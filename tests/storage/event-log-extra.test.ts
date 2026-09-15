/**
 * `EventLog` 的**损坏处理与读取边界**。
 *
 * `event-log.test.ts` 覆盖了正常读写、缓存失效与补发锚点三态。这里补的是
 * 事件日志作为"**补发的唯一权威**"（`parts/09` §1.1）必须扛住的东西：
 *
 * - 进程写到一半崩溃留下的**半行**——可以丢这半行，但不能因此读不出整个日志；
 * - 中间的损坏——**绝不能静默丢弃**（丢一条就等于客户端永久缺一条）；
 * - 序号非单调——宁可报错也不能把乱序当成正常序列发下去；
 * - 文件读不了（不是"不存在"，而是真的读不了）——必须报错而不是假装空日志。
 */
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createSessionId, createEventId, type SessionId } from '../../src/core/ids.js'
import { EventLog } from '../../src/storage/event-log.js'
import type { RuntimeEventEnvelope } from '../../src/core/events.js'

/** 复刻 EventLog 内部的文件命名，用来直接往盘上写"坏数据"。 */
const fileFor = (dir: string, sessionId: SessionId): string =>
  join(dir, `${createHash('sha256').update(sessionId).digest('hex')}.ndjson`)

const newLog = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'deepcode-eventlog-extra-'))
  return { dir, log: new EventLog(dir) }
}

const envelope = (over: Partial<RuntimeEventEnvelope> = {}): RuntimeEventEnvelope => ({
  eventId: createEventId(),
  sequence: 1,
  type: 'text',
  timestamp: '2026-09-15T00:00:00.000Z',
  sessionId: createSessionId(),
  data: {},
  ...over,
})

