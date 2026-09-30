import type { SessionId, ToolCallId, TurnId } from './ids.js'
import { systemClock, type Clock, type IsoTimestamp } from './time.js'

/**
 * 可观测性记录的稳定信封。
 *
 * 内核只依赖这个协议，不依赖本地文件格式或远端 exporter。字段使用可选形态，
 * 因为 MCP 启动这类进程级事件没有 session/turn，而模型、工具事件必须带齐关联 ID。
 */
export interface ObservationRecord {
  readonly observationId: string
  readonly timestamp: IsoTimestamp
  readonly type: string
  readonly sessionId?: SessionId
  readonly turnId?: TurnId
  readonly toolCallId?: ToolCallId
  readonly subagentSessionId?: SessionId
  readonly policyId?: string
  readonly elapsedMs?: number
  readonly data: Readonly<Record<string, unknown>>
}

export interface ObservationInput {
  readonly type: string
  readonly sessionId?: SessionId
  readonly turnId?: TurnId
  readonly toolCallId?: ToolCallId
  readonly subagentSessionId?: SessionId
  readonly policyId?: string
  readonly elapsedMs?: number
  readonly data?: Readonly<Record<string, unknown>>
}

/** 外部观测能力的唯一注入点。实现必须自行完成敏感信息脱敏。 */
export interface ObservationSink {
  /** 只保证记录已被接受；实现可异步批量落盘，避免拖慢 turn。 */
  record(input: ObservationInput): Promise<void>
  /** 优雅关闭与测试断言前等待已接受记录全部落定。 */
  flush?(): Promise<void>
  /** 停止接受记录并释放 exporter；调用前应等待活动 turn 结束。 */
  shutdown?(): Promise<void>
}

/** 显式关闭观测时使用；避免在业务代码里散落可选链与分支。 */
export class NullObservationSink implements ObservationSink {
  record(_input: ObservationInput): Promise<void> {
    return Promise.resolve()
  }
}

/** 测试与嵌入式调用使用的内存实现。生产默认使用本地 NDJSON。 */
export class InMemoryObservationSink implements ObservationSink {
  readonly records: ObservationRecord[] = []
  #nextId = 1
  constructor(readonly clock: Clock = systemClock) {}
  record(input: ObservationInput): Promise<void> {
    this.records.push({
      observationId: `memory-observation-${this.#nextId++}`,
      timestamp: this.clock.now(),
      type: input.type,
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
      ...(input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId }),
      ...(input.subagentSessionId === undefined
        ? {}
        : { subagentSessionId: input.subagentSessionId }),
      ...(input.policyId === undefined ? {} : { policyId: input.policyId }),
      ...(input.elapsedMs === undefined ? {} : { elapsedMs: input.elapsedMs }),
      data: input.data ?? {},
    })
    return Promise.resolve()
  }
}
