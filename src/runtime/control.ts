import { setTimeout as delay } from 'node:timers/promises'
import { abortable } from '../core/abort.js'

/** 即使适配器没有响应取消，也结束调用方的等待；底层仍收到同一个 signal。 */
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

// `abortable` 的实现已移到 `core/abort.ts`（纯控制流工具，不该让 tools/ 依赖 runtime/）。
// 这里 re-export 保持既有 import 路径可用；新代码请直接从 core/abort.js 取。
export { abortable }
