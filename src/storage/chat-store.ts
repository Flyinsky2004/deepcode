import { randomUUID } from 'node:crypto'
import { AgentError, ErrorCode } from '../core/errors.js'
import { createMessageId, createTurnId, type SessionId, type TurnId } from '../core/ids.js'
import {
  MessageRole,
  MessageSubtype,
  type Conversation,
  type Message,
  type CompactBoundaryContent,
} from '../core/models.js'
import {
  PermissionRequestStatus,
  ToolExecutionStatus,
  type PermissionRequest,
  type PermissionResolution,
} from '../core/tool.js'
import { ACTIVE_PHASES, canTransition, TurnPhase } from '../core/turn.js'
import { systemClock, type Clock } from '../core/time.js'
import { type AppPaths } from './paths.js'
import type { RuntimeEventEnvelope } from '../core/events.js'
import { isRecord, readJsonObject, updateJsonAtomic } from './json-file.js'
import {
  type ChatDocument,
  type IdempotencyRecord,
  type PersistedPermissionResolution,
  type PersistedToolExecution,
  type PersistedTurn,
  type RecoverySnapshot,
  type RuntimeDocument,
} from './types.js'

const VERSION = 1
const EMPTY_RUNTIME: RuntimeDocument = {
  schema_version: VERSION,
  revision: 0,
  turns: [],
  permission_requests: [],
  permission_resolutions: [],
  tool_executions: [],
  idempotency: [],
  events: [],
}

const asString = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)
const asNum = (v: unknown, fallback = 0): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback
const asArray = (v: unknown): readonly unknown[] => (Array.isArray(v) ? v : [])

function normalizeConversation(value: unknown): Conversation | undefined {
  if (!isRecord(value)) return undefined
  const id = asString(value['id'])
  if (!id) return undefined
  const now = new Date().toISOString()
  return {
    id: id as SessionId,
    title: asString(value['title'], 'New conversation'),
    total_output_tokens: asNum(value['total_output_tokens'] ?? value['totalOutputTokens']),
    last_input_tokens: asNum(value['last_input_tokens'] ?? value['lastInputTokens']),
    compacted_message_count: asNum(
      value['compacted_message_count'] ?? value['compactedMessageCount'],
    ),
    current_turn: asNum(value['current_turn'] ?? value['currentTurn']),
    status: asString(value['status'], 'active'),
    parent_conversation_id: asString(
      value['parent_conversation_id'] ?? value['parentConversationId'],
    ) as SessionId | '',
    agent_type: asString(value['agent_type'] ?? value['agentType']),
    created_at: asString(value['created_at'] ?? value['createdAt'], now),
    updated_at: asString(value['updated_at'] ?? value['updatedAt'], now),
  }
}

function normalizeMessage(value: unknown): Message | undefined {
  if (!isRecord(value)) return undefined
  const id = asString(value['id'])
  const conversationId = asString(value['conversation_id'] ?? value['conversationId'])
  if (!id || !conversationId) return undefined
  const role =
    value['role'] === 'user' ||
    value['role'] === 'assistant' ||
    value['role'] === 'tool' ||
    value['role'] === 'system'
      ? value['role']
      : 'user'
  const subtype = Object.values(MessageSubtype).includes(value['subtype'] as MessageSubtype)
    ? (value['subtype'] as MessageSubtype)
    : MessageSubtype.NORMAL
  return {
    id: id as Message['id'],
    conversation_id: conversationId as SessionId,
    role,
    content: asString(value['content']),
    created_at: asString(value['created_at'] ?? value['createdAt'], new Date().toISOString()),
    turn_id: asString(value['turn_id'] ?? value['turnId']) as TurnId | '',
    subtype,
    tool_call_id:
      value['tool_call_id'] === null || value['tool_call_id'] === undefined
        ? null
        : asString(value['tool_call_id']),
    meta: asString(value['meta'], '{}'),
    agent_type: asString(value['agent_type'] ?? value['agentType']),
  }
}

