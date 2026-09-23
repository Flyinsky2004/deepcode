/**
 * 中文文案表。
 *
 * 与 `en.ts` **键集必须完全相同**——`tests/tui/i18n.test.ts` 直接断言这一点。
 * 缺一个键就会在中文界面下显示点分键名（`t()` 的缺键行为），
 * 而那正是 `parts/05` §10.2 要避免的。
 */

import { TKey, type Language } from './keys.js'

export const ZH: Readonly<Record<TKey, string>> = {
  [TKey.LABEL_YOU]: '你',
  [TKey.LABEL_ASSISTANT]: '助手',
  [TKey.LABEL_TOOL]: '工具',
  [TKey.LABEL_SYSTEM]: '系统',
  [TKey.LABEL_MESSAGE]: '消息',

  [TKey.PLACEHOLDER_INPUT]: '向 DeepCode 提问，或输入 / 查看命令',
  [TKey.PLACEHOLDER_PERMISSION]: '按 Enter 批准，n 拒绝',

  [TKey.EMPTY_HINT]: '在下方输入框中开始项目本地的对话。',

  [TKey.CMENU_NO_MATCHES]: '没有匹配的命令',
  [TKey.CMENU_COMMANDS]: '命令',
  [TKey.CMENU_FOOTER]: '↑/↓ 选择，Tab 自动补全，Enter 打开。',

  [TKey.FILE_MENTION_TITLE]: '工作区路径',
  [TKey.FILE_MENTION_FOOTER]: '↑/↓ 选择，Enter 或 Tab 插入路径。',
  [TKey.FILE_MENTION_NO_MATCHES]: '没有匹配 @{query} 的文件或文件夹',
  [TKey.FILE_MENTION_FILE]: '文件',
  [TKey.FILE_MENTION_DIR]: '文件夹',

  [TKey.PANEL_UNKNOWN_CMD]: '未知命令',
  [TKey.SEL_SESSION_TITLE]: '会话历史',
  [TKey.SEL_SESSION_FOOTER]: '↑/↓ 选择会话，Enter 进入。',

  [TKey.STATUS_WORKING]: '正在处理',
  [TKey.STATUS_COMPACTING]: '⏳ 正在压缩对话历史...',
  [TKey.STATUS_NO_MODEL]: '未配置模型 — 请使用 /api 然后 /model',
  [TKey.STATUS_THINK]: '思考: {status}',
  [TKey.STATUS_NO_CONV]: '无对话',
  [TKey.STATUS_MSGS]: '{count} 条消息',
  [TKey.STATUS_TIER]: '档位: {tier}',
  [TKey.STATUS_COST]: '${cost}',
  [TKey.STATUS_ROUTE_CHANGED]: '模型路由已切换：{from} → {to}（{reason}）',
  [TKey.STATUS_MODE_NORMAL]: '常规',
  [TKey.STATUS_MODE_AUTO_EDIT]: '自动',
  [TKey.STATUS_MODE_YOLO]: 'YOLO',
  [TKey.STATUS_MODE_PLAN]: '计划',

  [TKey.PERM_TITLE]:
    '## 需要权限\n\n**工具：** {tool}\n\n**风险：** {risk}\n\n**参数：** `{args}`\n\n**原因：** {reason}\n\n---\n按 **Enter** 批准，或按 **n** 拒绝',
  [TKey.PERM_LABEL]: '需要权限',
  [TKey.PERM_PLACEHOLDER]: '按 Enter 批准，n 拒绝',
  [TKey.PERM_APPROVE]: '批准 - 允许此工具执行',
  [TKey.PERM_ALWAYS_APPROVE]: '总是允许 - 自动批准此类命令',
  [TKey.PERM_DENY]: '拒绝 - 阻止此工具调用',
  [TKey.PERM_ACTION_TITLE]: '需要操作',
  [TKey.PERM_ACTION_FOOTER]: '↑/↓ 选择  |  Enter 确认  |  y=批准  a=总是允许  n=拒绝',

  [TKey.RISK_LOW]: '低',
  [TKey.RISK_MEDIUM]: '中',
  [TKey.RISK_HIGH]: '高',
  [TKey.RISK_CRITICAL]: '严重',

  [TKey.TODO_TITLE]: '计划',
  [TKey.TODO_DONE]: '已完成',
  [TKey.TODO_ACTIVE]: '进行中',
  [TKey.TODO_PENDING]: '待处理',

  [TKey.MISC_NO_MESSAGES]: '_暂无消息_',
  [TKey.MISC_ERROR_PREFIX]: '*[错误: {error}]*',

  [TKey.HINT_CANCELLED]: '已取消本轮。',
}

/** 语言标识，供 `I18nStore` 建表时校验。 */
export const LANGUAGE: Language = 'zh'
