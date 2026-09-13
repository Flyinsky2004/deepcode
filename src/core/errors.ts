/**
 * 稳定错误码与结构化错误。
 *
 * 设计约束（progess.md 设计约束 6）：「新增能力必须有结构化事件、**稳定错误码**和幂等语义」。
 *
 * "稳定"意味着两件事：
 * 1. 错误码是**公开契约**——客户端、测试、审计日志都依赖它做分支判断，
 *    因此字符串值与语义一旦发布不得随意更改。
 * 2. 错误码**可枚举**。调用方应当能穷举处理，而不是靠正则匹配错误消息。
 *
 * 错误消息（`message`）面向人、可以随文案调整；错误码面向程序、保持稳定。
 * 不要把诊断信息塞进错误码，也不要用错误消息做控制流。
 */

/**
 * 全部错误码。
 *
 * 按子系统分段，便于新增时判断归属。新增错误码时必须同时在
 * `ERROR_CATEGORY` 中登记分类。
 */
export const ErrorCode = {
  // ── 输入校验 / 契约 ──────────────────────────────────────────────
  /** 外部输入未通过 schema 校验（磁盘 JSON、HTTP body、模型输出）。 */
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  /** 命令行 / slash command 参数非法。 */
  INVALID_COMMAND_ARGUMENTS: 'INVALID_COMMAND_ARGUMENTS',

  // ── 权限 ────────────────────────────────────────────────────────
  /** 策略判定为拒绝，直接不执行。 */
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  /** 策略判定为需人工审批，审批尚未完成。 */
  PERMISSION_REQUIRED: 'PERMISSION_REQUIRED',
  /** 审批请求等待超时。超时按 deny 处理（parts/09 §5）。 */
  PERMISSION_TIMEOUT: 'PERMISSION_TIMEOUT',

  // ── 工具 ────────────────────────────────────────────────────────
  /** 请求的工具不在注册表中。 */
  TOOL_NOT_FOUND: 'TOOL_NOT_FOUND',
  /** 工具输入不满足其 input schema。 */
  TOOL_INVALID_INPUT: 'TOOL_INVALID_INPUT',
  /** 工具执行过程中抛出异常。 */
  TOOL_RUNTIME_ERROR: 'TOOL_RUNTIME_ERROR',
  /** 工具执行超出其超时预算。 */
  TOOL_TIMEOUT: 'TOOL_TIMEOUT',
  /** 工具输出超过限额，已被截断或拒绝。 */
  TOOL_OUTPUT_LIMIT: 'TOOL_OUTPUT_LIMIT',
  /** 工具执行状态未知（如进程中断），不可幂等重放（parts/09 §2）。 */
  TOOL_EXECUTION_UNKNOWN: 'TOOL_EXECUTION_UNKNOWN',

  // ── Skill ──────────────────────────────────────────────────────
  /** skill 运行时守护拒绝了该工具调用。 */
  SKILL_GUARD_DENIED: 'SKILL_GUARD_DENIED',
  /** skill 定义不合法（frontmatter 缺失、schema 校验失败）。 */
  SKILL_INVALID_DEFINITION: 'SKILL_INVALID_DEFINITION',

  // ── 模型 / Provider ─────────────────────────────────────────────
  /** 没有任何已启用且满足能力要求的模型可用。 */
  MODEL_CAPABILITY_UNAVAILABLE: 'MODEL_CAPABILITY_UNAVAILABLE',
  /** 引用的 provider 或模型不存在，或未启用。 */
  MODEL_NOT_FOUND: 'MODEL_NOT_FOUND',
  /** provider 凭据缺失或失效。 */
  PROVIDER_AUTH_FAILED: 'PROVIDER_AUTH_FAILED',
  /** 连接 provider 失败（DNS / TCP / TLS）。 */
  PROVIDER_CONNECTION_FAILED: 'PROVIDER_CONNECTION_FAILED',
  /** provider 返回 429。 */
  PROVIDER_RATE_LIMITED: 'PROVIDER_RATE_LIMITED',
  /** provider 返回暂时性 5xx。 */
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  /** 流式响应解析失败或协议违约。 */
  PROVIDER_STREAM_INVALID: 'PROVIDER_STREAM_INVALID',

  // ── 上下文 / 预算 ───────────────────────────────────────────────
  /** 上下文超过窗口，且压缩无法解决。 */
  CONTEXT_EXCEEDED: 'CONTEXT_EXCEEDED',
  /** 预算耗尽（模型调用数、工具调用数、墙钟时间、token 或成本）。 */
  BUDGET_EXCEEDED: 'BUDGET_EXCEEDED',

  // ── 会话 / 并发 ─────────────────────────────────────────────────
  /** 同一 session 已有 active turn（parts/09 §1.1）。 */
  SESSION_BUSY: 'SESSION_BUSY',
  /** 目标 session 不存在或无权限访问。 */
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  /** 非法状态迁移，或事件/请求重复但内容不一致。 */
  INVALID_STATE_TRANSITION: 'INVALID_STATE_TRANSITION',

  // ── 存储 ────────────────────────────────────────────────────────
  /** 读取持久化数据失败（不存在、损坏、权限不足）。 */
  STORAGE_READ_FAILED: 'STORAGE_READ_FAILED',
  /** 写入持久化数据失败。 */
  STORAGE_WRITE_FAILED: 'STORAGE_WRITE_FAILED',
  /** 检测到外部修改，拒绝覆盖（parts/09 §5）。 */
  STORAGE_EXTERNAL_MODIFICATION: 'STORAGE_EXTERNAL_MODIFICATION',
  /** 磁盘数据的 schema version 高于本实现所能处理。 */
  STORAGE_SCHEMA_UNSUPPORTED: 'STORAGE_SCHEMA_UNSUPPORTED',

  // ── Sub-agent ──────────────────────────────────────────────────
  /** 子代理定义不存在或加载冲突（同名定义）。 */
  SUBAGENT_DEFINITION_INVALID: 'SUBAGENT_DEFINITION_INVALID',
  /** 子代理状态无法恢复（continuationHandle 失效）。 */
  SUBAGENT_RESUME_FAILED: 'SUBAGENT_RESUME_FAILED',

  // ── MCP ────────────────────────────────────────────────────────
  /** MCP server 配置非法（缺字段、传输不支持、重名）。 */
  MCP_CONFIG_INVALID: 'MCP_CONFIG_INVALID',
  /** MCP server 连接失败。 */
  MCP_CONNECTION_FAILED: 'MCP_CONNECTION_FAILED',
  /** MCP 请求超时。 */
  MCP_TIMEOUT: 'MCP_TIMEOUT',
  /** 熔断器打开，暂时不再请求该 server（parts/09 §8）。 */
  MCP_CIRCUIT_OPEN: 'MCP_CIRCUIT_OPEN',

  // ── 内部 ────────────────────────────────────────────────────────
  /** 未被上面任何一类覆盖的内部错误。 */
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const

/** 错误码类型。 */
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode]

