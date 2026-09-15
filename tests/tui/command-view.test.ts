/**
 * `CommandResult` → 界面意图的映射（命令层与 UI 之间的窄协议）。
 *
 * 这是纯函数，所以每条分支都能直接断言——包括"注册表认识但不可用"这一类，
 * 它在端到端测试里需要构造命令才能触发。
 */

import { describe, expect, it } from 'vitest'

import { CommandResultCode, type CommandResult } from '../../src/commands/types.js'
import { commandNameOf, commandViewOf } from '../../src/clients/tui/command-view.js'

function view(result: CommandResult, known = true, raw = '/cmd') {
  return commandViewOf({ raw, result, known, language: 'en' })
}

describe('commandNameOf', () => {
  it('去掉前导 / 与参数', () => {
    expect(commandNameOf('/workwith a/b do it')).toBe('workwith')
    expect(commandNameOf('/clear')).toBe('clear')
    expect(commandNameOf('  /model  use  ')).toBe('model')
  })
})

describe('data.kind 约定的界面意图', () => {
  it('switch_session → 切会话，文本随行', () => {
    expect(
      view({
        ok: true,
        code: CommandResultCode.OK,
        text: '已开始新会话',
        data: { kind: 'switch_session', sessionId: 's1' },
      }),
    ).toEqual({ kind: 'switch-session', sessionId: 's1', text: '已开始新会话' })
  })

  it('set_language → 换语言', () => {
    expect(
      view({
        ok: true,
        code: CommandResultCode.OK,
        text: '界面语言已切换为 zh',
        data: { kind: 'set_language', language: 'zh' },
      }),
    ).toEqual({ kind: 'set-language', language: 'zh', text: '界面语言已切换为 zh' })
  })

  it('session_select → 选择列表（会话语境、i18n 标题、轮次作副标题）', () => {
    const mapped = view({
      ok: true,
      code: CommandResultCode.SELECTION,
      text: '标题一（2 轮）',
      data: {
        kind: 'session_select',
        sessions: [
          { id: 's1', title: '标题一', current_turn: 2, agent_type: 'main' },
          { id: 's2', title: '标题二', current_turn: 'x' },
        ],
      },
    })
    expect(mapped.kind).toBe('selection')
    if (mapped.kind !== 'selection') throw new Error('unreachable')
    expect(mapped.selection.context).toBe('session_select')
    expect(mapped.selection.title).toBe('Session history')
    expect(mapped.selection.footer).toContain('Enter')
    expect(mapped.selection.items).toEqual([
      { key: 's1', title: '标题一', description: '2' },
      // 非法轮次按 0，不显示 "undefined"
      { key: 's2', title: '标题二', description: '0' },
    ])
  })

  it('sessions 不是数组时给出空列表而不是崩溃', () => {
    const mapped = view({
      ok: true,
      code: CommandResultCode.SELECTION,
      text: 'x',
      data: { kind: 'session_select', sessions: 'nope' },
    })
    if (mapped.kind !== 'selection') throw new Error('unreachable')
    expect(mapped.selection.items).toEqual([])
  })

  it('ok 但 kind 未知时退化为文本输出', () => {
    expect(
      view({ ok: true, code: CommandResultCode.OK, text: 'hi', data: { kind: 'something_else' } }),
    ).toEqual({ kind: 'text', text: 'hi' })
  })

  it('失败的命令即使带 kind 也不走界面意图', () => {
    expect(
      view({
        ok: false,
        code: CommandResultCode.FAILED,
        text: 'boom',
        data: { kind: 'switch_session', sessionId: 's1' },
      }),
    ).toEqual({ kind: 'panel', title: '/cmd', body: 'boom' })
  })
})

describe('通用选择列表（旧形状 data.items）', () => {
  it('按 data.items 构造，语境取 data.context', () => {
    const mapped = view(
      {
        ok: true,
        code: CommandResultCode.SELECTION,
        text: 'Pick one',
        data: {
          context: 'file_mention',
          items: [{ key: 'a.ts', title: 'a.ts', description: 'file' }],
        },
      },
      true,
    )
    if (mapped.kind !== 'selection') throw new Error('unreachable')
    expect(mapped.selection.context).toBe('file_mention')
    expect(mapped.selection.title).toBe('Pick one')
    expect(mapped.selection.items).toEqual([{ key: 'a.ts', title: 'a.ts', description: 'file' }])
  })

  it('非字符串字段一律当空串', () => {
    const mapped = view({
      ok: true,
      code: CommandResultCode.SELECTION,
      text: 'x',
      data: { items: [{ key: 1, title: null, description: {} }] },
    })
    if (mapped.kind !== 'selection') throw new Error('unreachable')
    expect(mapped.selection.items[0]).toEqual({ key: '', title: '', description: '' })
  })
})

describe('面板', () => {
  it('标题是命令名，正文优先取 data.body', () => {
    expect(
      view({
        ok: true,
        code: CommandResultCode.PANEL,
        text: '短文本',
        data: { body: '长正文' },
      }),
    ).toEqual({ kind: 'panel', title: '/cmd', body: '长正文' })
  })

  it('没有 data.body 时用 text 兜底', () => {
    expect(view({ ok: true, code: CommandResultCode.PANEL, text: '当前档位分配：…' })).toEqual({
      kind: 'panel',
      title: '/cmd',
      body: '当前档位分配：…',
    })
  })
})

describe('失败分流：未知命令 vs 存在但不可用', () => {
  it('注册表认识 → 标题是命令名，正文照实显示（诚实降级）', () => {
    expect(
      view(
        {
          ok: false,
          code: CommandResultCode.NOT_AVAILABLE,
          text: '/mcp 依赖的「MCP」子系统尚未实现（Phase 10）。',
        },
        true,
        '/mcp',
      ),
    ).toEqual({
      kind: 'panel',
      title: '/mcp',
      body: '/mcp 依赖的「MCP」子系统尚未实现（Phase 10）。',
    })
  })

  it('注册表不认识 → 标题是"未知命令"', () => {
    expect(
      view(
        { ok: false, code: CommandResultCode.NOT_AVAILABLE, text: '未知命令：/nope' },
        false,
        '/nope',
      ),
    ).toEqual({ kind: 'panel', title: 'Unknown command', body: '未知命令：/nope' })
  })

  it('参数非法 / 会话忙 / 权限不足同样走"命令名"面板', () => {
    for (const code of [
      CommandResultCode.INVALID_ARGUMENTS,
      CommandResultCode.SESSION_BUSY,
      CommandResultCode.PERMISSION_DENIED,
      CommandResultCode.FAILED,
    ] as const)
      expect(view({ ok: false, code, text: '原因' })).toEqual({
        kind: 'panel',
        title: '/cmd',
        body: '原因',
      })
  })

  it('未知命令的标题随语言变化', () => {
    expect(
      commandViewOf({
        raw: '/nope',
        result: { ok: false, code: CommandResultCode.NOT_AVAILABLE, text: 'x' },
        known: false,
        language: 'zh',
      }),
    ).toMatchObject({ title: '未知命令' })
  })
})

describe('成功但无要求', () => {
  it('ok 且无 data → 文本输出', () => {
    expect(view({ ok: true, code: CommandResultCode.OK, text: 'done' })).toEqual({
      kind: 'text',
      text: 'done',
    })
  })
})
