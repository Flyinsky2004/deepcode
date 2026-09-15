/**
 * 取消传播。
 *
 * `AbortSignal` / `AbortController` 是 Node 18+ 的**全局**对象（由 `@types/node`
 * 声明），不从任何模块导入。这里直接使用全局类型，不做重新导出——
 * 包装或别名会破坏与 `fetch`、`child_process`、MCP SDK 等原生 API 的类型互操作。
 *
 * progess.md 设计约束 5：「所有异步操作都支持 `AbortSignal`」。
 * `parts/09` §2 进一步要求取消必须**主动中断** provider 流、子进程、MCP 请求
 * 和等待审批，而不只是置一个标志位。
 *
 * ## 为什么取消不是错误
 *
 * 取消是**控制流**，不占用 `Result` 的错误分支，也不应该被当作失败报告。
 * 旧实现把取消实现成一个永不清理的标志位（REWRITE_SPEC §7.2），导致取消后
 * 同一实例的**后续所有 turn 立即被判为取消**——用户排队的下一条消息被静默吞掉。
 * 本实现改为每个 turn 独立的 `AbortController`，从类型上就杜绝了这种粘性。
 *
 * ## 与 `AbortSignal` 的关系
 *
 * `AbortSignal` 是平台全局对象（Node 18+ 内置），不做包装——包装会破坏与
 * `fetch`、`child_process`、MCP SDK 等所有原生 API 的互操作性。
 * 本模块只提供组合与判定工具。
 */

/**
 * 取消原因。
 *
 * 用于区分"用户主动取消"与"因超时/预算/父代理取消而中止"——三者对用户
 * 的呈现与对恢复的影响都不同。
 */
export const CancelReason = {
  /** 用户显式取消。 */
  USER: 'user',
  /** 父 turn 取消，取消传播到子代理。 */
  PARENT: 'parent',
  /** 权限请求或用户输入等待超时。 */
  TIMEOUT: 'timeout',
  /** 预算耗尽触发的收尾。**不是**用户取消，但也需要中断当前操作。 */
  BUDGET: 'budget',
  /** 进程关闭时的优雅停止。 */
  SHUTDOWN: 'shutdown',
} as const

/** 取消原因类型。 */
export type CancelReason = (typeof CancelReason)[keyof typeof CancelReason]

/**
 * 把一个信号包装为"带原因"的信号。
 *
 * 平台原生的 `AbortController.abort(reason)` 已支持传原因，因此这里不额外包装；
 * 本类型用于让**读取方**以结构化方式取得原因。
 */
export interface CancelReasonCarrier {
  readonly reason: CancelReason
}

/**
 * 判断信号是否已中止。
 *
 * 等价于读 `signal.aborted`，但作为函数存在是为了让调用点更醒目——
 * 取消检查点遗漏是本项目最容易出错的地方之一。
 */
export function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

/**
 * 把多个信号合并为一个：任一中止则结果中止。
 *
 * 用途：子代理需要同时响应"父 turn 取消"与"自身取消"。
 * 平台已有 `AbortSignal.any()`（Node 20+），这里直接透传，
 * 不自行实现以免丢失原生实现的内存与监听器清理语义。
 */
export function combineSignals(signals: readonly AbortSignal[]): AbortSignal {
  return AbortSignal.any([...signals])
}

/**
 * 在给定信号上附加超时：超时后自动中止。
 *
 * 用途：权限审批（120 秒）、用户输入（120 秒）、工具执行超时。
 *
 * ⚠️ 返回的对象同时给出 `signal` 与 `cleanup`。**调用方必须在完成后调用
 * `cleanup()`**，否则定时器会一直挂到超时才释放——在高频工具调用场景下
 * 会累积大量挂起的定时器。
 */
export function withTimeout(
  signal: AbortSignal | undefined,
  timeoutMs: number,
  reason: CancelReason = CancelReason.TIMEOUT,
): {
  readonly signal: AbortSignal
  readonly cleanup: () => void
  readonly timedOut: () => boolean
} {
  const controller = new AbortController()
  let didTimeOut = false

  const timer = setTimeout(() => {
    didTimeOut = true
    controller.abort(reason)
  }, timeoutMs)

  // 定时器不应阻止进程退出：审批等待可能长达 120 秒，
  // 若它持有事件循环句柄，进程会在本可退出时继续等待。
  timer.unref?.()

  const onOuterAbort = (): void => {
    controller.abort(signal?.reason ?? reason)
  }

  if (signal !== undefined) {
    if (signal.aborted) {
      onOuterAbort()
    } else {
      signal.addEventListener('abort', onOuterAbort, { once: true })
    }
  }

  return {
    signal: controller.signal,
    cleanup: (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onOuterAbort)
    },
    timedOut: (): boolean => didTimeOut,
  }
}

/**
 * 创建一个"永不中止"的信号。
 *
 * 用于测试与明确不需要取消的场景。**不要用它来占位**——如果某个异步操作
 * 理应可取消，传入永不中止的信号会让取消请求悄无声息地失效。
 */
export function neverAborts(): AbortSignal {
  return new AbortController().signal
}

/**
 * 抛出一个表示取消的错误。
 *
 * 与 `AbortError` 语义一致：调用方应把 `name === 'AbortError'` 视为取消
 * 而非失败。使用平台认可的 `name` 值，以便 `fetch` 等原生 API 的错误
 * 用同一套判定处理。
 */
export function abortError(reason: CancelReason = CancelReason.USER): Error {
  const error = new Error(`操作已取消: ${reason}`)
  error.name = 'AbortError'
  return error
}

/** 判断抛出物是否为取消信号。 */
export function isAbortError(value: unknown): boolean {
  return value instanceof Error && value.name === 'AbortError'
}

/**
 * 等待一个操作，但**在 signal 中止时立刻结束等待**。
 *
 * 与只把 signal 传给被调方的区别在于：对方可以不理会 signal。`withTimeout`
 * 的 signal 是"建议"，而这里的 race 是"保证"——调用方不会因为被调方
 * 不响应而无限等待。
 *
 * ⚠️ 提前返回**不代表对方停止了**。若被调方不响应 abort，它可能仍在后台运行
 * 并产生副作用，此时副作用是否发生是**不可知**的。
 */
export async function abortable<T>(operation: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  const promise = Promise.resolve(operation)
  // 先挂拒绝处理，避免已中止时产生未处理的拒绝。
  const aborted = new Promise<never>((_resolve, reject) => {
    if (signal.aborted) reject(abortError())
  })
  if (signal.aborted)
    return Promise.race([promise, aborted]).then(() => {
      throw abortError()
    })
  let onAbort: () => void = () => undefined
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
