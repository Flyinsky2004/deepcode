/**
 * `ContextBuilder` 的信封组装测试。
 *
 * `parts/09` §4 的核心要求是：**请求上下文必须显式构造**，不能靠反扫历史
 * 重建状态。因此这里固化三件事：
 *
 * 1. `conversation` 里不出现 UI 审计消息，且相邻 user 已被修复；
 * 2. `system` 由 `createSystemPrompt` 组装，skill 指导与压缩摘要**只来自显式入参**；
 * 3. `compact` 状态来自消息里的 `compact_summary` 记录。
 *
 * 第 3 条里有一处**可疑行为**（`boundaryId` 取的是摘要消息自身的 id、token 计数
 * 恒为 0），已在对应用例中写明分析并保留现状，未修改实现。
 */
import { describe, expect, it } from 'vitest'

import { MessageRole, MessageSubtype, type Message } from '../../src/core/models.js'
import { renderSystemPrompt, type RuntimeState } from '../../src/core/context.js'
import { PermissionMode, type ToolDescriptor } from '../../src/core/tool.js'
import { TurnPhase } from '../../src/core/turn.js'
import type { ChatStore } from '../../src/storage/chat-store.js'
import { ContextBuilder, renderEnvelopeSystem } from '../../src/runtime/context-builder.js'
import {
  BASE_SYSTEM,
  MODE_NORMAL,
  SAFETY_POLICY,
  SUBAGENT_AWARENESS,
} from '../../src/runtime/prompts.js'

type SessionId = Parameters<ChatStore['listActiveMessages']>[0]
const SESSION = 'session-1' as SessionId

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

function makeRuntime(): RuntimeState {
  return {
    phase: TurnPhase.BUILDING_CONTEXT,
    mode: PermissionMode.NORMAL,
    turnNumber: 1,
    appliedSkills: [],
    activePhase: '',
    budget: {
      maxModelCalls: 1,
      maxToolCalls: 1,
      maxWallTimeMs: 1000,
      maxInputTokens: 100,
      maxOutputTokens: 100,
      maxCost: 1,
    },
    budgetConsumption: {
      modelCalls: 0,
      toolCalls: 0,
      wallTimeMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
    },
  }
}

const tools: readonly ToolDescriptor[] = [
  {
    name: 'file_read',
    description: 'read',
    input_schema: { type: 'object' },
    version: '1',
    risk_level: 'low',
    capabilities: ['read'],
    source: { kind: 'native' },
  },
]

interface BuilderHarness {
  readonly builder: ContextBuilder
  /** `tools()` 被调用次数。 */
  readonly calls: () => number
  /** `listActiveMessages` 收到的 sessionId 序列。 */
  readonly listCalls: readonly string[]
}

function makeBuilder(
  all: readonly Message[],
  options: { skillGuidance?: () => string | undefined; toolList?: readonly ToolDescriptor[] } = {},
): BuilderHarness {
  let calls = 0
  const listCalls: string[] = []
  const fake = {
    listActiveMessages: (sessionId: string) => {
      listCalls.push(sessionId)
      return Promise.resolve(all)
    },
  }
  return {
    builder: new ContextBuilder({
      chatStore: fake as unknown as ChatStore,
      tools: () => {
        calls += 1
        return options.toolList ?? tools
      },
      ...(options.skillGuidance === undefined ? {} : { skillGuidance: options.skillGuidance }),
    }),
    calls: () => calls,
    listCalls,
  }
}

