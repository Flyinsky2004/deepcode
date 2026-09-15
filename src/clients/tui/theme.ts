/**
 * TUI 配色与首页 logo。
 *
 * 颜色全部是 `app.py:209-313` 的**硬编码十六进制值**，逐条抄录——
 * `parts/05` §2.1 的检查清单明确要求"CSS 的全部颜色值照抄"。
 * Ink 的 `color` 属性直接接受 `#rrggbb`，所以这里不需要任何转换层。
 *
 * ️ 与旧项目的差异（有意）：
 * - **无边框渲染**。Ink 没有 Textual 的 `border: round #334155`，边框要手工
 *   用 `borderStyle` 画。`border`/`focusBorder` 两个颜色因此只用于分隔线，
 *   面板改为加粗标题 + 前缀标记。这不改变任何可观测的**语义**（哪个容器在
 *   哪个位置、显示什么内容），只改变边框的画法。
 * - **logo 文案是 `DEEPCODE`**，旧项目是 `FLYINCHAT`。同一段 ASCII art 槽位、
 *   同一字体风格、同一颜色（`#7dd3fc` 加粗居中），只是产品名不同
 *   （数据目录已是 `~/.deepcode`，见 ADR 0001 决策 7）。
 */

/** `app.py:209-313` 的硬编码色值。 */
export const COLORS = {
  /** Screen.background */
  screen: '#0a0e17',
  /** Screen.color */
  screenText: '#d7dde8',
  /** Header/Footer.background */
  chrome: '#0f1724',
  /** Header.color */
  chromeText: '#edf2f7',
  /** #empty-logo */
  logo: '#7dd3fc',
  /** #empty-hint / #input-label / Footer.color */
  muted: '#8b9bb4',
  /** #message-view.color / #prompt-input.color */
  body: '#edf2f7',
  /** #composer border-top */
  composerBorder: '#1f2a3d',
  /** #todo-panel.background */
  surface: '#101827',
  /** #todo-panel border */
  todoBorder: '#2d4a3e',
  /** #todo-panel .todo-title */
  todoTitle: '#4ade80',
  /** #command-menu / #prompt-input border */
  menuBorder: '#334155',
  /** #prompt-input:focus border */
  focusBorder: '#7dd3fc',
  /** #status-bar.color */
  status: '#6b7d99',
} as const

/**
 * 模式标签颜色（`app.py:2141-2158` 的 `mode_keys`）。
 *
 * 旧表第一项是 `"normal"`——那是**未被使用**的名称，实际只取颜色。
 * 这里只保留颜色，并在注释里记一笔（不复刻死字段）。
 */
export const MODE_COLORS: readonly string[] = [
  '#7dd3fc', // 0 normal
  '#fbbf24', // 1 auto_edit
  '#dc2626', // 2 yolo（旧值 `bold #dc2626`，Ink 用 bold 属性表达加粗）
  '#60a5fa', // 3 plan
]

/** yolo 模式额外加粗，对应旧 CSS 的 `bold #dc2626`。 */
export const MODE_BOLD: readonly boolean[] = [false, false, true, false]

/** 待办标记（`app.py:2219-2223`）。未知状态回退 `○`。 */
export const TODO_MARKERS: Readonly<Record<string, string>> = {
  completed: '✓',
  in_progress: '▸',
  pending: '○',
}

/** 未知状态的标记。 */
export const TODO_FALLBACK_MARKER = '○'

/** 待办标记颜色，与旧实现的 Rich 标记一一对应。 */
export const TODO_MARKER_COLORS: Readonly<Record<string, string>> = {
  completed: '#4ade80',
  in_progress: '#fbbf24',
  pending: '#555566',
}

/** 状态栏 spinner 帧（`app.py:104`，120ms/帧）。 */
export const SPINNER_FRAMES: readonly string[] = ['|', '/', '—', '\\']

/**
 * 首页大标题。
 *
 * 字体与旧 `_EMPTY_LOGO` 同一套（ANSI Shadow 风格方块字），逐字替换为
 * `DEEPCODE`；`.strip()` 的语义对应下面的 `trim()` 调用。
 */
export const EMPTY_LOGO = [
  '██████╗ ███████╗█████████████╗  ██████╗ ██████  ██████╗ ███████╗',
  '██╔══██╗██╔════██════██╔══██╗██╔════╝██╔═══██╗██══██╗██╔════',
  '██  ███████╗  █████╗  ██████╔╝██     ██   ███  ███████╗  ',
  '██  ████╔══╝  ██╔══╝  ██╔═══╝ ██     ██   ████║  ██║██╔══╝  ',
  '██████╔╝███████╗███████╗██     ╚██████╗██████╔██████╔╝███████',
  '╚═════╝ ══════╝══════╝═╝      ╚═════ ╚═════╝ ╚═════╝ ══════╝',
].join('\n')

/** 布局用到的 id，与 `app.py:317-336` 的 `compose()` 逐一对齐。 */
export const IDS = {
  CHAT_AREA: 'chat-area',
  EMPTY_STATE: 'empty-state',
  EMPTY_LOGO: 'empty-logo',
  EMPTY_HINT: 'empty-hint',
  MESSAGE_VIEW: 'message-view',
  COMPOSER: 'composer',
  TODO_PANEL: 'todo-panel',
  COMMAND_MENU: 'command-menu',
  INPUT_LABEL: 'input-label',
  PROMPT_INPUT: 'prompt-input',
  STATUS_BAR: 'status-bar',
} as const

/** 应用标题（旧 `TITLE = "FlyinChat"`）。 */
export const APP_TITLE = 'DeepCode'

/** Footer 提示（旧 `BINDINGS = [("q", "quit", "Quit")]` 只有一条）。 */
export const FOOTER_HINT = 'ctrl+c Quit'
