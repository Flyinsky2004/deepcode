/**
 * 领域模型。
 *
 * ## 命名约定（刻意的选择）
 *
 * 字段名一律使用 **snake_case**，与持久化 JSON 逐字一致，而不是 TypeScript
 * 惯用的 camelCase。理由：
 *
 * 1. **消除映射层**。持久化就是 `JSON.stringify(record)`，读取就是校验后直接用，
 *    中间不存在"把 `tool_call_id` 翻译成 `toolCallId`"的代码。每一层映射
 *    都是一类 bug（漏字段、默认值不一致、双向不对称）。
 * 2. **与规格可对照**。`docs/rewrite-spec/parts/01-data-layer.md` 用 snake_case
 *    逐字段描述这些结构，字段名一致意味着代码评审时可以逐行对照规格。
 *
 * 代价是不符合 TS 惯例。这个取舍是有意的——本项目的核心风险是**恢复语义出错**
 * （progess.md 设计约束 4），而不是代码风格。
 *
 * ## 不可变性
 *
 * 全部实体都是 `readonly` 字段。状态更新一律构造新对象，绝不原地修改
 * （REWRITE_SPEC §6 不变量 1）。这一条在旧项目里是全局编码约束，不是偶然。
 */

import { type MessageId, type SessionId, type TurnId } from './ids.js'
import { type IsoTimestamp } from './time.js'

// ── 消息 ──────────────────────────────────────────────────────────

/**
 * 消息角色。
 *
 * `"system"` 是**磁盘级**角色，用于承载压缩摘要、权限审计与 skill 审计记录。
 * 它不直接进入模型请求——`message_to_api_format` 会按 `subtype` 与 `content.type`
 * 决定丢弃、改写为 system 段落，或原样送出。
 */
export const MessageRole = {
  SYSTEM: 'system',
  USER: 'user',
  ASSISTANT: 'assistant',
  TOOL: 'tool',
} as const

/** 消息角色类型。 */
export type MessageRole = (typeof MessageRole)[keyof typeof MessageRole]

/** 全部合法角色集合，用于边界校验。 */
export const MESSAGE_ROLES: ReadonlySet<string> = new Set(Object.values(MessageRole))

/**
 * 消息子类型。
 *
 * 区分"这条消息在协议里是什么"，而不只是"谁说的"——`role` 相同但 `subtype`
 * 不同的消息，序列化行为完全不同。
 *
 * ⚠️ 其中 `COMPACT_SUMMARY` 与 `COMPACT_BOUNDARY` 是**建模值**：旧实现写入时
 * 漏传 `subtype`，导致这两类在磁盘上实际落成 `"normal"`，检测完全依赖
 * `content` 里的 `type` 字段。本实现**写入正确的 subtype**，同时读取侧
 * 两套判定都认——这样新数据自描述，旧数据仍能识别。
 */
export const MessageSubtype = {
  /** 普通消息：用户输入、助手纯文本回复。 */
  NORMAL: 'normal',
  /** 助手消息，`content` 是含 `tool_use` 块的 JSON 数组。 */
  TOOL_CALL: 'tool_call',
  /** 工具结果，`content` 是 `{"tool_use_id", "content"}`。 */
  TOOL_RESULT: 'tool_result',
  /** 取消时写入的占位助手消息，`content` 为 `"[Interrupted]"`。 */
  INTERRUPTED: 'interrupted',
  /** skill 命中审计记录，**不送模型**。 */
  SKILL_EVENT: 'skill_event',
  /** 权限往返审计记录，**不送模型**。 */
  PERMISSION_EVENT: 'permission_event',
  /** 压缩摘要正文，作为 system 段落送模型。 */
  COMPACT_SUMMARY: 'compact_summary',
  /** 压缩边界元数据，**不送模型**。 */
  COMPACT_BOUNDARY: 'compact_boundary',
  /**
   * slash command 的执行结果（Phase 6），**不送模型**。
   *
   * 与 `SKILL_EVENT` / `PERMISSION_EVENT` 同类：是给人看的审计记录，
   * `messageToApiFormat` 对它返回 `null`。
   *
   * ⚠️ 命令结果有**两条**呈现通道：落进 transcript 的这条消息，以及
   * 事件流里的审计事件。**消息是历史的真相源**，事件通过 `messageId`
   * 指向它；客户端按 id 去重，否则同一条结果会被画两次。
   */
  COMMAND_EVENT: 'command_event',
} as const

