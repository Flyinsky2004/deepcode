/**
 * `message-converter` 的角色/内容判别测试。
 *
 * 这个模块决定"磁盘上的消息"如何变成"发给模型的 `ApiMessage`"。它同时是
 * 协议合法性的最后一道兜底：`content` 是多态字符串（纯文本 / block 数组 /
 * 对象），判别错一次就会把非法请求体发给 provider。
 *
 * 因此这里逐分支覆盖三类判别：
 * 1. **不该送模型的**（permission/skill/command 审计、compact 元数据、system 消息）；
 * 2. **block 数组的逐块校验**（含 thinking 的 signature、tool_use 的 input 形状）；
 * 3. **角色交替修复**（`sanitizeApiMessages`，崩溃/取消留下的连续 user）。
 */
import { describe, expect, it } from 'vitest'

import { MessageRole, MessageSubtype, type Message } from '../../src/core/models.js'
import type { ApiMessage } from '../../src/core/provider.js'
import {
  messageToApiFormat,
  message_to_api_format,
  sanitizeApiMessages,
  sanitize_api_messages,
} from '../../src/storage/message-converter.js'

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-1' as Message['id'],
    conversation_id: 'session-1',
    role: MessageRole.USER,
    content: 'hello',
    created_at: '2026-01-01T00:00:00.000Z',
    turn_id: '',
    subtype: MessageSubtype.NORMAL,
    tool_call_id: null,
    meta: '{}',
    agent_type: '',
    ...overrides,
  } as Message
}

const blocks = (value: unknown): string => JSON.stringify(value)

describe('messageToApiFormat：不进入模型请求的消息', () => {
  it.each([
    MessageSubtype.PERMISSION_EVENT,
    MessageSubtype.SKILL_EVENT,
    MessageSubtype.COMMAND_EVENT,
  ])('审计类子类型 %s 返回 null', (subtype) => {
    expect(messageToApiFormat(message({ subtype }))).toBeNull()
  })

  it('compact 边界元数据返回 null（它划定范围，本身不是模型输入）', () => {
    expect(
      messageToApiFormat(
        message({
          subtype: MessageSubtype.COMPACT_BOUNDARY,
          content: blocks({ type: 'compact_boundary', boundary_id: 'b1' }),
        }),
      ),
    ).toBeNull()
  })

  it('compact 摘要返回 null（摘要改由 ContextEnvelope.system 承载，避免重复注入）', () => {
    expect(
      messageToApiFormat(
        message({
          subtype: MessageSubtype.COMPACT_SUMMARY,
          role: MessageRole.SYSTEM,
          content: blocks({ type: 'compact_summary', summary: 's', summarized_count: 3 }),
        }),
      ),
    ).toBeNull()
  })

  it('system 角色的普通消息返回 null（系统提示只存在于 envelope.system）', () => {
    expect(
      messageToApiFormat(message({ role: MessageRole.SYSTEM, content: '系统提示' })),
    ).toBeNull()
  })
})

describe('messageToApiFormat：纯文本消息', () => {
  it('user 保持 user，assistant 保持 assistant，tool 收敛为 user', () => {
    expect(messageToApiFormat(message({ content: 'hi' }))).toEqual({ role: 'user', content: 'hi' })
    expect(messageToApiFormat(message({ role: MessageRole.ASSISTANT, content: 'ok' }))).toEqual({
      role: 'assistant',
      content: 'ok',
    })
    // tool 结果在 Anthropic 协议里必须挂成 user 消息，不能有第三种角色
    expect(messageToApiFormat(message({ role: MessageRole.TOOL, content: 'out' }))).toEqual({
      role: 'user',
      content: 'out',
    })
  })

  it('非 JSON 文本走 catch 分支原样保留（历史脏数据不能被丢弃）', () => {
    expect(messageToApiFormat(message({ content: '不是 JSON {{{' }))).toEqual({
      role: 'user',
      content: '不是 JSON {{{',
    })
  })

  it('JSON 标量（数字/字符串/null）不是数组也不是对象，回退为纯文本', () => {
    expect(messageToApiFormat(message({ content: '123' }))?.content).toBe('123')
    expect(messageToApiFormat(message({ content: '"带引号"' }))?.content).toBe('"带引号"')
    expect(messageToApiFormat(message({ content: 'null' }))?.content).toBe('null')
  })

  it('无法识别 type 的 JSON 对象回退为纯文本（不猜、不改写）', () => {
    expect(messageToApiFormat(message({ content: blocks({ type: 'unknown_thing' }) }))).toEqual({
      role: 'user',
      content: blocks({ type: 'unknown_thing' }),
    })
  })
})

