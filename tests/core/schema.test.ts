import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { ErrorCode } from '../../src/core/errors.js'
import {
  flatSettingsSchema,
  readBoolSetting,
  readIntSetting,
  timestampSchema,
  validate,
  validateJsonString,
  validateOrThrow,
  withFallback,
} from '../../src/core/schema.js'

const personSchema = z.object({
  name: z.string(),
  age: z.number().int(),
})

describe('validate', () => {
  it('合法输入返回 ok', () => {
    const result = validate(personSchema, { name: 'a', age: 1 })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toEqual({ name: 'a', age: 1 })
  })

  it('非法输入返回带 VALIDATION_FAILED 的结构化错误', () => {
    const result = validate(personSchema, { name: 'a', age: 'x' }, 'storage')

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.VALIDATION_FAILED)
      expect(result.error.source).toBe('storage')
      expect(result.error.context?.['issues']).toBeDefined()
    }
  })

  it('错误消息包含字段路径，便于定位', () => {
    const result = validate(personSchema, { name: 'a', age: 'x' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain('age')
  })

  it('剥除未知字段而非报错（读入容错）', () => {
    const result = validate(personSchema, { name: 'a', age: 1, unknownField: 'x' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toEqual({ name: 'a', age: 1 })
  })

  it('问题过多时截断，避免错误体过大', () => {
    const wide = z.object(
      Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`f${i}`, z.number()])),
    )
    const result = validate(wide, {})

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.message).toContain('共 40 项')
      expect(result.error.context?.['issues']).toHaveLength(10)
    }
  })
})

describe('validateOrThrow', () => {
  it('合法输入返回值', () => {
    expect(validateOrThrow(personSchema, { name: 'a', age: 1 }).name).toBe('a')
  })

  it('非法输入抛出 AgentError', () => {
    expect(() => validateOrThrow(personSchema, {})).toThrow()
  })
})

describe('validateJsonString', () => {
  it('解析并校验 JSON 字符串', () => {
    const result = validateJsonString(personSchema, '{"name":"a","age":1}')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.name).toBe('a')
  })

  it('非法 JSON 返回 VALIDATION_FAILED 而非抛错', () => {
    const result = validateJsonString(personSchema, '{not json')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe(ErrorCode.VALIDATION_FAILED)
  })

  it('合法 JSON 但结构不符时同样失败', () => {
    const result = validateJsonString(personSchema, '{"name":123}')
    expect(result.ok).toBe(false)
  })
})

describe('withFallback', () => {
  it('校验失败时回落到默认值', () => {
    const schema = withFallback(personSchema, { name: 'default', age: 0 })
    expect(validate(schema, 'garbage').ok).toBe(true)
    expect(validate(schema, 'garbage')).toEqual({
      ok: true,
      value: { name: 'default', age: 0 },
    })
  })

  it('校验成功时使用真实值', () => {
    const schema = withFallback(personSchema, { name: 'default', age: 0 })
    const result = validate(schema, { name: 'real', age: 9 })
    if (result.ok) expect(result.value.name).toBe('real')
  })
})

describe('timestampSchema', () => {
  it('接受合法时间戳', () => {
    expect(validate(timestampSchema, '2026-09-14T02:39:11.123Z').ok).toBe(true)
  })

  it('接受不带毫秒的历史格式（读入容错）', () => {
    expect(validate(timestampSchema, '2026-09-14T02:39:11Z').ok).toBe(true)
  })

  it('拒绝非时间戳字符串', () => {
    expect(validate(timestampSchema, 'nope').ok).toBe(false)
  })
})

describe('flatSettingsSchema', () => {
  it('接受扁平的 string -> string 映射', () => {
    const input = { language: 'zh', langfuse_enabled: 'true' }
    const result = validate(flatSettingsSchema, input)
    expect(result.ok).toBe(true)
  })

  it('拒绝嵌套结构（旧项目的 app_settings 是扁平的）', () => {
    expect(validate(flatSettingsSchema, { nested: { a: 1 } }).ok).toBe(false)
  })

  it('拒绝原生布尔值（旧实现统一存字符串）', () => {
    expect(validate(flatSettingsSchema, { enabled: true }).ok).toBe(false)
  })
})

describe('readBoolSetting', () => {
  it('识别各种为真的写法', () => {
    for (const value of ['true', 'True', 'TRUE', '1', 'yes', ' true ']) {
      expect(readBoolSetting(value), value).toBe(true)
    }
  })

  it('识别各种为假的写法', () => {
    for (const value of ['false', 'False', '0', 'no']) {
      expect(readBoolSetting(value), value).toBe(false)
    }
  })

  it('缺失或无法判定时返回 fallback', () => {
    expect(readBoolSetting(undefined)).toBe(false)
    expect(readBoolSetting(undefined, true)).toBe(true)
    expect(readBoolSetting('maybe', true)).toBe(true)
    expect(readBoolSetting('maybe')).toBe(false)
  })
})

describe('readIntSetting', () => {
  it('解析整数', () => {
    expect(readIntSetting('42', 0)).toBe(42)
    expect(readIntSetting(' 42 ', 0)).toBe(42)
  })

  it('无法解析时返回 fallback（旧数据可能被手工编辑）', () => {
    expect(readIntSetting('abc', 7)).toBe(7)
    expect(readIntSetting('', 7)).toBe(7)
    expect(readIntSetting(undefined, 7)).toBe(7)
    expect(readIntSetting('12px', 7)).toBe(12)
  })
})