/** 消息子类型。 */
export type MessageSubtype = (typeof MessageSubtype)[keyof typeof MessageSubtype]

/**
 * 由本实现主动写入的 subtype 集合。
 *
 * 与"读取时接受的集合"（全部 8 个）区分开：校验读取可容忍的比写入的更多，
 * 因为手工编辑或跨版本的数据可能出现任意组合。
 */
export const WRITABLE_MESSAGE_SUBTYPES: ReadonlySet<string> = new Set<MessageSubtype>([
  MessageSubtype.NORMAL,
  MessageSubtype.TOOL_CALL,
  MessageSubtype.TOOL_RESULT,
  MessageSubtype.INTERRUPTED,
  MessageSubtype.SKILL_EVENT,
  MessageSubtype.PERMISSION_EVENT,
  MessageSubtype.COMPACT_SUMMARY,
  MessageSubtype.COMPACT_BOUNDARY,
  MessageSubtype.COMMAND_EVENT,
])

/**
 * 一条消息。
 *
 * `content` 是**多态的字符串**——这是本项目最容易被误用的字段。它可能是：
 * - 纯文本（用户输入、简单助手回复）
 * - JSON 字符串形式的 content block 数组（助手消息，含 thinking / text / tool_use）
 * - JSON 字符串形式的对象（工具结果、压缩摘要、压缩边界、审计记录）
 *
 * ⚠️ **永远不要把 `content` 改成对象**。它的"字符串承载 JSON"双重编码是刻意设计：
 * 保持定长字符串便于排序与比较，也让无法解析的历史内容仍能原样保留并展示。
 * 判别依据是 `subtype`，兜底再解析 `content` 里的 `type` 字段。
 *
 * `meta` 同理——**必须是字符串**。若写入对象，读取时的 `String(对象)` 会产出
 * 单引号的类 Python repr，`JSON.parse` 再也读不回来，静默损坏数据。
 */
export interface Message {
  readonly id: MessageId
  readonly conversation_id: SessionId
  readonly role: MessageRole
  /** 多态字符串。详见接口文档。 */
  readonly content: string
  /** ISO 8601 UTC，固定 3 位毫秒。**这是排序键**。 */
  readonly created_at: IsoTimestamp
  /** 所属 turn。空串是合法值（未归属任何 turn 的消息）。 */
  readonly turn_id: TurnId | ''
  readonly subtype: MessageSubtype
  /** 工具调用 ID。与 `tool_use_id` 配对。**只有工具类消息非空**。 */
  readonly tool_call_id: string | null
  /** JSON 字符串形式的附加元数据。默认 `"{}"`。 */
  readonly meta: string
  /** 产出该消息的子代理角色名。主代理为空串。 */
  readonly agent_type: string
}

// ── 会话 ──────────────────────────────────────────────────────────

/**
 * 一个会话（对话线程）。
 *
 * 子代理会话与主会话**同构**——子代理会话就是这个结构的一个实例，
 * 靠 `parent_conversation_id` 非空标识。不需要单独的集合或类型。
 */
export interface Conversation {
  readonly id: SessionId
  /** 会话标题。非空。 */
  readonly title: string
  /** 本会话累计输出 token。 */
  readonly total_output_tokens: number
  /** **最近一次**请求的输入 token，不是累计值。 */
  readonly last_input_tokens: number
  /**
   * 已被压缩的消息数。
   *
   * ⚠️ **纯记账字段，不参与任何边界判定**。压缩边界由消息流里的
   * `compact_boundary` 标记决定（见 `MessageSubtype`）。
   * 误用它来裁剪历史会直接破坏可恢复性。
   */
  readonly compacted_message_count: number
  /** turn 自增计数。下一个 turn 的序号是它 +1。 */
  readonly current_turn: number
  readonly status: string
  /** 非空表示这是子代理的隔离会话，值为父会话 ID。 */
  readonly parent_conversation_id: SessionId | ''
  /** 子代理角色名。主会话为空串。 */
  readonly agent_type: string
  /**
   * 会话所有者。
   *
   * Web UI 下每个连接映射到一个独立 `principalId`（`parts/09` §1.1），
   * 会话、权限请求与事件都必须校验该 principal——**不能只凭 URL 里的
   * session id 访问**。
   *
   * **空串表示"归属本机 principal"**：旧数据没有这个字段（读取时容错为 `''`），
   * 由启动时的 `ensureLocalPrincipal()` 认领。这一点让旧 `chat.json`
   * 无需迁移即可被本机用户继续使用。
   */
  readonly principal_id: string
  readonly created_at: IsoTimestamp
  readonly updated_at: IsoTimestamp
}

