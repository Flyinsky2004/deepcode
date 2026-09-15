/**
 * 应用层阈值。
 *
 * `parts/09` §3 与 `CLAUDE.md` 都要求「超时、截断长度、重试次数、token 预算等
 * **不得硬编码在局部**」。Phase 7 引入了大量这类数字（监听上限、速率限制、
 * 优雅关闭宽限期……），全部收在这里，并且可以通过
 * `config.json` 的 `app_settings['policy.<key>']` 逐项覆盖。
 *
 * 覆盖值是字符串（`app_settings` 的类型如此），因此每一项都要单独解析与校验——
 * **解析失败就报错，不要静默退回默认值**，否则用户改错一个键会得到
 * "配置看起来生效了但其实没有"的行为。
 */

import { AgentError, ErrorCode } from '../core/errors.js'
import type { ConfigDocument } from '../storage/types.js'

export interface AppPolicy {
  // ── 审批 ───────────────────────────────────────────────────────
  /** 审批等待上限。超时按 deny 处理（`parts/09` §5）。 */
  readonly approvalTimeoutMs: number
  /** 同时挂起的审批请求上限。超出直接拒绝，不排队到无限。 */
  readonly approvalQueueLimit: number
  /**
   * `always_approve`（记住授权）的有效期。
   *
   * 单独一项而不是借用 `idempotencyTtlMs`：两者的语义无关（一个是"记住别再问
   * 我"，一个是"重复请求回放结果"），借用会让任何一方调整时意外改变另一方。
   * `GrantScope` 也要求明确过期时间（parts/09 §5），含糊不得。
   */
  readonly grantTtlMs: number
  // ── 用户提问 ────────────────────────────────────────────────────
  /** `ask_user_question` 的等待上限。超时回灌 `{"_timeout": true}` 并继续跑。 */
  readonly userInputTimeoutMs: number
  readonly userInputQueueLimit: number
  // ── 工具 ────────────────────────────────────────────────────────
  readonly toolTimeoutMs: number
  readonly toolOutputLimitChars: number
  // ── turn ────────────────────────────────────────────────────────
  /** 取消一个 turn 后，等待它真正结束的上限。 */
  readonly turnCancelGraceMs: number
  // ── 事件流 ──────────────────────────────────────────────────────
  /** 单个订阅者的出站队列上限。溢出即断开该订阅者（事件不丢，重连补发）。 */
  readonly eventSubscriberQueueLimit: number
  // ── HTTP ───────────────────────────────────────────────────────
  readonly httpBodyLimitBytes: number
  readonly httpRequestsPerMinute: number
  readonly httpBurst: number
  readonly authFailuresPerMinute: number
  // ─ WebSocket ───────────────────────────────────────────────────
  readonly wsMessageLimitBytes: number
  readonly wsConnectionsTotal: number
  readonly wsConnectionsPerPrincipal: number
  readonly wsIdleTimeoutMs: number
  readonly wsPingIntervalMs: number
  // ── 幂等 ────────────────────────────────────────────────────────
  readonly idempotencyTtlMs: number
  // ─ 生命周期 ────────────────────────────────────────────────────
  readonly shutdownGraceMs: number
  readonly shutdownPersistMs: number
  // ── 会话 ────────────────────────────────────────────────────────
  readonly sessionListLimit: number
}

/**
 * 默认阈值。
 *
 * 速率限制一项 `parts/09` §1.1 **只要求存在、未给数值**，这里取保守值：
 * 单机自用的 Web UI 远达不到 120 req/min，而一旦被恶意脚本打满也能兜住。
 */
