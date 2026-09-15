/**
 * `errors.ts` 的补充测试：**错误上下文的脱敏边界**。
 *
 * `tests/core/errors.test.ts` 已经覆盖了错误码表、暂时性判定与基本包装，
 * 这里只补它的空白：`toAgentError` 对**各种原始类型抛出值**的处理。
 *
 * 为什么值得单独测：`context.raw` 会落进事件日志与审计记录，而
 * parts/09 §8 要求"敏感参数默认脱敏、API key 不得出现在日志里"。
 * 因此 `safeInspect` 只能记录原始类型的值，对 object / function
 * **只返回类型名**——这条边界一旦被改成 `String(value)` 就会泄漏凭据。
 */
import { describe, expect, it } from 'vitest'

import { AgentError, ErrorCode, toAgentError } from '../../src/core/errors.js'

/** 取出被包装后的错误上下文，顺带断言错误码是 INTERNAL_ERROR。 */
function wrapped(value: unknown, source?: string): { raw: string } {
  const error = toAgentError(value, source)
  expect(error.code).toBe(ErrorCode.INTERNAL_ERROR)
  expect(error.category).toBe('internal')
  return error.context as { raw: string }
}

describe('toAgentError：原始类型抛出值的记录方式', () => {
  it('字符串原样记录（字符串本身就是最常见的抛出值）', () => {
    expect(wrapped('出错了').raw).toBe('出错了')
  })

  it('数字与布尔转成字符串（不是 String(value) 的兜底路径）', () => {
    expect(wrapped(42).raw).toBe('42')
    expect(wrapped(0).raw).toBe('0')
    expect(wrapped(false).raw).toBe('false')
    expect(wrapped(true).raw).toBe('true')
  })

  it('bigint 带 n 后缀，保留精度不丢信息', () => {
    expect(wrapped(9007199254740993n).raw).toBe('9007199254740993n')
  })

  it('symbol 用 toString 记录（便于定位是哪个 symbol）', () => {
    expect(wrapped(Symbol('token')).raw).toBe('Symbol(token)')
  })

  it('函数只记录 [function]，绝不序列化函数体', () => {
    expect(wrapped(() => undefined).raw).toBe('[function]')
  })

  it('对象只记录 [object]，不序列化内容（防止凭据进日志）', () => {
    const secrets = { apiKey: 'sk-ant-secret', nested: { token: 't' } }
    const context = wrapped(secrets)
    expect(context.raw).toBe('[object]')
    expect(JSON.stringify(context)).not.toContain('sk-ant-secret')
  })

  it('数组同样按 object 处理（数组元素可能含凭据）', () => {
    expect(wrapped(['sk-ant-secret']).raw).toBe('[object]')
  })
})

describe('toAgentError：source 与 cause 的可选语义', () => {
  it('不传 source 时字段为 undefined，且不出现在 toDetails 里', () => {
    const error = toAgentError(new Error('底层失败'))
    expect(error.source).toBeUndefined()
    expect(Object.keys(error.toDetails()).sort()).toEqual(['code', 'context', 'message'])
  })

  it('传 source 时记录来源子系统', () => {
    expect(toAgentError('x', 'provider').source).toBe('provider')
  })

  it('原始抛出值的类型名进入 context，便于区分 TypeError 与普通 Error', () => {
    const error = toAgentError(new TypeError('坏类型'))
    expect(error.context).toEqual({ errorName: 'TypeError' })
    expect(error.message).toBe('坏类型')
  })

  it('已经是 AgentError 时不做二次包装，即使传了 source', () => {
    const original = new AgentError({ code: ErrorCode.SESSION_BUSY, message: '忙', source: 'app' })
    expect(toAgentError(original, 'other')).toBe(original)
    expect(original.source).toBe('app')
  })
})

describe('AgentError：可选字段与 cause', () => {
  it('不传 options 时 cause 为 undefined（不伪造空 cause）', () => {
    const error = new AgentError({ code: ErrorCode.INTERNAL_ERROR, message: 'x' })
    expect(error.cause).toBeUndefined()
    expect(error.retryAfterMs).toBeUndefined()
    expect(error.context).toBeUndefined()
    expect(error.source).toBeUndefined()
  })

  it('cause 为 undefined 等价于不传（同样不建立 cause 链）', () => {
    const error = new AgentError(
      { code: ErrorCode.INTERNAL_ERROR, message: 'x' },
      { cause: undefined },
    )
    expect(error.cause).toBeUndefined()
  })

  it('retryAfterMs 为 0 时仍会出现在 toDetails（0 是合法建议值，不能被当成缺失）', () => {
    const error = new AgentError({
      code: ErrorCode.PROVIDER_RATE_LIMITED,
      message: '限流',
      retryAfterMs: 0,
    })
    expect(error.toDetails().retryAfterMs).toBe(0)
  })

  it('错误堆栈可被捕获（继承 Error 以便在 await 边界自然传播）', () => {
    const error = new AgentError({ code: ErrorCode.INTERNAL_ERROR, message: 'x' })
    expect(typeof error.stack).toBe('string')
    expect(error).toBeInstanceOf(Error)
  })
})
