/**
 * EventBus 的**兜底护栏与关闭路径**补充。
 *
 * `event-bus.test.ts` 覆盖了主流程（扇出、补发、竞态、隔离）。这里补的是
 * 那些"正常不会走到、但一走到就必须正确"的分支：
 * - 出站队列溢出的兜底（以及它在**补发量正好等于上限**时的边界行为）；
 * - 按 `sequence` 去重的护栏；
 * - 订阅者在收到事件的过程中被断开（背压或 `close()`）。
 *
 * 这些分支的共同点是：写错了不会报错，只会**静默丢事件**——所以必须有测试。
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { EventBus, type EventSubscriber } from '../../src/app/event-bus.js'
import { DEFAULT_APP_POLICY, type AppPolicy } from '../../src/app/policy.js'
import { EventLog } from '../../src/storage/event-log.js'
import { ErrorCode } from '../../src/core/errors.js'
import { createSessionId, type SessionId } from '../../src/core/ids.js'
import type { RuntimeEventEnvelope } from '../../src/core/events.js'

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
  get errorCode(): string | undefined {
    return (this.error as { code?: string } | undefined)?.code
  }
}

/** 可以替换 `listAfter` 结果的日志，用来构造"补发批次本身有问题"的场景。 */
class OverridableLog extends EventLog {
  overrideListAfter:
    | ((
        sessionId: SessionId,
        afterEventId: string,
      ) => Promise<{ found: boolean; events: readonly RuntimeEventEnvelope[] }>)
    | undefined

  override async listAfter(sessionId: SessionId, afterEventId: string) {
    if (this.overrideListAfter) return this.overrideListAfter(sessionId, afterEventId)
    return super.listAfter(sessionId, afterEventId)
  }
}

async function harness(policy: Partial<AppPolicy> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'deepcode-bus-extra-'))
  const log = new OverridableLog(dir)
  const bus = new EventBus({ log, policy: { ...DEFAULT_APP_POLICY, ...policy } })
  const sessionId = createSessionId()
  return { dir, log, bus, sessionId }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('EventBus：出站队列溢出的兜底护栏', () => {
  it('补发量正好等于上限时**仍然正常**（补发完毕标记不会把队列顶过上限）', async () => {
    // 上限判定是"入队后队列长度 > limit"，而补发批次本身已被 `events.length > limit`
    // 前置拦截；批次与补发完毕标记之间还有一个 await（`lastSequence`），
    // 那时队列已经排空。所以"正好等于上限"不会溢出——这条固化它。
    //
    // 顺带说明：也正因如此，实时路径（每次 fanout 只入队一条）永远不会堆积，
    // `#enqueue` 里的 `> limit` 兜底在正常配置下**不可达**，只有下面的 limit=0
    // 这个边界能真实触发它。
    const { bus, sessionId } = await harness({ eventSubscriberQueueLimit: 2 })
    const first = await bus.publish({ sessionId, type: 'a', data: {} })
    await bus.publish({ sessionId, type: 'b', data: {} })
    await bus.publish({ sessionId, type: 'c', data: {} })

    const r = new Recorder()
    // 锚点是第一条 → 补发 [b, c] 恰好 2 条 = limit
    const sub = await bus.subscribe(sessionId, r, { lastEventId: first.eventId })
    await settle()

    expect(sub.replayed).toBe(2)
    expect(r.sequences).toEqual([2, 3])
    expect(r.replayedUpTo).toBe(3)
    expect(r.error).toBeUndefined()
  })

  it('上限为 0（完全不缓冲）时任何一次订阅都立刻断开，并给出可重连的说明', async () => {
    // `policy.event_subscriber_queue_limit` 接受 0（非负即可），它的语义只能是
    // "不缓冲"。这时"补发完毕"这个标记本身就没地方放，订阅者被立刻断开——
    // 这是溢出护栏**唯一可达**的触发方式。保留现状：0 是个能配出来的边界值，
    // "断开 + 明确错误码 + 提示带 lastEventId 重连"比静默丢事件可诊断得多。
    const { bus, sessionId } = await harness({ eventSubscriberQueueLimit: 0 })

    const r = new Recorder()
    const sub = await bus.subscribe(sessionId, r)
    await settle()

    expect(sub.replayed).toBe(0)
    expect(r.errorCode).toBe(ErrorCode.EVENT_STREAM_BACKPRESSURE)
    expect(r.error?.message).toMatch(/lastEventId/)
    expect(r.events).toEqual([])

    // 溢出之后订阅者**不会**被从扇出表里摘掉，所以后续事件走到它时
    // 必须由 `deliver` 自己挡住——否则就会往一个已断开的连接上继续写事件。
    await bus.publish({ sessionId, type: 'later', data: {} })
    await settle()
    expect(r.events).toEqual([])

    // 再次 close() 必须幂等：不能重复触发 onError（UI 会重复弹断线提示）
    r.error = undefined
    bus.close()
    expect(r.error).toBeUndefined()
  })
})

