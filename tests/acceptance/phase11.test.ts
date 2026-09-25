import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { AgentApplication } from '../../src/app/agent-application.js'
import type { EventSubscriber } from '../../src/app/event-bus.js'
import { toEventDto } from '../../src/clients/web/dto.js'
import { applyEvent } from '../../src/clients/tui/events.js'
import { createInitialState } from '../../src/clients/tui/types.js'
import { AgentError, ErrorCode } from '../../src/core/errors.js'
import type { RuntimeEventEnvelope } from '../../src/core/events.js'
import {
  ModelEventType,
  type ModelProvider,
  type ModelStream,
  type Provider,
} from '../../src/core/provider.js'
import { aggregateTurnMetrics } from '../../src/observability/metrics.js'
import type { ResolvedModelRoute } from '../../src/providers/router.js'
import { ChatStore } from '../../src/storage/chat-store.js'
import { ConfigStore } from '../../src/storage/config-store.js'
import { resolveAppPaths } from '../../src/storage/paths.js'
import type { ConfigDocument } from '../../src/storage/types.js'
import { ToolRegistry } from '../../src/tools/registry.js'

const providers: readonly Provider[] = [
  {
    id: 'primary',
    name: 'Primary compatible endpoint',
    baseUrl: 'https://primary.invalid',
    apiKeyRef: { source: 'env', key: 'PRIMARY_API_KEY' },
    createdAt: '',
    updatedAt: '',
  },
  {
    id: 'fallback',
    name: 'Fallback compatible endpoint',
    baseUrl: 'https://fallback.invalid',
    apiKeyRef: { source: 'env', key: 'FALLBACK_API_KEY' },
    createdAt: '',
    updatedAt: '',
  },
]

const config = (): ConfigDocument => ({
  schema_version: 1,
  llm_channels: [],
  llm_models: [],
  app_settings: {},
  providers: providers.map((provider) => ({ ...provider, enabled: true })),
  model_profiles: [
    {
      id: 'model-a',
      providerId: 'primary',
      contextWindow: 100_000,
      maxOutputTokens: 4096,
      supportsThinking: false,
      supportsTools: true,
      supportsVision: false,
      supports1MContext: false,
      inputCostPerMillion: 1,
      outputCostPerMillion: 2,
      enabled: true,
    },
    {
      id: 'model-b',
      providerId: 'fallback',
      contextWindow: 200_000,
      maxOutputTokens: 8192,
      supportsThinking: true,
      supportsTools: true,
      supportsVision: false,
      supports1MContext: false,
      inputCostPerMillion: 2,
      outputCostPerMillion: 4,
      enabled: true,
    },
  ],
  tier_assignments: [
    {
      tier: 'implementation',
      modelRef: { providerId: 'primary', modelId: 'model-a' },
      fallbackModelRefs: [{ providerId: 'fallback', modelId: 'model-b' }],
      enabled: true,
    },
  ],
})

class Recorder implements EventSubscriber {
  readonly events: RuntimeEventEnvelope[] = []
  onEvent(event: RuntimeEventEnvelope): void {
    this.events.push(event)
  }
}

describe('Phase 11 验收：跨 provider、模型与客户端的自动门禁', () => {
  it('瞬时失败重试后跨 provider fallback，三端得到一致终态并生成完整指标', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deepcode-phase11-'))
    const paths = resolveAppPaths({ home: dir, cwd: dir })
    const configStore = new ConfigStore(paths)
    await configStore.save(config())

    let primaryCalls = 0
    let fallbackCalls = 0
    const providerFactory = (route: ResolvedModelRoute): ModelProvider => {
      if (route.provider.id === 'primary') {
        const stream: ModelStream = {
          [Symbol.asyncIterator]() {
            return {
              next: () => {
                primaryCalls += 1
                return Promise.reject(
                  new AgentError({
                    code: ErrorCode.PROVIDER_UNAVAILABLE,
                    message: 'fixture primary unavailable',
                    source: 'phase11.fixture',
                  }),
                )
              },
            }
          },
        }
        return {
          stream: () => stream,
          probe: () => Promise.resolve({ ok: true }),
        }
      }
      const stream: ModelStream = {
        usage: { inputTokens: 100, outputTokens: 50 },
        async *[Symbol.asyncIterator]() {
          await Promise.resolve()
          fallbackCalls += 1
          yield { type: ModelEventType.TEXT, content: 'fallback 完成' }
        },
      }
      return {
        stream: () => stream,
        probe: () => Promise.resolve({ ok: true }),
      }
    }

    const app = await AgentApplication.create({
      paths,
      workspaceRoot: dir,
      configStore,
      chatStore: new ChatStore(paths),
      registry: new ToolRegistry(),
      providerFactory,
    })
    const session = await app.createSession(app.localPrincipalId)
    const recorder = new Recorder()
    await app.attach(recorder, { sessionId: session.id })

    // CLI/直接调用得到 TurnResult；TUI 与 Web 都只消费同一个事件流。
    const cli = await app.submitTurn({
      principalId: app.localPrincipalId,
      sessionId: session.id,
      prompt: '执行固定回归任务',
    })
    await app.flush()

    let tui = createInitialState({ principalId: app.localPrincipalId })
    for (const event of recorder.events) tui = applyEvent(tui, event).state
    const webEvents = recorder.events.map(toEventDto)
    const webEnd = webEvents.find((event) => event.type === 'turn_end')

    expect(cli.result).toMatchObject({
      status: 'completed',
      final_text: 'fallback 完成',
      input_tokens: 100,
      output_tokens: 50,
    })
    expect(tui.lastInputTokens).toBe(cli.result.input_tokens)
    expect(tui.totalOutputTokens).toBe(cli.result.output_tokens)
    expect(webEnd?.data).toMatchObject({
      status: cli.result.status,
      final_text: cli.result.final_text,
      input_tokens: cli.result.input_tokens,
      output_tokens: cli.result.output_tokens,
    })
    expect(recorder.events.some((event) => event.type === 'model_route_changed')).toBe(true)
    expect(primaryCalls).toBe(3)
    expect(fallbackCalls).toBe(1)

    const observations = await app.observationLog!.list({
      sessionId: session.id,
      turnId: cli.turnId,
    })
    const metrics = aggregateTurnMetrics(observations)
    expect(metrics).toMatchObject({
      modelCallCount: 4,
      retryCount: 2,
      fallbackCount: 1,
      inputTokens: 100,
      cumulativeInputTokens: 100,
      outputTokens: 50,
      failureStage: 'none',
    })
    expect(metrics.cost).toBeCloseTo(0.0004, 8)
    expect(observations.map((record) => record.type)).toEqual(
      expect.arrayContaining([
        'model.route.selected',
        'model.call.started',
        'model.call.failed',
        'model.retry',
        'model.fallback',
        'model.call.completed',
        'turn.completed',
      ]),
    )
  })
})
