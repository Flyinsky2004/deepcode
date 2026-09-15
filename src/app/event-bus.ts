/**
 * 事件总线：把 runtime 的事件落盘并扇出给多个订阅者。
 *
 * 同时服务 TUI 与 Web UI，且两者必须看到**完全相同**的序列
 * （`progess.md` Phase 7 验收项：「Web UI 与 TUI 同时连接时事件、权限和
 * cancel 语义一致」）。
 *
 * ## 为什么需要它
 *
 * `EventLog` 只会 append——它没有"推送"的能力。而 `AgentRuntime` 只认
 * `EventSink.append`。因此中间需要一层：收到事件 → 持久化 → 扇出。
 *
 * ## 补发 + 实时：三个窗口
 *
 * 重连补发是这里最容易静默出错的地方。设订阅发生在 T 时刻、补发区间由
 * `listAfter(lastEventId)` 决定，则有三个出错窗口：
 *
 * 1. **丢**：事件在"读日志之后、注册订阅者之前"落盘 → 补发里没有、推送也没收到。
 * 2. **重**：事件在"读日志之前、注册订阅者之后"落盘 → 补发里有、推送又发一次。
 * 3. **乱序**：补发与推送都发出去了，但推送先于补发写进 socket。
 *
 * 解法：把**发布**与**订阅**串到同一条 per-session 的 promise 链上
 * （`#serialize`），并在同一个临界区内完成"读日志 + 注册订阅者"——
 * 窗口 1 与 2 因此不可能存在（发布要么整段在订阅之前、要么整段在其后）。
 * 窗口 3 由**有序出站队列**解决：补发先入队，实时事件排在其后，按序交给订阅者。
 *
 * 另加一条零成本护栏：出站队列按 `sequence` 去重，任何 `sequence <= 已投递`
 * 的项直接丢弃。有了上面的论证它不该被触发，但它让"重复投递"在实现层面
 * 不可表达，也让竞态测试可以断言"从未跳过或重复"。
 */

import { AgentError, ErrorCode } from '../core/errors.js'
import type { EventSink, RuntimeEventEnvelope } from '../core/events.js'
import { createEventId, type SessionId, type TurnId } from '../core/ids.js'
import { systemClock, type Clock } from '../core/time.js'
import type { EventLog } from '../storage/event-log.js'
import type { AppPolicy } from './policy.js'

/** 订阅回调。实现必须**同步**返回——异步写盘会拖住整条出站队列。 */
export interface EventSubscriber {
  onEvent(event: RuntimeEventEnvelope): void
  /**
   * 订阅者被断开（背压溢出、内部错误）。此后不会再收到任何事件。
   *
   * 客户端应当带 `lastEventId` 重连——**事件没有丢**，断开只是让
   * "丢失"在协议上不可表达。
   */
  onError?(error: AgentError): void
  /**
   * 补发到此为止，之后是实时流。UI 据此结束 loading 态。
   *
   * 这个回调必须存在：没有它，客户端无法区分"补发还在继续"与"已经追平"，
   * 于是要么过早渲染，要么永远在转圈。
   */
  onReplayComplete?(lastSequence: number): void
}

export interface EventSubscription {
  readonly sessionId: SessionId
  /** 本次订阅补发了多少条事件（不含实时）。 */
  readonly replayed: number
  unsubscribe(): void
}

export interface EventPublisher {
  publish(input: {
    readonly sessionId: SessionId
    readonly turnId?: TurnId
    readonly type: string
    readonly data: unknown
  }): Promise<RuntimeEventEnvelope>
}

/** 出站队列里的一项。用显式标记而非"哨兵事件"，避免与真实事件混淆。 */
type OutboundItem =
  | { readonly kind: 'event'; readonly event: RuntimeEventEnvelope }
  | { readonly kind: 'replay-complete'; readonly lastSequence: number }
  | { readonly kind: 'error'; readonly error: AgentError }

