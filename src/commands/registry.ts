/**
 * 命令注册表与执行管线。
 *
 * 管线的**顺序本身就是契约**（`parts/09` §6 要求每个命令声明参数 schema、
 * 是否打断 turn、权限、审计事件与幂等策略）。几个顺序上的决定值得单独说明：
 *
 * - **审计放在权限检查之前**：审计要回答的是"谁在什么时候试图跑什么命令"，
 *   而**被权限拒绝的尝试恰恰是最该记录的那一类**（越权尝试是安全信号）。
 *   放在权限之后就永远看不到它们。
 * - **忙碌检查放在审计与权限之前**：会话忙是环境状态，不是授权问题，
 *   也不是一次"尝试执行命令"——它应当在产生任何记录之前就挡下。
 * - **幂等查询放在执行之前**：重复提交（浏览器刷新、TUI 重发）必须回放
 *   首次结果，而不是重新执行一遍副作用。
 *
 * 管线顺序：解析 → 查表 → 参数校验 → 忙碌 → **审计** → 权限 → 幂等 → 执行
 * → 结果落地 → 幂等写回。
 */

import { AgentError, ErrorCode, toAgentError } from '../core/errors.js'
import type { PrincipalId, SessionId } from '../core/ids.js'
import { inputHash } from '../storage/audit.js'
import { parseCommandLine, restFrom, type ParsedCommand } from './parser.js'
import {
  CommandResultCode,
  type CommandContext,
  type CommandDefinition,
  type CommandHost,
  type CommandResult,
} from './types.js'

export interface CommandExecutionInput {
  /** 命令原文，含前导 `/`。 */
  readonly raw: string
  readonly principalId: PrincipalId
  readonly sessionId?: SessionId
  readonly signal: AbortSignal
  /** 幂等键。Web 端来自 `Idempotency-Key`；TUI 端可由实现生成。 */
  readonly idempotencyKey?: string
  /** `interrupt: 'with-confirmation'` 的命令需要它为真才会打断。 */
  readonly confirmInterrupt?: boolean
}

/** 参数校验用的默认 schema（无约束）。 */
const argObject = (parsed: ParsedCommand, def: CommandDefinition): Record<string, unknown> => {
  const args: Record<string, unknown> = {}
  def.parameters.positionals.forEach((positional, index) => {
    const value = parsed.args[index]
    if (value !== undefined) args[positional.name] = value
  })
  if (def.parameters.restFrom !== undefined)
    args['rest'] = restFrom(parsed, def.parameters.restFrom)
  return args
}

export class CommandRegistry {
  readonly #commands = new Map<string, CommandDefinition>()

