/**
 * 对外序列化层：**Web 响应里出现的每一个字节都从这里出去**。
 *
 * ## 为什么必须收口到一处
 *
 * `parts/09` §1.1：「Web UI 不得接收完整 API key、MCP 环境变量、绝对路径 secrets
 * 或未经脱敏的工具参数」。散在各路由里做脱敏必然会漏——漏掉的那一条不会报错，
 * 只会安静地把密钥写进浏览器。
 *
 * 因此本模块遵守两条互补的规则：
 *
 * 1. **白名单优先**。`toConfigDto` 之类的转换只挑出**明确要暴露**的字段，
 *    而不是"先整个发出去再删掉几个"。`ConfigDocument` 里 `llm_channels` /
 *    `llm_models` 是从旧项目继承的 `Record<string, unknown>`，里面是什么完全
 *    不可知——只有白名单能保证它们不出去。
 * 2. **黑名单兜底**。`redactKeys` / `redactSecrets` 处理不能白名单化的部分
 *    （工具参数、事件载荷）。白名单管"我知道有什么"，黑名单管"我不知道有什么"。
 *
 * ## 为什么有两档脱敏
 *
 * - `redactKeys`：只按**键名**脱敏。用于助手文本、工具输出——那些是给人看的
 *   内容，按值猜"这看起来像密钥"会把正常讨论（"'token' 这个词"）也涂掉。
 * - `redactSecrets`：键名 + **值形态**都脱敏。用于结构化参数（工具入参、
 *   配置片段）——那里出现 `sk-ant-…` 形状的字符串没有任何正当理由。
 */

import { createHash } from 'node:crypto'

import type { RuntimeEventEnvelope } from '../../core/events.js'
import type { Conversation, Message } from '../../core/models.js'
import type { TurnResult } from '../../core/turn.js'
import type { ConfigDocument } from '../../storage/types.js'
import { ModelTier } from '../../core/provider.js'
import { POLICY_SETTING_KEYS } from '../../app/policy.js'
import { messageToDisplay } from '../tui/format.js'
import type { PendingApprovalView } from '../../app/approval-broker.js'
import type { PendingUserInputView } from '../../app/user-input-broker.js'

/** 脱敏后的占位符。固定字符串，便于前端识别并渲染成"已隐藏"。 */
export const REDACTED = '[redacted]'

/**
 * 敏感键名。
 *
 * 用**子串**匹配而不是精确匹配：`anthropicApiKey`、`ANTHROPIC_API_KEY`、
 * `api-key`、`apiKeyRef` 都要命中，而穷举这些拼写是不可靠的。
 * 词表刻意保持保守——多涂会把正常内容涂坏，涂坏的内容比多一个 `[redacted]` 更难排查。
 */
const SENSITIVE_KEY_PARTS: readonly string[] = [
  'apikey',
  'api_key',
  'api-key',
  'secret',
  'password',
  'passwd',
  'credential',
  'authorization',
  'privatekey',
  'private_key',
  'accesskey',
  'access_key',
  'token',
  'cookie',
]

/** 这些是 UI 所需的 token 计量字段，不是凭据。 */
const SAFE_TOKEN_KEYS: ReadonlySet<string> = new Set([
  'input_tokens',
  'output_tokens',
  'total_tokens',
  'max_tokens',
  'context_tokens_before',
  'context_tokens_after',
])

/**
 * 值形态的密钥模式。
 *
 * 只收各家的**前缀式**密钥与 JWT——它们的形状足够独特，几乎不会误伤正常文本。
 * 刻意**不**收"长 base64 / 长 hex"：那会把 session id、内容哈希、base64 图片
 * 一起涂掉，而它们在 UI 上是有用的。
 */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}/g, // Anthropic / OpenAI 风格
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, // GitHub
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, // JWT
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
]

/** 键名是否敏感。 */
export function isSensitiveKey(key: string): boolean {
  const lowered = key.toLowerCase()
  if (SAFE_TOKEN_KEYS.has(lowered)) return false
  return SENSITIVE_KEY_PARTS.some((part) => lowered.includes(part))
}

