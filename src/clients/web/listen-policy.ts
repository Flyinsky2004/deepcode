/**
 * `--listen` / `--host` / `--port` 的地址策略：**纯决策函数**。
 *
 * 这是 `parts/09` §1.1 里最容易出错、也最不值得出错的一段：判定顺序、地址分类
 * 和"绝不降级"三条要求都必须可枚举地验证。因此本模块**不做任何 IO**——
 * DNS 解析与网卡枚举都从 `ListenPolicyDeps` 注入，测试用表驱动覆盖全部分支。
 *
 * ## 判定顺序是契约，不能重排
 *
 * 1. `public && auth === 'none'` —— **最先判**。放在后面会被"端口非法"之类的
 *    分支短路掉，于是"公网无认证"这个最危险组合反而要靠运气才被拦下。
 * 2. 端口范围（`--port 0` 仅显式传入时允许）。
 * 3. `--host`：名字先解析成**全部** IP，**逐个**校验，全部通过才算通过。
 * 4. 地址分类用 `node:net` 的 `isIPv4` / `isIPv6` + 数值解析，**不用字符串正则**。
 * 5. `local` 只允许 loopback；`lan` 只允许内网与本机地址；`public` 任意。
 * 6. 失败即失败——调用方打印原因后退出，**不得降级到更宽松的地址**。
 *
 * ## 三处显式决策（规格自身存在张力，这里给出取舍并说明理由）
 *
 * - **`100.64.0.0/10`（CGNAT）判为 `public`，不是 `lan`**。它属于运营商而非
 *   局域网；判成 lan 会让 `--listen lan` 去监听运营商网段上的接口。
 * - **显式 `--host 0.0.0.0` / `::` 在 `local` 与 `lan` 下被拒绝**。
 *   `lan` 的默认绑定确实是 `0.0.0.0` / `::`（表格如此），但"`--host` 不能扩大
 *   `--listen` 权限"是一条更明确的规则：通配地址严格宽于任何具体地址，
 *   且通配绑定无法兑现"拒绝公网接口"的承诺。只允许 `public` 显式指定通配。
 * - **`lan` 允许显式指定 loopback**。这是**收窄**而非扩大，拒绝它对用户没有任何
 *   安全收益，只会让"我只想在内网模式下限本机"这件事变得做不到。
 */

import { lookup } from 'node:dns/promises'
import { isIPv4, isIPv6 } from 'node:net'
import { networkInterfaces } from 'node:os'

import { ErrorCode } from '../../core/errors.js'

/** `--listen` 的三种范围。 */
export const ListenScope = {
  LOCAL: 'local',
  LAN: 'lan',
  PUBLIC: 'public',
} as const

/** 监听范围类型。 */
export type ListenScope = (typeof ListenScope)[keyof typeof ListenScope]

/** 全部合法监听范围，用于命令行参数校验。 */
export const LISTEN_SCOPES: readonly ListenScope[] = [
  ListenScope.LOCAL,
  ListenScope.LAN,
  ListenScope.PUBLIC,
]

/** `--auth` 的三种模式。 */
export const AuthMode = {
  NONE: 'none',
  TOKEN: 'token',
  PASSWORD: 'password',
} as const

/** 认证模式类型。 */
export type AuthMode = (typeof AuthMode)[keyof typeof AuthMode]

/** 全部合法认证模式。 */
export const AUTH_MODES: readonly AuthMode[] = [AuthMode.NONE, AuthMode.TOKEN, AuthMode.PASSWORD]

/** 默认端口（`parts/09` §1.1）。 */
export const DEFAULT_WEB_PORT = 3210

/**
 * 地址分类。
 *
 * `public` 是"既非 loopback 也非内网"的兜底，**包含** CGNAT 与各类保留段——
 * 它们都不是"局域网"，在 `--listen lan` 下必须被拒绝。
 */
export type AddressClass = 'loopback' | 'lan' | 'public'