  register(definition: CommandDefinition): void {
    const keys = [definition.name, ...(definition.aliases ?? [])]
    for (const key of keys) {
      const normalized = key.toLowerCase()
      if (this.#commands.has(normalized))
        throw new AgentError({
          code: ErrorCode.INVALID_COMMAND_ARGUMENTS,
          message: `命令名重复：${key}`,
          source: 'commands',
        })
      this.#commands.set(normalized, definition)
    }
  }

  registerAll(definitions: readonly CommandDefinition[]): void {
    for (const definition of definitions) this.register(definition)
  }

  /** 查找**大小写不敏感**（`parts/09` §6.1 第 1 条）。 */
  get(name: string): CommandDefinition | undefined {
    return this.#commands.get(name.toLowerCase())
  }

  /** 去重后的命令列表，按注册顺序。 */
  list(): readonly CommandDefinition[] {
    return [...new Set(this.#commands.values())]
  }

  names(): readonly string[] {
    return this.list().map((d) => d.name)
  }

  async execute(input: CommandExecutionInput, host: CommandHost): Promise<CommandResult> {
    // 1. 解析
    const parsed = parseCommandLine(input.raw)
    if (!parsed)
      return fail(
        CommandResultCode.INVALID_ARGUMENTS,
        '不是一条命令',
        ErrorCode.INVALID_COMMAND_ARGUMENTS,
      )

    // 2. 查表
    const definition = this.get(parsed.name)
    if (!definition)
      return fail(
        CommandResultCode.NOT_AVAILABLE,
        `未知命令：/${parsed.name}`,
        ErrorCode.COMMAND_NOT_AVAILABLE,
      )

    // 3. 参数校验 —— 失败时**不得提交模型请求**（§6.1 第 5 条）
    if (
      definition.parameters.rejectExtraPositionals === true &&
      parsed.args.length > definition.parameters.positionals.length
    )
      return fail(
        CommandResultCode.INVALID_ARGUMENTS,
        `参数过多：/${definition.name} 不接受额外参数`,
        ErrorCode.INVALID_COMMAND_ARGUMENTS,
      )
    const args = argObject(parsed, definition)
    const invalid = validateArgs(definition, args)
    if (invalid)
      return fail(CommandResultCode.INVALID_ARGUMENTS, invalid, ErrorCode.INVALID_COMMAND_ARGUMENTS)

    // 4. 忙碌检查
    const busy = input.sessionId !== undefined && host.isBusy(input.sessionId)
    if (busy && definition.interrupt === 'never')
      return {
        ok: false,
        code: CommandResultCode.SESSION_BUSY,
        text: '当前 turn 正在运行，请先取消或等待完成',
        errorCode: ErrorCode.SESSION_BUSY,
        // 不带 turnId：它由 runtime 内部生成，同步拿不到。与其填一个
        // 永远为 null 的字段，不如不承诺这个信息。
        data: { sessionId: input.sessionId ?? null },
      }
    if (busy && definition.interrupt === 'with-confirmation' && input.confirmInterrupt !== true)
      return {
        ok: false,
        code: CommandResultCode.SESSION_BUSY,
        text: '该命令会打断当前 turn，需要确认',
        errorCode: ErrorCode.SESSION_BUSY,
        data: { needsConfirmation: true },
      }

    // 5. 审计（执行**前**，且**在权限检查之前**）
    //
    // 放在权限之前是有意的：审计要回答的是"谁在什么时候试图跑什么命令"，
    // 而**被权限拒绝的尝试恰恰是最该记录的那一类**（越权尝试是安全信号）。
    // 放在权限之后就永远看不到它们。
    await host
      .publish({
        sessionId: input.sessionId,
        type: definition.auditEvent,
        data: {
          command: definition.name,
          principalId: input.principalId,
          // 命令原文可能含文件内容或密钥形态的文本，落进事件日志前先摘要
          args: inputHash(args),
        },
      })
      .catch(() => undefined)

    // 6. 权限
    if (
      definition.permission.kind === 'local-principal' &&
      input.principalId !== host.localPrincipalId
    )
      return fail(
        CommandResultCode.PERMISSION_DENIED,
        '该命令只能由本机用户执行',
        ErrorCode.PERMISSION_DENIED,
      )

    // 7. 幂等查询
    const idempotencyKey =
      definition.idempotency.kind === 'keyed' && input.idempotencyKey !== undefined
        ? `cmd:${definition.name}:${input.principalId}:${input.idempotencyKey}`
        : undefined
    const requestHash = inputHash({ raw: input.raw })
    if (idempotencyKey !== undefined) {
      const prior = await host.getIdempotency(idempotencyKey)
      if (prior) {
        if (prior.requestHash !== requestHash)
          return fail(
            CommandResultCode.FAILED,
            '同一个幂等键被用于了不同的命令内容',
            ErrorCode.INVALID_STATE_TRANSITION,
          )
        return prior.response as CommandResult
      }
    }

    // 8. 执行
    const ctx: CommandContext = {
      principalId: input.principalId,
      sessionId: input.sessionId,
      requestId: input.idempotencyKey ?? '',
      signal: input.signal,
      host,
      raw: input.raw,
      args,
    }
    let result: CommandResult
    try {
      result = await definition.execute(ctx)
    } catch (error) {
      const e = toAgentError(error, `command:${definition.name}`)
      result = {
        ok: false,
        code: CommandResultCode.FAILED,
        text: e.message,
        errorCode: e.code,
      }
    }

    // 9. 结果进入 transcript
    let messageId: string | undefined
    if (definition.persistResult && input.sessionId !== undefined) {
      messageId = await host
        .recordCommandResult({
          sessionId: input.sessionId,
          command: definition.name,
          result,
        })
        .catch(() => undefined)
    }

    // 10. 幂等写回
    if (idempotencyKey !== undefined)
      await host
        .putIdempotency({
          key: idempotencyKey,
          operation: `command:${definition.name}`,
          requestHash,
          response: result,
        })
        .catch(() => undefined)

    // 事件带 messageId 指向落盘的消息：消息是历史的真相源，
    // 客户端按 id 去重，否则同一条结果会被画两次。
    await host
      .publish({
        sessionId: input.sessionId,
        type: 'command_completed',
        data: {
          command: definition.name,
          ok: result.ok,
          code: result.code,
          messageId: messageId ?? null,
        },
      })
      .catch(() => undefined)

    return result
  }
}

/** 逐个校验位置参数；返回错误信息或 `undefined`。 */
function validateArgs(
  definition: CommandDefinition,
  args: Readonly<Record<string, unknown>>,
): string | undefined {
  for (const positional of definition.parameters.positionals) {
    const value = args[positional.name]
    if (value === undefined || value === '') {
      if (positional.required) return `缺少参数：${positional.name}`
      continue
    }
    const parsed = positional.schema.safeParse(value)
    if (!parsed.success)
      return `参数 ${positional.name} 非法：${parsed.error.issues[0]?.message ?? '格式不正确'}`
  }

  // `rest` 声明为必需时（如 `/workwith` 的指令部分）不允许为空
  const restPositional = definition.parameters.positionals.find((p) => p.name === 'rest')
  if (
    definition.parameters.restFrom !== undefined &&
    restPositional?.required === true &&
    (typeof args['rest'] !== 'string' || args['rest'].trim() === '')
  )
    return '缺少指令内容'

  return undefined
}

function fail(code: CommandResultCode, text: string, errorCode: ErrorCode): CommandResult {
  return { ok: false, code, text, errorCode }
}
