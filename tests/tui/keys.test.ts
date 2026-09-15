/**
 * `on_key` 的 14 步判定顺序（`parts/05` §3.1）。
 *
 * 顺序本身就是契约，因此这里的断言是**逐条**的：既有"这一步做了什么"，
 * 也有"这一步**先于**哪一步"（例如审批挂起时 `shift+tab` 仍然生效、
 * 单次 Esc 永不拒绝权限）。
 */

import { describe, expect, it } from 'vitest'

import type { PrincipalId } from '../../src/core/ids.js'
import {
  DOUBLE_ESCAPE_MS,
  clearSelection,
  handleKey,
  handleQuestionnaireKey,
  navigatePromptHistory,
  recordPromptHistory,
  resolveInputPrompt,
  resolvePermission,
  selectionTargetsMenu,
  answersToArray,
  type KeyInput,
} from '../../src/clients/tui/keys.js'
import {
  SelectionContext,
  createInitialState,
  type PendingPermission,
  type Questionnaire,
  type Selection,
  type TuiState,
} from '../../src/clients/tui/types.js'
import type { AskUserQuestion } from '../../src/core/input.js'

const NOW = 1_000_000

function state(overrides: Partial<TuiState> = {}): TuiState {
  return { ...createInitialState({ principalId: 'principal-1' as PrincipalId }), ...overrides }
}

function key(name: KeyInput['name'], char?: string): KeyInput {
  return char === undefined ? { name } : { name, char }
}

function permission(requestId = 'req-1', toolName = 'file_write'): PendingPermission {
  return {
    requestId,
    toolName,
    riskLevel: 'high',
    argsPreview: '{"path":"a"}',
    reason: 'needs approval',
    expiresAt: NOW + 120_000,
  }
}

function selection(context: SelectionContext = SelectionContext.MAIN): Selection {
  return {
    context,
    title: 'Commands',
    header: '',
    footer: 'footer',
    items: [
      { key: '/workwith', title: '/workwith', description: '为下一项任务指定模型' },
      { key: '/clear', title: '/clear', description: '清空会话' },
    ],
    selectedIndex: 0,
  }
}

function question(multiSelect = false): AskUserQuestion {
  return {
    question: '选哪个？',
    header: 'Choice',
    options: [
      { label: 'a', description: 'first' },
      { label: 'b', description: 'second' },
      { label: 'c', description: 'third' },
    ],
    ...(multiSelect ? { multiSelect: true } : {}),
  }
}

function questionnaire(overrides: Partial<Questionnaire> = {}): Questionnaire {
  return {
    requestId: 'q-1',
    questions: [question()],
    currentQuestion: 0,
    answers: {},
    multiCursorLabel: undefined,
    ...overrides,
  }
}

describe('第 1 步：shift+tab 是最高优先级', () => {
  it('按顺序循环 0 → 1 → 2 → 3 → 0', () => {
    let current = state()
    const seen: number[] = []
    for (let index = 0; index < 5; index += 1) {
      const result = handleKey(current, key('shift+tab'), NOW)
      current = result.state
      seen.push(current.mode)
    }
    expect(seen).toEqual([1, 2, 3, 0, 1])
  })

  it('审批弹窗打开时仍然生效（排在权限判断之前）', () => {
    const result = handleKey(state({ permissionQueue: [permission()] }), key('shift+tab'), NOW)
    expect(result.handled).toBe(true)
    expect(result.state.mode).toBe(1)
    // 权限队列不受影响
    expect(result.state.permissionQueue).toHaveLength(1)
    expect(result.effects).toEqual([])
  })

  it('问卷挂起时仍然生效', () => {
    const result = handleKey(state({ questionnaire: questionnaire() }), key('shift+tab'), NOW)
    expect(result.state.mode).toBe(1)
  })
})

