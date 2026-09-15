/**
 * `/model` —— 查看或设置**档位**到模型的分配。
 *
 * ## 与旧实现的有意不同（ADR 0004 D7）
 *
 * 旧实现只有"唯一主模型"（`is_default` 的那个，`storage.py:249`），
 * 所以它的写分支是**按编号选**：`/model use <ch> <mo>`，两个参数都是
 * `/model` 面板里的 1-based 下标（`app.py:1606-1627` 的 `_select_primary_model`）。
 *
 * 本项目有六个档位（`parts/09` §9.3），下标语义在这里没有对应物，而且**会漂移**
 * ——配置文件增删一个模型，历史下标就指向别的东西。所以写分支改收
 * `provider/model`，并复用 `/workwith` 那套消歧（`resolveModelRef`）：
 * 同一个输入在两个命令里必须得到同一个结果，否则用户得记两套规则。
 *
 * 面板（只读分支）仍按行列出档位，供人阅读。
 */

import { z } from 'zod'

import { ErrorCode } from '../../core/errors.js'
import {
  ModelRefFailure,
  TIER_REQUIRES_TOOLS,
  asModelTier,
  checkCapability,
  resolveModelRef,
} from '../model-ref.js'
import {
  CommandResultCode,
  type CommandConfigView,
  type CommandDefinition,
  type CommandResult,
} from '../types.js'

/**
 * 解析/校验失败 → 稳定错误码。
 *
 * 与 `/workwith` 共用同一张映射的理由：同一个失败原因在两个命令里给出不同的
 * 错误码，会让 HTTP 层和 UI 各自需要一套分支去解释它。
 */
const FAILURE_TO_ERROR_CODE: Readonly<Record<ModelRefFailure, ErrorCode>> = {
  [ModelRefFailure.MALFORMED]: ErrorCode.INVALID_COMMAND_ARGUMENTS,
  [ModelRefFailure.AMBIGUOUS]: ErrorCode.INVALID_COMMAND_ARGUMENTS,
  [ModelRefFailure.NOT_FOUND]: ErrorCode.MODEL_NOT_FOUND,
  [ModelRefFailure.DISABLED]: ErrorCode.MODEL_NOT_FOUND,
  [ModelRefFailure.NO_SECRET]: ErrorCode.PROVIDER_AUTH_FAILED,
  [ModelRefFailure.CAPABILITY]: ErrorCode.MODEL_CAPABILITY_UNAVAILABLE,
}

