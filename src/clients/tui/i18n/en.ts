/**
 * 英文文案表。
 *
 * 文案取自旧项目 `i18n/en.py`，**逐字保留**（`parts/05` §10.5：未 i18n 的
 * 硬编码字符串是复刻基线）。新增键只有三处，都在 Phase 7 的新增验收项里：
 * `status.tier`（模型档位）、`status.cost`（成本）、`risk.critical`
 * （ADR 0002 §七 的 4 档风险）。
 */

import { TKey, type Language } from './keys.js'

export const EN: Readonly<Record<TKey, string>> = {
  [TKey.LABEL_YOU]: 'You',
  [TKey.LABEL_ASSISTANT]: 'Assistant',
  [TKey.LABEL_TOOL]: 'Tool',
  [TKey.LABEL_SYSTEM]: 'System',
  [TKey.LABEL_MESSAGE]: 'Message',

  [TKey.PLACEHOLDER_INPUT]: 'Ask DeepCode anything, or type / for commands',
  [TKey.PLACEHOLDER_PERMISSION]: 'Press Enter to approve, n to deny',

  [TKey.EMPTY_HINT]: 'Start a project-local conversation from the prompt below.',

  [TKey.CMENU_NO_MATCHES]: 'No matching commands',
  [TKey.CMENU_COMMANDS]: 'Commands',
  [TKey.CMENU_FOOTER]: 'Use ↑/↓ to select, Tab to autocomplete, Enter to open.',

  [TKey.FILE_MENTION_TITLE]: 'Workspace paths',
  [TKey.FILE_MENTION_FOOTER]: 'Use ↑/↓ to select, Enter or Tab to insert the path.',
  [TKey.FILE_MENTION_NO_MATCHES]: 'No matching files or folders for @{query}',
  [TKey.FILE_MENTION_FILE]: 'file',
  [TKey.FILE_MENTION_DIR]: 'directory',

  [TKey.PANEL_UNKNOWN_CMD]: 'Unknown command',
  [TKey.SEL_SESSION_TITLE]: 'Session history',
  [TKey.SEL_SESSION_FOOTER]: 'Use ↑/↓ to choose a session, Enter to select.',

  [TKey.STATUS_WORKING]: 'Working',
  [TKey.STATUS_COMPACTING]: 'Compacting conversation history...',
  [TKey.STATUS_NO_MODEL]: 'No model configured — use /api then /model',
  [TKey.STATUS_THINK]: 'Think: {status}',
  [TKey.STATUS_NO_CONV]: 'No conversation',
  [TKey.STATUS_MSGS]: '{count} msgs',
  [TKey.STATUS_TIER]: 'Tier: {tier}',
  [TKey.STATUS_COST]: '${cost}',
  [TKey.STATUS_ROUTE_CHANGED]: 'Model route changed: {from} → {to} ({reason})',
  [TKey.STATUS_MODE_NORMAL]: 'NORMAL',
  [TKey.STATUS_MODE_AUTO_EDIT]: 'AUTO EDIT',
  [TKey.STATUS_MODE_YOLO]: 'YOLO',
  [TKey.STATUS_MODE_PLAN]: 'PLAN',

  [TKey.PERM_TITLE]:
    '## Permission Required\n\n**Tool:** {tool}\n\n**Risk:** {risk}\n\n**Args:** `{args}`\n\n**Reason:** {reason}\n\n---\nPress **Enter** to approve, or **n** to deny',
  [TKey.PERM_LABEL]: 'Permission required',
  [TKey.PERM_PLACEHOLDER]: 'Press Enter to approve, n to deny',
  [TKey.PERM_APPROVE]: 'Approve - allow this tool to execute',
  [TKey.PERM_ALWAYS_APPROVE]: 'Always Allow - auto-approve this command type',
  [TKey.PERM_DENY]: 'Deny - block this tool call',
  [TKey.PERM_ACTION_TITLE]: 'Action required',
  [TKey.PERM_ACTION_FOOTER]: '↑/↓ select  |  Enter confirm  |  y=approve  a=always allow  n=deny',

  [TKey.RISK_LOW]: 'LOW',
  [TKey.RISK_MEDIUM]: 'MEDIUM',
  [TKey.RISK_HIGH]: 'HIGH',
  [TKey.RISK_CRITICAL]: 'CRITICAL',

  [TKey.TODO_TITLE]: 'Plan',
  [TKey.TODO_DONE]: 'done',
  [TKey.TODO_ACTIVE]: 'active',
  [TKey.TODO_PENDING]: 'pending',

  [TKey.MISC_NO_MESSAGES]: '_No messages_',
  [TKey.MISC_ERROR_PREFIX]: '*[Error: {error}]*',

  [TKey.HINT_CANCELLED]: 'Turn cancelled.',
}

/** 语言标识，供 `I18nStore` 建表时校验。 */
export const LANGUAGE: Language = 'en'
