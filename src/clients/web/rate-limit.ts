/**
 * 限流与连接数控制。
 *
 * ## 数值一律来自 `AppPolicy`
 *
 * `parts/09` §3 与 `CLAUDE.md` 都要求阈值不得硬编码在局部。这里**没有任何
 * 字面量上限**——每个桶的容量与速率都是构造时传进来的 `AppPolicy` 字段。
 * 唯一写死的是"桶表最多留多少个键"这种**实现自身的**内存护栏，它不是策略阈值。
 *
 * ## 为什么用令牌桶而不是固定窗口
 *
 * 固定窗口在边界上允许 2 倍突发（窗口末尾打满 + 下个窗口开头再打满）。
 * 而这里要防的是"本地脚本用循环把 Agent 打到不可用"，突发正是它的形态。
 *
 * ## 时间从注入的时钟取
 *
 * `Date.now()` 直接调用会让限流测试只能靠 `sleep`，而 sleep 是 flaky 的温床。
 */

/** 一次限流判定的结果。 */
export type LimitDecision =
  | { readonly ok: true; readonly remaining: number }
  | { readonly ok: false; readonly retryAfterMs: number }

/** 桶表内存护栏。**不是**策略阈值，硬编码是有意的。 */
const MAX_TRACKED_KEYS = 4096

interface Bucket {
  tokens: number
  updatedAtMs: number
}

export interface TokenBucketOptions {
  /** 每分钟补充多少令牌。 */
  readonly perMinute: number
  /** 桶容量，即允许的瞬时突发。 */
  readonly burst: number
  readonly now: () => number
}

/** 令牌桶限流器。键可以是 IP、principal 或二者的组合。 */
export class TokenBucketLimiter {
  readonly #capacity: number
  readonly #refillPerMs: number
  readonly #now: () => number
  readonly #buckets = new Map<string, Bucket>()

  constructor(options: TokenBucketOptions) {
    // 容量至少 1：`perMinute = 0` 表示"完全禁止"，而不是"每桶 0 个令牌"导致
    // 除零或恒定拒绝时给出无意义的 retryAfter。
    this.#capacity = Math.max(1, Math.floor(options.burst))
    this.#refillPerMs = Math.max(0, options.perMinute) / 60_000
    this.#now = options.now
  }

