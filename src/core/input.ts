/**
 * 用户提问契约。
 *
 * `ask_user_question` 是**第二个**会阻塞 turn 等待人工响应的通道，与权限审批
 * **并行但语义不同**（ADR 0002 §四）：
 *
 * | | `awaiting_permission` | `awaiting_user_input` |
 * |---|---|---|
 * | 等的是 | 授权决定 | 答案内容 |
 * | 超时语义 | 按 **deny** 处理 | 返回 `{"_timeout": true}`，**turn 继续跑** |
 * | 结果去向 | 决定工具执不执行 | 作为 tool_result 回灌给模型 |
 *
 * 把两者合并成一个"等待"状态会让恢复逻辑无法判断该重新弹审批还是重新提问，
 * 所以这里独立建模，与 `ApprovalService` 对称。
 */

import type { PermissionRequestId, SessionId, ToolCallId, TurnId } from './ids.js'
import type { IsoTimestamp } from './time.js'

/** 一道选择题的选项。 */
export interface AskUserOption {
  /** 选项标签。**这是回灌给模型的值**。 */
  readonly label: string
  readonly description: string
}

/** 一道问题。 */
export interface AskUserQuestion {
  readonly question: string
  /** 短标题，用于 UI 分栏或折叠显示。 */
  readonly header: string
  readonly options: readonly AskUserOption[]
  /** 是否可多选。缺省为单选。 */
  readonly multiSelect?: boolean
}

/**
 * 一次待回答的提问。
 *
 * 与 `PermissionRequest` 一样**必须可持久化**：进程中断后要能恢复出
 * "这个 turn 停在等某个问题的答案"。因此字段全部是可 JSON 序列化的原始值。
 */
export interface UserInputRequest {
  readonly request_id: PermissionRequestId
  readonly session_id: SessionId
  readonly turn_id: TurnId
  readonly tool_call_id: ToolCallId
  readonly tool_name: string
  readonly questions: readonly AskUserQuestion[]
  readonly created_at: IsoTimestamp
  /** 到期时刻（epoch 毫秒）。超时按"无答案"处理并让 turn 继续。 */
  readonly expires_at: number
}

/** 提问请求的生命周期状态。 */
export const UserInputRequestStatus = {
  /** 已创建，等待用户作答。 */
  PENDING_USER_INPUT: 'PENDING_USER_INPUT',
  /** 用户已作答。 */
  ANSWERED: 'ANSWERED',
  /** 超时未作答。 */
  EXPIRED: 'EXPIRED',
  /** 被取消（turn 取消或服务关闭）。 */
  CANCELLED: 'CANCELLED',
} as const

/** 提问请求状态类型。 */
export type UserInputRequestStatus =
  (typeof UserInputRequestStatus)[keyof typeof UserInputRequestStatus]

/** 持久化形态：请求 + 状态。 */
export interface PersistedUserInputRequest {
  readonly request: UserInputRequest
  readonly status: UserInputRequestStatus
  /** 作答内容，未作答时为 `null`。 */
  readonly answers: readonly (readonly string[])[] | null
  readonly resolved_at: IsoTimestamp | null
  /** `"user"` 表示用户作答，`"system"` 表示超时或取消。 */
  readonly resolved_by: 'user' | 'system' | ''
}

/** 用户对一次提问的作答。 */
export interface UserInputResolution {
  /**
   * 与 `UserInputRequest.request_id` 对应。
   *
   * 类型是普通 `string` 而非品牌类型，与 `PermissionResolution.requestId`
   * **刻意保持一致**：决议来自 UI（HTTP/终端输入），那边拿到的就是字符串。
   * 品牌类型留给"由本实现生成"的 `UserInputRequest.request_id`。
   */
  readonly requestId: string
  /**
   * 按 `questions` 下标对齐的答案；多选为数组。
   *
   * `null` 表示**没有拿到答案**（超时、取消或 UI 不可用），
   * 调用方应回灌 `{"_timeout": true}` 而不是编造一个答案。
   */
  readonly answers: readonly (readonly string[])[] | null
  /** 决议来源。`"system"` 表示超时或取消导致的兜底。 */
  readonly resolvedBy: 'user' | 'system'
  readonly reason?: string
}

/**
 * 提问服务。
 *
 * 与 `ApprovalService` 有**相同的三条硬性要求**，因为调用方的超时包装
 * 对两者是同一套：
 *
 * 1. **必须幂等**——同一 `request_id` 重复调用返回同一结果（重连、重试、
 *    进程重启后的恢复都会触发重复调用）；
 * 2. **永不挂起**——超时、取消、UI 不可用都必须给出结果，绝不"卡住不返回"；
 * 3. **不得抛异常**——异常会被调用方当作"无答案"，但那会丢失诊断信息。
 *
 * ⚠️ 与 `ApprovalService` 的**关键差别**：超时的结果不是"拒绝"，而是
 * `answers: null` → 回灌 `{"_timeout": true}` → **turn 继续执行**。
 * 提问超时不终止任务，只是让模型知道"没拿到答案，自己看着办"。
 */
export interface UserInputService {
  request(request: UserInputRequest, signal: AbortSignal): Promise<UserInputResolution>
}

/**
 * 把答案整理成回灌给模型的文本。
 *
 * 无答案时返回 `{"_timeout": true}`——这个形状来自旧实现（`parts/05` §7.7），
 * 模型已经学会据此继续工作而不是反复追问，因此**必须逐字保留**。
 */
export function formatAnswersForModel(
  questions: readonly AskUserQuestion[],
  answers: readonly (readonly string[])[] | null,
): string {
  if (answers === null) return JSON.stringify({ _timeout: true })
  if (questions.length === 0) return JSON.stringify({ _empty: true })
  const paired = questions.map((question, index) => ({
    question: question.question,
    answers: answers[index] ?? [],
  }))
  return JSON.stringify({ answers: paired })
}