function normalizeRuntime(value: unknown): RuntimeDocument {
  if (!isRecord(value)) return EMPTY_RUNTIME
  const version = asNum(value['schema_version'], VERSION)
  if (version > VERSION)
    throw new AgentError({
      code: ErrorCode.STORAGE_SCHEMA_UNSUPPORTED,
      message: `chat runtime schema_version ${version} is too new`,
      source: 'chat',
    })
  return {
    schema_version: VERSION,
    revision: asNum(value['revision']),
    turns: asArray(value['turns']).filter(isRecord) as unknown as readonly PersistedTurn[],
    permission_requests: asArray(value['permission_requests']).filter(
      isRecord,
    ) as unknown as readonly PermissionRequest[],
    permission_resolutions: asArray(value['permission_resolutions']).filter(
      isRecord,
    ) as unknown as readonly PersistedPermissionResolution[],
    tool_executions: asArray(value['tool_executions']).filter(
      isRecord,
    ) as unknown as readonly PersistedToolExecution[],
    idempotency: asArray(value['idempotency']).filter(
      isRecord,
    ) as unknown as readonly IdempotencyRecord[],
    events: asArray(value['events']).filter(isRuntimeEvent) as unknown as RuntimeDocument['events'],
  }
}

function normalize(raw: Readonly<Record<string, unknown>>): ChatDocument {
  const version = asNum(raw['schema_version'], VERSION)
  if (version > VERSION)
    throw new AgentError({
      code: ErrorCode.STORAGE_SCHEMA_UNSUPPORTED,
      message: `chat schema_version ${version} is too new`,
      source: 'chat',
    })
  return {
    ...raw,
    schema_version: VERSION,
    conversations: asArray(raw['conversations'])
      .map(normalizeConversation)
      .filter((v): v is Conversation => v !== undefined),
    messages: asArray(raw['messages'])
      .map(normalizeMessage)
      .filter((v): v is Message => v !== undefined),
    runtime: normalizeRuntime(raw['runtime']),
  }
}

export class ChatStore {
  readonly path: string
  readonly clock: Clock
  constructor(paths: AppPaths | string, clock: Clock = systemClock) {
    this.path = typeof paths === 'string' ? paths : paths.chat_path
    this.clock = clock
  }

  async read(): Promise<ChatDocument> {
    return normalize(await readJsonObject(this.path, () => ({ schema_version: VERSION })))
  }

  async initialize(): Promise<ChatDocument> {
    return this.update((doc) => doc)
  }

  async createConversation(
    title = 'New conversation',
    parentConversationId: SessionId | '' = '',
    agentType = '',
  ): Promise<Conversation> {
    const now = this.clock.now()
    const conversation: Conversation = {
      id: cryptoRandomSessionId(),
      title: title.trim() || 'New conversation',
      total_output_tokens: 0,
      last_input_tokens: 0,
      compacted_message_count: 0,
      current_turn: 0,
      status: 'active',
      parent_conversation_id: parentConversationId,
      agent_type: agentType,
      created_at: now,
      updated_at: now,
    }
    await this.update((doc) => ({ ...doc, conversations: [...doc.conversations, conversation] }))
    return conversation
  }

  async getConversation(sessionId: SessionId): Promise<Conversation> {
    const found = (await this.read()).conversations.find((c) => c.id === sessionId)
    if (!found)
      throw new AgentError({
        code: ErrorCode.SESSION_NOT_FOUND,
        message: `session not found: ${sessionId}`,
        source: 'chat',
      })
    return found
  }

  async listConversations(): Promise<readonly Conversation[]> {
    return (await this.read()).conversations
  }

  async incrementTurn(sessionId: SessionId): Promise<number> {
    const conversation = await this.getConversation(sessionId)
    return (
      await this.updateConversation(sessionId, { current_turn: conversation.current_turn + 1 })
    ).current_turn
  }

