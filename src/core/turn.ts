/**
 * Turn 契约：状态机、事件、结果。
 *
 * 这是整个 runtime 的骨架——本文件定义的所有类型在 Phase 1..11 中被反复引用。
 *
 * ## 权威来源
 *
 * `parts/09-typescript-agent-standard.md` §2 规定了目标状态机与状态集合；
 * `parts/02-agent-loop.md` 记录了旧 Python 的**实际行为**。两者冲突时以 09 为准，
 * 但有一处 09 未覆盖而 02 有明确行为：**用户输入等待**（`ask_user_question`
 * 会阻塞最多 120 秒）。09 的 `TurnPhase` 里没有对应状态，因此本实现显式补上
 * `awaiting_user_input`，而不是把它塞进 `awaiting_permission`——两者的恢复语义
 * 不同（前者等的是答案，后者等的是授权决定）。
 */

import { type EventId, type PermissionRequestId, type SessionId, type TurnId } from './ids.js'
import { type MessageSubtype } from './models.js'
import { type IsoTimestamp } from './time.js'

// ── 状态机 ────────────────────────────────────────────────────────

/**
 * turn 所处的阶段。
 *
 * 前 7 个是**进行中**阶段，后 4 个是**终态**。终态一旦进入不可再迁移。
 */
export const TurnPhase = {
  /** 已分配 turn ID 与序号，用户消息已持久化。 */
  STARTING: 'starting',
  /** 正在组装上下文：读取活跃消息、解析 skill、组装 system prompt。 */
  BUILDING_CONTEXT: 'building_context',
  /** 正在消费 provider 流式响应。 */
  CALLING_MODEL: 'calling_model',
  /** 等待人工授权。**必须已持久化权限请求**，否则崩溃后无法恢复。 */
  AWAITING_PERMISSION: 'awaiting_permission',
  /** 等待用户回答问题（`ask_user_question`）。 */
  AWAITING_USER_INPUT: 'awaiting_user_input',
  /** 正在串行执行工具调用。 */
  EXECUTING_TOOLS: 'executing_tools',
  /** 正在压缩上下文（preflight / reactive / manual）。 */
  COMPACTING: 'compacting',
  /** 预算耗尽后的最后一次生成，不提供工具。 */
  FINALIZING: 'finalizing',
  /** 正常完成：模型本轮未请求任何工具。 */
  COMPLETED: 'completed',
  /** 被取消。 */
  CANCELLED: 'cancelled',
  /** 预算或上下文耗尽，未能正常收尾。 */
  BUDGET_EXCEEDED: 'budget_exceeded',
  /** 上下文超限且压缩无法解决。 */
  CONTEXT_EXCEEDED: 'context_exceeded',
  /** 失败（provider 错误、内部异常等）。 */
  FAILED: 'failed',
} as const

/** turn 阶段类型。 */
export type TurnPhase = (typeof TurnPhase)[keyof typeof TurnPhase]

/** 终态集合。进入终态后不再迁移。 */
export const TERMINAL_PHASES: ReadonlySet<TurnPhase> = new Set<TurnPhase>([
  TurnPhase.COMPLETED,
  TurnPhase.CANCELLED,
  TurnPhase.BUDGET_EXCEEDED,
  TurnPhase.CONTEXT_EXCEEDED,
  TurnPhase.FAILED,
])

/** 进行中阶段集合。 */
export const ACTIVE_PHASES: ReadonlySet<TurnPhase> = new Set<TurnPhase>(
  Object.values(TurnPhase).filter((phase) => !TERMINAL_PHASES.has(phase)),
)

/**
 * 合法迁移表。
 *
 * ⚠️ 这张表是**本实现的约定**：`parts/09` §2 要求「所有迁移必须校验 `from -> to`」，
 * 但规格全文没有给出任何迁移边。旧 Python 项目则根本没有具名状态（它只有循环
 * 位置），所以也无从转录。这里按 09 的阶段语义与 02 的实际流程推导而成。
 *
 * 设计取舍：
 * - `compacting` 可从 `building_context`（preflight）或 `calling_model`（reactive）
 *   进入，压缩后回到进入它的那个阶段。
 * - `finalizing` 只从 `calling_model` 进入——它是预算耗尽后的一次性收尾生成。
 * - `calling_model` 可自环（多轮工具循环里每轮都是一次模型调用）。
 * - 任何进行中阶段都可直接进入终态（取消/失败可在任意点发生）。
 */