/**
 * 错误码分类。用于日志分组、指标聚合与 UI 呈现（例如权限类错误要引导用户去审批）。
 */
export const ErrorCategory = {
  VALIDATION: 'validation',
  PERMISSION: 'permission',
  TOOL: 'tool',
  SKILL: 'skill',
  MODEL: 'model',
  CONTEXT: 'context',
  SESSION: 'session',
  STORAGE: 'storage',
  SUBAGENT: 'subagent',
  MCP: 'mcp',
  INTERNAL: 'internal',
} as const

/** 错误分类类型。 */
export type ErrorCategory = (typeof ErrorCategory)[keyof typeof ErrorCategory]

/** 错误码 → 分类。新增错误码时必须在此登记，否则类型检查不通过。 */
export const ERROR_CATEGORY: Readonly<Record<ErrorCode, ErrorCategory>> = {
  [ErrorCode.VALIDATION_FAILED]: ErrorCategory.VALIDATION,
  [ErrorCode.INVALID_COMMAND_ARGUMENTS]: ErrorCategory.VALIDATION,

  [ErrorCode.PERMISSION_DENIED]: ErrorCategory.PERMISSION,
  [ErrorCode.PERMISSION_REQUIRED]: ErrorCategory.PERMISSION,
  [ErrorCode.PERMISSION_TIMEOUT]: ErrorCategory.PERMISSION,

  [ErrorCode.TOOL_NOT_FOUND]: ErrorCategory.TOOL,
  [ErrorCode.TOOL_INVALID_INPUT]: ErrorCategory.TOOL,
  [ErrorCode.TOOL_RUNTIME_ERROR]: ErrorCategory.TOOL,
  [ErrorCode.TOOL_TIMEOUT]: ErrorCategory.TOOL,
  [ErrorCode.TOOL_OUTPUT_LIMIT]: ErrorCategory.TOOL,
  [ErrorCode.TOOL_EXECUTION_UNKNOWN]: ErrorCategory.TOOL,

  [ErrorCode.SKILL_GUARD_DENIED]: ErrorCategory.SKILL,
  [ErrorCode.SKILL_INVALID_DEFINITION]: ErrorCategory.SKILL,

  [ErrorCode.MODEL_CAPABILITY_UNAVAILABLE]: ErrorCategory.MODEL,
  [ErrorCode.MODEL_NOT_FOUND]: ErrorCategory.MODEL,
  [ErrorCode.PROVIDER_AUTH_FAILED]: ErrorCategory.MODEL,
  [ErrorCode.PROVIDER_CONNECTION_FAILED]: ErrorCategory.MODEL,
  [ErrorCode.PROVIDER_RATE_LIMITED]: ErrorCategory.MODEL,
  [ErrorCode.PROVIDER_UNAVAILABLE]: ErrorCategory.MODEL,
  [ErrorCode.PROVIDER_STREAM_INVALID]: ErrorCategory.MODEL,

  [ErrorCode.CONTEXT_EXCEEDED]: ErrorCategory.CONTEXT,
  [ErrorCode.BUDGET_EXCEEDED]: ErrorCategory.CONTEXT,

  [ErrorCode.SESSION_BUSY]: ErrorCategory.SESSION,
  [ErrorCode.SESSION_NOT_FOUND]: ErrorCategory.SESSION,
  [ErrorCode.INVALID_STATE_TRANSITION]: ErrorCategory.SESSION,

  [ErrorCode.STORAGE_READ_FAILED]: ErrorCategory.STORAGE,
  [ErrorCode.STORAGE_WRITE_FAILED]: ErrorCategory.STORAGE,
  [ErrorCode.STORAGE_EXTERNAL_MODIFICATION]: ErrorCategory.STORAGE,
  [ErrorCode.STORAGE_SCHEMA_UNSUPPORTED]: ErrorCategory.STORAGE,

  [ErrorCode.SUBAGENT_DEFINITION_INVALID]: ErrorCategory.SUBAGENT,
  [ErrorCode.SUBAGENT_RESUME_FAILED]: ErrorCategory.SUBAGENT,

  [ErrorCode.MCP_CONFIG_INVALID]: ErrorCategory.MCP,
  [ErrorCode.MCP_CONNECTION_FAILED]: ErrorCategory.MCP,
  [ErrorCode.MCP_TIMEOUT]: ErrorCategory.MCP,
  [ErrorCode.MCP_CIRCUIT_OPEN]: ErrorCategory.MCP,

  [ErrorCode.INTERNAL_ERROR]: ErrorCategory.INTERNAL,
}

