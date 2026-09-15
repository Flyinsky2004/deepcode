import { ErrorCode, toAgentError } from '../core/errors.js'
import {
  formatAnswersForModel,
  type AskUserQuestion,
  type UserInputRequest,
  type UserInputResolution,
  type UserInputService,
} from '../core/input.js'
import { abortable, withTimeout } from '../core/abort.js'
import {
  type SessionId,
  type ToolCallId,
  type TurnId,
  createPermissionRequestId,
  createToolExecutionId,
} from '../core/ids.js'
import {
  DEFAULT_PERMISSION_TIMEOUT_MS,
  type ApprovalService,
  PermissionAction,
  PermissionMode,
  PermissionRequestStatus,
  type PermissionRequest,
  type PermissionResolution,
  ToolExecutionStatus,
  type Tool,
  type ToolContext,
  type ToolResult,
  type PermissionEngine,
  type SkillGuardRef,
} from '../core/tool.js'
import { type ChatStore } from '../storage/chat-store.js'
import { type PersistedToolExecution } from '../storage/types.js'
import { systemClock, type Clock } from '../core/time.js'
import type { ToolRegistry } from './registry.js'
import { inputHash as canonicalInputHash, argsPreview } from '../storage/audit.js'

export interface ToolExecutorOptions {
  readonly registry: ToolRegistry
  readonly permissionEngine: PermissionEngine
  readonly chatStore?: ChatStore
  readonly approvalService?: ApprovalService
  /**
   * 提问服务。缺省时 `ask_user_question` 退回"无答案"路径
   * （回灌 `{"_timeout": true}`），turn 不会因此卡住。
   */
  readonly userInputService?: UserInputService
  /** 提问等待上限。超时回灌 `{"_timeout": true}` 并继续。 */
  readonly userInputTimeoutMs?: number
  readonly clock?: Clock
  readonly timeoutMs?: number
  readonly outputLimitChars?: number
  readonly onEvent?: (type: string, data: Readonly<Record<string, unknown>>) => Promise<void> | void
}

export interface ExecuteToolOptions {
  readonly toolName?: string
  readonly sessionId: SessionId
  readonly turnId: TurnId
  readonly toolCallId: ToolCallId
  readonly principalId: string
  readonly input: unknown
  readonly workspaceRoot: string
  readonly allowedReadRoots?: readonly string[]
  readonly allowedWriteRoots?: readonly string[]
  readonly mode?: PermissionMode
  readonly skillGuards?: readonly SkillGuardRef[]
  readonly turnState?: Readonly<Record<string, unknown>>
  readonly budget: ToolContext['budget']
  readonly signal: AbortSignal
}

export class ToolExecutor {
  readonly registry: ToolRegistry
  readonly permissionEngine: PermissionEngine
  readonly chatStore: ChatStore | undefined
  readonly approvalService: ApprovalService | undefined
  readonly clock: Clock
  readonly timeoutMs: number
  readonly outputLimitChars: number
  readonly userInputService: UserInputService | undefined
  readonly userInputTimeoutMs: number
  readonly onEvent?: ToolExecutorOptions['onEvent']
  constructor(options: ToolExecutorOptions) {
    this.registry = options.registry
    this.permissionEngine = options.permissionEngine
    this.chatStore = options.chatStore
    this.approvalService = options.approvalService
    this.clock = options.clock ?? systemClock
    this.timeoutMs = options.timeoutMs ?? 120_000
    this.userInputService = options.userInputService
    this.userInputTimeoutMs = options.userInputTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS
    this.outputLimitChars = options.outputLimitChars ?? 64_000
    this.onEvent = options.onEvent
  }

  async execute(options: ExecuteToolOptions): Promise<ToolResult> {
    return this.executeNamed(options.toolName ?? this.registryName(options.input), options)
  }

