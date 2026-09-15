/**
 * Slash command 契约。
 *
 * `parts/09` §6：「Slash command 是独立的 `CommandRegistry`，**与 TUI 无关**。
 * 每个命令声明参数 schema、是否打断当前 turn、权限、审计事件和幂等策略。」
 *
 * 之所以强调"与 TUI 无关"：命令在三个地方被触发——TUI 输入框、Web 的
 * `POST /api/commands`、以及未来的 CLI。任何一处内联分发都会让另外两处
 * 要么重复实现、要么行为漂移。
 */

import type { z } from 'zod'

import type { ErrorCode } from '../core/errors.js'
import type { PrincipalId, SessionId, TurnId } from '../core/ids.js'
import { ModelTier } from '../core/provider.js'

/**
 * 主循环使用的档位。**唯一来源，不要在别处再声明一份。**
 *
 * 旧实现的"主模型"是配置里 `is_default` 的那个模型（`storage.py:249`
 * `get_primary_llm_model`），也就是**主循环实际会用的那个**。本项目的对应物
 * 就是这个档位：`AgentRuntime` 构造 `TaskIntent` 时硬编码
 * `ModelTier.IMPLEMENTATION`，`/init` 据此判断"有没有主模型"，TUI 状态栏也据此
 * 决定展示哪个模型。
 *
 * 放在命令层是**当前可行**的选择：命令层自己要用它，`clients/tui` 也要用它，
 * 而依赖方向是 `clients → commands`，两边都够得着这里。位置更自然的是
 * `src/core/provider.ts`——`ModelTier` 就定义在那儿，而"主循环用哪个档位"是
 * 领域契约、不是命令层知识——但此刻改动 `src/core` 会牵动正在跑的测试线，
 * 故暂放在此，**后续可迁**。
 *
 * 此前它在 `clients/tui/sources.ts` 与 `commands/definitions/init.ts` 各有一份
 * 副本，同一个知识散落在多处，改一处就会静默漂移；先收敛成一份是当务之急，
 * 位置可以再议。
 *
 * ⚠️ 与 `AgentRuntime` 里硬编码的 `ModelTier.IMPLEMENTATION` **必须同步**——
 * 那处暂时没有共用（改 runtime 会牵动其他在跑的任务），但它是**唯一**剩下的
 * 重复点，而不是三份。
 */
export const PRIMARY_TIER = ModelTier.IMPLEMENTATION

/** 位置参数声明。 */
export interface CommandPositional {
  readonly name: string
  readonly required: boolean
  readonly description: string
  /** 该参数的取值约束。解析失败一律返回 `INVALID_COMMAND_ARGUMENTS`。 */
  readonly schema: z.ZodType<unknown>
}

/** 参数声明。 */
export interface CommandParameters {
  readonly positionals: readonly CommandPositional[]
  /**
   * 从第 n 个位置参数起的**全部剩余原文**合并为 `rest`。
   *
   * 保留原始空白、不做 shell 解析（`parts/09` §6.1 第 4 条：指令部分
   * 「保留原始文本，不经过 shell 解析」）。`/workwith` 与 `/init` 依赖它。
   */
  readonly restFrom?: number
}

/**
 * 命令是否打断当前 turn。
 *
 * 默认 `'never'`：运行中的会话返回 `SESSION_BUSY`（`parts/09` §6.1 要求
 * `/workwith` 在 turn 进行中默认如此）。
 */
export type CommandInterrupt = 'never' | 'with-confirmation' | 'always'

/**
 * 谁能执行该命令。
 *
 * 与"工具权限"是两件事：这里管的是**命令本身**的可执行性，
 * 而命令触发的工具调用仍然照常走 `PermissionEngine`。
 */
export type CommandPermission =
  | { readonly kind: 'always' }
  /** 仅本机 principal——会写全局配置的命令。 */
  | { readonly kind: 'local-principal' }

/** 幂等策略。 */
export type CommandIdempotency =
  | { readonly kind: 'read-only' }
  /** 按 requestId 去重并回放结果。 */
  | { readonly kind: 'keyed'; readonly ttlMs: number }