/** 新建会话时使用的默认值。集中在此，避免构造点各写一份。 */
export const NEW_CONVERSATION_DEFAULTS = {
  total_output_tokens: 0,
  last_input_tokens: 0,
  compacted_message_count: 0,
  current_turn: 0,
  status: 'active',
  parent_conversation_id: '',
  agent_type: '',
  principal_id: '',
} as const satisfies Omit<Partial<Conversation>, 'id' | 'title' | 'created_at' | 'updated_at'>

// ── content block ─────────────────────────────────────────────────

/**
 * 助手消息里的一种 content block。
 *
 * 与 Anthropic Messages API 的 content block 形状一致——因为本实现只对接
 * 该协议，不需要在中间层做归一化，直接透传即可。
 */

/** 思考块。`signature` 是 Anthropic 要求回传的完整性签名。 */
export interface ThinkingBlock {
  readonly type: 'thinking'
  readonly thinking: string
  /**
   * 加密签名。
   *
   * ⚠️ 必须原样回传给 provider，不能丢弃或改写——缺失会导致请求被拒。
   * 无签名的 provider 写空串（而非省略该字段）。
   */
  readonly signature: string
}

/** 文本块。 */
export interface TextBlock {
  readonly type: 'text'
  readonly text: string
}

/** 工具调用块。 */
export interface ToolUseBlock {
  readonly type: 'tool_use'
  readonly id: string
  readonly name: string
  readonly input: Readonly<Record<string, unknown>>
}

/** 助手消息可包含的块。 */
export type AssistantContentBlock = ThinkingBlock | TextBlock | ToolUseBlock

/**
 * 判断值是否为助手 content block 数组。
 *
 * 用于从 `Message.content` 的字符串形态判定该走哪条解析路径。
 */
export function isAssistantBlockArray(value: unknown): value is readonly AssistantContentBlock[] {
  if (!Array.isArray(value)) return false
  return value.every((item) => {
    if (typeof item !== 'object' || item === null) return false
    const type = (item as { type?: unknown }).type
    return type === 'thinking' || type === 'text' || type === 'tool_use'
  })
}

// ── 工具结果 content ──────────────────────────────────────────────

/** 工具结果消息的 `content` 反序列化后的形态。 */
export interface ToolResultContent {
  readonly tool_use_id: string
  /** 面向模型的文本。**这是唯一进入模型上下文的内容**。 */
  readonly content: string
}

// ── 压缩 ──────────────────────────────────────────────────────────

/** 压缩摘要消息的 `content` 反序列化后的形态。 */
export interface CompactSummaryContent {
  readonly type: 'compact_summary'
  /** LLM 生成的摘要正文。 */
  readonly summary: string
  /** 被摘要的消息数。 */
  readonly summarized_count: number
}

/**
 * 压缩边界消息的 `content` 反序列化后的形态。
 *
 * 版本化 schema（parts/09 §4）。这是恢复语义的关键：边界之前的消息仍在磁盘上，
 * 但不再进入模型请求，靠这条标记划定。
 */