/** 按键名递归脱敏。数组保持数组，对象保持对象，**不改动非敏感值**。 */
export function redactKeys(value: unknown, depth = 0): unknown {
  if (depth > 12) return value // 深到这种程度的数据结构本身就不该出现在响应里
  if (Array.isArray(value)) return value.map((item) => redactKeys(item, depth + 1))
  if (value === null || typeof value !== 'object') return value

  const record = value as Record<string, unknown>
  const inlineSecret = record['source'] === 'value' && typeof record['key'] === 'string'
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(record)) {
    out[key] =
      isSensitiveKey(key) || (inlineSecret && key === 'key')
        ? REDACTED
        : redactKeys(item, depth + 1)
  }
  return out
}

/** 把字符串里形如密钥的片段替换掉。 */
export function redactValueShapes(text: string): string {
  let out = text
  for (const pattern of SECRET_VALUE_PATTERNS) out = out.replace(pattern, REDACTED)
  return out
}

/** 键名 + 值形态双重脱敏。结构化参数用这个。 */
export function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > 12) return REDACTED
  if (typeof value === 'string') return redactValueShapes(value)
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, depth + 1))
  if (value === null || typeof value !== 'object') return value

  const record = value as Record<string, unknown>
  const inlineSecret = record['source'] === 'value' && typeof record['key'] === 'string'
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(record)) {
    out[key] =
      isSensitiveKey(key) || (inlineSecret && key === 'key')
        ? REDACTED
        : redactSecrets(item, depth + 1)
  }
  return out
}

/** 序列化为 JSON 文本。测试断言"响应里不含密钥"时用它。 */
export function renderJson(value: unknown): string {
  return JSON.stringify(value) ?? ''
}

/** 内容摘要：用于日志与审计，不用于响应体。 */
export function contentDigest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)
}

// ── 健康检查 ──────────────────────────────────────────────────────

export interface HealthDto {
  readonly ok: boolean
  readonly version: string
  readonly uptimeMs: number
}

/**
 * 健康检查响应。
 *
 * **只有三个字段**。规格明列"不泄露配置、密钥或文件路径"——所以不返回
 * 工作区路径、provider 列表、模型名或 policy 值。运维需要的活性信息就这三项。
 */
export function toHealthDto(input: {
  readonly version: string
  readonly uptimeMs: number
}): HealthDto {
  return { ok: true, version: input.version, uptimeMs: Math.max(0, Math.round(input.uptimeMs)) }
}

// ── 会话 / 消息 ───────────────────────────────────────────────────

export interface SessionDto {
  readonly id: string
  readonly title: string
  readonly status: string
  readonly currentTurn: number
  readonly agentType: string
  readonly isSubAgent: boolean
  readonly totalOutputTokens: number
  readonly lastInputTokens: number
}

export function toSessionDto(conversation: Conversation): SessionDto {
  return {
    id: conversation.id,
    title: conversation.title,
    status: conversation.status,
    currentTurn: conversation.current_turn,
    agentType: conversation.agent_type,
    isSubAgent: conversation.parent_conversation_id !== '',
    totalOutputTokens: conversation.total_output_tokens,
    lastInputTokens: conversation.last_input_tokens,
  }
}

export interface MessageDto {
  readonly id: string
  readonly role: string
  readonly subtype: string
  readonly content: string
  /** 将持久化 content block 还原为供 Web 呈现的 Markdown。 */
  readonly displayMarkdown: string
  readonly createdAt: string
  readonly turnId: string | null
  readonly toolCallId: string | null
  readonly agentType: string
  /**
   * `meta` 是 JSON 字符串。这里**解析后按键名脱敏**再发出。
   *
   * 不直接透传原文：`meta` 由多个子系统写入（工具、权限往返、压缩边界），
   * 内容不可穷举；解析失败时退化为 `null` 而不是把原文发出去——
   * 发不出去的 JSON 说明写入侧有问题，不该由浏览器承担。
   */
  readonly meta: unknown
}

