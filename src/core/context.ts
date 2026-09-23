/**
 * 上下文信封与工作记忆。
 *
 * ## 为什么需要结构化信封
 *
 * `parts/09` §4 的要求是：**模型请求必须使用结构化 `ContextEnvelope`，
 * 不能通过扫描 system message 重建状态**。
 *
 * 这条约束是对旧实现一个具体缺陷的修正。旧实现把压缩摘要、skill 指导等
 * 状态**编码进 system 消息**，组装请求时再反向扫描所有 `role==="system"`
 * 的消息把内容捞出来。这条链路上有三个问题：
 *
 * 1. **丢数据**：preflight 压缩会重建 `api_messages`，重建后 system prompt
 *    不在新列表里，那一轮请求就**完全没有** system prompt——没有模式约束、
 *    没有安全策略、没有 skill 指导（REWRITE_SPEC §7.1 缺陷 A）。
 * 2. **重复注入**：多次压缩后 system 消息累积，扫描会把**所有**历史摘要
 *    拼接进同一次请求（§4.5.1 记录的待验证行为）。
 * 3. **无法审计**：想知道"这次请求带没带 skill 指导"只能去模拟一遍扫描逻辑。
 *
 * 结构化后这些问题从根上消失：`ContextEnvelope` 是显式构造的，
 * 每个字段要么有值要么明确为空。压缩后重建整个信封，不拼接、不扫描。
 */

import { type AgentBudget, type BudgetConsumption } from './budget.js'
import { type Message, type MessageSubtype } from './models.js'
import { type ApiMessage } from './provider.js'
import { type PermissionMode, type ToolDescriptor } from './tool.js'
import { type TurnPhase } from './turn.js'

// ── 系统提示 ──────────────────────────────────────────────────────

/**
 * 系统提示的**分层结构**。
 *
 * 保留分层而不是拼成一个字符串，是为了让压缩后能重新组装、让审计能回答
 * "这次请求带了哪几层"。最终发给 provider 时仍会拼成单个字符串，
 * 但拼接是最后一步，不是唯一表示。
 */
export interface SystemPrompt {
  /**
   * 身份与行为准则层。
   *
   * ⚠️ 这一层与下面的模式层**必须逐字与旧实现一致**——它们直接决定模型行为，
   * 改写即导致行为不等价。文本内容由 prompt 组装模块提供，此处只声明结构。
   */
  readonly base: string
  /** 当前模式对应的约束描述。**必须与执行层的权限表同步**。 */
  readonly mode: string
  /** 工具使用与安全策略。 */
  readonly safety: string
  /** 子代理委派指导。 */
  readonly subagent: string
  /** skill 规划指导。无命中时省略。 */
  readonly skillGuidance?: string
  /** 历史压缩摘要。有压缩历史时省略则为无。 */
  readonly compactSummary?: string
}

/** 系统提示各层的固定标题。用于最终拼接与审计对照。 */
export const SYSTEM_PROMPT_HEADINGS = {
  skillGuidance: 'Skill planning guidance:',
  compactSummary: 'Historical summary (compacted conversation):',
} as const

/**
 * 把分层系统提示拼接为最终文本。
 *
 * 规则：各层先 `trim()`，用空行（`\n\n`）连接，**空层整体省略**。
 * 这一步是纯函数，便于在测试中逐字比对最终文本。
 */
export function renderSystemPrompt(prompt: SystemPrompt): string {
  const parts: string[] = [prompt.base, prompt.mode, prompt.safety, prompt.subagent]

  if (prompt.skillGuidance !== undefined && prompt.skillGuidance.trim() !== '') {
    parts.push(`${SYSTEM_PROMPT_HEADINGS.skillGuidance}\n${prompt.skillGuidance.trim()}`)
  }

  if (prompt.compactSummary !== undefined && prompt.compactSummary.trim() !== '') {
    parts.push(`${SYSTEM_PROMPT_HEADINGS.compactSummary}\n${prompt.compactSummary.trim()}`)
  }

  return parts
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .join('\n\n')
}

// ── 压缩 ──────────────────────────────────────────────────────────

/**
 * 一次压缩的摘要信息。
 *
 * 与磁盘上的 `CompactBoundaryContent` 对应，但这是**运行期**形态：
 * 它让组装请求的代码无需回查数据库就知道当前是否处于压缩后的状态。
 */
export interface CompactSummary {
  readonly boundaryId: string
  readonly strategy: string
  /** LLM 生成的摘要正文。 */
  readonly summary: string
  /** 压缩前的 token 估算值。 */
  readonly tokensBefore: number
  readonly tokensAfter: number
}

// ── 运行时状态 ────────────────────────────────────────────────────

/**
 * 组装一次请求所需的全部运行时状态。
 *
 * 这是**显式快照**：给定同一个 `ContextEnvelope`，请求的构造过程是确定的，
 * 不依赖任何隐含的全局状态。
 */
