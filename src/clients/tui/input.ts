/**
 * 输入框：文本编辑、`on_input_changed`、`on_input_submitted`。
 *
 * 旧实现把这三件事分散在 Textual 的 `Input` widget 与 `App` 的两个事件处理器里
 * （`app.py:669-760`）。这里把它拆成两层：
 *
 * 1. `editInputValue` 是**纯文本编辑器**（对应 Textual `Input` 的按键行为）；
 * 2. `applyInputChanged` / `submitInput` 是应用层判定，步骤逐字对应
 *    `parts/05` §3.4 / §3.5。
 *
 * 依赖方向是单向的：`input.ts → keys.ts`。反过来没有引用，因此不存在循环。
 */

import { TKey } from './i18n/keys.js'
import { translate } from './i18n/index.js'
import { insertSelectedMention, resolvePermission, type KeyInput } from './keys.js'
import { findActiveMention, workspacePathSuggestions } from './mentions.js'
import { SelectionContext, pure, type ReducerResult, type TuiState } from './types.js'

// ── 文本编辑器 ────────────────────────────────────────────────────

/** 编辑结果。 */
export interface EditResult {
  readonly value: string
  readonly cursor: number
  /** 值是否变化（对应 Textual 的 `Input.Changed`）。 */
  readonly changed: boolean
}

/**
 * 可打印字符判定。
 *
 * 用码点而不是控制字符正则：正则里的裸控制字符在源码里不可见，
 * 复制粘贴或格式化时极易被改坏，而这里的意图是明确的"排除 C0 与 DEL"。
 */
export function isPrintable(char: string): boolean {
  if (char.length === 0) return false
  for (const ch of char) {
    const code = ch.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) return false
  }
  return true
}

/**
 * 单次按键对输入框的编辑。
 *
 * 只处理 Textual `Input` widget 自己消费的键——这些键不会冒泡到 `App.on_key`
 * （`parts/05` §3.3），因此应用层判定跑完之后才轮到它。
 */
export function editInputValue(value: string, cursor: number, key: KeyInput): EditResult {
  const position = Math.max(0, Math.min(cursor, value.length))
  switch (key.name) {
    case 'char': {
      const char = key.char ?? ''
      if (!isPrintable(char)) return { value, cursor: position, changed: false }
      return {
        value: `${value.slice(0, position)}${char}${value.slice(position)}`,
        cursor: position + char.length,
        changed: true,
      }
    }
    case 'backspace': {
      if (position === 0) return { value, cursor: position, changed: false }
      return {
        value: `${value.slice(0, position - 1)}${value.slice(position)}`,
        cursor: position - 1,
        changed: true,
      }
    }
    case 'delete': {
      if (position >= value.length) return { value, cursor: position, changed: false }
      return {
        value: `${value.slice(0, position)}${value.slice(position + 1)}`,
        cursor: position,
        changed: true,
      }
    }
    case 'left':
      return { value, cursor: Math.max(0, position - 1), changed: false }
    case 'right':
      return { value, cursor: Math.min(value.length, position + 1), changed: false }
    case 'home':
      return { value, cursor: 0, changed: false }
    case 'end':
      return { value, cursor: value.length, changed: false }
    default:
      return { value, cursor: position, changed: false }
  }
}

// ── 菜单构造 ──────────────────────────────────────────────────────

/** 命令菜单的候选项来源。控制器传 `CommandRegistry.list()` 的投影进来。 */
export interface CommandEntry {
  readonly name: string
  readonly description: string
}

/**
 * 命令菜单（`_show_command_menu`，`app.py:1107-1122`）。
 *
 * **过滤算法是大小写敏感的前缀匹配**（`c.startswith(query)`），不是模糊匹配：
 * `/1` 只匹配 `/1M`，`/M` 不匹配 `/mcp`（§4.2）。
 */
export function showCommandMenu(
  state: TuiState,
  rawQuery: string,
  commands: readonly CommandEntry[],
): TuiState {
  const query = rawQuery.startsWith('/') ? rawQuery : `/${rawQuery}`
  const matches = commands.filter((command) => `/${command.name}`.startsWith(query))

  if (matches.length === 0) {
    // 无匹配时清空选择项（于是 up/down 退回输入历史），并显示无匹配提示。
    return {
      ...state,
      activeMentionSpan: undefined,
      selection: undefined,
      menuNotice: translate(state.language, TKey.CMENU_NO_MATCHES),
    }
  }
  return {
    ...state,
    activeMentionSpan: undefined,
    menuNotice: undefined,
    selection: {
      context: SelectionContext.MAIN,
      title: translate(state.language, TKey.CMENU_COMMANDS),
      header: '',
      footer: translate(state.language, TKey.CMENU_FOOTER),
      items: matches.map((command) => ({
        key: `/${command.name}`,
        title: `/${command.name}`,
        description: command.description,
      })),
      selectedIndex: 0,
    },
  }
}

