/**
 * 输入框三层：文本编辑器、`on_input_changed`（6 步）、`on_input_submitted`（11 步）。
 */

import { describe, expect, it } from 'vitest'

import type { PrincipalId } from '../../src/core/ids.js'
import {
  activateSelection,
  applyInputChanged,
  editInputValue,
  isPrintable,
  showCommandMenu,
  showFileMentionMenu,
  submitInput,
  type CommandEntry,
} from '../../src/clients/tui/input.js'
import { createInitialState, SelectionContext, type TuiState } from '../../src/clients/tui/types.js'
import type { KeyInput } from '../../src/clients/tui/keys.js'

const COMMANDS: readonly CommandEntry[] = [
  { name: 'workwith', description: '为下一项任务指定 provider/model' },
  { name: 'clear', description: '清空会话' },
]

function state(overrides: Partial<TuiState> = {}): TuiState {
  return { ...createInitialState({ principalId: 'p' as PrincipalId }), ...overrides }
}

function key(name: KeyInput['name'], char?: string): KeyInput {
  return char === undefined ? { name } : { name, char }
}

describe('editInputValue', () => {
  it('可打印字符插入到光标处', () => {
    expect(editInputValue('ac', 1, key('char', 'b'))).toEqual({
      value: 'abc',
      cursor: 2,
      changed: true,
    })
  })

  it('空格键在普通输入框中插入空格', () => {
    expect(editInputValue('/languagezh', 9, key('space'))).toEqual({
      value: '/language zh',
      cursor: 10,
      changed: true,
    })
  })

  it('退格删除光标前的字符', () => {
    expect(editInputValue('abc', 2, key('backspace'))).toEqual({
      value: 'ac',
      cursor: 1,
      changed: true,
    })
  })

  it('退格在行首无效', () => {
    expect(editInputValue('abc', 0, key('backspace'))).toEqual({
      value: 'abc',
      cursor: 0,
      changed: false,
    })
  })

  it('delete 删除光标处的字符', () => {
    expect(editInputValue('abc', 1, key('delete'))).toEqual({
      value: 'ac',
      cursor: 1,
      changed: true,
    })
  })

  it('delete 在行尾无效', () => {
    expect(editInputValue('abc', 3, key('delete')).changed).toBe(false)
  })

  it('左右移动光标（值不变）', () => {
    expect(editInputValue('abc', 1, key('left'))).toEqual({
      value: 'abc',
      cursor: 0,
      changed: false,
    })
    expect(editInputValue('abc', 1, key('right'))).toEqual({
      value: 'abc',
      cursor: 2,
      changed: false,
    })
    expect(editInputValue('abc', 0, key('left')).cursor).toBe(0)
    expect(editInputValue('abc', 3, key('right')).cursor).toBe(3)
  })

  it('home / end', () => {
    expect(editInputValue('abc', 2, key('home')).cursor).toBe(0)
    expect(editInputValue('abc', 1, key('end')).cursor).toBe(3)
  })

  it('光标越界被钳位', () => {
    expect(editInputValue('abc', 99, key('char', 'x')).value).toBe('abcx')
    expect(editInputValue('abc', -3, key('char', 'x')).value).toBe('xabc')
  })

  it('控制字符不插入', () => {
    expect(editInputValue('a', 1, key('char', '')).changed).toBe(false)
  })

  it('未识别的按键不改变任何东西', () => {
    expect(editInputValue('abc', 1, key('up'))).toEqual({ value: 'abc', cursor: 1, changed: false })
  })
})

describe('isPrintable', () => {
  it('普通字符可打印', () => {
    expect(isPrintable('a')).toBe(true)
    expect(isPrintable('你')).toBe(true)
    expect(isPrintable(' ')).toBe(true)
  })

  it('C0 控制字符与 DEL 不可打印', () => {
    expect(isPrintable('\u0000')).toBe(false)
    expect(isPrintable('\u001b')).toBe(false)
    expect(isPrintable('\n')).toBe(false)
    expect(isPrintable('\u007f')).toBe(false)
  })

  it('空串不可打印', () => {
    expect(isPrintable('')).toBe(false)
  })
})

