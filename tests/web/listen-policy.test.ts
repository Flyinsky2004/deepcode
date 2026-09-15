/**
 * 监听策略的**表驱动**测试。
 *
 * 这一组是 Web 层里最值得穷举的部分：判定分支多、每条分支对应一种真实的
 * 暴露方式，而且失败模式是"安静地监听了不该监听的地址"。
 * DNS 与网卡都从 deps 注入，因此每个用例都是确定性的。
 */

import { describe, expect, it } from 'vitest'

import { ErrorCode } from '../../src/core/errors.js'
import {
  AuthMode,
  DEFAULT_WEB_PORT,
  ListenScope,
  addressFamily,
  classifyAddress,
  evaluateBindResults,
  evaluateListen,
  formatAddress,
  isWildcardAddress,
  parseIPv4,
  parseIPv6,
  type ListenPolicyDeps,
  type ListenRequest,
} from '../../src/clients/web/listen-policy.js'

/** 可预测的 deps：名字 → 固定地址表，网卡 → 固定列表。 */
function deps(
  hosts: Readonly<Record<string, readonly string[]>> = {},
  interfaces: readonly { address: string; family: string; internal: boolean }[] = [],
): ListenPolicyDeps {
  return {
    resolveHost: (hostname) => {
      const found = hosts[hostname]
      if (found === undefined) return Promise.reject(new Error(`未知主机名 ${hostname}`))
      return Promise.resolve(found)
    },
    interfaces: () =>
      Object.fromEntries(interfaces.map((entry, index) => [`eth${String(index)}`, [entry]])),
  }
}

function request(overrides: Partial<ListenRequest> = {}): ListenRequest {
  return {
    listen: ListenScope.LOCAL,
    port: DEFAULT_WEB_PORT,
    portExplicit: false,
    auth: AuthMode.TOKEN,
    ...overrides,
  }
}

describe('地址解析与分类', () => {
  it('parseIPv4 只接受点分十进制', () => {
    expect(parseIPv4('127.0.0.1')).toBe(0x7f000001)
    expect(parseIPv4('0.0.0.0')).toBe(0)
    expect(parseIPv4('255.255.255.255')).toBe(0xffffffff)
    expect(parseIPv4('::1')).toBeUndefined()
    expect(parseIPv4('127.1')).toBeUndefined()
  })

  it('parseIPv6 支持缩写、zone 与内嵌 IPv4', () => {
    expect(parseIPv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1])
    expect(parseIPv6('fe80::1%en0')).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1])
    expect(parseIPv6('::ffff:127.0.0.1')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 0x0001])
    expect(parseIPv6('2001:db8::1')).toEqual([0x2001, 0x0db8, 0, 0, 0, 0, 0, 1])
    // 组数不足且没有 `::` 时不是合法地址
    expect(parseIPv6('2001:db8:1')).toBeUndefined()
    expect(parseIPv6('127.0.0.1')).toBeUndefined()
  })

  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback'],
    ['::1', 'loopback'],
    // v4-mapped 的 loopback 必须**归一化后**仍然判成 loopback
    ['::ffff:127.0.0.1', 'loopback'],
    ['10.0.0.5', 'lan'],
    ['172.16.0.1', 'lan'],
    ['172.31.255.254', 'lan'],
    ['172.32.0.1', 'public'],
    ['192.168.1.10', 'lan'],
    ['169.254.1.1', 'lan'],
    ['fc00::1', 'lan'],
    ['fd12:3456::1', 'lan'],
    ['fe80::1', 'lan'],
    // ⚠️ CGNAT：属于运营商，**不是**局域网。判成 lan 会让 `--listen lan`
    // 意外监听运营商网段上的接口。
    ['100.64.0.1', 'public'],
    ['100.127.255.255', 'public'],
    ['100.63.255.255', 'public'],
    ['100.128.0.1', 'public'],
    ['8.8.8.8', 'public'],
    ['2001:db8::1', 'public'],
  ])('classifyAddress(%s) === %s', (address, expected) => {
    expect(classifyAddress(address)).toBe(expected)
  })

  it('无法解析的输入返回 undefined，而不是猜一个分类', () => {
    expect(classifyAddress('not-an-ip')).toBeUndefined()
    expect(classifyAddress('')).toBeUndefined()
  })

  it('通配地址与家族判定', () => {
    expect(isWildcardAddress('0.0.0.0')).toBe(true)
    expect(isWildcardAddress('::')).toBe(true)
    expect(isWildcardAddress('127.0.0.1')).toBe(false)
    expect(addressFamily('127.0.0.1')).toBe(4)
    expect(addressFamily('::1')).toBe(6)
    expect(addressFamily('nope')).toBeUndefined()
  })

  it('IPv6 在 URL 里带方括号', () => {
    expect(formatAddress({ host: '127.0.0.1', family: 4 })).toBe('127.0.0.1')
    expect(formatAddress({ host: '::1', family: 6 })).toBe('[::1]')
  })
})

