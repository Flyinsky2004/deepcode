/**
 * `/workwith <provider/model> <instruction>`。
 *
 * **这是新增能力，旧项目没有**——`parts/09` §6.1 定义了它的语义。
 *
 * 作用域是**当前会话的下一项任务**：命令创建一个 `ModelOverride` 绑定到紧随
 * 其后的 user instruction，**不修改全局档位、也不影响其他会话**。用户想继续
 * 用同一个模型就必须再次 `/workwith`，或者在 UI 里显式设置会话级 override。
 *
 * `ModelOverride` **不落 `chat.json`**，只写事件审计。理由：它的语义是
 * "下一次提交的瞬时意图"，不是会话状态。持久化会在崩溃后产生"幽灵 override"
 * ——重启后用户早已忘记自己指定过模型，下一条消息却莫名用了别的模型。
 */

import { z } from 'zod'

import { ErrorCode, toAgentError } from '../../core/errors.js'
import { createModelOverrideId } from '../../core/ids.js'
import { ModelRefFailure, checkCapability, resolveModelRef } from '../model-ref.js'
import { CommandResultCode, type CommandDefinition, type CommandResult } from '../types.js'

/** 打断后等待旧 turn 真正结束的上限。 */
const CANCEL_GRACE_MS = 10_000

const refSchema = z.string().min(1, '缺少模型引用')

/**
 * 解析/校验失败 → 稳定错误码。
 *
 * ⚠️ `CommandResult.errorCode` **必须由命令层填**，不能留给传输层去猜。
 * 它对应的是"本该由领域层决定、却在这里被丢掉"的信息：`MODEL_NOT_FOUND`
 * 与 `MODEL_CAPABILITY_UNAVAILABLE` 对用户是完全不同的两件事（一个是配错了
 * 名字，一个是这个模型干不了这活），HTTP 层从 `CommandResultCode` 反推只会
 * 把它们都压成 400。
 */
const FAILURE_TO_ERROR_CODE: Readonly<Record<ModelRefFailure, ErrorCode>> = {
  [ModelRefFailure.MALFORMED]: ErrorCode.INVALID_COMMAND_ARGUMENTS,
  [ModelRefFailure.AMBIGUOUS]: ErrorCode.INVALID_COMMAND_ARGUMENTS,
  [ModelRefFailure.NOT_FOUND]: ErrorCode.MODEL_NOT_FOUND,
  [ModelRefFailure.DISABLED]: ErrorCode.MODEL_NOT_FOUND,
  [ModelRefFailure.NO_SECRET]: ErrorCode.PROVIDER_AUTH_FAILED,
  [ModelRefFailure.CAPABILITY]: ErrorCode.MODEL_CAPABILITY_UNAVAILABLE,
}

