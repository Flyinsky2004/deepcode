/**
 * TUI 文案键表。
 *
 * 键的**值**是点分字符串（`"status.mode.yolo"`），与旧项目 `i18n/keys.py` 的
 * `StrEnum` 逐字一致——这样 `parts/05` §10.5 的"硬编码清单"与新加的键可以
 * 对照检查，缺键时 `t()` 返回的也是同一个可读字符串。
 *
 * 只收录 **TUI 实际使用** 的键：旧表里的 `form.*`（`/api` 多步表单）、
 * `panel.mcp.*`、`panel.skills.*`、`cmd.*`、`compact.*` 属于
 * 命令层 / MCP / Skill / 压缩引擎的文案，各自由其子系统持有
 * （命令描述来自 `CommandRegistry`，压缩提示词在 `src/runtime/prompts.ts`），
 * 搬进 TUI 会形成第二份真相源。
 */

export const TKey = {
  // ── 角色标签 ──
  LABEL_YOU: 'label.you',
  LABEL_ASSISTANT: 'label.assistant',
  LABEL_TOOL: 'label.tool',
  LABEL_SYSTEM: 'label.system',
  LABEL_MESSAGE: 'label.message',

  // ── 输入框占位 ──
  PLACEHOLDER_INPUT: 'placeholder.input',
  PLACEHOLDER_PERMISSION: 'placeholder.permission',

  // ── 首页 ──
  EMPTY_HINT: 'empty.hint',

  // ─ 命令菜单 ─
  CMENU_NO_MATCHES: 'cmenu.no_matches',
  CMENU_COMMANDS: 'cmenu.commands',
  CMENU_FOOTER: 'cmenu.footer',

  // ── @ 提及菜单 ──
  FILE_MENTION_TITLE: 'file_mention.title',
  FILE_MENTION_FOOTER: 'file_mention.footer',
  FILE_MENTION_NO_MATCHES: 'file_mention.no_matches',
  FILE_MENTION_FILE: 'file_mention.file',
  FILE_MENTION_DIR: 'file_mention.dir',

  // ── 面板 ──
  PANEL_UNKNOWN_CMD: 'panel.unknown_cmd',
  SEL_SESSION_TITLE: 'sel.session.title',
  SEL_SESSION_FOOTER: 'sel.session.footer',

  // ── 状态栏 ──
  STATUS_WORKING: 'status.working',
  STATUS_COMPACTING: 'status.compacting',
  STATUS_NO_MODEL: 'status.no_model',
  STATUS_THINK: 'status.think',
  STATUS_NO_CONV: 'status.no_conv',
  STATUS_MSGS: 'status.msgs',
  STATUS_TIER: 'status.tier',
  STATUS_COST: 'status.cost',
  STATUS_ROUTE_CHANGED: 'status.route_changed',
  STATUS_MODE_NORMAL: 'status.mode.normal',
  STATUS_MODE_AUTO_EDIT: 'status.mode.auto_edit',
  STATUS_MODE_YOLO: 'status.mode.yolo',
  STATUS_MODE_PLAN: 'status.mode.plan',

  // ── 权限请求 ──
  PERM_TITLE: 'perm.title',
  PERM_LABEL: 'perm.label',
  PERM_PLACEHOLDER: 'perm.placeholder',
  PERM_APPROVE: 'perm.approve',
  PERM_ALWAYS_APPROVE: 'perm.always_approve',
  PERM_DENY: 'perm.deny',
  PERM_ACTION_TITLE: 'perm.action.title',
  PERM_ACTION_FOOTER: 'perm.action.footer',

  // ── 风险徽标（4 档，ADR 0002 §七）──
  RISK_LOW: 'risk.low',
  RISK_MEDIUM: 'risk.medium',
  RISK_HIGH: 'risk.high',
  RISK_CRITICAL: 'risk.critical',

  // ── 待办面板 ─
  TODO_TITLE: 'todo.title',
  TODO_DONE: 'todo.done',
  TODO_ACTIVE: 'todo.active',
  TODO_PENDING: 'todo.pending',

  // ── 杂项 ──
  MISC_NO_MESSAGES: 'misc.no_messages',
  MISC_ERROR_PREFIX: 'misc.error_prefix',

  // ── 提示 ──
  HINT_CANCELLED: 'hint.cancelled',
} as const

/** 文案键类型。 */
export type TKey = (typeof TKey)[keyof typeof TKey]

/** 全部键，供"两份表键集一致"的测试使用。 */
export const ALL_KEYS: readonly TKey[] = Object.values(TKey)

/** 支持的语言。 */
export const Language = {
  EN: 'en',
  ZH: 'zh',
} as const

/** 语言类型。 */
export type Language = (typeof Language)[keyof typeof Language]
