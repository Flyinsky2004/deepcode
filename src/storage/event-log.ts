import { appendFile, mkdir, open, readFile, stat } from 'node:fs/promises'
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

/**
 * 单会话的读取缓存。
 *
 * 目的是消除 append 的 O(n²)：原实现对**每一次** append 都重新读取并解析
 * 整个 NDJSON 文件，而一个 turn 里每段流式文本都会产生一个事件。
 *
 * 用文件 `size` 做失效判据：磁盘上的事件文件只会追加，因此"大小未变"
 * 等价于"内容未变"。这样即使有另一个进程（或另一次 `EventLog` 实例）
 * 写过同一个文件，缓存也会自动失效并重新读取。
 */
interface SessionCache {
  /** 文件字节数，用于判断缓存是否仍然有效。 */
  size: number
  /** 已解析的全部事件，按写入顺序。 */
  events: RuntimeEventEnvelope[]
}

/** 最多缓存多少个会话的完整事件列表。超过则按插入顺序淘汰最旧的一个。 */
const MAX_CACHED_SESSIONS = 8

/**
 * 按 session 分文件的 append-only 事件日志（NDJSON）。
 *
 * 是**补发的唯一权威**（`parts/09` §1.1：「WebSocket 重连必须支持 `lastEventId`，
 * 服务器从持久化事件日志补发，**不能只依赖内存队列**」）。
 *
 * 每行一个事件信封。写入使用 `fsync`，因此进程在写入后崩溃不会丢掉已确认的事件。
 */
export class EventLog implements EventSink {
  /** sessionId → 缓存。用 Map 的插入顺序实现最简 LRU。 */
  readonly #cache = new Map<SessionId, SessionCache>()

  constructor(
    readonly directory: string,
    readonly clock: Clock = systemClock,
  ) {}

  private path(sessionId: SessionId) {
    return join(this.directory, `${safeName(sessionId)}.ndjson`)
  }

  /** 取缓存；若文件大小已变则失效并丢弃。 */
  #cached(sessionId: SessionId, size: number): SessionCache | undefined {
    const cached = this.#cache.get(sessionId)
    if (!cached || cached.size !== size) {
      this.#cache.delete(sessionId)
      return undefined
    }
    // 重新插入以标记为"最近使用"。
    this.#cache.delete(sessionId)
    this.#cache.set(sessionId, cached)
    return cached
  }

  #store(sessionId: SessionId, value: SessionCache): void {
    this.#cache.delete(sessionId)
    this.#cache.set(sessionId, value)
    while (this.#cache.size > MAX_CACHED_SESSIONS) {
      const oldest = this.#cache.keys().next()
      if (oldest.done === true) break
      this.#cache.delete(oldest.value)
    }
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

  /** 读全部事件，命中缓存时避免重复解析。 */
  private async readCached(sessionId: SessionId): Promise<SessionCache> {
    const info = await stat(this.path(sessionId)).catch(() => undefined)
    const size = info?.size ?? 0
    const cached = this.#cached(sessionId, size)
    if (cached) return cached
    const events = await this.readAll(sessionId)
    const value: SessionCache = { size, events }
    this.#store(sessionId, value)
    return value
  }

  async append(event: RuntimeEventEnvelope): Promise<void> {
    await this.appendWithSequence(event)
  }

  /**
   * 追加事件并返回**带权威序号**的副本。
   *
   * `EventSink.append` 的契约是 `Promise<void>`，扇出时拿不到序号；
   * 而订阅者需要序号去做补发去重与"已追平"判定（见 `src/app/event-bus.ts`）。
   */
  async appendWithResult(event: RuntimeEventEnvelope): Promise<RuntimeEventEnvelope> {
    const sequence = await this.appendWithSequence(event)
    return { ...event, sequence }
  }

  private async appendWithSequence(event: RuntimeEventEnvelope): Promise<number> {
    if (!valid(event)) throw new TypeError('invalid runtime event envelope')
    const path = this.path(event.sessionId)
    return withFileMutex(path, async () => {
      await mkdir(this.directory, { recursive: true })
      const cache = await this.readCached(event.sessionId)
      const existing = cache.events
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
      const line = JSON.stringify(next) + '\n'
      await appendFile(path, line, { encoding: 'utf8', mode: 0o600 })
      const h = await open(path, 'r+')
      try {
        await h.sync()
      } finally {
        await h.close()
      }
      // 原地推进缓存，避免下一次 append 重新读盘。
      cache.events.push(next)
      cache.size += Buffer.byteLength(line)
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

  /**
   * 列出某会话的全部事件，可选从 `afterEventId` 之后开始。
   *
   * ⚠️ 锚点不存在时**返回全量**——调用方无法区分"补发完毕"与"已追平"。
   * 需要区分时用 `listAfter`。
   */
  async list(
    sessionId: SessionId,
    afterEventId?: string,
  ): Promise<readonly RuntimeEventEnvelope[]> {
    const values = (await this.readCached(sessionId)).events
    if (!afterEventId) return values
    const i = values.findIndex((e) => e.eventId === afterEventId)
    return i < 0 ? values : values.slice(i + 1)
  }

  read(sessionId: SessionId, afterEventId?: string) {
    return this.list(sessionId, afterEventId)
  }

  /**
   * 补发读取：**区分"锚点找到了"与"锚点不存在"**。
   *
   * `found === false` 时 `events` 是全量日志，调用方应当走
   * `EVENT_RESYNC_REQUIRED` 路径让客户端重建视图，而不是把这批全量事件
   * 当作补发推下去——那会让客户端重复渲染整个 transcript。
   */
  async listAfter(
    sessionId: SessionId,
    afterEventId: string,
  ): Promise<{ readonly found: boolean; readonly events: readonly RuntimeEventEnvelope[] }> {
    const values = (await this.readCached(sessionId)).events
    const i = values.findIndex((e) => e.eventId === afterEventId)
    if (i < 0) return { found: false, events: values }
    return { found: true, events: values.slice(i + 1) }
  }

  /** 当前日志里的最后一个序号（空日志为 0）。 */
  async lastSequence(sessionId: SessionId): Promise<number> {
    const values = (await this.readCached(sessionId)).events
    return values.at(-1)?.sequence ?? 0
  }

  /** 释放缓存。关闭后仍可继续使用（缓存会重新建立）。 */
  close(): void {
    this.#cache.clear()
  }
}
