import type { AgentBudget, BudgetConsumption } from '../core/budget.js'
import type { RuntimeEventEnvelope } from '../core/events.js'
import type { SkillGuardRef, PermissionMode } from '../core/tool.js'
import type { SkillTurnSnapshot } from '../skills/models.js'
import type { WorkingMemory } from '../core/context.js'
import type { Conversation, Message } from '../core/models.js'
import type { ModelProfile, ModelRef, ModelTier, Provider } from '../core/provider.js'
import type {
  PermissionRequest,
  PermissionResolution,
  ToolExecutionRecord,
  ToolResult,
} from '../core/tool.js'
import type { PersistedUserInputRequest } from '../core/input.js'
import type { PhaseTransition, TurnPhase, TurnResult } from '../core/turn.js'

/** 全局档位配置。新配置使用稳定的 provider/model ID。 */
export interface TierAssignment {
  readonly tier: ModelTier
  readonly modelRef: ModelRef
  readonly enabled: boolean
  readonly fallbackModelRefs: readonly ModelRef[]
  readonly maxCostPerTurn?: number
}

/** Provider 的持久化形态；enabled 是目标规范要求的运行开关。 */
export interface StoredProvider extends Provider {
  readonly enabled: boolean
}

/** 全局配置文件。旧字段原样保留，新字段是向后兼容扩展。 */
export interface ConfigDocument {
  readonly schema_version: number
  readonly llm_channels: readonly Readonly<Record<string, unknown>>[]
  readonly llm_models: readonly Readonly<Record<string, unknown>>[]
  readonly app_settings: Readonly<Record<string, string>>
  readonly mcp_servers?: readonly unknown[]
  readonly providers: readonly StoredProvider[]
  readonly model_profiles: readonly ModelProfile[]
  readonly tier_assignments: readonly TierAssignment[]
  readonly [key: string]: unknown
}

/** 每个 turn 固定的模型快照，配置改变不会重写历史。 */
export interface TurnModelSnapshot {
  readonly providerId: string
  readonly modelId: string
  readonly tier: ModelTier
  readonly contextWindow: number
  readonly maxOutputTokens: number
  readonly supportsThinking: boolean
  readonly supportsTools: boolean
  readonly supportsVision: boolean
  readonly supports1MContext: boolean
}

/** 可恢复的 turn 状态。 */
export interface PersistedTurn {
  readonly sessionId: string
  readonly turnId: string
  readonly turnNumber: number
  readonly phase: TurnPhase
  readonly createdAt: string
  readonly updatedAt: string
  readonly principalId: string
  readonly transitions: readonly PhaseTransition[]
  readonly budget: AgentBudget
  readonly consumption: BudgetConsumption
  readonly modelSnapshot?: TurnModelSnapshot
  readonly workingMemory: WorkingMemory
  readonly result?: TurnResult
  readonly mode?: PermissionMode
  readonly skillGuidance?: string
  readonly skillGuards?: readonly SkillGuardRef[]
  /** turn 起点固定的 skill catalog/decision/runtime 快照。 */
  readonly skillSnapshot?: SkillTurnSnapshot
  readonly finalText?: string
  readonly toolRounds?: number
  readonly lastToolError?: string | null
  readonly contextRetries?: number
  readonly finalizing?: boolean
  readonly cumulativeInputTokens?: number
  readonly routeSnapshot?: {
    readonly provider: Provider
    readonly model: ModelProfile
    readonly tier: ModelTier
  }
}

/** 执行记录扩展：保存输入与结果，才能真正防止重放。 */
export interface PersistedToolExecution extends ToolExecutionRecord {
  readonly input: Readonly<Record<string, unknown>>
  readonly descriptorVersion: string
  readonly idempotent: boolean
  readonly result?: ToolResult
  readonly principalId?: string
  readonly permissionRequestIds?: readonly string[]
}

/** 已决议授权，用于幂等恢复与显式授权范围。 */
export interface PersistedPermissionResolution {
  readonly requestId: string
  readonly resolution: PermissionResolution
  readonly resolvedAt: string
}

/** HTTP/命令层幂等键记录。 */
export interface IdempotencyRecord {
  readonly key: string
  readonly operation: string
  readonly requestHash: string
  readonly response: unknown
  readonly createdAt: string
}

/** chat.json 中的新运行时扩展区。 */
export interface RuntimeDocument {
  readonly schema_version: number
  readonly revision: number
  readonly turns: readonly PersistedTurn[]
  readonly permission_requests: readonly PermissionRequest[]
  /**
   * 待回答 / 已回答的提问请求（`ask_user_question`）。
   *
   * **additive 字段**：旧 `chat.json` 没有它，`normalizeRuntime` 容错为 `[]`。
   * 与权限请求并列而不是塞进 `permission_requests`——两者的超时语义不同
   * （权限超时按 deny，提问超时让 turn 继续跑），混在一起会让恢复逻辑
   * 无法判断该重新弹审批还是重新提问（ADR 0002 §四）。
   */
  readonly user_input_requests: readonly PersistedUserInputRequest[]
  readonly permission_resolutions: readonly PersistedPermissionResolution[]
  readonly tool_executions: readonly PersistedToolExecution[]
  readonly idempotency: readonly IdempotencyRecord[]
  readonly events: readonly RuntimeEventEnvelope[]
}

/** 工作区会话文件。conversations/messages 与旧实现逐字兼容。 */
export interface ChatDocument {
  readonly schema_version: number
  readonly conversations: readonly Conversation[]
  readonly messages: readonly Message[]
  readonly runtime: RuntimeDocument
  readonly [key: string]: unknown
}

/** 启动恢复扫描的结果。 */
export interface RecoverySnapshot {
  readonly unfinishedTurns: readonly PersistedTurn[]
  readonly pendingPermissions: readonly PermissionRequest[]
  /**
   * 仍未被回答的提问请求。
   *
   * 与 `pendingPermissions` 分开报告：恢复时一个要重新弹审批对话框，
   * 另一个要重新弹问卷，UI 的处理路径不同。
   */
  readonly pendingUserInputs: readonly PersistedUserInputRequest[]
  readonly unknownExecutions: readonly PersistedToolExecution[]
}
