import type { ObservationInput, ObservationSink } from '../core/observability.js'

/** 每个出口独立执行，远端故障不影响本地日志或其他出口。 */
export class CompositeObservationSink implements ObservationSink {
  constructor(readonly sinks: readonly ObservationSink[]) {}

  async record(input: ObservationInput): Promise<void> {
    await Promise.allSettled(this.sinks.map((sink) => this.invoke(() => sink.record(input))))
  }

  async flush(): Promise<void> {
    await Promise.allSettled(this.sinks.map((sink) => this.invoke(() => sink.flush?.())))
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled(
      this.sinks.map((sink) => this.invoke(() => sink.shutdown?.() ?? sink.flush?.())),
    )
  }

  private invoke(action: () => Promise<void> | undefined): Promise<void> {
    try {
      return action() ?? Promise.resolve()
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error('Observation sink failed'))
    }
  }
}
