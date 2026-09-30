import { createHash } from 'node:crypto'
import { cp, mkdir } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'

import { allocateChildBudget, type AgentBudget, type BudgetConsumption } from '../core/budget.js'
import { EMPTY_WORKING_MEMORY, type SystemPrompt, type WorkingMemory } from '../core/context.js'
import { AgentError, ErrorCode, toAgentError } from '../core/errors.js'
import type { EventSink } from '../core/events.js'
import type { ObservationSink } from '../core/observability.js'
import { createModelOverrideId, type SessionId, type TurnId } from '../core/ids.js'
import { MessageRole } from '../core/models.js'
import {
  ModelTier,
  type ModelOverride,
  type ModelProvider,
  type TaskIntent,
} from '../core/provider.js'
import {
  PermissionAction,
  PermissionMode,
  ToolCapability,
  type PermissionDecision,
  type PermissionEngine,
  type PermissionQuery,
  type SkillGuardRef,
  type ToolContext,
} from '../core/tool.js'
import { ACTIVE_PHASES, TurnStatus, type SubAgentResult, type TurnResult } from '../core/turn.js'
import { systemClock, type Clock } from '../core/time.js'
import type { ResolvedModelRoute, ModelRouter } from '../providers/router.js'
import { AgentRuntime } from '../runtime/agent-runtime.js'
import { ContextCompactor } from '../runtime/compaction.js'
import { ContextBuilder } from '../runtime/context-builder.js'
import { modePrompt, SAFETY_POLICY } from '../runtime/prompts.js'
import type { SkillRegistry } from '../skills/index.js'
import type { ChatStore } from '../storage/chat-store.js'
import type { PersistedTurn } from '../storage/types.js'
import { DefaultPermissionEngine } from '../tools/permission-engine.js'
import { ToolExecutor } from '../tools/executor.js'
import { ToolRegistry } from '../tools/registry.js'
import {
  SubAgentContextPolicy,
  SubAgentRunMode,
  SubAgentSessionStatus,
  WorkingDirectoryPolicy,
  type SubAgentDefinition,
  type SubAgentLaunchResult,
  type SubAgentRunRequest,
  type SubAgentSession,
} from './models.js'
import type { SubAgentRegistry } from './registry.js'

export interface SubAgentManagerOptions {
  readonly definitions: SubAgentRegistry
  readonly tools: ToolRegistry
  readonly chatStore: ChatStore
  readonly router?: ModelRouter
  readonly providerFactory?: (route: ResolvedModelRoute) => ModelProvider
  readonly eventSink: EventSink
  readonly observationSink?: ObservationSink
  readonly workspaceRoot: string
  readonly principalId: string
  readonly skillRegistry?: SkillRegistry
  readonly clock?: Clock
  readonly maxParallel?: number
  readonly toolTimeoutMs?: number
  readonly toolOutputLimitChars?: number
}

const ZERO_CONSUMPTION: BudgetConsumption = {
  modelCalls: 0,
  toolCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cost: 0,
  wallTimeMs: 0,
}

const READONLY_FORBIDDEN_CAPABILITIES = new Set<ToolCapability>([
  ToolCapability.WRITE,
  ToolCapability.SHELL,
  ToolCapability.NETWORK,
  ToolCapability.DATA_ACCESS,
])

/** 子代理不可以自行弹出授权；父权限链上出现 ASK 时按 DENY 收敛。 */
class ChildPermissionEngine implements PermissionEngine {
  readonly #delegate = new DefaultPermissionEngine()
  async decide(query: PermissionQuery): Promise<PermissionDecision> {
    const path = query.input['path']
    if (
      query.toolName === 'file_read' &&
      typeof path === 'string' &&
      path
        .replace(/\\/gu, '/')
        .split('/')
        .some((part) =>
          /^(?:\.env(?:\..*)?|id_(?:rsa|ed25519|ecdsa)|.*\.(?:pem|key)|credentials(?:\.json)?|secrets?(?:\..*)?)$/iu.test(
            part,
          ),
        )
    )
      return {
        action: PermissionAction.DENY,
        reason: 'sub-agent cannot read secret-bearing files by default',
        policyId: 'subagent.secret-file',
        risk: query.descriptor.risk_level,
      }
    const decision = await this.#delegate.decide(query)
    return decision.action === PermissionAction.ASK
      ? {
          ...decision,
          action: PermissionAction.DENY,
          reason: `sub-agent cannot widen parent permission: ${decision.reason}`,
          policyId: `subagent.intersection.${decision.policyId}`,
        }
      : decision
  }
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function matches(name: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/gu, '\\$&').replace(/\*/gu, '.*')
    return new RegExp(`^${escaped}$`, 'u').test(name)
  })
}

