import { describe, expect, it } from 'vitest'

import { InMemoryObservationSink, NullObservationSink } from '../../src/core/observability.js'
import { createFakeClock } from '../../src/core/time.js'

describe('ObservationSink 契约', () => {
  it('内存实现保留关联字段与注入时钟', async () => {
    const sink = new InMemoryObservationSink(createFakeClock(Date.UTC(2026, 0, 1)))
    await sink.record({
      type: 'model.call.completed',
      elapsedMs: 12,
      data: { input_tokens: 3 },
    })
    expect(sink.records).toEqual([
      expect.objectContaining({
        observationId: 'memory-observation-1',
        timestamp: '2026-01-01T00:00:00.000Z',
        type: 'model.call.completed',
        elapsedMs: 12,
        data: { input_tokens: 3 },
      }),
    ])
  })

  it('Null 实现明确丢弃记录', async () => {
    await expect(new NullObservationSink().record({ type: 'ignored' })).resolves.toBeUndefined()
  })
})
