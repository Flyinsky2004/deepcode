import { LangfuseSpanProcessor } from '@langfuse/otel'
import { ROOT_CONTEXT, SpanStatusCode, trace, type Span, type Tracer } from '@opentelemetry/api'
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base'

import type { ObservationInput, ObservationSink } from '../core/observability.js'
import type { StoredLangfuse } from '../storage/types.js'
import { defaultSecretResolver, type SecretResolver } from '../providers/secrets.js'
import { DEFAULT_PREVIEW_CHARS, previewText, sanitizeRecord, sanitizeValue } from './sanitize.js'

function textValue(data: Readonly<Record<string, unknown>>, key: string): string {
  return typeof data[key] === 'string' ? data[key] : ''
}

function boundedJson(value: unknown): string {
  const serialized = JSON.stringify(value) ?? ''
  return serialized.length <= DEFAULT_PREVIEW_CHARS
    ? serialized
    : JSON.stringify(previewText(serialized))
}

export interface LangfuseOptions {
  readonly publicKey: string
  readonly secretKey: string
  readonly baseUrl?: string
  readonly environment?: string
  readonly release?: string
}

export interface LangfuseStatus {
  readonly enabled: boolean
  readonly reason: string
  readonly baseUrl?: string
}

export async function langfuseOptionsFromConfig(
  configuration: StoredLangfuse | undefined,
  resolver: SecretResolver = defaultSecretResolver,
): Promise<LangfuseOptions | undefined> {
  if (configuration === undefined || !configuration.enabled) return undefined
  const [publicKey, secretKey] = await Promise.all([
    resolver.resolve(configuration.publicKeyRef),
    resolver.resolve(configuration.secretKeyRef),
  ])
  if (!publicKey?.trim() || !secretKey?.trim()) return undefined
  return {
    publicKey: publicKey.trim(),
    secretKey: secretKey.trim(),
    baseUrl: configuration.baseUrl,
    environment: configuration.environment ?? 'development',
    release: configuration.release ?? 'local',
  }
}

interface TurnSpans {
  readonly root: Span
  readonly children: Map<string, Span>
  readonly userId: string | undefined
  completed: boolean
}

/**
 * 把 runtime 的观测协议映射为 Langfuse OTEL spans。
 * 每个实例持有独立 provider，不修改进程的全局 OTEL provider/context manager。
 */
export class LangfuseObservationSink implements ObservationSink {
  readonly baseUrl: string
  readonly #provider: BasicTracerProvider
  readonly #tracer: Tracer
  readonly #turns = new Map<string, TurnSpans>()
  readonly #subagents = new Map<string, Span>()
  #shutdown: Promise<void> | undefined

  constructor(options: LangfuseOptions, provider?: BasicTracerProvider) {
    if (!options.publicKey.trim() || !options.secretKey.trim())
      throw new Error('Langfuse requires public and secret keys')
    const url = new URL(options.baseUrl ?? 'https://cloud.langfuse.com')
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error(
        'Langfuse base URL must be an HTTP(S) URL without credentials, query or fragment',
      )
    this.baseUrl = url.toString().replace(/\/+$/u, '')
    this.#provider =
      provider ??
      new BasicTracerProvider({
        spanProcessors: [
          new LangfuseSpanProcessor({
            publicKey: options.publicKey.trim(),
            secretKey: options.secretKey.trim(),
            baseUrl: this.baseUrl,
            ...(options.environment === undefined ? {} : { environment: options.environment }),
            ...(options.release === undefined ? {} : { release: options.release }),
            timeout: 5,
            mediaUploadEnabled: false,
            shouldExportSpan: ({ otelSpan }) => otelSpan.instrumentationScope.name === 'deepcode',
            mask: ({ data }) => sanitizeValue(data),
          }),
        ],
      })
    this.#tracer = this.#provider.getTracer('deepcode')
  }

  record(input: ObservationInput): Promise<void> {
    if (this.#shutdown !== undefined) return Promise.resolve()
    try {
      this.recordSpan(input)
    } catch {
      // 观测序列化或 SDK 异常不进入 turn 主链路。
    }
    return Promise.resolve()
  }

