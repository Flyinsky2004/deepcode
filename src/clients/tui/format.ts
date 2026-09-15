/**
 * 消息与面板的文本渲染（`message_utils.py` + `app.py` 的格式化部分）。
 *
 * 这是"消息区真相源是存储"的落点：控制器从 `ChatStore.listMessages()` 读出
 * 原始 `Message`，这里把 `content` 里的 JSON 还原成人类可读文本。
 *
 * ## 没移植的部分（显式决定）
 *
 * `message_utils.py` 里有 5 个**按工具名分派**的漂亮打印器
 * （`_format_file_read_result` / `_format_web_fetch_result` / `_format_grep_result` /
 * `_format_glob_result` / `_format_file_edit_result`）。它们读的是
 * `message.meta["data"]` 里旧工具层写入的字段（`returned_lines`、`matches`、
 * `files`、`changes`…）。本项目的工具（Phase 4）**不写这些字段**，
 * 因此那 5 个分支永远拿不到数据，移植过来只会是一段永不生效的分支。
 * 工具结果统一走 `_format_result_content`（截断 + JSON 美化），
 * 与旧实现在"meta.data 缺失"时的行为完全一致。
 */

import type { Message } from '../../core/models.js'
import { TKey } from './i18n/keys.js'
import { translate } from './i18n/index.js'
import type { Language } from './i18n/keys.js'

import { TODO_FALLBACK_MARKER, TODO_MARKER_COLORS, TODO_MARKERS } from './theme.js'
import type { Panel, Selection, SelectionItem, TodoEntry } from './types.js'

/** 工具结果内容截断上限（`message_utils._MAX_RESULT_CHARS`）。 */
export const MAX_RESULT_CHARS = 8000

/** 工具结果显示行数上限（`message_utils._MAX_RESULT_LINES`）。 */
export const MAX_RESULT_LINES = 15

/** 思考内容预览长度（`_format_assistant_blocks`）。 */
export const THINKING_PREVIEW_CHARS = 200

/** 工具输入单行长度上限（`_format_tool_use_input`）。 */
export const TOOL_INPUT_INLINE_CHARS = 120

/** 工具输入多行预览上限。 */
export const TOOL_INPUT_PREVIEW_CHARS = 500

type Json = Record<string, unknown>

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

function asRecord(value: unknown): Json | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : undefined
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * `message_to_display`：把持久化消息还原成可读文本。
 *
 * 分派顺序与旧实现逐字一致——`event` 字段先于 `type`，
 * `skill.resolve.complete` 先于通用 `event`。
 */
export function messageToDisplay(message: Message): string {
  const parsed = parseJson(message.content)
  if (Array.isArray(parsed)) return formatAssistantBlocks(parsed)
  const record = asRecord(parsed)
  if (record) {
    if (record['event'] === 'skill.resolve.complete') return formatSkillEvent(record)
    if ('event' in record) return formatPermissionEvent(record)
    if (record['type'] === 'compact_boundary') return formatCompactBoundary(record)
    if (record['type'] === 'compact_summary') return formatCompactSummary(record)
    if ('tool_use_id' in record) return formatToolResult(message, record)
  }
  return message.content
}

/** assistant 的 content block 数组。 */
function formatAssistantBlocks(blocks: readonly unknown[]): string {
  const parts: string[] = []
  for (const raw of blocks) {
    const block = asRecord(raw)
    if (!block) continue
    if (block['type'] === 'thinking') {
      const thinking = asString(block['thinking'])
      const preview =
        thinking.length > THINKING_PREVIEW_CHARS
          ? `${thinking.slice(0, THINKING_PREVIEW_CHARS)}...`
          : thinking
      parts.push(`\n\n💭 **thinking**\n\`\`\`\n${preview}\n\`\`\`\n`)
    } else if (block['type'] === 'text') {
      parts.push(asString(block['text']))
    } else if (block['type'] === 'tool_use') {
      parts.push(formatToolUseBlock(block))
    }
  }
  return parts.join('')
}

function formatToolUseBlock(block: Json): string {
  const name = asString(block['name'], 'unknown')
  const input = asRecord(block['input']) ?? {}
  return `\n\n🔧 **${name}**\n${formatToolUseInput(input)}`
}

