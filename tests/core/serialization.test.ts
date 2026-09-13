/**
 * 序列化往返测试。
 *
 * progess.md Phase 0 验收要求：「所有公共协议都有单元测试和**序列化测试**」。
 *
 * 为什么单独一个文件而不是散在各模块测试里：持久化实体的往返是**跨模块契约**
 * （`models` + `ids` + `time` + `tool` + `turn`），散开测会漏掉组合问题。
 * 且往返测试的价值在于"逐字段不丢失"，集中在一处更容易核对完整性。
 */

import { describe, expect, it } from 'vitest'

import {
  createMessageId,
  createSessionId,
  createToolCallId,
  createTurnId,
} from '../../src/core/ids.js'
import {
  MessageRole,
  MessageSubtype,
  type Message,
  type Conversation,
} from '../../src/core/models.js'
import { PermissionRequestStatus, RiskLevel, type PermissionRequest } from '../../src/core/tool.js'
import { TurnStatus, TerminalReason, type TurnResult } from '../../src/core/turn.js'

/** 断言 JSON 往返后逐字段完全相等。 */
function expectRoundTrip<T>(value: T): T {
  const json = JSON.stringify(value)
  const back = JSON.parse(json) as T
  expect(back).toEqual(value)
  return back
}

/** 一份具有代表性的消息（覆盖全部字段，含非空可空字段）。 */
function sampleMessage(): Message {
  const sessionId = createSessionId()
  return {
    id: createMessageId(),
    conversation_id: sessionId,
    role: MessageRole.ASSISTANT,
    content: JSON.stringify([
      { type: 'thinking', thinking: '想一下', signature: 'sig-abc' },
      { type: 'text', text: '我来查看文件。' },
      { type: 'tool_use', id: 'toolu_01ABC', name: 'file_read', input: { path: 'src/a.ts' } },
    ]),
    created_at: '2026-09-14T02:39:11.123Z',
    turn_id: createTurnId(sessionId, 3),
    subtype: MessageSubtype.TOOL_CALL,
    tool_call_id: null,
    meta: '{}',
    agent_type: '',
  }
}

describe('Message 往返', () => {
  it('逐字段不丢失', () => {
    const message = sampleMessage()
    const back = expectRoundTrip(message)

    expect(back.id).toBe(message.id)
    expect(back.conversation_id).toBe(message.conversation_id)
    expect(back.role).toBe('assistant')
    expect(back.content).toBe(message.content)
    expect(back.created_at).toBe('2026-09-14T02:39:11.123Z')
    expect(back.turn_id).toBe(message.turn_id)
    expect(back.subtype).toBe('tool_call')
    expect(back.tool_call_id).toBeNull()
    expect(back.meta).toBe('{}')
    expect(back.agent_type).toBe('')
  })

  it('content 与 meta 往返后仍是字符串（双重编码不得被破坏）', () => {
    const back = expectRoundTrip(sampleMessage())
    expect(typeof back.content).toBe('string')
    expect(typeof back.meta).toBe('string')

    // 且字符串内的 JSON 仍可解析回结构
    const blocks = JSON.parse(back.content) as { type: string }[]
    expect(blocks.map((b) => b.type)).toEqual(['thinking', 'text', 'tool_use'])
  })

  it('CJK 与 emoji 不被转义破坏', () => {
    const message: Message = {
      ...sampleMessage(),
      content: '中文内容 😀 与「引号」',
      agent_type: '代码审查员',
    }
    const back = expectRoundTrip(message)
    expect(back.content).toBe('中文内容 😀 与「引号」')
    expect(back.agent_type).toBe('代码审查员')
  })

  it('tool_call_id 非空时往返保留', () => {
    const message: Message = {
      ...sampleMessage(),
      role: MessageRole.TOOL,
      subtype: MessageSubtype.TOOL_RESULT,
      tool_call_id: 'toolu_01ABC',
    }
    expect(expectRoundTrip(message).tool_call_id).toBe('toolu_01ABC')
  })

  it('turn_id 允许空串（未归属任何 turn）', () => {
    const message: Message = { ...sampleMessage(), turn_id: '' }
    expect(expectRoundTrip(message).turn_id).toBe('')
  })

  it('tool_result 的 content 结构可往返还原', () => {
    const inner = { tool_use_id: 'toolu_1', content: '1|import os\n2|print(1)' }
    const message: Message = {
      ...sampleMessage(),
      role: MessageRole.TOOL,
      subtype: MessageSubtype.TOOL_RESULT,
      content: JSON.stringify(inner),
      tool_call_id: 'toolu_1',
    }

    const back = expectRoundTrip(message)
    expect(JSON.parse(back.content)).toEqual(inner)
  })
})

