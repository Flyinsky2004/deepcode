import { AgentError, ErrorCode, isTransient, toAgentError } from '../core/errors.js'
import { BudgetTracker, DEFAULT_BUDGET, type AgentBudget } from '../core/budget.js'
import { EMPTY_WORKING_MEMORY, type RuntimeState, renderSystemPrompt } from '../core/context.js'
import {
  createEventId,
  type PermissionRequestId,
  type SessionId,
  type ToolCallId,
  type TurnId,
} from '../core/ids.js'
import { MessageRole, MessageSubtype } from '../core/models.js'
import {
  type ModelProvider,
  type ModelRequest,
  type ModelOverride,
  type TaskIntent,
  ModelTier,
  thinkingConfigFor,
} from '../core/provider.js'
import {
  RuntimeEventType,
  type RuntimeEventData,
  type TurnResult,
  TurnPhase,
  TurnStatus,
  TerminalReason,
  canTransition,
  ACTIVE_PHASES,
} from '../core/turn.js'
import {
  DEFAULT_PERMISSION_TIMEOUT_MS,
  PermissionMode,
  ToolExecutionStatus,
  type ToolResult,
} from '../core/tool.js'
import type { EventSink, RuntimeEventEnvelope } from '../core/events.js'
import { systemClock, type Clock } from '../core/time.js'
import type { ChatStore } from '../storage/chat-store.js'
import { argsPreview } from '../storage/audit.js'
import type { PersistedTurn } from '../storage/types.js'
import type { ModelRouter } from '../providers/router.js'
import { sameRef, type ResolvedModelRoute } from '../providers/router.js'
import type { ContextBuilder } from './context-builder.js'
import type { ContextCompactor } from './compaction.js'
import type { ToolExecutor } from '../tools/executor.js'
import { AnthropicMessagesProvider } from '../providers/anthropic.js'
import { withTimeout } from '../core/abort.js'
import {
  SkillCompiler,
  SkillResolver,
  type SkillTurnSnapshot,
  type SkillRegistry,
  shouldAdvertiseTool,
} from '../skills/index.js'

const SKILL_GUARD_AUDIT_KEYS = [
  'skill_guard_id',
  'skill_name',
  'guard_type',
  'guard_reason',
] as const

function skillGuardAuditMeta(result: ToolResult): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    SKILL_GUARD_AUDIT_KEYS.filter((key) => result.meta[key] !== undefined).map((key) => [
      key,
      result.meta[key],
    ]),
  )
}

export interface AgentRuntimeOptions {
  readonly chatStore: ChatStore
  readonly contextBuilder: ContextBuilder
  readonly toolExecutor: ToolExecutor
  /**
   * 事件出口。**必填**。
   *
   * 早先它是可选的、且运行时同时把事件写进 `chat.json`，于是漏传只是"少了一份
   * 副本"。既然那份副本已移除（无任何读取方），`eventSink` 就成了**唯一**的
   * 事件路径——再做成可选，漏传会变成"事件彻底消失"且没有任何编译期或运行期信号。
   *
   * 不需要事件的调用方请显式传 `NullEventSink`，把意图写出来。
   */
  readonly eventSink: EventSink
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
  /** 可选 skill 注册表；未注入时新 turn 不解析 skill，恢复时保留已落盘的守护。 */
  readonly skillRegistry?: SkillRegistry
}

export class AgentRuntime {
  readonly options: AgentRuntimeOptions
  readonly clock: Clock
  readonly skillResolver = new SkillResolver()
  readonly skillCompiler = new SkillCompiler()
  /**
   * 正在运行的 turn 所在的会话。`parts/09` §1.1：同一 session 默认只允许
   * 一个 active turn，第二个请求返回 `SESSION_BUSY`。
   */
  readonly busy = new Set<string>()
  constructor(options: AgentRuntimeOptions) {
    this.options = options
    this.clock = options.clock ?? systemClock
  }

