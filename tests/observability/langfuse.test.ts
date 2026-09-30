import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base'
import { SpanStatusCode, trace } from '@opentelemetry/api'

import { createSessionId, createToolCallId, createTurnId } from '../../src/core/ids.js'
import { InMemoryObservationSink, type ObservationInput } from '../../src/core/observability.js'
import { CompositeObservationSink } from '../../src/observability/composite.js'
import {
  LangfuseObservationSink,
  langfuseOptionsFromConfig,
} from '../../src/observability/langfuse.js'

const credentials = { publicKey: 'pk-lf-test', secretKey: 'sk-lf-test-secret' }
const sinks: LangfuseObservationSink[] = []
afterEach(async () => {
  await Promise.all(sinks.splice(0).map((sink) => sink.shutdown()))
})

function harness() {
  const exporter = new InMemorySpanExporter()
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
  const sink = new LangfuseObservationSink(credentials, provider)
  sinks.push(sink)
  const sessionId = createSessionId()
  const turnId = createTurnId(sessionId, 1)
  const record = (type: string, extra: Partial<ObservationInput> = {}) =>
    sink.record({ type, sessionId, turnId, ...extra })
  return { sink, exporter, provider, sessionId, turnId, record }
}

describe('Langfuse exporter', () => {
  it('读取 config.json 中的 SecretRef，凭据不完整或停用时不启用', async () => {
    const config = {
      enabled: true,
      baseUrl: 'http://localhost:3000',
      publicKeyRef: { source: 'value', key: ' pk ' },
      secretKeyRef: { source: 'value', key: ' sk ' },
      environment: 'test',
      release: 'v1',
    } as const
    await expect(langfuseOptionsFromConfig(undefined)).resolves.toBeUndefined()
    await expect(langfuseOptionsFromConfig({ ...config, enabled: false })).resolves.toBeUndefined()
    await expect(
      langfuseOptionsFromConfig({
        ...config,
        secretKeyRef: { source: 'env', key: 'DEEPCODE_NONEXISTENT_TEST_KEY' },
      }),
    ).resolves.toBeUndefined()
    await expect(
      langfuseOptionsFromConfig({
        ...config,
        secretKeyRef: { source: 'keychain', key: 'not-implemented' },
      }),
    ).resolves.toBeUndefined()
    await expect(langfuseOptionsFromConfig(config)).resolves.toEqual({
      publicKey: 'pk',
      secretKey: 'sk',
      baseUrl: 'http://localhost:3000',
      environment: 'test',
      release: 'v1',
    })
  })

  it.each([
    'file:///tmp/test',
    'https://user:password@example.com',
    'https://example.com?secret=x',
    'https://example.com#key',
  ])('拒绝非法或含凭据的 URL：%s', (baseUrl) => {
    expect(() => new LangfuseObservationSink({ ...credentials, baseUrl })).toThrow()
  })

  it('轮次隔离，模型与工具共享 trace，并正确导出用量、费用与脱敏数据', async () => {
    const globalProvider = trace.getTracerProvider()
    const { sink, record, exporter, sessionId, turnId } = harness()
    const toolCallId = createToolCallId()
    await record('turn.started', { data: { principal_id: 'local-user' } })
    await record('model.call.started', { data: { model_id: 'claude-test', max_tokens: 1024 } })
    await record('model.call.completed', {
      data: { input_tokens: 100, output_tokens: 20, cost: 0.001 },
    })
    await record('tool.execution.started', {
      toolCallId,
      data: {
        tool_name: 'bash',
        input: { command: 'echo sk-lf-secret123456', api_key: 'private-value' },
      },
    })
    await record('tool.execution.completed', {
      toolCallId,
      policyId: 'policy-1',
      data: { tool_name: 'bash', ok: true },
    })
    await record('turn.completed', { data: { status: 'completed' } })
    await sink.flush()
    const spans = exporter.getFinishedSpans()
    const root = spans.find((span) => span.name === 'deepcode.turn')!
    const model = spans.find((span) => span.name === 'deepcode.model')!
    const tool = spans.find((span) => span.name === 'bash')!
    expect(spans).toHaveLength(3)
    expect(model.parentSpanContext?.spanId).toBe(root.spanContext().spanId)
    expect(tool.spanContext().traceId).toBe(root.spanContext().traceId)
    for (const span of spans) {
      expect(span.attributes['langfuse.session.id']).toBe(sessionId)
      expect(span.attributes['langfuse.trace.metadata.turn_id']).toBe(turnId)
      expect(span.attributes['langfuse.user.id']).toBe('local-user')
    }
    expect(model.attributes['langfuse.observation.type']).toBe('generation')
    expect(model.attributes['langfuse.observation.model.name']).toBe('claude-test')
    expect(JSON.parse(model.attributes['langfuse.observation.usage_details'] as string)).toEqual({
      input: 100,
      output: 20,
    })
    expect(JSON.parse(model.attributes['langfuse.observation.cost_details'] as string)).toEqual({
      total: 0.001,
    })
    expect(tool.attributes['langfuse.observation.metadata.policy_id']).toBe('policy-1')
    expect(JSON.stringify(spans.map((span) => span.attributes))).not.toMatch(
      /private-value|sk-lf-secret123456/,
    )
    expect(trace.getTracerProvider()).toBe(globalProvider)

    const otherSession = createSessionId()
    await record('turn.started', { sessionId: otherSession })
    await record('turn.completed', { sessionId: otherSession })
    await sink.flush()
    expect(exporter.getFinishedSpans().at(-1)!.spanContext().traceId).not.toBe(
      root.spanContext().traceId,
    )
  })

  it('重试生成独立 generation，失败与取消会关闭所有模型 span', async () => {
    const { sink, record, exporter } = harness()
    await record('turn.started')
    await record('model.call.started')
    await record('model.call.failed', {
      data: { error_code: 'PROVIDER_UNAVAILABLE', message: 'Bearer abcdefghijklmnopqrstuvwxyz' },
    })
    await record('model.retry', { data: { retry: 1 } })
    await record('model.call.started')
    await record('turn.completed', { data: { status: 'cancelled' } })
    await sink.flush()
    const models = exporter.getFinishedSpans().filter((span) => span.name === 'deepcode.model')
    expect(models).toHaveLength(2)
    expect(models[0]!.status.code).toBe(SpanStatusCode.ERROR)
    expect(models[0]!.status.message).toBe('[redacted]')
    expect(models[1]!.attributes['langfuse.observation.level']).toBe('WARNING')
    expect(exporter.getFinishedSpans().at(-1)!.attributes['langfuse.observation.level']).toBe(
      'WARNING',
    )
  })

  it('background 子代理在父 turn 完成后仍接续原 trace', async () => {
    const { sink, record, exporter } = harness()
    const childSession = createSessionId()
    const childTurn = createTurnId(childSession, 1)
    await record('turn.started')
    await record('subagent.started', {
      subagentSessionId: childSession,
      data: { agent_type: 'explore' },
    })
    await record('turn.completed', { data: { status: 'completed' } })
    await record('turn.started', { sessionId: childSession, turnId: childTurn })
    await record('model.call.started', { sessionId: childSession, turnId: childTurn })
    await record('model.call.completed', { sessionId: childSession, turnId: childTurn })
    await record('turn.completed', { sessionId: childSession, turnId: childTurn })
    await record('subagent.completed', {
      subagentSessionId: childSession,
      data: { status: 'completed' },
    })
    await sink.flush()
    const spans = exporter.getFinishedSpans()
    expect(spans).toHaveLength(4)
    expect(new Set(spans.map((span) => span.spanContext().traceId)).size).toBe(1)
    const subagent = spans.find((span) => span.name === 'subagent:explore')!
    const child = spans.find(
      (span) =>
        span.attributes['langfuse.trace.metadata.turn_id'] === childTurn &&
        span.name === 'deepcode.turn',
    )!
    expect(child.parentSpanContext?.spanId).toBe(subagent.spanContext().spanId)
  })

  it('flush 不结束活动 turn；shutdown 幂等且停止接受记录', async () => {
    const { sink, record, exporter, provider } = harness()
    await record('turn.started')
    await record('model.call.started')
    await sink.flush()
    expect(exporter.getFinishedSpans()).toHaveLength(0)
    const shutdown = vi.spyOn(provider, 'shutdown')
    await sink.shutdown()
    await sink.shutdown()
    await record('turn.started')
    expect(shutdown).toHaveBeenCalledTimes(1)
  })

  it('远端同步抛错、异步拒绝都不阻止本地记录和关闭', async () => {
    const local = new InMemoryObservationSink()
    const shutdown = vi.fn(() => Promise.reject(new Error('offline')))
    const composite = new CompositeObservationSink([
      {
        record: () => {
          throw new Error('synchronous failure')
        },
        flush: () => Promise.reject(new Error('offline')),
        shutdown,
      },
      local,
    ])
    await expect(composite.record({ type: 'model.call.completed' })).resolves.toBeUndefined()
    await expect(composite.flush()).resolves.toBeUndefined()
    await expect(composite.shutdown()).resolves.toBeUndefined()
    expect(local.records).toHaveLength(1)
    expect(shutdown).toHaveBeenCalledTimes(1)
  })
})