/**
 * 判断某错误是否为**暂时性**的，即重试可能成功。
 *
 * 这份判定是 fallback 与重试策略的唯一依据（parts/09 §9.5）：
 * 「fallback 只在连接失败、429、暂时性 5xx、模型能力不足时触发；
 * 不得在工具执行失败、权限拒绝或模型输出质量不足时自动换模型重放」。
 *
 * ⚠️ 权限拒绝、校验失败、工具运行错误**不是**暂时性错误——重试它们
 * 只会浪费时间并可能造成重复副作用。
 */
const TRANSIENT_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  ErrorCode.PROVIDER_CONNECTION_FAILED,
  ErrorCode.PROVIDER_RATE_LIMITED,
  ErrorCode.PROVIDER_UNAVAILABLE,
  ErrorCode.PROVIDER_STREAM_INVALID,
  ErrorCode.MCP_CONNECTION_FAILED,
  ErrorCode.MCP_TIMEOUT,
  ErrorCode.TOOL_TIMEOUT,
  ErrorCode.STORAGE_READ_FAILED,
])

/** 该错误码是否属于「重试可能成功」的暂时性失败。 */
export function isTransient(code: ErrorCode): boolean {
  return TRANSIENT_CODES.has(code)
}

/**
 * 是否允许因该错误而切换到 fallback 模型。
 *
 * 比 `isTransient` 多一条：模型能力不足也要 fallback（换一个更强的模型可能满足）。
 * 但**工具执行失败、权限拒绝绝不触发 fallback**。
 */
export function allowsModelFallback(code: ErrorCode): boolean {
  return isTransient(code) || code === ErrorCode.MODEL_CAPABILITY_UNAVAILABLE
}