export function toMessageDto(message: Message): MessageDto {
  let meta: unknown = null
  if (message.meta !== '' && message.meta !== '{}') {
    try {
      meta = redactKeys(JSON.parse(message.meta))
    } catch {
      meta = null
    }
  }
  return {
    id: message.id,
    role: message.role,
    subtype: message.subtype,
    content: message.content,
    displayMarkdown: messageToDisplay(message),
    createdAt: message.created_at,
    turnId: message.turn_id === '' ? null : message.turn_id,
    toolCallId: message.tool_call_id,
    agentType: message.agent_type,
    meta,
  }
}

// ── turn 结果 ─────────────────────────────────────────────────────

export interface TurnResultDto {
  readonly turnId: string
  readonly status: string
  readonly finalText: string
  readonly toolRounds: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly numTurns: number
  readonly maxTurns: number
  readonly terminalReason: string | null
  readonly lastToolError: string | null
  readonly error: string | null
  readonly cancelled: boolean
}

/**
 * turn 结果的对外形态。
 *
 * `finalText` 原样发出（它是用户要看的产出，按值涂会毁掉正文）；
 * 其余字段都是枚举值或计数，没有可泄露的内容。
 */
export function toTurnResultDto(result: TurnResult): TurnResultDto {
  return {
    turnId: result.turn_id,
    status: result.status,
    finalText: result.final_text,
    toolRounds: result.tool_rounds,
    inputTokens: result.input_tokens,
    outputTokens: result.output_tokens,
    numTurns: result.num_turns,
    maxTurns: result.max_turns,
    terminalReason: result.terminal_reason,
    lastToolError: result.last_tool_error,
    error: result.error,
    cancelled: result.status === 'cancelled',
  }
}

// ── 待处理项 ──────────────────────────────────────────────────────

export interface PendingApprovalDto {
  readonly requestId: string
  readonly sessionId: string
  readonly turnId: string
  readonly toolName: string
  readonly toolCallId: string
  /** 已由 `ToolExecutor` 脱敏并截断的参数摘要。 */
  readonly argsPreview: string
  readonly riskLevel: string
  readonly reason: string
  readonly createdAt: string
  readonly expiresAt: number
  readonly secondConfirmation: boolean
}

export function toPendingApprovalDto(view: PendingApprovalView): PendingApprovalDto {
  return {
    requestId: view.requestId,
    sessionId: view.sessionId,
    turnId: view.turnId,
    toolName: view.toolName,
    toolCallId: view.toolCallId,
    // 再涂一遍是**有意的冗余**：`args_preview` 的脱敏属于 executor，
    // 而这里是最后一道出口。两张网比一张网可靠，代价只是一次字符串扫描。
    argsPreview: redactValueShapes(view.argsPreview),
    riskLevel: view.riskLevel,
    reason: view.reason,
    createdAt: view.createdAt,
    expiresAt: view.expiresAt,
    secondConfirmation: view.secondConfirmation,
  }
}

export interface PendingUserInputDto {
  readonly requestId: string
  readonly sessionId: string
  readonly turnId: string
  readonly toolName: string
  readonly questions: unknown
  readonly createdAt: string
  readonly expiresAt: number
}

export function toPendingUserInputDto(view: PendingUserInputView): PendingUserInputDto {
  return {
    requestId: view.requestId,
    sessionId: view.sessionId,
    turnId: view.turnId,
    toolName: view.toolName,
    questions: redactKeys(view.questions),
    createdAt: view.createdAt,
    expiresAt: view.expiresAt,
  }
}

// ── 配置 ──────────────────────────────────────────────────────────

export interface ConfigDto {
  readonly schemaVersion: number
  readonly language: string
  readonly availableTiers: readonly string[]
  readonly policySettingKeys: readonly string[]
  readonly providers: readonly {
    readonly id: string
    readonly name: string
    readonly baseUrl: string
    readonly enabled: boolean
    /** 只说明"引用了一个凭据来源"，**不说明来源是什么**。 */
    readonly hasSecretRef: boolean
  }[]
  readonly models: readonly {
    readonly id: string
    readonly providerId: string
    readonly displayName: string
    readonly enabled: boolean
    readonly contextWindow: number
    readonly maxOutputTokens: number
    readonly supportsTools: boolean
    readonly supportsThinking: boolean
    readonly supports1MContext: boolean
  }[]
  readonly tiers: readonly {
    readonly tier: string
    readonly providerId: string
    readonly modelId: string
    readonly enabled: boolean
    readonly fallbackCount: number
  }[]
  /** 只暴露 `policy.*` 项：它们是可调阈值，其余 `app_settings` 内容不外泄。 */
  readonly policySettings: Readonly<Record<string, string>>
  readonly mcpServerCount: number
  readonly mcpServers: readonly { name: string; transport: string; enabled: boolean }[]
  readonly tierCount: number
}

