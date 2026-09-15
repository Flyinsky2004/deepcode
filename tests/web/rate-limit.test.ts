/**
 * 限流与连接数控制。
 *
 * 时间从注入的时钟取，因此这里没有一个 `sleep`——限流测试最怕的就是
 * "靠真实时间等着"，那既是 flaky 的来源，也让边界值（刚好用完、刚好补充）
 * 根本没法断言。
 */

import { describe, expect, it } from 'vitest'

import {
  ConnectionLimiter,
  TokenBucketLimiter,
  clientKey,
} from '../../src/clients/web/rate-limit.js'

function clock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let value = start
  return {
    now: () => value,
    advance: (ms) => {
      value += ms
    },
  }
}

describe('TokenBucketLimiter', () => {
  it('容量 = burst，用完后拒绝并给出重试间隔', () => {
    const time = clock()
    const limiter = new TokenBucketLimiter({ perMinute: 60, burst: 3, now: time.now })

    expect(limiter.check('a').ok).toBe(true)
    expect(limiter.check('a').ok).toBe(true)
    expect(limiter.check('a').ok).toBe(true)

    const denied = limiter.check('a')
    expect(denied.ok).toBe(false)
    if (denied.ok) return
    // 60/min = 1 令牌/秒 → 缺 1 个令牌要等 1000ms
    expect(denied.retryAfterMs).toBe(1000)
  })

  it('按时间补充，补充到容量为止', () => {
    const time = clock()
    const limiter = new TokenBucketLimiter({ perMinute: 60, burst: 2, now: time.now })

    limiter.check('a')
    limiter.check('a')
    expect(limiter.check('a').ok).toBe(false)

    time.advance(1000)
    expect(limiter.check('a').ok).toBe(true)
    expect(limiter.check('a').ok).toBe(false)

    // 放很久也只会回到容量上限，不会攒出一大堆令牌
    time.advance(600_000)
    expect(limiter.check('a').ok).toBe(true)
    expect(limiter.check('a').ok).toBe(true)
    expect(limiter.check('a').ok).toBe(false)
  })

  it('不同的键互不影响（每个 IP 一个桶）', () => {
    const time = clock()
    const limiter = new TokenBucketLimiter({ perMinute: 60, burst: 1, now: time.now })
    expect(limiter.check('a').ok).toBe(true)
    expect(limiter.check('a').ok).toBe(false)
    expect(limiter.check('b').ok).toBe(true)
  })

  it('reset 清空某个键', () => {
    const time = clock()
    const limiter = new TokenBucketLimiter({ perMinute: 60, burst: 1, now: time.now })
    limiter.check('a')
    limiter.reset('a')
    expect(limiter.check('a').ok).toBe(true)
  })

  it('perMinute = 0 表示完全禁止，重试间隔为无穷（不是 0）', () => {
    const time = clock()
    const limiter = new TokenBucketLimiter({ perMinute: 0, burst: 1, now: time.now })
    expect(limiter.check('a').ok).toBe(true)
    const denied = limiter.check('a')
    expect(denied.ok).toBe(false)
    if (denied.ok) return
    expect(Number.isFinite(denied.retryAfterMs)).toBe(false)
  })

  it('桶表不会无限增长：回满的桶会被剪掉', () => {
    const time = clock()
    const limiter = new TokenBucketLimiter({ perMinute: 60, burst: 1, now: time.now })
    for (let index = 0; index < 6_000; index += 1) limiter.check(`key-${String(index)}`)
    // 剪枝应当把表压回上限的一半左右
    expect(limiter.size).toBeLessThan(6_000)
  })
})

describe('ConnectionLimiter', () => {
  it('总数上限', () => {
    const limiter = new ConnectionLimiter({ total: 2, perPrincipal: 10 })
    const a = limiter.acquire('p1')
    const b = limiter.acquire('p2')
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)

    const third = limiter.acquire('p3')
    expect(third.ok).toBe(false)
    if (third.ok) return
    expect(third.code).toBe('total')
  })

  it('单主体上限', () => {
    const limiter = new ConnectionLimiter({ total: 10, perPrincipal: 1 })
    expect(limiter.acquire('p1').ok).toBe(true)
    const second = limiter.acquire('p1')
    expect(second.ok).toBe(false)
    if (second.ok) return
    expect(second.code).toBe('per-principal')
    expect(limiter.acquire('p2').ok).toBe(true)
  })

  it('释放后可再次占用，且重复释放不会把计数减成负数', () => {
    const limiter = new ConnectionLimiter({ total: 1, perPrincipal: 1 })
    const first = limiter.acquire('p1')
    expect(first.ok).toBe(true)
    if (!first.ok) return

    // close 与 error 可能都触发释放；幂等是必须的，否则"上限"形同虚设。
    first.lease.release()
    first.lease.release()
    expect(limiter.total).toBe(0)

    expect(limiter.acquire('p1').ok).toBe(true)
  })

  it('上限为 0 表示禁止连接', () => {
    const limiter = new ConnectionLimiter({ total: 0, perPrincipal: 0 })
    expect(limiter.acquire('p1').ok).toBe(false)
  })

  it('countFor 反映单主体占用', () => {
    const limiter = new ConnectionLimiter({ total: 10, perPrincipal: 10 })
    limiter.acquire('p1')
    limiter.acquire('p1')
    expect(limiter.countFor('p1')).toBe(2)
    expect(limiter.countFor('p2')).toBe(0)
  })
})

describe('clientKey', () => {
  it('取 remoteAddress，缺失时归到 unknown', () => {
    expect(clientKey('127.0.0.1')).toBe('127.0.0.1')
    expect(clientKey(undefined)).toBe('unknown')
    expect(clientKey('')).toBe('unknown')
  })
})
