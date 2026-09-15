import { AgentError, ErrorCode, isTransient, toAgentError } from '../core/errors.js'
import { BudgetTracker, DEFAULT_BUDGET, type AgentBudget } from '../core/budget.js'
import { EMPTY_WORKING_MEMORY, type RuntimeState, renderSystemPrompt } from '../core/context.js'
import { createEventId, type SessionId, type ToolCallId, type TurnId } from '../core/ids.js'
import { MessageRole, MessageSubtype } from '../core/models.js'
import {
  type ModelProvider,
  type ModelRequest,
  type ModelOverride,
  type TaskIntent,
  ModelTier,
} from '../core/provider.js'
import {
  RuntimeEventType,
  type TurnResult,
  TurnPhase,
  TurnStatus,
  TerminalReason,
  canTransition,
  ACTIVE_PHASES,
} from '../core/turn.js'
import { PermissionMode, ToolExecutionStatus, type ToolResult } from '../core/tool.js'
import type { EventSink, RuntimeEventEnvelope } from '../core/events.js'
import { systemClock, type Clock } from '../core/time.js'
import type { ChatStore } from '../storage/chat-store.js'
import type { PersistedTurn } from '../storage/types.js'
import type { ModelRouter } from '../providers/router.js'
import type { ResolvedModelRoute } from '../providers/router.js'
import type { ContextBuilder } from './context-builder.js'
import type { ContextCompactor } from './compaction.js'
import type { ToolExecutor } from '../tools/executor.js'
import { AnthropicMessagesProvider } from '../providers/anthropic.js'
import { withTimeout } from '../core/abort.js'

export interface AgentRuntimeOptions {
  readonly chatStore: ChatStore
  readonly contextBuilder: ContextBuilder
  readonly toolExecutor: ToolExecutor
  readonly eventSink?: EventSink
  readonly provider?: ModelProvider
  readonly model?: string
  readonly router?: ModelRouter
  readonly providerFactory?: (route: ResolvedModelRoute) => ModelProvider
  readonly compactor?: ContextCompactor
  readonly budget?: AgentBudget
  readonly mode?: PermissionMode
  readonly workspaceRoot: string
  readonly principalId: string
  readonly clock?: Clock
  readonly maxTurns?: number
}

export class AgentRuntime {
  readonly options: AgentRuntimeOptions
  readonly clock: Clock
  readonly busy = new Set<string>()
  readonly sequence = new Map<string, number>()
  constructor(options: AgentRuntimeOptions) {
    this.options = options
    this.clock = options.clock ?? systemClock
  }

  async submitMessage(
    sessionId: SessionId,
    prompt: string,
    signal: AbortSignal = new AbortController().signal,
    override?: ModelOverride,
  ): Promise<TurnResult> {
    if (this.busy.has(sessionId))
      throw new AgentError({
        code: ErrorCode.SESSION_BUSY,
        message: 'session already has an active turn',
        source: 'runtime',
      })
    this.busy.add(sessionId)
    try {
      const configuredBudget = this.options.budget ?? DEFAULT_BUDGET
      const budget =
        this.options.maxTurns === undefined
          ? configuredBudget
          : {
              ...configuredBudget,
              maxModelCalls: Math.min(configuredBudget.maxModelCalls, this.options.maxTurns),
            }
      const tracker = new BudgetTracker(budget, this.clock)
      const persisted = await this.options.chatStore.beginTurn(
        sessionId,
        prompt,
        this.options.principalId,
        budget,
        EMPTY_WORKING_MEMORY,
      )
      const turnId = persisted.turnId as TurnId
      const { turnNumber } = persisted
      await this.options.chatStore.updateTurn(sessionId, turnId, {
        mode: this.options.mode ?? PermissionMode.NORMAL,
      })
      await this.emit(sessionId, turnId, RuntimeEventType.TURN_START, { turn_number: turnNumber })
      return await this.runTurn(sessionId, turnId, turnNumber, tracker, signal, override)
    } finally {
      this.busy.delete(sessionId)
    }
  }

  submit(
    sessionId: SessionId,
    prompt: string,
    signal?: AbortSignal,
    override?: ModelOverride,
  ): Promise<TurnResult> {
    return this.submitMessage(sessionId, prompt, signal, override)
  }