describe('ContextBuilder.build：会话消息', () => {
  it('丢弃不进入模型请求的审计消息，只保留可转换的部分', async () => {
    const { builder } = makeBuilder([
      message({ id: 'm1' as Message['id'], content: 'hi' }),
      message({
        id: 'm2' as Message['id'],
        subtype: MessageSubtype.PERMISSION_EVENT,
        content: '{"toolName":"bash"}',
      }),
      message({
        id: 'm3' as Message['id'],
        subtype: MessageSubtype.SKILL_EVENT,
        content: '{"skill":"demo"}',
      }),
      message({ id: 'm4' as Message['id'], role: MessageRole.SYSTEM, content: '系统提示' }),
    ])

    const envelope = await builder.build(SESSION, PermissionMode.NORMAL, makeRuntime())
    expect(envelope.conversation).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('修复连续 user 造成的角色断裂（崩溃/取消后的恢复路径）', async () => {
    const { builder } = makeBuilder([
      message({ id: 'm1' as Message['id'], content: 'one' }),
      message({ id: 'm2' as Message['id'], content: 'two' }),
    ])

    const envelope = await builder.build(SESSION, PermissionMode.NORMAL, makeRuntime())
    expect(envelope.conversation.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(envelope.conversation[1]?.content).toBe('[Interrupted]')
  })

  it('保留工具调用与结果的配对关系', async () => {
    const { builder } = makeBuilder([
      message({
        id: 'm1' as Message['id'],
        role: MessageRole.ASSISTANT,
        subtype: MessageSubtype.TOOL_CALL,
        content: JSON.stringify([
          { type: 'tool_use', id: 'tc-1', name: 'file_read', input: { path: 'a.txt' } },
        ]),
      }),
      message({
        id: 'm2' as Message['id'],
        role: MessageRole.TOOL,
        subtype: MessageSubtype.TOOL_RESULT,
        content: JSON.stringify({ tool_use_id: 'tc-1', content: 'content' }),
      }),
    ])

    const envelope = await builder.build(SESSION, PermissionMode.NORMAL, makeRuntime())
    expect(envelope.conversation).toEqual([
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tc-1', name: 'file_read', input: { path: 'a.txt' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tc-1', content: 'content' }],
      },
    ])
  })

  it('把 sessionId 原样传给存储，工具描述每次构建都重新收集', async () => {
    const holder = makeBuilder([message()])
    await holder.builder.build('other' as SessionId, PermissionMode.NORMAL, makeRuntime())
    expect(holder.listCalls).toEqual(['other'])
    expect(holder.calls()).toBe(1)
  })

  it('运行时状态按引用放入信封（是快照，不做深拷贝）', async () => {
    const { builder } = makeBuilder([])
    const runtime = makeRuntime()
    const envelope = await builder.build(SESSION, PermissionMode.NORMAL, runtime)
    expect(envelope.runtime).toBe(runtime)
  })
})

describe('ContextBuilder.build：系统提示', () => {
  it('未命中 skill 时不注入 skillGuidance（空层整体省略）', async () => {
    const { builder } = makeBuilder([])
    const envelope = await builder.build(SESSION, PermissionMode.PLAN, makeRuntime())

    expect(envelope.system.base).toBe(BASE_SYSTEM)
    expect(envelope.system.safety).toBe(SAFETY_POLICY)
    expect(envelope.system.subagent).toBe(SUBAGENT_AWARENESS)
    expect(envelope.system.skillGuidance).toBeUndefined()
    expect(envelope.system.compactSummary).toBeUndefined()
    expect(envelope.system.mode).not.toBe(MODE_NORMAL)
    expect(renderEnvelopeSystem(envelope)).toContain('ask_user_question')
  })

  it('skillGuidance 回调返回字符串时注入对应层', async () => {
    const { builder } = makeBuilder([], { skillGuidance: () => '按 demo skill 执行' })
    const envelope = await builder.build(SESSION, PermissionMode.NORMAL, makeRuntime())
    expect(envelope.system.skillGuidance).toBe('按 demo skill 执行')
  })

  it('skillGuidance 回调返回 undefined 时不注入（命中失败是常态，不是错误）', async () => {
    const { builder } = makeBuilder([], { skillGuidance: () => undefined })
    const envelope = await builder.build(SESSION, PermissionMode.NORMAL, makeRuntime())
    expect(envelope.system.skillGuidance).toBeUndefined()
  })

  it('renderEnvelopeSystem 与 renderSystemPrompt 输出一致（拼接只有一处实现）', async () => {
    const { builder } = makeBuilder([], { skillGuidance: () => '指导' })
    const envelope = await builder.build(SESSION, PermissionMode.NORMAL, makeRuntime())
    expect(renderEnvelopeSystem(envelope)).toBe(renderSystemPrompt(envelope.system))
    expect(renderEnvelopeSystem(envelope)).toContain('指导')
  })
})

