import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { EventBus, type EventSubscriber } from '../../src/app/event-bus.js'
import { DEFAULT_APP_POLICY, type AppPolicy } from '../../src/app/policy.js'
import { EventLog } from '../../src/storage/event-log.js'
import { ErrorCode } from '../../src/core/errors.js'
import { createSessionId } from '../../src/core/ids.js'
import type { RuntimeEventEnvelope } from '../../src/core/events.js'
import type { SessionId } from '../../src/core/ids.js'

/** 记录收到的事件与回调时序。 */
class Recorder implements EventSubscriber {
  readonly events: RuntimeEventEnvelope[] = []
  readonly order: string[] = []
  replayedUpTo: number | undefined
  error: Error | undefined

  onEvent(event: RuntimeEventEnvelope): void {
    this.events.push(event)
    this.order.push(`${event.sequence}:${event.type}`)
  }
  onReplayComplete(lastSequence: number): void {
    this.replayedUpTo = lastSequence
    this.order.push(`replay-complete:${lastSequence}`)
  }
  onError(error: Error): void {
    this.error = error
  }

  get sequences(): number[] {
    return this.events.map((e) => e.sequence)
  }
}

/**
 * 一个可以在"读日志之后、注册订阅者之前"注入动作的日志。
 *
 * 这正是补发竞态的关键窗口。
 */
class InjectableLog extends EventLog {
  hook: (() => Promise<void>) | undefined
  override async listAfter(sessionId: SessionId, afterEventId: string) {
    const result = await super.listAfter(sessionId, afterEventId)
    // 此刻订阅者尚未注册——任何在此落盘的事件都可能被漏掉或重复。
    await this.hook?.()
    return result
  }
}

async function harness(policy: Partial<AppPolicy> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'deepcode-bus-'))
  const log = new InjectableLog(dir)
  const bus = new EventBus({ log, policy: { ...DEFAULT_APP_POLICY, ...policy } })
  const sessionId = createSessionId()
  return { dir, log, bus, sessionId }
}