describe('evaluateListen：判定顺序与范围', () => {
  it('public + auth none 被拒绝，且**先于**其它分支', async () => {
    // 端口与 host 同时非法：若判定顺序被重排，会先报端口错误。
    // 这条断言锁住的是"最危险的组合最先判"。
    const decision = await evaluateListen(
      request({
        listen: ListenScope.PUBLIC,
        auth: AuthMode.NONE,
        port: 99999,
        host: 'definitely-not-a-host',
      }),
      deps(),
    )
    expect(decision.ok).toBe(false)
    if (decision.ok) return
    expect(decision.code).toBe(ErrorCode.WEB_AUTH_FAILED)
    expect(decision.reason).toContain('--auth none')
  })

  it('public + token 允许，并带上公网暴露警告', async () => {
    const decision = await evaluateListen(
      request({ listen: ListenScope.PUBLIC, auth: AuthMode.TOKEN }),
      deps(),
    )
    expect(decision.ok).toBe(true)
    if (!decision.ok) return
    expect(decision.addresses.map((a) => a.host)).toEqual(['0.0.0.0', '::'])
    expect(decision.warnings.join('')).toContain('public')
  })

  it('public + password 允许（规格要求非 none 即可）', async () => {
    const decision = await evaluateListen(
      request({ listen: ListenScope.PUBLIC, auth: AuthMode.PASSWORD }),
      deps(),
    )
    expect(decision.ok).toBe(true)
  })

  it('local 默认绑两个 loopback 地址（一个 server 只能绑一个）', async () => {
    const decision = await evaluateListen(request(), deps())
    expect(decision.ok).toBe(true)
    if (!decision.ok) return
    expect(decision.addresses).toEqual([
      { host: '127.0.0.1', family: 4 },
      { host: '::1', family: 6 },
    ])
    expect(decision.warnings).toEqual([])
  })

  it('lan 默认绑通配地址并给出局域网警告', async () => {
    const decision = await evaluateListen(request({ listen: ListenScope.LAN }), deps())
    expect(decision.ok).toBe(true)
    if (!decision.ok) return
    expect(decision.addresses.map((a) => a.host)).toEqual(['0.0.0.0', '::'])
    expect(decision.warnings.join('')).toContain('防火墙')
  })

  it.each([0, 65536, -1, 1.5, Number.NaN])('端口 %s 越界被拒绝', async (port) => {
    const decision = await evaluateListen(request({ port }), deps())
    expect(decision.ok).toBe(false)
  })

  it('端口 0 只在显式传入时允许', async () => {
    const implicit = await evaluateListen(request({ port: 0 }), deps())
    expect(implicit.ok).toBe(false)

    const explicit = await evaluateListen(request({ port: 0, portExplicit: true }), deps())
    expect(explicit.ok).toBe(true)
  })
})

