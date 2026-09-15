import { setTimeout as delay } from 'node:timers/promises'
import { abortError } from '../core/abort.js'

/** 即使适配器没有响应取消，也结束调用方的等待；底层仍收到同一个 signal。 */
export async function abortable<T>(operation: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  const promise = Promise.resolve(operation)
  // 先挂拒绝处理，避免已取消时产生未处理的拒绝。
  const aborted = new Promise<never>((_resolve, reject) => {
    if (signal.aborted) reject(abortError())
  })
  if (signal.aborted)
    return Promise.race([promise, aborted]).then(() => {
      throw abortError()
    })
  let onAbort: () => void = () => {}
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortError())
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([promise, cancelled])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

export async function* cancellableStream<T>(
  source: AsyncIterable<T>,
  signal: AbortSignal,
): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]()
  try {
    while (true) {
      signal.throwIfAborted()
      const next = await abortable(iterator.next(), signal)
      if (next.done) return
      yield next.value
    }
  } finally {
    // return() 可能等待一个挂起的 next()；取消时不能再无限等待它。
    void iterator.return?.().catch(() => undefined)
  }
}

export async function retryDelay(ms: number, signal: AbortSignal): Promise<void> {
  await delay(ms, undefined, { signal })
}