/**
 * 配置的对外视图。
 *
 * ⚠️ **白名单构造**，不是"取全量再删字段"。
 * `llm_channels` / `llm_models` 是旧项目继承来的自由结构（`Record<string, unknown>`），
 * 里面完全可能存着明文 api key；它们**根本不参与**这里的构造，因此不可能漏出去。
 * `apiKeyRef` 也整体不发——只发一个布尔值说明"有引用"。
 */
export function toConfigDto(config: ConfigDocument): ConfigDto {
  const settings = config.app_settings
  const policySettings: Record<string, string> = {}
  for (const [key, value] of Object.entries(settings)) {
    if (key.startsWith('policy.')) policySettings[key] = value
  }

  return {
    schemaVersion: config.schema_version,
    language: settings['language'] === 'en' ? 'en' : 'zh',
    availableTiers: Object.values(ModelTier),
    policySettingKeys: POLICY_SETTING_KEYS,
    providers: config.providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      enabled: provider.enabled,
      hasSecretRef: provider.apiKeyRef !== undefined && provider.apiKeyRef !== null,
    })),
    models: config.model_profiles.map((model) => ({
      id: model.id,
      providerId: model.providerId,
      displayName: model.displayName ?? model.id,
      enabled: model.enabled,
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxOutputTokens,
      supportsTools: model.supportsTools,
      supportsThinking: model.supportsThinking,
      supports1MContext: model.supports1MContext,
    })),
    tiers: config.tier_assignments.map((assignment) => ({
      tier: assignment.tier,
      providerId: assignment.modelRef.providerId,
      modelId: assignment.modelRef.modelId,
      enabled: assignment.enabled,
      fallbackCount: assignment.fallbackModelRefs.length,
    })),
    policySettings,
    mcpServerCount: config.mcp_servers?.length ?? 0,
    mcpServers: (config.mcp_servers ?? []).flatMap((item) => {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) return []
      const record = item as Readonly<Record<string, unknown>>
      if (typeof record['name'] !== 'string') return []
      return [
        {
          name: record['name'],
          transport: typeof record['transport'] === 'string' ? record['transport'] : 'stdio',
          enabled: record['enabled'] !== false,
        },
      ]
    }),
    tierCount: config.tier_assignments.length,
  }
}

// ── 事件 ──────────────────────────────────────────────────────────

export interface EventDto {
  readonly eventId: string
  readonly sequence: number
  readonly type: string
  readonly timestamp: string
  readonly sessionId: string
  readonly turnId: string | null
  readonly data: unknown
}

/**
 * 载荷里可能带**未脱敏工具参数**的事件类型。
 *
 * 只有这两类事件的 `data` 里嵌着模型的原始工具入参（`input` / `tool_input`），
 * 而工具入参恰好是密钥最容易出现的地方（写文件、跑命令、发请求）。其余事件
 * 的载荷是文本增量、计数、枚举——按值涂会毁掉正文。
 */
const RAW_TOOL_INPUT_EVENTS: ReadonlySet<string> = new Set([
  'tool_use',
  'permission_required',
  'user_input_required',
])

/** 事件的对外形态。 */
export function toEventDto(event: RuntimeEventEnvelope): EventDto {
  const data = RAW_TOOL_INPUT_EVENTS.has(event.type)
    ? redactSecrets(event.data)
    : redactKeys(event.data)

  return {
    eventId: event.eventId,
    sequence: event.sequence,
    type: event.type,
    timestamp: event.timestamp,
    sessionId: event.sessionId,
    turnId: event.turnId ?? null,
    data,
  }
}
