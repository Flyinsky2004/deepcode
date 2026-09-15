/**
 * Web 传输层认证。
 *
 * ## 三条不可协商的规则（`parts/09` §1.1）
 *
 * 1. **token 不落盘、只在终端显示一次**。落盘就等于把"谁能连"变成"谁能读文件"，
 *    而 `config.json` / `chat.json` 都是明文 JSON。
 * 2. **URL 里不允许出现 token**。URL 会进浏览器历史、`Referer`、代理日志和
 *    服务的 access log。这是"不允许把 token 放在 URL"的**执行点**：
 *    只要 query string 里出现 token 类参数，无论值对不对，一律 401 + 审计。
 * 3. **常量时间比较**。`===` 会在第一个不同字节处返回，逐字节的时序差异足以
 *    在本地网络里把 32 字节 token 一位一位试出来。
 *
 * ## WebSocket 为什么需要 ticket
 *
 * 浏览器的 `WebSocket` 构造函数**不能设置请求头**，所以"用 `Authorization: Bearer`
 * 握手"在浏览器里做不到。摆在面前的两条路是"把 token 放 URL"（违反规则 2）
 * 或"短期 ticket"。ticket 的代价是多一次 `POST /api/ws-ticket`，收益是
 * token 永远不进 URL——而 ticket 本身只活 30 秒、只能用一次、且绑定 Origin。
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

import { ErrorCode } from '../../core/errors.js'
import type { PrincipalId } from '../../core/ids.js'
import type { AuthMode } from './listen-policy.js'
import type { WebLogger } from './logger.js'

/**
 * WebSocket ticket 有效期。
 *
 * **刻意不放进 `AppPolicy`**：它是协议常量而非部署可调项——放宽它只会扩大
 * "ticket 被中间人截获后仍可用"的窗口，没有任何运维场景需要调它。
 * （`AppPolicy` 里那些可调项的共同点是"合理取值随部署规模变化"。）
 */
export const WS_TICKET_TTL_MS = 30_000

/** token 的随机字节数。32 字节 = 256 位熵，远超暴力破解可行域。 */
const TOKEN_BYTES = 32

/**
 * query string 里**禁止**出现的参数名。
 *
 * 大小写不敏感地逐项比对：`?Token=` / `?access_token=` 同样是泄露路径，
 * 只拦小写 `token` 是纸糊的。
 */
const FORBIDDEN_QUERY_KEYS: readonly string[] = [
  'token',
  'access_token',
  'access-token',
  'api_key',
  'apikey',
  'key',
  'auth',
  'authorization',
  'password',
  'passwd',
  'secret',
  'session',
  'ticket_token',
]

/** 生成一个高熵 token（base64url，无填充，可直接放进 header）。 */
export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url')
}

/**
 * 常量时间比较。
 *
 * 先各自做一次 SHA-256 再 `timingSafeEqual`：这样**长度不同也走同一条路径**，
 * 不会因为 `timingSafeEqual` 对长度不等直接抛错而退化成"早退比较"。
 * 哈希引入的碰撞风险对本场景没有意义——比较的是同一个秘密。
 */
export function constantTimeEquals(left: string, right: string): boolean {
  const a = createHash('sha256').update(left, 'utf8').digest()
  const b = createHash('sha256').update(right, 'utf8').digest()
  return timingSafeEqual(a, b)
}

/** 认证结果。 */
export type AuthResult =
  | { readonly ok: true; readonly principalId: PrincipalId }
  | { readonly ok: false; readonly code: ErrorCode; readonly reason: string }

/**
 * 认证失败的形状。
 *
 * `checkQueryString` 返回 `AuthFailure | undefined`（`undefined` = 通过）而不是
 * `AuthResult`：后者会让 `if (failure)` 收窄成整个联合，于是 `failure.code`
 * 在类型上仍然可能不存在——一个只有类型检查器能发现的坑。
 */
export type AuthFailure = Extract<AuthResult, { readonly ok: false }>

/** ticket 记录。 */
interface Ticket {
  readonly principalId: PrincipalId
  /** 绑定的 Origin。换一个 Origin 用同一张 ticket 会被拒绝。 */
  readonly origin: string
  readonly expiresAtMs: number
}

export interface AuthServiceOptions {
  readonly mode: AuthMode
  /** `mode === 'none'` 时忽略。 */
  readonly token: string
  readonly principalId: PrincipalId
  readonly now: () => number
  readonly logger: WebLogger
}

/**
 * 认证服务。
 *
 * **只有一条认证路径**：所有 HTTP 与 WS 校验都经过 `authenticate*`，
 * 不允许任何路由"自己判断一下 Authorization 头"——那正是认证绕过长出来的方式。
 */
export class AuthService {
  readonly #mode: AuthMode
  readonly #token: string
  readonly #principalId: PrincipalId
  readonly #now: () => number
  readonly #logger: WebLogger
  readonly #tickets = new Map<string, Ticket>()

  constructor(options: AuthServiceOptions) {
    this.#mode = options.mode
    this.#token = options.token
    this.#principalId = options.principalId
    this.#now = options.now
    this.#logger = options.logger
  }

  get mode(): AuthMode {
    return this.#mode
  }

  /** 本机 principal。Web 用户全部映射到它（单 token 部署下只有一个主体）。 */
  get principalId(): PrincipalId {
    return this.#principalId
  }

  /** 认证是否被完全关闭。仅 `--auth none`，且 `public` 下不可能为真。 */
  get disabled(): boolean {
    return this.#mode === 'none'
  }