/**
 * 结构化错误详情。
 *
 * 这是错误对象的**序列化形态**——它可以落进事件日志、审计记录与 API 响应。
 * 因此这里只允许放可 JSON 序列化的值，且**必须已脱敏**
 * （parts/09 §8：敏感参数默认脱敏；API key 不得出现在日志、事件、导出文件、URL 或前端响应中）。
 */
export interface AgentErrorDetails {
  /** 稳定错误码。 */
  readonly code: ErrorCode
  /** 面向人的说明。可以改文案，不用于控制流。 */
  readonly message: string
  /** 由哪个子系统抛出。 */
  readonly source?: string
  /** 暂时性失败时的建议重试间隔（毫秒）。 */
  readonly retryAfterMs?: number
  /**
   * 附加的结构化上下文。**必须已脱敏**——
   * 不要放入 API key、完整环境变量、绝对路径 secrets 或未脱敏的工具参数。
   */
  readonly context?: Readonly<Record<string, unknown>>
}

/**
 * 本项目的统一错误类型。
 *
 * 继承 `Error` 以便在 `await` 边界上自然传播、保留堆栈；同时携带稳定错误码，
 * 使得上层无需解析消息文本即可分支处理。
 */
export class AgentError extends Error {
  /** 稳定错误码。 */
  readonly code: ErrorCode
  /** 错误分类，由 `code` 派生。 */
  readonly category: ErrorCategory
  /** 由哪个子系统抛出。 */
  readonly source: string | undefined
  /** 建议重试间隔（毫秒）。 */
  readonly retryAfterMs: number | undefined
  /** 附加结构化上下文（已脱敏）。 */
  readonly context: Readonly<Record<string, unknown>> | undefined

  constructor(details: AgentErrorDetails, options?: { cause?: unknown }) {
    super(details.message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'AgentError'
    this.code = details.code
    this.category = ERROR_CATEGORY[details.code]
    this.source = details.source
    this.retryAfterMs = details.retryAfterMs
    this.context = details.context
  }

  /** 该错误是否可重试。 */
  get isTransient(): boolean {
    return isTransient(this.code)
  }

  /** 序列化为可安全落盘 / 传输的对象。 */
  toDetails(): AgentErrorDetails {
    return {
      code: this.code,
      message: this.message,
      ...(this.source === undefined ? {} : { source: this.source }),
      ...(this.retryAfterMs === undefined ? {} : { retryAfterMs: this.retryAfterMs }),
      ...(this.context === undefined ? {} : { context: this.context }),
    }
  }

  /** 类型守卫：把 `unknown` 收窄为 `AgentError`。 */
  static is(value: unknown): value is AgentError {
    return value instanceof AgentError
  }
}

/**
 * 把一个未知的抛出物归一化为 `AgentError`。
 *
 * 用于 `catch` 边界：`useUnknownInCatchVariables` 下捕获到的是 `unknown`，
 * 而契约要求错误必须是结构化的、带稳定错误码的。
 *
 * 已经是 `AgentError` 的原样返回（保留其错误码与上下文），否则包装为
 * `INTERNAL_ERROR`，并把原始值放进 `context.raw` 以便定位。
 */
export function toAgentError(value: unknown, source?: string): AgentError {
  if (AgentError.is(value)) return value

  if (value instanceof Error) {
    return new AgentError(
      {
        code: ErrorCode.INTERNAL_ERROR,
        message: value.message,
        ...(source === undefined ? {} : { source }),
        context: { errorName: value.name },
      },
      { cause: value },
    )
  }

  return new AgentError({
    code: ErrorCode.INTERNAL_ERROR,
    message: '未知的抛出值',
    ...(source === undefined ? {} : { source }),
    context: { raw: safeInspect(value) },
  })
}

/**
 * 把任意值转换成适合放进日志的短字符串。
 *
 * 只接受原始类型，避免把对象结构（可能含凭据）序列化进错误上下文。
 */
function safeInspect(value: unknown): string {
  if (value === null) return 'null'

  switch (typeof value) {
    case 'string':
      return value
    case 'number':
    case 'boolean':
      // 显式转换而非 String(value)：后者对 object 会走默认字符串化，
      // 可能把内容泄漏进日志。这里的分支已排除 object。
      return `${value}`
    case 'bigint':
      return `${value}n`
    case 'undefined':
      return 'undefined'
    case 'symbol':
      return value.toString()
    case 'function':
      return '[function]'
    default:
      // object / function：只返回类型，绝不序列化内容（可能含凭据）。
      return '[object]'
  }
}
