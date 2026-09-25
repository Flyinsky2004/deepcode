import { readFile } from 'node:fs/promises'

import { AgentError, ErrorCode, toAgentError } from '../core/errors.js'
import { withTimeout } from '../core/abort.js'
import {
  type ModelEvent,
  ModelEventType,
  type ModelProvider,
  type ModelStream,
  type ModelRequest,
  type Provider,
  type ProviderProbeResult,
  type TokenUsage,
} from '../core/provider.js'

export interface SecretResolver {
  resolve(ref: Provider['apiKeyRef']): Promise<string | undefined>
}
export interface AnthropicProviderOptions {
  readonly provider: Provider
  readonly resolveSecret?: SecretResolver
  readonly fetchImpl?: typeof fetch
  readonly timeoutMs?: number
  readonly apiVersion?: string
}

const defaultResolver: SecretResolver = {
  async resolve(ref) {
    if (ref.source === 'env') return process.env[ref.key]
    if (ref.source === 'file') return (await readFile(ref.key, 'utf8')).trim()
    if (ref.source === 'value') return ref.key
    return undefined
  },
}

export class AnthropicMessagesProvider implements ModelProvider {
  readonly provider: Provider
  readonly resolveSecret: SecretResolver
  readonly fetchImpl: typeof fetch
  readonly timeoutMs: number
  readonly apiVersion: string
  #lastUsage: TokenUsage | undefined

  constructor(options: AnthropicProviderOptions) {
    this.provider = options.provider
    this.resolveSecret = options.resolveSecret ?? defaultResolver
    this.fetchImpl = options.fetchImpl ?? fetch
    this.timeoutMs = options.timeoutMs ?? 120_000
    this.apiVersion = options.apiVersion ?? '2023-06-01'
  }

  get lastUsage(): TokenUsage | undefined {
    return this.#lastUsage
  }

  stream(request: ModelRequest, signal: AbortSignal): ModelStream {
    const generator = this.streamGenerator.bind(this)
    let usage: TokenUsage | undefined
    return {
      get usage() {
        return usage
      },
      [Symbol.asyncIterator]() {
        return generator(request, signal, (value) => {
          usage = value
        })
      },
    } as ModelStream
  }

