import { appendFile, mkdir, open, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { createEventId, type SessionId } from '../core/ids.js'
import { systemClock, type Clock } from '../core/time.js'
import { type EventSink, type RuntimeEventEnvelope } from '../core/events.js'
import { withFileMutex } from './json-file.js'

const safeName = (id: string) => createHash('sha256').update(id).digest('hex')
const valid = (v: unknown): v is RuntimeEventEnvelope => {
  if (!v || typeof v !== 'object') return false
  const x = v as Record<string, unknown>
  return (
    typeof x['eventId'] === 'string' &&
    typeof x['sessionId'] === 'string' &&
    typeof x['sequence'] === 'number' &&
    Number.isInteger(x['sequence']) &&
    x['sequence'] >= 0 &&
    typeof x['timestamp'] === 'string' &&
    typeof x['type'] === 'string' &&
    'data' in x
  )
}

export class EventLog implements EventSink {
  constructor(
    readonly directory: string,
    readonly clock: Clock = systemClock,
  ) {}
  private path(sessionId: SessionId) {
    return join(this.directory, `${safeName(sessionId)}.ndjson`)
  }

  private async readAll(sessionId: SessionId): Promise<RuntimeEventEnvelope[]> {
    let text: string
    try {
      text = await readFile(this.path(sessionId), 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw e
    }
    const lines = text.split('\n')
    const result: RuntimeEventEnvelope[] = []
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]?.trim()
      if (!line) continue
      try {
        const parsed: unknown = JSON.parse(line)
        if (!valid(parsed) || parsed.sessionId !== sessionId)
          throw new Error('invalid event envelope')
        result.push(parsed)
      } catch (e) {
        // A crash may leave only the final line partial; corruption in the
        // middle is never silently discarded.
        if (i === lines.length - 1 && !text.endsWith('\n')) {
          const keep = text.lastIndexOf('\n') + 1
          try {
            const h = await open(this.path(sessionId), 'r+')
            try {
              await h.truncate(Buffer.byteLength(text.slice(0, keep)))
            } finally {
              await h.close()
            }
          } catch {
            /* read-only recovery */
          }
          break
        }
        throw e
      }
    }
    for (let i = 1; i < result.length; i++) {
      if (result[i]!.sequence <= result[i - 1]!.sequence)
        throw new Error('event sequence is not strictly monotonic')
    }
    return result
  }

  async append(event: RuntimeEventEnvelope): Promise<void> {
    await this.appendWithSequence(event)
  }

  private async appendWithSequence(event: RuntimeEventEnvelope): Promise<number> {
    if (!valid(event)) throw new TypeError('invalid runtime event envelope')
    const path = this.path(event.sessionId)
    return withFileMutex(path, async () => {
      await mkdir(this.directory, { recursive: true })
      const existing = await this.readAll(event.sessionId)
      const duplicate = existing.find((e) => e.eventId === event.eventId)
      if (duplicate) {
        if (
          JSON.stringify(duplicate.data) !== JSON.stringify(event.data) ||
          duplicate.type !== event.type ||
          duplicate.turnId !== event.turnId
        )
          throw new Error('event id collision')
        return duplicate.sequence
      }
      const sequence = (existing.at(-1)?.sequence ?? 0) + 1
      const next = { ...event, sequence }
      await appendFile(path, JSON.stringify(next) + '\n', { encoding: 'utf8', mode: 0o600 })
      const h = await open(path, 'r+')
      try {
        await h.sync()
      } finally {
        await h.close()
      }
      return sequence
    })
  }

  async emit<TType extends string, TData>(
    sessionId: SessionId,
    type: TType,
    data: TData,
    turnId?: RuntimeEventEnvelope['turnId'],
  ): Promise<RuntimeEventEnvelope<TType, TData>> {
    const event = {
      eventId: createEventId(),
      sequence: 0,
      type,
      timestamp: this.clock.now(),
      sessionId,
      ...(turnId === undefined ? {} : { turnId }),
      data,
    } as RuntimeEventEnvelope<TType, TData>
    const sequence = await this.appendWithSequence(event)
    return { ...event, sequence }
  }
  async list(
    sessionId: SessionId,
    afterEventId?: string,
  ): Promise<readonly RuntimeEventEnvelope[]> {
    const values = await this.readAll(sessionId)
    if (!afterEventId) return values
    const i = values.findIndex((e) => e.eventId === afterEventId)
    return i < 0 ? values : values.slice(i + 1)
  }
  read(sessionId: SessionId, afterEventId?: string) {
    return this.list(sessionId, afterEventId)
  }
}