export function createWorkwithCommand(): CommandDefinition {
  return {
    name: 'workwith',
    description: '为下一项任务指定 provider/model',
    parameters: {
      positionals: [
        { name: 'ref', required: true, description: 'provider/model', schema: refSchema },
        { name: 'rest', required: true, description: '指令内容', schema: z.string() },
      ],
      // 指令部分保留原始文本，不经过 shell 解析（§6.1 第 4 条）
      restFrom: 1,
    },
    // 会打断当前 turn，但必须先经用户确认（§6.1 末段）
    interrupt: 'with-confirmation',
    permission: { kind: 'always' },
    auditEvent: 'command_received',
    // 会真正提交一个 turn，必须幂等——刷新页面不应重复提交
    idempotency: { kind: 'keyed', ttlMs: 86_400_000 },
    persistResult: true,
    execute: async (ctx): Promise<CommandResult> => {
      const sessionId = ctx.sessionId
      if (sessionId === undefined)
        return {
          ok: false,
          code: CommandResultCode.INVALID_ARGUMENTS,
          text: '请先开始一个会话再使用 /workwith',
          errorCode: ErrorCode.INVALID_COMMAND_ARGUMENTS,
        }

      const instruction = typeof ctx.args['rest'] === 'string' ? ctx.args['rest'] : ''
      const ref = typeof ctx.args['ref'] === 'string' ? ctx.args['ref'] : ''

      const config = await ctx.host.readConfig()

      // 1. 解析引用（歧义必须报错，不能随机选）
      const resolved = resolveModelRef(ref, config)
      if (!resolved.ok)
        return {
          ok: false,
          code: CommandResultCode.INVALID_ARGUMENTS,
          text: resolved.message,
          errorCode: FAILURE_TO_ERROR_CODE[resolved.reason],
          data: { reason: resolved.reason },
        }

      // 2. 能力校验 —— 失败一律返回明确错误码，**不静默回退到全局档位**
      const capable = checkCapability(resolved, config, { requiresTools: true })
      if (!capable.ok)
        return {
          ok: false,
          code: CommandResultCode.INVALID_ARGUMENTS,
          text: capable.message,
          errorCode: FAILURE_TO_ERROR_CODE[capable.reason],
          data: { reason: capable.reason },
        }

      await ctx.host.publish({
        sessionId,
        type: 'model_capability_checked',
        data: { providerId: resolved.providerId, modelId: resolved.modelId, ok: true },
      })

      const override = {
        overrideId: createModelOverrideId(),
        scope: 'next-turn' as const,
        providerId: resolved.providerId,
        modelId: resolved.modelId,
        requestedBy: ctx.principalId,
        instruction,
        createdAt: ctx.host.now(),
      }

      await ctx.host.publish({
        sessionId,
        type: 'model_override_created',
        data: {
          overrideId: override.overrideId,
          scope: override.scope,
          providerId: override.providerId,
          modelId: override.modelId,
          requestedBy: override.requestedBy,
        },
      })

      // 3. 打断当前 turn（若正在跑）。
      //
      // ⚠️ abort **不会同步清空** runtime 的 busy 集合——它是在 `finish()` 的
      // finally 里清的，而 `finish()` 还要写存储。因此必须 await 到 turn 真正
      // 结束，否则紧接着的 submitTurn 会抛 `SESSION_BUSY`——用户刚点了"确认打断"
      // 却看到"会话忙"，这是最容易被当成 bug 的行为。
      if (ctx.host.isBusy(sessionId)) {
        ctx.host.cancelTurn(sessionId, 'workwith-interrupt')
        await ctx.host.awaitTurn(sessionId, CANCEL_GRACE_MS)
        if (ctx.host.isBusy(sessionId))
          return {
            ok: false,
            code: CommandResultCode.SESSION_BUSY,
            text: '无法打断当前 turn，请稍后重试',
            errorCode: ErrorCode.SESSION_BUSY,
          }
      }

      // 4. 提交
      let turnId: string
      try {
        const submitted = await ctx.host.submitTurn({
          principalId: ctx.principalId,
          sessionId,
          prompt: instruction,
          override,
        })
        turnId = submitted.turnId
      } catch (error) {
        const e = toAgentError(error, 'command.workwith')
        return {
          ok: false,
          code: CommandResultCode.FAILED,
          text: e.message,
          errorCode: e.code,
        }
      }

      await ctx.host.publish({
        sessionId,
        turnId: turnId as never,
        type: 'workwith_turn_started',
        data: { overrideId: override.overrideId, turnId },
      })

      // 前端必须显示"本次任务使用 provider/model"，避免用户误以为
      // 全局档位已被修改（§6.1 末段）
      return {
        ok: true,
        code: CommandResultCode.OK,
        text: `本次任务使用 ${resolved.providerName}/${resolved.modelId}`,
        data: {
          overrideId: override.overrideId,
          providerId: resolved.providerId,
          modelId: resolved.modelId,
          turnId,
          scope: 'next-turn',
        },
      }
    },
  }
}

/** 供 UI 展示的失败原因（与 `ModelRefFailure` 一致）。 */
export { ModelRefFailure }