/**
 * 命令结果的性质。
 *
 * 区分 `ok` / `panel` / `selection` 是为了让 UI 知道该"直接输出文本"还是
 * "渲染一个面板/选择列表"——旧 TUI 用两套渲染路径（`#command-menu` 与
 * `_show_panel`），命令层必须把意图表达出来，而不是让每个 UI 各自猜。
 */
export const CommandResultCode = {
  /** 纯文本回复。 */
  OK: 'ok',
  /** 需要在消息区渲染一个面板（会盖住对话，返回需显式重绘历史）。 */
  PANEL: 'panel',
  /** 需要弹出一个选择列表。 */
  SELECTION: 'selection',
  /** 参数非法。`parts/09` §6.1：不得因此提交模型请求。 */
  INVALID_ARGUMENTS: 'invalid_arguments',
  /** 会话正在跑 turn 且该命令不打断。 */
  SESSION_BUSY: 'session_busy',
  PERMISSION_DENIED: 'permission_denied',
  /** 命令存在，但依赖的子系统尚未实现（Phase 8/10/11）。 */
  NOT_AVAILABLE: 'not_available',
  FAILED: 'failed',
} as const

export type CommandResultCode = (typeof CommandResultCode)[keyof typeof CommandResultCode]

/** 执行结果。 */
export interface CommandResult {
  readonly ok: boolean
  readonly code: CommandResultCode
  /** 面向用户的文本。`persistResult` 为真时**会进入 transcript**。 */
  readonly text: string
  /** 结构化数据，供 UI 渲染面板或选择列表。**不送模型**。 */
  readonly data?: Readonly<Record<string, unknown>>
  readonly errorCode?: ErrorCode
}

/** 命令的执行上下文。 */
export interface CommandContext {
  readonly principalId: PrincipalId
  readonly sessionId: SessionId | undefined
  /** 幂等键。Web 端来自 `Idempotency-Key`，TUI 端由实现生成。 */
  readonly requestId: string
  readonly signal: AbortSignal
  readonly host: CommandHost
  /** 命令原文，含前导 `/`。 */
  readonly raw: string
  readonly args: Readonly<Record<string, unknown>>
}

export interface CommandDefinition {
  /** 不含前导 `/`。 */
  readonly name: string
  readonly aliases?: readonly string[]
  readonly description: string
  readonly parameters: CommandParameters
  readonly interrupt: CommandInterrupt
  readonly permission: CommandPermission
  /**
   * 审计事件类型。**执行前**发出——这样被权限拒绝的命令也留痕。
   */
  readonly auditEvent: string
  readonly idempotency: CommandIdempotency
  /** 结果是否作为 `command_event` 消息进入 transcript。 */
  readonly persistResult: boolean
  execute(ctx: CommandContext): Promise<CommandResult>
}

/**
 * 命令层需要的能力。
 *
 * 这是一个**窄接口**，由 `src/app/AgentApplication` 实现。命令层不 import
 * `src/app`——依赖方向必须是 `app → commands(端口)`，否则组合根与命令
 * 会互相依赖，命令也就无法脱离应用被单测。
 */
export interface CommandHost {
  /** 本机 principal。`local-principal` 类权限据此判定。 */
  readonly localPrincipalId: PrincipalId

  // ── 会话 ──────────────────────────────────────────────────────
  listSessions(principalId: PrincipalId): Promise<
    readonly {
      readonly id: SessionId
      readonly title: string
      readonly current_turn: number
      readonly agent_type: string
    }[]
  >
  createSession(principalId: PrincipalId, title?: string): Promise<{ readonly id: SessionId }>
  sessionExists(principalId: PrincipalId, sessionId: SessionId): Promise<boolean>

  // ── turn ──────────────────────────────────────────────────────
  isBusy(sessionId: SessionId): boolean
  cancelTurn(sessionId: SessionId, reason: string): boolean
  /** 等待在飞 turn 真正结束。**有界**——调用方传超时。 */
  awaitTurn(sessionId: SessionId, timeoutMs: number): Promise<void>
  submitTurn(input: {
    readonly principalId: PrincipalId
    readonly sessionId: SessionId
    readonly prompt: string
    readonly override?: CommandModelOverride
  }): Promise<{ readonly turnId: TurnId }>