describe('第 2-4 步：escape', () => {
  it('流式中 Esc = 取消当前轮（不是清输入框）', () => {
    const result = handleKey(state({ streaming: true, input: 'draft' }), key('escape'), NOW)
    expect(result.effects).toEqual([{ kind: 'cancel-turn', reason: 'user' }])
    expect(result.state.input).toBe('draft')
    expect(result.state.lastEscapeAt).toBe(0)
  })

  it('单次 Esc 只记录时刻，什么都不做', () => {
    const result = handleKey(state({ input: 'draft' }), key('escape'), NOW)
    expect(result.handled).toBe(true)
    expect(result.state.input).toBe('draft')
    expect(result.state.lastEscapeAt).toBe(NOW)
    expect(result.effects).toEqual([])
  })

  it('双击 Esc（<0.5s）清空输入并重置选择', () => {
    const result = handleKey(
      state({ lastEscapeAt: NOW - 100, input: 'draft', cursor: 5, selection: selection() }),
      key('escape'),
      NOW,
    )
    expect(result.state.input).toBe('')
    expect(result.state.cursor).toBe(0)
    expect(result.state.selection).toBeUndefined()
    expect(result.state.activeMentionSpan).toBeUndefined()
    expect(result.state.lastEscapeAt).toBe(0)
  })

  it('间隔超过时间窗不算双击', () => {
    const result = handleKey(
      state({ lastEscapeAt: NOW - DOUBLE_ESCAPE_MS - 1, input: 'draft' }),
      key('escape'),
      NOW,
    )
    expect(result.state.input).toBe('draft')
    expect(result.state.lastEscapeAt).toBe(NOW)
  })

  it('双击 Esc 同时拒绝待审批（清输入之前先出队）', () => {
    const result = handleKey(
      state({ lastEscapeAt: NOW - 10, input: 'draft', permissionQueue: [permission('req-9')] }),
      key('escape'),
      NOW,
    )
    expect(result.state.permissionQueue).toEqual([])
    expect(result.state.input).toBe('')
    expect(result.effects[0]).toEqual({
      kind: 'resolve-permission',
      requestId: 'req-9',
      decision: 'deny',
      toolName: 'file_write',
      reason: 'user denied',
    })
  })
})

describe('第 5-7 步：审批挂起时的 y / a / n', () => {
  it('y → allow（不带 grantScope）', () => {
    const result = handleKey(state({ permissionQueue: [permission('r1')] }), key('char', 'y'), NOW)
    expect(result.effects[0]).toEqual({
      kind: 'resolve-permission',
      requestId: 'r1',
      decision: 'allow',
      toolName: 'file_write',
      reason: 'user approved',
    })
    expect(result.state.permissionQueue).toEqual([])
    expect(result.state.inputPrompt).toEqual({ kind: 'default' })
  })

  it('a → allow 且带 tool 范围的 grantScope', () => {
    const result = handleKey(state({ permissionQueue: [permission('r2')] }), key('char', 'a'), NOW)
    expect(result.effects[0]).toMatchObject({
      kind: 'resolve-permission',
      requestId: 'r2',
      decision: 'allow',
      grantScope: 'tool',
    })
  })

  it('n → deny', () => {
    const result = handleKey(state({ permissionQueue: [permission('r3')] }), key('char', 'n'), NOW)
    expect(result.effects[0]).toMatchObject({ decision: 'deny', requestId: 'r3' })
  })

  it('T-1：单次 Esc 永远不会拒绝权限（死分支已删除）', () => {
    const first = handleKey(state({ permissionQueue: [permission('r4')] }), key('escape'), NOW)
    expect(first.state.permissionQueue).toHaveLength(1)
    expect(first.effects).toEqual([])
    // 第二次才拒绝（双击语义）
    const second = handleKey(first.state, key('escape'), NOW + 50)
    expect(second.state.permissionQueue).toEqual([])
    expect(second.effects[0]).toMatchObject({ decision: 'deny' })
  })

  it('y/a/n 之外的键在审批挂起时不被应用层接管（继续走后面的步骤）', () => {
    const result = handleKey(state({ permissionQueue: [permission()] }), key('char', 'x'), NOW)
    expect(result.handled).toBe(false)
    expect(result.state.permissionQueue).toHaveLength(1)
  })

  it('T-2：审批是队列，逐个解决', () => {
    let current = state({ permissionQueue: [permission('r1'), permission('r2')] })
    const first = handleKey(current, key('char', 'y'), NOW)
    expect(first.state.permissionQueue.map((p) => p.requestId)).toEqual(['r2'])
    current = first.state
    const second = handleKey(current, key('char', 'n'), NOW)
    expect(second.state.permissionQueue).toEqual([])
    expect(second.effects[0]).toMatchObject({ requestId: 'r2', decision: 'deny' })
  })
})