  private async *streamGenerator(
    request: ModelRequest,
    signal: AbortSignal,
    setUsage: (usage: TokenUsage) => void,
  ): AsyncGenerator<ModelEvent> {
    if (request.thinking && request.maxTokens <= request.thinking.budgetTokens)
      throw new AgentError({
        code: ErrorCode.VALIDATION_FAILED,
        message: 'maxTokens must be greater than thinking budget',
        source: 'anthropic',
      })
    const key = await this.resolveSecret.resolve(this.provider.apiKeyRef)
    if (!key)
      throw new AgentError({
        code: ErrorCode.PROVIDER_AUTH_FAILED,
        message: 'provider secret is unavailable',
        source: 'anthropic',
      })
    const timeout = withTimeout(signal, this.timeoutMs)
    try {
      const response = await this.fetchImpl(
        `${this.provider.baseUrl.replace(/\/+$/, '')}/v1/messages`,
        {
          method: 'POST',
          signal: timeout.signal,
          headers: {
            'content-type': 'application/json',
            'anthropic-version': this.apiVersion,
            'x-api-key': key,
          },
          body: JSON.stringify({
            model: request.model,
            max_tokens: request.maxTokens,
            stream: true,
            messages: request.messages,
            ...(request.system === undefined ? {} : { system: request.system }),
            ...(request.tools && request.tools.length > 0
              ? {
                  tools: request.tools.map(({ name, description, input_schema }) => ({
                    name,
                    description,
                    input_schema,
                  })),
                }
              : {}),
            ...(request.thinking
              ? { thinking: { type: 'enabled', budget_tokens: request.thinking.budgetTokens } }
              : {}),
          }),
        },
      )
      if (!response.ok) throw await httpError(response)
      if (!response.body)
        throw new AgentError({
          code: ErrorCode.PROVIDER_STREAM_INVALID,
          message: 'provider returned no stream body',
          source: 'anthropic',
        })
      let inputTokens = 0
      let outputTokens = 0
      let sawStart = false
      let sawStop = false
      const blocks = new Map<
        number,
        {
          type: string
          id?: string
          name?: string
          text: string
          json: string
          signature: string
          input?: Readonly<Record<string, unknown>>
        }
      >()
      for await (const event of parseSse(response.body)) {
        const type = typeof event['type'] === 'string' ? event['type'] : ''
        if (type === 'message_start') {
          sawStart = true
          inputTokens = readUsage(event['message'], 'input_tokens')
        }
        if (type === 'message_delta') outputTokens = readUsage(event['usage'], 'output_tokens')
        if (type === 'content_block_start') {
          const index = typeof event['index'] === 'number' ? event['index'] : blocks.size
          const block = isRecord(event['content_block']) ? event['content_block'] : {}
          const blockType = typeof block['type'] === 'string' ? block['type'] : ''
          if (!['text', 'thinking', 'tool_use'].includes(blockType) || blocks.has(index))
            throw new AgentError({
              code: ErrorCode.PROVIDER_STREAM_INVALID,
              message: 'invalid or duplicate content block',
              source: 'anthropic',
            })
          blocks.set(index, {
            type: blockType,
            ...(typeof block['id'] === 'string' ? { id: block['id'] } : {}),
            ...(typeof block['name'] === 'string' ? { name: block['name'] } : {}),
            text: typeof block['thinking'] === 'string' ? block['thinking'] : '',
            json: '',
            signature: typeof block['signature'] === 'string' ? block['signature'] : '',
            ...(isRecord(block['input']) ? { input: block['input'] } : {}),
          })
        }
        if (type === 'content_block_delta') {
          const index = typeof event['index'] === 'number' ? event['index'] : 0
          const block = blocks.get(index)
          const delta = isRecord(event['delta']) ? event['delta'] : {}
          if (!block) continue
          if (delta['type'] === 'text_delta' && typeof delta['text'] === 'string')
            yield { type: ModelEventType.TEXT, content: delta['text'] }
          else if (delta['type'] === 'thinking_delta' && typeof delta['thinking'] === 'string')
            block.text += delta['thinking']
          else if (delta['type'] === 'signature_delta' && typeof delta['signature'] === 'string')
            block.signature += delta['signature']
          else if (
            delta['type'] === 'input_json_delta' &&
            typeof delta['partial_json'] === 'string'
          )
            block.json += delta['partial_json']
        }
        if (type === 'content_block_stop') {
          const index = typeof event['index'] === 'number' ? event['index'] : 0
          const block = blocks.get(index)
          if (!block) continue
          if (block.type === 'thinking')
            yield {
              type: ModelEventType.THINKING,
              thinking: block.text,
              signature: block.signature,
            }
          if (block.type === 'tool_use' && block.id && block.name) {
            let input: Readonly<Record<string, unknown>> = {}
            try {
              const parsed: unknown = block.json ? JSON.parse(block.json) : (block.input ?? {})
              if (isRecord(parsed)) input = parsed
            } catch (cause) {
              throw new AgentError(
                {
                  code: ErrorCode.PROVIDER_STREAM_INVALID,
                  message: 'tool input JSON is invalid',
                  source: 'anthropic',
                },
                { cause },
              )
            }
            yield { type: ModelEventType.TOOL_USE, id: block.id, name: block.name, input }
          }
        }
        if (type === 'error')
          throw new AgentError({
            code: ErrorCode.PROVIDER_STREAM_INVALID,
            message: 'provider stream reported an error',
            source: 'anthropic',
          })
        if (type === 'message_stop') sawStop = true
      }
      if (!sawStart || !sawStop)
        throw new AgentError({
          code: ErrorCode.PROVIDER_STREAM_INVALID,
          message: 'provider stream ended without message_start/message_stop',
          source: 'anthropic',
        })
      this.#lastUsage = { inputTokens, outputTokens }
      setUsage(this.#lastUsage)
    } catch (error) {
      if (AgentError.is(error)) throw error
      if (error instanceof Error && error.name === 'AbortError') throw error
      if (error instanceof TypeError)
        throw new AgentError(
          {
            code: ErrorCode.PROVIDER_CONNECTION_FAILED,
            message: 'provider connection failed',
            source: 'anthropic',
          },
          { cause: error },
        )
      throw toAgentError(error, 'anthropic')
    } finally {
      timeout.cleanup()
    }
  }

  async probe(signal: AbortSignal): Promise<ProviderProbeResult> {
    try {
      const stream = this.stream(
        {
          model: 'probe',
          maxTokens: 32,
          messages: [{ role: 'user', content: 'ping' }],
          thinking: { type: 'enabled', budgetTokens: 8 },
          tools: [
            {
              name: 'probe_tool',
              description: 'Probe tool',
              input_schema: { type: 'object', properties: {} },
              version: '1',
              risk_level: 'low',
              capabilities: [],
              source: { kind: 'native' },
            },
          ],
        },
        signal,
      )
      let sawTool = false
      let sawThinking = false
      for await (const event of stream) {
        sawTool ||= event.type === ModelEventType.TOOL_USE
        sawThinking ||= event.type === ModelEventType.THINKING
      }
      return {
        ok: true,
        capabilities: {
          streaming: true,
          tools: sawTool,
          thinking: sawThinking,
          usage: this.#lastUsage !== undefined,
        },
      }
    } catch (error) {
      const e = toAgentError(error, 'anthropic')
      return {
        ok: false,
        errorCode: e.code,
        message: e.message,
        capabilities: { streaming: false, tools: false, thinking: false, usage: false },
      }
    }
  }
}

async function httpError(response: Response): Promise<AgentError> {
  let body = ''
  try {
    body = await response.text()
  } catch {
    /* ignore */
  }
  const code =
    response.status === 401 || response.status === 403
      ? ErrorCode.PROVIDER_AUTH_FAILED
      : response.status === 429
        ? ErrorCode.PROVIDER_RATE_LIMITED
        : response.status >= 500
          ? ErrorCode.PROVIDER_UNAVAILABLE
          : response.status === 400 && /context|too many tokens|maximum.*token/i.test(body)
            ? ErrorCode.CONTEXT_EXCEEDED
            : response.status === 400
              ? ErrorCode.PROVIDER_STREAM_INVALID
              : ErrorCode.PROVIDER_CONNECTION_FAILED
  const retryAfter = Number.parseInt(response.headers.get('retry-after') ?? '', 10)
  return new AgentError({
    code,
    message: `provider HTTP ${response.status}`,
    source: 'anthropic',
    ...(Number.isFinite(retryAfter) ? { retryAfterMs: retryAfter * 1000 } : {}),
    context: { status: response.status, provider_body_present: body.length > 0 },
  })
}

async function* parseSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      buffer += decoder.decode(next.value, { stream: true })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data === '[DONE]') return
        try {
          const parsed: unknown = JSON.parse(data)
          if (isRecord(parsed)) yield parsed
        } catch {
          throw new AgentError({
            code: ErrorCode.PROVIDER_STREAM_INVALID,
            message: 'invalid SSE payload',
            source: 'anthropic',
          })
        }
      }
    }
    buffer += decoder.decode()
    if (buffer.startsWith('data:')) {
      const data = buffer.slice(5).trim()
      if (data !== '[DONE]') {
        try {
          const parsed: unknown = JSON.parse(data)
          if (isRecord(parsed)) yield parsed
        } catch (cause) {
          throw new AgentError(
            {
              code: ErrorCode.PROVIDER_STREAM_INVALID,
              message: 'invalid SSE payload',
              source: 'anthropic',
            },
            { cause },
          )
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function readUsage(value: unknown, field: 'input_tokens' | 'output_tokens'): number {
  const usage = isRecord(value) && isRecord(value['usage']) ? value['usage'] : value
  return isRecord(usage) && typeof usage[field] === 'number' && Number.isFinite(usage[field])
    ? usage[field]
    : 0
}
