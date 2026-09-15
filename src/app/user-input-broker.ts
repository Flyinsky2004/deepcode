/**
 * 提问 broker：`ask_user_question` 的 UI 侧通道。
 *
 * 结构与 `ApprovalBroker` **刻意保持一致**（幂等、永不挂起、先到先得、
 * 由 broker 发事件、不写存储），因为两者的调用方——`ToolExecutor`——
 * 用的是同一套超时包装与同一套"UI 不在就按最坏情况兜底"的处理。
 *
 * ## 与权限审批唯一的实质差别：超时不是拒绝
 *
 * 权限超时按 **deny**（`parts/09` §5），提问超时则回灌 `{"_timeout": true}`
 * 并**让 turn 继续跑**。所以这里超时产出的是 `answers: null`，而不是某种
 * 拒绝语义。把这条差别抹平会让模型在拿不到答案时直接失败，而不是自己
 * 想办法继续——那是行为不等价。
 */

import { AgentError, ErrorCode } from '../core/errors.js'
import type {
  AskUserQuestion,
  PersistedUserInputRequest,
  UserInputResolution,
  UserInputService,
  UserInputRequest,
} from '../core/input.js'
import type { PrincipalId } from '../core/ids.js'
import type { Clock } from '../core/time.js'
import type { EventPublisher } from './event-bus.js'
import type { AppPolicy } from './policy.js'

/** 待人回答的提问（给 UI 渲染用）。 */
export interface PendingUserInputView {
  readonly requestId: string
  readonly sessionId: string
  readonly turnId: string
  readonly toolName: string
  readonly questions: readonly AskUserQuestion[]
  readonly createdAt: string
  readonly expiresAt: number
}

export interface UserInputAnswerInput {
  readonly requestId: string
  readonly principalId: PrincipalId
  /** 按 `questions` 下标对齐；`null` 表示用户放弃作答（等同超时）。 */
  readonly answers: readonly (readonly string[])[] | null
  readonly reason?: string
}

export type UserInputAnswerResult =
  | { readonly ok: true; readonly resolution: UserInputResolution; readonly duplicate: boolean }
  | { readonly ok: false; readonly code: ErrorCode; readonly message: string }

interface PendingQuestion {
  readonly request: UserInputRequest
  readonly waiters: Array<(resolution: UserInputResolution) => void>
  readonly timer: ReturnType<typeof setTimeout>
}

export class UserInputBroker implements UserInputService {
  readonly #publisher: EventPublisher
  readonly #policy: AppPolicy
  readonly #clock: Clock
  readonly #resolved = new Map<string, UserInputResolution>()
  readonly #pending = new Map<string, PendingQuestion>()
  readonly #authorize:
    ((principalId: PrincipalId, request: UserInputRequest) => boolean) | undefined

  constructor(options: {
    readonly publisher: EventPublisher
    readonly policy: AppPolicy
    readonly clock: Clock
    readonly authorize?: (principalId: PrincipalId, request: UserInputRequest) => boolean
  }) {
    this.#publisher = options.publisher
    this.#policy = options.policy
    this.#clock = options.clock
    this.#authorize = options.authorize
  }

  /** 内核侧入口（`UserInputService`）。幂等、永不挂起。 */
  async request(request: UserInputRequest, signal: AbortSignal): Promise<UserInputResolution> {
    const key = request.request_id

    const settled = this.#resolved.get(key)
    if (settled) return settled

    const existing = this.#pending.get(key)
    if (existing) return this.#wait(existing, signal)

    if (this.#pending.size >= this.#policy.userInputQueueLimit) {
      const unanswered = this.#noAnswer(key, '提问队列已满')
      void this.#publishResolved(request, unanswered)
      return unanswered
    }

    // 空问题列表：旧实现直接回 `{"_empty": true}`，不打扰用户。
    if (request.questions.length === 0) {
      const empty: UserInputResolution = {
        requestId: request.request_id,
        answers: [],
        resolvedBy: 'user',
      }
      this.#resolved.set(key, empty)
      return empty
    }

    const deadline = Math.min(
      request.expires_at,
      this.#clock.nowMs() + this.#policy.userInputTimeoutMs,
    )
    const delay = Math.max(0, deadline - this.#clock.nowMs())
    const entry: PendingQuestion = {
      request,
      waiters: [],
      timer: setTimeout(() => {
        // 超时**不终止 turn**：交回"没有答案"，由 executor 回灌
        // `{"_timeout": true}` 让模型自己继续。
        const unanswered = this.#noAnswer(key, '提问等待超时')
        this.#settle(key, unanswered)
        void this.#publishResolved(request, unanswered)
      }, delay),
    }
    entry.timer.unref?.()
    this.#pending.set(key, entry)

    // 与审批 broker 同样的顺序要求：**先挂 waiter，再广播**。
    // UI 的典型做法就是在事件回调里直接作答，先广播会让这次作答
    // 落在还没有 waiter 的请求上，形成永久等待。
    const waiting = this.#wait(entry, signal)

    // 与审批 broker 同理：信号在创建时就已取消的情况下，`#wait` 已经走完收尾
    // 并广播了 `user_input_resolved`，此时不再发 `user_input_required`
    // （否则 UI 会收到一个"未见过就已解决"的 request_id，且顺序倒置）。
    if (!signal.aborted)
      await this.#publisher.publish({
        sessionId: request.session_id,
        turnId: request.turn_id,
        type: 'user_input_required',
        data: {
          request_id: request.request_id,
          tool_name: request.tool_name,
          tool_call_id: request.tool_call_id,
          questions: request.questions,
          expires_at: request.expires_at,
        },
      })