export interface CompactBoundaryContent {
  readonly type: 'compact_boundary'
  readonly boundary_id: string
  /** 压缩策略标识，例如 `"autocompact_v1"`。 */
  readonly strategy: string
  /** 被摘要区间的首条消息 ID。 */
  readonly source_range_from: string
  /** 被摘要区间的末条消息 ID。 */
  readonly source_range_to: string
  /** 压缩后仍保留在活跃区头部的消息 ID。 */
  readonly preserved_head_ids: readonly string[]
  /** 压缩后仍保留的尾部消息 ID。 */
  readonly preserved_tail_id: string
  /** 摘要消息本身的 ID，便于交叉引用。 */
  readonly summary_msg_id: string
  readonly tokens_before: number
  /**
   * 压缩后的 token 数。
   *
   * ⚠️ 旧实现落盘时**恒为 0**（真实值只存在于返回值里）。本实现写入真实值；
   * 读取侧必须容忍 0 并视其为"未知"。
   */
  readonly tokens_after: number
}

// ── 事件审计 content ──────────────────────────────────────────────

/** 权限往返审计记录的 `content`。**不送模型**。 */
export interface PermissionEventContent {
  /** 例如 `"permission_request_created"` / `"permission_request_resolved"`。 */
  readonly event: string
  readonly request_id: string
  readonly tool_name?: string
  readonly args_preview?: string
  readonly risk_level?: string
  readonly resolution?: string
  readonly outcome?: string
}

/** skill 命中审计记录的 `content`。**不送模型**。 */
export interface SkillEventContent {
  readonly event: string
  readonly applied_skills: readonly string[]
  readonly confidence?: number
  readonly active_phase?: string
  readonly guards_applied?: readonly Readonly<Record<string, unknown>>[]
}

// ── 路径 ──────────────────────────────────────────────────────────

/**
 * 应用路径集合。
 *
 * 全部为绝对路径字符串。解析时通过参数注入 `home` / `cwd`，不直接读取
 * 全局状态——这是可测试性的基础（REWRITE_SPEC §6 不变量 15）。
 */
export interface AppPaths {
  /** 全局配置目录，`~/.deepcode`。 */
  readonly global_dir: string
  /** 项目目录，`<cwd>/.deepcode`。 */
  readonly project_dir: string
  /** 全局配置文件，`<global_dir>/config.json`。 */
  readonly config_path: string
  /** 项目会话文件，`<project_dir>/chat.json`。 */
  readonly chat_path: string
}

// ── 常量 ──────────────────────────────────────────────────────────

/**
 * 磁盘 schema 版本。
 *
 * 本实现写入的值。读取时接受任意整数——旧值、更高值都不应导致读取失败，
 * 差异由调用方决定告警还是忽略。
 */
export const SCHEMA_VERSION = 1

/**
 * 模型默认上下文窗口。
 *
 * 与旧实现一致。这是**配置默认值**，不是能力声明——真实能力来自 provider 的
 * 模型配置（`ModelProfile.contextWindow`）。
 */
export const DEFAULT_CONTEXT_WINDOW = 125_000

/**
 * 模型默认最大输出 token。
 *
 * ⚠️ 旧实现在五处使用了两个不同的默认值（`384_000` 与 `128_000`），
 * 其中 `384_000` 分支因归一化总是先填 `128_000` 而**不可达**。
 * 本实现统一取 `128_000`——即旧实现实际落盘的那个值。
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 128_000

/** 默认推理强度档位。 */
export const DEFAULT_REASONING_EFFORT = 'high'

/**
 * 合法的推理强度取值。
 *
 * `xhigh` 是**修正**的结果，不是凭空加的档位：旧实现的 `/effort` 菜单
 * （`app.py:192-199` 的 `_get_effort_levels`）提供 low/medium/high/**xhigh** 四项，
 * 但落盘校验 `set_model_reasoning_effort`（`storage.py:295-298`）只接受前三项并抛
 * `ValueError`；`_set_effort`（`app.py:1981-2007`）没有 try/except，于是选 xhigh 会
 * 先写成功 `thinking_enabled=True`、再在校验上炸掉——**配置被半写**。
 *
 * 两个值域本来就不一致（`/reasoning` 只提供前三项），本实现的选择是：
 * 把 `xhigh` 提升为**合法可落盘**的值，让 `/effort` 的菜单项不再是死路；
 * `/reasoning` 仍然只提供 low/medium/high（对齐旧菜单）。详见 ADR 0004。
 */
export const REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const

/** 推理强度类型。 */
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]

/** 判断字符串是否为合法推理强度。 */
export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && (REASONING_EFFORTS as readonly string[]).includes(value)
}
