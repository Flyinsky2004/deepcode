import { MessageSubtype, type CompactSummaryContent, type Message } from '../core/models.js'
import { type ContextEnvelope, type RuntimeState } from '../core/context.js'
import { type ToolDescriptor, type PermissionMode } from '../core/tool.js'
import { renderSystemPrompt } from '../core/context.js'
import { type ChatStore } from '../storage/chat-store.js'
import { messageToApiFormat, sanitizeApiMessages } from '../storage/message-converter.js'
import { createSystemPrompt } from './prompts.js'

export interface ContextBuilderOptions {
  readonly chatStore: ChatStore
  readonly tools: () => readonly ToolDescriptor[]
  readonly skillGuidance?: () => string | undefined
}
export class ContextBuilder {
  readonly chatStore: ChatStore
  readonly tools: () => readonly ToolDescriptor[]
  readonly skillGuidance: (() => string | undefined) | undefined
  constructor(options: ContextBuilderOptions) {
    this.chatStore = options.chatStore
    this.tools = options.tools
    this.skillGuidance = options.skillGuidance
  }
  async build(
    sessionId: Parameters<ChatStore['listActiveMessages']>[0],
    mode: PermissionMode,
    runtime: RuntimeState,
  ): Promise<ContextEnvelope> {
    const active = await this.chatStore.listActiveMessages(sessionId)
    const api = sanitizeApiMessages(
      active
        .map(messageToApiFormat)
        .filter((m): m is NonNullable<ReturnType<typeof messageToApiFormat>> => m !== null),
    )
    const summary = latestSummary(active)
    const system = createSystemPrompt(
      mode,
      runtime.skillGuidance ?? this.skillGuidance?.(),
      summary?.summary,
    )
    return {
      system,
      conversation: api,
      ...(summary === undefined ? {} : { compact: summary }),
      tools: this.tools(),
      runtime,
    }
  }
}

function latestSummary(messages: readonly Message[]): ContextEnvelope['compact'] {
  const summaries = messages
    .filter(
      (m) =>
        m.subtype === MessageSubtype.COMPACT_SUMMARY || m.content.includes('"compact_summary"'),
    )
    .flatMap((m) => {
      try {
        const parsed: unknown = JSON.parse(m.content)
        if (
          typeof parsed === 'object' &&
          parsed !== null &&
          (parsed as Record<string, unknown>)['type'] === 'compact_summary'
        ) {
          const value = parsed as unknown as CompactSummaryContent
          return [
            {
              boundaryId: m.id,
              strategy: 'autocompact_v1',
              summary: value.summary,
              tokensBefore: 0,
              tokensAfter: 0,
            },
          ]
        }
        return []
      } catch {
        return []
      }
    })
  return summaries.at(-1)
}

export function renderEnvelopeSystem(envelope: ContextEnvelope): string {
  return renderSystemPrompt(envelope.system)
}