describe('EventLog：写入前的形状校验', () => {
  it('append 一个不合法的信封直接抛 TypeError，不写坏日志', async () => {
    // 写进去一条脏数据会让**之后每一次**读取都失败（整条日志读不出来），
    // 所以校验必须在写之前，而不是读取时补救。
    const { dir, log } = await newLog()
    const session = createSessionId()

    await expect(log.append({} as never)).rejects.toThrow(TypeError)
    await expect(log.appendWithResult({ type: 1 } as never)).rejects.toThrow(TypeError)
    // 没有产生文件
    await expect(readFile(fileFor(dir, session), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('序号不是非负整数时同样被拒（序号是补发去重的唯一依据）', async () => {
    const { log } = await newLog()
    const session = createSessionId()

    await expect(log.append(envelope({ sessionId: session, sequence: -1 }))).rejects.toThrow(
      TypeError,
    )
    await expect(log.append(envelope({ sessionId: session, sequence: 1.5 }))).rejects.toThrow(
      TypeError,
    )
    // 'data' 字段缺失（哪怕值就是 undefined 也要有键）
    const withoutData = envelope({ sessionId: session })
    delete (withoutData as { data?: unknown }).data
    await expect(log.append(withoutData)).rejects.toThrow(TypeError)
  })

  it('emit 带 turnId 时信封里保留它（历史回放要靠它把事件归到某个 turn）', async () => {
    const { log } = await newLog()
    const session = createSessionId()

    const plain = await log.emit(session, 'text', { content: 'a' })
    const withTurn = await log.emit(session, 'text', { content: 'b' }, 'turn_x' as never)

    expect(plain.turnId).toBeUndefined()
    expect(withTurn.turnId).toBe('turn_x')

    const all = await log.list(session)
    expect(all[1]?.turnId).toBe('turn_x')
  })
})

describe('EventLog：半行与损坏', () => {
  it('崩溃留下的半行被截掉，前面的完整事件照常读出', async () => {
    // "写了一半就断电"是 append-only NDJSON 的常态。丢掉那半行是对的；
    // 若因此让整份日志读不出来，客户端就永远重建不了视图。
    const { dir, log } = await newLog()
    const session = createSessionId()
    const good = envelope({ sessionId: session, sequence: 1 })
    const half = '{"eventId":"evt_half","sessionId":"x","sequence":2,"type":"te'

    await writeFile(fileFor(dir, session), `${JSON.stringify(good)}\n${half}`, 'utf8')

    const events = await log.list(session)
    expect(events.map((e) => e.sequence)).toEqual([1])

    // 半行被就地截断，文件里只剩完整的那一行
    const onDisk = await readFile(fileFor(dir, session), 'utf8')
    expect(onDisk).toBe(`${JSON.stringify(good)}\n`)
  })

  it('半行之后继续 append 时序号接着走（截断后缓存与磁盘一致）', async () => {
    const { dir, log } = await newLog()
    const session = createSessionId()
    const good = envelope({ sessionId: session, sequence: 1 })

    await writeFile(fileFor(dir, session), `${JSON.stringify(good)}\n{"broken":`, 'utf8')

    const next = await log.emit(session, 'text', { content: 'after' })
    expect(next.sequence).toBe(2)
    expect(await log.lastSequence(session)).toBe(2)
  })

  it('中间的损坏**不**被静默丢弃，而是报错', async () => {
    // 丢中间的坏行等于客户端永久缺一条事件，且它自己无从察觉。
    const { dir, log } = await newLog()
    const session = createSessionId()
    const a = envelope({ sessionId: session, sequence: 1 })
    const b = envelope({ sessionId: session, sequence: 3 })

    // 坏行**不是**最后一行（后面还有换行与好数据）
    await writeFile(
      fileFor(dir, session),
      `${JSON.stringify(a)}\n{"不是合法信封":true}\n${JSON.stringify(b)}\n`,
      'utf8',
    )

    await expect(log.list(session)).rejects.toThrow('invalid event envelope')
  })

  it('不是对象的行（null / 数字 / 字符串）同样算损坏', async () => {
    for (const bad of ['null', '123', '"字符串"']) {
      const { dir, log } = await newLog()
      const session = createSessionId()
      await writeFile(
        fileFor(dir, session),
        `${bad}\n${JSON.stringify(envelope({ sessionId: session }))}\n`,
        'utf8',
      )
      await expect(log.list(session)).rejects.toThrow('invalid event envelope')
    }
  })

  it('信封里的 sessionId 与文件不匹配时算损坏，而不是"恰好读到别人的事件"', async () => {
    // 文件是按 sessionId 哈希命名的；内容对不上说明文件被改过或写串了，
    // 静默接受会让 A 会话读到 B 会话的事件。
    const { dir, log } = await newLog()
    const session = createSessionId()
    const other = envelope({ sessionId: createSessionId() })

    await writeFile(
      fileFor(dir, session),
      `${JSON.stringify({ ...other, sessionId: other.sessionId })}\n`,
      'utf8',
    )

    await expect(log.list(session)).rejects.toThrow('invalid event envelope')
  })

  it('序号非严格递增时报错，而不是把乱序当成正常序列发出去', async () => {
    const { dir, log } = await newLog()
    const session = createSessionId()
    const two = envelope({ sessionId: session, sequence: 2 })
    const one = envelope({ sessionId: session, sequence: 1 })

    await writeFile(
      fileFor(dir, session),
      `${JSON.stringify(two)}\n${JSON.stringify(one)}\n`,
      'utf8',
    )

    await expect(log.list(session)).rejects.toThrow('not strictly monotonic')
  })

  it('序号相等也算非严格递增', async () => {
    const { dir, log } = await newLog()
    const session = createSessionId()
    const a = envelope({ sessionId: session, sequence: 1 })
    const b = envelope({ sessionId: session, sequence: 1 })

    await writeFile(fileFor(dir, session), `${JSON.stringify(a)}\n${JSON.stringify(b)}\n`, 'utf8')
    await expect(log.list(session)).rejects.toThrow('not strictly monotonic')
  })
})

describe('EventLog：读取失败与不存在的区别', () => {
  it('文件永不存在的会话返回空日志（不是错误）', async () => {
    const { log } = await newLog()
    expect(await log.list(createSessionId())).toEqual([])
    expect(await log.lastSequence(createSessionId())).toBe(0)
    expect(await log.listAfter(createSessionId(), 'evt_x')).toEqual({ found: false, events: [] })
  })

  it('路径存在但读不了（是个目录）时报错，而不是假装空日志', async () => {
    // 假装空日志会让客户端以为"这个会话没有任何事件"，进而**清空已渲染的视图**。
    const { dir, log } = await newLog()
    const session = createSessionId()
    await mkdir(fileFor(dir, session))

    await expect(log.list(session)).rejects.toMatchObject({ code: 'EISDIR' })
  })
})

describe('EventLog：list 的锚点语义与 read 别名', () => {
  it('list(session, 锚点) 锚点存在时只返回其后的部分', async () => {
    const { log } = await newLog()
    const session = createSessionId()
    const first = await log.emit(session, 'text', { content: '1' })
    await log.emit(session, 'text', { content: '2' })
    await log.emit(session, 'text', { content: '3' })

    expect((await log.list(session, first.eventId)).map((e) => e.sequence)).toEqual([2, 3])
  })

  it('list(session, 锚点) 锚点不存在时**返回全量**（这正是要改用 listAfter 的原因）', async () => {
    // 这个"静默返回全量"是已知的坑：调用方无法区分"补发完毕"与"已追平"，
    // 客户端会把整个 transcript 重绘一遍。`listAfter` 就是为了替代它。
    const { log } = await newLog()
    const session = createSessionId()
    await log.emit(session, 'text', { content: '1' })
    await log.emit(session, 'text', { content: '2' })

    expect((await log.list(session, 'evt_不存在')).map((e) => e.sequence)).toEqual([1, 2])
  })

  it('不传锚点时返回全部事件', async () => {
    const { log } = await newLog()
    const session = createSessionId()
    await log.emit(session, 'text', { content: '1' })
    expect((await log.list(session)).map((e) => e.sequence)).toEqual([1])
  })

  it('read() 是 list() 的别名（旧调用点仍在用）', async () => {
    const { log } = await newLog()
    const session = createSessionId()
    const first = await log.emit(session, 'text', { content: '1' })
    await log.emit(session, 'text', { content: '2' })

    expect((await log.read(session)).map((e) => e.sequence)).toEqual([1, 2])
    expect((await log.read(session, first.eventId)).map((e) => e.sequence)).toEqual([2])
  })
})

describe('EventLog：会话缓存的上限', () => {
  it('写入超过缓存上限的会话数后，每个会话的事件仍完整可读', async () => {
    // 缓存是 LRU（上限 8），超出后淘汰最旧的一个。淘汰只该影响性能，
    // 不该影响可观测结果——这里用 12 个会话越界验证。
    const { log } = await newLog()
    const sessions = Array.from({ length: 12 }, () => createSessionId())

    for (const [index, session] of sessions.entries()) {
      await log.emit(session, 'text', { content: `s${index}-1` })
      await log.emit(session, 'text', { content: `s${index}-2` })
    }

    for (const session of sessions) {
      const events = await log.list(session)
      expect(events.map((e) => e.sequence)).toEqual([1, 2])
    }
  })

  it('close() 清空缓存后，重复读取仍然拿到同一份事件（不重不漏）', async () => {
    const { log } = await newLog()
    const session = createSessionId()
    await log.emit(session, 'text', { content: '1' })
    const before = await log.list(session)

    log.close()
    expect(await log.list(session)).toEqual(before)
  })
})
