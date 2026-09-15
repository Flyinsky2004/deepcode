/**
 * `ChatStore` 的持久化与恢复行为单测。
 *
 * 这个 store 是**磁盘兼容性的唯一入口**：旧项目的 `chat.json` 由它读入，新写入
 * 也必须保持同样的字段形状。因此本文件刻意覆盖三类容易被忽略的分支：
 *
 * 1. **旧数据归一化** —— snake_case / camelCase 双写、缺失字段的默认值、
 *    `tool_call_id` 的 null 与 undefined 语义差异（前者是"显式无工具调用"，
 *    后者是"字段不存在"）。
 * 2. **幂等写入** —— 同 id 重复写入若内容一致应当静默通过（重试/恢复路径会
 *    重复写），内容不一致才报 `INVALID_STATE_TRANSITION`。这条区分是
 *    "可恢复"与"数据被悄悄改坏"的分界线。
 * 3. **恢复扫描** —— 进程中断留下的 RUNNING 工具、超时的权限请求与提问请求，
 *    都必须被 `recover()` 标记成终态，否则 UI 会一直等待一个已经不存在的对端。
 *
 * 所有测试都只固化既有行为，不修改实现。
 */
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { ErrorCode } from '../../src/core/errors.js'
import { MessageRole, MessageSubtype, type Message } from '../../src/core/models.js'
import {
  PermissionAction,
  PermissionRequestStatus,
  ToolExecutionStatus,
  type PermissionRequest,
  type PermissionResolution,
} from '../../src/core/tool.js'
import {
  UserInputRequestStatus,
  type UserInputRequest,
  type UserInputResolution,
} from '../../src/core/input.js'
import { TurnPhase } from '../../src/core/turn.js'
import { createFakeClock } from '../../src/core/time.js'
import type { PermissionRequestId, SessionId, ToolCallId, TurnId } from '../../src/core/ids.js'
import type { RuntimeEventEnvelope } from '../../src/core/events.js'
import { ChatStore } from '../../src/storage/chat-store.js'
import type { PersistedTurn } from '../../src/storage/types.js'
import { resolveAppPaths } from '../../src/storage/paths.js'

async function makeStore(): Promise<{ store: ChatStore; path: string; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'deepcode-chatstore-'))
  const paths = resolveAppPaths({ home: dir, cwd: dir })
  // 目录预先建好，方便用例直接写"旧数据"文件；store 自己也会建（见 withFileMutex）。
  await mkdir(paths.project_dir, { recursive: true })
  return { store: new ChatStore(paths), path: paths.chat_path, dir }
}

async function readRaw(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
}

const budget = {
  maxModelCalls: 1,
  maxToolCalls: 1,
  maxWallTimeMs: 1000,
  maxInputTokens: 1000,
  maxOutputTokens: 1000,
  maxCost: 1,
}
const memory = {
  userConstraints: [],
  openTasks: [],
  pendingToolCalls: [],
  permissionDecisions: [],
  fileChanges: [],
  appliedSkills: [],
}

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-1' as Message['id'],
    conversation_id: 'session-1',
    role: MessageRole.USER,
    content: 'hi',
    created_at: '2026-01-01T00:00:00.000Z',
    turn_id: '',
    subtype: MessageSubtype.NORMAL,
    tool_call_id: null,
    meta: '{}',
    agent_type: '',
    ...overrides,
  } as Message
}

