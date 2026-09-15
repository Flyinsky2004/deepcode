/**
 * 键位判定（`app.py:591-667` 的 `on_key`）。
 *
 * ## 为什么是一个函数而不是分散的监听器
 *
 * 旧实现在**单个** `on_key` 里按**严格顺序**判断，顺序本身就是行为契约
 * （`parts/05` §3.1）。分散成多个监听器会丢掉"谁先谁后"，而这里最容易错的
 * 恰好就是顺序：`shift+tab` 必须排在权限判断之前（权限弹窗打开时也要能切模式），
 * `escape` 的四步必须排在 `y`/`a`/`n` 之前（否则单次 Esc 会变成拒绝权限）。
 *
 * ## `handled` 的含义
 *
 * 返回的 `handled` 表示**应用层是否对这次按键采取了动作**，而不是"按键是否
 * 被消耗"。未被应用层处理的键（可打印字符、退格、左右、回车）随后交给输入框
 * 编辑器——对应旧实现里 Textual 的 `Input` widget 先消费、冒泡到 `App.on_key`
 * 的那部分。
 *
 * ️ **一处对规格的解读**：`parts/05` §3.3 说可打印字符"不经 `on_key` 第 5 步
 * 之后逻辑"，照字面理解 `y`/`a`/`n` 也到不了第 5-7 步，那权限提示里
 * 宣传的 `y=approve a=always allow n=deny`（`PERM_ACTION_FOOTER`）就永远不生效。
 * 这里按**意图**实现：审批挂起时 `y`/`a`/`n` 被应用层接管，不进入输入框。
 * 这是唯一能让那段提示可用的解释，且与 §3.1 的顺序表完全一致。
 */

import { TKey } from './i18n/keys.js'
import { translate } from './i18n/index.js'

import { insertMention } from './mentions.js'
import {
  MENU_CONTEXTS,
  SelectionContext,
  pure,
  type ModeIndex,
  type PendingPermission,
  type Questionnaire,
  type ReducerResult,
  type Selection,
  type TuiEffect,
  type TuiState,
} from './types.js'

/** 双击 Esc 的时间窗（`app.py:605` 的 `0.5` 秒）。 */
export const DOUBLE_ESCAPE_MS = 500

/** 应用层能识别的按键。 */
export type KeyName =
  | 'shift+tab'
  | 'tab'
  | 'escape'
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'enter'
  | 'space'
  | 'backspace'
  | 'delete'
  | 'home'
  | 'end'
  | 'char'
  /** 未识别的键：应用层不动它，交给输入框。 */
  | 'other'

/** 一次按键。 */
export interface KeyInput {
  readonly name: KeyName
  /** `name === 'char'` 时的可打印字符。 */
  readonly char?: string
}

/** 判定结果。 */
export interface KeyResult extends ReducerResult {
  /** 应用层是否处理了这次按键（未处理则交给输入框编辑器）。 */
  readonly handled: boolean
}

function result(state: TuiState, handled: boolean, effects: readonly TuiEffect[] = []): KeyResult {
  return { state, handled, effects }
}

/** 清空选择（`_clear_selection`）。 */
export function clearSelection(state: TuiState): TuiState {
  return {
    ...state,
    selection: undefined,
    activeMentionSpan: undefined,
  }
}

/** 取出队首的待审批项。 */
function popPermission(state: TuiState): {
  readonly state: TuiState
  readonly permission: PendingPermission | undefined
} {
  const [head, ...rest] = state.permissionQueue
  return { state: { ...state, permissionQueue: rest }, permission: head }
}

/**
 * 审批决议的效果与状态更新（`_resolve_pending_permission`，`app.py:1481-1511`）。
 *
 * T-2（修正）：旧实现是**单槽位** `_pending_permission_request_id`，并发审批会
 * 覆盖掉前一个，前一个 future 只能等 120 秒超时。这里改成队列，每解决一个就
 * 出队一个。
 *
 * 与旧实现的一处**有意不同**：旧 UI 在 `always_approve` 时自己往
 * `ToolExecutor` 写 allowlist（`app.py:1489-1503`），引擎侧又写一遍。
 * 本实现的审批由 broker 统一负责（`src/app/approval-broker.ts`），
 * UI 只提交 `grantScope`——UI 侧再抄一份会形成第二份真相源
 * （`CLAUDE.md` 的"权限双写同步"正是要避免的）。因此这里只发效果。
 */