const TRANSITIONS: Readonly<Record<TurnPhase, readonly TurnPhase[]>> = {
  [TurnPhase.STARTING]: [TurnPhase.BUILDING_CONTEXT, TurnPhase.FAILED, TurnPhase.CANCELLED],

  [TurnPhase.BUILDING_CONTEXT]: [
    TurnPhase.CALLING_MODEL,
    TurnPhase.COMPACTING,
    TurnPhase.FAILED,
    TurnPhase.CANCELLED,
  ],

  [TurnPhase.CALLING_MODEL]: [
    TurnPhase.CALLING_MODEL, // 工具循环的下一轮
    TurnPhase.EXECUTING_TOOLS,
    TurnPhase.COMPACTING, // reactive 压缩
    TurnPhase.FINALIZING,
    TurnPhase.COMPLETED,
    TurnPhase.FAILED,
    TurnPhase.CANCELLED,
    TurnPhase.CONTEXT_EXCEEDED,
  ],

  [TurnPhase.COMPACTING]: [
    TurnPhase.BUILDING_CONTEXT, // 压缩后重建上下文
    TurnPhase.CALLING_MODEL, // reactive 压缩后重试本轮
    TurnPhase.FAILED,
    TurnPhase.CANCELLED,
    TurnPhase.CONTEXT_EXCEEDED,
  ],

  [TurnPhase.AWAITING_PERMISSION]: [
    TurnPhase.EXECUTING_TOOLS, // 批准
    TurnPhase.CALLING_MODEL, // 拒绝后把拒绝理由回灌给模型
    TurnPhase.CANCELLED,
    TurnPhase.FAILED,
  ],

  [TurnPhase.AWAITING_USER_INPUT]: [
    TurnPhase.EXECUTING_TOOLS,
    TurnPhase.CALLING_MODEL,
    TurnPhase.CANCELLED,
    TurnPhase.FAILED,
  ],

  [TurnPhase.EXECUTING_TOOLS]: [
    TurnPhase.CALLING_MODEL,
    TurnPhase.AWAITING_PERMISSION,
    TurnPhase.AWAITING_USER_INPUT,
    TurnPhase.CANCELLED,
    TurnPhase.FAILED,
  ],

  [TurnPhase.FINALIZING]: [
    TurnPhase.COMPLETED,
    TurnPhase.BUDGET_EXCEEDED,
    TurnPhase.CANCELLED,
    TurnPhase.FAILED,
  ],

  // 终态：无出边
  [TurnPhase.COMPLETED]: [],
  [TurnPhase.CANCELLED]: [],
  [TurnPhase.BUDGET_EXCEEDED]: [],
  [TurnPhase.CONTEXT_EXCEEDED]: [],
  [TurnPhase.FAILED]: [],
}

/** 判断一条迁移是否合法。 */
export function canTransition(from: TurnPhase, to: TurnPhase): boolean {
  return TRANSITIONS[from].includes(to)
}

/** 列出某阶段的全部合法后继。 */
export function nextPhases(from: TurnPhase): readonly TurnPhase[] {
  return TRANSITIONS[from]
}

/** 状态迁移记录。落盘用于恢复与审计（parts/09 §2）。 */
export interface PhaseTransition {
  readonly turnId: TurnId
  readonly from: TurnPhase
  readonly to: TurnPhase
  /** 迁移原因。用于区分"正常流转"与"异常中止"。 */
  readonly reason: string
  readonly timestamp: IsoTimestamp
  /** 关联的运行时事件 ID，便于把状态与事件日志对齐。 */
  readonly eventId: EventId
}

// ── turn 结果 ─────────────────────────────────────────────────────

/**
 * turn 的终止状态。
 *
 * ⚠️ 与 `TurnPhase` 的终态**不是一一对应**：`TurnPhase` 表达"停在哪个阶段"，
 * `TurnStatus` 表达"为什么停"。区别体现在 `budget_exceeded` / `context_exceeded`
 * 这两个 `TurnPhase` 终态上——它们都可能以 `partial` 收尾（有部分产出），
 * 而不是失败。
 */
export const TurnStatus = {
  /** 正常完成。 */
  COMPLETED: 'completed',
  /**
   * 部分完成：有可用产出，但因预算/资源限制提前收尾。
   *
   * ⚠️ **这是正常结果，不是失败**（parts/09 §7.4 明确要求
   * 「`partial` 不得伪装成失败」）。UI 必须把它与 `failed` 区分呈现。
   */
  PARTIAL: 'partial',
  /** 被取消。 */
  CANCELLED: 'cancelled',
  /** 失败。 */
  FAILED: 'failed',
  /** 预算耗尽。 */
  BUDGET_EXCEEDED: 'budget_exceeded',
  /** 上下文超限。 */
  CONTEXT_EXCEEDED: 'context_exceeded',
} as const