export const DEFAULT_APP_POLICY: AppPolicy = {
  approvalTimeoutMs: 120_000,
  approvalQueueLimit: 16,
  // 一次授权默认记住一天。与审批超时（120 秒）无关——那个是"这次等你多久"，
  // 这个是"记住多久别再问"。
  grantTtlMs: 86_400_000,

  userInputTimeoutMs: 120_000,
  userInputQueueLimit: 8,

  toolTimeoutMs: 120_000,
  toolOutputLimitChars: 64_000,

  turnCancelGraceMs: 10_000,

  eventSubscriberQueueLimit: 1_000,

  httpBodyLimitBytes: 1_048_576,
  httpRequestsPerMinute: 120,
  httpBurst: 30,
  authFailuresPerMinute: 10,

  wsMessageLimitBytes: 1_048_576,
  wsConnectionsTotal: 64,
  wsConnectionsPerPrincipal: 8,
  wsIdleTimeoutMs: 120_000,
  wsPingIntervalMs: 30_000,

  idempotencyTtlMs: 86_400_000,

  shutdownGraceMs: 15_000,
  shutdownPersistMs: 5_000,

  sessionListLimit: 200,
}

/** `policy.<key>` → 对应的 `AppPolicy` 字段。键名用 snake_case，与 `app_settings` 风格一致。 */
const POLICY_KEYS: Readonly<Record<string, keyof AppPolicy>> = {
  approval_timeout_ms: 'approvalTimeoutMs',
  approval_queue_limit: 'approvalQueueLimit',
  grant_ttl_ms: 'grantTtlMs',
  user_input_timeout_ms: 'userInputTimeoutMs',
  user_input_queue_limit: 'userInputQueueLimit',
  tool_timeout_ms: 'toolTimeoutMs',
  tool_output_limit_chars: 'toolOutputLimitChars',
  turn_cancel_grace_ms: 'turnCancelGraceMs',
  event_subscriber_queue_limit: 'eventSubscriberQueueLimit',
  http_body_limit_bytes: 'httpBodyLimitBytes',
  http_requests_per_minute: 'httpRequestsPerMinute',
  http_burst: 'httpBurst',
  auth_failures_per_minute: 'authFailuresPerMinute',
  ws_message_limit_bytes: 'wsMessageLimitBytes',
  ws_connections_total: 'wsConnectionsTotal',
  ws_connections_per_principal: 'wsConnectionsPerPrincipal',
  ws_idle_timeout_ms: 'wsIdleTimeoutMs',
  ws_ping_interval_ms: 'wsPingIntervalMs',
  idempotency_ttl_ms: 'idempotencyTtlMs',
  shutdown_grace_ms: 'shutdownGraceMs',
  shutdown_persist_ms: 'shutdownPersistMs',
  session_list_limit: 'sessionListLimit',
}

/** 已知的 `policy.*` 设置项，供 UI 与文档枚举。 */
export const POLICY_SETTING_KEYS: readonly string[] = Object.keys(POLICY_KEYS).sort()

export function loadAppPolicy(config?: ConfigDocument): AppPolicy {
  const settings = config?.app_settings ?? {}
  const overrides: Partial<Record<keyof AppPolicy, number>> = {}

  for (const [rawKey, rawValue] of Object.entries(settings)) {
    if (!rawKey.startsWith('policy.')) continue
    const field = POLICY_KEYS[rawKey.slice('policy.'.length)]
    // 未知的 policy.* 键直接报错，而不是忽略：多半是拼错了键名，
    // 静默忽略会让用户以为设置已生效。
    if (!field)
      throw new AgentError({
        code: ErrorCode.VALIDATION_FAILED,
        message: `未知的策略设置项：${rawKey}`,
        source: 'app.policy',
        context: { known: POLICY_SETTING_KEYS },
      })

    const parsed = Number(rawValue)
    if (!Number.isFinite(parsed) || parsed < 0)
      throw new AgentError({
        code: ErrorCode.VALIDATION_FAILED,
        message: `${rawKey} 必须是非负数字`,
        source: 'app.policy',
        context: { value: rawValue },
      })
    overrides[field] = parsed
  }

  return { ...DEFAULT_APP_POLICY, ...overrides }
}