export interface RuntimeState {
  readonly phase: TurnPhase
  readonly mode: PermissionMode
  readonly turnNumber: number
  /** 已应用的 skill 引用，格式 `name@version`。 */
  readonly appliedSkills: readonly string[]
  /** skill 当前阶段。 */
  readonly activePhase: string
  /** 本 turn 固定的 skill planning injection。 */
  readonly skillGuidance?: string
  readonly budget: AgentBudget
  /** 到目前为止的预算消耗，用于 UI 呈现与临近告警。 */
  readonly budgetConsumption: BudgetConsumption
  /** Explicit protected working memory snapshot carried with each request. */
  readonly workingMemory?: WorkingMemory
}

// ── 信封 ──────────────────────────────────────────────────────────

/**
 * 一次模型请求的完整上下文。
 *
 * 组装流程（每一步都是显式赋值，不存在反向扫描）：
 *
 * ```
 * 1. 从存储读取活跃消息（压缩边界之后的部分）
 * 2. 转换为 ApiMessage，丢弃纯 UI 记录（permission_event / skill_event / compact_boundary）
 * 3. 收敛为合法序列（修复孤立的 user 消息）
 * 4. 组装 SystemPrompt（压缩摘要来自 CompactSummary，不来自消息扫描）
 * 5. 收集工具描述
 * 6. 快照运行时状态
 * ```
 *
 * ⚠️ `conversation` **不含** system 消息。系统提示只存在于 `system` 字段——
 * 这样就不可能出现"抽干 system 再放回第 0 条"这类易错操作。
 */
export interface ContextEnvelope {
  readonly system: SystemPrompt
  readonly conversation: readonly ApiMessage[]
  /** 当前压缩状态。未压缩时省略。 */
  readonly compact?: CompactSummary
  readonly tools: readonly ToolDescriptor[]
  readonly runtime: RuntimeState
}

// ── 工作记忆 ──────────────────────────────────────────────────────

/**
 * 工作记忆：**压缩时不得丢弃**的信息。
 *
 * `parts/09` §4 明确列举必须进入工作记忆的内容：用户约束、未完成任务、
 * 待执行工具、权限决定、文件变更、已应用 skill。
 *
 * 单独建模的理由：压缩的本质是"有损摘要"，而上面这些信息一旦丢失，
 * 恢复后的行为就会与压缩前不一致——例如用户说过"不要改配置文件"，
 * 摘要掉这句话之后模型可能就改了。
 */
export interface WorkingMemory {
  /**
   * 用户明确提出的约束。
   *
   * 例如"不要动 package.json"、"只用标准库"。这些必须原样保留进摘要。
   */
  readonly userConstraints: readonly string[]
  /** 目标尚未达成的事项。 */
  readonly openTasks: readonly string[]
  /** 模型已请求但尚未执行的工具调用。 */
  readonly pendingToolCalls: readonly PendingToolCall[]
  /** 已做出的权限决定（按工具调用 ID）。 */
  readonly permissionDecisions: readonly PermissionDecisionRecord[]
  /** 已发生的文件变更。用于外部修改检测与回滚。 */
  readonly fileChanges: readonly FileChangeRecord[]
  /** 已应用的 skill 及其版本。 */
  readonly appliedSkills: readonly string[]
}

/** 待执行的工具调用。 */
export interface PendingToolCall {
  readonly toolCallId: string
  readonly toolName: string
  readonly input: Readonly<Record<string, unknown>>
}

/** 一条权限决定记录。 */
export interface PermissionDecisionRecord {
  readonly requestId: string
  readonly toolCallId: string
  readonly toolName: string
  /** `allow` / `ask` / `deny`。 */
  readonly action: string
  readonly resolution: string
  readonly reason: string
}

/** 一条文件变更记录。 */
export interface FileChangeRecord {
  readonly path: string
  readonly kind: 'created' | 'modified' | 'deleted'
  /** 变更前内容的哈希，用于检测外部修改。 */
  readonly beforeHash: string | null
  readonly afterHash: string | null
}

/** 空的工作记忆。新建 turn 时的起点。 */
export const EMPTY_WORKING_MEMORY: WorkingMemory = {
  userConstraints: [],
  openTasks: [],
  pendingToolCalls: [],
  permissionDecisions: [],
  fileChanges: [],
  appliedSkills: [],
}

/**
 * 判断某条消息是否应当进入模型请求。
 *
 * ⚠️ 这不是"序列化"判定，而是"是否值得转换"的预筛。真正的转换规则
 * （丢弃、改写角色、提取摘要）由消息转换模块负责——**两处判定必须一致**。
 *
 * 这里只排除**确定不会进入请求**的三类：
 * - `permission_event` / `skill_event`：纯 UI 审计记录
 * - `compact_boundary`：元数据，不是模型输入
 *
 * ⚠️ `compact_summary` **不在**排除之列——摘要必须进入请求，否则模型
 * 会彻底丢失被压缩的历史。
 */
export function isModelVisible(subtype: MessageSubtype): boolean {
  return (
    subtype !== 'permission_event' && subtype !== 'skill_event' && subtype !== 'compact_boundary'
  )
}

/**
 * 从消息列表中筛出可进入模型请求的部分。
 *
 * 纯函数，保留输入顺序。
 */
export function filterModelVisible(messages: readonly Message[]): readonly Message[] {
  return messages.filter((message) => isModelVisible(message.subtype))
}