  private recordSpan(input: ObservationInput): void {
    const data = sanitizeRecord(input.data ?? {})
    const now = Date.now()
    const turnKey = JSON.stringify([input.sessionId, input.turnId])
    let turn = this.#turns.get(turnKey)
    if (input.turnId !== undefined && turn === undefined) {
      const root = this.start(
        'deepcode.turn',
        'agent',
        input,
        this.#subagents.get(input.sessionId ?? ''),
        now - (input.elapsedMs ?? 0),
      )
      turn = {
        root,
        children: new Map(),
        userId: typeof data['principal_id'] === 'string' ? data['principal_id'] : undefined,
        completed: false,
      }
      this.#turns.set(turnKey, turn)
    }

    if (input.type === 'turn.started') {
      if (turn) this.update(turn.root, data)
      return
    }
    if (input.type === 'turn.completed' && turn) {
      for (const [key, span] of turn.children) {
        // background 子代理允许晚于父 turn 完成，保留原 trace 的关联。
        if (key.startsWith('subagent:')) continue
        span.setAttribute('langfuse.observation.level', 'WARNING')
        span.setAttribute(
          'langfuse.observation.status_message',
          'turn ended before operation completed',
        )
        span.end(now)
        turn.children.delete(key)
      }
      this.update(turn.root, data)
      turn.root.end(now)
      turn.completed = true
      if (turn.children.size === 0) this.#turns.delete(turnKey)
      return
    }

    const model = input.type.startsWith('model.call.')
    const tool = input.type.startsWith('tool.execution.')
    const subagent = input.type.startsWith('subagent.') && input.subagentSessionId !== undefined
    if (turn && (model || tool || subagent)) {
      const childKey = model
        ? 'model'
        : tool
          ? `tool:${input.toolCallId ?? ''}`
          : `subagent:${input.subagentSessionId ?? ''}`
      let span = turn.children.get(childKey)
      if (span === undefined) {
        const name = model
          ? 'deepcode.model'
          : tool
            ? textValue(data, 'tool_name') || 'deepcode.tool'
            : `subagent:${textValue(data, 'agent_type')}`
        span = this.start(
          name,
          model ? 'generation' : tool ? 'tool' : 'agent',
          input,
          turn.root,
          now - (input.elapsedMs ?? 0),
        )
        turn.children.set(childKey, span)
      }
      if (turn.userId !== undefined) span.setAttribute('langfuse.user.id', turn.userId)
      if (input.policyId !== undefined)
        span.setAttribute('langfuse.observation.metadata.policy_id', input.policyId)
      this.update(span, data)
      if (subagent && input.type === 'subagent.started')
        this.#subagents.set(input.subagentSessionId, span)
      if (input.type.endsWith('.completed') || input.type.endsWith('.failed')) {
        if (input.type.endsWith('.failed'))
          this.markError(
            span,
            textValue(data, 'message') || textValue(data, 'error_code') || 'model call failed',
          )
        span.end(now)
        turn.children.delete(childKey)
        if (subagent) this.#subagents.delete(input.subagentSessionId)
        if (turn.completed && turn.children.size === 0) this.#turns.delete(turnKey)
      }
      return
    }

    const span = this.start(input.type, 'span', input, turn?.root, now - (input.elapsedMs ?? 0))
    if (turn?.userId !== undefined) span.setAttribute('langfuse.user.id', turn.userId)
    this.update(span, data)
    span.end(now)
  }

  private start(
    name: string,
    type: string,
    input: ObservationInput,
    parent: Span | undefined,
    startTime: number,
  ): Span {
    const span = this.#tracer.startSpan(
      name,
      {
        startTime,
        attributes: {
          'langfuse.observation.type': type,
          'langfuse.trace.name': input.turnId === undefined ? name : 'deepcode.turn',
          ...(input.sessionId === undefined ? {} : { 'langfuse.session.id': input.sessionId }),
          ...(input.turnId === undefined
            ? {}
            : { 'langfuse.trace.metadata.turn_id': input.turnId }),
          ...(input.toolCallId === undefined
            ? {}
            : { 'langfuse.observation.metadata.tool_call_id': input.toolCallId }),
          ...(input.subagentSessionId === undefined
            ? {}
            : { 'langfuse.observation.metadata.subagent_session_id': input.subagentSessionId }),
          ...(input.policyId === undefined
            ? {}
            : { 'langfuse.observation.metadata.policy_id': input.policyId }),
        },
      },
      parent === undefined ? ROOT_CONTEXT : trace.setSpan(ROOT_CONTEXT, parent),
    )
    return span
  }

  private update(span: Span, data: Readonly<Record<string, unknown>>): void {
    for (const [key, value] of Object.entries(data)) {
      if (value === undefined) continue
      span.setAttribute(
        `langfuse.observation.metadata.${key}`,
        typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
          ? typeof value === 'string'
            ? previewText(value).preview
            : value
          : boundedJson(value),
      )
    }
    if (typeof data['principal_id'] === 'string')
      span.setAttribute('langfuse.user.id', data['principal_id'])
    if (typeof data['model_id'] === 'string')
      span.setAttribute('langfuse.observation.model.name', data['model_id'])
    if (data['max_tokens'] !== undefined)
      span.setAttribute(
        'langfuse.observation.model.parameters',
        JSON.stringify({
          max_tokens: data['max_tokens'],
          thinking_enabled: data['thinking_enabled'],
        }),
      )
    if (data['input_tokens'] !== undefined || data['output_tokens'] !== undefined)
      span.setAttribute(
        'langfuse.observation.usage_details',
        JSON.stringify({ input: data['input_tokens'] ?? 0, output: data['output_tokens'] ?? 0 }),
      )
    if (typeof data['cost'] === 'number' && data['cost'] > 0)
      span.setAttribute(
        'langfuse.observation.cost_details',
        JSON.stringify({ total: data['cost'] }),
      )
    if (data['input'] !== undefined)
      span.setAttribute('langfuse.observation.input', boundedJson(data['input']))
    if (
      data['ok'] === false ||
      data['status'] === 'failed' ||
      data['status'] === 'context_exceeded'
    )
      this.markError(
        span,
        String(data['message'] ?? data['error'] ?? data['error_code'] ?? data['status']),
      )
    else if (
      data['status'] === 'cancelled' ||
      data['status'] === 'partial' ||
      data['status'] === 'budget_exceeded'
    )
      span.setAttribute('langfuse.observation.level', 'WARNING')
  }

  private markError(span: Span, message: string): void {
    span.setStatus({ code: SpanStatusCode.ERROR, message })
    span.setAttribute('langfuse.observation.level', 'ERROR')
    span.setAttribute('langfuse.observation.status_message', message)
  }

  async flush(): Promise<void> {
    await this.#provider.forceFlush().catch(() => undefined)
  }

  shutdown(): Promise<void> {
    if (this.#shutdown !== undefined) return this.#shutdown
    for (const turn of this.#turns.values()) {
      for (const span of turn.children.values()) span.end()
      if (!turn.completed) {
        turn.root.setAttribute('langfuse.observation.level', 'WARNING')
        turn.root.setAttribute('langfuse.observation.status_message', 'application shutdown')
        turn.root.end()
      }
    }
    this.#turns.clear()
    this.#subagents.clear()
    this.#shutdown = this.#provider.shutdown().catch(() => undefined)
    return this.#shutdown
  }
}