/** 一个待绑定的地址。`family` 决定 `net.Server.listen` 的 `family` 选项。 */
export interface ListenAddress {
  readonly host: string
  readonly family: 4 | 6
}

/** `os.networkInterfaces()` 的最小结构，便于注入测试数据。 */
export interface InterfaceAddress {
  readonly address: string
  readonly family: string | number
  readonly internal: boolean
}

/** 网卡枚举结果。 */
export type NetworkInterfaceMap = Readonly<Record<string, readonly InterfaceAddress[] | undefined>>

/** 注入点。真实实现见 `systemListenDeps()`。 */
export interface ListenPolicyDeps {
  /** 解析主机名 → **全部**地址（A 与 AAAA）。名字不存在时抛错。 */
  readonly resolveHost: (hostname: string) => Promise<readonly string[]>
  /** 枚举本机网卡地址。 */
  readonly interfaces: () => NetworkInterfaceMap
}

/** 一次监听请求。 */
export interface ListenRequest {
  readonly listen: ListenScope
  /** `--host` 的原始值。未传入时为 `undefined`。 */
  readonly host?: string | undefined
  /** 最终端口。默认 `DEFAULT_WEB_PORT`。 */
  readonly port: number
  /** `--port` 是否被**显式**传入。`--port 0`（随机端口）只在显式为真时允许。 */
  readonly portExplicit: boolean
  readonly auth: AuthMode
}

/** 决策结果。失败时带稳定错误码与**可读原因**（调用方据此打印并退出）。 */
export type ListenDecision =
  | {
      readonly ok: true
      readonly addresses: readonly ListenAddress[]
      /** 需要提示给用户的警告（如公网暴露）。**不是**失败。 */
      readonly warnings: readonly string[]
    }
  | { readonly ok: false; readonly code: ErrorCode; readonly reason: string }

/** 一次绑定尝试的结果。由表现层在真正 `listen()` 之后回填。 */
export interface BindOutcome {
  readonly host: string
  readonly family: 4 | 6
  /** 绑定失败的原因。`undefined` 表示成功。 */
  readonly error?: string | undefined
}

// ─ 地址解析与分类 ────────────────────────────────────────────────

/** 16 进制字符 → 数值。不用正则，避免把"格式校验"和"取值"混在一处。 */
function hexValue(char: string): number | undefined {
  const code = char.charCodeAt(0)
  if (code >= 0x30 && code <= 0x39) return code - 0x30 // 0-9
  if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10 // a-f
  if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10 // A-F
  return undefined
}

/** 解析 IPv4 为 32 位无符号整数。非 IPv4 返回 `undefined`。 */
export function parseIPv4(ip: string): number | undefined {
  if (!isIPv4(ip)) return undefined
  let value = 0
  for (const part of ip.split('.')) {
    const octet = Number(part)
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return undefined
    value = value * 256 + octet
  }
  return value >>> 0
}

/** 按 `::` 切一刀。没有 `::` 时右侧为 `undefined`。 */
function splitCompression(text: string): [string, string | undefined] {
  const index = text.indexOf('::')
  if (index === -1) return [text, undefined]
  return [text.slice(0, index), text.slice(index + 2)]
}

/** 解析一段（不含 `::`）的十六进制组。 */
function parseGroups(segment: string): number[] | undefined {
  if (segment === '') return []
  const groups: number[] = []
  for (const piece of segment.split(':')) {
    if (piece.length === 0 || piece.length > 4) return undefined
    let value = 0
    for (const char of piece) {
      const digit = hexValue(char)
      if (digit === undefined) return undefined
      value = value * 16 + digit
    }
    groups.push(value)
  }
  return groups
}

/**
 * 解析 IPv6 为 8 个 16 位组。
 *
 * 支持 `%zone` 后缀（`fe80::1%en0`）与尾部内嵌 IPv4（`::ffff:1.2.3.4`）——
 * 后者是 **v4-mapped** 写法，必须先转成两个 16 位组，否则会被当成普通 v6
 * 地址，`::ffff:127.0.0.1` 就会绕过 loopback 判定。
 */