    return waiting
  }

  /** UI 侧入口：提交作答。**先到先得**，重复提交回放首次结果。 */
  async answer(input: UserInputAnswerInput): Promise<UserInputAnswerResult> {
    const settled = this.#resolved.get(input.requestId)
    if (settled) return { ok: true, resolution: settled, duplicate: true }

    const entry = this.#pending.get(input.requestId)
    if (!entry)
      return {
        ok: false,
        code: ErrorCode.SESSION_NOT_FOUND,
        message: '该提问不存在或已结束',
      }

    if (this.#authorize && !this.#authorize(input.principalId, entry.request))
      return {
        ok: false,
        code: ErrorCode.PERMISSION_DENIED,
        message: '无权回答该会话的提问',
      }

    const resolution: UserInputResolution = {
      requestId: input.requestId,
      answers: input.answers,
      resolvedBy: 'user',
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    }
    this.#settle(input.requestId, resolution)
    await this.#publishResolved(entry.request, resolution)
    return { ok: true, resolution, duplicate: false }
  }

  listPending(sessionId?: string): readonly PendingUserInputView[] {
    return [...this.#pending.values()]
      .filter((e) => sessionId === undefined || e.request.session_id === sessionId)
      .map((e) => ({
        requestId: e.request.request_id,
        sessionId: e.request.session_id,
        turnId: e.request.turn_id,
        toolName: e.request.tool_name,
        questions: e.request.questions,
        createdAt: e.request.created_at,
        expiresAt: e.request.expires_at,
      }))
  }

  cancelSession(sessionId: string, reason: string): number {
    let count = 0
    for (const [key, entry] of [...this.#pending.entries()]) {
      if (entry.request.session_id !== sessionId) continue
      const unanswered = this.#noAnswer(key, reason)
      this.#settle(key, unanswered)
      void this.#publishResolved(entry.request, unanswered)
      count++
    }
    return count
  }

  cancelAll(reason: string): number {
    let count = 0
    for (const [key, entry] of [...this.#pending.entries()]) {
      const unanswered = this.#noAnswer(key, reason)
      this.#settle(key, unanswered)
      void this.#publishResolved(entry.request, unanswered)
      count++
    }
    return count
  }

  #wait(entry: PendingQuestion, signal: AbortSignal): Promise<UserInputResolution> {
    return new Promise<UserInputResolution>((resolve) => {
      const key = entry.request.request_id

      const settled = this.#resolved.get(key)
      if (settled) {
        resolve(settled)
        return
      }

      const onAbort = (): void => {
        const unanswered = this.#noAnswer(key, '提问等待被取消')
        this.#settle(key, unanswered)
        void this.#publishResolved(entry.request, unanswered)
      }

      if (signal.aborted) {
        // 已取消：与 `onAbort` 走**完全相同**的收尾（摘队列 + 存档 + 广播）。
        // 早先只 resolve 一个"无答案"，既不 `#settle` 也不广播，于是该项仍占着
        // `userInputQueueLimit` 名额，且定时器到点会补发一条 `user_input_resolved`。
        // 与审批 broker 是同一处笔误，两边都按同一方式修。
        onAbort()
        resolve(this.#resolved.get(key) ?? this.#noAnswer(key, '提问等待被取消'))
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })

      entry.waiters.push((resolution) => {
        signal.removeEventListener('abort', onAbort)
        resolve(resolution)
      })
    })
  }

  /** "没有答案"——注意这**不是拒绝**，`answers` 为 `null` 才是它的表达。 */
  #noAnswer(requestId: string, reason: string): UserInputResolution {
    return { requestId, answers: null, resolvedBy: 'system', reason }
  }

  #settle(requestId: string, resolution: UserInputResolution): void {
    const entry = this.#pending.get(requestId)
    if (entry) {
      clearTimeout(entry.timer)
      this.#pending.delete(requestId)
    }
    if (!this.#resolved.has(requestId)) this.#resolved.set(requestId, resolution)
    const final = this.#resolved.get(requestId) ?? resolution
    for (const waiter of entry?.waiters ?? []) waiter(final)
  }

  async #publishResolved(
    request: UserInputRequest,
    resolution: UserInputResolution,
  ): Promise<void> {
    await this.#publisher
      .publish({
        sessionId: request.session_id,
        turnId: request.turn_id,
        type: 'user_input_resolved',
        data: {
          request_id: request.request_id,
          answered: resolution.answers !== null,
          resolved_by: resolution.resolvedBy,
          reason: resolution.reason ?? null,
        },
      })
      .catch(() => undefined)
  }
}

/** 启动错误包装，与 `approvalError` 对称。 */
export function userInputError(error: unknown): AgentError {
  return AgentError.is(error)
    ? error
    : new AgentError({
        code: ErrorCode.INTERNAL_ERROR,
        message: String(error),
        source: 'user-input',
      })
}

/** 兼容导出：让 UI 能直接引用持久化形态做历史渲染。 */
export type { PersistedUserInputRequest }