function formatToolUseInput(input: Json): string {
  const lines: string[] = []
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string') {
      if (value.length <= TOOL_INPUT_INLINE_CHARS && !value.includes('\n')) {
        lines.push(`- **${key}**: \`${value}\``)
      } else {
        const preview =
          value.length > TOOL_INPUT_PREVIEW_CHARS
            ? `${value.slice(0, TOOL_INPUT_PREVIEW_CHARS)}...`
            : value
        lines.push(`- **${key}**:\n\`\`\`\n${preview}\n\`\`\``)
      }
    } else if (typeof value === 'boolean') {
      lines.push(`- **${key}**: \`${value ? 'true' : 'false'}\``)
    } else if (typeof value === 'number') {
      lines.push(`- **${key}**: \`${value}\``)
    } else if (value === null || value === undefined) {
      lines.push(`- **${key}**: \`null\``)
    } else {
      lines.push(`- **${key}**: \`${JSON.stringify(value)}\``)
    }
  }
  return lines.join('\n')
}

function formatCompactBoundary(parsed: Json): string {
  const beforeK = Math.floor(asNumber(parsed['tokens_before']) / 1000)
  const afterK = Math.floor(asNumber(parsed['tokens_after']) / 1000)
  const strategy = asString(parsed['strategy'])
  return `\n\n---\n\n📦 **Conversation Compacted** (${strategy})\n${beforeK}K → ${afterK}K tokens\n`
}

function formatCompactSummary(parsed: Json): string {
  return `\n\n📋 **Summary of earlier conversation:**\n\n${asString(parsed['summary'])}\n`
}

function formatSkillEvent(parsed: Json): string {
  const applied = parsed['applied_skills']
  if (!Array.isArray(applied) || applied.length === 0) return ''
  const confidence = parsed['confidence'] ?? 0
  const phase = asString(parsed['active_phase'])
  const guards = parsed['guards_applied']
  const guardCount = Array.isArray(guards) ? guards.length : 0
  const refs = applied.map((skill) => `\`${String(skill)}\``).join(', ')
  const details = [
    `confidence: \`${typeof confidence === 'string' || typeof confidence === 'number' ? confidence : '0'}\``,
  ]
  if (phase) details.push(`phase: \`${phase}\``)
  details.push(`guards: \`${guardCount}\``)
  return `\n\n🧩 **Loaded Skill** ${refs}\n${details.join(' · ')}`
}

function formatPermissionEvent(parsed: Json): string {
  const eventType = asString(parsed['event'])
  const toolName = asString(parsed['tool_name'])
  const risk = asString(parsed['risk_level'])

  if (eventType === 'permission_request_created') {
    const badge = risk ? ` [${risk}]` : ''
    return `\n\n🔐 **${toolName}** — permission required${badge}`
  }
  if (eventType === 'permission_request_resolved') {
    const resolution = asString(parsed['resolution'])
    if (resolution === 'approved') return `\n\n✅ **${toolName}** — permission approved`
    if (resolution === 'denied') return `\n\n❌ **${toolName}** — permission denied`
    if (resolution === 'timeout') return `\n\n⏰ **${toolName}** — permission timed out`
    return `\n\n🔐 **${toolName}** — permission ${resolution}`
  }
  if (eventType === 'permission_effect_applied') {
    if (asString(parsed['outcome']) === 'executed') return ''
    return `\n\n⚠️ **${toolName}** — execution failed`
  }
  return ''
}

function formatToolResult(message: Message, parsed: Json): string {
  const content = asString(parsed['content'])
  const meta = asRecord(parseJson(message.meta)) ?? {}

  const toolName = asString(meta['tool_name'])
  const ok = meta['ok'] !== false
  const errorCode = meta['error_code']

  let statusLine = `${ok ? '✅' : '❌'} **${toolName}**`
  // ⚠️ 旧实现的 `_({elapsed_ms}ms)_` 在这里**必然缺失**：本项目把耗时写在
  // `ToolExecutionRecord.elapsedMs` 上，而 tool_result 消息的 meta 里没有它。
  // 保留字段读取会让每个结果都显示 `(0ms)`，比不显示更糟。
  if (!ok && typeof errorCode === 'string') statusLine += ` — \`${errorCode}\``

  return `\n\n${statusLine}\n${formatResultContent(content)}`
}

/** 结果正文：先截断字符数，再尝试 JSON 美化，最后按行数折叠。 */
export function formatResultContent(content: string): string {
  if (content.trim().length === 0) return '```\n(empty)\n```'

  let text = content
  if (text.length > MAX_RESULT_CHARS) text = `${text.slice(0, MAX_RESULT_CHARS)}\n... [truncated]`

  let lang = ''
  let formatted = text
  const structured = parseJson(text)
  if (structured !== undefined) {
    lang = 'json'
    formatted = JSON.stringify(structured, null, 2)
  }

  const lines = formatted.split('\n')
  if (lines.length > MAX_RESULT_LINES) {
    const preview = lines.slice(0, MAX_RESULT_LINES).join('\n')
    return `\`\`\`${lang}\n${preview}\n... (${lines.length - MAX_RESULT_LINES} more lines, collapsed)\n\`\`\``
  }
  return `\`\`\`${lang}\n${formatted}\n\`\`\``
}