  /**
   * 在 turn 第一次进入 context 阶段时解析并固定 skill。
   *
   * 解析结果作为 turn 的一部分落盘：文件在 turn 中途变化不会改变当前请求，
   * 进程重启/compact resume 也只读取这份快照。没有 registry 的新 turn 写入
   * 空快照；旧 turn 则兼容此前单独落盘的 skillGuidance/skillGuards。
   */
  private async initializeSkillSnapshot(
    sessionId: SessionId,
    turnId: TurnId,
    persisted: PersistedTurn | undefined,
    workingMemory: typeof EMPTY_WORKING_MEMORY,
  ): Promise<{
    readonly snapshot: SkillTurnSnapshot
    readonly workingMemory: typeof EMPTY_WORKING_MEMORY
  }> {
    if (persisted?.skillSnapshot !== undefined) {
      const snapshot = {
        ...persisted.skillSnapshot,
        runtimeGuards: Object.freeze([...persisted.skillSnapshot.runtimeGuards]),
      }
      return { snapshot, workingMemory }
    }

    if (this.options.skillRegistry === undefined) {
      const snapshot: SkillTurnSnapshot = {
        catalogChecksum: '',
        appliedSkills: persisted?.workingMemory.appliedSkills ?? [],
        activePhase: 'discover',
        planningInjection: persisted?.skillGuidance ?? '',
        runtimeGuards: Object.freeze([...(persisted?.skillGuards ?? [])]),
        decisionReason: '',
      }
      await this.options.chatStore.updateTurn(sessionId, turnId, {
        skillSnapshot: snapshot,
        skillGuidance: snapshot.planningInjection,
        skillGuards: snapshot.runtimeGuards,
      })
      return { snapshot, workingMemory }
    }

    const messages = await this.options.chatStore.listActiveMessages(sessionId)
    const query =
      [...messages].reverse().find((message) => message.role === MessageRole.USER)?.content ?? ''
    const catalog = this.options.skillRegistry.refresh()
    const decision = this.skillResolver.resolve(query, catalog)
    const compiled = this.skillCompiler.compile(decision)
    const snapshot: SkillTurnSnapshot = {
      catalogChecksum: catalog.checksum,
      appliedSkills: compiled.runtimeState.appliedSkills,
      activePhase: compiled.runtimeState.activePhase,
      planningInjection: compiled.planningInjection,
      runtimeGuards: compiled.runtimeGuards,
      decisionReason: compiled.runtimeState.decisionReason,
    }
    const nextMemory = {
      ...workingMemory,
      appliedSkills: [...snapshot.appliedSkills],
    }
    await this.options.chatStore.updateTurn(sessionId, turnId, {
      skillSnapshot: snapshot,
      skillGuidance: snapshot.planningInjection,
      skillGuards: snapshot.runtimeGuards,
      workingMemory: nextMemory,
    })
    // 空 catalog 不产生一条空审计消息：除了没有可观测信息外，UI 也无需因
    // 一个永远不会展示的 system message 触发历史重绘。存在有效或无效文件时，
    // 则保留完整 resolve 审计（包括 rejected/invalid 的诊断）。
    if (catalog.loadedSkills.length === 0 && catalog.invalidSkills.length === 0)
      return { snapshot, workingMemory: nextMemory }
    await this.options.chatStore.addMessage({
      conversation_id: sessionId,
      role: MessageRole.SYSTEM,
      content: JSON.stringify({
        event: 'skill.resolve.complete',
        applied_skills: snapshot.appliedSkills,
        rejected: decision.rejected,
        confidence: decision.confidence,
        skill_decision_reason: decision.reason,
        active_phase: snapshot.activePhase,
        guards_applied: snapshot.runtimeGuards.map((guard) => ({
          guard_id: guard.guardId,
          skill_name: guard.skillName,
          guard_type: guard.guardType,
          action: guard.action,
          reason: guard.reason,
        })),
      }),
      turn_id: turnId,
      subtype: MessageSubtype.SKILL_EVENT,
      tool_call_id: null,
      meta: '{}',
      agent_type: '',
    })
    if (snapshot.appliedSkills.length > 0)
      await this.emit(sessionId, turnId, RuntimeEventType.SKILL_RESOLVED, {
        applied_skills: snapshot.appliedSkills,
        active_phase: snapshot.activePhase,
        guards_applied: snapshot.runtimeGuards.length,
      })
    return { snapshot, workingMemory: nextMemory }
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
        // 预算耗尽统一先绕行 `finalizing` 再落终态。
        //
        // 迁移表（`core/turn.ts` 的 `TRANSITIONS`）里能直接进 `budget_exceeded`
        // 的只有 `calling_model` 与 `finalizing`，能进 `finalizing` 的只有
        // `calling_model`。原先只对 `executing_tools` 做了特判，于是
        // `building_context` / `compacting` / `awaiting_permission` /
        // `awaiting_user_input` 走到这里都会抛 `INVALID_STATE_TRANSITION`
        // ——而"provider 流卡死触发墙钟超时"这条最常见的路径，phase 正是
        // `calling_model` 或 `building_context`，等于把纯资源限制报成了内部错误。
        //
        // 这里**不新增迁移边**，只用既有边组合出一条合法路径：
        //   starting → building_context → calling_model → finalizing → budget_exceeded
        // 其余活动阶段都已有直达 `calling_model` 的边。语义上也一致：`finalizing`
        // 就是"预算耗尽后的收尾"，它本该是这条终态的唯一入口。
        // 取舍详见 `docs/adr/0003-turn-budget-transitions.md`。
        if (finalPhase === TurnPhase.BUDGET_EXCEEDED && phase !== TurnPhase.FINALIZING) {
          if (phase === TurnPhase.STARTING)
            await transition(TurnPhase.BUILDING_CONTEXT, 'budget checkpoint')
          if (phase !== TurnPhase.CALLING_MODEL)
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
        current_max_turns: this.options.maxTurns ?? tracker.budget.maxModelCalls,
        auto_continue_count: 0,
        last_tool_error: lastToolError,
        input_tokens: result.input_tokens,
        output_tokens: result.output_tokens,
        // 旧实现声明了 `cancelled` 却从不置真，而消费方（TUI/Web）正是靠它
        // 区分"用户取消"与"执行失败"——例如决定是否重发排队中的 prompt。
        ...(status === TurnStatus.CANCELLED ? { cancelled: true } : {}),
      })
      return result
    }
    try {
      if (phase === TurnPhase.STARTING || phase === TurnPhase.COMPACTING)
        await transition(TurnPhase.BUILDING_CONTEXT, 'start')
      else if (phase === TurnPhase.AWAITING_USER_INPUT)
        await transition(TurnPhase.CALLING_MODEL, 'resume user input')
      const initializedSkills = await this.initializeSkillSnapshot(
        sessionId,
        turnId,
        persisted,
        workingMemory,
      )
      const skillSnapshot = initializedSkills.snapshot
      workingMemory = initializedSkills.workingMemory
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
          resolvedIndex: 0,
          // 恢复时没有发生路由决策——模型是 turn 起点就定下的快照。
          // `tierRef` 取同一个值，于是 override 分支不会误报一次"路由变更"。
          tierRef: {
            providerId: persisted.routeSnapshot.provider.id,
            modelId: persisted.routeSnapshot.model.id,
          },
        }
      } else if (this.options.router) route = await this.options.router.resolve(intent, override)
      // 下标必须来自 `resolvedIndex`，**不能假定从 0 开始**：`resolve()` 会跳过
      // 配置层就不可用的候选，所以 `route.model` 未必是 `candidates[0]`。
      // 错位的后果见下方 fallback 分支。
      if (route) candidateIndex = route.resolvedIndex
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

      // 「显式 override 改了路由」也要留痕（parts/09 §6.1 / §9.5）。
      //
      // `from` 取 `route.tierRef`——**档位自己**分配的模型，而不是候选列表里的
      // 下一个。候选列表被去重过：override 与档位模型相同时会合并成一条，
      // 于是 `candidates[1]` 变成回退链的首项，"从哪来"就答错了。
      //
      // 三种情形分得很清：
      // - `tierRef` 等于当前路由 → 路由没变，**不发**（发了是噪音）；
      // - `tierRef` 是别的模型 → 发事件，`from` 是"本来会用的那个"；
      // - `tierRef` 为 `undefined`（该档位未配置或已禁用）→ 仍然发，
      //   `from` 留空串。此时没有 override 会直接抛 `MODEL_NOT_FOUND`，
      //   "从空路由换成 B"本身就是必须留痕的事实，不能因为答不出 `from` 就不发。
      const currentRef =
        route === undefined ? undefined : { providerId: route.provider.id, modelId: route.model.id }
      if (
        route !== undefined &&
        currentRef !== undefined &&
        override !== undefined &&
        (route.tierRef === undefined || !sameRef(route.tierRef, currentRef))
      )
        await this.emit(sessionId, turnId, RuntimeEventType.MODEL_ROUTE_CHANGED, {
          from_provider: route.tierRef?.providerId ?? '',
          from_model: route.tierRef?.modelId ?? '',
          to_provider: route.provider.id,
          to_model: route.model.id,
          tier: route.tier,
          reason: 'override',
          error_code: '',
          override_id: override.overrideId,
        }).catch(() => undefined)

      if (!provider || !model)
        return await finish(
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
              skillGuards: skillSnapshot?.runtimeGuards ?? [],
              turnState: { runtime_guards: skillSnapshot?.runtimeGuards ?? [] },
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
                ...skillGuardAuditMeta(result),
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
          return await (wallTimeout.timedOut()
            ? finish(
                TurnStatus.PARTIAL,
                TerminalReason.BUDGET_EXCEEDED,
                'budget exceeded: wallTime',
              )
            : finish(TurnStatus.CANCELLED, TerminalReason.CANCELLED, null))
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
            return await finish(
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
          appliedSkills: skillSnapshot?.appliedSkills ?? [],
          activePhase: skillSnapshot?.activePhase ?? 'discover',
          skillGuidance: skillSnapshot?.planningInjection ?? '',
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
        // `maxTokens` 与它折算出的思考预算必须来自**同一个**值，否则会出现
        // 「预算按 A 算、max_tokens 用 B 发」——provider 层的
        // `maxTokens > budgetTokens` 断言就会在预算大于 A 时炸掉。
        const maxTokens = route?.model.maxOutputTokens ?? 8192
        // 思考开关与强度是 **ModelProfile 的运行偏好**，缺省即关闭
        // （见 `thinkingConfigFor` 与 ADR 0004 D3）。
        //
        // 恢复路径（`persisted.routeSnapshot`）拿到的是 turn 起点落盘的**完整**
        // ModelProfile，所以中途 `/thinking` 改配置不会改变一个已在跑的 turn
        // ——这正是 parts/09 §9.1「每个 turn 开始时保存能力快照」要求的。
        const thinking = route === undefined ? undefined : thinkingConfigFor(route.model, maxTokens)
        const request: ModelRequest = {
          model: model ?? '',
          maxTokens,
          messages: envelope.conversation,
          system: renderSystemPrompt(envelope.system),
          tools: finalizationAttempted
            ? []
            : envelope.tools.filter((tool) =>
                shouldAdvertiseTool(skillSnapshot.runtimeGuards, tool.name),
              ),
          ...(thinking === undefined ? {} : { thinking }),
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
            return await finish(
              TurnStatus.CONTEXT_EXCEEDED,
              TerminalReason.CONTEXT_EXCEEDED,
              e.message,
            )
          if (runSignal.aborted)
            return await (wallTimeout.timedOut()
              ? finish(
                  TurnStatus.PARTIAL,
                  TerminalReason.BUDGET_EXCEEDED,
                  'budget exceeded: wallTime',
                )
              : finish(TurnStatus.CANCELLED, TerminalReason.CANCELLED, null))
          if (isTransient(e.code) && providerRetries < 2) {
            providerRetries += 1
            continue
          }
          const advanced =
            isTransient(e.code) && route && this.options.router
              ? await this.#nextUsableCandidate(intent, route, candidateIndex + 1)
              : undefined
          if (route && advanced !== undefined) {
            // `from` 取**当前 route**——它就是刚刚失败的那个模型。
            // ⚠️ 不能取 `candidates[candidateIndex]`：`resolve()` 会跳过配置层就
            // 不可用的候选，`candidateIndex` 与 `route.model` 可能错位，
            // 那样报出的"从 A 滑到 B"里的 A 会是**一个从未运行过的模型**，
            // 而且下一次 fallback 会重新请求刚失败的那个。
            const previous = { providerId: route.provider.id, modelId: route.model.id }
            route = advanced.route
            candidateIndex = advanced.index
            provider =
              this.options.providerFactory?.(route) ??
              new AnthropicMessagesProvider({ provider: route.provider })
            model = route.model.id
            providerRetries = 0
            // parts/09 §9.5：「切换模型后必须重新构建请求并写 model_route_changed」。
            // 用户明确指定的模型因连接失败被换掉，是**用户必须能看见**的事
            // ——否则他以为 `/workwith` 的模型跑完了整件事。
            //
            // 这里的 `catch` 是**刻意**的（与文件里其余 emit 不同）：那几处是
            // turn 的正文流（文本、工具结果），写不进去说明事件通道已经坏了，
            // turn 该失败；而本条是通知类事件，为了「让用户看见模型变了」而
            // 把整个 turn 判失败，是拿手段换目的。
            await this.emit(sessionId, turnId, RuntimeEventType.MODEL_ROUTE_CHANGED, {
              from_provider: previous.providerId,
              from_model: previous.modelId,
              to_provider: route.provider.id,
              to_model: route.model.id,
              tier: route.tier,
              reason: 'fallback',
              error_code: e.code,
              override_id: override?.overrideId ?? '',
            }).catch(() => undefined)
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
          return await finish(TurnStatus.FAILED, TerminalReason.ERROR, e.message)
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
          return await (finalizationAttempted
            ? finish(TurnStatus.PARTIAL, TerminalReason.BUDGET_EXCEEDED, null)
            : finish(TurnStatus.COMPLETED, TerminalReason.COMPLETED, null))
        if (finalizationAttempted)
          return await finish(
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
            skillGuards: skillSnapshot?.runtimeGuards ?? [],
            turnState: { runtime_guards: skillSnapshot?.runtimeGuards ?? [] },
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
              ...skillGuardAuditMeta(result),
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
          // 这条分支只在**没有审批服务**时可达（executor 仅在 `!approvalService`
          // 时返回 PERMISSION_REQUIRED）。它是"有 UI 在听但没有 broker"的兜底通知；
          // 常规路径下审批事件由审批 broker 发出，因为它才拿得到权威的 request_id。
          if (result.error_code === ErrorCode.PERMISSION_REQUIRED)
            await this.emit(sessionId, turnId, RuntimeEventType.PERMISSION_REQUIRED, {
              request_id: (typeof result.meta['request_id'] === 'string'
                ? result.meta['request_id']
                : '') as PermissionRequestId,
              tool_name: call.name,
              tool_call_id: call.id,
              tool_input: call.input,
              // 必须走脱敏的 argsPreview：`bash` 的 command 与 `file_write` 的
              // content 都含在 call.input 里。Phase 7 起这个事件会被推送到
              // 浏览器（--listen lan/public），原始参数会直接离开进程。
              args_preview: argsPreview(call.input),
              risk_level:
                typeof result.meta['risk_level'] === 'string'
                  ? result.meta['risk_level']
                  : 'medium',
              reason: result.content,
              expires_at:
                typeof result.meta['expires_at'] === 'number'
                  ? result.meta['expires_at']
                  : this.clock.nowMs() + DEFAULT_PERMISSION_TIMEOUT_MS,
            })
          tracker.recordToolCall()
          if (runSignal.aborted)
            return await (wallTimeout.timedOut()
              ? finish(
                  TurnStatus.PARTIAL,
                  TerminalReason.BUDGET_EXCEEDED,
                  'budget exceeded: wallTime',
                )
              : finish(TurnStatus.CANCELLED, TerminalReason.CANCELLED, null))
          // 这里原本有一条对 `USER_INPUT_REQUIRED` 的 `finish(PARTIAL, ERROR)`。
          // 该分支已移除：`ToolExecutor` 现在会**消化**用户提问并产出正常的
          // 工具结果（回灌答案或 `{"_timeout": true}`），因此 runtime 不会再
          // 看到这个错误码。保留一条永不触发的终止路径只会增加状态机复杂度
          // ——与 ADR 0002 §三 移除 `incomplete_tool_call` 的理由相同。
        }
        const exhausted = tracker.check()
        if (exhausted)
          return await finish(
            TurnStatus.PARTIAL,
            TerminalReason.BUDGET_EXCEEDED,
            `budget exceeded: ${exhausted.dimension}`,
          )
      }
    } catch (error) {
      const e = toAgentError(error, 'runtime')
      return await finish(
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

  /**
   * 从 `from` 起找一个**真的可用**的候选模型。
   *
   * 为什么要循环而不是只试下一个：`resolve()` 在 turn 起点就会跳过配置层
   * 不可用的候选（`router.ts` 的 for/catch），所以候选列表里可以躺着若干个
   * 一调 `resolveCandidate` 就抛的条目（模型被禁用、不支持工具、窗口太小）。
   * 只试下一个的话：一是会挑中一个注定失败的模型、二是那个模型下一轮
   * 又触发一次 fallback，把下标推着往前走——两件事都会让
   * `model_route_changed` 报出与实际不符的模型。
   *
   * 全部试完仍无可用者时返回 `undefined`，由调用方以 `FAILED` 收尾
   * ——这与 `resolve()` 起点处"没有可用模型"的处理一致。
   */
  async #nextUsableCandidate(
    intent: TaskIntent,
    route: ResolvedModelRoute,
    from: number,
  ): Promise<{ readonly route: ResolvedModelRoute; readonly index: number } | undefined> {
    const router = this.options.router
    if (!router) return undefined
    for (let index = from; index < route.candidates.length; index += 1) {
      try {
        return {
          route: await router.resolveCandidate(intent, route.candidates[index]!, route.candidates),
          index,
        }
      } catch {
        // 这个候选在配置层就不可用，继续往后找。
      }
    }
    return undefined
  }

  /**
   * 发射一个运行时事件。
   *
   * ⚠️ **序号由 `EventSink` 分配，不是这里**。生产者传 `sequence: 0` 表示"未分配"；
   * `EventLog.append` 会以 `lastSequence + 1` 覆写它并在磁盘上保持严格单调。
   *
   * 早先的实现自己维护 `sequence` Map 并**同时**写 `chatStore.appendEvent`
   * 与 `eventSink.append`，带来两个问题：
   * 1. 两份副本的序号由不同机制分配，`lastEventId` 补发无法确定该信任哪一份；
   * 2. `chatStore` 的写入是"全文件 parse → 全量 stringify → fsync"，
   *    而流式文本**每段**都发一个事件——一个 turn 内对多 MB 的 `chat.json`
   *    做几十次全量重写。
   *
   * `chat.json` 里那份副本没有任何读取方（`RuntimeDocument.events` 只写不读），
   * 因此这里只保留 `EventLog` 一条权威路径。
   */
  private async emit<T extends RuntimeEventType>(
    sessionId: SessionId,
    turnId: TurnId,
    type: T,
    data: RuntimeEventData[T],
  ): Promise<void> {
    const event = {
      eventId: createEventId(),
      sequence: 0,
      type,
      timestamp: this.clock.now(),
      sessionId,
      turnId,
      data,
    } as RuntimeEventEnvelope
    await this.options.eventSink.append(event)
  }
}
