/**
 * 品牌类型（branded types）工具。
 *
 * 领域里存在大量同为 `string` 但语义互不相通的标识（sessionId / turnId / toolCallId /
 * messageId / principalId）。裸 `string` 会让它们可以互相赋值，而本项目的可恢复性
 * 契约（REWRITE_SPEC §6 不变量 4、parts/09 §2）要求每个 ID 都能被准确追溯到
 * 它属于哪个层次。
 *
 * 因此所有标识一律使用品牌类型：编译期不可互换，运行期就是普通字符串，
 * 序列化到 JSON 时无需任何转换。
 */

/** 品牌符号。不导出——只有本模块的 `Brand` 能构造品牌类型。 */
declare const brand: unique symbol

/**
 * 把一个基础类型标记为语义独立的品牌类型。
 *
 * @example
 * ```ts
 * type SessionId = Brand<string, 'SessionId'>
 * ```
 */
export type Brand<T, TBrand extends string> = T & { readonly [brand]: TBrand }

/**
 * 取出品牌类型的底层类型。
 *
 * 用于序列化边界：把品牌值降回普通类型再写入 JSON。
 * 注意品牌类型本身在运行期就是普通字符串，所以这主要是编译期的表达。
 */
export type Unbrand<T> = T extends Brand<infer U, string> ? U : T

/**
 * 把一个普通字符串断言为品牌类型。
 *
 * 只应在**校验已经通过**的地方调用——它不做任何运行期检查。来自外部
 * （磁盘 JSON、HTTP 请求、模型输出）的值必须先经 Zod schema 校验，
 * 再由 schema 的 transform 完成品牌化，不要直接用它。
 *
 * 参数类型固定为 `string` 而非 `Unbrand<T>`：本项目的全部品牌类型都以
 * `string` 为底层类型，而 `Unbrand<T>` 在交叉类型里无法被 TS 可靠推断
 * （`infer U` 出现在交叉位置时推断会失败，退化为 `T` 本身）。
 */
export function brandAs<T extends Brand<string, string>>(value: string): T {
  return value as T
}
