/**
 * 审批 broker：把 `ApprovalService`（内核侧）与"多个 UI 同时在线"（表现层）接起来。
 *
 * ## 为什么审批事件必须由这里发出，而不是 runtime
 *
 * `AgentRuntime` 只在 `result.error_code === PERMISSION_REQUIRED` 时发
 * `permission_required` 事件，而 `ToolExecutor` **只在没有 `approvalService` 时**
 * 才返回那个错误码。也就是说：UI 一接上真实的审批服务，这条事件就永远不再出现——
 * UI 会退化成只能靠 `ToolExecutorOptions.onEvent` 这条旁路拿到待审批信息，
 * 而那条旁路既违反"UI 只消费事件流"，Web 端的第二个连接也收不到。
 *
 * 所以事件改由 broker 发出：它天然知道 `request_id`，天然对所有订阅者广播，
 * 而且事件经 `EventBus` 落进 `EventLog` 之后，**重连补发会自动覆盖审批项**
 * （`parts/09` §1.1 明确要求不依赖内存队列）。
 *
 * ## broker 不写存储
 *
 * 权限请求的创建与决议落盘**继续由 `ToolExecutor` 独占**：只有它同时知道
 * "最终决议"与"工具执行结果"，它写出来的 `permission_resolutions` 才是完整记录。
 * broker 若也写一遍，executor 的第二次 `resolvePermission` 会因为 JSON 不完全
 * 相等而抛 `INVALID_STATE_TRANSITION`。于是 broker 是**纯协调 + 事件**对象。
 */

import { AgentError, ErrorCode } from '../core/errors.js'
import type {
  GrantScope,
  PermissionAction,
  PermissionRequest,
  PermissionResolution,
  ApprovalService,
} from '../core/tool.js'
import type { PrincipalId } from '../core/ids.js'
import type { Clock } from '../core/time.js'
import type { EventPublisher } from './event-bus.js'
import type { AppPolicy } from './policy.js'

/** 待审批项的对外视图（给 UI 渲染用，不含内部字段）。 */
export interface PendingApprovalView {
  readonly requestId: string
  readonly sessionId: string
  readonly turnId: string
  readonly toolName: string
  readonly toolCallId: string
  readonly argsPreview: string
  /** 仅在待审批内存队列中保存，供授权后的 Web 待办接口展示。 */
  readonly commandPreview?: string
  readonly riskLevel: string
  readonly reason: string
  readonly createdAt: string
  readonly expiresAt: number
  /** 是否属于"高风险二次确认"的第二次请求。 */
  readonly secondConfirmation: boolean
}

export interface ApprovalResolutionInput {
  readonly requestId: string
  readonly decision: PermissionAction
  /** 提交决议的 principal。必须对该会话有权限。 */
  readonly principalId: PrincipalId
  readonly resolvedBy?: 'user' | 'system'
  readonly grantScope?: GrantScope
  readonly reason?: string
}

export type ApprovalResolutionResult =
  | { readonly ok: true; readonly resolution: PermissionResolution; readonly duplicate: boolean }
  | { readonly ok: false; readonly code: ErrorCode; readonly message: string }

interface PendingApproval {
  readonly request: PermissionRequest
  readonly commandPreview?: string
  /** 在 `request()` 里挂起、等待决议的调用方。 */
  readonly waiters: Array<(resolution: PermissionResolution) => void>
  readonly timer: ReturnType<typeof setTimeout>
}

/** 二次确认请求的 reason 后缀由 executor 追加，见 `ToolExecutor`。 */
const SECOND_CONFIRMATION_SUFFIX = ' (second confirmation)'

export class ApprovalBroker implements ApprovalService {
  readonly #publisher: EventPublisher
  readonly #policy: AppPolicy
  readonly #clock: Clock
  /** 已解决的决议，用于幂等回放。 */
  readonly #resolved = new Map<string, PermissionResolution>()
  readonly #pending = new Map<string, PendingApproval>()
  readonly #authorize:
    ((principalId: PrincipalId, request: PermissionRequest) => boolean) | undefined

  constructor(options: {
    readonly publisher: EventPublisher
    readonly policy: AppPolicy
    readonly clock: Clock
    readonly authorize?: (principalId: PrincipalId, request: PermissionRequest) => boolean
  }) {
    this.#publisher = options.publisher
    this.#policy = options.policy
    this.#clock = options.clock
    this.#authorize = options.authorize
  }

