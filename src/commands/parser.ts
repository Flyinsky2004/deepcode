/**
 * Slash command 解析。
 *
 * **纯函数，不做 shell 解析**（`parts/09` §6.1 第 4 条：指令部分
 * 「保留原始文本，不经过 shell 解析」）。这里只做两件最小的事：
 * 切出命令名、切出位置参数；剩下的原文原样保留给 `rest`。
 *
 * 之所以要支持引号：provider 的展示名允许含空格（§6.1 第 3 条），
 * 所以 `"My Provider"/model-id` 必须能作为**一个**参数被切出来。
 */

/** 一个已切分的词及其在原文中的起始偏移。 */
export interface CommandToken {
  readonly value: string
  /** 相对 `body`（去掉前导 `/` 之后）的偏移，用于取回 `rest` 原文。 */
  readonly start: number
}

export interface ParsedCommand {
  /** 命令名，**不含**前导 `/`。大小写由调用方处理（查找是大小写不敏感的）。 */
  readonly name: string
  /** 位置参数（已去引号）。 */
  readonly args: readonly string[]
  /** 位置参数对应的词元，带偏移。 */
  readonly argTokens: readonly CommandToken[]
  /** 去掉前导 `/` 之后的原文。 */
  readonly body: string
  /** 完整原文。 */
  readonly raw: string
}

const isSpace = (ch: string): boolean => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r'

/**
 * 按空白切词，支持单/双引号包裹。
 *
 * 未闭合的引号**不报错**，按"一直到结尾"处理——命令原文来自用户输入，
 * 为一个漏掉的引号抛异常会让 UI 需要额外的错误分支，而它本来也只是
 * 一个参数解析失败，交给 zod 校验更合适。
 */
function tokenize(text: string): CommandToken[] {
  const tokens: CommandToken[] = []
  let i = 0
  while (i < text.length) {
    while (i < text.length && isSpace(text[i] ?? '')) i++
    if (i >= text.length) break
    const start = i
    let value = ''

    const quote = text[i]
    if (quote === '"' || quote === "'") {
      i++
      while (i < text.length && text[i] !== quote) {
        value += text[i]
        i++
      }
      // 跳过收尾引号（未闭合时 i 已在结尾）
      if (i < text.length) i++
      // 继续拼接紧随其后的非空白字符。
      //
      // 这一条必不可少：`"My Provider"/model-id` 必须作为**一个**参数，
      // 因为 provider 展示名允许含空格，而它和 model id 拼成同一个
      // `provider/model` 引用（parts/09 §6.1 第 3 条）。
      // 在收尾引号处截断会把它切成两个参数，`/workwith` 就再也解析不了
      // 带空格的 provider 名。
      while (i < text.length && !isSpace(text[i] ?? '')) {
        value += text[i]
        i++
      }
    } else {
      while (i < text.length && !isSpace(text[i] ?? '')) {
        value += text[i]
        i++
      }
    }

    tokens.push({ value, start })
  }
  return tokens
}

/**
 * 解析一行命令。不是命令（不以 `/` 开头）或只有 `/` 时返回 `undefined`。
 */
export function parseCommandLine(input: string): ParsedCommand | undefined {
  const trimmed = input.trimStart()
  if (!trimmed.startsWith('/')) return undefined

  const body = trimmed.slice(1)
  const tokens = tokenize(body)
  const head = tokens[0]
  if (head === undefined) return undefined

  const argTokens = tokens.slice(1)
  return {
    name: head.value,
    args: argTokens.map((t) => t.value),
    argTokens,
    body,
    raw: input,
  }
}

/**
 * 取从第 `from` 个位置参数起的**原始剩余文本**。
 *
 * 保留原始空白与引号——`/workwith` 要把指令原样交给模型，
 * 重新拼接会丢失用户写的换行与多余空格。
 */
export function restFrom(parsed: ParsedCommand, from: number): string {
  const token = parsed.argTokens[from]
  if (token === undefined) return ''
  return parsed.body.slice(token.start)
}
