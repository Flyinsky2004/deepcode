import { describe, expect, it } from 'vitest'

import {
  type EventSink,
  InMemoryEventSink,
  NullEventSink,
  type RuntimeEventEnvelope,
} from '../../src/core/events.js'
import { createEventId, createSessionId, type SessionId } from '../../src/core/ids.js'

function event(
  sequence: number,
  sessionId: SessionId,
  type = 'test',
): RuntimeEventEnvelope<string, { n: number }> {
  return {
    eventId: createEventId(),
    sequence,
    type,
    timestamp: '2026-09-14T02:39:11.123Z',
    sessionId,
    data: { n: sequence },
  }
}

describe('RuntimeEventEnvelope', () => {
  it('turnId 可选（会话级事件没有 turn）', () => {
    const sessionId = createSessionId()
    const withoutTurn = event(1, sessionId)

    expect(withoutTurn.turnId).toBeUndefined()
    expect(withoutTurn.sessionId).toBe(sessionId)
  })
})

describe('InMemoryEventSink', () => {
  it('按追加顺序保存事件', async () => {
    const sink = new InMemoryEventSink()
    const sessionId = createSessionId()

    await sink.append(event(1, sessionId))
    await sink.append(event(2, sessionId))

    expect(sink.events.map((e) => e.sequence)).toEqual([1, 2])
  })

  it('按 eventId 幂等：重复追加不产生重复状态', async () => {
    // parts/09 §2：结果写入必须是幂等操作。重连补发会重复投递同一事件。
    const sink = new InMemoryEventSink()
    const sessionId = createSessionId()
    const e = event(1, sessionId)

    await sink.append(e)
    await sink.append(e)
    await sink.append(e)

    expect(sink.events).toHaveLength(1)
  })

  it('不同 eventId 但相同 sequence 视为两条（不做序号去重）', async () => {
    const sink = new InMemoryEventSink()
    const sessionId = createSessionId()

    await sink.append(event(1, sessionId))
    await sink.append(event(1, sessionId))

    expect(sink.events).toHaveLength(2)
  })

  it('clear 清空事件与去重集合', async () => {
    const sink = new InMemoryEventSink()
    const sessionId = createSessionId()
    const e = event(1, sessionId)

    await sink.append(e)
    sink.clear()
    expect(sink.events).toHaveLength(0)

    // clear 后同一事件可以再次写入（去重集合也被清空）
    await sink.append(e)
    expect(sink.events).toHaveLength(1)
  })

  it('可被当作用户侧只读视图消费', async () => {
    const sink = new InMemoryEventSink()
    const sessionId = createSessionId()
    await sink.append(event(1, sessionId, 'turn_start'))

    const types = sink.events.map((e) => e.type)
    expect(types).toEqual(['turn_start'])
  })
})

describe('NullEventSink', () => {
  it('静默丢弃全部事件（用于无订阅者场景）', async () => {
    const sink = new NullEventSink()
    await expect(sink.append(event(1, createSessionId()))).resolves.toBeUndefined()
  })
})

describe('EventSink 契约', () => {
  it('两个实现都满足接口', () => {
    const sinks: EventSink[] = [new InMemoryEventSink(), new NullEventSink()]
    expect(sinks).toHaveLength(2)
  })
})