describe('messageToApiFormat：工具结果对象', () => {
  it('带 tool_use_id 的对象转成 tool_result block（角色固定 user）', () => {
    expect(
      messageToApiFormat(
        message({
          role: MessageRole.TOOL,
          subtype: MessageSubtype.TOOL_RESULT,
          content: blocks({ tool_use_id: 'tc-1', content: '结果' }),
        }),
      ),
    ).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tc-1', content: '结果' }],
    })
  })

  it('tool_result 内容不是字符串时降级为空串（协议要求 string）', () => {
    const converted = messageToApiFormat(
      message({ content: blocks({ tool_use_id: 'tc-1', content: { nested: true } }) }),
    )
    expect(converted?.content).toEqual([{ type: 'tool_result', tool_use_id: 'tc-1', content: '' }])
  })

  it('tool_use_id 不是字符串时强转为字符串（不因脏数据整条丢弃）', () => {
    const converted = messageToApiFormat(message({ content: blocks({ tool_use_id: 7 }) }))
    expect(converted?.content).toEqual([{ type: 'tool_result', tool_use_id: '7', content: '' }])
  })
})

describe('messageToApiFormat：block 数组的逐块校验', () => {
  it('接受 text / thinking / tool_use / tool_result 四类合法块', () => {
    const content = [
      { type: 'text', text: 'hi' },
      { type: 'thinking', thinking: '想', signature: 'sig' },
      { type: 'tool_use', id: 'tc-1', name: 'bash', input: { command: 'ls' } },
      { type: 'tool_result', tool_use_id: 'tc-1', content: 'out' },
    ]
    expect(
      messageToApiFormat(
        message({
          role: MessageRole.ASSISTANT,
          subtype: MessageSubtype.TOOL_CALL,
          content: blocks(content),
        }),
      ),
    ).toEqual({ role: 'assistant', content })
  })

  it('任何一块非法就整条作废（宁可丢弃也不发非法请求体）', () => {
    const content = [
      { type: 'text', text: 'hi' },
      { type: 'text', text: 42 },
    ]
    expect(messageToApiFormat(message({ content: blocks(content) }))).toBeNull()
  })

  it.each([
    ['非对象元素', [null]],
    ['数组元素', [[]]],
    ['字符串元素', ['text']],
    ['未知 type', [{ type: 'image', source: {} }]],
    ['text 缺少 text 字段', [{ type: 'text' }]],
    ['thinking 缺少 signature', [{ type: 'thinking', thinking: 'x' }]],
    ['thinking 的 signature 非字符串', [{ type: 'thinking', thinking: 'x', signature: 1 }]],
    ['tool_use 缺少 id', [{ type: 'tool_use', name: 'bash', input: {} }]],
    ['tool_use 的 input 为 null', [{ type: 'tool_use', id: 'a', name: 'b', input: null }]],
    ['tool_use 的 input 是数组', [{ type: 'tool_use', id: 'a', name: 'b', input: [] }]],
    ['tool_use 的 input 是空串', [{ type: 'tool_use', id: 'a', name: 'b', input: '' }]],
    ['tool_result 缺少 content', [{ type: 'tool_result', tool_use_id: 'a' }]],
  ])('%s 导致整条消息被丢弃', (_name, content) => {
    expect(messageToApiFormat(message({ content: blocks(content) }))).toBeNull()
  })

  it('空数组目前会产出 content 为空的 ApiMessage（可疑，保留现状）', () => {
    // 分析：`blocks.length !== parsed.length` 对空数组同样成立（0 === 0），
    // 于是返回 `{ content: [] }`。Anthropic 协议要求 content 非空，
    // 但该形态只能由磁盘上出现 `"[]"` 的消息产生，正常写入路径不会生成它，
    // 因此保守地固化现状、交由裁决（未修改实现）。
    expect(messageToApiFormat(message({ content: '[]' }))).toEqual({ role: 'user', content: [] })
  })
})