/**
 * `@` 提及菜单（`_show_file_mention_menu`，`app.py:1124-1162`）。
 *
 * 返回 `active: false` 表示"当前没有活跃提及"（调用方据此关菜单）。
 * 工作区根由调用方传入——旧实现用 `paths.project_dir.parent`，
 * 本实现用 `AgentApplication.workspaceRoot`（同一个目录）。
 */
export function showFileMentionMenu(
  state: TuiState,
  value: string,
  cursorPosition: number,
  workspaceRoot: string,
): { readonly state: TuiState; readonly active: boolean } {
  const span = findActiveMention(value, cursorPosition)
  if (!span) return { state: { ...state, activeMentionSpan: undefined }, active: false }

  const suggestions = workspacePathSuggestions(workspaceRoot, span.query)
  const base: TuiState = { ...state, activeMentionSpan: span, menuNotice: undefined }

  if (suggestions.length === 0) {
    // 无匹配仍**保留语境与标题**，但清空 items —— 于是 up/down 走输入历史，
    // 且 Enter 不会被拦截（`on_input_submitted` 第 3 步要求 items 非空）。
    return {
      state: {
        ...base,
        selection: {
          context: SelectionContext.FILE_MENTION,
          title: translate(state.language, TKey.FILE_MENTION_TITLE),
          header: '',
          footer: '',
          items: [],
          selectedIndex: 0,
        },
        menuNotice: translate(state.language, TKey.FILE_MENTION_NO_MATCHES, {
          query: span.query,
        }),
      },
      active: true,
    }
  }

  return {
    state: {
      ...base,
      selection: {
        context: SelectionContext.FILE_MENTION,
        title: translate(state.language, TKey.FILE_MENTION_TITLE),
        header: '',
        footer: translate(state.language, TKey.FILE_MENTION_FOOTER),
        items: suggestions.map((suggestion) => ({
          key: suggestion.path,
          // 目录的 title 带尾斜杠（视觉区分），但插入的是**无斜杠**的 key。
          title: suggestion.isDir ? `${suggestion.path}/` : suggestion.path,
          description: translate(
            state.language,
            suggestion.isDir ? TKey.FILE_MENTION_DIR : TKey.FILE_MENTION_FILE,
          ),
        })),
        selectedIndex: 0,
      },
    },
    active: true,
  }
}

// ── on_input_changed ──────────────────────────────────────────────

/** `on_input_changed` 的依赖。 */
export interface InputChangedContext {
  readonly commands: readonly CommandEntry[]
  readonly workspaceRoot: string
}

/**
 * `on_input_changed`（`app.py:669-692`）的 6 步。
 *
 * 顺序要点：
 * - `_suppress_menu_update` 消费一次就复位——程序化改写输入框不能弹菜单；
 * - `/` 判定用 **strip 后**的值（前导空格也算命令）；
 * - `@` 判定用**原值** + 光标位置。
 */
export function applyInputChanged(state: TuiState, ctx: InputChangedContext): TuiState {
  // 1. 程序化修改 → 吃掉这次事件
  if (state.suppressMenuUpdate) return { ...state, suppressMenuUpdate: false }

  // 2. 表单进行中不弹菜单 —— 本实现没有多步表单（见 types.ts 的说明），
  //    这一步因此没有对应分支。

  // 3. 权限挂起时不弹菜单
  if (state.permissionQueue.length > 0) return state

  const stripped = state.input.trim()
  if (stripped.startsWith('/')) {
    return showCommandMenu({ ...state, activeMentionSpan: undefined }, stripped, ctx.commands)
  }

  const mention = showFileMentionMenu(state, state.input, state.cursor, ctx.workspaceRoot)
  if (mention.active) return mention.state

  // 6. 都不匹配 → 关菜单
  const cleared =
    state.selection?.context === SelectionContext.MAIN ||
    state.selection?.context === SelectionContext.FILE_MENTION
      ? { ...state, selection: undefined }
      : state
  return { ...cleared, menuNotice: undefined }
}

// ─ 选择激活 ─────────────────────────────────────────────────────

/**
 * `_activate_selection`（`app.py:1164-1207`）的语境分派。
 *
 * 只保留本实现真的会产生的 4 个语境，理由见 `types.ts` 的 `SelectionContext`。
 */
