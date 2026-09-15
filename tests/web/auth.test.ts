/**
 * 认证：token 生成、常量时间比较、URL 凭据拒绝、ticket 生命周期。
 */

import { describe, expect, it } from 'vitest'

import { ErrorCode } from '../../src/core/errors.js'
import type { PrincipalId } from '../../src/core/ids.js'
import {
  AuthService,
  WS_TICKET_TTL_MS,
  constantTimeEquals,
  formatAccessNotice,
  generateToken,
} from '../../src/clients/web/auth.js'
import { AuthMode } from '../../src/clients/web/listen-policy.js'
import { MemoryLogger } from '../../src/clients/web/logger.js'

const PRINCIPAL = 'principal-1' as PrincipalId

function service(
  mode: AuthMode = AuthMode.TOKEN,
  options: { readonly token?: string; readonly now?: () => number } = {},
): { auth: AuthService; logger: MemoryLogger; token: string } {
  const token = options.token ?? 'the-token'
  const logger = new MemoryLogger()
  return {
    token,
    logger,
    auth: new AuthService({
      mode,
      token,
      principalId: PRINCIPAL,
      now: options.now ?? (() => 1_000),
      logger,
    }),
  }
}

describe('token 生成', () => {
  it('是 base64url、无填充、每次不同、熵足够', () => {
    const a = generateToken()
    const b = generateToken()
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/)
    // 32 字节 → 43 个 base64url 字符
    expect(a).toHaveLength(43)
  })
})

describe('constantTimeEquals', () => {
  it('相等/不等/长度不同都返回正确结果，且长度不同不抛错', () => {
    expect(constantTimeEquals('abc', 'abc')).toBe(true)
    expect(constantTimeEquals('abc', 'abd')).toBe(false)
    // `timingSafeEqual` 对长度不等会抛——这里的实现必须先哈希再比，
    // 否则长度不同会变成异常而不是 false。
    expect(constantTimeEquals('abc', 'abcdef')).toBe(false)
    expect(constantTimeEquals('', 'x')).toBe(false)
  })
})

describe('AuthService：Bearer', () => {
  it('正确 token 通过', () => {
    const { auth } = service()
    expect(auth.authenticateBearer('Bearer the-token', 'test')).toEqual({
      ok: true,
      principalId: PRINCIPAL,
    })
  })

  it('错误 token / 缺失头 / 非 Bearer 方案都拒绝', () => {
    const { auth } = service()
    for (const header of [undefined, '', 'Bearer wrong', 'Basic the-token', 'the-token']) {
      const result = auth.authenticateBearer(header, 'test')
      expect(result.ok).toBe(false)
    }
  })

  it('拒绝时记审计日志', () => {
    const { auth, logger } = service()
    auth.authenticateBearer('Bearer nope', '/api/x')
    expect(logger.warnings.join('\n')).toContain('/api/x')
  })

  it('--auth none 直接放行（public 下这条路径在启动阶段已被堵死）', () => {
    const { auth } = service(AuthMode.NONE)
    expect(auth.disabled).toBe(true)
    expect(auth.authenticateBearer(undefined, 'test')).toEqual({
      ok: true,
      principalId: PRINCIPAL,
    })
  })
})

describe('AuthService：URL 里的凭据', () => {
  it('任何 token 类参数都拒绝，且大小写不敏感', () => {
    const { auth } = service()
    for (const key of ['token', 'Token', 'access_token', 'api_key', 'apikey', 'secret', 'auth']) {
      const failure = auth.checkQueryString(new URLSearchParams(`${key}=x`), '/api/x')
      expect(failure?.code).toBe(ErrorCode.WEB_AUTH_FAILED)
    }
  })

  it('ticket 是唯一允许出现在 query 里的凭据', () => {
    const { auth } = service()
    expect(auth.checkQueryString(new URLSearchParams('ticket=abc'), '/api/stream')).toBeUndefined()
  })

  it('无关参数不拒绝', () => {
    const { auth } = service()
    expect(
      auth.checkQueryString(new URLSearchParams('sessionId=s1&lastEventId=e1'), '/x'),
    ).toBeUndefined()
  })
})

describe('AuthService：WebSocket ticket', () => {
  it('签发后可消费一次，第二次失败', () => {
    const { auth } = service()
    const { ticket } = auth.issueTicket('http://127.0.0.1:3210')

    expect(auth.consumeTicket(ticket, 'http://127.0.0.1:3210')).toEqual({
      ok: true,
      principalId: PRINCIPAL,
    })
    expect(auth.consumeTicket(ticket, 'http://127.0.0.1:3210').ok).toBe(false)
  })

  it('绑定 Origin：换个来源用同一张票被拒', () => {
    const { auth } = service()
    const { ticket } = auth.issueTicket('http://127.0.0.1:3210')
    expect(auth.consumeTicket(ticket, 'http://evil.example').ok).toBe(false)
  })

  it('过期后不可用', () => {
    let now = 1_000
    const { auth } = service(AuthMode.TOKEN, { now: () => now })
    const { ticket, expiresAtMs } = auth.issueTicket('http://127.0.0.1:3210')
    expect(expiresAtMs).toBe(1_000 + WS_TICKET_TTL_MS)

    now = 1_000 + WS_TICKET_TTL_MS + 1
    expect(auth.consumeTicket(ticket, 'http://127.0.0.1:3210').ok).toBe(false)
  })

  it('空的/未知的 ticket 一律拒绝', () => {
    const { auth } = service()
    expect(auth.consumeTicket(undefined, 'http://x').ok).toBe(false)
    expect(auth.consumeTicket('', 'http://x').ok).toBe(false)
    expect(auth.consumeTicket('never-issued', 'http://x').ok).toBe(false)
  })

  it('签发时顺带清理过期票据，避免表无限增长', () => {
    let now = 1_000
    const { auth } = service(AuthMode.TOKEN, { now: () => now })
    auth.issueTicket('http://a')
    expect(auth.pendingTickets).toBe(1)

    now += WS_TICKET_TTL_MS + 1
    auth.issueTicket('http://a')
    // 旧的那张被剪掉，只剩新的
    expect(auth.pendingTickets).toBe(1)
  })
})

describe('启动提示', () => {
  it('token 模式下把 token 打印出来（这是用户拿到它的唯一机会）', () => {
    const lines = formatAccessNotice({
      url: 'http://127.0.0.1:3210',
      token: 'secret-token',
      authMode: AuthMode.TOKEN,
      warnings: [],
    })
    expect(lines.join('\n')).toContain('secret-token')
    expect(lines.join('\n')).toContain('仅本次显示')
  })

  it('auth none 下给出明确警告', () => {
    const lines = formatAccessNotice({
      url: 'http://127.0.0.1:3210',
      token: undefined,
      authMode: AuthMode.NONE,
      warnings: [],
    })
    expect(lines.join('\n')).toContain('认证已关闭')
  })

  it('警告逐条输出', () => {
    const lines = formatAccessNotice({
      url: 'http://0.0.0.0:3210',
      token: 't',
      authMode: AuthMode.TOKEN,
      warnings: ['警告甲', '警告乙'],
    })
    expect(lines.join('\n')).toContain('警告甲')
    expect(lines.join('\n')).toContain('警告乙')
  })
})