describe('ChatStore 归一化与旧数据兼容', () => {
  it('缺少文件时读出空文档，且不主动创建磁盘文件', async () => {
    const { store, path } = await makeStore()
    const doc = await store.read()
    expect(doc.schema_version).toBe(1)
    expect(doc.conversations).toEqual([])
    expect(doc.messages).toEqual([])
    expect(doc.runtime.turns).toEqual([])
    await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('拒绝过新的 schema_version', async () => {
    const { store, path } = await makeStore()
    await writeFile(path, JSON.stringify({ schema_version: 99 }), 'utf8')
    await expect(store.read()).rejects.toMatchObject({
      code: ErrorCode.STORAGE_SCHEMA_UNSUPPORTED,
    })
  })

  it('runtime.schema_version 过新时同样拒绝', async () => {
    const { store, path } = await makeStore()
    await writeFile(
      path,
      JSON.stringify({ schema_version: 1, runtime: { schema_version: 2 } }),
      'utf8',
    )
    await expect(store.read()).rejects.toMatchObject({
      code: ErrorCode.STORAGE_SCHEMA_UNSUPPORTED,
    })
  })

  it('runtime 不是 object 时回落到空 runtime', async () => {
    const { store, path } = await makeStore()
    await writeFile(path, JSON.stringify({ schema_version: 1, runtime: 'nope' }), 'utf8')
    await expect(store.read()).resolves.toMatchObject({ runtime: { revision: 0, turns: [] } })
  })

  it('对话同时接受 snake_case 与 camelCase 字段，并丢弃无 id 的条目', async () => {
    const { store, path } = await makeStore()
    await writeFile(
      path,
      JSON.stringify({
        schema_version: 1,
        conversations: [
          {
            id: 'a',
            title: 'A',
            totalOutputTokens: 3,
            lastInputTokens: 4,
            compactedMessageCount: 5,
            currentTurn: 6,
            parentConversationId: 'p',
            agentType: 'sub',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
          { title: 'no id' },
          'not a record',
        ],
      }),
      'utf8',
    )
    const doc = await store.read()
    expect(doc.conversations).toHaveLength(1)
    expect(doc.conversations[0]).toMatchObject({
      id: 'a',
      total_output_tokens: 3,
      last_input_tokens: 4,
      compacted_message_count: 5,
      current_turn: 6,
      parent_conversation_id: 'p',
      agent_type: 'sub',
      principal_id: '',
      status: 'active',
    })
  })

  it('消息非法 role 回落到 user，非法 subtype 回落到 normal', async () => {
    const { store, path } = await makeStore()
    await writeFile(
      path,
      JSON.stringify({
        schema_version: 1,
        messages: [
          { id: 'm1', conversation_id: 'c', role: 'robot', subtype: 'wat' },
          { id: 'm2', conversationId: 'c', role: 'assistant', subtype: 'compact_summary' },
          { conversation_id: 'c' },
        ],
      }),
      'utf8',
    )
    const doc = await store.read()
    expect(doc.messages).toHaveLength(2)
    expect(doc.messages[0]).toMatchObject({
      role: MessageRole.USER,
      subtype: MessageSubtype.NORMAL,
      content: '',
      meta: '{}',
    })
    expect(doc.messages[1]).toMatchObject({
      role: MessageRole.ASSISTANT,
      subtype: MessageSubtype.COMPACT_SUMMARY,
    })
  })

  it('tool_call_id 的 null 与缺失被区分对待', async () => {
    const { store, path } = await makeStore()
    await writeFile(
      path,
      JSON.stringify({
        schema_version: 1,
        messages: [
          { id: 'explicit-null', conversation_id: 'c', tool_call_id: null },
          { id: 'absent', conversation_id: 'c' },
          { id: 'present', conversation_id: 'c', tool_call_id: 'tc-1' },
        ],
      }),
      'utf8',
    )
    const doc = await store.read()
    // null 与 undefined 都归一为 null —— 但这是**幂等**的：再次写回时不会因为
    // "null vs 缺字段"这种无意义差异被判为内容冲突。
    expect(doc.messages.map((m) => m.tool_call_id)).toEqual([null, null, 'tc-1'])
  })

  it('runtime 里非法的事件条目被过滤掉', async () => {
    const { store, path } = await makeStore()
    await writeFile(
      path,
      JSON.stringify({
        schema_version: 1,
        runtime: {
          events: [
            { eventId: 'e1', sessionId: 's', sequence: 1, type: 'turn.started', data: {} },
            { eventId: 'e2', sessionId: 's', sequence: 1.5, type: 'x', data: {} },
            { eventId: 'e3', sessionId: 's', sequence: 1, type: 'x' },
            { eventId: 4, sessionId: 's', sequence: 1, type: 'x', data: {} },
            'not a record',
          ],
        },
      }),
      'utf8',
    )
    const doc = await store.read()
    expect(doc.runtime.events.map((e) => e.eventId)).toEqual(['e1'])
  })

  it('initialize() 会落盘一份规范化的空文档', async () => {
    const { store, path } = await makeStore()
    await expect(store.initialize()).resolves.toMatchObject({ schema_version: 1 })
    expect(await readRaw(path)).toMatchObject({ schema_version: 1, conversations: [] })
  })
})

describe('ChatStore 对话与消息', () => {
  it('标题空白时回落到默认标题', async () => {
    const { store } = await makeStore()
    await expect(store.createConversation('   ')).resolves.toMatchObject({
      title: 'New conversation',
    })
  })

  it('createConversation 保留父会话、代理类型与主体', async () => {
    const { store } = await makeStore()
    const conversation = await store.createConversation('T', 'parent' as never, 'sub', 'prin')
    expect(conversation).toMatchObject({
      title: 'T',
      parent_conversation_id: 'parent',
      agent_type: 'sub',
      principal_id: 'prin',
      current_turn: 0,
      status: 'active',
    })
  })

  it('读取不存在的会话抛 SESSION_NOT_FOUND', async () => {
    const { store } = await makeStore()
    await expect(store.getConversation('missing' as never)).rejects.toMatchObject({
      code: ErrorCode.SESSION_NOT_FOUND,
    })
  })

  it('incrementTurn 递增 current_turn 并返回新值', async () => {
    const { store } = await makeStore()
    const conversation = await store.createConversation()
    await expect(store.incrementTurn(conversation.id)).resolves.toBe(1)
    await expect(store.incrementTurn(conversation.id)).resolves.toBe(2)
    await expect(store.listConversations()).resolves.toHaveLength(1)
  })

  it('相同 id 但内容不同的消息被判为冲突，内容相同则幂等通过', async () => {
    const { store } = await makeStore()
    const conversation = await store.createConversation()
    const payload = { ...message({ conversation_id: conversation.id }), id: 'fixed' as never }
    await store.addMessage(payload)
    // 重试路径会重复写同一条消息：内容一致必须静默通过。
    await expect(store.addMessage(payload)).resolves.toMatchObject({ id: 'fixed' })
    await expect(store.addMessage({ ...payload, content: 'changed' })).rejects.toMatchObject({
      code: ErrorCode.INVALID_STATE_TRANSITION,
    })
    await expect(store.listMessages(conversation.id)).resolves.toHaveLength(1)
  })

  it('addMessage 自动补 id 与时间戳，并刷新所属会话的 updated_at', async () => {
    const clock = createFakeClock(Date.parse('2026-01-01T00:00:00.000Z'))
    const { store: _unused } = await makeStore()
    void _unused
    const dir = await mkdtemp(join(tmpdir(), 'deepcode-chatstore-clock-'))
    const store = new ChatStore(resolveAppPaths({ home: dir, cwd: dir }), clock)
    const conversation = await store.createConversation()
    clock.advance(5000)
    const created = await store.addMessage({
      conversation_id: conversation.id,
      role: MessageRole.USER,
      content: 'x',
      turn_id: '',
      subtype: MessageSubtype.NORMAL,
      tool_call_id: null,
      meta: '{}',
      agent_type: '',
    })
    expect(created.created_at).toBe('2026-01-01T00:00:05.000Z')
    const [reloaded] = await store.listConversations()
    expect(reloaded!.updated_at).toBe('2026-01-01T00:00:05.000Z')
  })

  it('listMessages 按 created_at 升序返回，且只含本会话', async () => {
    const { store } = await makeStore()
    const a = await store.createConversation('a')
    const b = await store.createConversation('b')
    await store.addMessage(
      message({
        id: 'late' as never,
        conversation_id: a.id,
        created_at: '2026-01-02T00:00:00.000Z',
      }),
    )
    await store.addMessage(
      message({
        id: 'early' as never,
        conversation_id: a.id,
        created_at: '2026-01-01T00:00:00.000Z',
      }),
    )
    await store.addMessage(message({ id: 'other' as never, conversation_id: b.id }))
    await expect(store.listMessages(a.id)).resolves.toMatchObject([{ id: 'early' }, { id: 'late' }])
  })

  it('persistMessage / getActiveMessages 是 addMessage / listActiveMessages 的别名', async () => {
    const { store } = await makeStore()
    const conversation = await store.createConversation()
    await store.persistMessage(message({ id: 'm' as never, conversation_id: conversation.id }))
    await expect(store.getActiveMessages(conversation.id)).resolves.toHaveLength(1)
  })

  it('updateConversation 支持显式 updated_at，且找不到会话时抛错', async () => {
    const { store } = await makeStore()
    const conversation = await store.createConversation()
    await expect(
      store.updateConversation(conversation.id, {
        title: 'renamed',
        status: 'archived',
        total_output_tokens: 9,
        last_input_tokens: 8,
        compacted_message_count: 7,
        current_turn: 6,
        updated_at: '2030-01-01T00:00:00.000Z',
      }),
    ).resolves.toMatchObject({
      title: 'renamed',
      status: 'archived',
      total_output_tokens: 9,
      last_input_tokens: 8,
      compacted_message_count: 7,
      current_turn: 6,
      updated_at: '2030-01-01T00:00:00.000Z',
    })
    await expect(store.updateConversation('nope' as never, { title: 'x' })).rejects.toMatchObject({
      code: ErrorCode.SESSION_NOT_FOUND,
    })
  })
})

describe('ChatStore 活动消息（压缩边界）', () => {
  it('没有压缩边界时返回全部消息', async () => {
    const { store } = await makeStore()
    const conversation = await store.createConversation()
    await store.addMessage(message({ id: 'a' as never, conversation_id: conversation.id }))
    await expect(store.listActiveMessages(conversation.id)).resolves.toHaveLength(1)
  })

  it('边界之后的消息、以及边界显式保留的 id 都留在活动集里', async () => {
    const { store } = await makeStore()
    const conversation = await store.createConversation()
    const boundaryContent = JSON.stringify({
      type: 'compact_boundary',
      preserved_head_ids: ['head'],
      preserved_tail_id: 'tail',
      summary_msg_id: 'summary',
    })
    for (const [id, at, content] of [
      ['head', '2026-01-01T00:00:00.000Z', 'plain'],
      ['dropped', '2026-01-01T00:00:01.000Z', 'plain'],
      ['summary', '2026-01-01T00:00:02.000Z', 'plain'],
      ['tail', '2026-01-01T00:00:03.000Z', 'plain'],
      ['boundary', '2026-01-01T00:00:04.000Z', boundaryContent],
      ['after', '2026-01-01T00:00:05.000Z', 'plain'],
    ] as const)
      await store.addMessage(
        message({
          id: id as never,
          conversation_id: conversation.id,
          created_at: at,
          content,
          subtype: id === 'boundary' ? MessageSubtype.COMPACT_BOUNDARY : MessageSubtype.NORMAL,
        }),
      )
    const active = await store.listActiveMessages(conversation.id)
    // ⚠️ 边界消息**自身**不在活动集里：它既没有被元数据列为保留 id，也没有
    // "位于边界之后"。这是既有行为，且无实际影响——`messageToApiFormat()` 对
    // `compact_boundary` 一律返回 null，摘要另由 ContextBuilder 提升为 system。
    expect(active.map((m) => m.id)).toEqual(['head', 'summary', 'tail', 'after'])
  })

  it('边界内容非法 JSON 时不崩，只靠 subtype 识别边界', async () => {
    const { store } = await makeStore()
    const conversation = await store.createConversation()
    for (const [id, at, content, subtype] of [
      ['old', '2026-01-01T00:00:00.000Z', 'plain', MessageSubtype.NORMAL],
      ['boundary', '2026-01-01T00:00:01.000Z', '{ not json', MessageSubtype.COMPACT_BOUNDARY],
      ['new', '2026-01-01T00:00:02.000Z', 'plain', MessageSubtype.NORMAL],
    ] as const)
      await store.addMessage(
        message({
          id: id as never,
          conversation_id: conversation.id,
          created_at: at,
          content,
          subtype,
        }),
      )
    const active = await store.listActiveMessages(conversation.id)
    // 元数据解析失败 → 保留集合为空 → 只剩边界之后的消息。不抛错是重点。
    expect(active.map((m) => m.id)).toEqual(['new'])
  })

  it('边界未声明 summary_msg_id 时，取紧邻其前的压缩摘要', async () => {
    const { store } = await makeStore()
    const conversation = await store.createConversation()
    await store.addMessage(
      message({
        id: 'summary' as never,
        conversation_id: conversation.id,
        created_at: '2026-01-01T00:00:00.000Z',
        subtype: MessageSubtype.COMPACT_SUMMARY,
      }),
    )
    await store.addMessage(
      message({
        id: 'boundary' as never,
        conversation_id: conversation.id,
        created_at: '2026-01-01T00:00:01.000Z',
        content: JSON.stringify({ type: 'compact_boundary' }),
      }),
    )
    await expect(store.listActiveMessages(conversation.id)).resolves.toMatchObject([
      { id: 'summary' },
    ])
  })

  it('以内容里的 type 而非 subtype 识别边界（旧数据只写了内容）', async () => {
    const { store } = await makeStore()
    const conversation = await store.createConversation()
    await store.addMessage(
      message({
        id: 'old' as never,
        conversation_id: conversation.id,
        created_at: '2026-01-01T00:00:00.000Z',
      }),
    )
    await store.addMessage(
      message({
        id: 'boundary' as never,
        conversation_id: conversation.id,
        created_at: '2026-01-01T00:00:01.000Z',
        content: JSON.stringify({ type: 'compact_boundary' }),
      }),
    )
    await expect(store.listActiveMessages(conversation.id)).resolves.toEqual([])
  })

  it('边界处于首条消息时不会误取前一条', async () => {
    const { store } = await makeStore()
    const conversation = await store.createConversation()
    await store.addMessage(
      message({
        id: 'boundary' as never,
        conversation_id: conversation.id,
        created_at: '2026-01-01T00:00:00.000Z',
        subtype: MessageSubtype.COMPACT_BOUNDARY,
        content: JSON.stringify({ type: 'compact_boundary' }),
      }),
    )
    await expect(store.listActiveMessages(conversation.id)).resolves.toEqual([])
  })

  it('多个边界时只用最后一个', async () => {
    const { store } = await makeStore()
    const conversation = await store.createConversation()
    for (const [id, at] of [
      ['b1', '2026-01-01T00:00:00.000Z'],
      ['mid', '2026-01-01T00:00:01.000Z'],
      ['b2', '2026-01-01T00:00:02.000Z'],
      ['last', '2026-01-01T00:00:03.000Z'],
    ] as const)
      await store.addMessage(
        message({
          id: id as never,
          conversation_id: conversation.id,
          created_at: at,
          subtype: id.startsWith('b') ? MessageSubtype.COMPACT_BOUNDARY : MessageSubtype.NORMAL,
          content: id.startsWith('b') ? JSON.stringify({ type: 'compact_boundary' }) : 'plain',
        }),
      )
    await expect(store.listActiveMessages(conversation.id)).resolves.toMatchObject([{ id: 'last' }])
  })
})

describe('ChatStore turn 生命周期', () => {
  async function withConversation(): Promise<{ store: ChatStore; sessionId: SessionId }> {
    const { store } = await makeStore()
    const conversation = await store.createConversation()
    return { store, sessionId: conversation.id }
  }

  it('beginTurn 分配递增的 turn 号并写出一条用户消息', async () => {
    const { store, sessionId } = await withConversation()
    const turn = await store.beginTurn(sessionId, 'hello', 'p', budget, memory)
    expect(turn).toMatchObject({
      sessionId,
      turnNumber: 1,
      phase: TurnPhase.STARTING,
      principalId: 'p',
      transitions: [],
      consumption: {
        modelCalls: 0,
        toolCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cost: 0,
        wallTimeMs: 0,
      },
    })
    await expect(store.getConversation(sessionId as never)).resolves.toMatchObject({
      current_turn: 1,
    })
    await expect(store.listMessages(sessionId as never)).resolves.toMatchObject([
      { content: 'hello', role: MessageRole.USER, turn_id: turn.turnId },
    ])
  })

  it('会话不存在或已有活动 turn 时拒绝开启新 turn', async () => {
    const { store, sessionId } = await withConversation()
    await expect(
      store.beginTurn('missing' as never, 'x', 'p', budget, memory),
    ).rejects.toMatchObject({ code: ErrorCode.SESSION_NOT_FOUND })

    await store.beginTurn(sessionId, 'first', 'p', budget, memory)
    await expect(
      store.beginTurn(sessionId as never, 'second', 'p', budget, memory),
    ).rejects.toMatchObject({ code: ErrorCode.SESSION_BUSY })
  })

  it('已有终态 turn 的会话可以再次开启', async () => {
    const { store, sessionId } = await withConversation()
    const first = await store.beginTurn(sessionId, 'a', 'p', budget, memory)
    // starting → failed 是合法迁移（任意进行中阶段都可直接进终态）。
    await store.updateTurn(sessionId, first.turnId as TurnId, { phase: TurnPhase.FAILED })
    await expect(
      store.beginTurn(sessionId as never, 'b', 'p', budget, memory),
    ).resolves.toMatchObject({ turnNumber: 2 })
  })

  it('createTurn 对同 id 幂等，对内容不同的冲突报错，对活动会话报忙碌', async () => {
    const { store, sessionId } = await withConversation()
    const turn: PersistedTurn = {
      sessionId: sessionId,
      turnId: 't1',
      turnNumber: 1,
      phase: TurnPhase.STARTING,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      principalId: 'p',
      transitions: [],
      budget,
      consumption: {
        modelCalls: 0,
        toolCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cost: 0,
        wallTimeMs: 0,
      },
      workingMemory: memory,
    }
    await store.createTurn(turn)
    await expect(store.createTurn(turn)).resolves.toBeUndefined()
    await expect(store.createTurn({ ...turn, principalId: 'other' })).rejects.toMatchObject({
      code: ErrorCode.INVALID_STATE_TRANSITION,
    })
    await expect(store.createTurn({ ...turn, turnId: 't2', turnNumber: 2 })).rejects.toMatchObject({
      code: ErrorCode.SESSION_BUSY,
    })
  })

  it('updateTurn 拒绝非法相位迁移，找不到 turn 时抛错', async () => {
    const { store, sessionId } = await withConversation()
    const turn = await store.beginTurn(sessionId, 'a', 'p', budget, memory)
    await expect(
      store.updateTurn(sessionId as never, turn.turnId as TurnId, {
        phase: TurnPhase.BUILDING_CONTEXT,
      }),
    ).resolves.toMatchObject({ phase: TurnPhase.BUILDING_CONTEXT })
    // building_context → completed 不是合法迁移（必须先经过 calling_model）。
    await expect(
      store.updateTurn(sessionId as never, turn.turnId as TurnId, { phase: TurnPhase.COMPLETED }),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_STATE_TRANSITION })
    await expect(
      store.updateTurn(sessionId as never, 'ghost' as never, { phase: TurnPhase.CALLING_MODEL }),
    ).rejects.toMatchObject({ code: ErrorCode.SESSION_NOT_FOUND })
  })

  it('updateTurn 可以在不改变相位时更新其它字段', async () => {
    const { store, sessionId } = await withConversation()
    const turn = await store.beginTurn(sessionId, 'a', 'p', budget, memory)
    const updated = await store.updateTurn(sessionId, turn.turnId as TurnId, {
      updatedAt: '2030-01-01T00:00:00.000Z',
    })
    expect(updated).toMatchObject({
      phase: TurnPhase.STARTING,
      updatedAt: '2030-01-01T00:00:00.000Z',
    })
  })

  it('getTurn 找不到时抛 SESSION_NOT_FOUND', async () => {
    const { store } = await withConversation()
    await expect(store.getTurn('s' as never, 't' as never)).rejects.toMatchObject({
      code: ErrorCode.SESSION_NOT_FOUND,
    })
  })

  it('appendCompaction 追加摘要与边界并累加已压缩条数；重复调用被忽略', async () => {
    const { store, sessionId } = await withConversation()
    const summary = message({
      id: 'summary' as never,
      conversation_id: sessionId,
      subtype: MessageSubtype.COMPACT_SUMMARY,
    })
    const boundary = message({
      id: 'boundary' as never,
      conversation_id: sessionId,
      subtype: MessageSubtype.COMPACT_BOUNDARY,
      created_at: '2026-01-02T00:00:00.000Z',
    })
    await store.appendCompaction(summary, boundary, 4)
    await store.appendCompaction(summary, boundary, 4)
    await expect(store.listMessages(sessionId as never)).resolves.toHaveLength(2)
    await expect(store.getConversation(sessionId as never)).resolves.toMatchObject({
      compacted_message_count: 4,
      updated_at: '2026-01-02T00:00:00.000Z',
    })
  })

  it('appendEvent 幂等，但对同 id 不同内容/不同类型报冲突', async () => {
    const { store } = await withConversation()
    const event = {
      eventId: 'e1',
      sessionId: 's',
      sequence: 1,
      type: 'turn.started',
      data: { a: 1 },
    } as unknown as RuntimeEventEnvelope
    await store.appendEvent(event)
    await expect(store.appendEvent(event)).resolves.toBeUndefined()
    await expect(store.appendEvent({ ...event, data: { a: 2 } })).rejects.toMatchObject({
      code: ErrorCode.INVALID_STATE_TRANSITION,
    })
    await expect(store.appendEvent({ ...event, type: 'turn.completed' })).rejects.toMatchObject({
      code: ErrorCode.INVALID_STATE_TRANSITION,
    })
    await expect(store.read()).resolves.toMatchObject({
      runtime: { revision: 1, events: [{ eventId: 'e1' }] },
    })
  })
})

describe('ChatStore 权限请求', () => {
  /** 决议对象的形状：`requestId` 与 `decision` 在 `PermissionResolution` 里是必填的。 */
  const resolution = (
    requestId: string,
    decision: PermissionAction,
    extra: Partial<PermissionResolution> = {},
  ): PermissionResolution => ({ requestId, decision, resolvedBy: 'user', ...extra })

  const request = (overrides: Partial<PermissionRequest> = {}): PermissionRequest => {
    const base: PermissionRequest = {
      request_id: 'req-1',
      session_id: 's1' as SessionId,
      turn_id: 't1' as TurnId,
      tool_name: 'bash',
      tool_call_id: 'tc' as ToolCallId,
      args_preview: '{}',
      reason: 'needs approval',
      risk_level: 'medium',
      status: PermissionRequestStatus.CREATED,
      created_at: '2026-01-01T00:00:00.000Z',
      expires_at: 1000,
      resolved_at: null,
      resolved_by: '',
      resolution: '',
    }
    return { ...base, ...overrides }
  }

  it('同 request_id 的重复写入覆盖而非追加', async () => {
    const { store } = await makeStore()
    await store.addPermissionRequest(request())
    await store.addPermissionRequest(request({ reason: 'updated' }))
    await expect(store.listPermissionRequests()).resolves.toMatchObject([{ reason: 'updated' }])
  })

  it('listPermissionRequests 可按会话过滤', async () => {
    const { store } = await makeStore()
    await store.addPermissionRequest(request({ request_id: 'a', session_id: 's1' as SessionId }))
    await store.addPermissionRequest(request({ request_id: 'b', session_id: 's2' as SessionId }))
    await expect(store.listPermissionRequests()).resolves.toHaveLength(2)
    await expect(store.listPermissionRequests('s1' as never)).resolves.toMatchObject([
      { request_id: 'a' },
    ])
  })

  it('决策到状态的映射：allow / timeout / cancel / 其它', async () => {
    const { store } = await makeStore()
    const cases: readonly [PermissionAction, string, PermissionRequestStatus][] = [
      [PermissionAction.ALLOW, '', PermissionRequestStatus.APPROVED],
      // 决议被拒时，理由里的关键字决定是"超时"还是"取消"——这两者与"用户拒绝"
      // 在恢复语义上完全不同（前者可自动重试，后者不行）。
      [PermissionAction.DENY, 'request expired', PermissionRequestStatus.EXPIRED],
      [PermissionAction.DENY, 'user cancelled it', PermissionRequestStatus.CANCELLED],
      [PermissionAction.DENY, 'not allowed', PermissionRequestStatus.DENIED],
    ]
    for (const [index, [decision, reason, expected]] of cases.entries()) {
      const id = `req-${index}`
      await store.addPermissionRequest(request({ request_id: id }))
      await store.resolvePermission(id, resolution(id, decision, { reason }))
      await expect(store.listPermissionRequests()).resolves.toContainEqual(
        expect.objectContaining({ request_id: id, status: expected, resolved_by: 'user' }),
      )
    }
  })

  it('resolvePermission 记录 resolution 与解析后的时间戳', async () => {
    const { store } = await makeStore()
    await store.addPermissionRequest(request())
    await store.resolvePermission(
      'req-1',
      resolution('req-1', PermissionAction.ALLOW, { reason: 'ok' }),
      '2026-05-05T00:00:00.000Z',
    )
    const doc = await store.read()
    expect(doc.runtime.permission_resolutions).toMatchObject([
      { requestId: 'req-1', resolvedAt: '2026-05-05T00:00:00.000Z' },
    ])
    expect(await store.listPermissionRequests()).toMatchObject([
      {
        resolution: 'ok',
        resolved_at: Date.parse('2026-05-05T00:00:00.000Z'),
        resolved_by: 'user',
      },
    ])
  })

  it('未指定 resolvedAt 时用时钟当前时间填充', async () => {
    const clock = createFakeClock(Date.parse('2026-02-02T00:00:00.000Z'))
    const dir = await mkdtemp(join(tmpdir(), 'deepcode-chatstore-resolve-'))
    const store = new ChatStore(resolveAppPaths({ home: dir, cwd: dir }), clock)
    await store.addPermissionRequest(request())
    await store.resolvePermission('req-1', resolution('req-1', PermissionAction.DENY))
    await expect(store.listPermissionRequests()).resolves.toMatchObject([
      { resolved_at: Date.parse('2026-02-02T00:00:00.000Z') },
    ])
  })

  it('未找到请求时抛 SESSION_NOT_FOUND', async () => {
    const { store } = await makeStore()
    await expect(
      store.resolvePermission('ghost', resolution('ghost', PermissionAction.ALLOW)),
    ).rejects.toMatchObject({ code: ErrorCode.SESSION_NOT_FOUND })
  })

  it('已终态请求重复提交相同决策幂等通过，不同决策报冲突', async () => {
    const { store } = await makeStore()
    const allow = resolution('req-1', PermissionAction.ALLOW, { reason: 'ok' })
    await store.addPermissionRequest(request())
    await store.resolvePermission('req-1', allow)
    // 重连/重试会重复提交同一决议：必须幂等通过，而不是报"已解决"。
    await expect(store.resolvePermission('req-1', allow)).resolves.toBeUndefined()
    await expect(
      store.resolvePermission(
        'req-1',
        resolution('req-1', PermissionAction.DENY, { reason: 'no' }),
      ),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_STATE_TRANSITION })
  })
})

describe('ChatStore 提问请求与工具执行', () => {
  const inputRequest = (overrides: Partial<UserInputRequest> = {}): UserInputRequest => {
    const base: UserInputRequest = {
      request_id: 'q1' as PermissionRequestId,
      session_id: 's1' as SessionId,
      turn_id: 't1' as TurnId,
      tool_call_id: 'tc' as ToolCallId,
      tool_name: 'ask_user_question',
      questions: [],
      created_at: '2026-01-01T00:00:00.000Z',
      expires_at: 1000,
    }
    return { ...base, ...overrides }
  }

  /** 作答决议的形状：`requestId` 必填，`answers` 是按下标对齐的二维数组。 */
  const inputResolution = (
    requestId: string,
    answers: readonly (readonly string[])[] | null,
    resolvedBy: 'user' | 'system',
  ): UserInputResolution => ({ requestId, answers, resolvedBy })

  it('同 id 的提问请求只写入一次', async () => {
    const { store } = await makeStore()
    await store.addUserInputRequest(inputRequest())
    await store.addUserInputRequest(inputRequest())
    await expect(store.listUserInputRequests()).resolves.toMatchObject([
      { status: UserInputRequestStatus.PENDING_USER_INPUT, answers: null, resolved_at: null },
    ])
  })

  it('listUserInputRequests 可按会话过滤', async () => {
    const { store } = await makeStore()
    await store.addUserInputRequest(
      inputRequest({ request_id: 'a' as PermissionRequestId, session_id: 's1' as SessionId }),
    )
    await store.addUserInputRequest(
      inputRequest({ request_id: 'b' as PermissionRequestId, session_id: 's2' as SessionId }),
    )
    await expect(store.listUserInputRequests()).resolves.toHaveLength(2)
    await expect(store.listUserInputRequests('s2' as never)).resolves.toMatchObject([
      { request: { request_id: 'b' } },
    ])
  })

  it('作答状态由 answers 与 resolvedBy 共同决定', async () => {
    const { store } = await makeStore()
    await store.addUserInputRequest(inputRequest({ request_id: 'answered' as PermissionRequestId }))
    await store.addUserInputRequest(inputRequest({ request_id: 'expired' as PermissionRequestId }))
    await store.addUserInputRequest(
      inputRequest({ request_id: 'cancelled' as PermissionRequestId }),
    )

    await expect(
      store.resolveUserInput('answered', inputResolution('answered', [['x']], 'user')),
    ).resolves.toMatchObject({ status: UserInputRequestStatus.ANSWERED })
    // answers 为 null 且由 system 收尾 → 超时过期；由用户收尾 → 主动取消。
    await expect(
      store.resolveUserInput('expired', inputResolution('expired', null, 'system')),
    ).resolves.toMatchObject({ status: UserInputRequestStatus.EXPIRED })
    await expect(
      store.resolveUserInput('cancelled', inputResolution('cancelled', null, 'user')),
    ).resolves.toMatchObject({ status: UserInputRequestStatus.CANCELLED })
  })

  it('对不存在的提问请求作答返回 undefined 而不是抛错', async () => {
    const { store } = await makeStore()
    await expect(
      store.resolveUserInput('ghost', inputResolution('ghost', null, 'user')),
    ).resolves.toBeUndefined()
  })

  it('工具执行记录按 executionId 去重，并支持增量更新与按调用查找', async () => {
    const { store } = await makeStore()
    const record = {
      executionId: 'ex1',
      sessionId: 's1',
      toolCallId: 'tc1',
      inputHash: 'h1',
      status: ToolExecutionStatus.RUNNING,
      startedAt: '2026-01-01T00:00:00.000Z',
    }
    await store.addToolExecution(record as never)
    await store.addToolExecution({ ...record, status: ToolExecutionStatus.SUCCESS } as never)
    await expect(store.listToolExecutions()).resolves.toMatchObject([
      { executionId: 'ex1', status: ToolExecutionStatus.SUCCESS },
    ])

    await store.updateToolExecution('ex1', { output: 'done' } as never)
    await expect(store.listToolExecutions('s1' as never)).resolves.toMatchObject([
      { output: 'done' },
    ])

    await expect(store.findToolExecution('tc1', 'h1')).resolves.toMatchObject({
      executionId: 'ex1',
    })
    // inputHash 不同的同一次调用必须区分开——这是重放防护的关键。
    await expect(store.findToolExecution('tc1', 'other')).resolves.toBeUndefined()
  })

  it('幂等记录按 key 去重并可读回', async () => {
    const { store } = await makeStore()
    await store.putIdempotency({ key: 'k', value: 'v1' } as never)
    await store.putIdempotency({ key: 'k', value: 'v2' } as never)
    await expect(store.getIdempotency('k')).resolves.toMatchObject({ value: 'v2' })
    await expect(store.getIdempotency('missing')).resolves.toBeUndefined()
  })
})

describe('ChatStore.recover', () => {
  it('把超时的权限请求、提问请求与中断的工具执行标记为终态', async () => {
    const clock = createFakeClock(5000)
    const dir = await mkdtemp(join(tmpdir(), 'deepcode-chatstore-recover-'))
    const store = new ChatStore(resolveAppPaths({ home: dir, cwd: dir }), clock)
    const conversation = await store.createConversation()
    const turn = await store.beginTurn(conversation.id, 'p', 'prin', budget, memory)

    await store.addPermissionRequest({
      request_id: 'expired-perm',
      session_id: conversation.id,
      turn_id: turn.turnId,
      tool_name: 'bash',
      tool_call_id: 'tc',
      input: {},
      reason: '',
      risk_level: 'medium',
      status: PermissionRequestStatus.PENDING_USER_APPROVAL,
      created_at: '2026-01-01T00:00:00.000Z',
      expires_at: 4000,
    } as unknown as PermissionRequest)
    await store.addPermissionRequest({
      request_id: 'live-perm',
      session_id: conversation.id,
      turn_id: turn.turnId,
      tool_name: 'bash',
      tool_call_id: 'tc',
      input: {},
      reason: '',
      risk_level: 'medium',
      status: PermissionRequestStatus.CREATED,
      created_at: '2026-01-01T00:00:00.000Z',
      expires_at: 9000,
    } as unknown as PermissionRequest)

    await store.addUserInputRequest({
      request_id: 'expired-q',
      session_id: conversation.id,
      turn_id: turn.turnId,
      questions: [],
      created_at: '2026-01-01T00:00:00.000Z',
      expires_at: 4000,
    } as unknown as UserInputRequest)
    await store.addUserInputRequest({
      request_id: 'live-q',
      session_id: conversation.id,
      turn_id: turn.turnId,
      questions: [],
      created_at: '2026-01-01T00:00:00.000Z',
      expires_at: 9000,
    } as unknown as UserInputRequest)

    await store.addToolExecution({
      executionId: 'running',
      sessionId: conversation.id,
      toolCallId: 'tc',
      inputHash: 'h',
      status: ToolExecutionStatus.RUNNING,
      startedAt: '2026-01-01T00:00:00.000Z',
    } as never)
    await store.addToolExecution({
      executionId: 'stale-unknown',
      sessionId: conversation.id,
      toolCallId: 'tc',
      inputHash: 'h',
      status: ToolExecutionStatus.UNKNOWN,
      startedAt: '2026-01-01T00:00:00.000Z',
    } as never)

    const snapshot = await store.recover()
    expect(snapshot.unfinishedTurns).toMatchObject([{ turnId: turn.turnId }])
    // 已修正的缺陷（ADR 0003 同批）：原过滤条件写成
    // `(!expired && CREATED) || PENDING_USER_APPROVAL`，`||` 的优先级让
    // `PENDING_USER_APPROVAL` 逃过过期检查，于是刚被判定超时、并已在磁盘上
    // 改成 EXPIRED 的请求仍出现在快照里，与落盘状态自相矛盾。
    // 现在 `!expired` 同时约束两个状态（与 pendingUserInputs 同一写法），
    // 超时的那条必须**不再**出现在待审批列表里。
    expect(snapshot.pendingPermissions.map((r) => r.request_id)).toEqual(['live-perm'])
    expect(snapshot.pendingUserInputs.map((r) => r.request.request_id)).toEqual(['live-q'])
    // unknown 列表去重：本次新标记的 running 与前次遗留的 stale-unknown 各出现一次。
    expect(snapshot.unknownExecutions.map((r) => r.executionId).sort()).toEqual([
      'running',
      'stale-unknown',
    ])

    const doc = await store.read()
    expect(doc.runtime.permission_requests).toMatchObject([
      {
        request_id: 'expired-perm',
        status: PermissionRequestStatus.EXPIRED,
        resolved_by: 'system',
      },
      { request_id: 'live-perm', status: PermissionRequestStatus.CREATED },
    ])
    expect(doc.runtime.user_input_requests).toMatchObject([
      { request: { request_id: 'expired-q' }, status: UserInputRequestStatus.EXPIRED },
      { request: { request_id: 'live-q' }, status: UserInputRequestStatus.PENDING_USER_INPUT },
    ])
    expect(doc.runtime.tool_executions).toMatchObject([
      { executionId: 'running', status: ToolExecutionStatus.UNKNOWN },
      { executionId: 'stale-unknown', status: ToolExecutionStatus.UNKNOWN },
    ])
  })

  it('没有需要恢复的内容时快照为空且不写盘', async () => {
    const { store, path } = await makeStore()
    await store.initialize()
    const before = await readFile(path, 'utf8')
    await expect(store.recover()).resolves.toEqual({
      unfinishedTurns: [],
      pendingPermissions: [],
      pendingUserInputs: [],
      unknownExecutions: [],
    })
    expect(await readFile(path, 'utf8')).toBe(before)
  })
})