  /** Resume the latest unfinished turn after a process restart. */
  async resumeTurn(
    sessionId: SessionId,
    turnId: TurnId,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<TurnResult> {
    if (this.busy.has(sessionId))
      throw new AgentError({
        code: ErrorCode.SESSION_BUSY,
        message: 'session already has an active turn',
        source: 'runtime',
      })
    const persisted = await this.options.chatStore.getTurn(sessionId, turnId)
    if (persisted.principalId !== this.options.principalId)
      throw new AgentError({
        code: ErrorCode.PERMISSION_DENIED,
        message: 'turn belongs to a different principal',
        source: 'runtime',
      })
    if (!ACTIVE_PHASES.has(persisted.phase))
      return (
        persisted.result ?? {
          turn_id: turnId,
          status: TurnStatus.FAILED,
          final_text: persisted.finalText ?? '',
          tool_rounds: persisted.toolRounds ?? 0,
          input_tokens: persisted.consumption.inputTokens,
          output_tokens: persisted.consumption.outputTokens,
          error: 'turn is not resumable',
          num_turns: persisted.consumption.modelCalls,
          max_turns: persisted.budget.maxModelCalls,
          terminal_reason: TerminalReason.ERROR,
          last_tool_error: persisted.lastToolError ?? null,
        }
      )
    this.busy.add(sessionId)
    try {
      const tracker = new BudgetTracker(
        persisted.budget,
        this.clock,
        persisted.consumption,
        persisted.cumulativeInputTokens,
      )
      return await this.runTurn(
        sessionId,
        turnId,
        persisted.turnNumber,
        tracker,
        signal,
        undefined,
        persisted,
      )
    } finally {
      this.busy.delete(sessionId)
    }
  }

  private async runTurn(
    sessionId: SessionId,
    turnId: TurnId,
    turnNumber: number,
    tracker: BudgetTracker,
    signal: AbortSignal,
    override?: ModelOverride,
    persisted?: PersistedTurn,
  ): Promise<TurnResult> {
    let phase: TurnPhase = persisted?.phase ?? TurnPhase.STARTING
    let text = persisted?.finalText ?? ''
    let toolRounds = persisted?.toolRounds ?? 0
    let numTurns = persisted?.consumption.modelCalls ?? 0
    let lastToolError: string | null = null
    let route: ResolvedModelRoute | undefined
    let provider: ModelProvider | undefined
    let model: string | undefined
    let candidateIndex = 0
    let compactedThisTurn = false
    let providerRetries = 0
    let finalizationAttempted = persisted?.phase === TurnPhase.FINALIZING
    const mode = persisted?.mode ?? this.options.mode ?? PermissionMode.NORMAL
    let workingMemory = persisted?.workingMemory ?? EMPTY_WORKING_MEMORY
    const wallTimeout = withTimeout(
      signal,
      Math.max(0, tracker.budget.maxWallTimeMs - (persisted?.consumption.wallTimeMs ?? 0)),
    )
    const runSignal = wallTimeout.signal
    const transition = async (to: TurnPhase, reason: string): Promise<void> => {
      if (phase === to) return
      if (!canTransition(phase, to))
        throw new AgentError({
          code: ErrorCode.INVALID_STATE_TRANSITION,
          message: `${phase} -> ${to}`,
          source: 'runtime',
        })
      await this.options.chatStore.updateTurn(sessionId, turnId, {
        phase: to,
        updatedAt: this.clock.now(),
        consumption: tracker.snapshot(),
        cumulativeInputTokens: tracker.cumulativeInputTokens,
        transitions: [
          ...(await this.options.chatStore.getTurn(sessionId, turnId)).transitions,
          {
            turnId,
            from: phase,
            to,
            reason,
            timestamp: this.clock.now(),
            eventId: createEventId(),
          },
        ],
      })
      phase = to
    }
    const finish = async (
      status: TurnStatus,
      reason: TurnResult['terminal_reason'],
      error: string | null,
    ): Promise<TurnResult> => {
      const result: TurnResult = {
        turn_id: turnId,
        status,
        final_text: text,
        tool_rounds: toolRounds,
        input_tokens: tracker.snapshot().inputTokens,
        output_tokens: tracker.snapshot().outputTokens,
        error,
        num_turns: numTurns,
        max_turns: this.options.maxTurns ?? tracker.budget.maxModelCalls,
        terminal_reason: reason,
        last_tool_error: lastToolError,
      }
      const finalPhase =
        status === TurnStatus.COMPLETED
          ? TurnPhase.COMPLETED
          : status === TurnStatus.CANCELLED
            ? TurnPhase.CANCELLED
            : status === TurnStatus.PARTIAL && reason === TerminalReason.BUDGET_EXCEEDED
              ? TurnPhase.BUDGET_EXCEEDED
              : status === TurnStatus.CONTEXT_EXCEEDED
                ? TurnPhase.CONTEXT_EXCEEDED
                : status === TurnStatus.BUDGET_EXCEEDED
                  ? TurnPhase.BUDGET_EXCEEDED
                  : TurnPhase.FAILED
      if (phase !== finalPhase) {
        // The frozen state machine routes budget exhaustion through finalizing;
        // executing_tools has no direct completed/budget edge by design.
        if (finalPhase === TurnPhase.BUDGET_EXCEEDED && phase === TurnPhase.EXECUTING_TOOLS) {
          await transition(TurnPhase.CALLING_MODEL, 'budget checkpoint')
          await transition(TurnPhase.FINALIZING, 'budget exhausted')
        }
        await transition(finalPhase, reason ?? 'finished')
      }
      await this.options.chatStore.updateTurn(sessionId, turnId, {
        result,
        consumption: tracker.snapshot(),
        cumulativeInputTokens: tracker.cumulativeInputTokens,
        updatedAt: this.clock.now(),
      })
      await this.emit(sessionId, turnId, RuntimeEventType.TURN_END, {
        status,
        terminal_reason: reason,
        final_text: text,
        tool_rounds: toolRounds,
        num_turns: numTurns,
        base_max_turns: tracker.budget.maxModelCalls,
        max_turns: tracker.budget.maxModelCalls,
      })
      return result
    }
    try {
      if (phase === TurnPhase.STARTING || phase === TurnPhase.COMPACTING)
        await transition(TurnPhase.BUILDING_CONTEXT, 'start')
      else if (phase === TurnPhase.AWAITING_USER_INPUT)
        await transition(TurnPhase.CALLING_MODEL, 'resume user input')
      const intent: TaskIntent = {
        tier: ModelTier.IMPLEMENTATION,
        purpose: 'implement',
        requiresTools: true,
        requiresThinking: false,
      }
      if (persisted?.routeSnapshot) {
        route = {
          provider: persisted.routeSnapshot.provider,
          model: persisted.routeSnapshot.model,
          tier: persisted.routeSnapshot.tier,
          candidates: [
            {
              providerId: persisted.routeSnapshot.provider.id,
              modelId: persisted.routeSnapshot.model.id,
            },
          ],
        }
      } else if (this.options.router) route = await this.options.router.resolve(intent, override)
      provider = route
        ? (this.options.providerFactory?.(route) ??
          new AnthropicMessagesProvider({ provider: route.provider }))
        : this.options.provider
      model = route?.model.id ?? this.options.model
      if (route)
        await this.options.chatStore.updateTurn(sessionId, turnId, {
          modelSnapshot: {
            providerId: route.provider.id,
            modelId: route.model.id,
            tier: route.tier,
            contextWindow: route.model.contextWindow,
            maxOutputTokens: route.model.maxOutputTokens,
            supportsThinking: route.model.supportsThinking,
            supportsTools: route.model.supportsTools,
            supportsVision: route.model.supportsVision,
            supports1MContext: route.model.supports1MContext,
          },
          routeSnapshot: {
            provider: route.provider,
            model: route.model,
            tier: route.tier,
          },
        })
      if (!provider || !model)
        return finish(
          TurnStatus.FAILED,
          TerminalReason.ERROR,
          'No model configured. Add one with /api, then /model.',
        )

      // A crash can leave a durable PENDING tool execution while the turn is
      // executing/awaiting permission. Reconcile it before asking the model
      // for another response; UNKNOWN executions are never auto-replayed.
      if (
        persisted &&
        (persisted.phase === TurnPhase.EXECUTING_TOOLS ||
          persisted.phase === TurnPhase.AWAITING_PERMISSION)
      ) {
        const records = (await this.options.chatStore.listToolExecutions(sessionId)).filter(
          (record) =>
            record.turnId === turnId &&
            (record.status === ToolExecutionStatus.PENDING ||
              record.status === ToolExecutionStatus.UNKNOWN),
        )
        if (records.length > 0 && phase !== TurnPhase.EXECUTING_TOOLS)
          await transition(TurnPhase.EXECUTING_TOOLS, 'resume pending tools')
        for (const record of records) {
          const existingMessage = (await this.options.chatStore.listMessages(sessionId)).some(
            (message) => message.tool_call_id === record.toolCallId,
          )
          let result: ToolResult
          if (record.status === ToolExecutionStatus.UNKNOWN) {
            result = {
              ok: false,
              content: 'tool execution status is unknown; manual confirmation required',
              error_code: ErrorCode.TOOL_EXECUTION_UNKNOWN,
              meta: {},
            }
          } else {
            result = await this.options.toolExecutor.executeNamed(record.toolName, {
              sessionId,
              turnId,
              toolCallId: record.toolCallId,
              principalId: this.options.principalId,
              input: record.input,
              workspaceRoot: this.options.workspaceRoot,
              budget: tracker.budget,
              signal: runSignal,
              mode,
              ...(persisted.skillGuards ? { skillGuards: persisted.skillGuards } : {}),
            })
          }
          lastToolError = result.error_code
          if (!existingMessage) {
            await this.options.chatStore.addMessage({
              conversation_id: sessionId,
              role: MessageRole.TOOL,
              content: JSON.stringify({ tool_use_id: record.toolCallId, content: result.content }),
              turn_id: turnId,
              subtype: MessageSubtype.TOOL_RESULT,
              tool_call_id: record.toolCallId,
              meta: JSON.stringify({
                tool_name: record.toolName,
                ok: result.ok,
                error_code: result.error_code,
                ...(result.data ?? {}),
              }),
              agent_type: '',
            })
            await this.emit(sessionId, turnId, RuntimeEventType.TOOL_RESULT, {
              tool_use_id: record.toolCallId,
              name: record.toolName,
              ok: result.ok,
              content: result.content,
              error_code: result.error_code,
            })
          }
          tracker.recordToolCall()
          workingMemory = {
            ...workingMemory,
            pendingToolCalls: workingMemory.pendingToolCalls.filter(
              (pending) => pending.toolCallId !== record.toolCallId,
            ),
            permissionDecisions: [
              ...workingMemory.permissionDecisions,
              {
                requestId:
                  typeof result.meta['request_id'] === 'string' ? result.meta['request_id'] : '',
                toolCallId: record.toolCallId,
                toolName: record.toolName,
                action: result.ok ? 'allow' : 'deny',
                resolution: result.ok ? 'executed' : (result.error_code ?? 'error'),
                reason: result.content,
              },
            ],
          }
          await this.options.chatStore.updateTurn(sessionId, turnId, {
            workingMemory,
            lastToolError,
          })
        }
        if (phase === TurnPhase.EXECUTING_TOOLS)
          await transition(TurnPhase.CALLING_MODEL, 'pending tools reconciled')
      }
      while (true) {
        if (runSignal.aborted) {
          return wallTimeout.timedOut()
            ? finish(
                TurnStatus.PARTIAL,
                TerminalReason.BUDGET_EXCEEDED,
                'budget exceeded: wallTime',
              )
            : finish(TurnStatus.CANCELLED, TerminalReason.CANCELLED, null)
        }
        const exhaustedBeforeCall = tracker.check()
        if (exhaustedBeforeCall && numTurns > 0) {
          if (!finalizationAttempted && phase === TurnPhase.CALLING_MODEL) {
            finalizationAttempted = true
            await transition(
              TurnPhase.FINALIZING,
              `budget exhausted: ${exhaustedBeforeCall.dimension}`,
            )
          } else if (finalizationAttempted && phase === TurnPhase.FINALIZING) {
            // A process may have stopped during the one allowed finalization call.
            // Resume that call once; a second attempt falls through to partial below.
          } else {
            return finish(
              TurnStatus.PARTIAL,
              TerminalReason.BUDGET_EXCEEDED,
              `budget exceeded: ${exhaustedBeforeCall.dimension}`,
            )
          }
        }
        const state: RuntimeState = {
          phase: TurnPhase.BUILDING_CONTEXT,
          mode,
          turnNumber,
          appliedSkills: [],
          activePhase: 'implementation',
          budget: tracker.budget,
          budgetConsumption: tracker.snapshot(),
          workingMemory,
        }
        const envelope = await this.options.contextBuilder.build(sessionId, mode, state)
        if (
          this.options.compactor &&
          !compactedThisTurn &&
          this.options.compactor.shouldCompact(
            await this.options.chatStore.listActiveMessages(sessionId),
          )
        ) {
          await this.emit(sessionId, turnId, RuntimeEventType.COMPACT_START, {
            strategy: 'preflight',
          })
          await transition(TurnPhase.COMPACTING, 'preflight')
          const compacted = await this.options.compactor.compact(
            sessionId,
            workingMemory,
            runSignal,
          )
          compactedThisTurn = true
          await this.emit(sessionId, turnId, RuntimeEventType.COMPACT_END, {
            applied: compacted !== undefined,
            strategy: 'preflight',
          })
          await transition(TurnPhase.BUILDING_CONTEXT, 'compact complete')
          continue
        }
        if (!finalizationAttempted) await transition(TurnPhase.CALLING_MODEL, 'context ready')
        tracker.recordModelCall()
        numTurns += 1
        const request: ModelRequest = {
          model: model ?? '',
          maxTokens: route?.model.maxOutputTokens ?? 8192,
          messages: envelope.conversation,
          system: renderSystemPrompt(envelope.system),
          tools: finalizationAttempted ? [] : envelope.tools,
        }
        const blocks: Array<Record<string, unknown>> = []
        const toolCalls: Array<{
          id: ToolCallId
          name: string
          input: Readonly<Record<string, unknown>>
        }> = []
        let streamUsage: { inputTokens: number; outputTokens: number } | undefined
        try {
          const stream = provider.stream(request, runSignal)
          for await (const event of stream) {
            if (event.type === 'text') {
              text += event.content
              const previous = blocks.at(-1)
              if (previous?.['type'] === 'text' && typeof previous['text'] === 'string')
                previous['text'] = `${previous['text']}${event.content}`
              else blocks.push({ type: 'text', text: event.content })
              await this.emit(sessionId, turnId, RuntimeEventType.TEXT, { content: event.content })
            } else if (event.type === 'thinking') {
              blocks.push({
                type: 'thinking',
                thinking: event.thinking,
                signature: event.signature,
              })
              await this.emit(sessionId, turnId, RuntimeEventType.THINKING, {
                content: event.thinking,
                preview: event.thinking.slice(0, 200),
              })
            } else {
              const call = { id: event.id as ToolCallId, name: event.name, input: event.input }
              toolCalls.push(call)
              blocks.push({ type: 'tool_use', id: event.id, name: event.name, input: event.input })
              await this.emit(sessionId, turnId, RuntimeEventType.TOOL_USE, {
                id: event.id,
                name: event.name,
                input: event.input,
              })
            }
          }
          streamUsage = stream.usage
        } catch (error) {
          const e = toAgentError(error, 'runtime')
          if (
            e.code === ErrorCode.CONTEXT_EXCEEDED &&
            this.options.compactor &&
            !compactedThisTurn
          ) {
            await transition(TurnPhase.COMPACTING, 'reactive context overflow')
            await this.options.compactor.compactReactive(sessionId, workingMemory, runSignal)
            compactedThisTurn = true
            await transition(TurnPhase.BUILDING_CONTEXT, 'reactive compact complete')
            continue
          }
          if (e.code === ErrorCode.CONTEXT_EXCEEDED)
            return finish(TurnStatus.CONTEXT_EXCEEDED, TerminalReason.CONTEXT_EXCEEDED, e.message)
          if (runSignal.aborted)
            return wallTimeout.timedOut()
              ? finish(
                  TurnStatus.PARTIAL,
                  TerminalReason.BUDGET_EXCEEDED,
                  'budget exceeded: wallTime',
                )
              : finish(TurnStatus.CANCELLED, TerminalReason.CANCELLED, null)
          if (isTransient(e.code) && providerRetries < 2) {
            providerRetries += 1
            continue
          }
          if (
            isTransient(e.code) &&
            route &&
            this.options.router &&
            candidateIndex + 1 < route.candidates.length
          ) {
            candidateIndex += 1
            route = await this.options.router.resolveCandidate(
              intent,
              route.candidates[candidateIndex]!,
              route.candidates,
            )
            provider =
              this.options.providerFactory?.(route) ??
              new AnthropicMessagesProvider({ provider: route.provider })
            model = route.model.id
            providerRetries = 0
            await this.options.chatStore.updateTurn(sessionId, turnId, {
              modelSnapshot: {
                providerId: route.provider.id,
                modelId: route.model.id,
                tier: route.tier,
                contextWindow: route.model.contextWindow,
                maxOutputTokens: route.model.maxOutputTokens,
                supportsThinking: route.model.supportsThinking,
                supportsTools: route.model.supportsTools,
                supportsVision: route.model.supportsVision,
                supports1MContext: route.model.supports1MContext,
              },
              routeSnapshot: {
                provider: route.provider,
                model: route.model,
                tier: route.tier,
              },
            })
            continue
          }
          return finish(TurnStatus.FAILED, TerminalReason.ERROR, e.message)
        }
        const usage = typeof streamUsage !== 'undefined' ? streamUsage : undefined
        if (usage) tracker.recordUsage(usage)
        if (blocks.length > 0)
          await this.options.chatStore.addMessage({
            conversation_id: sessionId,
            role: MessageRole.ASSISTANT,
            content: JSON.stringify(blocks),
            turn_id: turnId,
            subtype: toolCalls.length ? MessageSubtype.TOOL_CALL : MessageSubtype.NORMAL,
            tool_call_id: null,
            meta: '{}',
            agent_type: '',
          })
        if (toolCalls.length === 0)
          return finalizationAttempted
            ? finish(TurnStatus.PARTIAL, TerminalReason.BUDGET_EXCEEDED, null)
            : finish(TurnStatus.COMPLETED, TerminalReason.COMPLETED, null)
        if (finalizationAttempted)
          return finish(
            TurnStatus.PARTIAL,
            TerminalReason.FINALIZATION_TOOL_CALL,
            'finalization response requested tools',
          )
        toolRounds += 1
        await transition(TurnPhase.EXECUTING_TOOLS, 'model requested tools')
        for (const call of toolCalls) {
          workingMemory = {
            ...workingMemory,
            pendingToolCalls: [
              ...workingMemory.pendingToolCalls.filter((p) => p.toolCallId !== call.id),
              { toolCallId: call.id, toolName: call.name, input: call.input },
            ],
          }
          const result = await this.options.toolExecutor.executeNamed(call.name, {
            sessionId,
            turnId,
            toolCallId: call.id,
            principalId: this.options.principalId,
            input: call.input,
            workspaceRoot: this.options.workspaceRoot,
            budget: tracker.budget,
            signal: runSignal,
            mode,
          })
          if (call.name === 'todo_write' && Array.isArray(result.data?.['todos'])) {
            workingMemory = {
              ...workingMemory,
              openTasks: result.data['todos'].flatMap((todo) =>
                todo &&
                typeof todo === 'object' &&
                (todo as Record<string, unknown>)['status'] !== 'completed' &&
                typeof (todo as Record<string, unknown>)['content'] === 'string'
                  ? [(todo as Record<string, unknown>)['content'] as string]
                  : [],
              ),
            }
          }
          if (
            result.ok &&
            (call.name === 'file_write' || call.name === 'file_edit') &&
            typeof result.data?.['path'] === 'string'
          ) {
            workingMemory = {
              ...workingMemory,
              fileChanges: [
                ...workingMemory.fileChanges,
                {
                  path: result.data['path'],
                  kind: result.data['before_hash'] === null ? 'created' : 'modified',
                  beforeHash:
                    typeof result.data['before_hash'] === 'string'
                      ? result.data['before_hash']
                      : null,
                  afterHash:
                    typeof result.data['after_hash'] === 'string'
                      ? result.data['after_hash']
                      : null,
                },
              ],
            }
          }
          lastToolError = result.error_code
          workingMemory = {
            ...workingMemory,
            pendingToolCalls: workingMemory.pendingToolCalls.filter(
              (p) => p.toolCallId !== call.id,
            ),
            permissionDecisions: [
              ...workingMemory.permissionDecisions,
              {
                requestId:
                  typeof result.meta['request_id'] === 'string' ? result.meta['request_id'] : '',
                toolCallId: call.id,
                toolName: call.name,
                action: result.ok ? 'allow' : 'deny',
                resolution: result.ok ? 'executed' : (result.error_code ?? 'error'),
                reason: result.content,
              },
            ],
          }
          await this.options.chatStore.updateTurn(sessionId, turnId, {
            workingMemory,
            lastToolError,
          })
          await this.options.chatStore.addMessage({
            conversation_id: sessionId,
            role: MessageRole.TOOL,
            content: JSON.stringify({ tool_use_id: call.id, content: result.content }),
            turn_id: turnId,
            subtype: MessageSubtype.TOOL_RESULT,
            tool_call_id: call.id,
            meta: JSON.stringify({
              tool_name: call.name,
              ok: result.ok,
              error_code: result.error_code,
              ...(result.data ?? {}),
            }),
            agent_type: '',
          })
          await this.emit(sessionId, turnId, RuntimeEventType.TOOL_RESULT, {
            tool_use_id: call.id,
            name: call.name,
            ok: result.ok,
            content: result.content,
            error_code: result.error_code,
          })
          if (result.error_code === ErrorCode.PERMISSION_REQUIRED)
            await this.emit(sessionId, turnId, RuntimeEventType.PERMISSION_REQUIRED, {
              request_id:
                typeof result.meta['request_id'] === 'string' ? result.meta['request_id'] : '',
              tool_name: call.name,
              tool_call_id: call.id,
              tool_input: call.input,
              args_preview: JSON.stringify(call.input).slice(0, 1000),
              risk_level: 'medium',
              reason: result.content,
              expires_at: Date.now() + 120_000,
            })
          tracker.recordToolCall()
          if (runSignal.aborted)
            return wallTimeout.timedOut()
              ? finish(
                  TurnStatus.PARTIAL,
                  TerminalReason.BUDGET_EXCEEDED,
                  'budget exceeded: wallTime',
                )
              : finish(TurnStatus.CANCELLED, TerminalReason.CANCELLED, null)
          if (result.error_code === 'USER_INPUT_REQUIRED')
            return finish(TurnStatus.PARTIAL, TerminalReason.ERROR, 'user input required')
        }
        const exhausted = tracker.check()
        if (exhausted)
          return finish(
            TurnStatus.PARTIAL,
            TerminalReason.BUDGET_EXCEEDED,
            `budget exceeded: ${exhausted.dimension}`,
          )
      }
    } catch (error) {
      const e = toAgentError(error, 'runtime')
      return finish(
        wallTimeout.timedOut()
          ? TurnStatus.PARTIAL
          : signal.aborted
            ? TurnStatus.CANCELLED
            : TurnStatus.FAILED,
        wallTimeout.timedOut()
          ? TerminalReason.BUDGET_EXCEEDED
          : signal.aborted
            ? TerminalReason.CANCELLED
            : TerminalReason.ERROR,
        wallTimeout.timedOut() ? `budget exceeded: wallTime` : signal.aborted ? null : e.message,
      )
    } finally {
      wallTimeout.cleanup()
    }
  }

  private async emit<T>(
    sessionId: SessionId,
    turnId: TurnId,
    type: string,
    data: T,
  ): Promise<void> {
    const persistedMax = (await this.options.chatStore.read()).runtime.events
      .filter((e) => e.sessionId === sessionId)
      .reduce((max, e) => Math.max(max, e.sequence), 0)
    const sequence = Math.max(this.sequence.get(sessionId) ?? 0, persistedMax) + 1
    this.sequence.set(sessionId, sequence)
    const event = {
      eventId: createEventId(),
      sequence,
      type,
      timestamp: this.clock.now(),
      sessionId,
      turnId,
      data,
    } as RuntimeEventEnvelope
    await this.options.chatStore.appendEvent(event)
    await this.options.eventSink?.append(event)
  }
}