describe('showCommandMenu：大小写敏感的前缀匹配', () => {
  it('前缀匹配，不是模糊匹配', () => {
    const menu = showCommandMenu(state(), '/wo', COMMANDS)
    expect(menu.selection?.items.map((item) => item.key)).toEqual(['/workwith'])
  })

  it('/c 只匹配 clear', () => {
    expect(showCommandMenu(state(), '/c', COMMANDS).selection?.items.map((i) => i.key)).toEqual([
      '/clear',
    ])
  })

  it('/C 不匹配 /clear（大小写敏感）', () => {
    const menu = showCommandMenu(state(), '/C', COMMANDS)
    expect(menu.selection).toBeUndefined()
    expect(menu.menuNotice).toBe('No matching commands')
  })

  it('无匹配时清空选择项但给出提示（up/down 因此退回输入历史）', () => {
    const menu = showCommandMenu(state(), '/zzz', COMMANDS)
    expect(menu.selection).toBeUndefined()
    expect(menu.menuNotice).toBeTruthy()
  })

  it('未带前导 / 也按命令处理', () => {
    expect(showCommandMenu(state(), 'wo', COMMANDS).selection?.items).toHaveLength(1)
  })

  it('菜单文本使用 i18n 标题与页脚，并带语境', () => {
    const menu = showCommandMenu(state({ language: 'zh' }), '/w', COMMANDS)
    expect(menu.selection).toMatchObject({
      context: SelectionContext.MAIN,
      title: '命令',
      selectedIndex: 0,
    })
  })
})

describe('applyInputChanged（on_input_changed 的 6 步）', () => {
  const ctx = { commands: COMMANDS, workspaceRoot: '/no/such/workspace' }

  it('1. suppressMenuUpdate 消费一次事件后复位', () => {
    const suppressed = state({ suppressMenuUpdate: true, selection: undefined })
    const next = applyInputChanged(suppressed, ctx)
    expect(next.suppressMenuUpdate).toBe(false)
    expect(next.selection).toBeUndefined()
  })

  it('3. 权限挂起时不弹菜单', () => {
    const withPermission = state({
      input: '/w',
      permissionQueue: [
        {
          requestId: 'r',
          toolName: 't',
          riskLevel: 'low',
          argsPreview: '',
          reason: '',
          expiresAt: 0,
        },
      ],
    })
    expect(applyInputChanged(withPermission, ctx).selection).toBeUndefined()
  })

  it('4. 以 / 开头（strip 后）弹命令菜单', () => {
    expect(applyInputChanged(state({ input: '  /w' }), ctx).selection?.context).toBe(
      SelectionContext.MAIN,
    )
  })

  it('4. 命令菜单会清掉提及区间', () => {
    const next = applyInputChanged(
      state({ input: '/w', activeMentionSpan: { start: 0, end: 1, query: '' } }),
      ctx,
    )
    expect(next.activeMentionSpan).toBeUndefined()
  })

  it('5. 无 @ 时关菜单并清掉 main/file_mention 语境', () => {
    const next = applyInputChanged(
      state({
        input: 'plain text',
        selection: {
          context: SelectionContext.MAIN,
          title: 't',
          header: '',
          footer: '',
          items: [{ key: '/a', title: '/a', description: '' }],
          selectedIndex: 0,
        },
      }),
      ctx,
    )
    expect(next.selection).toBeUndefined()
  })

  it('5. 其他语境（session_select）不被关菜单误清', () => {
    const sessionSelection = {
      context: SelectionContext.SESSION_SELECT,
      title: 't',
      header: '',
      footer: '',
      items: [],
      selectedIndex: 0,
    }
    const next = applyInputChanged(state({ input: 'plain', selection: sessionSelection }), ctx)
    expect(next.selection).toEqual(sessionSelection)
  })
})

