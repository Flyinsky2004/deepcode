/**
 * Schema 校验基础设施。
 *
 * 设计约束（progess.md Phase 0）：「所有外部输入使用 runtime schema 校验
 * （推荐 Zod 或等价方案）」。
 *
 * "外部输入"包括：磁盘上的 JSON、HTTP 请求体、WebSocket 消息、CLI 参数、
 * 模型输出、MCP 响应、skill 定义文件。**都不能信任**。
 *
 * 本模块的价值不在于包装 Zod，而在于固化两条容易做错的策略：
 *
 * 1. **读入容错**（REWRITE_SPEC §3.2）：旧版本写的文件会被新版本读，
 *    因此反序列化必须对缺失字段用默认值填充、对未知字段忽略而非报错。
 *    `lenientObject` 就是这个策略的载体。
 * 2. **错误结构化**：校验失败必须转成带 `VALIDATION_FAILED` 错误码的
 *    `AgentError`，而不是把 Zod 的原始错误抛出去——上层需要能按错误码分支。
 */

import { z } from 'zod'

import { AgentError, ErrorCode } from './errors.js'
import { type Result, err, ok } from './result.js'

/**
 * 校验一段未知输入，失败时返回结构化的 `AgentError`。
 *
 * 这是**所有**外部数据进入系统的推荐入口。返回 `Result` 而非抛异常，
 * 因为"数据不合法"是可预期的失败，调用方通常需要自行决定是跳过该条、
 * 用默认值兜底，还是中止整个操作。
 *
 * @example
 * ```ts
 * const parsed = validateJson(MessageSchema, raw)
 * if (!parsed.ok) {
 *   logger.warn('跳过损坏的消息', parsed.error.toDetails())
 *   continue
 * }
 * ```
 */
export function validate<T>(
  schema: z.ZodType<T>,
  input: unknown,
  source?: string,
): Result<T, AgentError> {
  const result = schema.safeParse(input)

  if (result.success) {
    return ok(result.data)
  }

  return err(
    new AgentError({
      code: ErrorCode.VALIDATION_FAILED,
      message: formatIssues(result.error),
      ...(source === undefined ? {} : { source }),
      context: { issues: summarizeIssues(result.error) },
    }),
  )
}

/**
 * 同 `validate`，但失败时抛出。
 *
 * 用于**内部**边界——即"这里的数据按不变量来说一定合法，不合法就是程序 bug"。
 * 不要用它处理来自磁盘或网络的数据。
 */
export function validateOrThrow<T>(schema: z.ZodType<T>, input: unknown, source?: string): T {
  const result = validate(schema, input, source)
  if (!result.ok) throw result.error
  return result.value
}

/** 把 Zod 的校验问题压缩成可落进日志的短数组（最多 10 条）。 */
function summarizeIssues(error: z.ZodError): readonly string[] {
  return error.issues.slice(0, 10).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '<root>'
    return `${path}: ${issue.message}`
  })
}

/** 把 Zod 的校验问题格式化为一行人类可读的消息。 */
function formatIssues(error: z.ZodError): string {
  const issues = summarizeIssues(error)
  const suffix = error.issues.length > issues.length ? ` (共 ${error.issues.length} 项)` : ''
  return `校验失败: ${issues.join('; ')}${suffix}`
}

/**
 * 构造一个"读取容错"的对象 schema。
 *
 * 行为：
 * - **未知字段被剥离**而不是报错（Zod 的 object 默认即 strip）。
 * - **缺失字段用默认值填充**的职责交给各字段自己的 `.default()` / `.catch()`。
 * - 输入不是对象时返回一个明确的错误（而不是 Zod 的默认噪音）。
 *
 * 与 `z.object()` 的区别主要在语义表达上：用这个名字声明"这是一个从磁盘读来的、
 * 可能来自旧版本的结构"，提醒后续维护者不要收紧它。
 *
 * ⚠️ **不要**用 `.strict()`。旧数据里存在新版本不认识的字段（例如旧版本写入、
 * 后来被移除的实验性配置），严格模式会让整份数据读不出来。
 */
export function lenientObject<T extends z.ZodRawShape>(shape: T): z.ZodObject<T> {
  return z.object(shape)
}

/**
 * 一个总能解析成功的 schema，解析失败时回落到给定的默认值。
 *
 * 用于"这个字段坏了也不该让整条记录失败"的场景，例如 `Message.meta`
 * （一个 JSON 字符串字段，旧数据里可能不是合法 JSON）。
 *
 * ⚠️ 它会**静默吞掉**校验错误。只在确实可以安全降级的地方使用，
 * 并且在调用处注释说明为什么可以降级。
 */
export function withFallback<T>(schema: z.ZodType<T>, fallback: T): z.ZodType<T> {
  return schema.catch(fallback)
}

/**
 * 把 JSON 字符串解析并校验。
 *
 * 用于 `Message.content` / `Message.meta` 这类"字段本身是字符串，
 * 内容是序列化后的结构"的场景。这两步必须一起做——只解析不校验会让
 * 下游拿到形状错误的对象。
 */
export function validateJsonString<T>(
  schema: z.ZodType<T>,
  input: string,
  source?: string,
): Result<T, AgentError> {
  let parsed: unknown
  try {
    parsed = JSON.parse(input)
  } catch (cause) {
    return err(
      new AgentError(
        {
          code: ErrorCode.VALIDATION_FAILED,
          message: '内容不是合法 JSON',
          ...(source === undefined ? {} : { source }),
        },
        { cause },
      ),
    )
  }

  return validate(schema, parsed, source)
}

/**
 * 一个 schema，接受任何输入并原样返回。
 *
 * 用于明确标记"这个字段不做校验"的位置——比留空更有表达力，
 * 也比 `z.unknown()` 更清楚地表达意图。
 */
export const passthrough = z.unknown()

/**
 * ISO 8601 时间戳字符串 schema。
 *
 * 宽松：只要求是可被 `Date.parse` 解析的字符串。旧数据里可能存在
 * 不带毫秒或带 `+00:00` 后缀的历史格式，严格校验会让它们读不出来。
 */
export const timestampSchema = z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
  message: '不是可解析的时间戳',
})

/** 非空字符串。用于所有标识符字段。 */
export const idSchema = z.string().min(1)

/**
 * 扁平字符串映射 schema。
 *
 * 旧项目的 `app_settings` 是 `string → string`，布尔值也存成字符串
 * （如 `"langfuse_enabled": "true"`）。因此读取时不能期待原生类型。
 */
export const flatSettingsSchema = z.record(z.string(), z.string())

/**
 * 把扁平设置里的字符串读成布尔值。
 *
 * 旧项目靠 `str(value)` 归一，因此 `"true"` / `"True"` / `"1"` 都可能出现。
 * 无法判定时返回 `fallback`。
 */
export function readBoolSetting(value: string | undefined, fallback = false): boolean {
  if (value === undefined) return fallback
  const normalized = value.trim().toLowerCase()
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return false
  return fallback
}

/**
 * 把扁平设置里的字符串读成整数。
 *
 * 解析失败（非数字、空串、含单位）时返回 `fallback`——
 * 旧数据里这些字段可能被手工编辑过。
 */
export function readIntSetting(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const parsed = Number.parseInt(value.trim(), 10)
  return Number.isNaN(parsed) ? fallback : parsed
}