  // ── 配置 ──────────────────────────────────────────────────────
  /** 读取全局配置的**只读快照**，供命令生成展示数据。 */
  readConfig(): Promise<CommandConfigView>
  /** 修改全局配置。命令不直接写盘，一律经过它。 */
  updateConfig(mutator: (view: CommandConfigView) => CommandConfigView): Promise<void>
  /** 修改某个模型的运行偏好（`/thinking`、`/reasoning`、`/effort`）。 */
  updateModelPreferences(
    tier: ModelTier,
    patch: { readonly thinkingEnabled?: boolean; readonly reasoningEffort?: string },
  ): Promise<void>

  // ── 事件与审计 ────────────────────────────────────────────────
  publish(input: {
    readonly sessionId: SessionId | undefined
    readonly turnId?: TurnId
    readonly type: string
    readonly data: unknown
  }): Promise<void>

  // ── 幂等 ──────────────────────────────────────────────────────
  getIdempotency(
    key: string,
  ): Promise<{ readonly requestHash: string; readonly response: unknown } | undefined>
  putIdempotency(record: {
    readonly key: string
    readonly operation: string
    readonly requestHash: string
    readonly response: unknown
  }): Promise<void>

  // ── 结果落地 ──────────────────────────────────────────────────
  /** 把命令结果作为 `command_event` 消息写入 transcript。返回消息 id 供事件引用。 */
  recordCommandResult(input: {
    readonly sessionId: SessionId
    readonly command: string
    readonly result: CommandResult
  }): Promise<string | undefined>

  // ── 压缩 ──────────────────────────────────────────────────────
  /** `/compact` 的真实执行入口。无摘要器时返回 `not_available` 的原因。 */
  compact(sessionId: SessionId, signal: AbortSignal): Promise<CommandResult>

  /** 时区无关的当前时刻，便于测试注入。 */
  now(): string
}

/** 命令层可见的配置视图——只暴露命令需要的东西，不泄漏 secret 引用细节。 */
export interface CommandConfigView {
  readonly providers: readonly {
    readonly id: string
    readonly name: string
    readonly enabled: boolean
    readonly hasSecret: boolean
  }[]
  readonly models: readonly {
    readonly id: string
    readonly providerId: string
    readonly displayName: string
    readonly enabled: boolean
    readonly supportsTools: boolean
    readonly supportsThinking: boolean
    readonly supports1MContext: boolean
    readonly contextWindow: number
    readonly maxOutputTokens: number
  }[]
  readonly tiers: readonly {
    readonly tier: ModelTier
    readonly providerId: string
    readonly modelId: string
    readonly enabled: boolean
  }[]
  /**
   * `app_settings` 的可写视图。
   *
   * 之前这里没有它，于是 `/language` 只能对配置做**恒等变换**——什么也没写，
   * 而各客户端为了让它"看起来生效"只能各自补一次落盘。那正是要消除的
   * "每个客户端自己写一遍"。配置视图要么完整可用，要么别暴露 `updateConfig`。
   */
  readonly settings: Readonly<Record<string, string>>
  /** 待写回的原始文档。命令不解读它，只用于回写。 */
  readonly raw: Readonly<Record<string, unknown>>
}

/**
 * `/workwith` 产生的模型覆盖。
 *
 * 形状对齐 `parts/09` §6.1 的 `ModelOverride`，但**不落 `chat.json`**：
 * 它的语义是"下一次提交的瞬时意图"，持久化会在崩溃后产生"幽灵 override"
 * ——用户早已忘记，下一条消息却莫名用了别的模型。
 */
export interface CommandModelOverride {
  readonly overrideId: string
  readonly scope: 'next-turn'
  readonly providerId: string
  readonly modelId: string
  readonly requestedBy: string
  readonly instruction: string
  readonly createdAt: string
}