describe('Conversation 往返', () => {
  function sampleConversation(): Conversation {
    return {
      id: createSessionId(),
      title: '修复登录流程',
      total_output_tokens: 1234,
      last_input_tokens: 5678,
      compacted_message_count: 12,
      current_turn: 3,
      status: 'active',
      parent_conversation_id: '',
      agent_type: '',
      created_at: '2026-09-14T02:00:00.000Z',
      updated_at: '2026-09-14T02:39:11.123Z',
    }
  }

  it('主会话逐字段不丢失', () => {
    const conversation = sampleConversation()
    const back = expectRoundTrip(conversation)

    expect(back).toEqual(conversation)
    expect(Number.isInteger(back.total_output_tokens)).toBe(true)
    expect(Number.isInteger(back.current_turn)).toBe(true)
  })

  it('子代理会话靠 parent_conversation_id 非空标识', () => {
    const parentId = createSessionId()
    const sub: Conversation = {
      ...sampleConversation(),
      parent_conversation_id: parentId,
      agent_type: 'code-reviewer',
      title: '审查 diff',
    }

    const back = expectRoundTrip(sub)
    expect(back.parent_conversation_id).toBe(parentId)
    expect(back.agent_type).toBe('code-reviewer')
    expect(back.parent_conversation_id).not.toBe('')
  })

  it('计数字段为 0 时不被丢弃（0 是合法值，不是缺失）', () => {
    const fresh: Conversation = {
      ...sampleConversation(),
      total_output_tokens: 0,
      last_input_tokens: 0,
      compacted_message_count: 0,
      current_turn: 0,
    }

    const back = expectRoundTrip(fresh)
    expect(back.total_output_tokens).toBe(0)
    expect(back.current_turn).toBe(0)
    // 关键：字段存在且为 0，而非字段缺失
    expect(Object.keys(back)).toContain('current_turn')
  })
})

describe('TurnResult 往返', () => {
  function sampleResult(): TurnResult {
    const sessionId = createSessionId()
    return {
      turn_id: createTurnId(sessionId, 3),
      status: TurnStatus.COMPLETED,
      final_text: '已完成修改并通过测试。',
      tool_rounds: 4,
      input_tokens: 12000,
      output_tokens: 3400,
      error: null,
      num_turns: 5,
      max_turns: 10,
      terminal_reason: TerminalReason.COMPLETED,
      last_tool_error: null,
    }
  }

  it('正常完成往返', () => {
    const result = sampleResult()
    expect(expectRoundTrip(result)).toEqual(result)
  })

  it('partial 状态可往返且不与 failed 混淆', () => {
    const partial: TurnResult = {
      ...sampleResult(),
      status: TurnStatus.PARTIAL,
      terminal_reason: TerminalReason.MAX_TURNS,
      final_text: '已完成前两步，第三步因预算耗尽未执行。',
    }

    const back = expectRoundTrip(partial)
    expect(back.status).toBe('partial')
    expect(back.status).not.toBe(TurnStatus.FAILED)
    // 部分完成仍保留已有产出，不因非 completed 而清空
    expect(back.final_text).toBe('已完成前两步，第三步因预算耗尽未执行。')
  })

  it('失败时保留错误信息与最后工具错误', () => {
    const failed: TurnResult = {
      ...sampleResult(),
      status: TurnStatus.FAILED,
      error: 'HTTP 401 鉴权失败',
      terminal_reason: TerminalReason.ERROR,
      last_tool_error: 'TOOL_RUNTIME_ERROR',
    }

    const back = expectRoundTrip(failed)
    expect(back.error).toBe('HTTP 401 鉴权失败')
    expect(back.last_tool_error).toBe('TOOL_RUNTIME_ERROR')
  })

  it('终止原因为 null 时往返仍为 null（不是 undefined）', () => {
    const result: TurnResult = { ...sampleResult(), terminal_reason: null, error: null }
    const back = expectRoundTrip(result)

    expect(back.terminal_reason).toBeNull()
    expect(back.error).toBeNull()
    expect('terminal_reason' in back).toBe(true)
  })

  it('input 是快照、output 是累加 —— 两者语义不同，往返不得互换', () => {
    const result: TurnResult = { ...sampleResult(), input_tokens: 5000, output_tokens: 900 }
    const back = expectRoundTrip(result)

    expect(back.input_tokens).toBe(5000)
    expect(back.output_tokens).toBe(900)
  })
})