  async executeNamed(toolName: string, options: ExecuteToolOptions): Promise<ToolResult> {
    let tool: Tool
    try {
      tool = this.registry.require(toolName)
    } catch {
      return {
        ok: false,
        content: `tool not found: ${toolName}`,
        error_code: ErrorCode.TOOL_NOT_FOUND,
        meta: {},
      }
    }
    const validated = tool.validate(options.input)
    if (!validated.ok)
      return {
        ok: false,
        content: 'invalid tool input',
        error_code: ErrorCode.TOOL_INVALID_INPUT,
        meta: { errors: validated.errors },
      }
    const input = validated.value
    const inputHash = canonicalInputHash(input)
    const existing = (await this.chatStore?.listToolExecutions(options.sessionId))?.find(
      (r) =>
        r.turnId === options.turnId &&
        r.toolCallId === options.toolCallId &&
        r.inputHash === inputHash,
    )
    if (existing?.status === ToolExecutionStatus.SUCCESS && existing.result) return existing.result
    if (existing?.status === ToolExecutionStatus.UNKNOWN)
      return {
        ok: false,
        content: 'tool execution status is unknown; manual confirmation required',
        error_code: ErrorCode.TOOL_EXECUTION_UNKNOWN,
        meta: {},
      }
    if (existing?.status === ToolExecutionStatus.RUNNING)
      return {
        ok: false,
        content: 'tool execution is still running',
        error_code: ErrorCode.TOOL_EXECUTION_UNKNOWN,
        meta: {},
      }
    const ctx: ToolContext = {
      sessionId: options.sessionId,
      turnId: options.turnId,
      principalId: options.principalId,
      workspaceRoot: options.workspaceRoot,
      allowedReadRoots: options.allowedReadRoots ?? [],
      allowedWriteRoots: options.allowedWriteRoots ?? [],
      turnState: options.turnState ?? {},
      budget: options.budget,
      signal: options.signal,
    }
    const execution: PersistedToolExecution = existing ?? {
      executionId: createToolExecutionId(),
      sessionId: options.sessionId,
      turnId: options.turnId,
      toolCallId: options.toolCallId,
      toolName,
      inputHash,
      status: ToolExecutionStatus.PENDING,
      startedAt: this.clock.now(),
      finishedAt: null,
      errorCode: null,
      elapsedMs: null,
      input,
      descriptorVersion: tool.descriptor.version,
      idempotent: tool.descriptor.risk_level === 'low',
      principalId: options.principalId,
    }
    if (!existing) await this.chatStore?.addToolExecution(execution)
    const claim = tool.safetyCheck?.(input, ctx)
    const decision = await this.permissionEngine.decide({
      toolName,
      input,
      descriptor: tool.descriptor,
      ctx,
      ...(claim === undefined ? {} : { toolClaim: claim }),
      mode: options.mode ?? PermissionMode.NORMAL,
      skillGuards: options.skillGuards ?? [],
    })
    if (decision.action !== PermissionAction.ALLOW) {
      if (decision.action === PermissionAction.DENY)
        return {
          ok: false,
          content: decision.reason || `tool denied: ${toolName}`,
          error_code: ErrorCode.PERMISSION_DENIED,
          meta: { policy_id: decision.policyId },
        }
      const priorRequests = existing?.permissionRequestIds?.length
        ? await this.chatStore?.listPermissionRequests(options.sessionId)
        : undefined
      const prior = existing?.permissionRequestIds
        ?.slice()
        .reverse()
        .map((id) => priorRequests?.find((r) => r.request_id === id))
        .find(
          (r): r is PermissionRequest =>
            r !== undefined &&
            (r.status === PermissionRequestStatus.PENDING_USER_APPROVAL ||
              r.status === PermissionRequestStatus.APPROVED),
        )
      const resumingSecond = Boolean(
        existing?.permissionRequestIds &&
        existing.permissionRequestIds.length > 1 &&
        prior?.request_id === existing.permissionRequestIds.at(-1),
      )
      const request: PermissionRequest = prior ?? {
        request_id: createPermissionRequestId(),
        session_id: options.sessionId,
        turn_id: options.turnId,
        tool_call_id: options.toolCallId,
        tool_name: toolName,
        args_preview: argsPreview(input),
        risk_level: decision.risk,
        reason: decision.reason,
        status: PermissionRequestStatus.PENDING_USER_APPROVAL,
        created_at: this.clock.now(),
        expires_at: this.clock.nowMs() + DEFAULT_PERMISSION_TIMEOUT_MS,
        resolved_at: null,
        resolved_by: '',
        resolution: '',
      }
      if (!prior) {
        await this.chatStore?.addPermissionRequest(request)
        await this.chatStore?.updateToolExecution(execution.executionId, {
          permissionRequestIds: [request.request_id],
        })
      }
      if (!prior)
        await this.onEvent?.('permission.request', {
          request_id: request.request_id,
          tool: toolName,
          risk: decision.risk,
        })
      if (request.status === PermissionRequestStatus.APPROVED) {
        // Idempotent recovery: the request was approved before the process died.
      } else if (!this.approvalService)
        return {
          ok: false,
          content: decision.reason,
          error_code: ErrorCode.PERMISSION_REQUIRED,
          // 带上真实的风险等级与到期时刻：没有审批服务时，runtime 会用它们
          // 广播 `permission_required` 事件。缺了它们，runtime 只能编造
          // （旧实现就是硬编码 `risk_level: 'medium'` + `Date.now() + 120_000`）。
          meta: {
            request_id: request.request_id,
            risk_level: decision.risk,
            expires_at: request.expires_at,
          },
        }
      let resolution: PermissionResolution =
        request.status === PermissionRequestStatus.APPROVED
          ? { requestId: request.request_id, decision: PermissionAction.ALLOW, resolvedBy: 'user' }
          : {
              requestId: request.request_id,
              decision: PermissionAction.DENY,
              resolvedBy: 'system',
              reason: 'approval unavailable',
            }
      if (request.status !== PermissionRequestStatus.APPROVED) {
        const timeout = withTimeout(
          options.signal,
          Math.max(0, request.expires_at - this.clock.nowMs()),
        )
        try {
          resolution = await this.approvalService!.request(request, timeout.signal)
        } catch {
          /* timeout/cancel/UI failure remains a denial */
        } finally {
          timeout.cleanup()
        }
      }
      if (resolution.decision !== PermissionAction.ALLOW) {
        await this.chatStore?.resolvePermission(request.request_id, resolution)
        await this.chatStore?.updateToolExecution(execution.executionId, {
          status: ToolExecutionStatus.FAILURE,
          finishedAt: this.clock.now(),
          errorCode: ErrorCode.PERMISSION_DENIED,
          result: {
            ok: false,
            content: resolution.reason ?? 'permission denied',
            error_code: ErrorCode.PERMISSION_DENIED,
            meta: { request_id: request.request_id },
          },
        })
        return {
          ok: false,
          content: resolution.reason ?? 'permission denied',
          error_code: ErrorCode.PERMISSION_DENIED,
          meta: { request_id: request.request_id },
        }
      }
      // ADR 0002 §七 把风险档位从 3 档扩到 4 档并把 `critical` 变成真实输入，
      // 但这里原本只判 `high`——于是 `critical` 反而比 `high` 少一道确认。
      if ((decision.risk === 'high' || decision.risk === 'critical') && !resumingSecond) {
        if (!this.approvalService)
          return {
            ok: false,
            content: 'second confirmation required',
            error_code: ErrorCode.PERMISSION_REQUIRED,
            meta: {
              request_id: request.request_id,
              risk_level: decision.risk,
              expires_at: request.expires_at,
              second_confirmation: true,
            },
          }
        const secondRequest = {
          ...request,
          request_id: createPermissionRequestId(),
          reason: `${request.reason} (second confirmation)`,
        }
        await this.chatStore?.addPermissionRequest(secondRequest)
        await this.chatStore?.updateToolExecution(execution.executionId, {
          permissionRequestIds: [
            ...(execution.permissionRequestIds ?? [request.request_id]),
            secondRequest.request_id,
          ],
        })
        const second = await this.approvalService
          .request(secondRequest, options.signal)
          .catch(() => ({
            requestId: secondRequest.request_id,
            decision: PermissionAction.DENY,
            resolvedBy: 'system' as const,
            reason: 'second confirmation unavailable',
          }))
        if (second.decision !== PermissionAction.ALLOW) {
          await this.chatStore?.resolvePermission(secondRequest.request_id, second)
          await this.chatStore?.updateToolExecution(execution.executionId, {
            status: ToolExecutionStatus.FAILURE,
            finishedAt: this.clock.now(),
            errorCode: ErrorCode.PERMISSION_DENIED,
            result: {
              ok: false,
              content: second.reason ?? 'second confirmation denied',
              error_code: ErrorCode.PERMISSION_DENIED,
              meta: { request_id: secondRequest.request_id },
            },
          })
          return {
            ok: false,
            content: second.reason ?? 'second confirmation denied',
            error_code: ErrorCode.PERMISSION_DENIED,
            meta: { request_id: secondRequest.request_id },
          }
        }
        await this.chatStore?.resolvePermission(secondRequest.request_id, second)
      }
      await this.chatStore?.resolvePermission(request.request_id, resolution)
    }
    await this.chatStore?.updateToolExecution(execution.executionId, {
      status: ToolExecutionStatus.RUNNING,
      startedAt: this.clock.now(),
    })
    await this.onEvent?.('tool.start', { tool: toolName, input: argsPreview(input) })
    const started = this.clock.nowMs()
    const timeout = withTimeout(options.signal, this.timeoutMs)
    let result: ToolResult
    try {
      // ⚠️ 必须用 `abortable` 而不是直接 await。
      //
      // 直接 await 的话，工具若**不理会 signal**（内置工具大多如此：只有
      // `bash` 会把 signal 传给子进程），`await` 会一直等到它真正跑完——
      // 下面的 `timeout.timedOut()` 只能把**已经完成的**结果标成超时，
      // 超时形同虚设。`abortable` 保证等待本身在超时时结束。
      //
      // ⚠️ 提前返回**不代表工具停了**。不响应 abort 的工具有可能仍在后台运行
      // 并产生副作用，此时副作用是否发生不可知——按 ADR 0002 §六 的语义，
      // 这种不确定性的正确表达是 `UNKNOWN`，但那条路径目前只覆盖"进程中断"
      // （由 `recover()` 把 `RUNNING` 改判为 `UNKNOWN`）。这里是已知限制：
      // 超时的工具仍记为 FAILURE，因为它已经向模型返回了失败结果。
      result = await abortable(
        tool.execute({ ...ctx, signal: timeout.signal }, input),
        timeout.signal,
      )
    } catch (error) {
      const e = toAgentError(error, `tool:${toolName}`)
      result = { ok: false, content: e.message, error_code: e.code, meta: {} }
    } finally {
      timeout.cleanup()
    }
    // `ask_user_question` 走**与权限审批同构**的等待路径：由 executor 等待并
    // 产出最终 ToolResult，runtime 不需要任何特殊分支。
    //
    // 这样做而不是让 runtime 等待，有两个具体好处：
    // 1. 权限等待本来就在 executor 里（`AWAITING_PERMISSION` 阶段在正常路径下
    //    也不进入——runtime 并不知情），两条阻塞通道走同一模式才一致；
    // 2. 结果经由**正常的工具结果路径**落盘，不依赖 runtime 为它开特殊分支。
    //
    // ⚠️ 修正一处此前的误判：原实现**确实**写了 `tool_result`
    // （`agent-runtime.ts` 里 `addMessage(TOOL_RESULT)` 在 `finish()` 之前），
    // 所以并不存在悬空的 `tool_use`。原实现真正的问题是
    // `user_input_required` 事件永不发出、`TurnPhase.AWAITING_USER_INPUT`
    // 永不进入，于是 `requiresResolution()` 声称需要回灌却没有任何事件去喂它。
    //
    // 即使没有注入 `userInputService` 也照常消化：回灌 `{"_timeout": true}`
    // （与真超时同形），让模型自己决定下一步。这比留下一个
    // "error_code 表示需要用户输入、但谁也不会来回答"的结果要好——
    // 后者会让模型反复重试同一个工具。
    if (result.error_code === 'USER_INPUT_REQUIRED')
      result = await this.awaitUserInput(toolName, options, result, timeout.signal)

    let finalRecord: Partial<PersistedToolExecution> = {
      status: result.ok ? ToolExecutionStatus.SUCCESS : ToolExecutionStatus.FAILURE,
      finishedAt: this.clock.now(),
      elapsedMs: this.clock.nowMs() - started,
      errorCode: result.error_code,
      result,
    }
    if (timeout.timedOut()) {
      result = {
        ok: false,
        content: `tool timed out: ${toolName}`,
        error_code: ErrorCode.TOOL_TIMEOUT,
        meta: {},
      }
      finalRecord = {
        ...finalRecord,
        status: ToolExecutionStatus.FAILURE,
        errorCode: ErrorCode.TOOL_TIMEOUT,
        result,
      }
    }
    if (result.content.length > this.outputLimitChars) {
      result = {
        ...result,
        content: `${result.content.slice(0, this.outputLimitChars)}\n... [output truncated]`,
        meta: { ...result.meta, output_truncated: true, output_limit_chars: this.outputLimitChars },
      }
    }
    await this.chatStore?.updateToolExecution(execution.executionId, finalRecord)
    await this.onEvent?.('tool.complete', { tool: toolName, ok: result.ok, meta: result.meta })
    return result
  }