/**
 * 单个订阅者的有序出站队列。
 *
 * 补发与实时事件都经由它投递，因此**顺序由入队顺序唯一决定**，
 * 与"谁先写 socket"无关。
 */
class OutboundSubscriber {
  readonly #queue: OutboundItem[] = []
  #scheduled = false
  #lastDelivered = 0
  #closed = false
  #replayCompleteSent = false
  /** 等待"队列已排空"的调用方（见 `EventBus.flush`）。 */
  #drainWaiters: Array<() => void> = []

  constructor(
    readonly sessionId: SessionId,
    readonly target: EventSubscriber,
    readonly limit: number,
  ) {}

  get closed(): boolean {
    return this.#closed
  }

  /** 队列是否已排空。 */
  get drained(): boolean {
    return this.#queue.length === 0 && !this.#scheduled
  }

  /** 入队一个实时事件。 */
  deliver(event: RuntimeEventEnvelope): void {
    if (this.#closed) return
    this.#enqueue({ kind: 'event', event })
  }

  /** 入队一批补发事件。必须在同一临界区内、注册订阅者**之前**调用。 */
  deliverMany(events: readonly RuntimeEventEnvelope[]): void {
    if (this.#closed) return
    for (const event of events) this.#enqueue({ kind: 'event', event })
  }

  /** 入队"补发完毕"标记。即使补发为空也要发，否则客户端永远等不到追平信号。 */
  markReplayComplete(lastSequence: number): void {
    if (this.#closed || this.#replayCompleteSent) return
    this.#replayCompleteSent = true
    this.#enqueue({ kind: 'replay-complete', lastSequence })
  }

  close(error?: AgentError): void {
    if (this.#closed) return
    this.#closed = true
    if (error) this.#drainTo(() => this.target.onError?.(error))
    this.#releaseDrainWaiters()
  }

  /**
   * 等待出站队列排空。
   *
   * ⚠️ 投递是**微任务**驱动的（`queueMicrotask`），因此"写入完成"不等于
   * "订阅者已收到"。`flush()` 若只等写入，调用方在它之后立刻断言或关闭，
   * 就会看到事件缺失——而这不是丢事件，只是还没轮到微任务。
   */
  whenDrained(): Promise<void> {
    if (this.#closed || (this.#queue.length === 0 && !this.#scheduled)) return Promise.resolve()
    return new Promise<void>((resolve) => {
      this.#drainWaiters.push(resolve)
    })
  }

  #releaseDrainWaiters(): void {
    const waiters = this.#drainWaiters
    this.#drainWaiters = []
    for (const waiter of waiters) waiter()
  }

  #enqueue(item: OutboundItem): void {
    this.#queue.push(item)
    if (item.kind === 'event') {
      if (item.event.sequence <= this.#lastDelivered) {
        // 幂等护栏：重复事件不入队。
        this.#queue.pop()
        return
      }
      this.#lastDelivered = item.event.sequence
    }
    if (this.#queue.length > this.limit) {
      // 兜底护栏，**不是**主要的积压处理路径。
      //
      // 实时事件在每个 append 里只入队一条，而出站队列每个微任务就排空一次，
      // 因此实时路径实际上不会堆积；补发积压已在 `EventBus.subscribe` 里
      // 通过 `EVENT_RESYNC_REQUIRED` 前置拦截。这里保留只是为了在未来的
      // 重构意外引入"一次入队多条"时，宁可断开也不静默丢事件。
      this.#closed = true
      this.#queue.length = 0
      this.target.onError?.(
        new AgentError({
          code: ErrorCode.EVENT_STREAM_BACKPRESSURE,
          message: '事件订阅者出站队列溢出，连接已断开；请带 lastEventId 重连',
          source: 'app.event-bus',
          context: { sessionId: this.sessionId, limit: this.limit },
        }),
      )
      return
    }
    this.#schedule()
  }

  #schedule(): void {
    if (this.#scheduled) return
    this.#scheduled = true
    // 用微任务而不是 await：投递是同步的，不能因为某个订阅者慢就拖住 append。
    queueMicrotask(() => {
      this.#drain()
    })
  }

  #drain(): void {
    this.#scheduled = false
    while (this.#queue.length > 0) {
      const item = this.#queue.shift()
      if (item === undefined) break
      this.#drainTo(() => {
        switch (item.kind) {
          case 'event':
            this.target.onEvent(item.event)
            break
          case 'replay-complete':
            this.target.onReplayComplete?.(item.lastSequence)
            break
          case 'error':
            this.target.onError?.(item.error)
            break
        }
      })
      if (this.#closed) return
    }
    this.#releaseDrainWaiters()
  }

  /**
   * 调用订阅者并吞掉它抛出的异常。
   *
   * 一个订阅者崩溃不应该影响其他订阅者，也不应该让 append 失败——
   * 事件已经落盘了，那是权威副本。
   */
  #drainTo(action: () => void): void {
    try {
      action()
    } catch {
      /* 订阅者自身的异常不向上传播 */
    }
  }
}