function intentFor(definition: SubAgentDefinition): TaskIntent {
  // 未显式声明档位时沿用主循环的 implementation 分配；否则一个只配置了主
  // 档位的项目会让所有内置子代理在路由阶段失败。
  const tier = definition.modelTier ?? ModelTier.IMPLEMENTATION
  return {
    tier,
    purpose:
      definition.type === 'code-reviewer' || tier === ModelTier.REVIEW
        ? 'review'
        : definition.type === 'general-purpose' || tier === ModelTier.EXPLORATION
          ? 'explore'
          : tier === ModelTier.PLANNING
            ? 'plan'
            : 'implement',
    requiresTools: true,
    requiresThinking: tier === ModelTier.REVIEW || tier === ModelTier.PLANNING,
  }
}

function remainingBudget(session: SubAgentSession): AgentBudget {
  const used = session.consumption
  const remaining = {
    maxModelCalls: session.budget.maxModelCalls - used.modelCalls,
    maxToolCalls: session.budget.maxToolCalls - used.toolCalls,
    maxWallTimeMs: session.budget.maxWallTimeMs - used.wallTimeMs,
    maxInputTokens: session.budget.maxInputTokens - used.inputTokens,
    maxOutputTokens: session.budget.maxOutputTokens - used.outputTokens,
    ...(session.budget.maxCost === undefined
      ? {}
      : { maxCost: session.budget.maxCost - used.cost }),
  }
  if (
    remaining.maxModelCalls <= 0 ||
    remaining.maxToolCalls <= 0 ||
    remaining.maxWallTimeMs <= 0 ||
    remaining.maxInputTokens <= 0 ||
    remaining.maxOutputTokens <= 0 ||
    (remaining.maxCost !== undefined && remaining.maxCost <= 0)
  )
    throw new AgentError({
      code: ErrorCode.BUDGET_EXCEEDED,
      message: 'sub-agent has no remaining budget to resume',
      source: 'subagents.manager',
    })
  return remaining
}

function numberField(value: unknown, key: string): number {
  if (typeof value !== 'object' || value === null) return 0
  const field = (value as Readonly<Record<string, unknown>>)[key]
  return typeof field === 'number' && Number.isFinite(field) ? Math.max(0, field) : 0
}

function availableParentBudget(parent: ToolContext): AgentBudget {
  const consumption = parent.turnState['budget_consumption']
  const cumulativeInput = parent.turnState['cumulative_input_tokens']
  const available = {
    maxModelCalls: parent.budget.maxModelCalls - numberField(consumption, 'modelCalls'),
    maxToolCalls: parent.budget.maxToolCalls - numberField(consumption, 'toolCalls'),
    maxWallTimeMs: parent.budget.maxWallTimeMs - numberField(consumption, 'wallTimeMs'),
    maxInputTokens:
      parent.budget.maxInputTokens -
      (typeof cumulativeInput === 'number'
        ? cumulativeInput
        : numberField(consumption, 'inputTokens')),
    maxOutputTokens: parent.budget.maxOutputTokens - numberField(consumption, 'outputTokens'),
    ...(parent.budget.maxCost === undefined
      ? {}
      : { maxCost: parent.budget.maxCost - numberField(consumption, 'cost') }),
  }
  if (
    available.maxModelCalls <= 0 ||
    available.maxToolCalls <= 0 ||
    available.maxWallTimeMs <= 0 ||
    available.maxInputTokens <= 0 ||
    available.maxOutputTokens <= 0 ||
    (available.maxCost !== undefined && available.maxCost <= 0)
  )
    throw new AgentError({
      code: ErrorCode.BUDGET_EXCEEDED,
      message: 'parent turn has no remaining budget for a sub-agent',
      source: 'subagents.manager',
    })
  return available
}