export function resolvePermission(
  state: TuiState,
  choice: 'approve' | 'always_approve' | 'deny',
): KeyResult {
  const { state: next, permission } = popPermission(state)
  if (!permission)
    return result(clearSelection({ ...next, inputPrompt: { kind: 'default' } }), true)

  const effect: TuiEffect =
    choice === 'deny'
      ? {
          kind: 'resolve-permission',
          requestId: permission.requestId,
          decision: 'deny',
          toolName: permission.toolName,
          reason: 'user denied',
        }
      : {
          kind: 'resolve-permission',
          requestId: permission.requestId,
          decision: 'allow',
          toolName: permission.toolName,
          ...(choice === 'always_approve' ? { grantScope: 'tool' as const } : {}),
          reason: choice === 'always_approve' ? 'always approved' : 'user approved',
        }

  return result(
    clearSelection({
      ...next,
      // 权限流程结束后输入框 label/placeholder 还原为默认值（`app.py:1507`）。
      inputPrompt: { kind: 'default' },
    }),
    true,
    [effect, { kind: 'render-history' }],
  )
}

// ── 问卷 ─────────────────────────────────────────────────────────

/** 把答案整理成 `answerUserInput` 需要的形状（按题下标对齐）。 */
export function answersToArray(
  questions: Questionnaire['questions'],
  answers: Readonly<Record<number, string | readonly string[]>>,
): readonly (readonly string[])[] {
  return questions.map((_, index) => {
    const answer = answers[index]
    if (answer === undefined) return []
    return typeof answer === 'string' ? [answer] : answer
  })
}

/**
 * 问卷作答（`_handle_user_input_key`，`app.py:1344-1422`）。
 *
 * T-10（修正）：多选光标纳入状态；T-13（修正）：`"> "` 标记不再作为
 * "先赋值再被覆盖"的死分支存在（标记由渲染函数按真实状态推导）。
 */
