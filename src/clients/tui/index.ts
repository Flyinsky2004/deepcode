/**
 * TUI 表现层的导出面。
 *
 * 依赖方向：`src/clients/tui → src/app → src/runtime / tools / providers / storage
 * → src/core`。TUI **不**被任何内核模块 import——`src/index.ts` 也不导出它，
 * 否则"内核不依赖 TUI"（`progess.md` 设计约束 1）就会在打包图里被破坏。
 */

// ── 装配与入口 ──
export { TuiApp, toKeyInput, renderQuestionnaire, MAX_RENDERED_MESSAGES } from './app.js'
export type { TuiAppProps } from './app.js'
export { runTui, createTuiRuntime } from './run.js'
export type { TuiRuntime } from './run.js'
export { TuiController, SPINNER_INTERVAL_MS, STREAM_RENDER_INTERVAL_MS } from './controller.js'
export type { TuiControllerOptions, InputApplyResult } from './controller.js'

// ─ 状态机（纯函数，可脱离 React 使用）──
export {
  createInitialState,
  MODE_NAMES,
  MENU_CONTEXTS,
  PermissionChoice,
  SelectionContext,
  pure,
} from './types.js'
export type {
  InputPrompt,
  MentionSpan,
  ModeIndex,
  Panel,
  PendingPermission,
  Questionnaire,
  ReducerResult,
  Selection,
  SelectionItem,
  StatusModel,
  TodoEntry,
  TuiEffect,
  TuiState,
} from './types.js'

export {
  handleKey,
  handleQuestionnaireKey,
  resolvePermission,
  navigatePromptHistory,
  recordPromptHistory,
  clearSelection,
  resolveInputPrompt,
  selectionTargetsMenu,
  answersToArray,
  DOUBLE_ESCAPE_MS,
} from './keys.js'
export type { KeyInput, KeyName, KeyResult } from './keys.js'

export {
  activateSelection,
  applyInputChanged,
  editInputValue,
  isPrintable,
  showCommandMenu,
  showFileMentionMenu,
  submitInput,
} from './input.js'
export type { CommandEntry, EditResult, SubmitContext } from './input.js'

export {
  applyEvent,
  enqueuePermission,
  createQuestionnaire,
  estimateStreamingTokens,
  modeIndexFromName,
} from './events.js'
export type { EventResult } from './events.js'

// ── 渲染纯函数 ──
export {
  formatCost,
  contextWindowLabel,
  estimateCost,
  maxOutputLabel,
  modeLabel,
  renderStatusBar,
  statusBarLine,
} from './status-bar.js'
export {
  formatMessageDisplay,
  formatResultContent,
  messageToDisplay,
  renderPanelText,
  renderSelectionText,
  renderTodoPanel,
  MAX_RESULT_CHARS,
  MAX_RESULT_LINES,
} from './format.js'

// ─ 提及 ──
export {
  findActiveMention,
  insertMention,
  isIgnoredPath,
  workspacePathSuggestions,
  IGNORED_DIR_NAMES,
  MENTION_LIMIT,
} from './mentions.js'
export type { WorkspacePathSuggestion } from './mentions.js'

// ── 主题与 i18n ──
export {
  APP_TITLE,
  COLORS,
  EMPTY_LOGO,
  IDS,
  MODE_COLORS,
  SPINNER_FRAMES,
  TODO_MARKERS,
} from './theme.js'
export { I18nStore, translate, TKey, Language, ALL_KEYS } from './i18n/index.js'