describe('showFileMentionMenu', () => {
  it('没有活跃 @ 时返回 active=false', () => {
    const result = showFileMentionMenu(state({ input: 'no mention' }), 'no mention', 10, '/tmp')
    expect(result.active).toBe(false)
    expect(result.state.activeMentionSpan).toBeUndefined()
  })

  it('工作区不存在时给出无匹配提示（仍算 active）', () => {
    const result = showFileMentionMenu(state({ input: '@x' }), '@x', 2, '/no/such/workspace')
    expect(result.active).toBe(true)
    expect(result.state.selection).toMatchObject({
      context: SelectionContext.FILE_MENTION,
      items: [],
    })
    expect(result.state.menuNotice).toContain('@x')
  })
})

describe('activateSelection 的语境分派', () => {
  function withSelection(context: SelectionContext, keyValue: string): TuiState {
    return state({
      input: 'draft',
      // 审批语境下必须有挂起的请求，否则决议无处可提交（那正是 T-2 的行为）。
      ...(context === SelectionContext.PERMISSION_REQUEST
        ? {
            permissionQueue: [
              {
                requestId: 'req-1',
                toolName: 'file_write',
                riskLevel: 'high' as const,
                argsPreview: '',
                reason: '',
                expiresAt: 0,
              },
            ],
          }
        : {}),
      selection: {
        context,
        title: 't',
        header: '',
        footer: '',
        items: [{ key: keyValue, title: keyValue, description: '' }],
        selectedIndex: 0,
      },
    })
  }

  it('main → 执行命令并清空输入', () => {
    const result = activateSelection(withSelection(SelectionContext.MAIN, '/clear'))
    expect(result.effects).toEqual([{ kind: 'run-command', raw: '/clear' }])
    expect(result.state.input).toBe('')
    expect(result.state.selection).toBeUndefined()
  })

  it('permission_request → 提交审批决议', () => {
    const result = activateSelection(withSelection(SelectionContext.PERMISSION_REQUEST, 'approve'))
    expect(result.effects[0]).toMatchObject({
      kind: 'resolve-permission',
      decision: 'allow',
      requestId: 'req-1',
    })
  })

  it('permission_request → always_approve 带 grantScope', () => {
    const result = activateSelection(
      withSelection(SelectionContext.PERMISSION_REQUEST, 'always_approve'),
    )
    expect(result.effects[0]).toMatchObject({ decision: 'allow', grantScope: 'tool' })
  })

  it('permission_request → deny', () => {
    const result = activateSelection(withSelection(SelectionContext.PERMISSION_REQUEST, 'deny'))
    expect(result.effects[0]).toMatchObject({ decision: 'deny' })
  })

  it('session_select → 切换会话并重绘', () => {
    const result = activateSelection(withSelection(SelectionContext.SESSION_SELECT, 'sess-9'))
    expect(result.effects).toEqual([
      { kind: 'select-session', sessionId: 'sess-9' },
      { kind: 'render-history' },
    ])
  })

  it('没有选择项时什么都不做', () => {
    expect(activateSelection(state()).effects).toEqual([])
  })

  it('高亮越界时什么都不做（防御）', () => {
    const outOfRange = withSelection(SelectionContext.MAIN, '/clear')
    const broken = { ...outOfRange, selection: { ...outOfRange.selection!, selectedIndex: 5 } }
    expect(activateSelection(broken).effects).toEqual([])
  })
})

