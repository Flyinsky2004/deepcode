import { describe, expect, it } from 'vitest'

import { err, isErr, isOk, mapErr, mapResult, ok, unwrap } from '../../src/core/result.js'

describe('ok / err 构造', () => {
  it('ok 携带值与判别标记', () => {
    expect(ok(1)).toEqual({ ok: true, value: 1 })
  })

  it('err 携带错误与判别标记', () => {
    expect(err('boom')).toEqual({ ok: false, error: 'boom' })
  })

  it('可以承载 undefined 值而不与失败混淆', () => {
    const result = ok(undefined)
    expect(result.ok).toBe(true)
    expect(isOk(result)).toBe(true)
  })
})

describe('isOk / isErr', () => {
  it('对成功结果判定一致', () => {
    const result = ok('v')
    expect(isOk(result)).toBe(true)
    expect(isErr(result)).toBe(false)
  })

  it('对失败结果判定一致', () => {
    const result = err('e')
    expect(isOk(result)).toBe(false)
    expect(isErr(result)).toBe(true)
  })

  it('收窄后可访问对应分支的字段', () => {
    const result = ok(42)
    if (isOk(result)) {
      expect(result.value).toBe(42)
    }
  })
})

describe('unwrap', () => {
  it('成功时取出值', () => {
    expect(unwrap(ok('v'))).toBe('v')
  })

  it('失败时抛出，且消息包含错误内容', () => {
    expect(() => unwrap(err({ code: 'X' }))).toThrow(/unwrap\(\) on Err/)
  })
})

describe('mapResult', () => {
  it('成功时映射值', () => {
    expect(mapResult(ok(2), (n) => n * 2)).toEqual(ok(4))
  })

  it('失败时原样透传，不调用映射函数', () => {
    let called = false
    const result = mapResult(err('e'), () => {
      called = true
      return 'x'
    })

    expect(called).toBe(false)
    expect(result).toEqual(err('e'))
  })
})

describe('mapErr', () => {
  it('失败时映射错误', () => {
    expect(mapErr(err('e'), (e) => `${e}!`)).toEqual(err('e!'))
  })

  it('成功时原样透传，不调用映射函数', () => {
    let called = false
    const result = mapErr(ok(1), () => {
      called = true
      return 'x'
    })

    expect(called).toBe(false)
    expect(result).toEqual(ok(1))
  })
})