describe('evaluateListen：--host', () => {
  it('local 下拒绝非 loopback 字面量', async () => {
    const decision = await evaluateListen(request({ host: '192.168.1.10' }), deps())
    expect(decision.ok).toBe(false)
    if (decision.ok) return
    expect(decision.reason).toContain('loopback')
  })

  it('local 下允许显式 127.0.0.1（逃生口）', async () => {
    const decision = await evaluateListen(request({ host: '127.0.0.1' }), deps())
    expect(decision.ok).toBe(true)
    if (!decision.ok) return
    expect(decision.addresses).toEqual([{ host: '127.0.0.1', family: 4 }])
  })

  it('lan 下允许 RFC1918 / RFC4193 / link-local', async () => {
    for (const host of ['10.1.2.3', '192.168.0.9', '172.20.0.1', 'fd00::9', 'fe80::1'])
      expect((await evaluateListen(request({ listen: ListenScope.LAN, host }), deps())).ok).toBe(
        true,
      )
  })

  it('lan 下拒绝公网地址与 CGNAT', async () => {
    for (const host of ['8.8.8.8', '100.64.0.1']) {
      const decision = await evaluateListen(request({ listen: ListenScope.LAN, host }), deps())
      expect(decision.ok).toBe(false)
    }
  })

  it('lan 下允许 loopback（收窄不是扩大）', async () => {
    const decision = await evaluateListen(
      request({ listen: ListenScope.LAN, host: '127.0.0.1' }),
      deps(),
    )
    expect(decision.ok).toBe(true)
    if (!decision.ok) return
    // 收窄到 loopback 时不该再警告"已暴露到局域网"
    expect(decision.warnings).toEqual([])
  })

  it('只有 public 允许显式指定通配地址', async () => {
    for (const scope of [ListenScope.LOCAL, ListenScope.LAN]) {
      const decision = await evaluateListen(request({ listen: scope, host: '0.0.0.0' }), deps())
      expect(decision.ok).toBe(false)
    }
    expect(
      (await evaluateListen(request({ listen: ListenScope.PUBLIC, host: '0.0.0.0' }), deps())).ok,
    ).toBe(true)
  })

  it('DNS 名称解析出的**全部**地址都要合规（多 A 记录部分不合规即拒绝）', async () => {
    // 这正是"通过名称绕过限制"的手法：一个名字同时挂内网与公网 A 记录。
    const decision = await evaluateListen(
      request({ listen: ListenScope.LAN, host: 'mixed.example' }),
      deps({ 'mixed.example': ['192.168.1.5', '203.0.113.7'] }),
    )
    expect(decision.ok).toBe(false)
    if (decision.ok) return
    expect(decision.reason).toContain('203.0.113.7')
  })

  it('DNS 名称解析出的地址全部合规时全部绑定', async () => {
    const decision = await evaluateListen(
      request({ listen: ListenScope.LAN, host: 'both.example' }),
      deps({ 'both.example': ['192.168.1.5', 'fd00::5'] }),
    )
    expect(decision.ok).toBe(true)
    if (!decision.ok) return
    expect(decision.addresses).toEqual([
      { host: '192.168.1.5', family: 4 },
      { host: 'fd00::5', family: 6 },
    ])
  })

  it('名称解析失败 → 拒绝并说明原因', async () => {
    const decision = await evaluateListen(
      request({ listen: ListenScope.LAN, host: 'nowhere.invalid' }),
      deps(),
    )
    expect(decision.ok).toBe(false)
    if (decision.ok) return
    expect(decision.reason).toContain('nowhere.invalid')
  })

  it('名称解析出 0 条记录 → 拒绝（不静默绑到默认地址）', async () => {
    const decision = await evaluateListen(
      request({ listen: ListenScope.LAN, host: 'empty.example' }),
      deps({ 'empty.example': [] }),
    )
    expect(decision.ok).toBe(false)
  })

  it('localhost 在 local 下可用（解析出 v4 + v6 loopback）', async () => {
    const decision = await evaluateListen(
      request({ host: 'localhost' }),
      deps({ localhost: ['127.0.0.1', '::1'] }),
    )
    expect(decision.ok).toBe(true)
  })
})

describe('evaluateBindResults：绑定失败不降级', () => {
  const addresses = [
    { host: '127.0.0.1', family: 4 as const },
    { host: '::1', family: 6 as const },
  ]

  it('全部成功即通过', () => {
    const decision = evaluateBindResults(ListenScope.LOCAL, addresses, [
      { host: '127.0.0.1', family: 4 },
      { host: '::1', family: 6 },
    ])
    expect(decision.ok).toBe(true)
  })

  it('⚠️ 127.0.0.1 成功而 ::1 失败 → 仍然失败，但给出 IPv4 逃生口', () => {
    const decision = evaluateBindResults(ListenScope.LOCAL, addresses, [
      { host: '127.0.0.1', family: 4 },
      { host: '::1', family: 6, error: 'EADDRNOTAVAIL' },
    ])
    expect(decision.ok).toBe(false)
    if (decision.ok) return
    expect(decision.code).toBe(ErrorCode.WEB_LISTEN_FAILED)
    expect(decision.reason).toContain('EADDRNOTAVAIL')
    // 不降级是硬要求，但必须给用户一条明确的出路。
    expect(decision.reason).toContain('--host 127.0.0.1')
  })

  it('非 ::1 的失败不带 IPv4 逃生口（那是无意义的提示）', () => {
    const decision = evaluateBindResults(ListenScope.LAN, addresses, [
      { host: '0.0.0.0', family: 4, error: 'EADDRINUSE' },
    ])
    expect(decision.ok).toBe(false)
    if (decision.ok) return
    expect(decision.reason).not.toContain('--host 127.0.0.1')
  })
})
