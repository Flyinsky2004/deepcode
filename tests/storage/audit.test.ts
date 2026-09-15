/**
 * `audit.ts` 的摘要与脱敏测试。
 *
 * 这个模块服务于两件事：
 * 1. **幂等与外部修改检测**——`inputHash` 必须对"键顺序不同但内容相同"的两个
 *    对象给出同一个哈希，否则重放会被误判成"内容不一致"并抛
 *    `INVALID_STATE_TRANSITION`；
 * 2. **脱敏**——`argsPreview` 会落进审计记录，凭据、命令原文与文件内容都不能出现。
 */
import { describe, expect, it } from 'vitest'

import { argsPreview, inputHash, redact, stableStringify } from '../../src/storage/audit.js'

describe('stableStringify', () => {
  it('对象键按字典序排序，与书写顺序无关', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
    expect(stableStringify({ a: 2, b: 1 })).toBe(stableStringify({ b: 1, a: 2 }))
  })

  it('嵌套对象与数组同样稳定', () => {
    expect(stableStringify({ x: { d: 1, c: [3, { z: 1, y: 2 }] } })).toBe(
      '{"x":{"c":[3,{"y":2,"z":1}],"d":1}}',
    )
  })

  it('数组保持顺序（顺序是内容的一部分，不能排序）', () => {
    expect(stableStringify([2, 1])).toBe('[2,1]')
  })

  it('原始类型走 JSON.stringify；undefined 落成字符串 null', () => {
    expect(stableStringify('s')).toBe('"s"')
    expect(stableStringify(1)).toBe('1')
    expect(stableStringify(true)).toBe('true')
    // JSON.stringify(undefined) 返回 undefined，用 'null' 兜底避免产出 undefined
    expect(stableStringify(undefined)).toBe('null')
    expect(stableStringify(null)).toBe('null')
  })

  it('函数与 symbol 这类无法 JSON 化的值落成 null（不抛错）', () => {
    expect(stableStringify(() => undefined)).toBe('null')
    expect(stableStringify(Symbol('s'))).toBe('null')
  })
})

describe('inputHash', () => {
  it('键顺序不同但内容相同的对象哈希一致（幂等重放的关键）', () => {
    expect(inputHash({ command: 'ls', timeout: 30 })).toBe(
      inputHash({ timeout: 30, command: 'ls' }),
    )
  })

  it('内容不同则哈希不同', () => {
    expect(inputHash({ command: 'ls' })).not.toBe(inputHash({ command: 'rm' }))
  })

  it('数组顺序不同视为不同输入', () => {
    expect(inputHash([1, 2])).not.toBe(inputHash([2, 1]))
  })

  it('返回 sha256 十六进制串（长度固定，可作为稳定契约）', () => {
    expect(inputHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('redact', () => {
  it('键名命中敏感词时整块替换为 [redacted]', () => {
    expect(redact({ apiKey: 'sk-1' })).toEqual({ apiKey: '[redacted]' })
    expect(redact({ token: 't' })).toEqual({ token: '[redacted]' })
    expect(redact({ password: 'p' })).toEqual({ password: '[redacted]' })
    expect(redact({ Authorization: 'Bearer x' })).toEqual({ Authorization: '[redacted]' })
    expect(redact({ secret: 's' })).toEqual({ secret: '[redacted]' })
  })

  it('content 与 command 也整体脱敏（文件内容与命令原文同样敏感）', () => {
    expect(redact({ content: '文件内容' })).toEqual({ content: '[redacted]' })
    expect(redact({ command: 'curl -H "Authorization: x" https://x' })).toEqual({
      command: '[redacted]',
    })
  })

  it('匹配是子串且大小写不敏感（`monkey` 这类键也会被脱敏）', () => {
    // 观察：正则 /key|token|.../i 作用于整个键名，因此 `monkey`、`hockey` 也会命中。
    // 这是"宁可多脱敏不可漏"的保守取向，不视为缺陷；此处固化现状。
    expect(redact({ monkey: 'x' })).toEqual({ monkey: '[redacted]' })
    expect(redact({ TOKEN_VALUE: 'x' })).toEqual({ TOKEN_VALUE: '[redacted]' })
  })

  it('非敏感键保留原值，只对子键递归脱敏', () => {
    expect(redact({ path: 'a.txt', nested: { apiKey: 'sk-1' } })).toEqual({
      path: 'a.txt',
      nested: { apiKey: '[redacted]' },
    })
  })

  it('数组按元素递归（数组元素继承不到父键名，需靠子键自证）', () => {
    expect(redact([{ password: 'p' }, 'plain'])).toEqual([{ password: '[redacted]' }, 'plain'])
    // 顶层键名为空串，不命中任何敏感词 → 数组本身不被整体替换
    expect(redact(['sk-ant-secret'])).toEqual(['sk-ant-secret'])
  })

  it('原始类型与 null 原样返回', () => {
    expect(redact('x')).toBe('x')
    expect(redact(3)).toBe(3)
    expect(redact(null)).toBeNull()
    expect(redact(true)).toBe(true)
  })

  it('空对象与空数组不抛错', () => {
    expect(redact({})).toEqual({})
    expect(redact([])).toEqual([])
  })

  it('深层嵌套中的敏感键在任意深度都被脱敏', () => {
    expect(redact({ a: { b: { c: { apiKey: 'sk-1' } } } })).toEqual({
      a: { b: { c: { apiKey: '[redacted]' } } },
    })
  })
})

describe('argsPreview', () => {
  it('产出脱敏后的 JSON 预览', () => {
    const preview = argsPreview({ path: 'a.txt', content: '机密' })
    expect(JSON.parse(preview)).toEqual({ path: 'a.txt', content: '[redacted]' })
  })

  it('超长输入截断到 1000 字符（审计记录不能无界膨胀）', () => {
    const preview = argsPreview({ path: 'x'.repeat(5000) })
    expect(preview).toHaveLength(1000)
  })

  it('截断后的片段仍保持前缀（便于人看开头）', () => {
    expect(argsPreview({ path: 'abcdef' })).toContain('abcdef')
  })
})