describe('第 8 步：问卷', () => {
  it('up/down 在单选下循环移动选中项', () => {
    const start = state({ questionnaire: questionnaire() })
    const down = handleKey(start, key('down'), NOW)
    expect(down.state.questionnaire?.answers[0]).toBe('b')
    const up = handleKey(down.state, key('up'), NOW)
    expect(up.state.questionnaire?.answers[0]).toBe('a')
    // 从 'a' 再往上 → 循环到 'c'
    const wrap = handleKey(up.state, key('up'), NOW)
    expect(wrap.state.questionnaire?.answers[0]).toBe('c')
  })

  it('enter 在最后一题作答并回灌答案', () => {
    const result = handleKey(
      state({ questionnaire: questionnaire({ answers: { 0: 'b' } }) }),
      key('enter'),
      NOW,
    )
    expect(result.state.questionnaire).toBeUndefined()
    expect(result.effects[0]).toEqual({
      kind: 'answer-user-input',
      requestId: 'q-1',
      answers: [['b']],
      reason: 'answered',
    })
  })

  // BUG-COMPAT：旧实现的"问卷 Esc 取消"分支**不可达**（escape 被 on_key 的
  // 第 2-4 步无条件吃掉），与 T-1 同类。这里固化旧行为：Esc 既不取消问卷，
  // 也不作答——它走的是通用的"单击记时刻 / 双击清输入"语义。
  it('BUG-COMPAT：Esc 不取消问卷（该分支在旧实现中不可达）', () => {
    const single = handleKey(state({ questionnaire: questionnaire() }), key('escape'), NOW)
    expect(single.state.questionnaire).not.toBeUndefined()
    expect(single.effects).toEqual([])
    expect(single.state.lastEscapeAt).toBe(NOW)

    const double = handleKey(single.state, key('escape'), NOW + 50)
    expect(double.state.questionnaire).not.toBeUndefined()
    expect(double.effects).toEqual([])
  })

  it('多选：space 切换选中集，up/down 只移动光标（T-10）', () => {
    const start = state({
      questionnaire: questionnaire({
        questions: [question(true)],
        multiCursorLabel: 'a',
      }),
    })
    const toggled = handleKey(start, key('space'), NOW)
    expect(toggled.state.questionnaire?.answers[0]).toEqual(['a'])

    const moved = handleKey(toggled.state, key('down'), NOW)
    expect(moved.state.questionnaire?.multiCursorLabel).toBe('b')
    // 移动光标**不改**选中集
    expect(moved.state.questionnaire?.answers[0]).toEqual(['a'])

    const toggled2 = handleKey(moved.state, key('space'), NOW)
    expect(toggled2.state.questionnaire?.answers[0]).toEqual(['a', 'b'])
  })

  it('多选 enter 在没选任何项时默认选第一项', () => {
    const result = handleKey(
      state({ questionnaire: questionnaire({ questions: [question(true)] }) }),
      key('enter'),
      NOW,
    )
    expect(result.effects[0]).toMatchObject({ answers: [['a']] })
  })

  it('left 回上一题，right 前进', () => {
    const two = questionnaire({ questions: [question(), question()], currentQuestion: 1 })
    const back = handleKey(state({ questionnaire: two }), key('left'), NOW)
    expect(back.state.questionnaire?.currentQuestion).toBe(0)
    const forward = handleKey(state({ questionnaire: two }), key('right'), NOW)
    // 最后一题 → 直接收尾
    expect(forward.state.questionnaire).toBeUndefined()
  })

  it('多题问卷按顺序收集答案（按下标对齐）', () => {
    let current = state({ questionnaire: questionnaire({ questions: [question(), question()] }) })
    current = handleKey(current, key('enter'), NOW).state // 第 1 题 → 默认 a
    current = handleKey(current, key('down'), NOW).state // 第 2 题 → b
    const done = handleKey(current, key('enter'), NOW)
    expect(done.state.questionnaire).toBeUndefined()
    expect(done.effects[0]).toMatchObject({ answers: [['a'], ['b']] })
  })

  it('问卷吃掉未识别的按键（不让它改输入框）', () => {
    const result = handleKey(state({ questionnaire: questionnaire() }), key('char', 'x'), NOW)
    expect(result.handled).toBe(true)
    expect(result.state.input).toBe('')
  })

  it('问卷状态里没有问题时不做任何事（handleQuestionnaireKey 防御）', () => {
    const result = handleQuestionnaireKey(
      state({ questionnaire: questionnaire({ questions: [], currentQuestion: 0 }) }),
      key('enter'),
    )
    expect(result.handled).toBe(false)
  })

  it('answersToArray 把单选字符串与多选数组统一成数组', () => {
    const questions = [question(), question(true)]
    expect(answersToArray(questions, { 0: 'a', 1: ['b', 'c'] })).toEqual([['a'], ['b', 'c']])
    expect(answersToArray(questions, {})).toEqual([[], []])
  })
})

