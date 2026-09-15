/**
 * 消息格式化（`message_utils.py` 的移植）与面板/菜单/待办渲染。
 *
 * 断言的是**逐字**的输出形状：这些字符串直接决定用户看到什么，
 * 也决定权限提示、思考预览、工具结果截断是否与旧实现一致。
 */

import { describe, expect, it } from 'vitest'

import type { Message } from '../../src/core/models.js'
import {
  MAX_RESULT_CHARS,
  MAX_RESULT_LINES,
  formatMessageDisplay,
  formatResultContent,
  messageToDisplay,
  renderPanelText,
  renderSelectionText,
  renderTodoPanel,
} from '../../src/clients/tui/format.js'
import type { Selection } from '../../src/clients/tui/types.js'

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: 'm1' as Message['id'],
    conversation_id: 'c1' as Message['conversation_id'],
    role: 'assistant',
    content: 'plain text',
    created_at: '2026-09-15T00:00:00.000Z',
    turn_id: 'turn_1_c1' as Message['turn_id'],
    subtype: 'normal',
    tool_call_id: null,
    meta: '{}',
    agent_type: '',
    ...overrides,
  }
}

describe('messageToDisplay', () => {
  it('纯文本原样返回', () => {
    expect(messageToDisplay(message({ content: 'hello' }))).toBe('hello')
  })

  it('非法 JSON 也不抛错', () => {
    expect(messageToDisplay(message({ content: '{not json' }))).toBe('{not json')
  })

  it('assistant 的 content block 数组：thinking 预览截断到 200 字符', () => {
    const blocks = JSON.stringify([
      { type: 'thinking', thinking: 'a'.repeat(250), signature: '' },
      { type: 'text', text: 'final answer' },
    ])
    const display = messageToDisplay(message({ content: blocks }))
    expect(display).toContain(' **thinking**')
    expect(display).toContain(`${'a'.repeat(200)}...`)
    expect(display).not.toContain('a'.repeat(201))
    expect(display).toContain('final answer')
  })

  it('短思考不加省略号', () => {
    const blocks = JSON.stringify([{ type: 'thinking', thinking: 'short', signature: '' }])
    expect(messageToDisplay(message({ content: blocks }))).toContain('```\nshort\n```')
  })

  it('tool_use block 渲染工具名与参数', () => {
    const blocks = JSON.stringify([
      { type: 'tool_use', id: 't1', name: 'file_read', input: { path: 'a.ts' } },
    ])
    const display = messageToDisplay(message({ content: blocks }))
    expect(display).toContain(' **file_read**')
    expect(display).toContain('- **path**: `a.ts`')
  })

  it('长参数或多行参数改用代码块并截断到 500 字符', () => {
    const blocks = JSON.stringify([
      {
        type: 'tool_use',
        id: 't1',
        name: 'bash',
        input: { command: 'x'.repeat(600) },
      },
    ])
    const display = messageToDisplay(message({ content: blocks }))
    expect(display).toContain('- **command**:\n```')
    expect(display).toContain(`${'x'.repeat(500)}...`)
  })

  it('参数里的非字符串类型按 JSON 字面量渲染', () => {
    const blocks = JSON.stringify([
      {
        type: 'tool_use',
        id: 't1',
        name: 'x',
        input: { flag: true, count: 3, nothing: null, list: [1, 2] },
      },
    ])
    const display = messageToDisplay(message({ content: blocks }))
    expect(display).toContain('- **flag**: `true`')
    expect(display).toContain('- **count**: `3`')
    expect(display).toContain('- **nothing**: `null`')
    expect(display).toContain('- **list**: `[1,2]`')
  })

  it('compact_boundary 渲染压缩前后 token', () => {
    const content = JSON.stringify({
      type: 'compact_boundary',
      tokens_before: 120_000,
      tokens_after: 30_000,
      strategy: 'preflight',
    })
    const display = messageToDisplay(message({ content }))
    expect(display).toContain('📦 **Conversation Compacted** (preflight)')
    expect(display).toContain('120K → 30K tokens')
  })

  it('compact_summary 渲染摘要', () => {
    const display = messageToDisplay(
      message({ content: JSON.stringify({ type: 'compact_summary', summary: 'earlier stuff' }) }),
    )
    expect(display).toContain('📋 **Summary of earlier conversation:**')
    expect(display).toContain('earlier stuff')
  })

  it('permission_event 三类事件的文案', () => {
    const created = messageToDisplay(
      message({
        content: JSON.stringify({
          event: 'permission_request_created',
          tool_name: 'file_write',
          risk_level: 'high',
        }),
      }),
    )
    expect(created).toBe('\n\n🔐 **file_write** — permission required [high]')

    expect(
      messageToDisplay(
        message({
          content: JSON.stringify({
            event: 'permission_request_resolved',
            tool_name: 'file_write',
            resolution: 'approved',
          }),
        }),
      ),
    ).toContain('permission approved')

    expect(
      messageToDisplay(
        message({
          content: JSON.stringify({
            event: 'permission_request_resolved',
            tool_name: 'file_write',
            resolution: 'timeout',
          }),
        }),
      ),
    ).toContain('permission timed out')

    // 未识别的 resolution 也要有输出
    expect(
      messageToDisplay(
        message({
          content: JSON.stringify({
            event: 'permission_request_resolved',
            tool_name: 't',
            resolution: 'weird',
          }),
        }),
      ),
    ).toContain('permission weird')

    // 执行成功不额外渲染（紧随其后的工具结果消息会说明）
    expect(
      messageToDisplay(
        message({
          content: JSON.stringify({
            event: 'permission_effect_applied',
            tool_name: 't',
            outcome: 'executed',
          }),
        }),
      ),
    ).toBe('')

    expect(
      messageToDisplay(
        message({
          content: JSON.stringify({
            event: 'permission_effect_applied',
            tool_name: 't',
            outcome: 'failed',
          }),
        }),
      ),
    ).toContain('execution failed')
  })

  it('skill 事件：无 applied_skills 时不渲染', () => {
    expect(
      messageToDisplay(message({ content: JSON.stringify({ event: 'skill.resolve.complete' }) })),
    ).toBe('')
  })

  it('skill 事件：有技能时渲染引用与细节', () => {
    const display = messageToDisplay(
      message({
        content: JSON.stringify({
          event: 'skill.resolve.complete',
          applied_skills: ['safe-edit@1.0.0'],
          confidence: 0.9,
          active_phase: 'planning',
          guards_applied: [{}, {}],
        }),
      }),
    )
    expect(display).toContain(' **Loaded Skill** `safe-edit@1.0.0`')
    expect(display).toContain('confidence: `0.9`')
    expect(display).toContain('phase: `planning`')
    expect(display).toContain('guards: `2`')
  })

  it('tool_result：按 meta 渲染状态行', () => {
    const display = messageToDisplay(
      message({
        role: 'tool',
        content: JSON.stringify({ tool_use_id: 't1', content: 'done' }),
        meta: JSON.stringify({ tool_name: 'file_read', ok: true }),
      }),
    )
    expect(display).toContain('✅ **file_read**')
  })

  it('tool_result：失败时带 error_code', () => {
    const display = messageToDisplay(
      message({
        role: 'tool',
        content: JSON.stringify({ tool_use_id: 't1', content: 'nope' }),
        meta: JSON.stringify({ tool_name: 'bash', ok: false, error_code: 'PERMISSION_DENIED' }),
      }),
    )
    expect(display).toContain('❌ **bash** — `PERMISSION_DENIED`')
  })

  it('tool_result：meta 非法时默认成功', () => {
    const display = messageToDisplay(
      message({
        role: 'tool',
        content: JSON.stringify({ tool_use_id: 't1', content: 'x' }),
        meta: '{bad',
      }),
    )
    expect(display).toContain('✅')
  })
})