export function handleQuestionnaireKey(state: TuiState, key: KeyInput): KeyResult {
  const questionnaire = state.questionnaire
  if (!questionnaire) return result(state, false)

  const index = questionnaire.currentQuestion
  const question = questionnaire.questions[index]
  if (!question) return result(state, false)
  const options = question.options
  const multi = question.multiSelect === true

  const withQuestionnaire = (next: Questionnaire): TuiState => ({ ...state, questionnaire: next })

  // ⚠️ **没有 escape 分支**——旧实现有，但它不可达。
  //
  // 旧 `_handle_user_input_key` 开头是 `if event.key == "escape":
  // self._resolve_pending_user_input({"_cancelled": True})`，可是 `on_key` 的
  // 第 2-4 步已经把 escape **无条件 return 掉了**（流式中取消 / 双击清输入 /
  // 单击记时刻），按键永远到不了第 8 步。这与 T-1（单次 Esc 拒权限不可达）
  // 是同一类问题的**第二处**，`parts/05` §12.2 只记了前者。
  //
  // 决策：与 T-1 保持一致——**删掉死分支，保留键序**。问卷因此只能靠作答
  // （Enter / →）或超时结束，Esc 不取消。这是旧实现的可观测行为，
  // 测试里固化成 BUG-COMPAT。若将来要让它可用，正确做法是让问卷像权限弹窗
  // 那样在键序中排在 escape 之前，而不是在这里补一个永不执行的分支。

  // left → 回上一题
  if (key.name === 'left') {
    if (index === 0) return result(state, true)
    return result(withQuestionnaire({ ...questionnaire, currentQuestion: index - 1 }), true)
  }

  // right / enter → 确认当前题并前进（或收尾）
  if (key.name === 'right' || key.name === 'enter') {
    let answers = questionnaire.answers
    if (multi) {
      const selected = answers[index]
      let list: string[] = Array.isArray(selected) ? [...(selected as readonly string[])] : []
      // 一个都没选时默认选第一项（`app.py:1362-1365`）。
      if (options.length > 0 && list.length === 0) list = [options[0]?.label ?? '']
      if (list.length > 0) answers = { ...answers, [index]: list }
    } else if (options.length > 0) {
      const current = answers[index]
      const currentLabel = typeof current === 'string' ? current : undefined
      const label =
        typeof current === 'string'
          ? current
          : (options.find((option) => option.label === currentLabel)?.label ??
            options[0]?.label ??
            '')
      answers = { ...answers, [index]: label }
    }

    if (index + 1 >= questionnaire.questions.length) {
      return result({ ...clearSelection(state), questionnaire: undefined }, true, [
        {
          kind: 'answer-user-input',
          requestId: questionnaire.requestId,
          answers: answersToArray(questionnaire.questions, answers),
          reason: 'answered',
        },
        { kind: 'render-history' },
      ])
    }
    return result(
      withQuestionnaire({ ...questionnaire, answers, currentQuestion: index + 1 }),
      true,
    )
  }

  if (key.name === 'up' || key.name === 'down') {
    const direction = key.name === 'up' ? -1 : 1
    if (multi) {
      // 多选：移动**光标**，不改选中集合（T-10：光标是正式状态字段）。
      if (options.length === 0) return result(state, true)
      const cursorLabel = questionnaire.multiCursorLabel ?? options[0]?.label ?? ''
      const found = options.findIndex((option) => option.label === cursorLabel)
      const cursorIndex = found >= 0 ? found : 0
      const nextIndex = (cursorIndex + direction + options.length) % options.length
      return result(
        withQuestionnaire({
          ...questionnaire,
          multiCursorLabel: options[nextIndex]?.label ?? '',
        }),
        true,
      )
    }
    // 单选：循环移动选中项（`_navigate_single_option`，注意取模是**循环**的）。
    if (options.length === 0) return result(state, true)
    const current = questionnaire.answers[index]
    const currentLabel = typeof current === 'string' ? current : undefined
    const found = options.findIndex((option) => option.label === currentLabel)
    const currentIndex = found >= 0 ? found : direction > 0 ? 0 : -1
    const nextIndex = (currentIndex + direction + options.length) % options.length
    const label = options[nextIndex]?.label ?? ''
    return result(
      withQuestionnaire({
        ...questionnaire,
        answers: { ...questionnaire.answers, [index]: label },
      }),
      true,
    )
  }

  if (key.name === 'space') {
    if (!multi) return result(state, true)
    // 多选：切换光标项的选中状态（`_toggle_multi_select`）。
    const options2 = options
    const cursorLabel = questionnaire.multiCursorLabel ?? options2[0]?.label ?? ''
    const selected = questionnaire.answers[index]
    const list: string[] = Array.isArray(selected) ? [...(selected as readonly string[])] : []
    const found = list.indexOf(cursorLabel)
    if (found >= 0) list.splice(found, 1)
    else list.push(cursorLabel)
    return result(
      withQuestionnaire({ ...questionnaire, answers: { ...questionnaire.answers, [index]: list } }),
      true,
    )
  }

  // 其余按键被问卷吃掉：不让它们继续改输入框。
  return result(state, true)
}

// ─ 主处理器 ──────────────────────────────────────────────────────

/**
 * `on_key` 的 14 步。
 *
 * `nowMs` 必须由调用方注入（真实时钟或测试假时钟）——双击 Esc 判定依赖它，
 * 直接用 `Date.now()` 会让测试无法稳定复现。
 */
