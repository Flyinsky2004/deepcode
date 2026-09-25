import type { ObservationRecord } from '../core/observability.js'

export type FailureStage =
  | 'none'
  | 'user_interaction'
  | 'permission_error'
  | 'tool_execution_error'
  | 'timeout'
  | 'environment_error'
  | 'unknown'

export interface TurnMetrics {
  readonly modelCallCount: number
  readonly toolCallCount: number
  readonly inputTokens: number
  readonly cumulativeInputTokens: number
  readonly outputTokens: number
  readonly cost: number
  readonly modelLatencyMs: number
  readonly toolLatencyMs: number
  readonly taskLatencyMs: number
  readonly retryCount: number
  readonly fallbackCount: number
  readonly permissionRequestCount: number
  readonly permissionDeniedCount: number
  readonly compactCount: number
  readonly subagentCount: number
  readonly failureStage: FailureStage
  readonly failureReason: string
}

function numberValue(data: Readonly<Record<string, unknown>>, key: string): number {
  const value = data[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function textValue(data: Readonly<Record<string, unknown>>, key: string): string {
  const value = data[key]
  return typeof value === 'string' ? value : ''
}

/** 从 append-only 观测记录确定性聚合一轮指标，不依赖远端服务。 */
export function aggregateTurnMetrics(records: readonly ObservationRecord[]): TurnMetrics {
  let modelCallCount = 0
  let toolCallCount = 0
  let inputTokens = 0
  let cumulativeInputTokens = 0
  let outputTokens = 0
  let cost = 0
  let modelLatencyMs = 0
  let toolLatencyMs = 0
  let taskLatencyMs = 0
  let retryCount = 0
  let fallbackCount = 0
  let permissionRequestCount = 0
  let permissionDeniedCount = 0
  let compactCount = 0
  const subagents = new Set<string>()
  let status = ''
  let terminalReason = ''
  let lastToolError = ''
  let finalError = ''
  let lastModelError = ''

  for (const record of records) {
    const data = record.data
    switch (record.type) {
      case 'model.call.started':
        modelCallCount += 1
        break
      case 'model.call.completed':
        inputTokens = numberValue(data, 'input_tokens')
        cumulativeInputTokens += inputTokens
        outputTokens += numberValue(data, 'output_tokens')
        cost += numberValue(data, 'cost')
        modelLatencyMs += record.elapsedMs ?? 0
        break
      case 'model.call.failed':
        modelLatencyMs += record.elapsedMs ?? 0
        lastModelError = textValue(data, 'error_code') || textValue(data, 'message')
        break
      case 'model.retry':
        retryCount += 1
        break
      case 'model.fallback':
        fallbackCount += 1
        break
      case 'tool.execution.completed':
        toolCallCount += 1
        toolLatencyMs += record.elapsedMs ?? 0
        if (data['ok'] === false) lastToolError = textValue(data, 'error_code')
        break
      case 'permission.requested':
        permissionRequestCount += 1
        break
      case 'permission.decided':
        if (data['action'] === 'deny') permissionDeniedCount += 1
        break
      case 'permission.resolved':
        if (data['decision'] !== 'allow') permissionDeniedCount += 1
        break
      case 'compact.completed':
        if (data['applied'] === true) compactCount += 1
        break
      case 'subagent.started':
        if (record.subagentSessionId) subagents.add(record.subagentSessionId)
        break
      case 'turn.completed':
        status = textValue(data, 'status')
        terminalReason = textValue(data, 'terminal_reason')
        if ('last_tool_error' in data) lastToolError = textValue(data, 'last_tool_error')
        finalError = textValue(data, 'error')
        taskLatencyMs = record.elapsedMs ?? numberValue(data, 'wall_time_ms')
        // turn.completed 是权威快照；调用级累计用于在它缺失时继续诊断。
        if ('input_tokens' in data) inputTokens = numberValue(data, 'input_tokens')
        if ('output_tokens' in data) outputTokens = numberValue(data, 'output_tokens')
        if ('cost' in data) cost = numberValue(data, 'cost')
        if ('cumulative_input_tokens' in data)
          cumulativeInputTokens = numberValue(data, 'cumulative_input_tokens')
        break
      default:
        break
    }
  }

  const failure = classifyFailure({
    status,
    terminalReason,
    permissionDeniedCount,
    lastToolError,
    finalError,
    lastModelError,
  })
  return {
    modelCallCount,
    toolCallCount,
    inputTokens,
    cumulativeInputTokens,
    outputTokens,
    cost,
    modelLatencyMs,
    toolLatencyMs,
    taskLatencyMs,
    retryCount,
    fallbackCount,
    permissionRequestCount,
    permissionDeniedCount,
    compactCount,
    subagentCount: subagents.size,
    failureStage: failure.stage,
    failureReason: failure.reason,
  }
}

function classifyFailure(input: {
  readonly status: string
  readonly terminalReason: string
  readonly permissionDeniedCount: number
  readonly lastToolError: string
  readonly finalError: string
  readonly lastModelError: string
}): { readonly stage: FailureStage; readonly reason: string } {
  if (input.status === 'completed' && !input.lastToolError) return { stage: 'none', reason: 'none' }
  if (input.status === 'cancelled') return { stage: 'user_interaction', reason: 'cancelled' }
  if (input.permissionDeniedCount > 0)
    return { stage: 'permission_error', reason: 'permission_denied' }
  if (input.lastToolError) return { stage: 'tool_execution_error', reason: input.lastToolError }
  if (
    input.status === 'budget_exceeded' ||
    input.status === 'context_exceeded' ||
    input.terminalReason === 'budget_exceeded' ||
    input.terminalReason === 'max_turns'
  )
    return { stage: 'timeout', reason: input.terminalReason || input.status }
  if (input.finalError || input.lastModelError)
    return { stage: 'environment_error', reason: input.lastModelError || input.finalError }
  return { stage: 'unknown', reason: input.status || 'missing terminal observation' }
}
