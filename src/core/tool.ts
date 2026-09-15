/**
 * 工具与权限契约。
 *
 * ## 关键约束：唯一门控
 *
 * progess.md 设计约束 3：「所有工具都经过统一 `PermissionEngine`，不能由 UI
 * 或模型调用直接绕过」。
 *
 * 因此工具**不能**自己决定是否执行——它只能声明自己的安全要求
 * （`Tool.safetyCheck`），由 `PermissionEngine` 综合决策。旧实现把三道门控
 * 散在 `ToolExecutor` 与各工具内部，导致 `execute_approved()` 能跳过其中两道；
 * 本实现把决策集中到一处，执行路径只有一条。
 *
 * ## 决策顺序（parts/09 §5，固定不可交换）
 *
 * ```
 * 工具策略 → 参数策略 → workspace/session 策略 → skill guard → 风险策略
 * ```
 *
 * ⚠️ 注意这与旧实现的顺序**相反**：旧实现把 skill guard 放在第一道（先于模式权限），
 * 而 09 把它放在第 4 道。新代码一律按 09 的顺序。
 */

import { type AgentBudget } from './budget.js'
import { type SessionId, type ToolCallId, type TurnId } from './ids.js'

// ── 风险与能力 ────────────────────────────────────────────────────

/**
 * 风险等级。
 *
 * ⚠️ **4 档**。旧实现与 `parts/08` 只列了 3 档（无 `critical`），
 * `parts/09` §5 的 `PermissionDecision.risk` 给出 4 档。以 09 为准。
 *
 * 旧实现里 `risk_level` **不参与任何门控判定**，只用于审批界面的风险徽标。
 * 本实现让它成为风险策略阶段的输入——即真正参与决策。
 */
export const RiskLevel = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
} as const

/** 风险等级类型。 */
export type RiskLevel = (typeof RiskLevel)[keyof typeof RiskLevel]

/**
 * 工具能力标签。
 *
 * 用于路由与策略匹配：例如 plan 模式可以一次性拒绝所有带 `WRITE` 标签的工具，
 * 而不必逐个工具列举。比"按工具名硬编码集合"更不容易漏。
 */
export const ToolCapability = {
  /** 读取文件系统。 */
  READ: 'read',
  /** 写入文件系统。 */
  WRITE: 'write',
  /** 访问网络。 */
  NETWORK: 'network',
  /** 执行 shell 命令。 */
  SHELL: 'shell',
  /** 触发界面交互（提问、审批）。 */
  INTERACTIVE: 'interactive',
  /** 委派给子代理。 */
  DELEGATE: 'delegate',
  /** 访问外部数据源（MCP）。 */
  DATA_ACCESS: 'data_access',
} as const

/** 工具能力类型。 */
export type ToolCapability = (typeof ToolCapability)[keyof typeof ToolCapability]

// ── 工具描述 ──────────────────────────────────────────────────────

/**
 * 工具的静态描述。
 *
 * 这是**声明**，不是行为——所有判定都基于它，工具自身不参与决策。
 */
export interface ToolDescriptor {
  /** 工具名。必须全局唯一。 */
  readonly name: string
  /** 面向模型的说明。**逐字影响模型行为，不得改写**。 */
  readonly description: string
  /**
   * 输入 JSON Schema。
   *
   * 字段名保持 `input_schema`（snake_case）——它直接作为 Anthropic 请求体的
   * 一部分发出，改名为 `inputSchema` 会引入一层无意义的映射。
   */
  readonly input_schema: Readonly<Record<string, unknown>>
  /** 工具版本。用于执行记录与恢复时的兼容判定。 */
  readonly version: string
  readonly risk_level: RiskLevel
  readonly capabilities: readonly ToolCapability[]
  /** 来源。MCP 工具的命名约定为 `mcp_<server>_<tool>`。 */
  readonly source: ToolSource
}

/** 工具来源。 */
export type ToolSource =
  { readonly kind: 'native' } | { readonly kind: 'mcp'; readonly serverId: string }

// ── 权限 ──────────────────────────────────────────────────────────

/** 权限动作。 */
export const PermissionAction = {
  ALLOW: 'allow',
  ASK: 'ask',
  DENY: 'deny',
} as const

/** 权限动作类型。 */
export type PermissionAction = (typeof PermissionAction)[keyof typeof PermissionAction]

