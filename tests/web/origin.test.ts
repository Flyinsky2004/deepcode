/**
 * Origin / CORS / 安全响应头。
 *
 * `--cors '*'` 的拒绝、CSP 里没有 `unsafe-inline`、`/api/*` 的 `no-store`
 * 都是"配错了不会报错、只会静默降低安全性"的项，所以逐条断言。
 */

import { describe, expect, it } from 'vitest'

import { ErrorCode } from '../../src/core/errors.js'
import {
  CONTENT_SECURITY_POLICY,
  allowedOriginList,
  defaultAllowedOrigins,
  isApiPath,
  isOriginAllowed,
  resolveCors,
  securityHeaders,
} from '../../src/clients/web/origin.js'

describe('默认同源', () => {
  it('覆盖 IPv4 / IPv6 / localhost 三种写法', () => {
    expect(defaultAllowedOrigins(3210)).toEqual([
      'http://127.0.0.1:3210',
      'http://[::1]:3210',
      'http://localhost:3210',
    ])
  })

  it('未给 --cors 时只有同源', () => {
    const decision = resolveCors(undefined, 3210)
    expect(decision.ok).toBe(true)
    if (!decision.ok) return
    expect(decision.policy.extra).toEqual([])
    expect(isOriginAllowed('http://127.0.0.1:3210', decision.policy)).toBe(true)
    expect(isOriginAllowed('http://evil.example', decision.policy)).toBe(false)
  })

  it('缺省 / 无 Origin 不放行（由调用方决定是否豁免）', () => {
    const decision = resolveCors(undefined, 3210)
    if (!decision.ok) return
    expect(isOriginAllowed(undefined, decision.policy)).toBe(false)
    expect(isOriginAllowed('', decision.policy)).toBe(false)
  })
})

describe('--cors 解析', () => {
  it('⚠️ `*` 直接拒绝', () => {
    const decision = resolveCors('*', 3210)
    expect(decision.ok).toBe(false)
    if (decision.ok) return
    expect(decision.code).toBe(ErrorCode.WEB_ORIGIN_REJECTED)
    expect(decision.reason).toContain('*')
  })

  it('逗号分隔的多个来源被接受并规范化', () => {
    const decision = resolveCors('http://192.168.1.5:3210, https://box.example', 3210)
    expect(decision.ok).toBe(true)
    if (!decision.ok) return
    expect(decision.policy.extra).toEqual(['http://192.168.1.5:3210', 'https://box.example'])
    expect(allowedOriginList(decision.policy)).toContain('http://localhost:3210')
  })

  it.each([
    ['not a url', '非法 URL'],
    ['ftp://x.example', '非 http/https'],
    ['http://x.example/path', '带路径'],
    ['http://x.example?a=1', '带查询串'],
  ])('拒绝 %s（%s）', (raw) => {
    expect(resolveCors(raw, 3210).ok).toBe(false)
  })

  it('空串等价于未配置', () => {
    const decision = resolveCors('  ', 3210)
    expect(decision.ok).toBe(true)
    if (!decision.ok) return
    expect(decision.policy.extra).toEqual([])
  })
})

describe('安全响应头', () => {
  it('CSP 含规格要求的四段，且**没有** unsafe-inline', () => {
    expect(CONTENT_SECURITY_POLICY).toBe(
      "default-src 'self'; connect-src 'self' ws:; script-src 'self'; style-src 'self'",
    )
    expect(CONTENT_SECURITY_POLICY).not.toContain('unsafe-inline')
    expect(CONTENT_SECURITY_POLICY).not.toContain('unsafe-eval')
  })

  it('API 响应带 no-store，静态资源不带', () => {
    expect(securityHeaders({ isApi: true })['Cache-Control']).toBe('no-store')
    expect(securityHeaders({ isApi: false })['Cache-Control']).toBeUndefined()
  })

  it('每一条响应都带 nosniff / noreferrer / DENY，且都带 CSP', () => {
    for (const isApi of [true, false]) {
      const headers = securityHeaders({ isApi })
      expect(headers['X-Content-Type-Options']).toBe('nosniff')
      expect(headers['Referrer-Policy']).toBe('no-referrer')
      expect(headers['X-Frame-Options']).toBe('DENY')
      expect(headers['Content-Security-Policy']).toBe(CONTENT_SECURITY_POLICY)
    }
  })
})

describe('isApiPath', () => {
  it('只认 /api 与 /api/ 前缀', () => {
    expect(isApiPath('/api')).toBe(true)
    expect(isApiPath('/api/sessions')).toBe(true)
    expect(isApiPath('/')).toBe(false)
    expect(isApiPath('/app.js')).toBe(false)
    // 前缀相同但不同段：`/apix` 不是 API
    expect(isApiPath('/apix')).toBe(false)
  })
})
