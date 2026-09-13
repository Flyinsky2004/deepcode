import { describe, expect, it, vi } from 'vitest'

import {
  CancelReason,
  abortError,
  combineSignals,
  isAbortError,
  isAborted,
  neverAborts,
  withTimeout,
} from '../../src/core/abort.js'

describe('isAborted', () => {
  it('未中止信号返回 false', () => {
    expect(isAborted(new AbortController().signal)).toBe(false)
  })

  it('已中止信号返回 true', () => {
    const controller = new AbortController()
    controller.abort()
    expect(isAborted(controller.signal)).toBe(true)
  })

  it('undefined 视为未中止（可选信号的常见用法）', () => {
    expect(isAborted(undefined)).toBe(false)
  })
})

describe('combineSignals', () => {
  it('任一输入中止则合并信号中止', () => {
    const a = new AbortController()
    const b = new AbortController()
    const combined = combineSignals([a.signal, b.signal])

    expect(combined.aborted).toBe(false)
    a.abort()
    expect(combined.aborted).toBe(true)
  })

  it('输入已中止时合并信号立即中止', () => {
    const a = new AbortController()
    a.abort()
    expect(combineSignals([a.signal, neverAborts()]).aborted).toBe(true)
  })
})

describe('neverAborts', () => {
  it('返回不会中止的信号', () => {
    const signal = neverAborts()
    expect(signal.aborted).toBe(false)
    expect(isAborted(signal)).toBe(false)
  })
})

describe('withTimeout', () => {
  it('超时后自动中止', () => {
    vi.useFakeTimers()
    try {
      const { signal, timedOut, cleanup } = withTimeout(undefined, 1000)

      expect(signal.aborted).toBe(false)
      expect(timedOut()).toBe(false)

      vi.advanceTimersByTime(1000)

      expect(signal.aborted).toBe(true)
      expect(timedOut()).toBe(true)
      cleanup()
    } finally {
      vi.useRealTimers()
    }
  })

  it('未超时则不中止', () => {
    vi.useFakeTimers()
    try {
      const { signal, cleanup } = withTimeout(undefined, 1000)
      vi.advanceTimersByTime(999)
      expect(signal.aborted).toBe(false)
      cleanup()
    } finally {
      vi.useRealTimers()
    }
  })

  it('外层信号中止时立即传播，且不算超时', () => {
    const outer = new AbortController()
    const { signal, timedOut, cleanup } = withTimeout(outer.signal, 60_000)

    outer.abort(CancelReason.USER)

    expect(signal.aborted).toBe(true)
    // 是外层取消而非超时——UI 需要区分二者
    expect(timedOut()).toBe(false)
    cleanup()
  })

  it('外层信号传入时已中止则立即中止', () => {
    const outer = new AbortController()
    outer.abort()

    const { signal, cleanup } = withTimeout(outer.signal, 60_000)
    expect(signal.aborted).toBe(true)
    cleanup()
  })

  it('cleanup 后超时不再触发', () => {
    vi.useFakeTimers()
    try {
      const { signal, cleanup } = withTimeout(undefined, 1000)
      cleanup()
      vi.advanceTimersByTime(5000)
      expect(signal.aborted).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('cleanup 移除外层监听器，避免监听器泄漏', () => {
    const outer = new AbortController()
    const removeSpy = vi.spyOn(outer.signal, 'removeEventListener')

    const { cleanup } = withTimeout(outer.signal, 60_000)
    cleanup()

    expect(removeSpy).toHaveBeenCalled()
  })
})

describe('abortError / isAbortError', () => {
  it('错误名称为 AbortError，与平台约定一致', () => {
    const error = abortError()
    expect(error.name).toBe('AbortError')
    expect(isAbortError(error)).toBe(true)
  })

  it('携带取消原因', () => {
    expect(abortError(CancelReason.PARENT).message).toContain(CancelReason.PARENT)
  })

  it('普通错误不被判定为取消', () => {
    expect(isAbortError(new Error('普通失败'))).toBe(false)
    expect(isAbortError('字符串')).toBe(false)
    expect(isAbortError(null)).toBe(false)
  })

  it('可被识别为 Error 实例，便于统一兜底', () => {
    expect(abortError()).toBeInstanceOf(Error)
  })
})

describe('CancelReason', () => {
  it('区分取消与超时等不同来源（UI 呈现与恢复语义不同）', () => {
    expect(Object.values(CancelReason).sort()).toEqual([
      'budget',
      'parent',
      'shutdown',
      'timeout',
      'user',
    ])
  })
})