describe('第 9-11 步：无选择项时 up/down 翻输入历史', () => {
  const withHistory = state({
    promptHistory: ['first', 'second'],
    input: 'draft',
  })

  it('无历史时 up/down 不动', () => {
    const result = handleKey(state({ input: 'x' }), key('up'), NOW)
    expect(result.state.input).toBe('x')
  })

  it('首次 down 无效（游标为 None 且向下）', () => {
    const result = handleKey(withHistory, key('down'), NOW)
    expect(result.state.input).toBe('draft')
    expect(result.state.historyIndex).toBeUndefined()
  })

  it('首次 up 保存草稿并从末尾开始', () => {
    const result = handleKey(withHistory, key('up'), NOW)
    expect(result.state.input).toBe('second')
    expect(result.state.historyDraft).toBe('draft')
    expect(result.state.historyIndex).toBe(1)
  })

  it('继续 up 到下界后钳在 0', () => {
    let current = handleKey(withHistory, key('up'), NOW).state
    current = handleKey(current, key('up'), NOW).state
    expect(current.input).toBe('first')
    current = handleKey(current, key('up'), NOW).state
    expect(current.input).toBe('first')
    expect(current.historyIndex).toBe(0)
  })

  it('越过上界恢复草稿并重置游标', () => {
    let current = handleKey(withHistory, key('up'), NOW).state
    current = handleKey(current, key('down'), NOW).state
    expect(current.input).toBe('draft')
    expect(current.historyIndex).toBeUndefined()
  })

  it('光标落在补全文本末尾', () => {
    const result = handleKey(withHistory, key('up'), NOW)
    expect(result.state.cursor).toBe('second'.length)
  })

  it('第 11 步：其余键不被接管（放行给输入框）', () => {
    const result = handleKey(state(), key('char', 'a'), NOW)
    expect(result.handled).toBe(false)
    expect(result.state.input).toBe('')
  })

  it('recordPromptHistory 追加并重置游标（命令也记）', () => {
    const recorded = recordPromptHistory(state({ promptHistory: ['a'] }), '/not-a-command')
    expect(recorded.promptHistory).toEqual(['a', '/not-a-command'])
    expect(recorded.historyIndex).toBeUndefined()
  })

  it('navigatePromptHistory 可单独调用', () => {
    const result = navigatePromptHistory(state({ promptHistory: ['x'], input: '' }), -1)
    expect(result.state.input).toBe('x')
  })
})