export function createModelCommand(): CommandDefinition {
  return {
    name: 'model',
    description: '查看或设置档位模型',
    parameters: {
      positionals: [
        // 第一个位置参数是动作。写成 `z.literal('use')` 而不是 `z.string()`：
        // `/model foo bar` 会在参数校验阶段就被挡下（`INVALID_COMMAND_ARGUMENTS`），
        // 不必进到 execute 里再判断——也不会有机会把它误当成只读分支。
        { name: 'action', required: false, description: 'use', schema: z.literal('use') },
        { name: 'tier', required: false, description: '档位名', schema: z.string() },
        { name: 'ref', required: false, description: 'provider/model', schema: z.string() },
      ],
    },
    interrupt: 'never',
    // 会写全局配置 —— 只允许本机 principal
    permission: { kind: 'local-principal' },
    auditEvent: 'command_received',
    idempotency: { kind: 'read-only' },
    persistResult: false,
    execute: async (ctx): Promise<CommandResult> => {
      const config = await ctx.host.readConfig()
      if (ctx.args['action'] !== 'use') return describeTiers(config)

      const tier = asModelTier(ctx.args['tier'])
      if (tier === undefined)
        return {
          ok: false,
          code: CommandResultCode.INVALID_ARGUMENTS,
          text:
            `未知档位：${typeof ctx.args['tier'] === 'string' ? ctx.args['tier'] : ''}。` +
            `可用档位：${Object.keys(TIER_REQUIRES_TOOLS).join('、')}`,
          errorCode: ErrorCode.INVALID_COMMAND_ARGUMENTS,
        }

      const ref = typeof ctx.args['ref'] === 'string' ? ctx.args['ref'] : ''

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

      // 2. 能力校验 —— 失败返回明确错误码，**不写入一个注定跑不起来的分配**
      const capable = checkCapability(resolved, config, {
        requiresTools: TIER_REQUIRES_TOOLS[tier],
      })
      if (!capable.ok)
        return {
          ok: false,
          code: CommandResultCode.INVALID_ARGUMENTS,
          text: capable.message,
          errorCode: FAILURE_TO_ERROR_CODE[capable.reason],
          data: { reason: capable.reason },
        }

      await ctx.host.publish({
        sessionId: ctx.sessionId,
        type: 'model_capability_checked',
        data: { providerId: resolved.providerId, modelId: resolved.modelId, tier, ok: true },
      })

      // 3. 写入
      await ctx.host.assignTierModel(tier, resolved.providerId, resolved.modelId)

      // 4. 回读一次再展示：命令的"成功"必须反映**磁盘上真的写成了什么**，
      //    而不是把入参回显一遍。写入被并发改动或被归一化吞掉时，
      //    回显会给出一个不存在的承诺。
      const after = await ctx.host.readConfig()
      const assignment = after.tiers.find((t) => t.tier === tier)

      // 回读不到 = **没写成**。这是自证失败，必须报错：
      // 继续返回 `ok: true` + "档位 X → 未设置"就是那句注释要避免的
      // "不存在的承诺"，而且比回显入参更糟——它同时声称了成功和没写进去。
      if (assignment === undefined)
        return {
          ok: false,
          code: CommandResultCode.FAILED,
          text: `写入后回读不到档位 ${tier} 的分配，配置可能被并发修改`,
          errorCode: ErrorCode.INVALID_STATE_TRANSITION,
        }

      await ctx.host.publish({
        sessionId: ctx.sessionId,
        type: 'model_tier_assigned',
        data: {
          tier,
          from: config.tiers.find((t) => t.tier === tier)?.modelId ?? null,
          to: assignment.modelId,
          providerId: assignment.providerId,
        },
      })

      return {
        ok: true,
        code: CommandResultCode.OK,
        text: `档位 ${tier} → ${resolved.providerName}/${assignment.modelId}`,
        // `data` 全部取自回读结果，不掺入参——否则并发下会出现
        // `data.modelId = A` 而 `data.tiers[...] = B` 的同一条响应内部矛盾。
        data: {
          kind: 'model_panel',
          tier,
          providerId: assignment.providerId,
          modelId: assignment.modelId,
          tiers: after.tiers,
          models: after.models,
        },
      }
    },
  }
}

/** 只读分支：列出当前档位分配。 */
function describeTiers(config: CommandConfigView): CommandResult {
  if (config.tiers.length === 0)
    return {
      ok: true,
      code: CommandResultCode.PANEL,
      text: '尚未配置任何档位。用法：/model use <档位> <provider/model>',
      data: { kind: 'model_panel', tiers: [], models: config.models },
    }
  const labelOf = (providerId: string, modelId: string): string => {
    // 展示名统一为 `providerName/modelId`（parts/09 §9.1）——与 `/workwith`
    // 的回执同一形状，用户在两处看到的是同一个名字。
    // provider 或模型已被删除时退回 id 而不是崩溃：配置里留着一个悬空分配
    // 是用户**要能看见**的事实，不是异常。
    const provider = config.providers.find((p) => p.id === providerId)
    return `${provider?.name ?? providerId}/${modelId}`
  }
  const lines = config.tiers.map(
    (t) => `${t.tier}${t.enabled ? '' : '（已禁用）'} → ${labelOf(t.providerId, t.modelId)}`,
  )
  return {
    ok: true,
    code: CommandResultCode.PANEL,
    text: `当前档位分配：\n${lines.join('\n')}`,
    data: { kind: 'model_panel', tiers: config.tiers, models: config.models },
  }
}
