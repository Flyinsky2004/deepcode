import { MessageSubtype, type Message } from '../core/models.js'
import { type ApiMessage, type ApiContentBlock } from '../core/provider.js'

/** 将持久化消息转为 Anthropic-compatible 的内部消息形态。 */
export function messageToApiFormat(message: Message): ApiMessage | null {
  if (
    message.subtype === MessageSubtype.PERMISSION_EVENT ||
    message.subtype === MessageSubtype.SKILL_EVENT ||
    message.subtype === MessageSubtype.COMMAND_EVENT
  )
    return null
  try {
    const parsed: unknown = JSON.parse(message.content)
    if (Array.isArray(parsed)) {
      const blocks = parsed.filter(isApiBlock)
      if (blocks.length !== parsed.length) return null
      return { role: message.role === 'assistant' ? 'assistant' : 'user', content: blocks }
    }
    if (typeof parsed === 'object' && parsed !== null) {
      const value = parsed as Record<string, unknown>
      if ('tool_use_id' in value)
        return {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: String(value['tool_use_id']),
              content: typeof value['content'] === 'string' ? value['content'] : '',
            },
          ],
        }
      if (value['type'] === 'compact_boundary') return null
      // compact summaries are promoted to ContextEnvelope.system by the context builder.
      if (value['type'] === 'compact_summary') return null
    }
  } catch {
    /* plain text is valid */
  }
  if (message.role === 'system') return null
  return { role: message.role === 'assistant' ? 'assistant' : 'user', content: message.content }
}

/** 修复崩溃/取消留下的连续 user 消息，保证协议角色交替。 */
export function sanitizeApiMessages(messages: readonly ApiMessage[]): readonly ApiMessage[] {
  if (messages.length === 0) return messages
  const cleaned: ApiMessage[] = []
  for (const message of messages) {
    if (cleaned.at(-1)?.role === 'user' && message.role === 'user') {
      const previous = cleaned.at(-1)!
      const prevBlocks: readonly ApiContentBlock[] = Array.isArray(previous.content)
        ? previous.content
        : []
      const nextBlocks: readonly ApiContentBlock[] = Array.isArray(message.content)
        ? message.content
        : []
      if (
        prevBlocks.length > 0 &&
        nextBlocks.length > 0 &&
        prevBlocks.every((b) => b.type === 'tool_result') &&
        nextBlocks.every((b) => b.type === 'tool_result')
      ) {
        cleaned[cleaned.length - 1] = { role: 'user', content: [...prevBlocks, ...nextBlocks] }
        continue
      }
      cleaned.push({ role: 'assistant', content: '[Interrupted]' })
    }
    cleaned.push(message)
  }
  return cleaned
}

function isApiBlock(value: unknown): value is ApiContentBlock {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const b = value as Record<string, unknown>
  if (b['type'] === 'text') return typeof b['text'] === 'string'
  if (b['type'] === 'thinking')
    return typeof b['thinking'] === 'string' && typeof b['signature'] === 'string'
  if (b['type'] === 'tool_use')
    return (
      typeof b['id'] === 'string' &&
      typeof b['name'] === 'string' &&
      !!b['input'] &&
      typeof b['input'] === 'object' &&
      !Array.isArray(b['input'])
    )
  if (b['type'] === 'tool_result')
    return typeof b['tool_use_id'] === 'string' && typeof b['content'] === 'string'
  return false
}

/** snake_case aliases retained for parity with the rewrite specification. */
export const message_to_api_format = messageToApiFormat
export const sanitize_api_messages = sanitizeApiMessages
