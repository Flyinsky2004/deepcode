import { describe, expect, it } from 'vitest'

import { createMessageId, createSessionId } from '../../src/core/ids.js'
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_REASONING_EFFORT,
  MESSAGE_ROLES,
  MessageRole,
  MessageSubtype,
  NEW_CONVERSATION_DEFAULTS,
  REASONING_EFFORTS,
  SCHEMA_VERSION,
  WRITABLE_MESSAGE_SUBTYPES,
  isAssistantBlockArray,
  isReasoningEffort,
  type AssistantContentBlock,
  type Message,
} from '../../src/core/models.js'

describe('MessageRole', () => {
  it('4 个角色，与旧实现一致', () => {
    expect(Object.values(MessageRole).sort()).toEqual(['assistant', 'system', 'tool', 'user'])
  })

  it('MESSAGE_ROLES 与枚举同步，用于边界校验', () => {
    expect([...MESSAGE_ROLES].sort()).toEqual(Object.values(MessageRole).sort())
  })
})

describe('MessageSubtype', () => {
  it('8 个 subtype，含压缩两类', () => {
    expect(Object.values(MessageSubtype).sort()).toEqual([
      'compact_boundary',
      'compact_summary',
      'interrupted',
      'normal',
      'permission_event',
      'skill_event',
      'tool_call',
      'tool_result',
    ])
  })

  it('写入集合覆盖全部 8 个（本实现写入正确的 compact subtype）', () => {
    // 旧实现写入 compact 消息时漏传 subtype，导致磁盘上落成 "normal"，
    // 检测只能依赖 content.type。本实现写入正确的 subtype。
    expect(WRITABLE_MESSAGE_SUBTYPES.has(MessageSubtype.COMPACT_BOUNDARY)).toBe(true)
    expect(WRITABLE_MESSAGE_SUBTYPES.has(MessageSubtype.COMPACT_SUMMARY)).toBe(true)
    expect(WRITABLE_MESSAGE_SUBTYPES.size).toBe(8)
  })
})

describe('Message 形状', () => {
  it('content 与 meta 都是字符串（双重编码是刻意设计）', () => {
    const message: Message = {
      id: createMessageId(),
      conversation_id: createSessionId(),
      role: MessageRole.ASSISTANT,
      content: JSON.stringify([{ type: 'text', text: 'hi' }]),
      created_at: '2026-09-14T02:39:11.123Z',
      turn_id: '',
      subtype: MessageSubtype.NORMAL,
      tool_call_id: null,
      meta: '{}',
      agent_type: '',
    }

    expect(typeof message.content).toBe('string')
    expect(typeof message.meta).toBe('string')
    expect(JSON.parse(message.content)).toBeInstanceOf(Array)
  })

  it('tool_call_id 是唯一的可空字段之一', () => {
    const base = {
      id: createMessageId(),
      conversation_id: createSessionId(),
      role: MessageRole.TOOL,
      content: '{}',
      created_at: '2026-09-14T02:39:11.123Z',
      turn_id: '',
      subtype: MessageSubtype.TOOL_RESULT,
      meta: '{}',
      agent_type: '',
    }

    expect({ ...base, tool_call_id: null }).toMatchObject({ tool_call_id: null })
    expect({ ...base, tool_call_id: 'toolu_1' }).toMatchObject({ tool_call_id: 'toolu_1' })
  })
})

describe('isAssistantBlockArray', () => {
  it('识别合法的 block 数组', () => {
    const blocks: readonly AssistantContentBlock[] = [
      { type: 'thinking', thinking: '想一下', signature: 'sig' },
      { type: 'text', text: '回复' },
      { type: 'tool_use', id: 'toolu_1', name: 'file_read', input: { path: 'a.ts' } },
    ]
    expect(isAssistantBlockArray(blocks)).toBe(true)
  })

  it('空数组视为合法（无内容的助手消息）', () => {
    expect(isAssistantBlockArray([])).toBe(true)
  })

  it('拒绝非数组', () => {
    expect(isAssistantBlockArray('text')).toBe(false)
    expect(isAssistantBlockArray({ type: 'text', text: 'x' })).toBe(false)
    expect(isAssistantBlockArray(null)).toBe(false)
  })

  it('拒绝含未知块的数组（工具结果对象不应被误判为助手块）', () => {
    expect(isAssistantBlockArray([{ type: 'tool_result', tool_use_id: 'x' }])).toBe(false)
    expect(isAssistantBlockArray([{ type: 'text', text: 'ok' }, { foo: 1 }])).toBe(false)
  })

  it('拒绝元素为 null / 非对象', () => {
    expect(isAssistantBlockArray([null])).toBe(false)
    expect(isAssistantBlockArray(['text'])).toBe(false)
    expect(isAssistantBlockArray([42])).toBe(false)
  })
})

describe('推理强度', () => {
  it('3 档', () => {
    expect([...REASONING_EFFORTS]).toEqual(['low', 'medium', 'high'])
  })

  it('默认 high，与旧实现一致', () => {
    expect(DEFAULT_REASONING_EFFORT).toBe('high')
  })

  it('isReasoningEffort 正确收窄', () => {
    expect(isReasoningEffort('high')).toBe(true)
    expect(isReasoningEffort('medium')).toBe(true)
    expect(isReasoningEffort('ultra')).toBe(false)
    expect(isReasoningEffort(undefined)).toBe(false)
    expect(isReasoningEffort(1)).toBe(false)
  })
})

describe('默认值', () => {
  it('schema 版本为 1', () => {
    expect(SCHEMA_VERSION).toBe(1)
  })

  it('上下文窗口默认 125000（与旧实现一致）', () => {
    expect(DEFAULT_CONTEXT_WINDOW).toBe(125_000)
  })

  it('最大输出 token 统一为 128000 —— 即旧实现实际落盘的值', () => {
    // 旧实现在五处用了两个不同的默认值（384000 / 128000），
    // 但归一化总是先填 128000，所以 384000 分支不可达。
    expect(DEFAULT_MAX_OUTPUT_TOKENS).toBe(128_000)
  })

  it('新会话默认状态为 active 且无父会话', () => {
    expect(NEW_CONVERSATION_DEFAULTS.status).toBe('active')
    expect(NEW_CONVERSATION_DEFAULTS.parent_conversation_id).toBe('')
    expect(NEW_CONVERSATION_DEFAULTS.agent_type).toBe('')
    expect(NEW_CONVERSATION_DEFAULTS.current_turn).toBe(0)
  })

  it('新会话默认不含 id/title/时间戳（由调用方提供）', () => {
    expect(Object.keys(NEW_CONVERSATION_DEFAULTS).sort()).toEqual([
      'agent_type',
      'compacted_message_count',
      'current_turn',
      'last_input_tokens',
      'parent_conversation_id',
      'status',
      'total_output_tokens',
    ])
  })
})