  /**
   * 内核侧入口。**幂等、永不挂起、永不抛**。
   *
   * 这三条不是修饰语：`ToolExecutor` 用 `withTimeout` 包住它并把任何抛出
   * 都当作拒绝处理，所以"卡住不返回"会直接变成"每次审批都要等满 120 秒"。
   */
  async request(
    request: PermissionRequest,
    signal: AbortSignal,
    presentation?: { readonly commandPreview?: string },
  ): Promise<PermissionResolution> {
    const key = request.request_id

    // 1. 已解决 —— 幂等回放，**不重发事件**（重连、重试、恢复都会走到这里）
    const settled = this.#resolved.get(key)
    if (settled) return settled

    // 2. 已经挂起 ——（比如二次确认与首次确认撞上）挂个 waiter，不重发事件
    const existing = this.#pending.get(key)
    if (existing) return this.#wait(existing, signal)

    // 3. 队列满 —— 立即拒绝，而不是无限排队
    if (this.#pending.size >= this.#policy.approvalQueueLimit) {
      const denied = this.#deny(key, '审批队列已满，自动拒绝')
      void this.#publishResolved(request, denied)
      return denied
    }

    // 4. 新建待审批项
    const deadline = Math.min(
      request.expires_at,
      this.#clock.nowMs() + this.#policy.approvalTimeoutMs,
    )
    const delay = Math.max(0, deadline - this.#clock.nowMs())
    const entry: PendingApproval = {
      request,
      ...(presentation?.commandPreview === undefined
        ? {}
        : { commandPreview: presentation.commandPreview }),
      waiters: [],
      timer: setTimeout(() => {
        // 超时按 deny 处理（parts/09 §5）。resolvedBy 为 system，
        // 与"用户主动拒绝"在下游可区分。
        const denied = this.#deny(key, '审批等待超时')
        this.#settle(key, denied)
        void this.#publishResolved(request, denied)
      }, delay),
    }
    entry.timer.unref?.()
    this.#pending.set(key, entry)

    // ️ 顺序至关重要：**先挂 waiter，再广播事件**。
    //
    // UI 的典型做法就是"在 permission_required 的回调里直接提交决议"
    // （见 tests/app/approval-broker.test.ts 的 AutoApprover）。若先广播，
    // 决议可能在 `#settle` 时发现 `waiters` 还是空的——请求被记为已解决、
    // 从队列里摘掉，却没有任何人收到通知，于是 turn 一直挂到 120 秒超时。
    // 这是"点了批准但什么也没发生"的成因。
    const waiting = this.#wait(entry, signal)

    // 若信号在创建时就已取消，`#wait` 已经走完收尾（摘队列 + 归档 + 广播
    // `permission_resolved`）。此时**不发** `permission_required`：
    // UI 不该为一个已经结束的请求弹审批框；而且 `#wait` 是同步执行的，
    // 那样会让事件顺序变成 resolved → required，前端拿到一个"未见过就已解决"
    // 的 request_id。
    if (!signal.aborted)
      await this.#publisher.publish({
        sessionId: request.session_id,
        turnId: request.turn_id,
        type: 'permission_required',
        data: {
          request_id: request.request_id,
          tool_name: request.tool_name,
          tool_call_id: request.tool_call_id,
          // args_preview 由 executor 生成，**已经过脱敏**（storage/audit.ts）。
          args_preview: request.args_preview,
          risk_level: request.risk_level,
          reason: request.reason,
          expires_at: request.expires_at,
        },
      })