/** turn 终止状态类型。 */
export type TurnStatus = (typeof TurnStatus)[keyof typeof TurnStatus]

/**
 * 终止原因。
 *
 * 比 `TurnStatus` 更细，用于定位"为什么是这个状态"。它是**稳定契约**——
 * 测试与审计依赖这些字符串。
 */
export const TerminalReason = {
  /** 模型本轮未请求任何工具 → 正常收尾。 */
  COMPLETED: 'completed',
  /** 用户取消。 */
  CANCELLED: 'cancelled',
  /** turn 预算耗尽，且自动续跑次数已用尽。 */
  MAX_TURNS: 'max_turns',
  /** 自动续跑次数用尽。 */
  AUTO_CONTINUE_LIMIT: 'auto_continue_limit_reached',
  /** 工具调用被截断后的重试次数用尽。 */
  INCOMPLETE_TOOL_CALL_LIMIT: 'incomplete_tool_call_limit_reached',
  /** provider 报错，重试无效。 */
  ERROR: 'error',
  /** 上下文超限，且压缩未能解决。 */
  CONTEXT_EXCEEDED: 'context_exceeded',
  /** 通用预算维度耗尽（墙钟、token、成本、工具调用数）。 */
  BUDGET_EXCEEDED: 'budget_exceeded',
  /** 最终收尾轮仍产出了工具调用，被迫终止。 */
  FINALIZATION_TOOL_CALL: 'finalization_tool_call',
} as const

/** 终止原因类型。 */
export type TerminalReason = (typeof TerminalReason)[keyof typeof TerminalReason]

/**
 * 一次 turn 的最终产物。
 *
 * 这是可观测性的输入，也是 UI 判断"这一轮到底发生了什么"的唯一依据。
 */
export interface TurnResult {
  readonly turn_id: TurnId
  readonly status: TurnStatus
  /**
   * 面向用户的最终文本。
   *
   * 部分完成时这里承载已有的产出，**不要因为非 `completed` 就丢弃它**。
   */
  readonly final_text: string
  /** 完成了多少个工具轮（"模型请求工具 → 执行 → 回灌"的循环次数）。 */
  readonly tool_rounds: number
  /** 最近一次请求的输入 token（**快照语义，非累加**）。 */
  readonly input_tokens: number
  /** 本 turn 累计输出 token（**累加语义**）。 */
  readonly output_tokens: number
  readonly error: string | null
  /** 实际执行的模型调用轮数。 */
  readonly num_turns: number
  /** 本轮生效的 turn 预算上限（自动续跑会抬高它）。 */
  readonly max_turns: number
  readonly terminal_reason: TerminalReason | null
  /** 最近一次失败的工具错误码。全部成功时为 `null`。 */
  readonly last_tool_error: string | null
}

// ── 运行时事件 ────────────────────────────────────────────────────

/**
 * runtime 事件类型。
 *
 * 名称与旧实现逐字一致——它们是**稳定契约**，UI、日志与测试都按这些字符串分支。
 *
 * ⚠️ 两个容易踩的点：
 * 1. **`thinking` 与 `tool_use` 事件不携带最终渲染所需的数据**。流式阶段它们只用于
 *    进度提示；历史重绘时消息从存储读取完整 content block 渲染。不要把流式增量
 *    当作用户可见的最终内容。
 * 2. **`turn_end` 不是唯一的终止信号**。部分失败路径只发 `error` 而不发 `turn_end`。
 *    任何以 `turn_end` 为唯一终止条件的 UI 都可能在失败时挂住——因此
 *    `TurnStreamEvent` 把 `error` 也纳入终止判定（见 `isTerminalEvent`）。
 */
export const RuntimeEventType = {
  TURN_START: 'turn_start',
  THINKING: 'thinking',
  TEXT: 'text',
  TOOL_USE: 'tool_use',
  TOOL_RESULT: 'tool_result',
  SKILL_RESOLVED: 'skill_resolved',
  COMPACT_START: 'compact_start',
  COMPACT_END: 'compact_end',
  AUTO_CONTINUE: 'auto_continue',
  PERMISSION_REQUIRED: 'permission_required',
  USER_INPUT_REQUIRED: 'user_input_required',
  TURN_END: 'turn_end',
  MODEL_ROUTE_CHANGED: 'model_route_changed',
  ERROR: 'error',
} as const