export function parseIPv6(ip: string): readonly number[] | undefined {
  const zoneIndex = ip.indexOf('%')
  const bare = zoneIndex === -1 ? ip : ip.slice(0, zoneIndex)
  if (!isIPv6(bare)) return undefined

  let text = bare
  const lastColon = text.lastIndexOf(':')
  const tail = text.slice(lastColon + 1)
  if (tail.includes('.')) {
    const v4 = parseIPv4(tail)
    if (v4 === undefined) return undefined
    const high = (v4 >>> 16) & 0xffff
    const low = v4 & 0xffff
    text = `${text.slice(0, lastColon + 1)}${high.toString(16)}:${low.toString(16)}`
  }

  const [left, right] = splitCompression(text)
  const leftGroups = parseGroups(left)
  const rightGroups = right === undefined ? undefined : parseGroups(right)
  if (leftGroups === undefined) return undefined

  if (rightGroups === undefined) {
    // 没有 `::` 时必须正好 8 组
    return leftGroups.length === 8 ? leftGroups : undefined
  }

  const fill = 8 - leftGroups.length - rightGroups.length
  if (fill < 0) return undefined
  return [...leftGroups, ...new Array<number>(fill).fill(0), ...rightGroups]
}

/** IPv4 数值 → 分类。 */
function classifyV4(value: number): AddressClass {
  const first = (value >>> 24) & 0xff
  const second = (value >>> 16) & 0xff

  if (first === 127) return 'loopback' // 127.0.0.0/8
  if (first === 10) return 'lan' // 10.0.0.0/8
  if (first === 172 && second >= 16 && second <= 31) return 'lan' // 172.16.0.0/12
  if (first === 192 && second === 168) return 'lan' // 192.168.0.0/16
  if (first === 169 && second === 254) return 'lan' // 169.254.0.0/16 link-local

  // 100.64.0.0/10（CGNAT）**刻意**落到这里。它属于运营商而不是局域网：
  // 判成 lan 会让 `--listen lan` 去监听运营商网段上的接口，而用户以为
  // 那只暴露了自己的局域网。
  return 'public'
}

/** IPv6 组 → 分类。 */
function classifyV6(groups: readonly number[]): AddressClass {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups

  // v4-mapped（::ffff:a.b.c.d）与 v4-compatible 尾部：归一化后按 v4 分类。
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff)
    return classifyV4(((g6 << 16) | g7) >>> 0)

  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 1)
    return 'loopback' // ::1

  if ((g0 & 0xfe00) === 0xfc00) return 'lan' // fc00::/7 RFC4193 unique local
  if ((g0 & 0xffc0) === 0xfe80) return 'lan' // fe80::/10 link-local

  return 'public'
}

/**
 * 地址分类。无法解析时返回 `undefined`（调用方按失败处理，不猜）。
 *
 * `::ffff:a.b.c.d` 会被归一化为 v4 再分类——这是规格明列要求。
 */
export function classifyAddress(ip: string): AddressClass | undefined {
  const v4 = parseIPv4(ip)
  if (v4 !== undefined) return classifyV4(v4)
  const v6 = parseIPv6(ip)
  if (v6 === undefined) return undefined
  return classifyV6(v6)
}

/** 是否为通配地址（`0.0.0.0` / `::`）。 */
export function isWildcardAddress(ip: string): boolean {
  const v4 = parseIPv4(ip)
  if (v4 !== undefined) return v4 === 0
  const v6 = parseIPv6(ip)
  if (v6 === undefined) return false
  return v6.every((group) => group === 0)
}

/** 地址家族。无法解析返回 `undefined`。 */
export function addressFamily(ip: string): 4 | 6 | undefined {
  if (parseIPv4(ip) !== undefined) return 4
  if (parseIPv6(ip) !== undefined) return 6
  return undefined
}