describe('submitInput（on_input_submitted 的 11 步）', () => {
  const ctx = { commands: COMMANDS }

  it('3. file_mention 有候选时 Enter 插入路径', () => {
    const fileState = state({
      input: 'fix @app',
      cursor: 8,
      activeMentionSpan: { start: 4, end: 8, query: 'app' },
      selection: {
        context: SelectionContext.FILE_MENTION,
        title: 't',
        header: '',
        footer: '',
        items: [{ key: 'src/app.ts', title: 'src/app.ts', description: 'file' }],
        selectedIndex: 0,
      },
    })
    const result = submitInput(fileState, ctx)
    expect(result.state.input).toBe('fix src/app.ts ')
    expect(result.effects).toEqual([])
  })

  it('4. 带参数的命令直接执行，不被菜单拦截', () => {
    const menuState = state({
      input: '/workwith provider/model do the thing',
      selection: {
        context: SelectionContext.MAIN,
        title: 't',
        header: '',
        footer: '',
        items: [{ key: '/clear', title: '/clear', description: '' }],
        selectedIndex: 0,
      },
    })
    const result = submitInput(menuState, ctx)
    expect(result.effects).toEqual([
      { kind: 'run-command', raw: '/workwith provider/model do the thing' },
    ])
    expect(result.state.input).toBe('')
  })

  it('5. 权限挂起时 Enter = 激活当前选中项', () => {
    const permissionState = state({
      input: '',
      permissionQueue: [
        {
          requestId: 'r1',
          toolName: 't',
          riskLevel: 'low',
          argsPreview: '',
          reason: '',
          expiresAt: 0,
        },
      ],
      selection: {
        context: SelectionContext.PERMISSION_REQUEST,
        title: 't',
        header: '',
        footer: '',
        items: [
          { key: 'approve', title: 'Approve', description: '' },
          { key: 'deny', title: 'Deny', description: '' },
        ],
        selectedIndex: 0,
      },
    })
    const result = submitInput(permissionState, ctx)
    expect(result.effects[0]).toMatchObject({ kind: 'resolve-permission', requestId: 'r1' })
  })

  it('6. 菜单打开且输入为空时 Enter 激活选中项', () => {
    const menuState = state({
      input: '',
      selection: {
        context: SelectionContext.MAIN,
        title: 't',
        header: '',
        footer: '',
        items: [{ key: '/clear', title: '/clear', description: '' }],
        selectedIndex: 0,
      },
    })
    expect(submitInput(menuState, ctx).effects).toEqual([{ kind: 'run-command', raw: '/clear' }])
  })

  it('7. 空输入什么都不做', () => {
    expect(submitInput(state({ input: '   ' }), ctx)).toMatchObject({ effects: [] })
  })

  it('8. 流式中提交 = 暂存 + 取消（打断重提）', () => {
    const result = submitInput(state({ input: 'new question', streaming: true }), ctx)
    expect(result.state.pendingPrompt).toBe('new question')
    expect(result.state.input).toBe('')
    expect(result.effects).toEqual([{ kind: 'cancel-turn', reason: 'user' }])
  })

  it('9. 斜杠命令走命令层', () => {
    const result = submitInput(state({ input: '/clear' }), ctx)
    expect(result.effects).toEqual([{ kind: 'run-command', raw: '/clear' }])
  })

  it('10/11. 普通消息提交并清空输入', () => {
    const result = submitInput(state({ input: '  explain this  ' }), ctx)
    // 只发 submit-prompt：控制器自己会刷新历史，多一条 render-history
    // 会把提交失败写下的 lastError/notice 清掉（见 input.ts 的说明）。
    expect(result.effects).toEqual([{ kind: 'submit-prompt', prompt: 'explain this' }])
    expect(result.state.input).toBe('')
    expect(result.state.cursor).toBe(0)
    expect(result.state.selection).toBeUndefined()
  })

  it('普通消息提交时清掉提及区间与菜单提示', () => {
    const result = submitInput(
      state({
        input: 'hi',
        activeMentionSpan: { start: 0, end: 1, query: '' },
        menuNotice: 'notice',
      }),
      ctx,
    )
    expect(result.state.activeMentionSpan).toBeUndefined()
    expect(result.state.menuNotice).toBeUndefined()
  })

  it('提交前后的菜单收起标记被复位', () => {
    const result = submitInput(state({ input: 'hi', suppressMenuUpdate: true }), ctx)
    expect(result.state.suppressMenuUpdate).toBe(false)
  })
})
