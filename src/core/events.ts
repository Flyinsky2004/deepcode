/**
 * 运行时事件的基础设施。
 *
 * 事件是本项目**唯一的**内核 → UI 通道（REWRITE_SPEC §6 不变量 10）：
 * 「UI 与引擎单向流 + 显式回灌：引擎只通过 `on_event` 推、通过 `resolve_*` 收」。
 *
 * 这个约束带来两条必须落实的要求：
 *
 * 1. **事件必须自包含**。UI 只消费事件，不得回查内核状态，因此每个事件
 *    都要带齐渲染所需的信息（谁、什么、何时、属于哪个 turn）。
 * 2. **事件必须持久化且有序**。WebSocket 断线重连要能用 `lastEventId` 补发
 *    （parts/09 §1.1），所以事件携带单调递增的序号。
 *
 * ⚠️ 具体的**事件类型联合**（turn_start / text / tool_result / …）在
 * `src/core/turn.ts` 中定义——那里需要引用 Message / TurnPhase 等类型，
 * 放在本模块会造成循环依赖。本模块只负责"事件信封"与 `EventSink` 契约。
 */

import { type EventId, type SessionId, type TurnId } from './ids.js'
import { type IsoTimestamp } from './time.js'

/**
 * 事件类型的泛型约束。
 *
 * ⚠️ 命名为 `EventKind` 而非 `RuntimeEventType`——后者是 `turn.ts` 里
 * **具体的**事件类型联合（`"turn_start" | "text" | ...`）。两者是不同的东西：
 * 这里是"任何字符串都能当事件类型"的宽松约束，`turn.ts` 里是可枚举的具体集合。
 * 若同名，`index.ts` 的再导出会冲突。
 */
export type EventKind = string

/**
 * 事件信封：所有运行时事件共有的字段。
 *
 * 具体事件类型 = 本信封 + 自己的 `type` 与 `data`。
 *
 * 为什么把信封与载荷分开：`EventSink.append()` 需要按序号排序、按 turn 分组、
 * 按时序补发，这些操作只依赖信封字段。分开后这些逻辑无需了解任何具体事件。
 */
export interface RuntimeEventEnvelope<TType extends EventKind = EventKind, TData = unknown> {
  /** 事件的唯一标识，用于 WebSocket 重连补发。 */
  readonly eventId: EventId
  /**
   * 同一 session 内单调递增的序号。
   *
   * ⚠️ 是**每 session** 而非全局递增——WebSocket 补发时客户端给出
   * `lastEventId`，服务端需要在同一 session 的事件日志里定位。
   * 全局序号会导致跨 session 定位歧义。
   */
  readonly sequence: number
  /** 事件类型。 */
  readonly type: TType
  /** 事件发生时刻。 */
  readonly timestamp: IsoTimestamp
  /** 所属会话。 */
  readonly sessionId: SessionId
  /** 所属 turn。会话级事件（如 session_created）没有 turn。 */
  readonly turnId?: TurnId
  /** 事件载荷。 */
  readonly data: TData
}

/**
 * 事件接收端。
 *
 * 内核只依赖这个接口，不关心对端是 TUI、WebSocket 还是测试用的数组收集器。
 * 这是"内核不得依赖 TUI/Web 框架"（progess.md 设计约束 1）的具体落点。
 *
 * ⚠️ **`append` 必须是幂等的**（parts/09 §2：「批准、执行、结果写入都必须是
 * 幂等操作」）。同一 `eventId` 重复 append 不得产生重复状态——重连补发、
 * 重试、进程重启后重放都可能触发重复写入。
 */
export interface EventSink {
  append(event: RuntimeEventEnvelope): Promise<void>
}

/**
 * 把事件写入内存数组的实现。
 *
 * 用于测试与单进程冒烟运行。**不持久化**——生产环境的实现（append-only
 * 事件日志）属于 Phase 1 的存储层。
 */
export class InMemoryEventSink implements EventSink {
  #events: RuntimeEventEnvelope[] = []
  #seen = new Set<string>()

  /** 已收集的事件（只读视图）。 */
  get events(): readonly RuntimeEventEnvelope[] {
    return this.#events
  }

  /**
   * 追加事件。
   *
   * 按 `eventId` 去重——重复事件静默忽略而非抛错，因为重连补发是正常路径，
   * 不是异常情况。
   */
  append(event: RuntimeEventEnvelope): Promise<void> {
    if (this.#seen.has(event.eventId)) return Promise.resolve()
    this.#seen.add(event.eventId)
    this.#events.push(event)
    return Promise.resolve()
  }

  /** 清空（测试用）。 */
  clear(): void {
    this.#events = []
    this.#seen.clear()
  }
}

/**
 * 丢弃全部事件的实现。
 *
 * 用途：可观测性与事件写入**不得拖垮主链路**。当没有订阅者、
 * 或事件日志不可用时，注入这个 sink 让 turn 继续跑完
 * （REWRITE_SPEC §6 不变量 12 的同类思路）。
 */
export class NullEventSink implements EventSink {
  append(_event: RuntimeEventEnvelope): Promise<void> {
    // 有意为空：丢弃事件是设计行为，不是错误。
    // 返回已 resolve 的 Promise 而非 async 方法——没有 await 的 async 函数
    // 会多产生一层微任务调度。
    return Promise.resolve()
  }
}