  /**
   * 校验 URL query string 里没有 token 类参数。
   *
   * **先于一切凭据校验执行**：带着合法 Bearer 但 query 里塞了 token 的请求
   * 同样必须被拒——否则"URL 不含 token"就只是对合法用户的约束，
   * 拿到 token 的人反而可以随便把它写进 URL。
   */
  checkQueryString(searchParams: URLSearchParams, context: string): AuthFailure | undefined {
    for (const key of searchParams.keys()) {
      const normalized = key.toLowerCase()
      if (!FORBIDDEN_QUERY_KEYS.includes(normalized)) continue

      const reason = `凭据不得出现在 URL query string 中（发现参数 ${key}）`
      this.#logger.warn(`[web-auth] 拒绝请求：${reason}（${context}）`)
      return { ok: false, code: ErrorCode.WEB_AUTH_FAILED, reason }
    }
    return undefined
  }

  /** 校验 `Authorization: Bearer <token>`。 */
  authenticateBearer(header: string | undefined, context: string): AuthResult {
    if (this.disabled) return { ok: true, principalId: this.#principalId }

    if (header === undefined || header === '') {
      this.#logger.warn(`[web-auth] 缺少 Authorization 头（${context}）`)
      return { ok: false, code: ErrorCode.WEB_AUTH_FAILED, reason: '缺少 Authorization: Bearer' }
    }

    const prefix = 'Bearer '
    if (!header.startsWith(prefix))
      return { ok: false, code: ErrorCode.WEB_AUTH_FAILED, reason: '仅支持 Authorization: Bearer' }

    const presented = header.slice(prefix.length).trim()
    if (!constantTimeEquals(presented, this.#token)) {
      this.#logger.warn(`[web-auth] token 不匹配（${context}）`)
      return { ok: false, code: ErrorCode.WEB_AUTH_FAILED, reason: 'token 无效' }
    }
    return { ok: true, principalId: this.#principalId }
  }

  /**
   * 签发一张 WebSocket ticket。
   *
   * 绑定 `origin` 是必要而非多余的：ticket 会出现在 WS 的 URL 里，
   * 而 URL 可能被日志记录。绑定后即使被读到，别的页面也用不了。
   */
  issueTicket(origin: string): { readonly ticket: string; readonly expiresAtMs: number } {
    this.#pruneTickets()
    const ticket = randomBytes(TOKEN_BYTES).toString('base64url')
    const expiresAtMs = this.#now() + WS_TICKET_TTL_MS
    this.#tickets.set(ticket, { principalId: this.#principalId, origin, expiresAtMs })
    return { ticket, expiresAtMs }
  }

  /**
   * 消费一张 ticket。**单次使用**——无论校验成功与否都从表里摘掉。
   *
   * 只在校验成功时删除是不够的：失败的那次尝试同样消耗掉了这张 ticket 的
   * "未知性"（攻击者已经知道值了），留着它只会让后续正主用同一张票反复失败。
   */
  consumeTicket(ticket: string | undefined, origin: string): AuthResult {
    if (ticket === undefined || ticket === '') {
      return { ok: false, code: ErrorCode.WEB_AUTH_FAILED, reason: '缺少 ticket' }
    }

    const entry = this.#tickets.get(ticket)
    this.#tickets.delete(ticket)

    if (!entry) {
      // 用常量时间比较兜一层：避免"ticket 存在与否"的响应时间差可被观测。
      constantTimeEquals(ticket, ticket)
      return { ok: false, code: ErrorCode.WEB_AUTH_FAILED, reason: 'ticket 无效或已被使用' }
    }
    if (entry.expiresAtMs <= this.#now())
      return { ok: false, code: ErrorCode.WEB_AUTH_FAILED, reason: 'ticket 已过期' }
    if (entry.origin !== origin)
      return { ok: false, code: ErrorCode.WEB_AUTH_FAILED, reason: 'ticket 与 Origin 不匹配' }

    return { ok: true, principalId: entry.principalId }
  }

  /** 当前有效 ticket 数。测试与诊断用。 */
  get pendingTickets(): number {
    return this.#tickets.size
  }

  #pruneTickets(): void {
    const now = this.#now()
    for (const [key, entry] of this.#tickets) {
      if (entry.expiresAtMs <= now) this.#tickets.delete(key)
    }
  }
}

/**
 * 启动时打印的一次性访问提示。
 *
 * 抽成函数而不是内联在 `server.ts`：这段文本**只在终端出现一次**，
 * 是用户拿到 token 的唯一机会，值得被测试固定住（漏打印等于 token 拿不到）。
 */
export function formatAccessNotice(input: {
  readonly url: string
  readonly token: string | undefined
  readonly authMode: AuthMode
  readonly warnings: readonly string[]
}): readonly string[] {
  const lines: string[] = [`[web-ui] 监听 ${input.url}`]

  if (input.authMode === 'none') {
    lines.push('[web-ui] ⚠️ 认证已关闭（--auth none）：任何能访问该地址的人都能驱动 Agent')
  } else if (input.token !== undefined) {
    lines.push('[web-ui] 认证 token（仅本次显示，不会写入任何文件）：')
    lines.push(`[web-ui]   ${input.token}`)
    lines.push('[web-ui] 在浏览器中粘贴该 token 完成登录；它不会出现在 URL 里。')
  }

  for (const warning of input.warnings) lines.push(`[web-ui] ${warning}`)
  return lines
}