  async addMessage(
    message: Omit<Message, 'id' | 'created_at'> & Partial<Pick<Message, 'id' | 'created_at'>>,
  ): Promise<Message> {
    const full: Message = {
      ...message,
      id: message.id ?? createMessageId(),
      created_at: message.created_at ?? this.clock.now(),
    }
    await this.update((doc) => {
      const existing = doc.messages.find((m) => m.id === full.id)
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(full))
          throw new AgentError({
            code: ErrorCode.INVALID_STATE_TRANSITION,
            message: `message id collision: ${full.id}`,
            source: 'chat',
          })
        return doc
      }
      return {
        ...doc,
        messages: [...doc.messages, full],
        conversations: doc.conversations.map((c) =>
          c.id === full.conversation_id ? { ...c, updated_at: full.created_at } : c,
        ),
      }
    })
    return full
  }

  async listMessages(sessionId: SessionId): Promise<readonly Message[]> {
    return (await this.read()).messages
      .filter((m) => m.conversation_id === sessionId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
  }

  persistMessage(
    message: Omit<Message, 'id' | 'created_at'> & Partial<Pick<Message, 'id' | 'created_at'>>,
  ): Promise<Message> {
    return this.addMessage(message)
  }

  async listActiveMessages(sessionId: SessionId): Promise<readonly Message[]> {
    const all = await this.listMessages(sessionId)
    const boundaries = all.filter(
      (m) => m.subtype === MessageSubtype.COMPACT_BOUNDARY || isBoundaryMessage(m),
    )
    const boundary = boundaries.at(-1)
    if (!boundary) return all
    let metadata: Partial<CompactBoundaryContent> = {}
    try {
      const parsed: unknown = JSON.parse(boundary.content)
      if (isRecord(parsed)) metadata = parsed
    } catch {
      /* old malformed boundary: use timestamp fallback */
    }
    const ids = new Set<string>([
      ...(metadata.preserved_head_ids ?? []),
      metadata.preserved_tail_id ?? '',
      metadata.summary_msg_id ?? '',
    ])
    if (!metadata.summary_msg_id) {
      const index = all.findIndex((message) => message.id === boundary.id)
      const previous = index > 0 ? all[index - 1] : undefined
      if (previous?.subtype === MessageSubtype.COMPACT_SUMMARY) ids.add(previous.id)
    }
    const boundaryIndex = all.findIndex((m) => m.id === boundary.id)
    return all.filter((m, index) => ids.has(m.id) || index > boundaryIndex)
  }

  getActiveMessages(sessionId: SessionId): Promise<readonly Message[]> {
    return this.listActiveMessages(sessionId)
  }

  async updateConversation(
    sessionId: SessionId,
    patch: Partial<
      Pick<
        Conversation,
        | 'title'
        | 'status'
        | 'total_output_tokens'
        | 'last_input_tokens'
        | 'compacted_message_count'
        | 'current_turn'
        | 'updated_at'
      >
    >,
  ): Promise<Conversation> {
    let result: Conversation | undefined
    await this.update((doc) => ({
      ...doc,
      conversations: doc.conversations.map((c) => {
        if (c.id !== sessionId) return c
        const updated: Conversation = {
          ...c,
          ...patch,
          updated_at: patch.updated_at ?? this.clock.now(),
        }
        result = updated
        return updated
      }),
    }))
    if (!result)
      throw new AgentError({
        code: ErrorCode.SESSION_NOT_FOUND,
        message: `session not found: ${sessionId}`,
        source: 'chat',
      })
    return result
  }

  async update(mutator: (doc: ChatDocument) => ChatDocument): Promise<ChatDocument> {
    const next = await updateJsonAtomic(
      this.path,
      () => ({ schema_version: VERSION }),
      (raw) => mutator(normalize(raw)) as unknown as Readonly<Record<string, unknown>>,
    )
    return normalize(next)
  }

  async createTurn(turn: PersistedTurn): Promise<void> {
    await this.update((doc) => {
      const existing = doc.runtime.turns.find((t) => t.turnId === turn.turnId)
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(turn))
          throw new AgentError({
            code: ErrorCode.INVALID_STATE_TRANSITION,
            message: `turn id collision: ${turn.turnId}`,
            source: 'chat',
          })
        return doc
      }
      const busy = doc.runtime.turns.some(
        (t) => t.sessionId === turn.sessionId && ACTIVE_PHASES.has(t.phase),
      )
      if (busy)
        throw new AgentError({
          code: ErrorCode.SESSION_BUSY,
          message: 'session already has an active turn',
          source: 'chat',
        })
      return {
        ...doc,
        runtime: {
          ...doc.runtime,
          revision: doc.runtime.revision + 1,
          turns: [...doc.runtime.turns, turn],
        },
      }
    })
  }

  async appendCompaction(
    summary: Message,
    boundary: Message,
    compactedCount: number,
  ): Promise<void> {
    await this.update((doc) => {
      if (doc.messages.some((m) => m.id === boundary.id)) return doc
      return {
        ...doc,
        messages: [...doc.messages, summary, boundary],
        conversations: doc.conversations.map((c) =>
          c.id === summary.conversation_id
            ? {
                ...c,
                compacted_message_count: c.compacted_message_count + compactedCount,
                updated_at: boundary.created_at,
              }
            : c,
        ),
      }
    })
  }

  async appendEvent(event: RuntimeEventEnvelope): Promise<void> {
    await this.update((doc) => {
      const existing = doc.runtime.events.find((e) => e.eventId === event.eventId)
      if (existing) {
        if (
          JSON.stringify(existing.data) !== JSON.stringify(event.data) ||
          existing.type !== event.type
        )
          throw new AgentError({
            code: ErrorCode.INVALID_STATE_TRANSITION,
            message: `event id collision: ${event.eventId}`,
            source: 'chat',
          })
        return doc
      }
      return {
        ...doc,
        runtime: {
          ...doc.runtime,
          revision: doc.runtime.revision + 1,
          events: [...doc.runtime.events, event],
        },
      }
    })
  }

  /** Atomically allocates a turn number and persists its user message/turn. */
  async beginTurn(
    sessionId: SessionId,
    prompt: string,
    principalId: string,
    budget: PersistedTurn['budget'],
    workingMemory: PersistedTurn['workingMemory'],
    now = this.clock.now(),
  ): Promise<PersistedTurn> {
    let created: PersistedTurn | undefined
    await this.update((doc) => {
      const conversation = doc.conversations.find((c) => c.id === sessionId)
      if (!conversation)
        throw new AgentError({
          code: ErrorCode.SESSION_NOT_FOUND,
          message: `session not found: ${sessionId}`,
          source: 'chat',
        })
      if (doc.runtime.turns.some((t) => t.sessionId === sessionId && ACTIVE_PHASES.has(t.phase)))
        throw new AgentError({
          code: ErrorCode.SESSION_BUSY,
          message: 'session already has an active turn',
          source: 'chat',
        })
      const turnNumber = conversation.current_turn + 1
      const turnId = createTurnId(sessionId, turnNumber)
      const user = {
        id: createMessageId(),
        conversation_id: sessionId,
        role: MessageRole.USER,
        content: prompt,
        created_at: now,
        turn_id: turnId,
        subtype: MessageSubtype.NORMAL,
        tool_call_id: null,
        meta: '{}',
        agent_type: '',
      } as Message
      const turn: PersistedTurn = {
        sessionId,
        turnId,
        turnNumber,
        phase: TurnPhase.STARTING,
        createdAt: now,
        updatedAt: now,
        principalId,
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
        workingMemory,
      }
      created = turn
      return {
        ...doc,
        conversations: doc.conversations.map((c) =>
          c.id === sessionId ? { ...c, current_turn: turnNumber, updated_at: now } : c,
        ),
        messages: [...doc.messages, user],
        runtime: {
          ...doc.runtime,
          revision: doc.runtime.revision + 1,
          turns: [...doc.runtime.turns, turn],
        },
      }
    })
    return created!
  }
  async updateTurn(
    sessionId: SessionId,
    turnId: TurnId,
    patch: Partial<PersistedTurn>,
  ): Promise<PersistedTurn> {
    let result: PersistedTurn | undefined
    await this.update((doc) => ({
      ...doc,
      runtime: {
        ...doc.runtime,
        revision: doc.runtime.revision + 1,
        turns: doc.runtime.turns.map((t) => {
          if (t.sessionId !== sessionId || t.turnId !== turnId) return t
          if (patch.phase && patch.phase !== t.phase && !canTransition(t.phase, patch.phase))
            throw new AgentError({
              code: ErrorCode.INVALID_STATE_TRANSITION,
              message: `${t.phase} -> ${patch.phase}`,
              source: 'chat',
            })
          result = { ...t, ...patch }
          return result
        }),
      },
    }))
    if (!result)
      throw new AgentError({
        code: ErrorCode.SESSION_NOT_FOUND,
        message: `turn not found: ${turnId}`,
        source: 'chat',
      })
    return result
  }
  async getTurn(sessionId: SessionId, turnId: TurnId): Promise<PersistedTurn> {
    const t = (await this.read()).runtime.turns.find(
      (v) => v.sessionId === sessionId && v.turnId === turnId,
    )
    if (!t)
      throw new AgentError({
        code: ErrorCode.SESSION_NOT_FOUND,
        message: `turn not found: ${turnId}`,
        source: 'chat',
      })
    return t
  }

  async addPermissionRequest(request: PermissionRequest): Promise<void> {
    await this.update((doc) => ({
      ...doc,
      runtime: {
        ...doc.runtime,
        revision: doc.runtime.revision + 1,
        permission_requests: [
          ...doc.runtime.permission_requests.filter((r) => r.request_id !== request.request_id),
          request,
        ],
      },
    }))
  }
  async resolvePermission(
    requestId: string,
    resolution: PermissionResolution,
    resolvedAt = this.clock.now(),
  ): Promise<void> {
    const status =
      resolution.decision === 'allow'
        ? PermissionRequestStatus.APPROVED
        : /timeout|expired/i.test(resolution.reason ?? '')
          ? PermissionRequestStatus.EXPIRED
          : /cancel/i.test(resolution.reason ?? '')
            ? PermissionRequestStatus.CANCELLED
            : PermissionRequestStatus.DENIED
    await this.update((doc) => {
      const request = doc.runtime.permission_requests.find((r) => r.request_id === requestId)
      if (!request)
        throw new AgentError({
          code: ErrorCode.SESSION_NOT_FOUND,
          message: `permission request not found: ${requestId}`,
          source: 'chat',
        })
      if (
        request.status === PermissionRequestStatus.APPROVED ||
        request.status === PermissionRequestStatus.DENIED ||
        request.status === PermissionRequestStatus.EXPIRED ||
        request.status === PermissionRequestStatus.CANCELLED
      ) {
        const prior = doc.runtime.permission_resolutions.find((r) => r.requestId === requestId)
        if (prior && JSON.stringify(prior.resolution) === JSON.stringify(resolution)) return doc
        throw new AgentError({
          code: ErrorCode.INVALID_STATE_TRANSITION,
          message: `permission request already resolved: ${requestId}`,
          source: 'chat',
        })
      }
      return {
        ...doc,
        runtime: {
          ...doc.runtime,
          revision: doc.runtime.revision + 1,
          permission_requests: doc.runtime.permission_requests.map((r) =>
            r.request_id === requestId
              ? {
                  ...r,
                  status,
                  resolution: resolution.reason ?? resolution.decision,
                  resolved_by: resolution.resolvedBy,
                  resolved_at: Date.parse(resolvedAt) || Date.now(),
                }
              : r,
          ),
          permission_resolutions: [
            ...doc.runtime.permission_resolutions.filter((r) => r.requestId !== requestId),
            { requestId, resolution, resolvedAt },
          ],
        },
      }
    })
  }
  async listPermissionRequests(sessionId?: SessionId): Promise<readonly PermissionRequest[]> {
    const values = (await this.read()).runtime.permission_requests
    return sessionId ? values.filter((r) => r.session_id === sessionId) : values
  }

  async addToolExecution(record: PersistedToolExecution): Promise<void> {
    await this.update((doc) => ({
      ...doc,
      runtime: {
        ...doc.runtime,
        revision: doc.runtime.revision + 1,
        tool_executions: [
          ...doc.runtime.tool_executions.filter((r) => r.executionId !== record.executionId),
          record,
        ],
      },
    }))
  }
  async updateToolExecution(
    executionId: string,
    patch: Partial<PersistedToolExecution>,
  ): Promise<void> {
    await this.update((doc) => ({
      ...doc,
      runtime: {
        ...doc.runtime,
        revision: doc.runtime.revision + 1,
        tool_executions: doc.runtime.tool_executions.map((r) =>
          r.executionId === executionId ? { ...r, ...patch } : r,
        ),
      },
    }))
  }
  async findToolExecution(
    toolCallId: string,
    inputHash: string,
  ): Promise<PersistedToolExecution | undefined> {
    return (await this.read()).runtime.tool_executions.find(
      (r) => r.toolCallId === toolCallId && r.inputHash === inputHash,
    )
  }

  async listToolExecutions(sessionId?: SessionId): Promise<readonly PersistedToolExecution[]> {
    const values = (await this.read()).runtime.tool_executions
    return sessionId ? values.filter((r) => r.sessionId === sessionId) : values
  }

  async putIdempotency(record: IdempotencyRecord): Promise<void> {
    await this.update((doc) => ({
      ...doc,
      runtime: {
        ...doc.runtime,
        idempotency: [...doc.runtime.idempotency.filter((r) => r.key !== record.key), record],
      },
    }))
  }

  async getIdempotency(key: string): Promise<IdempotencyRecord | undefined> {
    return (await this.read()).runtime.idempotency.find((r) => r.key === key)
  }

  async recover(): Promise<RecoverySnapshot> {
    const doc = await this.read()
    const now = this.clock.nowMs()
    const expired = doc.runtime.permission_requests.filter(
      (r) =>
        (r.status === PermissionRequestStatus.CREATED ||
          r.status === PermissionRequestStatus.PENDING_USER_APPROVAL) &&
        r.expires_at <= now,
    )
    if (expired.length) {
      await this.update((current) => ({
        ...current,
        runtime: {
          ...current.runtime,
          permission_requests: current.runtime.permission_requests.map((r) =>
            expired.some((e) => e.request_id === r.request_id)
              ? {
                  ...r,
                  status: PermissionRequestStatus.EXPIRED,
                  resolved_by: 'system',
                  resolved_at: now,
                  resolution: 'expired',
                }
              : r,
          ),
        },
      }))
    }
    const unknown = doc.runtime.tool_executions
      .filter((r) => r.status === ToolExecutionStatus.RUNNING)
      .map((r) => ({ ...r, status: ToolExecutionStatus.UNKNOWN, finishedAt: this.clock.now() }))
    if (unknown.length > 0)
      await this.update((current) => ({
        ...current,
        runtime: {
          ...current.runtime,
          tool_executions: current.runtime.tool_executions.map(
            (r) => unknown.find((u) => u.executionId === r.executionId) ?? r,
          ),
        },
      }))
    const allUnknown = doc.runtime.tool_executions.filter(
      (r) => r.status === ToolExecutionStatus.UNKNOWN,
    )
    return {
      unfinishedTurns: doc.runtime.turns.filter((t) => ACTIVE_PHASES.has(t.phase)),
      pendingPermissions: doc.runtime.permission_requests.filter(
        (r) =>
          (!expired.some((e) => e.request_id === r.request_id) &&
            r.status === PermissionRequestStatus.CREATED) ||
          r.status === PermissionRequestStatus.PENDING_USER_APPROVAL,
      ),
      unknownExecutions: [
        ...allUnknown,
        ...unknown.filter((u) => !allUnknown.some((x) => x.executionId === u.executionId)),
      ],
    }
  }
}

function isBoundaryMessage(message: Message): boolean {
  try {
    const p: unknown = JSON.parse(message.content)
    return isRecord(p) && p['type'] === 'compact_boundary'
  } catch {
    return false
  }
}

function isRuntimeEvent(value: unknown): boolean {
  if (!isRecord(value)) return false
  return (
    typeof value['eventId'] === 'string' &&
    typeof value['sessionId'] === 'string' &&
    typeof value['sequence'] === 'number' &&
    Number.isInteger(value['sequence']) &&
    typeof value['type'] === 'string' &&
    'data' in value
  )
}
function cryptoRandomSessionId(): SessionId {
  return randomUUID() as SessionId
}