    return waiting
  }

  /**
   * UI 侧入口：提交决议。
   *
   * **先到先得**：第一个生效，其余连接收到 `permission_resolved` 事件后
   * 自行收起对话框。同一 `request_id` 重复提交返回首次结果
   * （`duplicate: true`），而不是抛错——浏览器重发是正常路径。
   */
  async resolve(input: ApprovalResolutionInput): Promise<ApprovalResolutionResult> {
    const settled = this.#resolved.get(input.requestId)
    if (settled) return { ok: true, resolution: settled, duplicate: true }

    const entry = this.#pending.get(input.requestId)
    if (!entry) {
      // 可能已超时/已取消，也可能根本不存在。两种情况对调用方都是"这个请求不在等你"。
      const past = this.#resolved.get(input.requestId)
      if (past) return { ok: true, resolution: past, duplicate: true }
      return {
        ok: false,
        code: ErrorCode.SESSION_NOT_FOUND,
        message: '该审批请求不存在或已结束',
      }
    }

    // 授权：不能只凭 URL 里的 requestId 就允许提交决议。
    if (this.#authorize && !this.#authorize(input.principalId, entry.request)) {
      // 返回 PERMISSION_DENIED 而不是"不存在"——调用方已经证明它知道这个 id
      return {
        ok: false,
        code: ErrorCode.PERMISSION_DENIED,
        message: '无权解决该会话的审批请求',
      }
    }

    const resolution: PermissionResolution = {
      requestId: input.requestId,
      decision: input.decision,
      resolvedBy: input.resolvedBy ?? 'user',
      ...(input.grantScope === undefined ? {} : { grantScope: input.grantScope }),
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    }
    this.#settle(input.requestId, resolution)
    await this.#publishResolved(entry.request, resolution)
    return { ok: true, resolution, duplicate: false }
  }

  /** 当前待审批项，供 UI 拉全量（例如刚连上、错过了事件）。 */
  listPending(sessionId?: string): readonly PendingApprovalView[] {
    const values = [...this.#pending.values()]
      .filter((e) => sessionId === undefined || e.request.session_id === sessionId)
      .map((e) => this.#view(e))
    return values
  }

  /** 取消某会话的全部待审批项（turn 被取消 / 服务关闭）。 */
  cancelSession(sessionId: string, reason: string): number {
    let count = 0
    for (const [key, entry] of [...this.#pending.entries()]) {
      if (entry.request.session_id !== sessionId) continue
      const denied = this.#deny(key, reason)
      this.#settle(key, denied)
      void this.#publishResolved(entry.request, denied)
      count++
    }
    return count
  }

  /** 取消全部待审批项。 */
  cancelAll(reason: string): number {
    let count = 0
    for (const [key, entry] of [...this.#pending.entries()]) {
      const denied = this.#deny(key, reason)
      this.#settle(key, denied)
      void this.#publishResolved(entry.request, denied)
      count++
    }
    return count
  }

  /** 等待决议，并与取消竞速。 */
  #wait(entry: PendingApproval, signal: AbortSignal): Promise<PermissionResolution> {
    return new Promise<PermissionResolution>((resolve) => {
      const key = entry.request.request_id

      // 兜底：调用 `#wait` 之前若该请求已经落定（决议、超时或取消先到），
      // 立刻返回存档结果。没有这一条，任何"先解决、后挂 waiter"的时序
      // 都会变成永久等待。
      const settled = this.#resolved.get(key)
      if (settled) {
        resolve(settled)
        return
      }

      const onAbort = (): void => {
        // 取消同样按 deny 处理，并且要把该项从队列里摘掉——
        // 否则它会一直挂到超时，占用队列名额。
        const denied = this.#deny(key, '审批等待被取消')
        this.#settle(key, denied)
        void this.#publishResolved(entry.request, denied)
      }

      if (signal.aborted) {
        // 已取消：走**与 `onAbort` 完全相同**的收尾——摘队列、存档决议、广播。
        // 早先这里只 resolve 一个 deny，既不 `#settle` 也不广播，于是：
        // 1) 该项仍留在 `#pending` 占着 `approvalQueueLimit` 的名额，
        //    最终会把真实审批挤成"队列已满"而拒绝；
        // 2) UI 可能为一个已经取消的请求弹出审批框；
        // 3) 它的定时器到点后还会**补发**一条 `permission_resolved`。
        // 同一条语义不该有两份实现，所以直接复用 `onAbort`，不另写一份。
        onAbort()
        resolve(this.#resolved.get(key) ?? this.#deny(key, '审批等待被取消'))
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })

      entry.waiters.push((resolution) => {
        signal.removeEventListener('abort', onAbort)
        resolve(resolution)
      })
    })
  }

  #deny(requestId: string, reason: string): PermissionResolution {
    return {
      requestId,
      decision: 'deny',
      resolvedBy: 'system',
      reason,
    }
  }

  #settle(requestId: string, resolution: PermissionResolution): void {
    const entry = this.#pending.get(requestId)
    if (entry) {
      clearTimeout(entry.timer)
      this.#pending.delete(requestId)
    }
    if (!this.#resolved.has(requestId)) this.#resolved.set(requestId, resolution)
    const waiters = entry?.waiters ?? []
    for (const waiter of waiters) waiter(this.#resolved.get(requestId) ?? resolution)
  }

  async #publishResolved(
    request: PermissionRequest,
    resolution: PermissionResolution,
  ): Promise<void> {
    await this.#publisher
      .publish({
        sessionId: request.session_id,
        turnId: request.turn_id,
        type: 'permission_resolved',
        data: {
          request_id: request.request_id,
          decision: resolution.decision,
          resolved_by: resolution.resolvedBy,
          reason: resolution.reason ?? null,
        },
      })
      .catch(() => undefined)
  }

  #view(entry: PendingApproval): PendingApprovalView {
    const request = entry.request
    return {
      requestId: request.request_id,
      sessionId: request.session_id,
      turnId: request.turn_id,
      toolName: request.tool_name,
      toolCallId: request.tool_call_id,
      argsPreview: request.args_preview,
      ...(entry.commandPreview === undefined ? {} : { commandPreview: entry.commandPreview }),
      riskLevel: request.risk_level,
      reason: request.reason,
      createdAt: request.created_at,
      expiresAt: request.expires_at,
      secondConfirmation: request.reason.endsWith(SECOND_CONFIRMATION_SUFFIX),
    }
  }
}

/** 供 UI 复用的启动错误包装。 */
export function approvalError(error: unknown): AgentError {
  return AgentError.is(error)
    ? error
    : new AgentError({ code: ErrorCode.INTERNAL_ERROR, message: String(error), source: 'approval' })
}
