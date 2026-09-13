/**
 * Token 估算。
 *
 * 旧项目没有用真实 tokenizer，而是用**字符数近似**（`compact_design.md` 明确
 * 把"真 tokenizer 精算"列为不做的事）。这个近似是 CJK 感知的，因为
 * 一个汉字与一个 ASCII 字符的 token 数相差约 5 倍——用统一的 `len/4`
 * 会严重低估中文对话的上下文占用，导致压缩触发过晚。
 *
 * ⚠️ 权重是**保守偏高**的：估算值略大于真实值，宁可早压缩。
 * 反过来的风险是请求超窗口被 provider 拒绝，代价大得多。
 *
 * parts/09 §4 要求「估算器按 provider/model 可替换，并记录估算误差」，
 * 因此这里定义成接口，默认实现为字符近似。
 */

/**
 * CJK 字符区间。
 *
 * 覆盖旧项目正则的全部区间，改用 `\u` 转义书写以避免源码编码歧义：
 * - U+2E80–U+2EFF  CJK 部首补充
 * - U+3000–U+303F  CJK 符号标点
 * - U+31C0–U+31EF  CJK 笔画
 * - U+3400–U+4DBF  CJK 扩展 A
 * - U+4E00–U+9FFF  CJK 统一表意文字
 * - U+F900–U+FAFF  CJK 兼容表意文字
 * - U+FE30–U+FE4F  CJK 兼容形式
 * - U+FF00–U+FFEF  半角及全角形式
 */
const CJK_PATTERN =
  /[\u2E80-\u2EFF\u3000-\u303F\u31C0-\u31EF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF]/gu

/**
 * 估算器接口。
 *
 * 按 provider/model 可替换：接入新模型时若厂商提供了 tokenizer，
 * 实现这个接口即可，压缩策略无需改动。
 */
export interface TokenEstimator {
  /** 估算一段文本的 token 数。 */
  estimate(text: string): number
  /** 估算一组内部消息的 token 数。 */
  estimateMessages(messages: readonly { readonly content: string }[]): number
  /** 估算一组 provider API 消息的 token 数。 */
  estimateApiMessages(apiMessages: readonly unknown[]): number
  /**
   * 估算相对误差。
   *
   * 字符近似没有真实基准，返回 `undefined` 表示"未知"。
   * 接入真实 tokenizer 的实现应返回经验误差值，用于压缩阈值的自适应校准。
   */
  readonly knownErrorRatio?: number
}

/** 默认估算器的权重配置。 */
export interface CharacterEstimatorOptions {
  /** 每个 CJK 字符折算的 token 数。 */
  readonly cjkWeight: number
  /** 每个非 CJK 字符折算的 token 数。 */
  readonly otherWeight: number
}

/**
 * 默认权重。
 *
 * `cjkWeight = 1.5`：一个汉字通常占 1–2 个 token，取 1.5 偏保守。
 * `otherWeight = 0.3`：英文约 4 字符/token（即 0.25），取 0.3 是因为
 * JSON 结构符（`{`、`"`、`,`）往往各自成 token，实际密度低于纯英文文本。
 */
export const DEFAULT_ESTIMATOR_OPTIONS: CharacterEstimatorOptions = {
  cjkWeight: 1.5,
  otherWeight: 0.3,
}

/**
 * 统计字符串的 Unicode 码点数量。
 *
 * ⚠️ 不能用 `text.length`——那是 UTF-16 码元数，代理对（emoji、部分生僻字）
 * 会被算成 2。旧项目用的是 Python 的 `len()`，按码点计数。
 * 两者在含 emoji 的文本上会产生不同的估算结果。
 */
function countCodePoints(text: string): number {
  let count = 0
  for (const _ of text) count += 1
  return count
}

/** 统计字符串中的 CJK 码点数量。 */
function countCjk(text: string): number {
  // 正则带 g 标志，需重置 lastIndex 以免跨调用残留（`matchAll` 内部会处理）。
  let count = 0
  for (const _ of text.matchAll(CJK_PATTERN)) count += 1
  return count
}

/**
 * 基于字符数的估算器（默认实现）。
 */
export class CharacterTokenEstimator implements TokenEstimator {
  readonly #options: CharacterEstimatorOptions

  constructor(options: CharacterEstimatorOptions = DEFAULT_ESTIMATOR_OPTIONS) {
    this.#options = options
  }

  /** 权重配置。 */
  get options(): CharacterEstimatorOptions {
    return this.#options
  }

  /**
   * 估算一段文本。
   *
   * 空文本返回 0；非空文本**至少返回 1**——即使只有一个字符，
   * 它在请求里也至少占一个 token，返回 0 会让"很多极短消息"的总量被低估。
   */
  estimate(text: string): number {
    if (text.length === 0) return 0

    const cjkCount = countCjk(text)
    const totalCount = countCodePoints(text)
    const otherCount = totalCount - cjkCount

    return Math.max(
      1,
      Math.floor(cjkCount * this.#options.cjkWeight + otherCount * this.#options.otherWeight),
    )
  }

  /** 对每条消息的 `content` 求和。 */
  estimateMessages(messages: readonly { readonly content: string }[]): number {
    let total = 0
    for (const message of messages) {
      total += this.estimate(message.content)
    }
    return total
  }

  /**
   * 估算 provider API 消息。
   *
   * 对序列化后的整体长度求和——不是逐字段求和，因为 JSON 的键名、
   * 引号与逗号同样会进入请求体并占用 token。
   *
   * ⚠️ **已知偏差**：旧项目用 Python 的 `json.dumps`，其默认分隔符是
   * `(', ', ': ')`（带空格），而 `JSON.stringify` 不带空格。因此同样的
   * 结构在本实现下估算值会**略小**。影响量级约为结构符数量的 1 倍
   * 乘 `otherWeight`（0.3）。鉴于估算本身是保守偏高的，这个偏差方向
   * 与保守性相反，需要在 Phase 5 用真实 transcript 对照校准。
   */
  estimateApiMessages(apiMessages: readonly unknown[]): number {
    let total = 0
    for (const message of apiMessages) {
      const serialized = safeStringify(message)
      if (serialized !== undefined) total += this.estimate(serialized)
    }
    return total
  }
}

/**
 * 序列化任意值为 JSON 字符串；无法序列化时返回 `undefined`。
 *
 * 循环引用、`BigInt`、含 `toJSON` 抛错的对象都会让 `JSON.stringify` 抛异常。
 * 估算器不应因此中断整个 turn——估算失败退化为"跳过该条"，
 * 由 `estimateApiMessages` 的调用方兜底（例如 turn 结束时用真实 usage 校正）。
 */
function safeStringify(value: unknown): string | undefined {
  try {
    const result = JSON.stringify(value)
    return result === undefined ? undefined : result
  } catch {
    return undefined
  }
}

/** 共享的默认估算器实例。无状态，可安全复用。 */
export const defaultTokenEstimator: TokenEstimator = new CharacterTokenEstimator()