  /** 消耗一个令牌。 */
  check(key: string): LimitDecision {
    const now = this.#now()
    const bucket = this.#buckets.get(key) ?? { tokens: this.#capacity, updatedAtMs: now }
    const elapsed = Math.max(0, now - bucket.updatedAtMs)
    const tokens = Math.min(this.#capacity, bucket.tokens + elapsed * this.#refillPerMs)

    if (tokens < 1) {
      this.#buckets.set(key, { tokens, updatedAtMs: now })
      const deficit = 1 - tokens
      const retryAfterMs =
        this.#refillPerMs === 0 ? Number.POSITIVE_INFINITY : Math.ceil(deficit / this.#refillPerMs)
      return { ok: false, retryAfterMs }
    }

    this.#buckets.set(key, { tokens: tokens - 1, updatedAtMs: now })
    this.#pruneIfNeeded(now)
    return { ok: true, remaining: Math.floor(tokens - 1) }
  }

  /** 清空某个键的计数。认证成功后调用，避免"正常用户被自己的历史失败拖累"。 */
  reset(key: string): void {
    this.#buckets.delete(key)
  }

  get size(): number {
    return this.#buckets.size
  }

  #pruneIfNeeded(now: number): void {
    if (this.#buckets.size <= MAX_TRACKED_KEYS) return
    // 只删"已经回满"的桶——它们的限流状态等价于不存在，删掉不改变任何判定。
    // 第一遍删"已经回满"的桶——它们的限流状态等价于不存在，删掉不改变任何判定。
    for (const [key, bucket] of this.#buckets) {
      const elapsed = Math.max(0, now - bucket.updatedAtMs)
      if (bucket.tokens + elapsed * this.#refillPerMs >= this.#capacity) this.#buckets.delete(key)
      if (this.#buckets.size <= MAX_TRACKED_KEYS / 2) return
    }

    // 第二遍按最久未活动逐个淘汰。
    //
    // 这把"内存有界"变成了硬保证。代价是：被淘汰的键会重新拿到满桶，
    // 也就是对这些键的限流短暂失效。这是**有意的取舍**——能触发它的前提是
    // 一次性访问数千个不同键（伪造源地址或大规模扫描），而那种情况下
    // "限流稍微松一点"远好过"进程被自己的桶表撑爆"。
    const byAge = [...this.#buckets.entries()].sort(
      (left, right) => left[1].updatedAtMs - right[1].updatedAtMs,
    )
    for (const [key] of byAge) {
      this.#buckets.delete(key)
      if (this.#buckets.size <= MAX_TRACKED_KEYS / 2) return
    }
  }
}

/** 连接数占用凭据。 */
export interface ConnectionLease {
  release(): void
}

export type ConnectionDecision =
  | { readonly ok: true; readonly lease: ConnectionLease }
  | { readonly ok: false; readonly code: 'total' | 'per-principal'; readonly reason: string }

export interface ConnectionLimiterOptions {
  readonly total: number
  readonly perPrincipal: number
}

/**
 * WebSocket 连接数限制。
 *
 * 超限时的处理是**先完成升级再用 1013 关闭**，而不是在握手阶段拒绝：
 * 浏览器对握手失败的 `WebSocket` 只暴露一个无信息的 `error` 事件，
 * 客户端无从区分"服务器没起来"和"连接数满了"。1013（Try Again Later）
 * 至少是可判定的，客户端可以退避后重试。
 */
export class ConnectionLimiter {
  readonly #total: number
  readonly #perPrincipal: number
  #count = 0
  readonly #byPrincipal = new Map<string, number>()

  constructor(options: ConnectionLimiterOptions) {
    this.#total = Math.max(0, Math.floor(options.total))
    this.#perPrincipal = Math.max(0, Math.floor(options.perPrincipal))
  }

  acquire(principalId: string): ConnectionDecision {
    if (this.#count >= this.#total)
      return {
        ok: false,
        code: 'total',
        reason: `WebSocket 连接总数已达上限（${String(this.#total)}）`,
      }

    const current = this.#byPrincipal.get(principalId) ?? 0
    if (current >= this.#perPrincipal)
      return {
        ok: false,
        code: 'per-principal',
        reason: `该主体的 WebSocket 连接数已达上限（${String(this.#perPrincipal)}）`,
      }

    this.#count += 1
    this.#byPrincipal.set(principalId, current + 1)

    let released = false
    return {
      ok: true,
      lease: {
        release: (): void => {
          // 幂等：close 与 error 可能都触发释放，重复递减会让计数变成负数，
          // 于是"上限"形同虚设。
          if (released) return
          released = true
          this.#count = Math.max(0, this.#count - 1)
          const next = (this.#byPrincipal.get(principalId) ?? 1) - 1
          if (next <= 0) this.#byPrincipal.delete(principalId)
          else this.#byPrincipal.set(principalId, next)
        },
      },
    }
  }

  get total(): number {
    return this.#count
  }

  countFor(principalId: string): number {
    return this.#byPrincipal.get(principalId) ?? 0
  }
}

/**
 * 客户端标识：限流的键。
 *
 * 只用 `socket.remoteAddress`，**不看 `X-Forwarded-For`**——那个头是客户端
 * 可伪造的，用它做限流键等于让攻击者自己决定用哪个桶。
 * 反向代理部署时应当在代理层限流。
 */
export function clientKey(remoteAddress: string | undefined): string {
  return remoteAddress === undefined || remoteAddress === '' ? 'unknown' : remoteAddress
}