/** runtime 事件类型。 */
export type RuntimeEventType = (typeof RuntimeEventType)[keyof typeof RuntimeEventType]

/**
 * 事件信封中除 `type` / `data` 外的公共字段。
 *
 * 与 `events.ts` 的 `RuntimeEventEnvelope` 配合：具体事件类型 = 信封 + `type` + `data`。
 */
interface TurnEventBase {
  readonly sessionId: SessionId
  readonly turnId: TurnId
}

/** turn 开始。 */
export interface TurnStartEvent extends TurnEventBase {
  readonly type: typeof RuntimeEventType.TURN_START
  readonly data: { readonly turn_number: number }
}

/**
 * 思考内容。
 *
 * `preview` 是 `content` 截断到 200 字符（超出加 `"..."`）的副本，供状态栏等
 * 只需要一行摘要的地方使用，避免为了显示一行而搬运整段思考。
 */
export interface ThinkingEvent extends TurnEventBase {
  readonly type: typeof RuntimeEventType.THINKING
  readonly data: { readonly content: string; readonly preview: string }
}

/** 助手文本增量（**不是**完整文本，需自行累积）。 */
export interface TextEvent extends TurnEventBase {
  readonly type: typeof RuntimeEventType.TEXT
  readonly data: { readonly content: string }
}

/** 模型请求调用某个工具。 */
export interface ToolUseEvent extends TurnEventBase {
  readonly type: typeof RuntimeEventType.TOOL_USE
  readonly data: {
    readonly id: string
    readonly name: string
    readonly input: Readonly<Record<string, unknown>>
  }
}

/** 工具执行结果。 */
export interface ToolResultEvent extends TurnEventBase {
  readonly type: typeof RuntimeEventType.TOOL_RESULT
  readonly data: {
    readonly tool_use_id: string
    readonly name: string
    readonly ok: boolean
    readonly content: string
    readonly error_code: string | null
  }
}

/**
 * skill 解析完成。
 *
 * ⚠️ **本实现暂不发射**：Skill 子系统属 Phase 8（`src/skills` 尚不存在）。
 * 契约类型保留，因为它是 UI 绘制 skill 面板的既定接口。
 */
export interface SkillResolvedEvent extends TurnEventBase {
  readonly type: typeof RuntimeEventType.SKILL_RESOLVED
  readonly data: {
    readonly applied_skills: readonly string[]
    readonly active_phase: string
    readonly guards_applied: number
  }
}

/** 压缩开始。`strategy` 区分触发来源。 */
export interface CompactStartEvent extends TurnEventBase {
  readonly type: typeof RuntimeEventType.COMPACT_START
  readonly data: { readonly strategy: string }
}

/** 压缩结束。**无论是否实际压缩都会发出**，`applied` 表明结果。 */
export interface CompactEndEvent extends TurnEventBase {
  readonly type: typeof RuntimeEventType.COMPACT_END
  readonly data: { readonly applied: boolean; readonly strategy: string }
}

/**
 * 预算耗尽后自动续跑，抬高了 turn 预算上限。
 *
 * ⚠️ **本实现不发射**，是**有意**的：旧项目那套"预算耗尽 → 追加预算 → 继续跑"
 * 的三计数器逻辑没有被移植，本实现的续跑语义由 `maxTurns` 承担
 * （`AgentRuntimeOptions.maxTurns`），且 `ContinuationLimits` 虽在
 * `src/core/budget.ts` 中定义，运行时从未使用。
 *
 * 因此 `TurnEndEvent.data.auto_continue_count` 恒为 `0`。
 * 契约类型保留是为了将来若真要移植该特性时不必改协议。
 */
export interface AutoContinueEvent extends TurnEventBase {
  readonly type: typeof RuntimeEventType.AUTO_CONTINUE
  readonly data: {
    readonly count: number
    readonly additional_turns: number
    readonly num_turns: number
    readonly base_max_turns: number
    readonly max_turns: number
    readonly current_max_turns: number
  }
}