describe('第 12-14 步：有选择项时移动与补全', () => {
  it('up/down 循环移动高亮', () => {
    const start = state({ selection: selection() })
    const down = handleKey(start, key('down'), NOW)
    expect(down.state.selection?.selectedIndex).toBe(1)
    const wrap = handleKey(down.state, key('down'), NOW)
    expect(wrap.state.selection?.selectedIndex).toBe(0)
    const up = handleKey(wrap.state, key('up'), NOW)
    expect(up.state.selection?.selectedIndex).toBe(1)
  })

  it('tab 补全命令名，同时把高亮推进一位（旧实现的副作用）', () => {
    const result = handleKey(state({ selection: selection() }), key('tab'), NOW)
    expect(result.state.input).toBe('/workwith')
    expect(result.state.cursor).toBe('/workwith'.length)
    expect(result.state.selection?.selectedIndex).toBe(1)
    expect(result.state.suppressMenuUpdate).toBe(true)
  })

  it('tab 在 file_mention 语境下插入路径（与 Enter 相同）', () => {
    const fileSelection: Selection = {
      ...selection(SelectionContext.FILE_MENTION),
      items: [{ key: 'src/app.ts', title: 'src/app.ts', description: 'file' }],
    }
    const result = handleKey(
      state({
        selection: fileSelection,
        activeMentionSpan: { start: 4, end: 8, query: 'app' },
        input: 'fix @app',
        cursor: 8,
      }),
      key('tab'),
      NOW,
    )
    expect(result.state.input).toBe('fix src/app.ts ')
    expect(result.state.selection).toBeUndefined()
    expect(result.state.activeMentionSpan).toBeUndefined()
    expect(result.state.suppressMenuUpdate).toBe(true)
  })

  it('mention 区间缺失时清空选择而不是猜测位置', () => {
    const fileSelection: Selection = {
      ...selection(SelectionContext.FILE_MENTION),
      items: [{ key: 'a.ts', title: 'a.ts', description: 'file' }],
    }
    const result = handleKey(state({ selection: fileSelection, input: 'x' }), key('tab'), NOW)
    expect(result.state.input).toBe('x')
    expect(result.state.selection).toBeUndefined()
  })

  it('有选择项时其余键不被接管', () => {
    const result = handleKey(state({ selection: selection() }), key('char', 'x'), NOW)
    expect(result.handled).toBe(false)
  })
})

describe('辅助函数', () => {
  it('clearSelection 同时清掉提及区间', () => {
    const cleared = clearSelection(
      state({ selection: selection(), activeMentionSpan: { start: 0, end: 1, query: '' } }),
    )
    expect(cleared.selection).toBeUndefined()
    expect(cleared.activeMentionSpan).toBeUndefined()
  })

  it('resolvePermission 在无待审批时也返回已处理（清输入框提示）', () => {
    const result = resolvePermission(state({ inputPrompt: { kind: 'permission' } }), 'approve')
    expect(result.handled).toBe(true)
    expect(result.effects).toEqual([])
    expect(result.state.inputPrompt).toEqual({ kind: 'default' })
  })

  it('selectionTargetsMenu 只认三个菜单语境（其余走面板）', () => {
    expect(selectionTargetsMenu(selection(SelectionContext.MAIN))).toBe(true)
    expect(selectionTargetsMenu(selection(SelectionContext.FILE_MENTION))).toBe(true)
    expect(selectionTargetsMenu(selection(SelectionContext.PERMISSION_REQUEST))).toBe(true)
    expect(selectionTargetsMenu(selection(SelectionContext.SESSION_SELECT))).toBe(false)
    expect(selectionTargetsMenu(undefined)).toBe(false)
  })

  it('resolveInputPrompt 按当前语言解析（T-6：切换语言即重绘）', () => {
    const en = resolveInputPrompt(state({ language: 'en' }))
    const zh = resolveInputPrompt(state({ language: 'zh' }))
    expect(en.label).toBe('Message')
    expect(zh.label).toBe('消息')
    expect(zh.placeholder).not.toBe(en.placeholder)
  })

  it('resolveInputPrompt 在权限语境下给出审批文案', () => {
    const resolved = resolveInputPrompt(state({ inputPrompt: { kind: 'permission' } }))
    expect(resolved.label).toBe('Permission required')
    expect(resolved.placeholder).toBe('Press Enter to approve, n to deny')
  })

  it('resolveInputPrompt 支持自定义文案（表单路径的形态）', () => {
    const resolved = resolveInputPrompt(
      state({ inputPrompt: { kind: 'custom', label: 'L', placeholder: 'P' } }),
    )
    expect(resolved).toEqual({ label: 'L', placeholder: 'P' })
  })
})
