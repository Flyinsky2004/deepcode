import { describe, expect, it } from 'vitest'

import {
  AgentError,
  ERROR_CATEGORY,
  ErrorCategory,
  ErrorCode,
  allowsModelFallback,
  isTransient,
  toAgentError,
} from '../../src/core/errors.js'

describe('错误码表', () => {
  it('每个错误码都登记了分类', () => {
    for (const code of Object.values(ErrorCode)) {
      expect(ERROR_CATEGORY[code], `缺少分类: ${code}`).toBeDefined()
    }
  })

  it('错误码的值等于其键名（稳定契约）', () => {
    for (const [key, value] of Object.entries(ErrorCode)) {
      expect(value).toBe(key)
    }
  })

  it('旧项目已出现的错误码必须保留，不得改名', () => {
    // 这些字符串出现在旧项目的运行期输出与测试断言中
    expect(ErrorCode.PERMISSION_REQUIRED).toBe('PERMISSION_REQUIRED')
    expect(ErrorCode.PERMISSION_DENIED).toBe('PERMISSION_DENIED')
    expect(ErrorCode.TOOL_NOT_FOUND).toBe('TOOL_NOT_FOUND')
    expect(ErrorCode.TOOL_RUNTIME_ERROR).toBe('TOOL_RUNTIME_ERROR')
    expect(ErrorCode.SKILL_GUARD_DENIED).toBe('SKILL_GUARD_DENIED')
    expect(ErrorCode.SESSION_BUSY).toBe('SESSION_BUSY')
    expect(ErrorCode.INVALID_COMMAND_ARGUMENTS).toBe('INVALID_COMMAND_ARGUMENTS')
    expect(ErrorCode.MODEL_CAPABILITY_UNAVAILABLE).toBe('MODEL_CAPABILITY_UNAVAILABLE')
  })
})

describe('isTransient', () => {
  it('网络与暂时性服务端错误可重试', () => {
    expect(isTransient(ErrorCode.PROVIDER_CONNECTION_FAILED)).toBe(true)
    expect(isTransient(ErrorCode.PROVIDER_RATE_LIMITED)).toBe(true)
    expect(isTransient(ErrorCode.PROVIDER_UNAVAILABLE)).toBe(true)
    expect(isTransient(ErrorCode.MCP_TIMEOUT)).toBe(true)
  })

  it('权限拒绝与工具运行错误不可重试', () => {
    expect(isTransient(ErrorCode.PERMISSION_DENIED)).toBe(false)
    expect(isTransient(ErrorCode.SKILL_GUARD_DENIED)).toBe(false)
    expect(isTransient(ErrorCode.TOOL_RUNTIME_ERROR)).toBe(false)
    expect(isTransient(ErrorCode.VALIDATION_FAILED)).toBe(false)
  })
})

describe('allowsModelFallback', () => {
  it('能力不足时允许 fallback（换个模型可能满足）', () => {
    expect(allowsModelFallback(ErrorCode.MODEL_CAPABILITY_UNAVAILABLE)).toBe(true)
  })

  it('暂时性错误允许 fallback', () => {
    expect(allowsModelFallback(ErrorCode.PROVIDER_UNAVAILABLE)).toBe(true)
  })

  it('工具失败与权限拒绝绝不触发 fallback', () => {
    // parts/09 §9.5：不得在工具执行失败、权限拒绝或输出质量不足时自动换模型重放
    expect(allowsModelFallback(ErrorCode.TOOL_RUNTIME_ERROR)).toBe(false)
    expect(allowsModelFallback(ErrorCode.PERMISSION_DENIED)).toBe(false)
    expect(allowsModelFallback(ErrorCode.PERMISSION_REQUIRED)).toBe(false)
    expect(allowsModelFallback(ErrorCode.BUDGET_EXCEEDED)).toBe(false)
  })
})

describe('AgentError', () => {
  it('携带稳定错误码与派生分类', () => {
    const error = new AgentError({
      code: ErrorCode.PERMISSION_DENIED,
      message: '写入被拒绝',
    })

    expect(error.code).toBe('PERMISSION_DENIED')
    expect(error.category).toBe(ErrorCategory.PERMISSION)
    expect(error.message).toBe('写入被拒绝')
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('AgentError')
  })

  it('isTransient 与错误码判定一致', () => {
    const transient = new AgentError({ code: ErrorCode.PROVIDER_UNAVAILABLE, message: 'x' })
    const permanent = new AgentError({ code: ErrorCode.PERMISSION_DENIED, message: 'x' })

    expect(transient.isTransient).toBe(true)
    expect(permanent.isTransient).toBe(false)
  })

  it('保留 cause 以便追溯原始异常', () => {
    const cause = new Error('底层失败')
    const error = new AgentError({ code: ErrorCode.INTERNAL_ERROR, message: '包装' }, { cause })
    expect(error.cause).toBe(cause)
  })

  it('toDetails 可安全序列化，且不输出 undefined 字段', () => {
    const error = new AgentError({
      code: ErrorCode.TOOL_TIMEOUT,
      message: '超时',
      source: 'bash',
      retryAfterMs: 1000,
      context: { toolName: 'bash' },
    })

    const details = error.toDetails()
    expect(details).toEqual({
      code: 'TOOL_TIMEOUT',
      message: '超时',
      source: 'bash',
      retryAfterMs: 1000,
      context: { toolName: 'bash' },
    })
    expect(JSON.parse(JSON.stringify(details))).toEqual(details)
  })

  it('未提供的可选字段不出现在 toDetails 中', () => {
    const error = new AgentError({ code: ErrorCode.INTERNAL_ERROR, message: 'x' })
    const details = error.toDetails()

    expect(Object.keys(details).sort()).toEqual(['code', 'message'])
  })

  it('AgentError.is 正确收窄', () => {
    expect(AgentError.is(new AgentError({ code: ErrorCode.INTERNAL_ERROR, message: 'x' }))).toBe(
      true,
    )
    expect(AgentError.is(new Error('普通错误'))).toBe(false)
    expect(AgentError.is('字符串')).toBe(false)
  })
})

describe('toAgentError', () => {
  it('已是 AgentError 时原样返回，保留错误码', () => {
    const original = new AgentError({ code: ErrorCode.PERMISSION_DENIED, message: 'x' })
    expect(toAgentError(original)).toBe(original)
  })

  it('把普通 Error 包装为 INTERNAL_ERROR 并保留 cause', () => {
    const cause = new Error('底层')
    const wrapped = toAgentError(cause, 'storage')

    expect(wrapped.code).toBe(ErrorCode.INTERNAL_ERROR)
    expect(wrapped.source).toBe('storage')
    expect(wrapped.cause).toBe(cause)
    expect(wrapped.context).toEqual({ errorName: 'Error' })
  })

  it('包装非 Error 抛出值且不泄漏对象结构', () => {
    const wrapped = toAgentError({ secret: 'api-key-123' })

    expect(wrapped.code).toBe(ErrorCode.INTERNAL_ERROR)
    // 只记录类型，不序列化对象内容，避免把凭据写进日志
    expect(wrapped.context).toEqual({ raw: '[object]' })
    expect(JSON.stringify(wrapped.toDetails())).not.toContain('api-key-123')
  })

  it('处理 null / undefined / symbol', () => {
    expect(toAgentError(null).context).toEqual({ raw: 'null' })
    expect(toAgentError(undefined).context).toEqual({ raw: 'undefined' })
    expect(toAgentError(Symbol('s')).context).toEqual({ raw: 'Symbol(s)' })
  })
})
