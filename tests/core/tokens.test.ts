import { describe, expect, it } from 'vitest'
import { CharacterTokenEstimator, defaultTokenEstimator } from '../../src/core/tokens.js'

describe('CharacterTokenEstimator', () => {
  const est = new CharacterTokenEstimator()

  it('空文本为 0', () => {
    expect(est.estimate('')).toBe(0)
  })

  it('单字符至少为 1', () => {
    expect(est.estimate('a')).toBe(1)
  })

  it('纯 ASCII 按 0.3 权重', () => {
    // 10 * 0.3 = 3
    expect(est.estimate('abcdefghij')).toBe(3)
  })

  it('纯 CJK 按 1.5 权重', () => {
    // 4 * 1.5 = 6
    expect(est.estimate('中文测试')).toBe(6)
  })

  it('emoji 按码点计数，不是 UTF-16 码元', () => {
    // 1 个码点 * 0.3 = 0.3 -> floor 0 -> max(1,0) = 1
    expect(est.estimate('😀')).toBe(1)
    // 10 个 emoji = 10 码点 * 0.3 = 3（若按 length 会算成 20 -> 6）
    expect(est.estimate('😀'.repeat(10))).toBe(3)
  })

  it('中日文假名不匹配 CJK（与旧实现一致）', () => {
    // あ 是 3 字节 UTF-8 但 1 个码点，非 CJK 区间 -> 0.3
    expect(est.estimate('あ')).toBe(1)
  })

  it('中英混排', () => {
    // 2 汉字 * 1.5 + 4 ascii * 0.3 = 3 + 1.2 = 4.2 -> 4
    expect(est.estimate('中文abcd')).toBe(4)
  })

  it('estimateMessages 求和', () => {
    expect(est.estimateMessages([{ content: 'abcd' }, { content: '中文' }])).toBe(
      est.estimate('abcd') + est.estimate('中文'),
    )
  })

  it('estimateApiMessages 对序列化整体估算', () => {
    const msgs = [{ role: 'user', content: 'hi' }]
    const expected = est.estimate(JSON.stringify(msgs[0]))
    expect(est.estimateApiMessages(msgs)).toBe(expected)
  })

  it('循环引用不抛异常', () => {
    const a: Record<string, unknown> = {}
    a['self'] = a
    expect(est.estimateApiMessages([a])).toBe(0)
  })

  it('默认实例可用', () => {
    expect(defaultTokenEstimator.estimate('中文')).toBe(3)
  })
})
