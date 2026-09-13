/**
 * 显式结果类型。
 *
 * 本项目区分三种"失败"，它们**不可互相替代**（parts/09 §2、§5）：
 *
 * 1. **可预期的业务失败** → 用 `Result<T, E>` 返回，调用方必须处理。
 *    例：权限被拒、工具输入校验失败、模型能力不满足。
 * 2. **不可恢复的程序错误** → 抛异常。
 *    例：契约被违反（非法状态迁移）、内部不变量被破坏。
 * 3. **取消** → 通过 `AbortSignal` 传播，不是 `Result` 的错误分支。
 *    取消是控制流而非错误（parts/09 §2：「取消必须中断 provider 流、子进程、
 *    MCP 请求和等待审批」）。
 *
 * 不要用异常表达第 1 种，也不要用 `Result` 表达第 2 种。
 */

/** 成功分支。 */
export interface Ok<T> {
  readonly ok: true
  readonly value: T
}

/** 失败分支。`error` 必须是结构化错误，不要用裸字符串。 */
export interface Err<E> {
  readonly ok: false
  readonly error: E
}

/** 显式结果。用于所有可预期的失败路径。 */
export type Result<T, E> = Ok<T> | Err<E>

/** 构造成功结果。 */
export function ok<T>(value: T): Ok<T> {
  return { ok: true, value }
}

/** 构造失败结果。 */
export function err<E>(error: E): Err<E> {
  return { ok: false, error }
}

/** 类型守卫：是否为成功结果。 */
export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok
}

/**
 * 类型守卫：是否为失败结果。
 *
 * 之所以同时提供两个守卫而不是只提供 `isErr`，是因为在 `if/else` 中
 * 用正向判定收窄可读性更好，而 TS 对 `!result.ok` 的收窄在
 * `exactOptionalPropertyTypes` 下偶有歧义。
 */
export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok
}

/**
 * 取出成功值，失败时抛出。
 *
 * ⚠️ 只应在调用方**已通过 `isOk` 判定**（或失败即代表程序 bug）时使用。
 * 用它来绕过错误处理会破坏"可预期失败必须被处理"的契约。
 */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (result.ok) return result.value
  throw new Error(`unwrap() on Err: ${JSON.stringify(result.error)}`)
}

/** 映射成功值，失败原样透传。 */
export function mapResult<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return result.ok ? ok(fn(result.value)) : result
}

/** 映射错误值，成功原样透传。 */
export function mapErr<T, E, F>(result: Result<T, E>, fn: (error: E) => F): Result<T, F> {
  return result.ok ? result : err(fn(result.error))
}