/** IPv6 在 URL / 日志里必须带方括号。 */
export function formatAddress(address: ListenAddress): string {
  return address.family === 6 ? `[${address.host}]` : address.host
}

// ── 决策 ──────────────────────────────────────────────────────────

function reject(reason: string, code: ErrorCode = ErrorCode.WEB_LISTEN_FAILED): ListenDecision {
  return { ok: false, code, reason }
}

/** 某个地址在给定范围内是否可接受。 */
function checkHostAddress(ip: string, scope: ListenScope): ListenDecision | undefined {
  const klass = classifyAddress(ip)
  if (klass === undefined) return reject(`无法解析的监听地址：${ip}`)

  if (isWildcardAddress(ip)) {
    if (scope === ListenScope.PUBLIC) return undefined
    return reject(
      `--listen ${scope} 不允许监听通配地址 ${ip}：` +
        `通配绑定无法兑现「拒绝公网接口」的承诺，请给出具体地址` +
        (scope === ListenScope.LOCAL ? '（如 --host 127.0.0.1）' : '（如 --host 192.168.1.10）'),
    )
  }

  switch (scope) {
    case ListenScope.LOCAL:
      if (klass === 'loopback') return undefined
      return reject(`--listen local 只允许 loopback 地址，${ip} 不是`)
    case ListenScope.LAN:
      // loopback 是**收窄**，允许；public（含 CGNAT 与公网网卡地址）拒绝。
      if (klass === 'loopback' || klass === 'lan') return undefined
      return reject(
        `--listen lan 只允许内网地址（RFC1918 / RFC4193 / link-local），${ip} 属于公网或运营商网段`,
      )
    case ListenScope.PUBLIC:
      return undefined
  }
}

/** 把主机名解析成全部地址；字面量 IP 直接返回。 */
async function resolveHostAddresses(
  host: string,
  deps: ListenPolicyDeps,
): Promise<{ ok: true; addresses: readonly string[] } | { ok: false; decision: ListenDecision }> {
  if (isIPv4(host) || isIPv6(host)) return { ok: true, addresses: [host] }

  let addresses: readonly string[]
  try {
    addresses = await deps.resolveHost(host)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      decision: reject(`无法解析主机名 ${host}：${message}`),
    }
  }

  if (addresses.length === 0)
    return { ok: false, decision: reject(`主机名 ${host} 未解析出任何地址`) }

  return { ok: true, addresses }
}

/** 默认绑定地址。`local` 是**两个**具体地址（Node 的一个 server 只能绑一个）。 */
function defaultAddresses(scope: ListenScope): readonly ListenAddress[] {
  switch (scope) {
    case ListenScope.LOCAL:
      return [
        { host: '127.0.0.1', family: 4 },
        { host: '::1', family: 6 },
      ]
    case ListenScope.LAN:
    case ListenScope.PUBLIC:
      return [
        { host: '0.0.0.0', family: 4 },
        { host: '::', family: 6 },
      ]
  }
}

function scopeWarnings(scope: ListenScope, addresses: readonly ListenAddress[]): string[] {
  switch (scope) {
    case ListenScope.LOCAL:
      return []
    case ListenScope.LAN:
      // `--listen lan --host 127.0.0.1` 是收窄用法，警告「已暴露到局域网」会误导。
      return addresses.every((address) => classifyAddress(address.host) === 'loopback')
        ? []
        : ['已按 --listen lan 监听局域网接口。请确认防火墙没有把这些端口转发到公网。']
    case ListenScope.PUBLIC:
      return [
        '⚠️ 已按 --listen public 监听全部接口，需要你自行承担公网暴露责任。',
        '⚠️ 生产部署请置于 TLS 反向代理之后；裸 HTTP 会让 token 在链路上明文传输。',
      ]
  }
}