describe('PermissionRequest 往返', () => {
  function sampleRequest(): PermissionRequest {
    const sessionId = createSessionId()
    return {
      request_id: 'req-123',
      session_id: sessionId,
      turn_id: createTurnId(sessionId, 2),
      tool_call_id: createToolCallId(),
      tool_name: 'bash',
      args_preview: 'command=rm -rf /tmp/x',
      risk_level: RiskLevel.HIGH,
      reason: 'requires user approval: bash',
      status: PermissionRequestStatus.PENDING_USER_APPROVAL,
      created_at: '2026-09-14T02:39:11.123Z',
      expires_at: 1_786_932_000_000,
      resolved_at: null,
      resolved_by: '',
      resolution: '',
    }
  }

  it('待审批状态往返', () => {
    const request = sampleRequest()
    expect(expectRoundTrip(request)).toEqual(request)
  })

  it('已决议状态往返（含 resolved_at 数值）', () => {
    const resolved: PermissionRequest = {
      ...sampleRequest(),
      status: PermissionRequestStatus.EXPIRED,
      resolved_at: 1_786_932_120_000,
      resolved_by: 'system',
      resolution: 'timeout',
    }

    const back = expectRoundTrip(resolved)
    expect(back.status).toBe('EXPIRED')
    expect(back.resolved_at).toBe(1_786_932_120_000)
    expect(back.resolved_by).toBe('system')
    expect(back.resolution).toBe('timeout')
  })

  it('expires_at 是 epoch 毫秒数值（不是时间戳字符串）', () => {
    const back = expectRoundTrip(sampleRequest())
    expect(typeof back.expires_at).toBe('number')
    expect(Number.isInteger(back.expires_at)).toBe(true)
  })

  it('resolved_at 为 null 时往返仍为 null', () => {
    const back = expectRoundTrip(sampleRequest())
    expect(back.resolved_at).toBeNull()
  })
})

describe('组合场景', () => {
  it('一个会话及其消息集合整体往返不丢失关联', () => {
    const sessionId = createSessionId()
    const conversation: Conversation = {
      id: sessionId,
      title: '会话',
      total_output_tokens: 0,
      last_input_tokens: 0,
      compacted_message_count: 0,
      current_turn: 2,
      status: 'active',
      parent_conversation_id: '',
      agent_type: '',
      created_at: '2026-09-14T02:00:00.000Z',
      updated_at: '2026-09-14T02:39:11.123Z',
    }

    const messages: Message[] = [
      {
        id: createMessageId(),
        conversation_id: sessionId,
        role: MessageRole.USER,
        content: '帮我改一下',
        created_at: '2026-09-14T02:39:00.000Z',
        turn_id: createTurnId(sessionId, 1),
        subtype: MessageSubtype.NORMAL,
        tool_call_id: null,
        meta: '{}',
        agent_type: '',
      },
      {
        id: createMessageId(),
        conversation_id: sessionId,
        role: MessageRole.SYSTEM,
        content: JSON.stringify({
          type: 'compact_summary',
          summary: '之前讨论了登录',
          summarized_count: 8,
        }),
        created_at: '2026-09-14T02:39:11.000Z',
        turn_id: '',
        subtype: MessageSubtype.COMPACT_SUMMARY,
        tool_call_id: null,
        meta: '{}',
        agent_type: '',
      },
    ]

    // 模拟磁盘格式：messages 是扁平数组，靠 conversation_id 归属
    const store = { schema_version: 1, conversations: [conversation], messages }
    const back = JSON.parse(JSON.stringify(store)) as typeof store

    expect(back.messages).toHaveLength(2)
    // 归属关系靠字段而非嵌套结构
    for (const m of back.messages) {
      expect(m.conversation_id).toBe(sessionId)
    }
    expect(back.conversations[0]!.id).toBe(conversation.id)
    // 压缩摘要的 subtype 正确落盘（新实现写入正确值）
    expect(back.messages[1]!.subtype).toBe('compact_summary')
    expect(JSON.parse(back.messages[1]!.content).type).toBe('compact_summary')
  })
})