describe('formatResultContent', () => {
  it('空内容渲染 (empty)', () => {
    expect(formatResultContent('   ')).toBe('```\n(empty)\n```')
  })

  it('普通文本放在无语言标注的代码块里', () => {
    expect(formatResultContent('line1\nline2')).toBe('```\nline1\nline2\n```')
  })

  it('JSON 被美化并标注 json', () => {
    expect(formatResultContent('{"a":1}')).toBe('```json\n{\n  "a": 1\n}\n```')
  })

  it(`超过 ${MAX_RESULT_CHARS} 字符时截断`, () => {
    const long = 'x'.repeat(MAX_RESULT_CHARS + 100)
    const rendered = formatResultContent(long)
    expect(rendered).toContain('... [truncated]')
    expect(rendered).not.toContain('x'.repeat(MAX_RESULT_CHARS + 1))
  })

  it(`超过 ${MAX_RESULT_LINES} 行时折叠并报出剩余行数`, () => {
    const lines = Array.from({ length: 30 }, (_, index) => `line${index}`).join('\n')
    const rendered = formatResultContent(lines)
    expect(rendered).toContain('line0')
    expect(rendered).toContain(`... (${30 - MAX_RESULT_LINES} more lines, collapsed)`)
    expect(rendered).not.toContain('line29')
  })
})

