/**
 * 时间：时间戳格式、时钟注入与耗时测量。
 *
 * 兼容性契约：旧项目把时间戳写成 **ISO 8601、UTC、带毫秒、带 `Z` 后缀**的字符串
 * （例如 `2025-09-14T02:39:11.123456+00:00` 归一化后的形式）。
 * 新实现必须写同一种格式，否则旧数据与新数据混在一起时无法排序比较。
 *
 * 设计要点：**时间读取必须可注入**。可恢复性测试需要构造"跨越压缩边界"、
 * "权限请求超时"这类场景，依赖真实时钟会让测试既慢又不稳定。
 */

/**
 * ISO 8601 UTC 时间戳字符串，形如 `2026-09-14T02:39:11.123Z`。
 *
 * 这是落盘与跨进程传输时的**唯一**时间表示。不要用 epoch 数值落盘——
 * 旧项目的 JSON 里存的是字符串，改格式会破坏兼容性。
 */
export type IsoTimestamp = string

/** 毫秒时长。 */
export type Millis = number

/**
 * 时钟抽象。
 *
 * 所有需要"当前时间"或"测量耗时"的代码都通过它获取，不直接调用 `Date.now()`
 * 或 `performance.now()`。这样测试可以注入假时钟。
 */
export interface Clock {
  /** 当前时刻，ISO 8601 UTC 字符串。 */
  now(): IsoTimestamp
  /** 当前时刻的 epoch 毫秒。用于计算与持久化无关的时长。 */
  nowMs(): Millis
}

/**
 * 使用系统时钟的默认实现。
 *
 * `Date.prototype.toISOString()` 的输出恒为 `YYYY-MM-DDTHH:mm:ss.sssZ`
 * （UTC，固定 3 位毫秒，带 `Z`），这正是我们要的规范形式。
 */
export const systemClock: Clock = {
  now(): IsoTimestamp {
    return new Date().toISOString()
  },
  nowMs(): Millis {
    return Date.now()
  },
}

/** 可手动推进的时钟，仅用于测试。 */
export interface FakeClock extends Clock {
  /** 按给定毫秒数推进时钟。 */
  advance(ms: Millis): void
  /** 直接设定当前 epoch 毫秒。 */
  set(epochMs: number): void
}

/** 构造一个起始于 `startMs`（默认 0）的假时钟。 */
export function createFakeClock(startMs = 0): FakeClock {
  let current = startMs

  return {
    now(): IsoTimestamp {
      return new Date(current).toISOString()
    },
    nowMs(): Millis {
      return current
    },
    advance(ms: Millis): void {
      current += ms
    },
    set(epochMs: number): void {
      current = epochMs
    },
  }
}

// ── 格式化与解析 ──────────────────────────────────────────────────

/**
 * 把 epoch 毫秒格式化为落盘用的时间戳。
 *
 * 拒绝 `NaN` / 非有限值——把 `Invalid Date` 写进磁盘会污染整份 transcript，
 * 且后续排序比较全部失效。这类错误必须在写入前暴露，而不是静默落盘。
 */
export function formatTimestamp(epochMs: number): IsoTimestamp {
  if (!Number.isFinite(epochMs)) {
    throw new RangeError(`formatTimestamp 收到非有限值: ${epochMs}`)
  }
  return new Date(epochMs).toISOString()
}

/**
 * 解析时间戳为 epoch 毫秒。无法解析时返回 `undefined`。
 *
 * 读取侧必须容错（REWRITE_SPEC §3.2）：旧数据可能缺字段、可能被手工编辑过。
 * 返回 `undefined` 而非抛错，让调用方决定是跳过该条还是回退到默认值。
 */
export function parseTimestamp(value: string): number | undefined {
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? undefined : ms
}

/**
 * 判断字符串是否为可解析的时间戳。
 *
 * 用于 schema 校验阶段的宽松检查。注意它接受任何 `Date.parse` 认得的形式
 * （包括不带时区的本地时间串），因为旧数据里可能存在历史遗留格式——
 * 严格校验会让那些数据读不出来。
 */
export function isTimestamp(value: unknown): value is IsoTimestamp {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
}

// ── 耗时测量 ──────────────────────────────────────────────────────

/**
 * 一次性耗时测量器。
 *
 * 用于 `result.meta.elapsed_ms`、工具超时与指标上报。基于注入的时钟，
 * 因此测试里可以精确断言"这次调用恰好耗时 250ms"。
 */
export interface Stopwatch {
  /** 从开始到现在的毫秒数。可重复调用，每次返回不同的值（时间在流逝）。 */
  elapsedMs(): Millis
}

/** 基于给定时钟启动一个计时器。 */
export function startStopwatch(clock: Clock): Stopwatch {
  const startedAt = clock.nowMs()
  return {
    elapsedMs(): Millis {
      return clock.nowMs() - startedAt
    },
  }
}
