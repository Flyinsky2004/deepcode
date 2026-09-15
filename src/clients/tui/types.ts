/**
 * TUI 状态与效果的类型定义。
 *
 * ## 为什么把状态抽成独立模块
 *
 * 旧实现把全部 UI 状态放在 `FlyinChatApp` 的**实例字段**上（`app.py:106-163`），
 * 于是"按 shift+tab 之后会发生什么"只能靠启动一个 Textual 应用来验证。
 * 这里把同一批字段抽成**不可变状态**，键位判定、事件归约、状态栏计算因此
 * 都是纯函数，可以直接断言（`common/coding-style.md`：状态更新 = 构造新对象）。
 *
 * ## 与旧字段的对应关系
 *
 * 字段名尽量沿用旧名（去掉 `_` 前缀），便于逐条对照 `parts/05` §1.3 的表格。
 * 少数地方**有意不同**，都写在各自字段的注释里。
 */

import type { Language } from './i18n/keys.js'
import type { PrincipalId, SessionId } from '../../core/ids.js'
import type { Message } from '../../core/models.js'
import type { AskUserQuestion } from '../../core/input.js'
import type { RiskLevel } from '../../core/tool.js'

// ── 选择菜单 ──────────────────────────────────────────────────────

/** 选择项（`app.py:88-92`）。 */
export interface SelectionItem {
  /** 选中后回传的稳定标识（命令名 / 模型 id / `approve` / 文件相对路径）。 */
  readonly key: string
  readonly title: string
  /** 副标题，缩进 4 空格渲染在下一行。 */
  readonly description: string
}

/**
 * 选择菜单的语境（`app.py:1164-1207` 的完整 match 表）。
 *
 * 只保留本实现**真的会产生**的语境：`main`（命令菜单）、`file_mention`、
 * `permission_request`、`session_select`。旧表里的 `api_actions` /
 * `model_select` / `thinking_toggle` / `reasoning_select` / `effort_select` /
 * `mcp_select` / `mcp_action` 由已被 `CommandRegistry` 取代的命令、或尚未移植的
 * MCP 子系统产生——现在构造它们只会得到永不出现的分支。
 */
export const SelectionContext = {
  MAIN: 'main',
  FILE_MENTION: 'file_mention',
  PERMISSION_REQUEST: 'permission_request',
  SESSION_SELECT: 'session_select',
} as const

/** 选择语境类型。 */
export type SelectionContext = (typeof SelectionContext)[keyof typeof SelectionContext]

/**
 * 渲染到 `#command-menu` 的语境集合（`app.py:2088-2107` 的关键分流规则）。
 *
 * 其余语境走 `_show_panel()`——**全屏替换消息区**（BUG-COMPAT，见 §12.2 第 14 项）。
 */
export const MENU_CONTEXTS: ReadonlySet<string> = new Set([
  SelectionContext.MAIN,
  SelectionContext.FILE_MENTION,
  SelectionContext.PERMISSION_REQUEST,
])

/** 当前选择菜单。 */
export interface Selection {
  readonly context: SelectionContext
  readonly title: string
  readonly header: string
  readonly footer: string
  readonly items: readonly SelectionItem[]
  /** 高亮项（旧 `selected_index`），`up`/`down`/`tab` 都改它。 */
  readonly selectedIndex: number
}

// ── 面板 / 待办 ───────────────────────────────────────────────────

/**
 * `_show_panel(title, body)` 的结果。
 *
 * BUG-COMPAT（§12.2 第 14 项）：面板**清空整个消息区**并在其上覆盖渲染，
 * 返回会话视图需要显式重绘历史。这里用一个状态字段表达同一语义：
 * `panel !== undefined` 时消息区只渲染面板。
 */
export interface Panel {
  readonly title: string
  readonly body: string
}

/** 待办项（来自 `todo_write` 工具结果的 meta）。 */
export interface TodoEntry {
  readonly content: string
  readonly status: string
}

// ── 权限 ──────────────────────────────────────────────────────────

/** 审批决议（旧实现的三个选项，`app.py:1258-1262`）。 */
export const PermissionChoice = {
  APPROVE: 'approve',
  ALWAYS_APPROVE: 'always_approve',
  DENY: 'deny',
} as const

/** 审批决议类型。 */
export type PermissionChoice = (typeof PermissionChoice)[keyof typeof PermissionChoice]

/** 一条待审批请求的 UI 视图。 */
export interface PendingPermission {
  readonly requestId: string
  readonly toolName: string
  /** 风险等级。事件里是裸字符串，取值来自 `RiskLevel`（4 档）。 */
  readonly riskLevel: RiskLevel
  readonly argsPreview: string
  readonly reason: string
  /** 到期时刻（epoch 毫秒）。超时由 broker 按拒绝处理。 */
  readonly expiresAt: number
}

// ── 问卷（ask_user_question）─────────────────────────────────────