export function handleKey(state: TuiState, key: KeyInput, nowMs: number): KeyResult {
  // ── 1. shift+tab：全局最高优先级（权限弹窗打开时也生效）──
  //
  // 旧实现顺带调用 `_apply_mode_permissions()` 写 `ToolContext.permission`
  // 的四个集合。本实现**不再有那张表**：模式→工具的判定已收敛到
  // `DefaultPermissionEngine`（`progess.md` 设计约束 3："所有工具都经过统一
  // PermissionEngine"）。UI 再维护一份会立刻产生"两份表不同步"的问题，
  // 而那正是 `CLAUDE.md` 提醒的"权限双写"陷阱。这里只维护模式**序号**
  // （显示用，以及 T-6 的 `mode.change` 反应）。
  if (key.name === 'shift+tab') {
    const mode = ((state.mode + 1) % 4) as ModeIndex
    return result({ ...state, mode }, true)
  }

  // ── 2. 流式中 escape = 取消当前轮 ──
  if (key.name === 'escape' && state.streaming) {
    return result(state, true, [{ kind: 'cancel-turn', reason: 'user' }])
  }

  // ── 3/4. escape 的双击语义 ──
  if (key.name === 'escape') {
    if (state.lastEscapeAt > 0 && nowMs - state.lastEscapeAt < DOUBLE_ESCAPE_MS) {
      // 双击：**先拒绝待审批，再清输入、重置选择**——三件事都做，
      // 不是互斥分支（`app.py:605-610` 里 deny 之后没有 return）。
      const denied = resolvePermission({ ...state, lastEscapeAt: 0 }, 'deny')
      const cleared = clearSelection({
        ...denied.state,
        lastEscapeAt: 0,
        input: '',
        cursor: 0,
      })
      return result(cleared, true, denied.effects)
    }
    // 单击：只记录时刻。
    return result({ ...state, lastEscapeAt: nowMs }, true)
  }

  // ── 5/6/7. 审批挂起时的 y / a / n ──
  //
  // T-1（修正）：旧实现的第 7 步还有 `or event.key == "escape"`，但 escape 在
  // 第 2-4 步**总是提前 return**，那个分支永远不可达（`parts/05` §3.2 结论 1）。
  // 这里直接删掉，只留 `n`。可观测行为不变：Esc 拒权限仍然靠双击。
  if (state.permissionQueue.length > 0) {
    if (key.name === 'char' && key.char === 'y') return resolvePermission(state, 'approve')
    if (key.name === 'char' && key.char === 'a') return resolvePermission(state, 'always_approve')
    if (key.name === 'char' && key.char === 'n') return resolvePermission(state, 'deny')
  }

  // ─ 8. 问卷挂起 ──
  if (state.questionnaire) return handleQuestionnaireKey(state, key)

  // ── 9/10/11. 无选择项：up/down 翻输入历史，其余键放行 ──
  const items = state.selection?.items ?? []
  if (items.length === 0) {
    if (key.name === 'up') return navigatePromptHistory(state, -1)
    if (key.name === 'down') return navigatePromptHistory(state, 1)
    return result(state, false)
  }

  // ── 12/13. 有选择项：up/down 移动高亮 ──
  const selection = state.selection
  if (!selection) return result(state, false) // 不可达：items 非空必有 selection
  const selectedIndex = selectedIndexSafe(state)

  if (key.name === 'up') {
    const index = (selectedIndex - 1 + items.length) % items.length
    return result(withIndex(state, index), true)
  }
  if (key.name === 'down') {
    const index = (selectedIndex + 1) % items.length
    return result(withIndex(state, index), true)
  }

  // ── 14. tab：补全 ──
  if (key.name === 'tab') {
    if (selection.context === SelectionContext.FILE_MENTION) {
      return insertSelectedMention(state)
    }
    // ⚠️ 注意副作用：补全命令名的**同时**把 selected_index 递增——这是旧实现
    // "反复按 Tab 循环候选"的方式（`app.py:664-665`）。
    const item = items[selectedIndex]
    if (!item) return result(state, true)
    const nextIndex = (selectedIndex + 1) % items.length
    return result(
      withIndex(
        {
          ...state,
          suppressMenuUpdate: true,
          input: item.key,
          cursor: item.key.length,
        },
        nextIndex,
      ),
      true,
    )
  }

  return result(state, false)
}