/** 需要人工授权。UI 必须据此弹出审批界面。 */
export interface PermissionRequiredEvent extends TurnEventBase {
  readonly type: typeof RuntimeEventType.PERMISSION_REQUIRED
  readonly data: {
    readonly request_id: PermissionRequestId
    readonly tool_name: string
    readonly tool_call_id: string
    readonly tool_input: Readonly<Record<string, unknown>>
    /** 脱敏且截断后的参数摘要，用于在审批界面上展示。 */
    readonly args_preview: string
    readonly risk_level: string
    readonly reason: string
    /** 到期时刻（epoch 毫秒）。超时按拒绝处理。 */
    readonly expires_at: number
  }
}

/** 需要用户回答问题。 */
export interface UserInputRequiredEvent extends TurnEventBase {
  readonly type: typeof RuntimeEventType.USER_INPUT_REQUIRED
  readonly data: {
    readonly request_id: PermissionRequestId
    readonly tool_name: string
    readonly tool_call_id: string
    readonly questions: readonly unknown[]
  }
}

/** turn 结束。 */
export interface TurnEndEvent extends TurnEventBase {
  readonly type: typeof RuntimeEventType.TURN_END
  readonly data: {
    readonly status: TurnStatus
    readonly terminal_reason: TerminalReason | null
    readonly final_text: string
    readonly tool_rounds: number
    readonly num_turns: number
    readonly base_max_turns: number
    readonly max_turns: number
    readonly current_max_turns: number
    readonly auto_continue_count: number
    readonly last_tool_error: string | null
    readonly input_tokens: number
    readonly output_tokens: number
    /** 仅在取消时存在。 */
    readonly cancelled?: boolean
  }
}

/**
 * 本 turn 实际使用的模型与路由预期不同。
 *
 * 两种触发情形（`parts/09` §9.4 的路由顺序把两者都算作 route change）：
 *
 * 1. **显式 override 生效**——`/workwith` 指定的模型覆盖了档位分配；
 * 2. **fallback 换候选**——首选模型连接失败 / 429 / 暂时性 5xx，路由滑到
 *    候选列表的下一个。
 *
 * 为什么必须发这个事件：`parts/09` §6.1 要求「模型引用、路由决策、能力校验和
 * 最终使用的模型写入审计事件」，§9.5 要求「切换模型后必须重新构建请求并写
 * `model_route_changed` 事件」。没有它，用户看到的「本次任务使用 A/B」与
 * **真正跑完这次任务的模型**可以是两个东西，而界面上无从分辨。
 *
 * ⚠️ 本事件是 ADR 0002 §3 冻结的 13 种事件之外**新增**的一种（见 ADR 0004 D8）。
 * 它是**通知类**事件，不是终止信号——`isTerminalEvent()` 不认它。
 */
export interface ModelRouteChangedEvent extends TurnEventBase {
  readonly type: typeof RuntimeEventType.MODEL_ROUTE_CHANGED
  readonly data: {
    /** 变更前路由指向的 provider/model。turn 起点还没有前值时为空串。 */
    readonly from_provider: string
    readonly from_model: string
    readonly to_provider: string
    readonly to_model: string
    /** 本次调用所属档位。 */
    readonly tier: string
    /** `override` 生效 / `fallback` 换候选。 */
    readonly reason: 'override' | 'fallback'
    /** 触发 fallback 的稳定错误码；override 生效时为空串。 */
    readonly error_code: string
    /** `override` 生效时对应的 `/workwith` 覆盖 id；否则为空串。 */
    readonly override_id: string
  }
}

/**
 * 错误。**可能在没有 `turn_end` 的情况下单独出现**。
 *
 * ⚠️ **turn 之内的失败本实现不发这个事件**——它们统一走
 * `finish()` → `turn_end{status: failed|cancelled|...}`，这样终止判定只有一条路径。
 * 本事件的定位是 **turn 之外**的错误（会话级、传输层），Phase 6/7 也还没有生产者。
 *
 * 消费方仍必须把它当作**终止信号**：`isTerminalEvent()` 同时认 `turn_end` 与
 * `error`，只等 `turn_end` 的客户端会在这些路径上永久挂起。
 */
export interface ErrorEvent extends TurnEventBase {
  readonly type: typeof RuntimeEventType.ERROR
  readonly data: { readonly message: string }
}

/** 全部 turn 流式事件的可辨识联合。 */
export type TurnStreamEvent =
  | TurnStartEvent
  | ThinkingEvent
  | TextEvent
  | ToolUseEvent
  | ToolResultEvent
  | SkillResolvedEvent
  | CompactStartEvent
  | CompactEndEvent
  | AutoContinueEvent
  | PermissionRequiredEvent
  | UserInputRequiredEvent
  | TurnEndEvent
  | ModelRouteChangedEvent
  | ErrorEvent