/**
 * 问卷状态。
 *
 * T-10（修正）：旧实现把多选题的"光标"放在**动态属性**
 * `_multi_cursor_label` 上（`app.py:1454`/`1461`/`1469`），既不在 `__init__`
 * 初始化，也会在同一 App 实例内**跨问卷残留**。这里把它纳入正式状态
 * （`multiCursorLabel`），并在每次新问卷开始时重置。
 */
export interface Questionnaire {
  readonly requestId: string
  readonly questions: readonly AskUserQuestion[]
  readonly currentQuestion: number
  /** 按题下标对齐的答案：单选是 `string`，多选是 `string[]`。（T-10） */
  readonly answers: Readonly<Record<number, string | readonly string[]>>
  /** 多选题的当前光标项标签。 */
  readonly multiCursorLabel: string | undefined
}

// ── 输入框 ────────────────────────────────────────────────────────

/**
 * 输入框 label/placeholder 的**意图**，而不是已解析的文案。
 *
 * T-6 相关修正：旧实现把解析后的字符串存进 widget（`_set_input_prompt`），
 * 于是 `/language` 切换后 label 仍是旧语言，直到某条路径显式重写它
 * （§12.2 第 6 项）。这里存意图，渲染时按**当前语言**解析，
 * 切换语言即自动重绘。
 */
export type InputPrompt =
  | { readonly kind: 'default' }
  | { readonly kind: 'permission' }
  | { readonly kind: 'custom'; readonly label: string; readonly placeholder: string }

/** `@` 提及区间（`file_mentions.py:20-24`）。 */
export interface MentionSpan {
  readonly start: number
  readonly end: number
  readonly query: string
}

// ── 模式 ──────────────────────────────────────────────────────────

/**
 * 权限模式序号（`app.py:2141-2158`）。
 *
 * **不持久化**，每次启动重置为 0（§12.1 不变量 10）。
 */
export type ModeIndex = 0 | 1 | 2 | 3

/** 序号 → `PermissionMode` 字符串（`mode_int_to_str`）。 */
export const MODE_NAMES: readonly string[] = ['normal', 'auto_edit', 'yolo', 'plan']

// ─ 顶层状态 ──────────────────────────────────────────────────────

/**
 * 整个 TUI 的状态。
 *
 * **不可变**：所有更新都是 `{...state, x}` 形式。这让"按键 → 新状态"可断言，
 * 也让 React 的按引用比较自然生效。
 */
export interface TuiState {
  readonly language: Language
  readonly mode: ModeIndex

  /** 当前会话 id。`undefined` 表示"还没建会话"（§12.1 不变量 1）。 */
  readonly sessionId: SessionId | undefined

  // ── 消息区（真相源是存储）──
  /** 最近一次从存储读出的消息（原始 `Message`，渲染时再格式化）。 */
  readonly messages: readonly Message[]
  readonly emptyStateVisible: boolean
  readonly panel: Panel | undefined
  /** 临时追加在历史末尾的一条提示（旧 `__hint_N__`）。重绘即失效。 */
  readonly notice: string | undefined
  /**
   * 最近一次的**失败原因**。
   *
   * 与 `notice` 分开：`notice` 是"下次重绘就消失"的临时提示，而失败必须在
   * 这一轮结束后仍然可见——失败路径上 `turn_end` 会紧跟一次历史重绘，
   * 用 `notice` 承载错误会正好被那次重绘抹掉。`lastError` 只在下一个
   * `turn_start` 时清除。
   */
  readonly lastError: string | undefined

  // ── 待办面板 ──
  readonly todos: readonly TodoEntry[]
  readonly todoVisible: boolean

  // ── 选择 ──
  readonly selection: Selection | undefined
  /**
   * 菜单区的"无匹配"提示（旧实现直接 `command_menu.update(...)` 覆盖文本）。
   *
   * 与 `selection` 分开：无匹配时 `selection` 必须为空（up/down 才能退回输入
   * 历史），但菜单区仍要显示一行说明。
   */
  readonly menuNotice: string | undefined
  /** 程序化改输入框时抑制菜单重算（`_suppress_menu_update`）。 */
  readonly suppressMenuUpdate: boolean

  // ── 输入 ──
  readonly input: string
  readonly cursor: number
  readonly inputPrompt: InputPrompt
  readonly promptHistory: readonly string[]
  /** 历史游标。`undefined` = 不在历史浏览中。 */
  readonly historyIndex: number | undefined
  readonly historyDraft: string
  readonly activeMentionSpan: MentionSpan | undefined
  /** 上次单击 Esc 的时刻（epoch 毫秒），用于双击判定。 */
  readonly lastEscapeAt: number

  // ── 权限（T-2：队列而非单槽位）──
  readonly permissionQueue: readonly PendingPermission[]

  // ─ 问卷 ──
  readonly questionnaire: Questionnaire | undefined

  // ── 流式 ──
  readonly streaming: boolean
  readonly spinnerFrame: number
  readonly streamingText: string
  /** 流式期 token 粗估（`max(1, len(text)//4)`）。 */
  readonly streamingTokens: number
  /** 上次流式重绘时刻（epoch 毫秒），50ms 节流。 */
  readonly lastStreamRenderAt: number
  readonly compacting: boolean