describe('EventBus：按 sequence 去重的护栏', () => {
  it('补发批次里出现重复 sequence 时只投递一次', async () => {
    // 设计文档把这条护栏写成"让重复投递在实现层面不可表达"。它防的是
    // "发布与订阅没能串行"时补发与实时重叠——这里直接构造那个重叠的产物，
    // 断言订阅者不会收到两条相同 sequence 的事件。
    const { bus, log, sessionId } = await harness()
    const first = await bus.publish({ sessionId, type: 'a', data: {} })
    const dup = await bus.publish({ sessionId, type: 'b', data: {} })

    log.overrideListAfter = () => Promise.resolve({ found: true, events: [dup, dup] })

    const r = new Recorder()
    const sub = await bus.subscribe(sessionId, r, { lastEventId: first.eventId })
    await settle()

    // 服务端仍会如实报告"补发了 2 条"，去重只发生在投递环节
    expect(sub.replayed).toBe(2)
    expect(r.sequences).toEqual([2])
  })

  it('补发批次里 sequence 回退（乱序）时同样被丢弃', async () => {
    const { bus, log, sessionId } = await harness()
    const first = await bus.publish({ sessionId, type: 'a', data: {} })
    const second = await bus.publish({ sessionId, type: 'b', data: {} })
    const third = await bus.publish({ sessionId, type: 'c', data: {} })

    // 先投递 3 再投递 2：2 因为 `<= lastDelivered` 被丢弃
    log.overrideListAfter = () => Promise.resolve({ found: true, events: [third, second] })

    const r = new Recorder()
    await bus.subscribe(sessionId, r, { lastEventId: first.eventId })
    await settle()

    expect(r.sequences).toEqual([3])
  })
})

describe('EventBus：投递过程中被断开', () => {
  it('订阅者在收到事件的过程中把总线关掉，投递立即停止且 flush 不挂住', async () => {
    // 这是 `#drain` 循环里的 `if (this.#closed) return`。少了它，一次投递
    // 会继续往已经关闭的连接上写事件（多客户端下就是"页面已关但仍在刷"）。
    //
    // 注意时序：补发期间订阅者**尚未**注册进扇出表，所以 `bus.close()` 只能
    // 通过"已注册的订阅者"在实时投递中触发——这里用先订阅、后发布来构造。
    const { bus, sessionId } = await harness()
    const seen: number[] = []

    await bus.subscribe(sessionId, {
      onEvent(event) {
        seen.push(event.sequence)
        bus.close()
      },
    })

    await bus.publish({ sessionId, type: 'a', data: {} })
    await settle()
    expect(seen).toEqual([1])

    // 断开之后的事件不再到达，而且 flush 不会因为等待这个订阅者而挂住
    await bus.publish({ sessionId, type: 'b', data: {} })
    await bus.flush(sessionId)
    expect(seen).toEqual([1])
  })
})

describe('EventBus：flush 的两种范围与收敛判定', () => {
  it('不传 sessionId 时等待全部会话（优雅关闭用）', async () => {
    const { bus, sessionId } = await harness()
    const other = createSessionId()
    const a = new Recorder()
    const b = new Recorder()
    await bus.subscribe(sessionId, a)
    await bus.subscribe(other, b)

    void bus.publish({ sessionId, type: 'x', data: {} })
    void bus.publish({ sessionId: other, type: 'y', data: {} })
    await bus.flush()

    expect(a.sequences).toEqual([1])
    expect(b.sequences).toEqual([1])
  })

  it('空闲总线上的 flush 立即收敛（不空转满 16 轮）', async () => {
    // `flush` 里 `if (settled) return` 的判定条件写错会变成"总是等满上限"，
    // 优雅关闭因此恒定慢 16 轮。这里用"发布前 flush 应当立刻返回"来固化它。
    const { bus } = await harness()
    const started = Date.now()
    await bus.flush()
    await bus.flush(createSessionId())
    expect(Date.now() - started).toBeLessThan(200)
  })

  it('订阅者已全部断开时 flush 不会挂住', async () => {
    const { bus, sessionId } = await harness({ eventSubscriberQueueLimit: 0 })
    // limit=0 → 订阅即溢出，订阅者处于 closed 但仍留在扇出表里的状态；
    // flush 必须能跳过它并收敛，而不是等一个永远不会来的排空信号。
    await bus.subscribe(sessionId, new Recorder())
    await settle()

    await bus.flush(sessionId)
    await bus.flush()
  })
})