/**
 * 授权范围。
 *
 * 规格只给出了五种授权种类的**名称**（parts/09 §5），未定义具体形状。
 * 这里按各自的过期语义设计为可辨识联合——`scope` 与 `expiresAt` 都是
 * 必需字段，因为「授权必须有过期时间」是硬性要求，
 * 不允许出现"永久授权"这种状态。
 */
export type GrantScope =
  | {
      readonly kind: 'allow-once'
      /** 一次性授权在用掉后即失效。 */
      readonly toolCallId: ToolCallId
    }
  | {
      readonly kind: 'tool'
      /** 按工具名授权，在该会话内有效。 */
      readonly toolName: string
      readonly sessionId: SessionId
      readonly expiresAt: string
    }
  | {
      readonly kind: 'server'
      /** 按 MCP server 授权。 */
      readonly serverId: string
      readonly expiresAt: string
    }
  | {
      readonly kind: 'workspace'
      /** 绑定到某个工作区根目录。 */
      readonly workspaceRoot: string
      readonly expiresAt: string
    }
  | {
      readonly kind: 'session'
      readonly sessionId: SessionId
      readonly expiresAt: string
    }

/**
 * 权限决策。
 *
 * 由 `PermissionEngine.decide()` 产出，是**唯一**的执行许可来源。
 */
export interface PermissionDecision {
  readonly action: PermissionAction
  /** 面向人的理由。`ask` 时它会成为审批界面上的说明文本。 */
  readonly reason: string
  /**
   * 做出该决策的策略标识。
   *
   * 必需且稳定——每个结构化事件都要带上它（parts/09 §8），
   * 这样"为什么这个工具被拒了"可以只靠日志回答，无需复现。
   */
  readonly policyId: string
  readonly risk: RiskLevel
  /** 授予的范围。`allow` 时可选（不授予持久权限则省略）。 */
  readonly scope?: GrantScope
}

/**
 * 权限请求的状态。
 *
 * ⚠️ **只用 5 个状态**，旧实现有 8 个。移除的三个是 `APPROVED`、`EXECUTED`、
 * `FAILED_AFTER_APPROVAL`——它们描述的是**执行**的进展，不是审批请求自身的状态。
 * 混在一个枚举里会导致"请求已批准"与"批准后执行成功"无法区分，
 * 恢复时也就无法判断该重新执行还是只补写结果。
 *
 * 执行结果由独立的 `ToolExecutionStatus` 表达（见下）。
 */
export const PermissionRequestStatus = {
  /** 已创建，尚未展示给用户。 */
  CREATED: 'CREATED',
  /** 等待用户决定。 */
  PENDING_USER_APPROVAL: 'PENDING_USER_APPROVAL',
  /** 用户批准。 */
  APPROVED: 'APPROVED',
  DENIED: 'DENIED',
  /** 等待超时。**按拒绝处理**（parts/09 §5）。 */
  EXPIRED: 'EXPIRED',
  /** 会话中断或进程关闭导致取消。 */
  CANCELLED: 'CANCELLED',
} as const

/** 权限请求状态类型。 */
export type PermissionRequestStatus =
  (typeof PermissionRequestStatus)[keyof typeof PermissionRequestStatus]

/** 终态集合。进入后不可再迁移。 */
export const TERMINAL_PERMISSION_STATUSES: ReadonlySet<PermissionRequestStatus> =
  new Set<PermissionRequestStatus>([
    PermissionRequestStatus.DENIED,
    PermissionRequestStatus.EXPIRED,
    PermissionRequestStatus.CANCELLED,
  ])

/**
 * 权限请求的合法迁移。
 *
 * ⚠️ `APPROVED` 不是终态——它必须继续走向执行（执行结果由
 * `ToolExecutionStatus` 记录）。这是"批准后只能执行一次"（防重放）的实现基础：
 * 重新执行必须是显式的新迁移，不能靠重读状态触发。
 */
const PERMISSION_TRANSITIONS: Readonly<
  Record<PermissionRequestStatus, readonly PermissionRequestStatus[]>
