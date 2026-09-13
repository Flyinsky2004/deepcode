import { describe, expect, it } from 'vitest'

import {
  createFakeClock,
  formatTimestamp,
  isTimestamp,
  parseTimestamp,
  startStopwatch,
  systemClock,
} from '../../src/core/time.js'

describe('formatTimestamp', () => {
  it('输出 ISO 8601 UTC 且带 Z 后缀', () => {
    expect(formatTimestamp(0)).toBe('1970-01-01T00:00:00.000Z')
  })

  it('保留毫秒精度', () => {
    expect(formatTimestamp(1_700_000_000_123)).toBe('2023-11-14T22:13:20.123Z')
  })

  it('对非有限值抛错，避免把 Invalid Date 写进磁盘', () => {
    expect(() => formatTimestamp(Number.NaN)).toThrow(RangeError)
    expect(() => formatTimestamp(Number.POSITIVE_INFINITY)).toThrow(RangeError)
  })
})

describe('parseTimestamp', () => {
  it('与 formatTimestamp 往返一致', () => {
    const ms = 1_700_000_000_123
    expect(parseTimestamp(formatTimestamp(ms))).toBe(ms)
  })

  it('无法解析时返回 undefined 而非抛错', () => {
    expect(parseTimestamp('')).toBeUndefined()
    expect(parseTimestamp('not a date')).toBeUndefined()
  })
})

describe('isTimestamp', () => {
  it('接受合法时间戳字符串', () => {
    expect(isTimestamp('2026-09-14T02:39:11.123Z')).toBe(true)
  })

  it('拒绝非字符串与非法字符串', () => {
    expect(isTimestamp(1700000000000)).toBe(false)
    expect(isTimestamp('nope')).toBe(false)
    expect(isTimestamp(null)).toBe(false)
  })
})

describe('createFakeClock', () => {
  it('可推进并反映到 now / nowMs', () => {
    const clock = createFakeClock(1000)
    expect(clock.nowMs()).toBe(1000)
    expect(clock.now()).toBe('1970-01-01T00:00:01.000Z')

    clock.advance(500)
    expect(clock.nowMs()).toBe(1500)
    expect(clock.now()).toBe('1970-01-01T00:00:01.500Z')
  })

  it('可绝对设定', () => {
    const clock = createFakeClock()
    clock.set(1_700_000_000_000)
    expect(clock.nowMs()).toBe(1_700_000_000_000)
  })
})

describe('startStopwatch', () => {
  it('基于注入的时钟测量耗时，不依赖真实时间', () => {
    const clock = createFakeClock(5000)
    const watch = startStopwatch(clock)

    expect(watch.elapsedMs()).toBe(0)
    clock.advance(250)
    expect(watch.elapsedMs()).toBe(250)
  })
})

describe('systemClock', () => {
  it('返回可解析的当前时间', () => {
    const now = systemClock.now()
    expect(isTimestamp(now)).toBe(true)
    expect(parseTimestamp(now)).toBeCloseTo(systemClock.nowMs(), -3)
  })
})