describe('snake_case 别名与 camelCase 同源', () => {
  it('规格里保留的别名指向同一实现', () => {
    expect(message_to_api_format).toBe(messageToApiFormat)
    expect(sanitize_api_messages).toBe(sanitizeApiMessages)
  })
})

describe('sanitizeApiMessages：角色交替修复', () => {
  it('空列表原样返回（返回同一引用，调用方无需判断）', () => {
    const empty: readonly ApiMessage[] = []
    expect(sanitizeApiMessages(empty)).toBe(empty)
  })

  it('已合法的 user/assistant 交替不被改动', () => {
    const input: ApiMessage[] = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' },
    ]
    expect(sanitizeApiMessages(input)).toEqual(input)
  })

  it('连续两条纯文本 user 之间插入 [Interrupted] 占位助手消息', () => {
    const repaired = sanitizeApiMessages([
      { role: 'user', content: 'one' },
      { role: 'user', content: 'two' },
    ])
    expect(repaired).toEqual([
      { role: 'user', content: 'one' },
      { role: 'assistant', content: '[Interrupted]' },
      { role: 'user', content: 'two' },
    ])
  })

  it('连续两条 tool_result user 消息合并成一条（并行工具调用的正常形态）', () => {
    const repaired = sanitizeApiMessages([
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: '1' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b', content: '2' }] },
    ])
    expect(repaired).toHaveLength(1)
    expect(repaired[0]?.content).toEqual([
      { type: 'tool_result', tool_use_id: 'a', content: '1' },
      { type: 'tool_result', tool_use_id: 'b', content: '2' },
    ])
  })

  it('其中一条是空 block 数组时不合并，插入占位助手消息', () => {
    const repaired = sanitizeApiMessages([
      { role: 'user', content: [] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b', content: '2' }] },
    ])
    expect(repaired.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
  })

  it('block 里混有非 tool_result 块时不合并（合并会改变语义）', () => {
    const repaired = sanitizeApiMessages([
      { role: 'user', content: [{ type: 'text', text: 'x' }] },
      { role: 'user', content: [{ type: 'text', text: 'y' }] },
    ])
    expect(repaired.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
  })

  it('一条是数组、另一条是字符串时不合并（类型不同，无法拼接）', () => {
    const repaired = sanitizeApiMessages([
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: '1' }] },
      { role: 'user', content: 'plain' },
    ])
    expect(repaired.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
  })

  it('连续三条 user 逐对修复（修复后的 assistant 会阻断后续合并）', () => {
    const repaired = sanitizeApiMessages([
      { role: 'user', content: 'one' },
      { role: 'user', content: 'two' },
      { role: 'user', content: 'three' },
    ])
    expect(repaired.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user'])
  })

  it('不修改传入数组（纯函数，不可变约定）', () => {
    const input: ApiMessage[] = [
      { role: 'user', content: 'one' },
      { role: 'user', content: 'two' },
    ]
    const snapshot = structuredClone(input)
    sanitizeApiMessages(input)
    expect(input).toEqual(snapshot)
  })

  it('合并结果覆盖原位置而不是追加，保持消息顺序', () => {
    const repaired = sanitizeApiMessages([
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: '1' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b', content: '2' }] },
      { role: 'assistant', content: 'after' },
    ])
    expect(repaired.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(repaired[1]?.content).toBe('after')
  })
})
