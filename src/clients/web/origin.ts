/**
 * Origin / CORS / 安全响应头。
 *
 * ## 为什么 `local` 也要校验 Origin
 *
 * 监听在 `127.0.0.1` 不等于安全：浏览器里任何一个网页都能向
 * `http://127.0.0.1:3210` 发跨站请求，而请求会带着**该网页的 Origin**。
 * 没有 Origin 校验时，用户打开的任意一个标签页都能驱动本机 Agent。
 * 默认 local 不要求 token，因此 Origin 校验尤其重要：它挡住其它网页
 * 跨端口调用本机 Agent。显式启用 token 时仍需检查 Origin。
 *
 * ## 默认仅同源，`*` 直接拒绝
 *
 * `parts/09` §1.1：「默认 CORS 仅允许同源，禁止 `*` 与 credentials 同时使用」。
 * 这里的取舍比规格更严一档：**`--cors '*'` 在启动阶段就被拒绝**，
 * 而不是"允许 `*` 但不发 credentials"。原因是本服务的每一个端点都等价于
 * 远程代码执行（提交 prompt、批准工具、取消 turn），宽松 CORS 在这里没有
 * 合理的用法，"配置成 `*` 然后出问题"的代价远高于"启动时报错"。
 *
 * ## CSP 里没有 `unsafe-inline`
 *
 * 这意味着两件事必须成立，否则页面会静默失灵：
 * 1. 前端不能有内联 `<script>` / `<style>`（所以样式编译成静态 CSS）。
 * 2. 前端 JS **不能写 `element.style.*`**——CSP3 下内联样式属性受 `style-src`
 *    管辖，没有 `unsafe-inline` 就会被拦。动态样式一律走 class 切换。
 */

import { ErrorCode } from '../../core/errors.js'

/**
 * 内容安全策略。
 *
 * `connect-src` 里的 `ws:` 是规格明列的值：`'self'` 在部分浏览器实现里
 * 不覆盖 `ws://` 同源地址，缺了它 WebSocket 会被 CSP 拦掉。
 */
export const CONTENT_SECURITY_POLICY =
  "default-src 'self'; connect-src 'self' ws:; script-src 'self'; style-src 'self'"

/** 允许的 HTTP 方法。`OPTIONS` 只用于 preflight。 */
export const ALLOWED_METHODS = 'GET, POST, OPTIONS'

/** 允许的请求头。`Idempotency-Key` 必须在列，否则浏览器 preflight 会失败。 */
export const ALLOWED_HEADERS = 'Authorization, Content-Type, Idempotency-Key, X-Deepcode-Project'

/** Origin 策略。 */
export interface OriginPolicy {
  /** 同源（本机 loopback）来源。**永远**包含这三条。 */
  readonly sameOrigin: readonly string[]
  /** `--cors` 显式追加的来源。为空表示仅同源。 */
  readonly extra: readonly string[]
}

/** CORS 解析结果。 */
export type CorsDecision =
  | { readonly ok: true; readonly policy: OriginPolicy }
  | { readonly ok: false; readonly code: ErrorCode; readonly reason: string }

/** 端口对应的默认同源来源。覆盖 IPv4 / IPv6 / localhost 三种写法。 */
export function defaultAllowedOrigins(port: number): readonly string[] {
  return [`http://127.0.0.1:${port}`, `http://[::1]:${port}`, `http://localhost:${port}`]
}

/**
 * 解析 `--cors`。
 *
 * 每一项都必须是完整的 `scheme://host[:port]`，**不接受**通配、路径或末尾斜杠：
 * 宽松解析会让 `--cors http://evil.com/../` 或 `http://evil.com*` 这类值
 * 悄悄变成"看起来是那个站点其实不是"。
 */
export function resolveCors(raw: string | undefined, port: number): CorsDecision {
  const sameOrigin = defaultAllowedOrigins(port)
  if (raw === undefined || raw.trim() === '') return { ok: true, policy: { sameOrigin, extra: [] } }

  const items = raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '')

  if (items.length === 0) return { ok: true, policy: { sameOrigin, extra: [] } }

  const extra: string[] = []
  for (const item of items) {
    if (item === '*')
      return {
        ok: false,
        code: ErrorCode.WEB_ORIGIN_REJECTED,
        reason:
          '--cors * 被拒绝：本服务的每个端点都等价于远程驱动 Agent，' +
          '不存在需要放开全部来源的合理场景；请逐个列出允许的 Origin',
      }

    let parsed: URL
    try {
      parsed = new URL(item)
    } catch {
      return {
        ok: false,
        code: ErrorCode.WEB_ORIGIN_REJECTED,
        reason: `--cors 的每一项都必须是完整来源（如 http://192.168.1.5:3210），收到：${item}`,
      }
    }
    if (parsed.origin === 'null' || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:'))
      return {
        ok: false,
        code: ErrorCode.WEB_ORIGIN_REJECTED,
        reason: `--cors 只接受 http/https 来源，收到：${item}`,
      }
    if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '')
      return {
        ok: false,
        code: ErrorCode.WEB_ORIGIN_REJECTED,
        reason: `--cors 不接受路径、查询串或片段，收到：${item}`,
      }
    extra.push(parsed.origin)
  }

  return { ok: true, policy: { sameOrigin, extra } }
}

/** 该 Origin 是否被允许。`undefined`（无 Origin）永远不允许——由调用方决定是否豁免。 */
export function isOriginAllowed(origin: string | undefined, policy: OriginPolicy): boolean {
  if (origin === undefined || origin === '') return false
  return policy.sameOrigin.includes(origin) || policy.extra.includes(origin)
}

/** 全部允许的来源，用于日志与错误提示。 */
export function allowedOriginList(policy: OriginPolicy): readonly string[] {
  return [...policy.sameOrigin, ...policy.extra]
}

/**
 * 安全响应头。
 *
 * `Cache-Control: no-store` 只加在 `/api/*` 上：静态资源需要正常缓存，
 * 否则每次刷新都要重下前端；而 API 响应里可能有 transcript、参数摘要
 * 与待审批项，落进浏览器缓存或中间代理都是泄露。
 */
export function securityHeaders(input: { readonly isApi: boolean }): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Security-Policy': CONTENT_SECURITY_POLICY,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
  }
  if (input.isApi) headers['Cache-Control'] = 'no-store'
  return headers
}

/** 路径是否为 `/api/*`。 */
export function isApiPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/')
}