/** 让微任务队列排空，使出站队列完成投递。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('EventBus：基本扇出', () => {
  it('两个订阅者收到完全相同的序列', async () => {
    const { bus, sessionId } = await harness()
    const a = new Recorder()
    const b = new Recorder()

    await bus.subscribe(sessionId, a)
    await bus.subscribe(sessionId, b)
    await bus.publish({ sessionId, type: 'turn_start', data: { turn_number: 1 } })
    await bus.publish({ sessionId, type: 'text', data: { content: 'hi' } })
    await settle()

    expect(a.sequences).toEqual([1, 2])
    expect(b.sequences).toEqual(a.sequences)
    expect(a.events.map((e) => e.type)).toEqual(['turn_start', 'text'])
  })

  it('序号由 EventLog 分配，生产者传入的被覆写', async () => {
    const { bus, sessionId } = await harness()
    const r = new Recorder()
    await bus.subscribe(sessionId, r)

    const stored = await bus.publish({ sessionId, type: 'x', data: {} })
    await settle()

    expect(stored.sequence).toBe(1)
    expect(r.sequences).toEqual([1])
  })

  it('订阅者抛错不影响其他订阅者，也不让 publish 失败', async () => {
    const { bus, sessionId } = await harness()
    const bad: EventSubscriber = {
      onEvent() {
        throw new Error('订阅者炸了')
      },
    }
    const good = new Recorder()

    await bus.subscribe(sessionId, bad)
    await bus.subscribe(sessionId, good)
    await expect(bus.publish({ sessionId, type: 'x', data: {} })).resolves.toBeDefined()
    await settle()

    expect(good.sequences).toEqual([1])
  })

  it('unsubscribe 之后不再收到事件', async () => {
    const { bus, sessionId } = await harness()
    const r = new Recorder()

    const sub = await bus.subscribe(sessionId, r)
    await bus.publish({ sessionId, type: 'a', data: {} })
    await settle()
    sub.unsubscribe()
    await settle()
    await bus.publish({ sessionId, type: 'b', data: {} })
    await settle()

    expect(r.events.map((e) => e.type)).toEqual(['a'])
  })
})

describe('EventBus：补发', () => {
  it('从 lastEventId 之后补发，并标记补发完毕', async () => {
    const { bus, sessionId } = await harness()
    await bus.publish({ sessionId, type: 'a', data: {} })
    const second = await bus.publish({ sessionId, type: 'b', data: {} })
    await bus.publish({ sessionId, type: 'c', data: {} })

    const r = new Recorder()
    const sub = await bus.subscribe(sessionId, r, { lastEventId: second.eventId })
    await settle()

    expect(sub.replayed).toBe(1)
    expect(r.events.map((e) => e.type)).toEqual(['c'])
    expect(r.replayedUpTo).toBe(3)
  })

  it('补发为空时仍发出补发完毕信号（否则客户端永远等不到追平）', async () => {
    const { bus, sessionId } = await harness()
    const last = await bus.publish({ sessionId, type: 'a', data: {} })

    const r = new Recorder()
    const sub = await bus.subscribe(sessionId, r, { lastEventId: last.eventId })
    await settle()

    expect(sub.replayed).toBe(0)
    expect(r.events).toEqual([])
    expect(r.replayedUpTo).toBe(1)
    expect(r.order).toEqual(['replay-complete:1'])
  })

  it('锚点不存在时抛 EVENT_RESYNC_REQUIRED，而不是静默补发全量', async () => {
    const { bus, sessionId } = await harness()
    await bus.publish({ sessionId, type: 'a', data: {} })

    await expect(
      bus.subscribe(sessionId, new Recorder(), { lastEventId: 'evt_不存在' }),
    ).rejects.toMatchObject({ code: ErrorCode.EVENT_RESYNC_REQUIRED })
  })

  it('锚点属于其他会话时同样要求重建', async () => {
    const { bus, sessionId } = await harness()
    const other = createSessionId()
    const inOther = await bus.publish({ sessionId: other, type: 'a', data: {} })

    await expect(
      bus.subscribe(sessionId, new Recorder(), { lastEventId: inOther.eventId }),
    ).rejects.toMatchObject({ code: ErrorCode.EVENT_RESYNC_REQUIRED })
  })
})

describe('EventBus：补发与实时的竞态', () => {
  it('事件的投递顺序与入队顺序一致：补发在前，实时在后', async () => {
    const { bus, sessionId } = await harness()
    const first = await bus.publish({ sessionId, type: 'a', data: {} })
    await bus.publish({ sessionId, type: 'b', data: {} })
    await bus.publish({ sessionId, type: 'c', data: {} })

    const r = new Recorder()
    const sub = await bus.subscribe(sessionId, r, { lastEventId: first.eventId })
    await bus.publish({ sessionId, type: 'd', data: {} })
    await settle()

    expect(sub.replayed).toBe(2)
    expect(r.events.map((e) => e.type)).toEqual(['b', 'c', 'd'])
    // 补发完毕信号必须落在 c 与 d 之间——客户端据此结束 loading 态
    expect(r.order).toEqual(['2:b', '3:c', 'replay-complete:3', '4:d'])
  })

  it('在临界区内发布的事件：既不丢也不重', async () => {
    const { bus, log, sessionId } = await harness()
    const first = await bus.publish({ sessionId, type: 'a', data: {} })
    await bus.publish({ sessionId, type: 'b', data: {} })

    // 在"读日志之后、注册订阅者之前"发起一次发布，且**不 await**。
    //
    // 不能 await：串行链会把这次 publish 排到 subscribe 之后，若在这里等待它
    // 完成就是自等——死锁。真实场景里的并发发布也是"发出去就不管"，
    // 不会嵌在别人的临界区里等待。
    let injected = false
    log.hook = () => {
      if (!injected) {
        injected = true
        void bus.publish({ sessionId, type: 'during', data: {} })
      }
      return Promise.resolve()
    }

    const r = new Recorder()
    const sub = await bus.subscribe(sessionId, r, { lastEventId: first.eventId })
    log.hook = undefined
    // flush 会等到串行链上排队的 publish 真正落盘并扇出
    await bus.flush(sessionId)
    await settle()

    const seqs = r.sequences
    // 严格递增、无洞、无重复
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y))
    expect(new Set(seqs).size).toBe(seqs.length)
    // 补发区间是 (a, 订阅时刻] = [b]，注入的 during 落在订阅之后 → 走实时
    expect(sub.replayed).toBe(1)
    expect(r.events.map((e) => e.type)).toEqual(['b', 'during'])
  })

  it('多个订阅者交错订阅时各自都拿到完整序列', async () => {
    const { bus, sessionId } = await harness()
    const first = new Recorder()
    await bus.subscribe(sessionId, first)

    await bus.publish({ sessionId, type: 'a', data: {} })

    const second = new Recorder()
    await bus.subscribe(sessionId, second)

    await bus.publish({ sessionId, type: 'b', data: {} })
    await settle()

    // 后订阅者没有给锚点，因此看不到历史——只有订阅之后的事件
    expect(first.events.map((e) => e.type)).toEqual(['a', 'b'])
    expect(second.events.map((e) => e.type)).toEqual(['b'])
  })
})

describe('EventBus：积压处理', () => {
  it('实时路径不会堆积——队列每个微任务排空一次', async () => {
    const { bus, sessionId } = await harness({ eventSubscriberQueueLimit: 3 })
    const r = new Recorder()
    await bus.subscribe(sessionId, r)

    // 连续发布超过 limit 条，不应触发任何背压
    for (let i = 0; i < 10; i++) await bus.publish({ sessionId, type: `e${i}`, data: {} })
    await settle()

    expect(r.error).toBeUndefined()
    expect(r.sequences).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })

  it('补发积压超过上限时要求重建，而不是硬推', async () => {
    const { bus, sessionId } = await harness({ eventSubscriberQueueLimit: 3 })
    const first = await bus.publish({ sessionId, type: 'a', data: {} })
    for (let i = 0; i < 10; i++) await bus.publish({ sessionId, type: `e${i}`, data: {} })

    // 溢出后若只是断开，客户端重连还会溢出 → 无限重连循环。
    // 转为"重建视图"是有界且必然收敛的路径。
    await expect(
      bus.subscribe(sessionId, new Recorder(), { lastEventId: first.eventId }),
    ).rejects.toMatchObject({ code: ErrorCode.EVENT_RESYNC_REQUIRED })
  })

  it('积压未超上限时正常补发', async () => {
    const { bus, sessionId } = await harness({ eventSubscriberQueueLimit: 100 })
    const first = await bus.publish({ sessionId, type: 'a', data: {} })
    await bus.publish({ sessionId, type: 'b', data: {} })

    const r = new Recorder()
    const sub = await bus.subscribe(sessionId, r, { lastEventId: first.eventId })
    await settle()

    expect(sub.replayed).toBe(1)
    expect(r.events.map((e) => e.type)).toEqual(['b'])
  })
})

describe('EventBus：隔离', () => {
  it('会话之间互不串流', async () => {
    const { bus } = await harness()
    const a = createSessionId()
    const b = createSessionId()
    const ra = new Recorder()
    const rb = new Recorder()

    await bus.subscribe(a, ra)
    await bus.subscribe(b, rb)
    await bus.publish({ sessionId: a, type: 'only-a', data: {} })
    await settle()

    expect(ra.events.map((e) => e.type)).toEqual(['only-a'])
    expect(rb.events).toEqual([])
  })

  it('一次订阅者抛错不会卡死该会话的串行链', async () => {
    const { bus, sessionId } = await harness()
    await bus.subscribe(sessionId, {
      onEvent() {
        throw new Error('boom')
      },
    })

    await bus.publish({ sessionId, type: 'a', data: {} })
    await bus.publish({ sessionId, type: 'b', data: {} })
    await settle()

    // 后续 publish 仍然成功
    const stored = await bus.publish({ sessionId, type: 'c', data: {} })
    expect(stored.sequence).toBe(3)
  })
})