  /**
   * 等待用户回答 `ask_user_question`。
   *
   * 与 `ApprovalService` 的三条要求一致（幂等、永不挂起、不抛），但**超时语义
   * 不同**：提问超时不是拒绝，而是回灌 `{"_timeout": true}` 让 turn 继续跑
   * （`parts/09` §5 的"超时按 deny"只适用于权限）。
   */
  private async awaitUserInput(
    toolName: string,
    options: ExecuteToolOptions,
    result: ToolResult,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const questions = Array.isArray(result.meta['questions'])
      ? (result.meta['questions'] as readonly AskUserQuestion[])
      : []
    const requestId = createPermissionRequestId()
    const request: UserInputRequest = {
      request_id: requestId,
      session_id: options.sessionId,
      turn_id: options.turnId,
      tool_call_id: options.toolCallId,
      tool_name: toolName,
      questions,
      created_at: this.clock.now(),
      expires_at: this.clock.nowMs() + this.userInputTimeoutMs,
    }
    // 先落盘再等待 —— 进程中断后要能恢复出"这个 turn 停在等某个问题的答案"
    await this.chatStore?.addUserInputRequest(request)

    const timeout = withTimeout(signal, Math.max(0, request.expires_at - this.clock.nowMs()))
    let resolution: UserInputResolution = {
      requestId,
      answers: null,
      resolvedBy: 'system',
      reason: 'user input unavailable',
    }
    try {
      // 没有注入服务时**不等待**：等价于立即超时。否则一个没有 UI 的自动化
      // 运行会在这里静默挂满整个超时窗口。
      if (this.userInputService !== undefined)
        resolution = await this.userInputService.request(request, timeout.signal)
    } catch {
      /* 超时/取消/UI 异常一律保持"无答案"，由 formatAnswersForModel 兜底 */
    } finally {
      timeout.cleanup()
    }
    await this.chatStore?.resolveUserInput(requestId, resolution)

    return {
      ok: true,
      content: formatAnswersForModel(questions, resolution.answers),
      error_code: null,
      meta: { request_id: requestId, questions, answered: resolution.answers !== null },
    }
  }

  private registryName(input: unknown): string {
    return typeof input === 'object' && input !== null && '__toolName' in input
      ? String((input as Record<string, unknown>)['__toolName'])
      : ''
  }
}