  // ── 记账 ──
  readonly lastInputTokens: number
  readonly totalOutputTokens: number
  /** 流式中提交时暂存的 prompt，取消后自动重提。 */
  readonly pendingPrompt: string | undefined

  /** 本机 principal（`resolvePermission` / `answerUserInput` 需要）。 */
  readonly principalId: PrincipalId

  /**
   * 状态栏用的模型信息（从 config 的 tier assignment 解析）。
   *
   * 放进状态而不是每次渲染去读盘：旧实现的状态栏每帧调
   * `get_primary_llm_model()` + `list_messages()`（§12.2 第 9 项），
   * 这里改为在"配置可能变化"的时刻刷新一次（启动、命令执行后、turn 结束）。
   */
  readonly statusModel: StatusModel | undefined
}

/**
 * 状态栏需要的模型信息。
 *
 * 刻意**不含任何 I/O**：解析由控制器完成，渲染函数因此可以纯函数单测。
 */
export interface StatusModel {
  readonly providerName: string
  readonly modelName: string
  readonly thinkingEnabled: boolean
  /** 未设置时（`ModelProfile.reasoningEffort` 可选）显示 `default`。 */
  readonly reasoningEffort: string | undefined
  readonly contextWindow: number
  readonly maxOutputTokens: number
  /** 档位名，如 `implementation`。 */
  readonly tier: string
  readonly inputCostPerMillion: number | undefined
  readonly outputCostPerMillion: number | undefined
}

/** 初始状态。**不做任何 I/O**（对应旧实现"构造期只赋初值"）。 */
export function createInitialState(input: {
  readonly principalId: PrincipalId
  readonly language?: Language
}): TuiState {
  return {
    language: input.language ?? 'en',
    mode: 0,
    sessionId: undefined,
    messages: [],
    // 首屏显示 `#empty-state`（logo + 提示），旧 `on_mount` 不渲染历史。
    emptyStateVisible: true,
    panel: undefined,
    notice: undefined,
    lastError: undefined,
    todos: [],
    todoVisible: false,
    selection: undefined,
    menuNotice: undefined,
    suppressMenuUpdate: false,
    input: '',
    cursor: 0,
    inputPrompt: { kind: 'default' },
    promptHistory: [],
    historyIndex: undefined,
    historyDraft: '',
    activeMentionSpan: undefined,
    lastEscapeAt: 0,
    permissionQueue: [],
    questionnaire: undefined,
    streaming: false,
    spinnerFrame: 0,
    streamingText: '',
    streamingTokens: 0,
    lastStreamRenderAt: 0,
    compacting: false,
    lastInputTokens: 0,
    totalOutputTokens: 0,
    pendingPrompt: undefined,
    principalId: input.principalId,
    statusModel: undefined,
  }
}

// ── 效果 ──────────────────────────────────────────────────────────

/**
 * 归约函数**不直接执行**副作用，而是返回一组效果描述，由控制器执行。
 *
 * 这样"按 `y` 会调用 `resolvePermission`"可以被断言成一条效果，
 * 而不必真的起一个 broker。
 */
export type TuiEffect =
  /** 取消当前 turn（流式中 Esc / 打断重提）。 */
  | { readonly kind: 'cancel-turn'; readonly reason: string }
  /** 提交审批决议。 */
  | {
      readonly kind: 'resolve-permission'
      readonly requestId: string
      readonly decision: 'allow' | 'deny'
      /**
       * 工具名。
       *
       * ️ **必须随效果一起传**：归约函数在产生这条效果时已经把请求**出队**，
       * 控制器再去状态里查就查不到了（`always_approve` 的 `grantScope`
       * 需要它）。
       */
      readonly toolName: string
      readonly grantScope?: 'tool'
      readonly reason: string
    }
  /** 提交问卷作答。`answers` 为 `null` 表示放弃作答。 */
  | {
      readonly kind: 'answer-user-input'
      readonly requestId: string
      readonly answers: readonly (readonly string[])[] | null
      readonly reason: string
    }
  /** 提交一条用户消息（可能先惰性建会话）。 */
  | { readonly kind: 'submit-prompt'; readonly prompt: string }
  /** 执行一条斜杠命令。 */
  | { readonly kind: 'run-command'; readonly raw: string }
  /** 重新从存储读消息并重绘消息区。 */
  | { readonly kind: 'render-history' }
  /** 读取待办并刷新面板。 */
  | { readonly kind: 'refresh-todos' }
  /** 把视图绑定到另一个会话并重绘（`session_select` 的激活）。 */
  | { readonly kind: 'select-session'; readonly sessionId: string }
  /** 重新从存储读输入历史（`_load_prompt_history`）。 */
  | { readonly kind: 'load-prompt-history' }
  /** 优雅关闭。 */
  | { readonly kind: 'shutdown' }

/** 归约结果：新状态 + 待执行效果。 */
export interface ReducerResult {
  readonly state: TuiState
  readonly effects: readonly TuiEffect[]
}

/** 无效果的便捷构造。 */
export function pure(state: TuiState): ReducerResult {
  return { state, effects: [] }
}
