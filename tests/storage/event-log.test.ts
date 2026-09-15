import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createSessionId } from '../../src/core/ids.js'
import { EventLog } from '../../src/storage/event-log.js'

const newLog = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'deepcode-eventlog-'))
  return { dir, log: new EventLog(dir) }
}

describe('EventLog：写入与序号', () => {
  it('序号按会话单调递增，从 1 开始', async () => {
    const { log } = await newLog()
    const session = createSessionId()

    const a = await log.emit(session, 'turn_start', { turn_number: 1 })
    const b = await log.emit(session, 'text', { content: 'hi' })

    expect(a.sequence).toBe(1)
    expect(b.sequence).toBe(2)
  })

  it('重复写入同一 eventId 不产生新事件，返回原序号', async () => {
    const { log } = await newLog()
    const session = createSessionId()

    const first = await log.emit(session, 'text', { content: 'x' })
    await log.append(first)
    await log.append(first)

    const all = await log.list(session)
    expect(all).toHaveLength(1)
    expect(all[0]?.sequence).toBe(1)
  })

  it('同一 eventId 携带不同内容时抛错，而不是静默接受', async () => {
    const { log } = await newLog()
    const session = createSessionId()

    const first = await log.emit(session, 'text', { content: 'x' })

    await expect(log.append({ ...first, data: { content: 'tampered' } })).rejects.toThrow(
      'event id collision',
    )
  })

  it('会话之间互不干扰', async () => {
    const { log } = await newLog()
    const a = createSessionId()
    const b = createSessionId()

    await log.emit(a, 'text', { content: 'a1' })
    await log.emit(b, 'text', { content: 'b1' })
    const a2 = await log.emit(a, 'text', { content: 'a2' })

    expect(a2.sequence).toBe(2)
    expect(await log.list(a)).toHaveLength(2)
    expect(await log.list(b)).toHaveLength(1)
  })
})

describe('EventLog：缓存不改变可观测行为', () => {
  it('连续 append 后读取仍返回全部事件', async () => {
    const { log } = await newLog()
    const session = createSessionId()

    for (let i = 0; i < 50; i++) await log.emit(session, 'text', { content: `chunk-${i}` })

    const all = await log.list(session)
    expect(all).toHaveLength(50)
    expect(all.map((e) => e.sequence)).toEqual(Array.from({ length: 50 }, (_v, i) => i + 1))
  })

  it('另一个实例写入后缓存失效，不会漏事件', async () => {
    const { dir, log } = await newLog()
    const session = createSessionId()

    await log.emit(session, 'text', { content: 'first' })
    // 建立缓存
    expect(await log.list(session)).toHaveLength(1)

    // 第二个实例（模拟另一个进程）写入同一文件
    const other = new EventLog(dir)
    await other.emit(session, 'text', { content: 'second' })

    const all = await log.list(session)
    expect(all).toHaveLength(2)
    expect(all[1]?.sequence).toBe(2)
  })

  it('close() 后仍可继续读写（缓存重建）', async () => {
    const { log } = await newLog()
    const session = createSessionId()

    await log.emit(session, 'text', { content: 'before' })
    log.close()
    await log.emit(session, 'text', { content: 'after' })

    expect(await log.list(session)).toHaveLength(2)
  })

  it('lastSequence 反映最新序号', async () => {
    const { log } = await newLog()
    const session = createSessionId()

    expect(await log.lastSequence(session)).toBe(0)
    await log.emit(session, 'text', { content: 'a' })
    expect(await log.lastSequence(session)).toBe(1)
  })
})

describe('EventLog.listAfter：补发锚点三态', () => {
  it('锚点存在且后面还有事件 → found=true，返回其后的部分', async () => {
    const { log } = await newLog()
    const session = createSessionId()

    const first = await log.emit(session, 'text', { content: '1' })
    await log.emit(session, 'text', { content: '2' })
    await log.emit(session, 'text', { content: '3' })

    const result = await log.listAfter(session, first.eventId)
    expect(result.found).toBe(true)
    expect(result.events.map((e) => e.sequence)).toEqual([2, 3])
  })

  it('锚点就是最后一条 → found=true，补发为空（表示已追平）', async () => {
    const { log } = await newLog()
    const session = createSessionId()

    await log.emit(session, 'text', { content: '1' })
    const last = await log.emit(session, 'text', { content: '2' })

    const result = await log.listAfter(session, last.eventId)
    expect(result.found).toBe(true)
    expect(result.events).toEqual([])
  })

  it('锚点不存在 → found=false，返回全量（调用方应转为 RESYNC）', async () => {
    const { log } = await newLog()
    const session = createSessionId()

    await log.emit(session, 'text', { content: '1' })
    await log.emit(session, 'text', { content: '2' })

    const result = await log.listAfter(session, 'evt_不存在')
    expect(result.found).toBe(false)
    // 与 list() 的差别就在这里：list() 会静默返回全量，调用方无法察觉
    expect(result.events).toHaveLength(2)
  })

  it('锚点来自另一个会话 → found=false', async () => {
    const { log } = await newLog()
    const a = createSessionId()
    const b = createSessionId()

    const inA = await log.emit(a, 'text', { content: 'a' })
    await log.emit(b, 'text', { content: 'b' })

    const result = await log.listAfter(b, inA.eventId)
    expect(result.found).toBe(false)
    expect(result.events).toHaveLength(1)
  })

  it('空日志上的任意锚点 → found=false 且事件为空', async () => {
    const { log } = await newLog()
    const result = await log.listAfter(createSessionId(), 'evt_x')
    expect(result.found).toBe(false)
    expect(result.events).toEqual([])
  })
})