// ── 内部工具 ──────────────────────────────────────────────────────

/** 选择高亮下标。旧实现把它存在 `selected_index` 上，这里挂在 selection 上。 */
function selectedIndexSafe(state: TuiState): number {
  return state.selection?.selectedIndex ?? 0
}

/** 返回"把高亮移到 index"的状态补丁。 */
function withIndex(state: TuiState, index: number): TuiState {
  const selection = state.selection
  if (!selection) return state
  return { ...state, selection: { ...selection, selectedIndex: index } }
}

/**
 * 插入选中的 `@` 提及（`_insert_selected_file_mention`）。
 *
 * 导出给 `input.ts` 的 `activateSelection`（`@` 提及菜单的 Enter 与 Tab 是
 * 同一个动作）。
 */
export function insertSelectedMention(state: TuiState): KeyResult {
  const selection = state.selection
  const span = state.activeMentionSpan
  if (!selection || !span) return result(clearSelection(state), true)
  const item = selection.items[selectedIndexSafe(state)]
  if (!item) return result(clearSelection(state), true)
  const inserted = insertMention(state.input, span, item.key)
  return result(
    clearSelection({
      ...state,
      suppressMenuUpdate: true,
      input: inserted.value,
      cursor: inserted.cursor,
      activeMentionSpan: undefined,
    }),
    true,
  )
}

/**
 * 输入历史导航（`_navigate_prompt_history`，`app.py:762-803`）。
 *
 * 四条规则逐字保留：
 * - 无历史 → 不动；
 * - 游标为 `undefined` 且向下 → 不动（首次按向下无效）；
 * - 游标为 `undefined` 且向上 → 先保存草稿，从末尾开始；
 * - 越过上界 → 恢复草稿并把游标置回 `undefined`。
 */
export function navigatePromptHistory(state: TuiState, direction: -1 | 1): KeyResult {
  const history = state.promptHistory
  if (history.length === 0) return result(state, true)
  if (state.historyIndex === undefined && direction > 0) return result(state, true)

  let index: number | undefined
  let draft = state.historyDraft
  if (state.historyIndex === undefined) {
    draft = state.input
    index = history.length - 1
  } else {
    index = state.historyIndex + direction
    if (index < 0) index = 0
    if (index >= history.length) {
      return result(
        { ...state, historyIndex: undefined, historyDraft: '', input: draft, cursor: draft.length },
        true,
      )
    }
  }

  const value = history[index] ?? ''
  return result(
    { ...state, historyIndex: index, historyDraft: draft, input: value, cursor: value.length },
    true,
  )
}

/** 记录一条输入历史（`_record_prompt_history`）。命令也记录。 */
export function recordPromptHistory(state: TuiState, prompt: string): TuiState {
  return {
    ...state,
    promptHistory: [...state.promptHistory, prompt],
    historyIndex: undefined,
    historyDraft: '',
  }
}

/** 供渲染层判断：选择项应渲染进 `#command-menu` 还是面板（`_render_selection`）。 */
export function selectionTargetsMenu(selection: Selection | undefined): boolean {
  return selection !== undefined && MENU_CONTEXTS.has(selection.context)
}

/** 输入框占位/标签的解析（T-6：按当前语言解析，切换语言即自动重绘）。 */
export function resolveInputPrompt(state: TuiState): {
  readonly label: string
  readonly placeholder: string
} {
  if (state.inputPrompt.kind === 'custom') {
    return { label: state.inputPrompt.label, placeholder: state.inputPrompt.placeholder }
  }
  if (state.inputPrompt.kind === 'permission') {
    return {
      label: translate(state.language, TKey.PERM_LABEL),
      placeholder: translate(state.language, TKey.PERM_PLACEHOLDER),
    }
  }
  return {
    label: translate(state.language, TKey.LABEL_MESSAGE),
    placeholder: translate(state.language, TKey.PLACEHOLDER_INPUT),
  }
}

/** 供 `selection` 之外的模块构造纯结果。 */
export { pure }