export class EventBus implements EventSink, EventPublisher {
  readonly #log: EventLog
  readonly #policy: AppPolicy
  readonly #clock: Clock
  /** per-session 串行链：保证"发布"与"订阅"的临界区互斥。 */
  readonly #tail = new Map<SessionId, Promise<void>>()
  readonly #subs = new Map<SessionId, Set<OutboundSubscriber>>()

  constructor(options: {
    readonly log: EventLog
    readonly policy: AppPolicy
    readonly clock?: Clock
  }) {
    this.#log = options.log
    this.#policy = options.policy
    this.#clock = options.clock ?? systemClock
  }

  /**
   * 把 `action` 排到该 session 串行链的末尾。
   *
   * 前一个动作失败不能阻断后一个（`then(action, action)`），否则一次
   * 写入错误会让该会话的事件流永久卡死。
   */
  #serialize<T>(sessionId: SessionId, action: () => Promise<T>): Promise<T> {
    const previous = this.#tail.get(sessionId) ?? Promise.resolve()
    const next = previous.then(action, action)
    this.#tail.set(
      sessionId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    )
    return next
  }

  /** 落盘并扇出。`EventSink` 的实现——runtime 调用这个。 */
  append(event: RuntimeEventEnvelope): Promise<void> {
    return this.#serialize(event.sessionId, async () => {
      const stored = await this.#log.appendWithResult(event)
      this.#fanout(event.sessionId, stored)
    })
  }

  /** 由 app 层（审批 broker、命令注册表）发布非 runtime 事件。 */
  publish(input: {
    readonly sessionId: SessionId
    readonly turnId?: TurnId
    readonly type: string
    readonly data: unknown
  }): Promise<RuntimeEventEnvelope> {
    const event = {
      eventId: createEventId(),
      sequence: 0,
      type: input.type,
      timestamp: this.#clock.now(),
      sessionId: input.sessionId,
      ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
      data: input.data,
    } as RuntimeEventEnvelope
    return this.#serialize(input.sessionId, async () => {
      const stored = await this.#log.appendWithResult(event)
      this.#fanout(input.sessionId, stored)
      return stored
    })
  }

  #fanout(sessionId: SessionId, stored: RuntimeEventEnvelope): void {
    const set = this.#subs.get(sessionId)
    if (!set) return
    for (const subscriber of set) subscriber.deliver(stored)
  }

  /**
   * 订阅某会话的事件流。
   *
   * `lastEventId` 给出时从该事件之后补发。**锚点必须存在**——找不到就抛
   * `EVENT_RESYNC_REQUIRED`，让客户端重建视图后重订阅。
   *
   * 不这样做的话，`EventLog.list` 在锚点缺失时会静默返回**全量**日志，
   * 客户端会把整个 transcript 重绘一遍——正是"重连不重复"要避免的。
   */
  subscribe(
    sessionId: SessionId,
    subscriber: EventSubscriber,
    options?: { readonly lastEventId?: string },
  ): Promise<EventSubscription> {
    return this.#serialize(sessionId, async () => {
      const out = new OutboundSubscriber(
        sessionId,
        subscriber,
        this.#policy.eventSubscriberQueueLimit,
      )

      let replayed = 0
      if (options?.lastEventId !== undefined) {
        const result = await this.#log.listAfter(sessionId, options.lastEventId)
        if (!result.found)
          throw new AgentError({
            code: ErrorCode.EVENT_RESYNC_REQUIRED,
            message: 'lastEventId 不在事件日志中，请重建视图后重新订阅',
            source: 'app.event-bus',
            context: { sessionId, lastEventId: options.lastEventId },
          })
        // 积压过大时同样要求重建，而不是硬推。
        //
        // 这不是性能优化而是**正确性**：客户端离线很久后锚点仍然有效，
        // 但补发量可能远超它能处理的规模。若改用"队列溢出就断开"来兜底，
        // 客户端重连会再次溢出——形成无限重连循环。让它转为"从消息历史
        // 重建视图"是**有界且必然收敛**的路径。
        if (result.events.length > this.#policy.eventSubscriberQueueLimit)
          throw new AgentError({
            code: ErrorCode.EVENT_RESYNC_REQUIRED,
            message: '补发积压过大，请重建视图后重新订阅',
            source: 'app.event-bus',
            context: {
              sessionId,
              backlog: result.events.length,
              limit: this.#policy.eventSubscriberQueueLimit,
            },
          })
        replayed = result.events.length
        // 补发必须先入队——它排在所有实时事件之前。
        out.deliverMany(result.events)
      }
      const lastSequence = await this.#log.lastSequence(sessionId)
      out.markReplayComplete(lastSequence)

      // ⚠️ 只有在临界区内才注册。注册提前会让实时事件越过补发（窗口 2 与 3），
      // 注册滞后则会漏掉临界区内落盘的事件（窗口 1）。
      let set = this.#subs.get(sessionId)
      if (!set) {
        set = new Set()
        this.#subs.set(sessionId, set)
      }
      set.add(out)

      return {
        sessionId,
        replayed,
        unsubscribe: (): void => {
          // 同样走串行链：否则可能在 deliverMany 迭代中途被移除。
          void this.#serialize(sessionId, () => {
            this.#subs.get(sessionId)?.delete(out)
            out.close()
            return Promise.resolve()
          })
        },
      }
    })
  }

  /**
   * 等待某会话（或全部会话）的写入**与投递**都完成。优雅关闭与测试用。
   *
   * 只等写入是不够的：出站投递由微任务驱动，写入完成时订阅者可能还没收到。
   * 优雅关闭若在这里提前返回，就会在事件送达前断开连接。
   *
   * 需要循环而不是等一轮：投递本身可能触发新的写入（例如订阅者在
   * `permission_required` 的回调里直接提交决议）。循环到"写入链不再推进
   * 且所有订阅者队列已排空"为止；上限只是防御性的，正常一两轮即收敛。
   */
  async flush(sessionId?: SessionId): Promise<void> {
    const targets = sessionId === undefined ? [...this.#tail.keys()] : [sessionId]
    const liveSubscribers = (): OutboundSubscriber[] =>
      [...this.#subs.values()].flatMap((set) => [...set]).filter((sub) => !sub.closed)

    for (let round = 0; round < 16; round++) {
      const before = targets.map((id) => this.#tail.get(id))
      await Promise.all(before.map((pending) => pending ?? Promise.resolve()))
      await Promise.all(liveSubscribers().map((sub) => sub.whenDrained()))
      const settled =
        targets.every((id, index) => this.#tail.get(id) === before[index]) &&
        liveSubscribers().every((sub) => sub.drained)
      if (settled) return
    }
  }

  /** 断开全部订阅者。 */
  close(): void {
    for (const set of this.#subs.values()) {
      for (const subscriber of set) subscriber.close()
    }
    this.#subs.clear()
  }
}