/**
 * 单条消息的最终显示文本（`_format_msg_display`，`app.py:2317-2326`）。
 *
 * `tool` / `system` 用各自的标签，其余按 user / assistant 二分。
 */
export function formatMessageDisplay(message: Message, language: Language): string {
  const body = messageToDisplay(message)
  if (message.role === 'tool') {
    return `**${translate(language, TKey.LABEL_TOOL)}**\n\n${body}`
  }
  if (message.role === 'system') {
    return `**${translate(language, TKey.LABEL_SYSTEM)}**\n\n${body}`
  }
  const label =
    message.role === 'user'
      ? translate(language, TKey.LABEL_YOU)
      : translate(language, TKey.LABEL_ASSISTANT)
  return `**${label}**\n\n${body}`
}

// ── 选择菜单 ──────────────────────────────────────────────────────

/**
 * 选择菜单文本（`_render_selection`，`app.py:2088-2107`）。
 *
 * 两条必须保留的细节：
 * - `title` 行**只在 items 非空时**出现；
 * - 面板路径下 `title` 会出现**两次**——一次作为 `_show_panel` 的 `## ` 标题，
 *   一次作为内容首行（旧实现就是如此，`_show_panel(self.selection_title, content)`）。
 */
export function renderSelectionText(selection: Selection, selectedIndex: number): string {
  const rows: string[] = []
  if (selection.header) rows.push(selection.header)
  if (selection.items.length > 0) {
    rows.push(selection.title)
    selection.items.forEach((item, index) => {
      const pointer = index === selectedIndex ? '>' : ' '
      rows.push(`${pointer} ${index + 1}. ${item.title}\n    ${item.description}`)
    })
  }
  if (selection.footer) rows.push(selection.footer)
  return rows.join('\n')
}

/** 面板文本（`_show_panel` 的 `f"## {title}\n\n{body}"`）。 */
export function renderPanelText(panel: Panel): string {
  return `## ${panel.title}\n\n${panel.body}`
}

/** 面板标题（供 Ink 视图单独渲染标题行）。 */
export function panelTitle(panel: Panel): string {
  return panel.title
}

/** 构造 `SelectionItem` 的小工具，供控制器使用。 */
export function item(key: string, title: string, description: string): SelectionItem {
  return { key, title, description }
}

// ── 待办面板 ──────────────────────────────────────────────────────

/** 待办面板渲染结果：一行标题 + 若干行条目，附各自颜色标记。 */
export interface TodoPanelRender {
  readonly title: string
  readonly summary: string
  readonly rows: readonly {
    readonly marker: string
    readonly color: string
    readonly content: string
  }[]
  /** 空列表 → 面板不显示（`_render_todo_panel` 的 `display = False`）。 */
  readonly visible: boolean
}

/**
 * 待办面板（`_render_todo_panel`，`app.py:2210-2238`）。
 *
 * 摘要由三段用 `" · "` 拼接，**为 0 的段省略**。
 */
export function renderTodoPanel(todos: readonly TodoEntry[], language: Language): TodoPanelRender {
  const done = todos.filter((todo) => todo.status === 'completed').length
  const active = todos.filter((todo) => todo.status === 'in_progress').length
  const pending = todos.filter((todo) => todo.status === 'pending').length

  const summaryParts: string[] = []
  if (done) summaryParts.push(`${done} ${translate(language, TKey.TODO_DONE)}`)
  if (active) summaryParts.push(`${active} ${translate(language, TKey.TODO_ACTIVE)}`)
  if (pending) summaryParts.push(`${pending} ${translate(language, TKey.TODO_PENDING)}`)

  return {
    title: translate(language, TKey.TODO_TITLE),
    summary: summaryParts.join(' · '),
    rows: todos.map((todo) => ({
      marker: TODO_MARKERS[todo.status] ?? TODO_FALLBACK_MARKER,
      color: TODO_MARKER_COLORS[todo.status] ?? TODO_MARKER_COLORS['pending'] ?? '#555566',
      content: todo.content,
    })),
    visible: todos.length > 0,
  }
}