describe('formatMessageDisplay', () => {
  it('四类角色各有标签', () => {
    expect(formatMessageDisplay(message({ role: 'user', content: 'hi' }), 'en')).toBe(
      '**You**\n\nhi',
    )
    expect(formatMessageDisplay(message({ role: 'assistant', content: 'hi' }), 'en')).toBe(
      '**Assistant**\n\nhi',
    )
    expect(formatMessageDisplay(message({ role: 'tool', content: 'hi' }), 'en')).toBe(
      '**Tool**\n\nhi',
    )
    expect(formatMessageDisplay(message({ role: 'system', content: 'hi' }), 'en')).toBe(
      '**System**\n\nhi',
    )
  })

  it('角色标签随语言变化', () => {
    expect(formatMessageDisplay(message({ role: 'user', content: 'hi' }), 'zh')).toBe(
      '**你**\n\nhi',
    )
  })
})

describe('renderSelectionText', () => {
  const selection: Selection = {
    context: 'main',
    title: 'Commands',
    header: '',
    footer: 'Use ↑/↓ to select.',
    items: [
      { key: '/a', title: '/a', description: 'first' },
      { key: '/b', title: '/b', description: 'second' },
    ],
    selectedIndex: 1,
  }

  it('指针指向高亮项，描述缩进 4 空格另起一行', () => {
    expect(renderSelectionText(selection, 1)).toBe(
      ['Commands', '  1. /a\n    first', '> 2. /b\n    second', 'Use ↑/↓ to select.'].join('\n'),
    )
  })

  it('title 行只在 items 非空时出现（无匹配时保留语境但不显示标题）', () => {
    const empty = { ...selection, items: [] }
    expect(renderSelectionText(empty, 0)).toBe('Use ↑/↓ to select.')
  })

  it('header 在 title 之前，footer 在最后', () => {
    const withHeader = { ...selection, header: 'HEADER' }
    const rendered = renderSelectionText(withHeader, 0)
    expect(rendered.startsWith('HEADER\nCommands')).toBe(true)
    expect(rendered.endsWith('Use ↑/↓ to select.')).toBe(true)
  })

  it('无 header/footer 时不产生空行', () => {
    const bare = { ...selection, header: '', footer: '' }
    expect(renderSelectionText(bare, 0)).toBe(
      ['Commands', '> 1. /a\n    first', '  2. /b\n    second'].join('\n'),
    )
  })
})

describe('renderPanelText', () => {
  it('标题前加 "## "，空行分隔', () => {
    expect(renderPanelText({ title: 'Compact', body: 'done' })).toBe('## Compact\n\ndone')
  })
})

describe('renderTodoPanel', () => {
  it('标记与颜色按状态映射', () => {
    const rendered = renderTodoPanel(
      [
        { content: 'a', status: 'completed' },
        { content: 'b', status: 'in_progress' },
        { content: 'c', status: 'pending' },
      ],
      'en',
    )
    expect(rendered.rows.map((row) => row.marker)).toEqual(['✓', '▸', '○'])
    expect(rendered.rows.map((row) => row.color)).toEqual(['#4ade80', '#fbbf24', '#555566'])
    expect(rendered.visible).toBe(true)
  })

  it('未知状态回退到 ○', () => {
    const rendered = renderTodoPanel([{ content: 'x', status: 'weird' }], 'en')
    expect(rendered.rows[0]?.marker).toBe('○')
  })

  it('摘要只列出非零的段，用 " · " 连接', () => {
    const rendered = renderTodoPanel(
      [
        { content: 'a', status: 'completed' },
        { content: 'b', status: 'completed' },
        { content: 'c', status: 'pending' },
      ],
      'en',
    )
    expect(rendered.summary).toBe('2 done · 1 pending')
  })

  it('摘要随语言变化', () => {
    const rendered = renderTodoPanel([{ content: 'a', status: 'in_progress' }], 'zh')
    expect(rendered.summary).toBe('1 进行中')
  })

  it('空列表 → 面板不显示', () => {
    expect(renderTodoPanel([], 'en').visible).toBe(false)
  })
})