> = {
  [PermissionRequestStatus.CREATED]: [
    PermissionRequestStatus.PENDING_USER_APPROVAL,
    PermissionRequestStatus.CANCELLED,
  ],
  [PermissionRequestStatus.PENDING_USER_APPROVAL]: [
    PermissionRequestStatus.APPROVED,
    PermissionRequestStatus.DENIED,
    PermissionRequestStatus.EXPIRED,
    PermissionRequestStatus.CANCELLED,
  ],
  [PermissionRequestStatus.APPROVED]: [],
  [PermissionRequestStatus.DENIED]: [],
  [PermissionRequestStatus.EXPIRED]: [],
  [PermissionRequestStatus.CANCELLED]: [],
}

/** 判断权限请求的状态迁移是否合法。 */
export function canTransitionPermission(
  from: PermissionRequestStatus,
  to: PermissionRequestStatus,
): boolean {
  return PERMISSION_TRANSITIONS[from].includes(to)
}

/**
 * 一个待审批或已审批的权限请求。
 *
 * **必须可持久化**——`ask` 之前要先落盘，否则进程在等待期间崩溃就无法恢复
 * （parts/09 §5：「`ask` 必须先创建可恢复的持久化请求」）。
 */
export interface PermissionRequest {
  readonly request_id: string
  readonly session_id: SessionId
  readonly turn_id: TurnId
  readonly tool_call_id: ToolCallId
  readonly tool_name: string
  /**
   * 脱敏并截断后的参数摘要。
   *
   * ⚠️ **必须脱敏**。它会出现在审批界面、transcript 与日志里，
   * 不能携带明文密钥或敏感文件内容。
   */
  readonly args_preview: string
  readonly risk_level: RiskLevel
  readonly reason: string
  readonly status: PermissionRequestStatus
  readonly created_at: string
  /** 到期时刻（epoch 毫秒）。超时按拒绝处理。 */
  readonly expires_at: number
  readonly resolved_at: number | null
  /** 决议来源：`"user"` 或 `"system"`。 */
  readonly resolved_by: string
  /** 决议内容。例如 `"approved"` / `"denied"` / `"timeout"` / `"cancel"`。 */
  readonly resolution: string
}

// ── 工具执行 ──────────────────────────────────────────────────────

/**
 * 工具执行的状态。
 *
 * 与权限状态分开，因为二者描述不同的生命周期。特别是 `UNKNOWN`：
 * 进程在工具执行中途崩溃时，我们**不知道**操作是否已产生副作用，
 * 因此不得自动重放不可幂等的操作（parts/09 §2）。
 */
export const ToolExecutionStatus = {
  /** 尚未开始。 */
  PENDING: 'pending',
  /** 执行中。 */
  RUNNING: 'running',
  SUCCESS: 'success',
  FAILURE: 'failure',
  /** 状态未知——进程中断，副作用是否发生无法确定。**
   * ⚠️ 落入此状态的操作不得自动重放，必须由人确认。**
   */
  UNKNOWN: 'unknown',
} as const

/** 工具执行状态类型。 */
export type ToolExecutionStatus = (typeof ToolExecutionStatus)[keyof typeof ToolExecutionStatus]

/**
 * 工具执行的持久化记录。
 *
 * 用于 `toolCallId + inputHash` 去重（parts/09 §2）：provider 超时后重试模型请求
 * 时，同一工具调用不得被重复执行。`inputHash` 参与去重是因为同一个
 * `toolCallId` 理论上可能被模型以不同参数复用——只有两者都相同才算同一次执行。
 */
export interface ToolExecutionRecord {
  readonly executionId: string
  readonly sessionId: SessionId
  readonly turnId: TurnId
  readonly toolCallId: ToolCallId
  readonly toolName: string
  /** 输入参数的规范化哈希。用于与 `toolCallId` 组合去重。 */
  readonly inputHash: string
  readonly status: ToolExecutionStatus
  readonly startedAt: string
  readonly finishedAt: string | null
  /** 结构化错误码。成功时为 `null`。 */
  readonly errorCode: string | null
  readonly elapsedMs: number | null
}

// ── 工具结果 ──────────────────────────────────────────────────────

/**
 * 工具执行结果。
 *
 * ⚠️ `content` 是**唯一**进入模型上下文的内容；`data` 与 `meta` 只落盘、
 * 不送模型。这个分界很重要：把结构化数据塞进 `content` 会浪费上下文，
 * 把面向模型的说明塞进 `data` 则模型看不到。
 */
