import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { ObservationInput, ObservationRecord, ObservationSink } from '../core/observability.js'
import { systemClock, type Clock } from '../core/time.js'
import { withFileMutex } from '../storage/json-file.js'
import { sanitizeRecord } from './sanitize.js'

function isRecord(value: unknown): value is ObservationRecord {
  if (value === null || typeof value !== 'object') return false
  const record = value as Readonly<Record<string, unknown>>
  return (
    typeof record['observationId'] === 'string' &&
    typeof record['timestamp'] === 'string' &&
    typeof record['type'] === 'string' &&
    record['data'] !== null &&
    typeof record['data'] === 'object' &&
    !Array.isArray(record['data'])
  )
}

/** 本地、append-only、默认脱敏的结构化观测日志。 */
export class LocalObservationLog implements ObservationSink {
  #tail: Promise<void> = Promise.resolve()

  constructor(
    readonly path: string,
    readonly clock: Clock = systemClock,
  ) {}

  record(input: ObservationInput): Promise<void> {
    const record: ObservationRecord = {
      observationId: randomUUID(),
      timestamp: this.clock.now(),
      type: input.type,
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
      ...(input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId }),
      ...(input.subagentSessionId === undefined
        ? {}
        : { subagentSessionId: input.subagentSessionId }),
      ...(input.policyId === undefined ? {} : { policyId: input.policyId }),
      ...(input.elapsedMs === undefined
        ? {}
        : { elapsedMs: Math.max(0, Math.round(input.elapsedMs)) }),
      data: sanitizeRecord(input.data ?? {}),
    }
    const line = `${JSON.stringify(record)}\n`
    const append = (): Promise<void> =>
      withFileMutex(this.path, async () => {
        await mkdir(dirname(this.path), { recursive: true })
        await appendFile(this.path, line, { encoding: 'utf8', mode: 0o600 })
      })
    const pending = this.#tail.then(append, append)
    this.#tail = pending.catch(() => undefined)
    return pending
  }

  flush(): Promise<void> {
    return this.#tail
  }

  async list(
    filter: {
      readonly sessionId?: string
      readonly turnId?: string
      readonly type?: string
    } = {},
  ): Promise<readonly ObservationRecord[]> {
    await this.flush()
    let text: string
    try {
      text = await readFile(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const records: ObservationRecord[] = []
    for (const raw of text.split('\n')) {
      if (!raw.trim()) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        continue
      }
      if (!isRecord(parsed)) continue
      if (filter.sessionId !== undefined && parsed.sessionId !== filter.sessionId) continue
      if (filter.turnId !== undefined && parsed.turnId !== filter.turnId) continue
      if (filter.type !== undefined && parsed.type !== filter.type) continue
      records.push(parsed)
    }
    return records
  }
}