describe('ContextBuilder.build：压缩摘要', () => {
  const summaryMessage = (overrides: Partial<Message> = {}) =>
    message({
      id: 'sum-1' as Message['id'],
      role: MessageRole.SYSTEM,
      subtype: MessageSubtype.COMPACT_SUMMARY,
      content: JSON.stringify({
        type: 'compact_summary',
        schema_version: 1,
        summary: '之前讨论了 A 与 B',
        summarized_count: 4,
      }),
      ...overrides,
    })

  it('存在压缩摘要时填充 compact 字段并注入 system.compactSummary', async () => {
    const { builder } = makeBuilder([summaryMessage(), message({ id: 'm2' as Message['id'] })])
    const envelope = await builder.build(SESSION, PermissionMode.NORMAL, makeRuntime())

    expect(envelope.compact?.summary).toBe('之前讨论了 A 与 B')
    expect(envelope.compact?.strategy).toBe('autocompact_v1')
    expect(envelope.system.compactSummary).toBe('之前讨论了 A 与 B')
    // 摘要消息本身不进入 conversation（它是 system 层，不是对话）
    expect(envelope.conversation).toEqual([{ role: 'user', content: 'hello' }])
  })

  it('没有摘要时省略 compact 字段（不是 null / 空对象）', async () => {
    const { builder } = makeBuilder([message()])
    const envelope = await builder.build(SESSION, PermissionMode.NORMAL, makeRuntime())
    expect('compact' in envelope).toBe(false)
  })

  it('多条摘要时取最后一条（最近一次压缩才反映当前状态）', async () => {
    const { builder } = makeBuilder([
      summaryMessage({ content: JSON.stringify({ type: 'compact_summary', summary: '旧摘要' }) }),
      summaryMessage({
        id: 'sum-2' as Message['id'],
        content: JSON.stringify({ type: 'compact_summary', summary: '新摘要' }),
      }),
    ])
    const envelope = await builder.build(SESSION, PermissionMode.NORMAL, makeRuntime())
    expect(envelope.compact?.summary).toBe('新摘要')
  })

  it('内容含 `"compact_summary"` 但 JSON 非法时静默跳过（脏数据不能让构建崩溃）', async () => {
    const { builder } = makeBuilder([
      message({ id: 'bad' as Message['id'], content: '坏数据 "compact_summary" 尾部' }),
      message({ id: 'ok' as Message['id'] }),
    ])
    const envelope = await builder.build(SESSION, PermissionMode.NORMAL, makeRuntime())
    expect('compact' in envelope).toBe(false)
    // 该消息仍作为普通文本进入 conversation
    expect(envelope.conversation[0]).toEqual({
      role: 'user',
      content: '坏数据 "compact_summary" 尾部',
    })
  })

  it('可解析但不是 compact_summary 类型时跳过（含字面量但 type 不符）', async () => {
    const { builder } = makeBuilder([
      message({
        id: 'x' as Message['id'],
        // 命中 content 兜底扫描，但解析出来的 type 不是 compact_summary
        content: JSON.stringify({ type: 'other', note: 'compact_summary' }),
      }),
    ])
    const envelope = await builder.build(SESSION, PermissionMode.NORMAL, makeRuntime())
    expect('compact' in envelope).toBe(false)
  })

  it('⚠️ 子类型为 NORMAL 但 content 里带 compact_summary 时同样被认作摘要（可疑，保留现状）', async () => {
    // 分析：`latestSummary` 的过滤条件除了 subtype 还兜底扫描 content 里是否含
    // 字面量 `"compact_summary"`——这正是 parts/09 §4 想要消除的"反扫历史重建状态"。
    // 保留它的理由只能是"兼容手工编辑/跨版本的历史数据"；此处固化现状待裁决。
    const { builder } = makeBuilder([
      message({
        id: 'legacy' as Message['id'],
        subtype: MessageSubtype.NORMAL,
        content: JSON.stringify({ type: 'compact_summary', summary: '老数据里的摘要' }),
      }),
    ])
    const envelope = await builder.build(SESSION, PermissionMode.NORMAL, makeRuntime())
    expect(envelope.compact?.summary).toBe('老数据里的摘要')
  })

  it('⚠️ compact.boundaryId 取的是摘要消息自身的 id，token 计数恒为 0（可疑，保留现状）', async () => {
    // 分析：`compaction.ts` 返回的 CompactSummary 用的是真实 boundaryId 与真实
    // token 估算；而从磁盘重建时 `latestSummary` 把 boundaryId 填成**摘要消息 id**，
    // 且 tokensBefore/tokensAfter 硬编码 0。重启后同一份会话的 CompactSummary
    // 字段语义与重启前不一致——若 UI 用 tokensBefore/After 展示压缩收益会显示 0。
    // 未修改实现，固化现状待裁决。
    const { builder } = makeBuilder([
      summaryMessage({ id: 'sum-42' as Message['id'] }),
      message({
        id: 'boundary-1' as Message['id'],
        subtype: MessageSubtype.COMPACT_BOUNDARY,
        content: '{}',
      }),
    ])
    const envelope = await builder.build(SESSION, PermissionMode.NORMAL, makeRuntime())
    expect(envelope.compact).toEqual({
      boundaryId: 'sum-42',
      strategy: 'autocompact_v1',
      summary: '之前讨论了 A 与 B',
      tokensBefore: 0,
      tokensAfter: 0,
    })
  })

  it('摘要缺 summary 字段时不崩溃，只是不注入 system 层（损坏数据静默降级）', async () => {
    const { builder } = makeBuilder([
      message({
        id: 'broken' as Message['id'],
        subtype: MessageSubtype.COMPACT_SUMMARY,
        content: JSON.stringify({ type: 'compact_summary' }),
      }),
    ])
    const envelope = await builder.build(SESSION, PermissionMode.NORMAL, makeRuntime())
    expect(envelope.compact?.summary).toBeUndefined()
    // renderSystemPrompt 会因 trim() 失败而跳过该层（undefined 不走注入分支）
    expect(envelope.system.compactSummary).toBeUndefined()
  })
})