export interface ToolResult {
  readonly ok: boolean
  /**
   * 面向模型的文本。
   *
   * `ok=false` 时它应当是**给模型看的解释**（模型据此自我调整），
   * 而不是给日志看的堆栈。
   */
  readonly content: string
  /** 结构化旁路数据（退出码、字节数等）。**不送模型**。 */
  readonly data?: Readonly<Record<string, unknown>>
  /** 机器可读错误码。成功时为 `null`。 */
  readonly error_code: string | null
  /** 执行元数据（耗时、guard 信息等）。**不送模型**。 */
  readonly meta: Readonly<Record<string, unknown>>
}

/** 工具输入校验结果。 */
export type ValidationResult =
  | { readonly ok: true; readonly value: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly errors: readonly ValidationIssue[] }

/** 单条校验问题。 */
export interface ValidationIssue {
  /** 出错字段的路径，如 `["path"]` 或 `["questions", "0", "label"]`。 */
  readonly path: readonly (string | number)[]
  readonly message: string
}

// ── 工具上下文 ────────────────────────────────────────────────────

/**
 * 工具执行上下文。
 *
 * 由 runtime 构造并注入，工具只能读取。**工具不得依赖这里之外的全局状态**——
 * 那会破坏可测试性与子代理隔离。
 */
export interface ToolContext {
  readonly sessionId: SessionId
  readonly turnId: TurnId
  /** 主体标识。Web UI 下每个用户一个，用于鉴权。 */
  readonly principalId: string
  /** 工作区根目录（绝对路径）。所有相对路径基于它解析。 */
  readonly workspaceRoot: string
  /** 允许读取的根目录。为空时回落为 `[workspaceRoot]`。 */
  readonly allowedReadRoots: readonly string[]
  /** 允许写入的根目录。为空时回落为 `[workspaceRoot]`。 */
  readonly allowedWriteRoots: readonly string[]
  /**
   * 跨工具共享的 turn 级状态。
   *
   * 承载 todo 列表、plan 模式标记、skill 运行时守护等。更新方式为
   * **构造新对象**（`{...old, ...patch}`），不做原地修改。
   */
  readonly turnState: Readonly<Record<string, unknown>>
  /**
   * 本 turn 的预算。
   *
   * 工具可以读取它做自我约束（例如提前收窄输出），但**不得**直接扣减——
   * 扣减由 runtime 统一记账。
   */
  readonly budget: AgentBudget
  /** 取消信号。工具必须把它传给所有子操作。 */
  readonly signal: AbortSignal
}

// ── 工具接口 ──────────────────────────────────────────────────────

/**
 * 一个工具。
 *
 * ⚠️ `execute` 的参数顺序是 **context 在前、input 在后**，与旧实现的
 * `run(input, context)` 相反。顺序本身不重要，重要的是全项目统一——
 * 参数顺序颠倒且两者都是对象时，编译器不会报错。
 */
export interface Tool {
  readonly descriptor: ToolDescriptor

  /**
   * 校验输入。
   *
   * 输入类型是 `unknown` 而非 `Record<string, unknown>`：这个方法的职责就是
   * 把不可信输入**收窄**为可信结构。调用方在拿到 `ok: true` 之前不得访问任何字段。
   */
  validate(input: unknown): ValidationResult

  /**
   * 声明本次调用的安全要求。
   *
   * 这是工具**参与**权限决策的唯一方式——它给出工具自身的判断，
   * 最终由 `PermissionEngine` 综合工具策略、参数策略、workspace/session 策略、
   * skill guard 与风险策略后裁决。
   *
   * 返回 `undefined` 表示"本工具无额外要求"（读取类工具的常见情况）。
   */
  safetyCheck?(
    input: Readonly<Record<string, unknown>>,
    ctx: ToolContext,
  ): ToolSafetyClaim | undefined

  /** 执行。错误应通过 `ToolResult.ok=false` 表达，异常会被 runtime 兜底捕获。 */
  execute(ctx: ToolContext, input: Readonly<Record<string, unknown>>): Promise<ToolResult>
}

/**
 * 工具对自身安全要求的声明。
 *
 * 注意这**不是**最终决策——`PermissionAction.DENY` 表示"我认为不该执行"，
 * 但引擎仍可能因更宽松的策略而允许；反之引擎也可以否决工具的 `ALLOW`。
 */
