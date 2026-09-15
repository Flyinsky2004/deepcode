/**
 * i18n 表与查找行为（`parts/05` §10）。
 *
 * 两条硬性要求写成断言：
 * 1. **EN 与 ZH 的键集完全相同**——缺一个键就会在中文界面下显示点分键名；
 * 2. **缺键返回键名本身，不抛错**（旧实现 `t()` 的 `str(key)` 行为）。
 */

import { describe, expect, it } from 'vitest'

import { ALL_KEYS, Language, TKey } from '../../src/clients/tui/i18n/keys.js'
import { EN, I18nStore, translate, ZH } from '../../src/clients/tui/i18n/index.js'

describe('i18n 键集', () => {
  it('EN 与 ZH 的键集完全相同', () => {
    const en = Object.keys(EN).sort()
    const zh = Object.keys(ZH).sort()
    expect(zh).toEqual(en)
    // 双向差集都为空（防止"两边都缺同一个键"也能通过上面的相等断言）。
    expect(en.filter((key) => !(key in ZH))).toEqual([])
    expect(zh.filter((key) => !(key in EN))).toEqual([])
  })

  it('ALL_KEYS 与两张表的键集一致', () => {
    expect([...ALL_KEYS].sort()).toEqual(Object.keys(EN).sort())
  })

  it('每个键都有非空文案', () => {
    for (const key of ALL_KEYS) {
      expect(EN[key].length, key).toBeGreaterThan(0)
      expect(ZH[key].length, key).toBeGreaterThan(0)
    }
  })

  it('键的值是点分字符串（不是自增枚举）', () => {
    for (const key of ALL_KEYS) expect(key).toMatch(/^[a-z0-9_.]+$/)
  })
})

describe('translate', () => {
  it('缺键返回键名本身，不抛错', () => {
    expect(translate(Language.EN, 'no.such.key')).toBe('no.such.key')
    expect(translate(Language.ZH, 'no.such.key')).toBe('no.such.key')
  })

  it('未知语言退回英文表', () => {
    expect(translate('fr' as Language, TKey.LABEL_YOU)).toBe(EN[TKey.LABEL_YOU])
  })

  it('无参数时原样返回模板', () => {
    expect(translate(Language.EN, TKey.STATUS_THINK)).toBe('Think: {status}')
  })

  it('用 {name} 占位符插值（与旧 Python 表逐字兼容）', () => {
    expect(translate(Language.EN, TKey.STATUS_THINK, { status: 'ON' })).toBe('Think: ON')
    expect(translate(Language.ZH, TKey.STATUS_THINK, { status: 'ON' })).toBe('思考: ON')
  })

  it('未提供的占位符原样保留（让漏传参数可见）', () => {
    expect(translate(Language.EN, TKey.STATUS_MSGS, {})).toBe('{count} msgs')
  })

  it('数字参数被转成字符串', () => {
    expect(translate(Language.EN, TKey.STATUS_MSGS, { count: 12 })).toBe('12 msgs')
  })

  it('权限模板保留 Markdown 结构与转义', () => {
    const text = translate(Language.EN, TKey.PERM_TITLE, {
      tool: 'file_write',
      risk: 'HIGH',
      args: '{"path":"a"}',
      reason: 'needs approval',
    })
    expect(text.startsWith('## Permission Required')).toBe(true)
    expect(text).toContain('**Tool:** file_write')
    expect(text).toContain('**Risk:** HIGH')
    expect(text).toContain('Press **Enter** to approve, or **n** to deny')
  })
})

describe('I18nStore', () => {
  it('默认英文', () => {
    expect(new I18nStore().language).toBe(Language.EN)
    expect(new I18nStore().t(TKey.LABEL_YOU)).toBe('You')
  })

  it('非法语言静默退回英文（对应旧 _load_language 的 except ValueError）', () => {
    expect(new I18nStore('de' as Language).language).toBe(Language.EN)
  })

  it('withLanguage 返回新实例，不原地修改（不可变契约）', () => {
    const en = new I18nStore(Language.EN)
    const zh = en.withLanguage(Language.ZH)
    expect(zh).not.toBe(en)
    expect(en.language).toBe(Language.EN)
    expect(en.t(TKey.LABEL_YOU)).toBe('You')
    expect(zh.t(TKey.LABEL_YOU)).toBe('你')
  })

  it('同语言切换返回同一实例（避免无谓重渲染）', () => {
    const en = new I18nStore(Language.EN)
    expect(en.withLanguage(Language.EN)).toBe(en)
  })
})