export class SubAgentManager {
  readonly options: SubAgentManagerOptions
  readonly clock: Clock
  readonly maxParallel: number
  readonly #controllers = new Map<string, AbortController>()
  readonly #tasks = new Map<string, Promise<SubAgentResult>>()
  #active = 0
  readonly #waiters: Array<() => void> = []

  constructor(options: SubAgentManagerOptions) {
    this.options = options
    this.clock = options.clock ?? systemClock
    this.maxParallel = Math.max(1, options.maxParallel ?? 4)
  }

  async launch(request: SubAgentRunRequest, parent: ToolContext): Promise<SubAgentLaunchResult> {
    const definition = this.options.definitions.get(request.agentType)
    if (!definition)
      throw new AgentError({
        code: ErrorCode.SUBAGENT_DEFINITION_INVALID,
        message: `unknown sub-agent definition: ${request.agentType}`,
        source: 'subagents.manager',
      })
    const parentDepth =
      typeof parent.turnState['subagent_depth'] === 'number'
        ? parent.turnState['subagent_depth']
        : 0
    if (
      parentDepth > 0 &&
      (!definition.allowRecursive || parentDepth >= (definition.maxDepth ?? 1))
    )
      throw new AgentError({
        code: ErrorCode.PERMISSION_DENIED,
        message: 'recursive sub-agent delegation is disabled',
        source: 'subagents.manager',
      })

    const runMode = request.runMode ?? definition.runMode
    const visibility = request.visibility ?? definition.visibility
    const selectedContext = await this.#selectContext(definition, request, parent)
    const contextSnapshotHash = createHash('sha256').update(selectedContext).digest('hex')
    const conversation = await this.options.chatStore.createConversation(
      `[sub-agent] ${definition.type}: ${request.task.slice(0, 80)}`,
      parent.sessionId,
      definition.type,
      parent.principalId,
    )
    const workingDirectory = await this.#workingDirectory(definition, conversation.id)
    const budget = allocateChildBudget(availableParentBudget(parent), definition.budget)
    const roots = this.#childRoots(request.allowedPaths ?? [], workingDirectory, parent)
    const inheritedSkillGuards = Array.isArray(parent.turnState['runtime_guards'])
      ? (parent.turnState['runtime_guards'] as readonly SkillGuardRef[])
      : []
    const now = this.clock.now()
    const session: SubAgentSession = {
      sessionId: conversation.id,
      parentSessionId: parent.sessionId,
      parentTurnId: parent.turnId,
      principalId: parent.principalId,
      agentType: definition.type,
      definitionVersion: definition.version,
      definition: { ...definition },
      status: SubAgentSessionStatus.QUEUED,
      visibility,
      contextSnapshotHash,
      continuationHandle: `subagent:${conversation.id}`,
      runMode,
      workingDirectoryPolicy: definition.workingDirectoryPolicy,
      workingDirectory,
      task: request.task,
      selectedContext,
      expectedOutput: request.expectedOutput ?? '',
      constraints: request.constraints ?? '',
      allowedPaths: roots.requested,
      allowedReadRoots: roots.read,
      allowedWriteRoots: roots.write,
      inheritedSkillGuards,
      parentMode:
        typeof parent.turnState['permission_mode'] === 'string'
          ? (parent.turnState['permission_mode'] as PermissionMode)
          : PermissionMode.NORMAL,
      budget,
      consumption: ZERO_CONSUMPTION,
      workingMemory: this.#workingMemory(definition, request, parent),
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      detached: request.detached ?? false,
      depth: parentDepth + 1,
    }
    await this.options.chatStore.addSubAgentSession(session)
    await this.#observe({
      type: 'subagent.queued',
      sessionId: parent.sessionId,
      turnId: parent.turnId,
      subagentSessionId: conversation.id,
      data: {
        agent_type: definition.type,
        run_mode: runMode,
        visibility,
        depth: session.depth,
      },
    })
    const controller = new AbortController()
    if (!session.detached)
      parent.signal.addEventListener('abort', () => controller.abort(), { once: true })
    this.#controllers.set(session.sessionId, controller)
    const task = this.#run(session, controller.signal)
    this.#tasks.set(session.sessionId, task)
    task
      .finally(() => {
        if (this.#tasks.get(session.sessionId) === task) {
          this.#controllers.delete(session.sessionId)
          this.#tasks.delete(session.sessionId)
        }
      })
      .catch(() => undefined)

    if (runMode !== SubAgentRunMode.FOREGROUND)
      return {
        accepted: true,
        sessionId: session.sessionId,
        status: SubAgentSessionStatus.QUEUED,
        continuationHandle: session.continuationHandle,
      }
    const result = await task
    const stored = await this.options.chatStore.getSubAgentSession(session.sessionId)
    return {
      accepted: true,
      sessionId: session.sessionId,
      status: stored.status,
      continuationHandle: session.continuationHandle,
      result,
    }
  }

  async resume(continuationHandle: string): Promise<SubAgentLaunchResult> {
    const sessionId = continuationHandle.replace(/^subagent:/u, '')
    let session = await this.options.chatStore.getSubAgentSession(sessionId)
    if (session.continuationHandle !== continuationHandle)
      throw new AgentError({
        code: ErrorCode.SUBAGENT_RESUME_FAILED,
        message: 'invalid sub-agent continuation handle',
        source: 'subagents.manager',
      })
    if (session.status === SubAgentSessionStatus.COMPLETED)
      throw new AgentError({
        code: ErrorCode.SUBAGENT_RESUME_FAILED,
        message: 'completed sub-agent sessions cannot be resumed',
        source: 'subagents.manager',
      })
    const previousTask = this.#tasks.get(sessionId)
    if (previousTask) {
      if (
        session.status === SubAgentSessionStatus.QUEUED ||
        session.status === SubAgentSessionStatus.RUNNING
      )
        return {
          accepted: true,
          sessionId,
          status: session.status,
          continuationHandle,
        }
      await previousTask.catch(() => undefined)
      session = await this.options.chatStore.getSubAgentSession(sessionId)
      if (session.status === SubAgentSessionStatus.COMPLETED)
        throw new AgentError({
          code: ErrorCode.SUBAGENT_RESUME_FAILED,
          message: 'completed sub-agent sessions cannot be resumed',
          source: 'subagents.manager',
        })
    }
    const controller = new AbortController()
    await this.#observe({
      type: 'subagent.resume.requested',
      sessionId: session.parentSessionId as SessionId,
      turnId: session.parentTurnId as TurnId,
      subagentSessionId: session.sessionId as SessionId,
      data: { agent_type: session.agentType },
    })
    this.#controllers.set(sessionId, controller)
    const task = this.#run(
      { ...session, budget: remainingBudget(session) },
      controller.signal,
      true,
    )
    this.#tasks.set(sessionId, task)
    task
      .finally(() => {
        if (this.#tasks.get(sessionId) === task) {
          this.#controllers.delete(sessionId)
          this.#tasks.delete(sessionId)
        }
      })
      .catch(() => undefined)
    return {
      accepted: true,
      sessionId,
      status: SubAgentSessionStatus.RUNNING,
      continuationHandle,
    }
  }

  cancel(sessionId: string): boolean {
    const controller = this.#controllers.get(sessionId)
    if (!controller) return false
    controller.abort()
    return true
  }

  status(sessionId: string): Promise<SubAgentSession> {
    return this.options.chatStore.getSubAgentSession(sessionId)
  }

  list(parentSessionId?: string): Promise<readonly SubAgentSession[]> {
    return this.options.chatStore.listSubAgentSessions(parentSessionId)
  }

  shutdown(): void {
    for (const controller of this.#controllers.values()) controller.abort()
  }

  /** 取消后等待后台子代理收尾，再关闭它们共享的观测出口。 */
  async waitForIdle(): Promise<void> {
    await Promise.allSettled([...this.#tasks.values()])
  }

  async #run(
    session: SubAgentSession,
    signal: AbortSignal,
    resume = false,
  ): Promise<SubAgentResult> {
    let acquired = false
    const startedAt = this.clock.nowMs()
    try {
      await this.#acquire(signal)
      acquired = true
      if (signal.aborted)
        throw new AgentError({
          code: ErrorCode.INVALID_STATE_TRANSITION,
          message: 'sub-agent cancelled before execution',
          source: 'subagents.manager',
        })
      await this.options.chatStore.updateSubAgentSession(session.sessionId, {
        status: SubAgentSessionStatus.RUNNING,
        updatedAt: this.clock.now(),
      })
      await this.#observe({
        type: 'subagent.started',
        sessionId: session.parentSessionId as SessionId,
        turnId: session.parentTurnId as TurnId,
        subagentSessionId: session.sessionId as SessionId,
        data: {
          agent_type: session.agentType,
          resume,
          depth: session.depth,
        },
      })
      const runtime = this.#runtime(session)
      let turn: TurnResult
      if (resume) {
        const persisted = await this.#latestTurn(session.sessionId)
        turn =
          persisted === undefined
            ? await runtime.submitMessage(
                session.sessionId as SessionId,
                this.#prompt(session, true),
                signal,
                this.#override(session),
              )
            : ACTIVE_PHASES.has(persisted.phase)
              ? await runtime.resumeTurn(
                  session.sessionId as SessionId,
                  persisted.turnId as TurnId,
                  signal,
                )
              : await runtime.submitMessage(
                  session.sessionId as SessionId,
                  this.#prompt(session, true),
                  signal,
                  this.#override(session),
                )
      } else {
        turn = await runtime.submitMessage(
          session.sessionId as SessionId,
          this.#prompt(session, false),
          signal,
          this.#override(session),
        )
      }
      const result = await this.#complete(session, turn)
      await this.#observe({
        type: 'subagent.completed',
        sessionId: session.parentSessionId as SessionId,
        turnId: session.parentTurnId as TurnId,
        subagentSessionId: session.sessionId as SessionId,
        elapsedMs: this.clock.nowMs() - startedAt,
        data: { agent_type: session.agentType, status: result.status },
      })
      return result
    } catch (error) {
      const e = toAgentError(error, 'subagents.manager')
      const status = signal.aborted ? 'cancelled' : 'failed'
      const result: SubAgentResult = {
        status,
        summary: e.message,
        findings: [],
        changes: [],
        evidence: [],
        unresolved: [session.task],
        sessionId: session.sessionId as SessionId,
        continuationHandle: session.continuationHandle,
      }
      await this.options.chatStore.updateSubAgentSession(session.sessionId, {
        status:
          status === 'cancelled' ? SubAgentSessionStatus.CANCELLED : SubAgentSessionStatus.FAILED,
        result,
        updatedAt: this.clock.now(),
        completedAt: this.clock.now(),
      })
      await this.#observe({
        type: 'subagent.completed',
        sessionId: session.parentSessionId as SessionId,
        turnId: session.parentTurnId as TurnId,
        subagentSessionId: session.sessionId as SessionId,
        elapsedMs: this.clock.nowMs() - startedAt,
        data: {
          agent_type: session.agentType,
          status,
          error_code: e.code,
          message: e.message,
        },
      })
      return result
    } finally {
      if (acquired) this.#release()
    }
  }

  #runtime(session: SubAgentSession): AgentRuntime {
    const tools = new ToolRegistry()
    for (const name of this.options.tools.names()) {
      if (!matches(name, session.definition.allowedTools)) continue
      if (matches(name, session.definition.deniedTools)) continue
      if (
        name === 'sub_agent' &&
        (!session.definition.allowRecursive || session.depth >= (session.definition.maxDepth ?? 1))
      )
        continue
      // shell 的参数不是结构化路径，无法在命令级证明它只访问父代理给出的窄根；
      // 父读范围不是整个工作目录时直接移除，保持 fail-closed。
      if (
        name === 'bash' &&
        !(session.allowedReadRoots ?? []).some(
          (root) => resolve(root) === resolve(session.workingDirectory),
        )
      )
        continue
      const tool = this.options.tools.get(name)
      // readonly 不能依赖工具名称或 shellSafety 的词法判断；任何具备写入、
      // shell 或外部数据源能力的工具都不进入子代理目录。
      if (
        session.workingDirectoryPolicy === WorkingDirectoryPolicy.READONLY &&
        tool?.descriptor.capabilities.some((capability) =>
          READONLY_FORBIDDEN_CAPABILITIES.has(capability),
        )
      )
        continue
      if (tool) tools.register(tool)
    }
    const mode =
      session.workingDirectoryPolicy === WorkingDirectoryPolicy.READONLY
        ? PermissionMode.PLAN
        : session.parentMode
    const contextBuilder = new ContextBuilder({
      chatStore: this.options.chatStore,
      tools: () => tools.descriptors(),
      systemPrompt: (_mode, skillGuidance, compactSummary): SystemPrompt => ({
        base: session.definition.systemPrompt,
        mode: modePrompt(mode),
        safety: SAFETY_POLICY,
        subagent:
          session.definition.allowRecursive === true
            ? `Recursive delegation is limited to depth ${session.definition.maxDepth ?? 1}.`
            : 'Recursive delegation is disabled. Do not call sub_agent.',
        ...(skillGuidance ? { skillGuidance } : {}),
        ...(compactSummary ? { compactSummary } : {}),
      }),
    })
    const executor = new ToolExecutor({
      registry: tools,
      permissionEngine: new ChildPermissionEngine(),
      chatStore: this.options.chatStore,
      clock: this.clock,
      ...(this.options.toolTimeoutMs === undefined
        ? {}
        : { timeoutMs: this.options.toolTimeoutMs }),
      ...(this.options.toolOutputLimitChars === undefined
        ? {}
        : { outputLimitChars: this.options.toolOutputLimitChars }),
      ...(this.options.observationSink === undefined
        ? {}
        : { observationSink: this.options.observationSink }),
    })
    return new AgentRuntime({
      chatStore: this.options.chatStore,
      contextBuilder,
      toolExecutor: executor,
      eventSink: this.options.eventSink,
      ...(this.options.observationSink === undefined
        ? {}
        : { observationSink: this.options.observationSink }),
      workspaceRoot: session.workingDirectory,
      principalId: session.principalId,
      budget: session.budget,
      mode,
      intent: intentFor(session.definition),
      initialWorkingMemory: session.workingMemory,
      inheritedSkillGuards: session.inheritedSkillGuards ?? [],
      allowedReadRoots:
        session.allowedReadRoots?.length > 0
          ? session.allowedReadRoots
          : [session.workingDirectory],
      allowedWriteRoots:
        session.workingDirectoryPolicy === WorkingDirectoryPolicy.READONLY
          ? []
          : session.allowedWriteRoots?.length > 0
            ? session.allowedWriteRoots
            : [session.workingDirectory],
      agentType: session.agentType,
      subagentDepth: session.depth,
      compactor: new ContextCompactor(this.options.chatStore),
      ...(this.options.router === undefined ? {} : { router: this.options.router }),
      ...(this.options.providerFactory === undefined
        ? {}
        : { providerFactory: this.options.providerFactory }),
      ...(this.options.skillRegistry === undefined
        ? {}
        : { skillRegistry: this.options.skillRegistry }),
    })
  }

  async #complete(session: SubAgentSession, turn: TurnResult): Promise<SubAgentResult> {
    const persisted = await this.options.chatStore.getTurn(
      session.sessionId as SessionId,
      turn.turn_id,
    )
    const executions = await this.options.chatStore.listToolExecutions(
      session.sessionId as SessionId,
    )
    const status: SubAgentResult['status'] =
      turn.status === TurnStatus.COMPLETED
        ? 'completed'
        : turn.status === TurnStatus.CANCELLED
          ? 'cancelled'
          : turn.status === TurnStatus.PARTIAL ||
              turn.status === TurnStatus.BUDGET_EXCEEDED ||
              turn.status === TurnStatus.CONTEXT_EXCEEDED
            ? 'partial'
            : 'failed'
    const contract = session.definition.resultContract
    const consumption: BudgetConsumption = {
      modelCalls: session.consumption.modelCalls + persisted.consumption.modelCalls,
      toolCalls: session.consumption.toolCalls + persisted.consumption.toolCalls,
      wallTimeMs: session.consumption.wallTimeMs + persisted.consumption.wallTimeMs,
      inputTokens: session.consumption.inputTokens + persisted.consumption.inputTokens,
      outputTokens: session.consumption.outputTokens + persisted.consumption.outputTokens,
      cost: session.consumption.cost + persisted.consumption.cost,
    }
    const summary = (turn.final_text || turn.error || 'Sub-agent produced no text.').slice(
      0,
      contract.maxSummaryChars,
    )
    const result: SubAgentResult = {
      status,
      summary,
      findings: contract.includeFindings && summary ? [{ summary }] : [],
      changes: contract.includeChanges
        ? persisted.workingMemory.fileChanges.map((change) => ({
            path: change.path,
            kind: change.kind,
            ...(change.beforeHash === null ? {} : { before_hash: change.beforeHash }),
            ...(change.afterHash === null ? {} : { after_hash: change.afterHash }),
          }))
        : [],
      evidence: contract.includeEvidence
        ? executions.map((execution) => ({
            kind: 'tool_execution',
            ref: execution.toolName,
            detail: `${execution.status}: ${execution.result?.content ?? ''}`.slice(0, 1_000),
          }))
        : [],
      unresolved:
        contract.includeUnresolved && status !== 'completed'
          ? [turn.error ?? `unfinished: ${session.task}`]
          : [],
      sessionId: session.sessionId as SessionId,
      ...(status === 'completed' ? {} : { continuationHandle: session.continuationHandle }),
    }
    await this.options.chatStore.updateSubAgentSession(session.sessionId, {
      status:
        status === 'completed'
          ? SubAgentSessionStatus.COMPLETED
          : status === 'partial'
            ? SubAgentSessionStatus.PARTIAL
            : status === 'cancelled'
              ? SubAgentSessionStatus.CANCELLED
              : SubAgentSessionStatus.FAILED,
      consumption,
      workingMemory: persisted.workingMemory,
      result,
      updatedAt: this.clock.now(),
      completedAt: this.clock.now(),
    })
    return result
  }

  async #selectContext(
    definition: SubAgentDefinition,
    request: SubAgentRunRequest,
    parent: ToolContext,
  ): Promise<string> {
    const selected = request.context?.trim() ?? ''
    if (definition.contextPolicy === SubAgentContextPolicy.MINIMAL) return selected
    if (definition.contextPolicy === SubAgentContextPolicy.PROJECT_AWARE)
      return [
        `Project: ${basename(parent.workspaceRoot)}`,
        `Root: ${parent.workspaceRoot}`,
        selected,
      ]
        .filter(Boolean)
        .join('\n')
    if (definition.contextPolicy === SubAgentContextPolicy.FILE_FOCUSED)
      return [
        `Allowed paths:\n${(request.allowedPaths ?? []).map((path) => `- ${path}`).join('\n')}`,
        selected,
      ]
        .filter(Boolean)
        .join('\n')
    if (definition.contextPolicy === SubAgentContextPolicy.FULL_PARENT_SUMMARY)
      return [
        selected,
        `Parent working memory:\n${JSON.stringify(parent.turnState['working_memory'] ?? {})}`,
      ]
        .filter(Boolean)
        .join('\n')
    const messages = await this.options.chatStore.listActiveMessages(parent.sessionId)
    const summary = messages
      .filter(
        (message) => message.role === MessageRole.USER || message.role === MessageRole.ASSISTANT,
      )
      .slice(-8)
      .map((message) => `${message.role}: ${message.content.slice(0, 1_000)}`)
      .join('\n')
    return [selected, `Parent conversation summary:\n${summary}`].filter(Boolean).join('\n')
  }

  #workingMemory(
    definition: SubAgentDefinition,
    request: SubAgentRunRequest,
    parent: ToolContext,
  ): WorkingMemory {
    const inherited = parent.turnState['working_memory']
    const parentMemory =
      inherited && typeof inherited === 'object'
        ? (inherited as WorkingMemory)
        : EMPTY_WORKING_MEMORY
    return {
      ...EMPTY_WORKING_MEMORY,
      userConstraints: request.constraints ? [request.constraints] : [],
      openTasks: [request.task],
      appliedSkills:
        definition.contextPolicy === SubAgentContextPolicy.FULL_PARENT_SUMMARY
          ? [...parentMemory.appliedSkills]
          : [],
    }
  }

  #observe(input: Parameters<ObservationSink['record']>[0]): Promise<void> {
    void this.options.observationSink?.record(input).catch(() => undefined)
    return Promise.resolve()
  }

  async #workingDirectory(definition: SubAgentDefinition, sessionId: string): Promise<string> {
    if (definition.workingDirectoryPolicy !== WorkingDirectoryPolicy.ISOLATED)
      return resolve(this.options.workspaceRoot)
    const target = join(
      this.options.workspaceRoot,
      '.deepcode',
      'subagents',
      sessionId,
      'workspace',
    )
    await mkdir(target, { recursive: true })
    await cp(this.options.workspaceRoot, target, {
      recursive: true,
      force: false,
      filter: (source) => {
        const rel = relative(this.options.workspaceRoot, source)
        return !rel
          .split(/[\\/]/u)
          .some((part) => ['.git', '.deepcode', 'node_modules'].includes(part))
      },
    })
    return target
  }

  #childRoots(
    paths: readonly string[],
    childRoot: string,
    parent: ToolContext,
  ): {
    readonly requested: readonly string[]
    readonly read: readonly string[]
    readonly write: readonly string[]
  } {
    const parentRoot = resolve(parent.workspaceRoot)
    const resolveParentRoots = (roots: readonly string[]): readonly string[] =>
      (roots.length > 0 ? roots : [parentRoot]).map((root) => resolve(parentRoot, root))
    const parentRead = resolveParentRoots(parent.allowedReadRoots)
    const parentWrite = resolveParentRoots(parent.allowedWriteRoots)
    const requestedParent = (paths.length > 0 ? paths : ['.'])
      .map((path) => resolve(parentRoot, path))
      .filter((path) => isInside(parentRoot, path))
    const mapToChild = (path: string): string =>
      childRoot === parentRoot ? path : resolve(childRoot, relative(parentRoot, path))
    const narrow = (roots: readonly string[]): readonly string[] => {
      const requested = paths.length > 0 ? requestedParent : [parentRoot]
      const allowed = requested
        .flatMap((path) =>
          roots.flatMap((root) =>
            isInside(root, path)
              ? [path]
              : isInside(path, root) && isInside(parentRoot, root)
                ? [root]
                : [],
          ),
        )
        .map(mapToChild)
      // ToolContext 的空 roots 表示“回落到 workspaceRoot”，不是“禁止全部”；
      // 因此交集为空时使用一个不存在的哨兵根，避免意外放大权限。
      return allowed.length > 0 ? [...new Set(allowed)] : [join(childRoot, '.deepcode-denied-root')]
    }
    return {
      requested: paths.length > 0 ? requestedParent.map(mapToChild) : [],
      read: narrow(parentRead),
      write: narrow(parentWrite),
    }
  }

  #prompt(session: SubAgentSession, resumed: boolean): string {
    return [
      resumed
        ? 'Continue the previously interrupted delegated task.'
        : 'Complete this delegated task.',
      `Task: ${session.task}`,
      session.selectedContext ? `Selected context:\n${session.selectedContext}` : '',
      session.constraints ? `Constraints:\n${session.constraints}` : '',
      session.expectedOutput ? `Expected output:\n${session.expectedOutput}` : '',
      'Return a concise summary with findings, evidence, changes, and unresolved items.',
    ]
      .filter(Boolean)
      .join('\n\n')
  }

  #override(session: SubAgentSession): ModelOverride | undefined {
    const ref = session.definition.modelRef
    return ref === undefined
      ? undefined
      : {
          overrideId: createModelOverrideId(),
          scope: 'next-turn',
          providerId: ref.providerId,
          modelId: ref.modelId,
          requestedBy: `sub-agent:${session.agentType}`,
          instruction: 'sub-agent definition model override',
          createdAt: this.clock.now(),
        }
  }

  async #latestTurn(sessionId: string): Promise<PersistedTurn | undefined> {
    const doc = await this.options.chatStore.read()
    return doc.runtime.turns
      .filter((turn) => turn.sessionId === sessionId)
      .sort((a, b) => b.turnNumber - a.turnNumber)[0]
  }

  async #acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted)
      throw new AgentError({
        code: ErrorCode.INVALID_STATE_TRANSITION,
        message: 'sub-agent cancelled before scheduling',
        source: 'subagents.manager',
      })
    if (this.#active < this.maxParallel) {
      this.#active += 1
      return
    }
    await new Promise<void>((resolveWait, reject) => {
      const wake = (): void => {
        signal.removeEventListener('abort', cancel)
        this.#active += 1
        resolveWait()
      }
      const cancel = (): void => {
        const index = this.#waiters.indexOf(wake)
        if (index >= 0) this.#waiters.splice(index, 1)
        reject(
          new AgentError({
            code: ErrorCode.INTERNAL_ERROR,
            message: 'sub-agent cancelled while queued',
            source: 'subagents.manager',
          }),
        )
      }
      this.#waiters.push(wake)
      signal.addEventListener('abort', cancel, { once: true })
      if (signal.aborted) cancel()
    })
  }

  #release(): void {
    this.#active = Math.max(0, this.#active - 1)
    this.#waiters.shift()?.()
  }
}
