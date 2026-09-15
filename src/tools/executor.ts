import { ErrorCode, toAgentError } from '../core/errors.js'
import { withTimeout } from '../core/abort.js'
import {
  type SessionId,
  type ToolCallId,
  type TurnId,
  createPermissionRequestId,
  createToolExecutionId,
} from '../core/ids.js'
import {
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
  readonly onEvent?: ToolExecutorOptions['onEvent']
  constructor(options: ToolExecutorOptions) {
    this.registry = options.registry
    this.permissionEngine = options.permissionEngine
    this.chatStore = options.chatStore
    this.approvalService = options.approvalService
    this.clock = options.clock ?? systemClock
    this.timeoutMs = options.timeoutMs ?? 120_000
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
        expires_at: this.clock.nowMs() + 120_000,
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
          meta: { request_id: request.request_id },
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
      if (decision.risk === 'high' && !resumingSecond) {
        if (!this.approvalService)
          return {
            ok: false,
            content: 'second confirmation required',
            error_code: ErrorCode.PERMISSION_REQUIRED,
            meta: { request_id: request.request_id },
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
      result = await tool.execute({ ...ctx, signal: timeout.signal }, input)
    } catch (error) {
      const e = toAgentError(error, `tool:${toolName}`)
      result = { ok: false, content: e.message, error_code: e.code, meta: {} }
    } finally {
      timeout.cleanup()
    }
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

  private registryName(input: unknown): string {
    return typeof input === 'object' && input !== null && '__toolName' in input
      ? String((input as Record<string, unknown>)['__toolName'])
      : ''
  }
}
