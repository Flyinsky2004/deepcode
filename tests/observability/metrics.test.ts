import { describe, expect, it } from 'vitest'

import type { ObservationRecord } from '../../src/core/observability.js'
import { aggregateTurnMetrics } from '../../src/observability/metrics.js'

const record = (
  type: string,
  data: Readonly<Record<string, unknown>> = {},
  elapsedMs?: number,
): ObservationRecord => ({
  observationId: `${type}-${Math.random()}`,
  timestamp: '2026-01-01T00:00:00.000Z',
  type,
  ...(elapsedMs === undefined ? {} : { elapsedMs }),
  data,
})

describe('Phase 11：本地指标聚合', () => {
  it('聚合 token、cost、latency、retry、fallback 与成功阶段', () => {
    const metrics = aggregateTurnMetrics([
      record('model.call.started'),
      record('model.call.failed', { error_code: 'PROVIDER_UNAVAILABLE' }, 20),
      record('model.retry'),
      record('model.call.started'),
      record('model.call.failed', { error_code: 'PROVIDER_UNAVAILABLE' }, 30),
      record('model.fallback'),
      record('model.call.started'),
      record('model.call.completed', { input_tokens: 100, output_tokens: 20, cost: 0.004 }, 50),
      record('tool.execution.completed', { ok: true }, 12),
      record('compact.completed', { applied: true }),
      record(
        'turn.completed',
        {
          status: 'completed',
          terminal_reason: 'completed',
          input_tokens: 100,
          cumulative_input_tokens: 100,
          output_tokens: 20,
          cost: 0.004,
        },
        140,
      ),
    ])

    expect(metrics).toMatchObject({
      modelCallCount: 3,
      toolCallCount: 1,
      inputTokens: 100,
      cumulativeInputTokens: 100,
      outputTokens: 20,
      cost: 0.004,
      modelLatencyMs: 100,
      toolLatencyMs: 12,
      taskLatencyMs: 140,
      retryCount: 1,
      fallbackCount: 1,
      compactCount: 1,
      failureStage: 'none',
    })
  })

  it('权限失败优先于工具失败分类', () => {
    const metrics = aggregateTurnMetrics([
      record('permission.requested'),
      record('permission.resolved', { decision: 'deny' }),
      record('tool.execution.completed', { ok: false, error_code: 'PERMISSION_DENIED' }),
      record('turn.completed', {
        status: 'failed',
        terminal_reason: 'error',
        last_tool_error: 'PERMISSION_DENIED',
        error: 'denied',
      }),
    ])
    expect(metrics.permissionRequestCount).toBe(1)
    expect(metrics.permissionDeniedCount).toBe(1)
    expect(metrics.failureStage).toBe('permission_error')
    expect(metrics.failureReason).toBe('permission_denied')
  })

  it('turn 终态快照会清除已经恢复的历史工具错误', () => {
    const metrics = aggregateTurnMetrics([
      record('tool.execution.completed', { ok: false, error_code: 'FILE_NOT_FOUND' }),
      record('tool.execution.completed', { ok: true, error_code: '' }),
      record('turn.completed', {
        status: 'completed',
        terminal_reason: 'completed',
        last_tool_error: '',
      }),
    ])
    expect(metrics.failureStage).toBe('none')
  })

  it.each([
    ['cancelled', '', 'user_interaction'],
    ['budget_exceeded', 'budget_exceeded', 'timeout'],
    ['failed', 'error', 'environment_error'],
  ] as const)('把 %s 分类为 %s 对应阶段', (status, terminalReason, stage) => {
    const metrics = aggregateTurnMetrics([
      record('model.call.failed', { error_code: 'PROVIDER_CONNECTION_FAILED' }),
      record('turn.completed', {
        status,
        terminal_reason: terminalReason,
        error: status === 'failed' ? 'network' : '',
      }),
    ])
    expect(metrics.failureStage).toBe(stage)
  })
})