/**
 * 事件类型 → 其 `data` 载荷的形状。
 *
 * 从 `TurnStreamEvent` **派生**而非手工重复，因此新增事件类型时这里自动跟上。
 *
 * 用途：让发射点在**编译期**校验 `type` 与 `data` 的对应关系。此前 `emit` 的
 * `type` 是 `string`、`data` 是自由泛型，两者毫无关联——于是 `turn_end` 事件
 * 可以少发一半字段而编译照常通过（本实现就曾漏发 `input_tokens` /
 * `output_tokens`，而状态栏正需要它们）。
 */
export type RuntimeEventData = {
  [K in RuntimeEventType]: Extract<TurnStreamEvent, { type: K }>['data']
}

/**
 * 判断该事件是否表示 turn 已终止。
 *
 * ⚠️ **`error` 也算终止**。部分失败路径只发 `error` 不发 `turn_end`，
 * 只认 `turn_end` 的消费方会在这些情况下永久等待。
 */
export function isTerminalEvent(event: TurnStreamEvent): event is TurnEndEvent | ErrorEvent {
  return event.type === RuntimeEventType.TURN_END || event.type === RuntimeEventType.ERROR
}

/**
 * 判断该事件是否需要 UI 回灌决定（而非仅仅消费）。
 *
 * 这些事件会**挂起整个 turn**直到 `resolve_*` 被调用。UI 若忽略它们，
 * turn 会一直等到超时——所以必须有超时兜底（审批 120 秒，超时按拒绝处理）。
 */
export function requiresResolution(
  event: TurnStreamEvent,
): event is PermissionRequiredEvent | UserInputRequiredEvent {
  return (
    event.type === RuntimeEventType.PERMISSION_REQUIRED ||
    event.type === RuntimeEventType.USER_INPUT_REQUIRED
  )
}

// ── 取消 ──────────────────────────────────────────────────────────

/**
 * 取消决议的输入。
 *
 * ⚠️ 取消是**控制流**，不是错误——它通过 `AbortSignal` 传播，不占用
 * `Result` 的错误分支。见 `result.ts` 的说明。
 */
export interface CancelRequest {
  readonly sessionId: SessionId
  readonly turnId: TurnId
  /** 取消原因，用于日志与审计。 */
  readonly reason?: string
}

// ── 子代理结果（09 §7.4 目标形态）────────────────────────────────

/**
 * 结构化发现。
 *
 * 子代理回传给父代理的**摘要**，不是原始输出。父代理不应把它当事实来源。
 */
export interface Finding {
  readonly summary: string
  readonly detail?: string
  /** 支撑该发现的证据位置（文件路径、命令等）。 */
  readonly evidence?: readonly string[]
}

/** 文件变更记录。 */
export interface FileChange {
  readonly path: string
  readonly kind: 'created' | 'modified' | 'deleted'
  /** 变更前的哈希，用于外部修改检测。 */
  readonly before_hash?: string
  readonly after_hash?: string
}

/** 证据引用。 */
export interface Evidence {
  readonly kind: string
  readonly ref: string
  readonly detail?: string
}

/**
 * 子代理结果。
 *
 * ⚠️ `partial` 是**正常结果**，不得伪装成失败（parts/09 §7.4）。
 * 压缩子代理结果时不得删除文件路径、验证命令、失败原因和未解决事项。
 */
export interface SubAgentResult {
  readonly status: 'completed' | 'partial' | 'failed' | 'cancelled'
  readonly summary: string
  readonly findings: readonly Finding[]
  readonly changes: readonly FileChange[]
  readonly evidence: readonly Evidence[]
  /** 明确未解决的事项。**不得为空数组以外的省略**——空表示确实没有遗留。 */
  readonly unresolved: readonly string[]
  readonly sessionId: SessionId
  /** 恢复句柄。必须能还原真实状态，不能只保存一段文本。 */
  readonly continuationHandle?: string
}

/** 消息子类型的可读标签，用于 UI 呈现。 */
export const SUBTYPE_LABELS: Readonly<Record<MessageSubtype, string>> = {
  normal: '消息',
  tool_call: '工具调用',
  tool_result: '工具结果',
  interrupted: '已中断',
  skill_event: 'Skill',
  permission_event: '权限',
  compact_summary: '摘要',
  compact_boundary: '压缩边界',
  command_event: '命令',
}