export interface ToolSafetyClaim {
  readonly action: PermissionAction
  readonly reason: string
}

// ── 审批服务 ──────────────────────────────────────────────────────

/**
 * 审批服务。
 *
 * 内核通过它请求人工授权，不关心对端是 TUI 对话框、Web 界面还是自动化策略。
 *
 * parts/09 §2 要求：**超时、取消和 UI 不可用均按 deny 处理**。
 * 因此实现必须保证：任何非批准的结果都返回 `DENY`，绝不"卡住不返回"。
 */
/**
 * 审批请求的默认有效期（毫秒）。
 *
 * 旧实现把这个 `120_000` 硬编码在工具执行器里（`expires_at` 的计算），
 * 而 `parts/09` §3 与 `CLAUDE.md` 都要求阈值收进配置、不得散落在局部。
 * 这里给出契约侧的默认值，执行层与运行时共用同一个来源；
 * Phase 7 的 `AppPolicy` 会允许按配置覆盖。
 */
export const DEFAULT_PERMISSION_TIMEOUT_MS = 120_000

export interface ApprovalService {
  /**
   * 请求审批。
   *
   * ⚠️ **必须幂等**：同一 `request.request_id` 重复调用应返回同一决定，
   * 不得重复弹窗或重复执行（重连、重试、恢复都会触发重复调用）。
   */
  request(request: PermissionRequest, signal: AbortSignal): Promise<PermissionResolution>
}

/** 用户对权限请求的决议。 */
export interface PermissionResolution {
  readonly requestId: string
  readonly decision: PermissionAction
  /** 决议来源。`"system"` 表示超时或取消导致的兜底拒绝。 */
  readonly resolvedBy: 'user' | 'system'
  /**
   * 若批准，是否在更宽的范围内记住该决定。
   *
   * ⚠️ 只在用户显式选择时设置。**不得因"同一工具被批准过"就自动扩大范围**——
   * 那会绕过后续的参数校验（权限漂移）。
   */
  readonly grantScope?: GrantScope
  /** 拒绝理由，会回灌给模型让它调整策略。 */
  readonly reason?: string
}

// ── 权限引擎 ──────────────────────────────────────────────────────

/** 权限引擎的决策输入。 */
export interface PermissionQuery {
  readonly toolName: string
  readonly input: Readonly<Record<string, unknown>>
  readonly descriptor: ToolDescriptor
  readonly ctx: ToolContext
  /** 工具自身的声明，来自 `Tool.safetyCheck`。 */
  readonly toolClaim?: ToolSafetyClaim
  /** 当前权限模式。 */
  readonly mode: PermissionMode
  /** 当前生效的 skill 运行时守护。 */
  readonly skillGuards: readonly SkillGuardRef[]
}

/** 权限模式。 */
export const PermissionMode = {
  /** 读写皆需审批（写操作）。 */
  NORMAL: 'normal',
  /** 写操作免审批，shell 与网络仍需审批。 */
  AUTO_EDIT: 'auto_edit',
  /** 免审批。**但仍保留工具自身的安全检查与路径逃逸防护**。 */
  YOLO: 'yolo',
  /** 只读：写操作硬拒。 */
  PLAN: 'plan',
} as const

/** 权限模式类型。 */
export type PermissionMode = (typeof PermissionMode)[keyof typeof PermissionMode]

/**
 * skill 运行时守护的引用。
 *
 * 只保留判定所需的字段——真正的守护规则由 skill 子系统持有。
 * 这样权限引擎不必依赖 skill 模块的数据结构。
 */
export interface SkillGuardRef {
  readonly guardId: string
  readonly skillName: string
  /** 守护类型，如 `deny_tool` / `ask_tool` / `path_scope` / `deny_command_pattern`。 */
  readonly guardType: string
  readonly action: PermissionAction
  readonly reason: string
  readonly parameters: Readonly<Record<string, unknown>>
}

/**
 * 权限引擎。
 *
 * **所有**工具执行都必须经过它（progess.md 设计约束 3）。UI 与模型都无法绕过：
 * 前者只能提交 `PermissionResolution`，后者只能发起 `tool_use`。
 */
export interface PermissionEngine {
  decide(query: PermissionQuery): Promise<PermissionDecision>
}