export function activateSelection(state: TuiState): ReducerResult {
  const selection = state.selection
  if (!selection) return pure(state)
  const item = selection.items[selection.selectedIndex]
  if (!item) return pure(state)

  switch (selection.context) {
    case SelectionContext.MAIN:
      return {
        state: clearInputSelection(state),
        effects: [{ kind: 'run-command', raw: item.key }],
      }
    case SelectionContext.FILE_MENTION:
      return insertSelectedMention(state)
    case SelectionContext.PERMISSION_REQUEST:
      if (item.key === 'approve' || item.key === 'always_approve' || item.key === 'deny') {
        const resolved = resolvePermission(state, item.key)
        return { state: resolved.state, effects: resolved.effects }
      }
      return pure(state)
    case SelectionContext.SESSION_SELECT:
      return {
        state: clearInputSelection(state),
        effects: [{ kind: 'select-session', sessionId: item.key }, { kind: 'render-history' }],
      }
    default:
      return pure(state)
  }
}

/** 清空输入框并收起菜单（`event.input.value = ""` + `command_menu.display = False`）。 */
function clearInputSelection(state: TuiState): TuiState {
  return {
    ...state,
    input: '',
    cursor: 0,
    selection: undefined,
    activeMentionSpan: undefined,
    menuNotice: undefined,
  }
}

// ─ on_input_submitted ────────────────────────────────────────────

/** `on_input_submitted` 的依赖。 */
export interface SubmitContext {
  readonly commands: readonly CommandEntry[]
}

/**
 * `on_input_submitted`（`app.py:694-760`）的 11 步判定。
 *
 * 与旧实现的**两处必要差异**，都是命令层下沉的连带结果：
 *
 * 1. **第 4 步**（`/api add ` / `/model use ` 直接执行）推广为
 *    **"带参数的命令直接执行"**：判据是 strip 后的文本包含空格。
 *    旧实现用两个硬编码前缀，因为那两条是旧命令表里仅有的带参命令；
 *    本实现的命令集由 `CommandRegistry` 提供，硬编码名字会漏掉后来新增的命令，
 *    而这一步的**目的**（带参命令不被菜单拦截）与具体名字无关。
 * 2. **第 10 步的会话标题**仍取 `prompt[:80]`，但**不再由 UI 落盘用户消息**：
 *    `ChatStore.beginTurn()` 已经写入（`src/storage/chat-store.ts`），
 *    UI 再写一次会产生两条 user 消息。UI 只提交 prompt，
 *    消息在随后的 `render-history` 里从存储读出来。
 */
export function submitInput(state: TuiState, _ctx: SubmitContext): ReducerResult {
  const prompt = state.input.trim()
  const items = state.selection?.items ?? []

  // 1. `paths is None` —— 本实现没有"未初始化"状态，跳过。
  // 2. 多步表单 —— 本实现无表单（`src/commands` 没有 `/api` preset 流程）。

  // 3. `@` 补全确认
  if (state.selection?.context === SelectionContext.FILE_MENTION && items.length > 0) {
    return activateSelection(state)
  }

  // 4. 带参数的命令直接执行（见上面的差异说明）
  if (prompt.startsWith('/') && prompt.includes(' ')) {
    return { state: clearInputSelection(state), effects: [{ kind: 'run-command', raw: prompt }] }
  }

  // 5. 权限挂起时按 Enter = 激活当前选中项
  if (state.permissionQueue.length > 0) return activateSelection(state)

  // 6. 菜单打开且（输入为空 或 输入以 / 开头）→ 激活选中项
  if (items.length > 0 && (prompt === '' || prompt.startsWith('/'))) {
    return activateSelection(state)
  }

  // 7. 空输入
  if (prompt === '') return pure(state)

  // 8. 流式中提交 = 打断重提
  if (state.streaming) {
    return {
      state: { ...state, pendingPrompt: prompt, input: '', cursor: 0 },
      effects: [{ kind: 'cancel-turn', reason: 'user' }],
    }
  }

  // 9. 斜杠命令
  if (prompt.startsWith('/')) {
    return { state: clearInputSelection(state), effects: [{ kind: 'run-command', raw: prompt }] }
  }

  // 10/11. 普通消息：清选择 → 提交（会话惰性创建交给控制器）
  const prepared: TuiState = {
    ...state,
    selection: undefined,
    activeMentionSpan: undefined,
    menuNotice: undefined,
    input: '',
    cursor: 0,
    // 命令菜单在提交后收起（`command_menu.display = False`）。
    suppressMenuUpdate: false,
  }
  // ️ 只发 `submit-prompt`，**不再追加 `render-history`**：
  // `TuiController.submitPrompt()` 自己会在提交前后刷新历史，而效果是**按序**
  // 执行的——多一条 `render-history` 会在提交返回后清掉刚写上的 `lastError`
  // （`refreshHistory` 的语义就是"临时提示重绘即失效"），
  // 于是"模型不可用"这类失败的提示会一闪而过，用户与测试都看不到。
  return { state: prepared, effects: [{ kind: 'submit-prompt', prompt }] }
}