/**
 * 主决策入口。
 *
 * 全流程无 IO 之外的副作用，因此可以逐条断言。**失败不降级**：
 * 返回 `ok: false` 后调用方必须打印 `reason` 并退出。
 */
export async function evaluateListen(
  request: ListenRequest,
  deps: ListenPolicyDeps,
): Promise<ListenDecision> {
  // ① 最危险组合最先判。任何后续分支都不得把它短路掉。
  if (request.listen === ListenScope.PUBLIC && request.auth === AuthMode.NONE)
    return reject(
      '--listen public 不允许 --auth none：公网无认证等同于把 Agent 交给任何人',
      ErrorCode.WEB_AUTH_FAILED,
    )

  // ② 端口。默认值是 3210，所以 port === 0 只可能来自显式 `--port 0`。
  if (!Number.isInteger(request.port) || request.port < 0 || request.port > 65535)
    return reject(`端口必须是 0-65535 之间的整数，收到 ${String(request.port)}`)
  if (request.port === 0 && !request.portExplicit)
    return reject('端口 0（随机端口）必须显式传入 --port 0，不能作为默认值')

  // ③ 显式 --host：名字要解析出全部 IP，逐个校验，全部通过才算通过。
  const host = request.host
  if (host !== undefined && host !== '') {
    const resolved = await resolveHostAddresses(host, deps)
    if (!resolved.ok) return resolved.decision

    for (const ip of resolved.addresses) {
      const failure = checkHostAddress(ip, request.listen)
      if (failure !== undefined) return failure
    }

    const addresses: ListenAddress[] = []
    for (const ip of resolved.addresses) {
      const family = addressFamily(ip)
      // 上一轮已经保证可解析；这里只是收窄类型。
      if (family === undefined) return reject(`无法解析的监听地址：${ip}`)
      addresses.push({ host: ip, family })
    }
    return { ok: true, addresses, warnings: scopeWarnings(request.listen, addresses) }
  }

  // ④ 未指定 --host：用该模式的默认绑定地址。
  const addresses = defaultAddresses(request.listen)
  return { ok: true, addresses, warnings: scopeWarnings(request.listen, addresses) }
}

/**
 * 绑定结果评估：把"某个地址没绑上"翻译成用户能照做的失败原因。
 *
 * 单独抽出来是因为 `local` 有一个**规格明列**的要求：`127.0.0.1` 成功而
 * `::1` 失败时**仍然失败退出**（不降级），但原因里必须给出逃生口——
 * 否则用户会卡在"明明是本机却起不来"上。
 */
export function evaluateBindResults(
  scope: ListenScope,
  addresses: readonly ListenAddress[],
  outcomes: readonly BindOutcome[],
): ListenDecision {
  const failed = outcomes.filter((outcome) => outcome.error !== undefined)
  if (failed.length === 0) return { ok: true, addresses, warnings: scopeWarnings(scope, addresses) }

  const detail = failed
    .map((outcome) => `[${outcome.host}]:${outcome.error ?? '未知错误'}`)
    .join('；')

  const needsEscape =
    scope === ListenScope.LOCAL && failed.some((outcome) => outcome.host === '::1')

  const escape = needsEscape ? '；如需仅 IPv4 请显式传 `--host 127.0.0.1`' : ''

  return reject(`监听失败：${detail}${escape}`)
}

/**
 * 真实依赖：系统 DNS 与网卡枚举。
 *
 * `verbatim: true`（Node 的默认值，这里显式写出来）很关键：它保证 A 与 AAAA
 * 记录**都**返回，而不是按家族挑一个。少返回一条记录就可能让"一个名字同时
 * 指向内网与公网"的绕过手法得逞。
 */
export function systemListenDeps(): ListenPolicyDeps {
  return {
    resolveHost: async (hostname) => {
      const results = await lookup(hostname, { all: true, verbatim: true })
      return results.map((entry) => entry.address)
    },
    interfaces: () => networkInterfaces(),
  }
}
