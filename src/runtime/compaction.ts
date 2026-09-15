import { createCompactBoundaryId, createMessageId } from '../core/ids.js'
import { MessageRole, MessageSubtype, type Message } from '../core/models.js'
import { CharacterTokenEstimator } from '../core/tokens.js'
import { type WorkingMemory, type CompactSummary } from '../core/context.js'
import { type ChatStore } from '../storage/chat-store.js'

export interface CompactionPolicy {
  readonly contextWindow: number
  readonly reserveOutputTokens: number
  readonly reserveSystemTokens: number
  readonly reserveToolTokens: number
  readonly triggerRatio: number
  readonly preserveRecentMessages: number
  readonly toolResultBudgetChars: number
}
export const DEFAULT_COMPACTION_POLICY: CompactionPolicy = {
  contextWindow: 125_000,
  reserveOutputTokens: 8_000,
  reserveSystemTokens: 2_000,
  reserveToolTokens: 8_000,
  triggerRatio: 0.9,
  preserveRecentMessages: 8,
  toolResultBudgetChars: 8_000,
}
export interface Summarizer {
  summarize(input: string, memory: WorkingMemory, signal: AbortSignal): Promise<string>
}
export class ContextCompactor {
  readonly chatStore: ChatStore
  readonly estimator = new CharacterTokenEstimator()
  readonly policy: CompactionPolicy
  readonly summarizer: Summarizer | undefined
  constructor(
    chatStore: ChatStore,
    policy: Partial<CompactionPolicy> = {},
    summarizer?: Summarizer,
  ) {
    this.chatStore = chatStore
    this.policy = { ...DEFAULT_COMPACTION_POLICY, ...policy }
    this.summarizer = summarizer
  }
  shouldCompact(messages: readonly Message[], estimatedTokens?: number): boolean {
    const tokens =
      estimatedTokens ?? this.estimator.estimate(messages.map((m) => m.content).join('\n'))
    const usable =
      this.policy.contextWindow -
      this.policy.reserveOutputTokens -
      this.policy.reserveSystemTokens -
      this.policy.reserveToolTokens
    return tokens >= Math.floor(usable * this.policy.triggerRatio)
  }
  async compact(
    sessionId: Parameters<ChatStore['listMessages']>[0],
    memory: WorkingMemory,
    signal: AbortSignal,
    force = false,
  ): Promise<CompactSummary | undefined> {
    const messages = await this.chatStore.listActiveMessages(sessionId)
    if (messages.length <= this.policy.preserveRecentMessages && !force) return undefined
    const estimated = this.estimator.estimate(messages.map((m) => m.content).join('\n'))
    const usable =
      this.policy.contextWindow -
      this.policy.reserveOutputTokens -
      this.policy.reserveSystemTokens -
      this.policy.reserveToolTokens
    if (!force && estimated < usable * this.policy.triggerRatio) return undefined
    let keepStart = Math.max(0, messages.length - this.policy.preserveRecentMessages)
    while (keepStart > 0 && messages[keepStart]?.role === MessageRole.TOOL) keepStart--
    const keep = messages.slice(keepStart)
    const old = messages.slice(0, keepStart)
    if (old.length === 0) return undefined
    const input = old
      .map((m) => `${m.role}: ${m.content.slice(0, this.policy.toolResultBudgetChars)}`)
      .join('\n')
    const summaryText =
      (await this.summarizer?.summarize(input, memory, signal)) ?? deterministicSummary(old, memory)
    const boundaryId = createCompactBoundaryId()
    const summaryCreatedAt = this.chatStore.clock.now()
    const summary = {
      id: createMessageId(),
      conversation_id: sessionId,
      role: MessageRole.SYSTEM,
      content: JSON.stringify({
        type: 'compact_summary',
        schema_version: 1,
        summary: summaryText,
        summarized_count: old.length,
      }),
      turn_id: '',
      created_at: summaryCreatedAt,
      subtype: MessageSubtype.COMPACT_SUMMARY,
      tool_call_id: null,
      meta: '{}',
      agent_type: '',
    } as Message
    const tokensAfter = this.estimator.estimate(summaryText + keep.map((m) => m.content).join('\n'))
    const boundary = {
      id: createMessageId(),
      conversation_id: sessionId,
      role: MessageRole.SYSTEM,
      content: JSON.stringify({
        type: 'compact_boundary',
        schema_version: 1,
        boundary_id: boundaryId,
        source_range_from: old[0]!.id,
        source_range_to: old.at(-1)!.id,
        // New boundaries carry explicit IDs for every preserved message.  The
        // field name is retained for old readers; including the full recent
        // window prevents a second compaction from silently dropping messages.
        preserved_head_ids: keep.map((m) => m.id),
        preserved_tail_id: keep.at(-1)!.id,
        summary_msg_id: summary.id,
        strategy: 'autocompact_v1',
        tokens_before: estimated,
        tokens_after: tokensAfter,
      }),
      turn_id: '',
      created_at: new Date(Date.parse(summaryCreatedAt) + 1).toISOString(),
      subtype: MessageSubtype.COMPACT_BOUNDARY,
      tool_call_id: null,
      meta: '{}',
      agent_type: '',
    } as Message
    await this.chatStore.appendCompaction(summary, boundary, old.length)
    return {
      boundaryId,
      strategy: 'autocompact_v1',
      summary: summaryText,
      tokensBefore: estimated,
      tokensAfter,
    }
  }

  compactPreflight(
    sessionId: Parameters<ChatStore['listMessages']>[0],
    memory: WorkingMemory,
    signal: AbortSignal,
  ): Promise<CompactSummary | undefined> {
    return this.compact(sessionId, memory, signal, false)
  }

  compactManual(
    sessionId: Parameters<ChatStore['listMessages']>[0],
    memory: WorkingMemory,
    signal: AbortSignal,
  ): Promise<CompactSummary | undefined> {
    return this.compact(sessionId, memory, signal, true)
  }

  compactReactive(
    sessionId: Parameters<ChatStore['listMessages']>[0],
    memory: WorkingMemory,
    signal: AbortSignal,
  ): Promise<CompactSummary | undefined> {
    return this.compact(sessionId, memory, signal, false)
  }
}
function deterministicSummary(messages: readonly Message[], memory: WorkingMemory): string {
  const parts = [
    memory.userConstraints.length ? `Constraints: ${memory.userConstraints.join('; ')}` : '',
    memory.openTasks.length ? `Open tasks: ${memory.openTasks.join('; ')}` : '',
    memory.pendingToolCalls.length
      ? `Pending tools: ${JSON.stringify(memory.pendingToolCalls)}`
      : '',
    memory.permissionDecisions.length
      ? `Permission decisions: ${JSON.stringify(memory.permissionDecisions)}`
      : '',
    memory.fileChanges.length ? `File changes: ${JSON.stringify(memory.fileChanges)}` : '',
    memory.appliedSkills.length ? `Applied skills: ${memory.appliedSkills.join('; ')}` : '',
  ].filter(Boolean)
  const body = messages
    .map((m) => `${m.role}: ${m.content}`)
    .join('\n')
    .slice(0, 12_000)
  return [...parts, body].filter(Boolean).join('\n').slice(0, 16_000)
}
