/**
 * 组合根：把存储、模型、工具、权限与运行时装配成一个可被 UI 驱动的对象。
 *
 * ## 为什么需要它
 *
 * 在此之前没有任何 DI 装配模块——每个测试各自手工拼装
 * `ChatStore + ToolRegistry + PermissionEngine + ToolExecutor + ContextBuilder
 * + AgentRuntime`。TUI 与 Web UI 若各自拼一遍，就会形成两份彼此漂移的装配，
 * 而 `parts/09` §1.1 明确要求「Web UI 不得复制 QueryEngine、ToolExecutor 或
 * PermissionEngine」。
 *
 * ## 依赖方向
 *
 * ```
 * src/clients/{tui,web,cli}  →  src/app  →  src/runtime / tools / providers / storage  →  src/core
 * ```
 *
 * UI 只调用这里的方法，并且只能**提交输入**（消息、命令、审批决议、取消）
 * 与**消费事件**——不得直接改会话、权限或工具状态。
 */

import { randomUUID } from 'node:crypto'

import { AgentError, ErrorCode, toAgentError } from '../core/errors.js'
import type { EventSink } from '../core/events.js'
import type { ObservationSink } from '../core/observability.js'
import type { PrincipalId, SessionId, TurnId } from '../core/ids.js'
import type { PermissionMode, ApprovalService } from '../core/tool.js'
import type { UserInputService } from '../core/input.js'
import { ModelTier, type ModelOverride, type ModelProfile } from '../core/provider.js'
import { ACTIVE_PHASES, type TurnResult } from '../core/turn.js'
import { systemClock, type Clock } from '../core/time.js'
import type { AgentBudget } from '../core/budget.js'

import { ChatStore } from '../storage/chat-store.js'
import { ConfigStore } from '../storage/config-store.js'
import { EventLog } from '../storage/event-log.js'
import { resolveAppPaths, type AppPaths } from '../storage/paths.js'
import type { RecoverySnapshot, StoredProvider, TierAssignment } from '../storage/types.js'

import { ModelRouter, type ResolvedModelRoute } from '../providers/router.js'
import { AnthropicMessagesProvider } from '../providers/anthropic.js'

import { ToolRegistry } from '../tools/registry.js'
import { DefaultPermissionEngine } from '../tools/permission-engine.js'
import { ToolExecutor } from '../tools/executor.js'
import { createBuiltinTools } from '../tools/builtins.js'

import { ContextBuilder } from '../runtime/context-builder.js'
import { ContextCompactor, type Summarizer } from '../runtime/compaction.js'
import { AgentRuntime } from '../runtime/agent-runtime.js'

import { EventBus, type EventSubscriber, type EventSubscription } from './event-bus.js'
import {
  ApprovalBroker,
  type ApprovalResolutionInput,
  type ApprovalResolutionResult,
  type PendingApprovalView,
} from './approval-broker.js'
import {
  UserInputBroker,
  type PendingUserInputView,
  type UserInputAnswerInput,
  type UserInputAnswerResult,
} from './user-input-broker.js'
import { loadAppPolicy, type AppPolicy } from './policy.js'
import { canAccess, ensureLocalPrincipal } from './principal.js'
import type { ModelProvider } from '../core/provider.js'
import { SkillRegistry } from '../skills/index.js'
import { SubAgentManager, SubAgentRegistry, createSubAgentTool } from '../subagents/index.js'
import {
  McpManager,
  parseMcpServerConfigs,
  type McpConnectionFactory,
  type McpServerConfig,
} from '../mcp/index.js'
import { LocalObservationLog } from '../observability/index.js'

export interface AgentApplicationOptions {
  readonly paths?: AppPaths
  readonly workspaceRoot?: string
  readonly clock?: Clock
  readonly mode?: PermissionMode
  readonly budget?: AgentBudget
  readonly maxTurns?: number
  /** 逐项覆盖 `DEFAULT_APP_POLICY`。配置文件里的 `policy.*` 优先于它。 */
  readonly policy?: Partial<AppPolicy>
  // ── 以下全部是测试注入点；缺省时由 `create()` 自建 ─
  readonly configStore?: ConfigStore
  readonly chatStore?: ChatStore
  readonly eventLog?: EventLog
  readonly observationSink?: ObservationSink
  readonly registry?: ToolRegistry
  readonly approvalService?: ApprovalService
  readonly userInputService?: UserInputService
  readonly summarizer?: Summarizer
  readonly providerFactory?: (route: ResolvedModelRoute) => ModelProvider
  readonly skillRegistry?: SkillRegistry
  readonly subAgentRegistry?: SubAgentRegistry
  readonly mcpFactoryFor?: (config: McpServerConfig) => McpConnectionFactory
}

/** 一次 turn 提交的结果。 */
export interface SubmitTurnResult {
  readonly turnId: TurnId
  readonly result: TurnResult
}

export class AgentApplication {
  readonly paths: AppPaths
  readonly policy: AppPolicy
  readonly workspaceRoot: string
  readonly configStore: ConfigStore
  readonly chatStore: ChatStore
  readonly eventLog: EventLog
  readonly observationSink: ObservationSink
  readonly observationLog: LocalObservationLog | undefined
  readonly bus: EventBus
  readonly registry: ToolRegistry
  readonly executor: ToolExecutor
  readonly contextBuilder: ContextBuilder
  readonly router: ModelRouter
  readonly compactor: ContextCompactor
  readonly localPrincipalId: PrincipalId
  /**
   * 审批 broker。注入自定义 `approvalService` 时为 `undefined`。
   *
   * UI 通过 `resolvePermission()` 提交决议，而不是直接碰它——
   * 但那两个方法本身就是转发，所以这里也公开出来便于测试与诊断。
   */
  readonly broker: ApprovalBroker | undefined
  /** 提问 broker。注入自定义 `userInputService` 时为 `undefined`。 */
  readonly userInputBroker: UserInputBroker | undefined

  readonly #clock: Clock
  readonly #mode: PermissionMode | undefined
  readonly #budget: AgentBudget | undefined
  readonly #maxTurns: number | undefined
  readonly #providerFactory: (route: ResolvedModelRoute) => ModelProvider
  readonly skillRegistry: SkillRegistry
  readonly subAgentRegistry: SubAgentRegistry
  readonly subAgentManager: SubAgentManager
  readonly mcpManager: McpManager
  readonly #runtimes = new Map<PrincipalId, AgentRuntime>()
  readonly #controllers = new Map<SessionId, AbortController>()
  readonly #inFlight = new Map<SessionId, Promise<TurnResult>>()
  /**
   * 已同步占位、但尚未登记 `#inFlight` 的会话。
   *
   * 用于消除 `submitTurn` 里"检查忙碌"与"登记在飞"之间的 `await` 竞态窗口。
   */
  readonly #reserved = new Set<SessionId>()
  #recovery: RecoverySnapshot | undefined
  #disposed = false

  private constructor(options: {
    paths: AppPaths
    workspaceRoot: string
    policy: AppPolicy
    clock: Clock
    configStore: ConfigStore
    chatStore: ChatStore
    eventLog: EventLog
    observationSink: ObservationSink
    observationLog?: LocalObservationLog
    bus: EventBus
    registry: ToolRegistry
    executor: ToolExecutor
    contextBuilder: ContextBuilder
    router: ModelRouter
    compactor: ContextCompactor
    localPrincipalId: PrincipalId
    broker?: ApprovalBroker
    userInputBroker?: UserInputBroker
    mode?: PermissionMode
    budget?: AgentBudget
    maxTurns?: number
    providerFactory: (route: ResolvedModelRoute) => ModelProvider
    skillRegistry: SkillRegistry
    subAgentRegistry: SubAgentRegistry
    subAgentManager: SubAgentManager
    mcpManager: McpManager
  }) {
    this.paths = options.paths
    this.workspaceRoot = options.workspaceRoot
    this.policy = options.policy
    this.#clock = options.clock
    this.configStore = options.configStore
    this.chatStore = options.chatStore
    this.eventLog = options.eventLog
    this.observationSink = options.observationSink
    this.observationLog = options.observationLog
    this.bus = options.bus
    this.registry = options.registry
    this.executor = options.executor
    this.contextBuilder = options.contextBuilder
    this.router = options.router
    this.compactor = options.compactor
    this.localPrincipalId = options.localPrincipalId
    this.broker = options.broker
    this.userInputBroker = options.userInputBroker
    this.#mode = options.mode
    this.#budget = options.budget
    this.#maxTurns = options.maxTurns
    this.#providerFactory = options.providerFactory
    this.skillRegistry = options.skillRegistry
    this.subAgentRegistry = options.subAgentRegistry
    this.subAgentManager = options.subAgentManager
    this.mcpManager = options.mcpManager
  }

  /**
   * 按 `parts/09` §1.2 的顺序装配：
   * 加载配置 → 初始化 storage/event log → provider/tools → **恢复扫描**。
   *
   * 「任何必需组件初始化失败都不能启动一个'半可用'服务」——所以这里任一步
   * 抛错都直接向上传播，不返回部分构造的实例。
   *
   * 监听绑定**不在这里**：那属于表现层，且必须排在成功装配之后。
   */
  static async create(options: AgentApplicationOptions = {}): Promise<AgentApplication> {
    const clock = options.clock ?? systemClock
    const paths = options.paths ?? resolveAppPaths()
    const workspaceRoot = options.workspaceRoot ?? paths.project_dir.replace(/\/\.deepcode$/, '')

    const configStore = options.configStore ?? new ConfigStore(paths)
    await configStore.initialize()
    const chatStore = options.chatStore ?? new ChatStore(paths, clock)
    await chatStore.initialize()

    const config = await configStore.read()
    const policy = { ...loadAppPolicy(config), ...options.policy }

    const eventLog = options.eventLog ?? new EventLog(`${paths.project_dir}/events`, clock)
    const bus = new EventBus({ log: eventLog, policy, clock })
    const observationSink =
      options.observationSink ??
      new LocalObservationLog(`${paths.project_dir}/observability.ndjson`, clock)
    const observationLog =
      observationSink instanceof LocalObservationLog ? observationSink : undefined

    // principal 要在 broker 之前确定：broker 的授权回调需要它来判断
    // "谁能解决这个会话的审批"。
    const { principalId } = await ensureLocalPrincipal(configStore, chatStore)

    // 审批 broker：**审批事件由它发出**，不是 runtime（原因见 approval-broker.ts）。
    // 注入 `approvalService` 时改用注入的那个，便于测试替身。
    const broker =
      options.approvalService === undefined
        ? new ApprovalBroker({
            publisher: bus,
            policy,
            clock,
            // 默认只允许本机 principal 解决审批。
            //
            // 更细的按会话授权由表现层完成：Web 路由在调用
            // `resolvePermission()` 之前会先做 `getSession()` 归属校验，
            // 因为那里才有 principal → 会话的完整上下文。
            authorize: (who) => who === principalId,
          })
        : undefined

    // 提问 broker：与审批 broker 对称，负责发 `user_input_required` 事件
    // 并等待 UI 作答。没有它时 executor 会把提问当作"立即超时"，
    // turn 照常继续（而不是卡住）。
    const userInputBroker =
      options.userInputService === undefined
        ? new UserInputBroker({
            publisher: bus,
            policy,
            clock,
            authorize: (who) => who === principalId,
          })
        : undefined

    const registry = options.registry ?? new ToolRegistry()
    if (options.registry === undefined) {
      for (const tool of createBuiltinTools()) registry.register(tool)
    }

    const executor = new ToolExecutor({
      registry,
      permissionEngine: new DefaultPermissionEngine(),
      chatStore,
      ...(options.approvalService === undefined
        ? broker === undefined
          ? {}
          : { approvalService: broker }
        : { approvalService: options.approvalService }),
      clock,
      ...(userInputBroker === undefined ? {} : { userInputService: userInputBroker }),
      timeoutMs: policy.toolTimeoutMs,
      userInputTimeoutMs: policy.userInputTimeoutMs,
      outputLimitChars: policy.toolOutputLimitChars,
      observationSink,
    })

    const contextBuilder = new ContextBuilder({
      chatStore,
      tools: () => registry.descriptors(),
    })

    const router = new ModelRouter(() => configStore.read())
    const compactor = new ContextCompactor(chatStore, {}, options.summarizer)

    const providerFactory =
      options.providerFactory ??
      ((route: ResolvedModelRoute) => new AnthropicMessagesProvider({ provider: route.provider }))
    const skillRegistry =
      options.skillRegistry ?? new SkillRegistry(workspaceRoot, paths.global_dir)
    skillRegistry.refresh()
    const subAgentRegistry =
      options.subAgentRegistry ?? new SubAgentRegistry(workspaceRoot, paths.global_dir)
    subAgentRegistry.refresh()
    const subAgentManager = new SubAgentManager({
      definitions: subAgentRegistry,
      tools: registry,
      chatStore,
      router,
      providerFactory,
      eventSink: bus,
      observationSink,
      workspaceRoot,
      principalId,
      skillRegistry,
      clock,
      maxParallel: 4,
      toolTimeoutMs: policy.toolTimeoutMs,
      toolOutputLimitChars: policy.toolOutputLimitChars,
    })
    if (registry.get('sub_agent') === undefined)
      registry.register(createSubAgentTool(subAgentManager))

    const mcpConfigs = parseMcpServerConfigs(config.mcp_servers)
    const mcpManager = new McpManager({
      configs: mcpConfigs,
      registry,
      clock,
      observationSink,
      ...(options.mcpFactoryFor === undefined ? {} : { factoryFor: options.mcpFactoryFor }),
    })
    await mcpManager.initialize()

    const app = new AgentApplication({
      paths,
      workspaceRoot,
      policy,
      clock,
      configStore,
      chatStore,
      eventLog,
      observationSink,
      ...(observationLog === undefined ? {} : { observationLog }),
      bus,
      registry,
      executor,
      contextBuilder,
      router,
      compactor,
      localPrincipalId: principalId,
      ...(broker === undefined ? {} : { broker }),
      ...(userInputBroker === undefined ? {} : { userInputBroker }),
      ...(options.mode === undefined ? {} : { mode: options.mode }),
      ...(options.budget === undefined ? {} : { budget: options.budget }),
      ...(options.maxTurns === undefined ? {} : { maxTurns: options.maxTurns }),
      providerFactory,
      skillRegistry,
      subAgentRegistry,
      subAgentManager,
      mcpManager,
    })

    // 恢复扫描：过期权限、`RUNNING → UNKNOWN` 的工具执行、以及
    // 幂等记录的 TTL 剪枝（ChatStore 自身不做剪枝）。
    app.#recovery = await chatStore.recover()
    await app.#pruneIdempotency()

    return app
  }

  /** 启动时恢复扫描的结果。UI 据此提示"有未完成的 turn / 待审批"。 */
  recovery(): RecoverySnapshot {
    return (
      this.#recovery ?? {
        unfinishedTurns: [],
        pendingPermissions: [],
        pendingUserInputs: [],
        unknownExecutions: [],
        recoverableSubagents: [],
      }
    )
  }

  // ── 会话 ────────────────────────────────────────────────────────

  /** 该 principal 可见的会话。无权限的一律不出现，而不是报错。 */
  async listSessions(
    principalId: PrincipalId,
  ): Promise<readonly Awaited<ReturnType<ChatStore['listConversations']>>[number][]> {
    const all = await this.chatStore.listConversations()
    return all
      .filter((c) => canAccess(principalId, c, this.localPrincipalId))
      .slice(0, this.policy.sessionListLimit)
  }

  async createSession(
    principalId: PrincipalId,
    title?: string,
  ): Promise<{ readonly id: SessionId }> {
    const conversation = await this.chatStore.createConversation(
      title ?? 'New conversation',
      '',
      '',
      principalId,
    )
    return { id: conversation.id }
  }

  /**
   * 取会话并校验归属。
   *
   * 无权限时返回 `SESSION_NOT_FOUND` 而不是 `PERMISSION_DENIED`——
   * 后者会泄露"这个会话确实存在"。
   */
  async getSession(principalId: PrincipalId, sessionId: SessionId) {
    const conversation = await this.chatStore.getConversation(sessionId)
    if (!canAccess(principalId, conversation, this.localPrincipalId))
      throw new AgentError({
        code: ErrorCode.SESSION_NOT_FOUND,
        message: 'session not found',
        source: 'app',
        context: { sessionId },
      })
    return conversation
  }

  // ── turn ────────────────────────────────────────────────────────

  /**
   * 该会话当前在飞的 turn ID；没有则为 `undefined`。
   *
   * **异步**：turn ID 由 runtime 在 `beginTurn` 时生成并落盘，同步拿不到。
   * Web 的 `POST /api/turns/:id/cancel` 需要它把 URL 里的 turn 反查回会话
   * ——没有这个口子就只能扫 `chatStore` 全表，既慢又容易漏掉尚未落盘的 turn。
   */
  async currentTurnId(sessionId: SessionId): Promise<TurnId | undefined> {
    const doc = await this.chatStore.read()
    const active = doc.runtime.turns.find(
      (t) => t.sessionId === sessionId && ACTIVE_PHASES.has(t.phase),
    )
    return active === undefined ? undefined : (active.turnId as TurnId)
  }

  isBusy(sessionId: SessionId): boolean {
    return (
      this.#reserved.has(sessionId) ||
      this.#inFlight.has(sessionId) ||
      this.#runtime(this.localPrincipalId).busy.has(sessionId)
    )
  }

  /**
   * 提交一个 turn。
   *
   * `signal` 由调用方提供——runtime 没有 `cancel()` 方法，取消只能靠 abort。
   * 这里同时把它登记进 `#controllers`，使 `cancelTurn()` 能按 session 找到它。
   */
  async submitTurn(input: {
    readonly principalId: PrincipalId
    readonly sessionId: SessionId
    readonly prompt: string
    readonly override?: ModelOverride
    readonly signal?: AbortSignal
  }): Promise<SubmitTurnResult> {
    this.#assertAlive()

    // ⚠️ 占位必须是**同步**的，排在第一个 `await` 之前。
    //
    // `getSession()` 是异步的，若把忙碌检查放在它之后，两个几乎同时到达的
    // 请求会双双通过检查——这正是"同一会话只能有一个 active turn"要防的。
    // runtime 内部还有一道 `busy` 检查兜底，但那时错误会以
    // `source: 'runtime'` 抛出，且已经白跑了一次存储读取。
    if (this.#reserved.has(input.sessionId))
      throw new AgentError({
        code: ErrorCode.SESSION_BUSY,
        message: 'session already has an active turn',
        source: 'app',
        context: { sessionId: input.sessionId },
      })
    this.#reserved.add(input.sessionId)

    const controller = new AbortController()
    const relay = (): void => {
      controller.abort()
    }
    input.signal?.addEventListener('abort', relay, { once: true })

    // ️ `#controllers` 与 `#inFlight` 都必须与 `#reserved` 在**同一个同步段**
    // 里登记，否则会出现一个窗口：`isBusy()` 已为真，但这两个表里都还没有
    // 对应项。在那个窗口内：
    //   - `cancelTurn()` 找不到 controller → **静默返回 false**
    //     （用户点了取消、界面显示正在取消、实际什么也没发生）；
    //   - `awaitTurn()` 找不到 in-flight promise → 立刻返回 `undefined`
    //     （`/workwith` 的打断路径会误判"旧 turn 已结束"）。
    // 两者都只在"提交后立刻操作"时出现，人工点按几乎撞不上，但 TUI / Web /
    // CLI 走的是同一条路径，三端都会中招。
    //
    // in-flight 用一个手写 deferred 提前登记：真正的 runtime promise 要到
    // `await getSession()` 之后才会产生，但调用方不该被迫感知这个内部时序。
    let settleInFlight: (result: TurnResult) => void = () => undefined
    let failInFlight: (error: unknown) => void = () => undefined
    const inFlight = new Promise<TurnResult>((resolve, reject) => {
      settleInFlight = resolve
      failInFlight = reject
    })
    // 挂一个不抛的观察者：提交阶段失败时，调用方是通过 `submitTurn` 的 throw
    // 拿到错误的，未必有人去 `awaitTurn`。没有这一行会产生 unhandled rejection。
    // 它不影响 `awaitTurn` —— 那里 `await pending` 仍会收到同一个拒绝。
    inFlight.catch(() => undefined)
    this.#controllers.set(input.sessionId, controller)
    this.#inFlight.set(input.sessionId, inFlight)

    try {
      await this.getSession(input.principalId, input.sessionId)
      const runtime = this.#runtime(input.principalId)
      const promise = runtime.submitMessage(
        input.sessionId,
        input.prompt,
        controller.signal,
        input.override,
      )
      // 把真实 promise 桥接到已登记的 deferred 上。`then` 同时消费掉
      // 拒绝，避免产生 unhandled rejection（调用方拿到的仍是同一个结果）。
      promise.then(settleInFlight, failInFlight)

      const result = await promise
      return { turnId: result.turn_id, result }
    } catch (error) {
      // 提交阶段（取会话、启动 runtime）失败时，deferred 还没有人接管；
      // 必须在这里让它落定，否则 `awaitTurn()` 会永远等下去。
      failInFlight(error)
      throw error
    } finally {
      input.signal?.removeEventListener('abort', relay)
      this.#reserved.delete(input.sessionId)
      this.#inFlight.delete(input.sessionId)
      this.#controllers.delete(input.sessionId)
    }
  }

  /**
   * 取消该会话正在跑的 turn。
   *
   * ⚠️ abort 之后 `runtime.busy` **不会立刻**清空——它是在 `finish()` 的
   * finally 里清的，而 `finish()` 还要写存储。因此调用方若打算紧接着提交
   * 新 turn（例如 `/workwith` 的打断路径），必须先 `await awaitTurn()`，
   * 否则会拿到一个"刚点了取消却说会话忙"的 `SESSION_BUSY`。
   */
  cancelTurn(sessionId: SessionId, reason = 'user'): boolean {
    const controller = this.#controllers.get(sessionId)
    if (!controller) return false
    controller.abort()
    this.bus
      .publish({
        sessionId,
        type: 'cancel_requested',
        data: { reason, requestedAt: this.#clock.now() },
      })
      .catch(() => undefined)
    return true
  }

  /** 等待该会话的在飞 turn 结束；无在飞 turn 时立即返回。 */
  async awaitTurn(sessionId: SessionId): Promise<TurnResult | undefined> {
    const pending = this.#inFlight.get(sessionId)
    if (!pending) return undefined
    try {
      return await pending
    } catch {
      return undefined
    }
  }

  // ── 事件 ───────────────────────────────────────────────────────

  /**
   * 订阅某会话的事件流。
   *
   * 传 `lastEventId` 时做补发；锚点失效或积压过大时抛
   * `EVENT_RESYNC_REQUIRED`，调用方应转为"重建视图后重订阅"。
   */
  attach(
    subscriber: EventSubscriber,
    options: { readonly sessionId: SessionId; readonly lastEventId?: string },
  ): Promise<EventSubscription> {
    return this.bus.subscribe(options.sessionId, subscriber, options)
  }

  /** 供 UI 直接落盘自身事件（如命令审计）。 */
  get eventSink(): EventSink {
    return this.bus
  }

  /** 刷新 skill 文件并返回脱敏的面板数据。 */
  listSkills() {
    const snapshot = this.skillRegistry.refresh()
    return {
      loadedSkills: snapshot.loadedSkills.map((skill) => ({
        ref: skill.manifest.ref,
        source: skill.manifest.source,
        description: skill.manifest.description,
        category: skill.manifest.category,
        tags: skill.manifest.tags,
        path: skill.path,
      })),
      invalidSkills: snapshot.invalidSkills,
      checksum: snapshot.checksum,
    }
  }

  listSubAgents(parentSessionId?: string) {
    return this.subAgentManager.list(parentSessionId)
  }

  listMcpServers() {
    return this.mcpManager.statuses()
  }

  reconnectMcpServer(serverId: string) {
    return this.mcpManager.reconnect(serverId)
  }

  // ─ 回灌 ──────────────────────────────────────────────────────

  /**
   * 提交审批决议。UI 的唯一审批入口。
   *
   * 幂等：同一 `requestId` 重复提交返回首次结果（`duplicate: true`），
   * 这样浏览器刷新导致的重复提交不会变成错误。
   */
  resolvePermission(input: ApprovalResolutionInput): Promise<ApprovalResolutionResult> {
    if (!this.broker)
      return Promise.resolve({
        ok: false,
        code: ErrorCode.INTERNAL_ERROR,
        message: '当前未启用审批 broker（注入了自定义 approvalService）',
      })
    return this.broker.resolve(input)
  }

  /** 待审批项。刚连上的客户端用它补齐错过的审批事件。 */
  listPendingApprovals(sessionId?: SessionId): readonly PendingApprovalView[] {
    return this.broker?.listPending(sessionId) ?? []
  }

  /**
   * 提交提问的作答。与 `resolvePermission()` 对称。
   *
   * `answers: null` 表示用户放弃作答，等价于超时——turn **不会**因此失败，
   * 而是收到 `{"_timeout": true}` 继续工作。
   */
  answerUserInput(input: UserInputAnswerInput): Promise<UserInputAnswerResult> {
    if (!this.userInputBroker)
      return Promise.resolve({
        ok: false,
        code: ErrorCode.INTERNAL_ERROR,
        message: '当前未启用提问 broker（注入了自定义 userInputService）',
      })
    return this.userInputBroker.answer(input)
  }

  /** 当前时刻（可注入时钟）。命令层用它生成时间戳，便于测试。 */
  now(): string {
    return this.#clock.now()
  }

  /**
   * 直接改全局配置文档。
   *
   * 只给 `CommandHostAdapter` 用——命令层通过受限的 `CommandConfigView`
   * 表达意图，适配器在这里把它合并回真正的文档。
   */
  updateConfigRaw(
    mutator: (
      doc: Awaited<ReturnType<ConfigStore['read']>>,
    ) => Awaited<ReturnType<ConfigStore['read']>>,
  ): Promise<void> {
    return this.configStore.update(mutator).then(() => undefined)
  }

  /**
   * 改某个档位所用模型的**运行偏好**（`/thinking`、`/reasoning`、`/effort`）。
   *
   * 目标是该档位当前指向的 `ModelProfile`，不是会话状态——偏好跟着模型走，
   * 这样切档位时行为一致。
   */
  async updateModelPreferences(
    tier: ModelTier,
    patch: { readonly thinkingEnabled?: boolean; readonly reasoningEffort?: string },
  ): Promise<void> {
    await this.#updateActiveProfile(tier, (m) => ({
      ...m,
      ...(patch.thinkingEnabled === undefined ? {} : { thinkingEnabled: patch.thinkingEnabled }),
      ...(patch.reasoningEffort === undefined ? {} : { reasoningEffort: patch.reasoningEffort }),
    }))
  }

  /**
   * 改某个档位所用模型的**上下文窗口**（`/1M`）。
   *
   * 与 `thinkingEnabled` / `reasoningEffort` 不同，`contextWindow` 是**能力声明**
   * （`parts/09` §9.2），所以"能不能切"由命令层按 `supports1MContext` 判定，
   * 这里只负责写。同理，这里也**不**替用户夹取值——拒绝发生在命令层，
   * 而不是静默改成一个别的大小。
   */
  async setModelContextWindow(tier: ModelTier, contextWindow: number): Promise<void> {
    await this.#updateActiveProfile(tier, (m) => ({ ...m, contextWindow }))
  }

  /**
   * 把某个档位指到另一个模型（`/model use`）。
   *
   * **保留既有 assignment 的其余字段**（`fallbackModelRefs`、`maxCostPerTurn`、
   * `enabled`）——换模型不等于清空回退策略和成本上限。此前适配器重建整条
   * assignment 时会静默丢掉 `maxCostPerTurn`，那是另一条需要修的路径
   * （见 `CommandHostAdapter.updateConfig`）。
   *
   * `fallbackModelRefs` 跨 provider 保留是有意的：回退列表本就允许指向别的
   * provider，清空它属于"顺手改掉用户配置"。
   */
  async assignTierModel(tier: ModelTier, providerId: string, modelId: string): Promise<void> {
    await this.configStore.update((current) => {
      const existing = current.tier_assignments.find((t) => t.tier === tier)
      const next: TierAssignment = {
        ...(existing ?? { tier, enabled: true, fallbackModelRefs: [] }),
        tier,
        modelRef: { providerId, modelId },
      }
      return {
        ...current,
        tier_assignments: [...current.tier_assignments.filter((t) => t.tier !== tier), next],
      }
    })
  }

  /**
   * 安全新增 provider：只创建环境变量 SecretRef，不接收或保存明文 key。
   * 第一个模型在 implementation 尚未配置时自动成为主模型。
   */
  async addProviderConfiguration(input: {
    readonly name: string
    readonly baseUrl: string
    readonly modelIds: readonly string[]
    readonly contextWindow: number
    readonly maxOutputTokens: number
  }): Promise<{
    readonly providerId: string
    readonly envName: string
    readonly modelIds: readonly string[]
    readonly assignedImplementation: boolean
  }> {
    const providerId = `provider_${randomUUID()}`
    const existing = await this.configStore.read()
    const envStem = input.name
      .normalize('NFKD')
      .replace(/[^a-zA-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .toUpperCase()
    const baseEnvName = `DEEPCODE_${envStem || 'PROVIDER'}_API_KEY`
    const usedEnvNames = new Set(
      existing.providers.flatMap((provider) =>
        provider.apiKeyRef.source === 'env' ? [provider.apiKeyRef.key] : [],
      ),
    )
    const envName = usedEnvNames.has(baseEnvName)
      ? `${baseEnvName}_${providerId.slice(-8).toUpperCase()}`
      : baseEnvName
    const now = this.now()
    const provider: StoredProvider = {
      id: providerId,
      name: input.name.trim(),
      baseUrl: input.baseUrl.replace(/\/+$/, ''),
      apiKeyRef: { source: 'env', key: envName },
      createdAt: now,
      updatedAt: now,
      enabled: true,
    }
    const modelIds = input.modelIds.map((modelId) => modelId.trim())
    const profiles: ModelProfile[] = modelIds.map((modelId) => ({
      id: modelId,
      providerId,
      displayName: modelId,
      contextWindow: input.contextWindow,
      maxOutputTokens: input.maxOutputTokens,
      // Agent 主循环依赖工具调用，因此安全入口默认声明 tools；其余能力保持
      // 保守关闭，用户确认 endpoint 支持后可在 config.json 中显式开启。
      supportsThinking: false,
      supportsTools: true,
      supportsVision: false,
      supports1MContext: false,
      enabled: true,
    }))
    const firstModel = modelIds[0]
    if (firstModel === undefined)
      throw new AgentError({
        code: ErrorCode.VALIDATION_FAILED,
        message: 'provider requires at least one model',
        source: 'app',
      })
    const { assignmentAdded } = await this.configStore.addProviderBundle(provider, profiles, {
      tier: ModelTier.IMPLEMENTATION,
      modelRef: { providerId, modelId: firstModel },
      enabled: true,
      fallbackModelRefs: [],
    })
    return {
      providerId,
      envName,
      modelIds,
      assignedImplementation: assignmentAdded,
    }
  }

  /**
   * 「档位 → 它当前指向的 `ModelProfile` → 改它」，三个 setter 共用。
   *
   * ⚠️ **找不到目标就抛错，不静默返回。**
   *
   * 早先这里 `if (!assignment) return`：档位不存在、或档位指向的 profile 已经
   * 不在配置里时，写入被**无声丢弃**，调用方照样拿到一个"成功"。
   * 这与 ADR 0004 D9 修掉的那个问题是同一族——"你让我改东西，我什么也没改，
   * 而且不告诉你"。命令层已经在调它之前用 `findPrimaryModel` 挡了一道，
   * 所以正常路径上不会看到这个错误；它挡住的是并发删除档位、
   * 以及"配置里留着一个指向已删 profile 的悬空分配"这类状态。
   *
   * 抛错同时保证**不会误改别的模型**：检查在写之前，没有任何 profile 被触碰。
   */
  async #updateActiveProfile(
    tier: ModelTier,
    update: (profile: ModelProfile) => ModelProfile,
  ): Promise<void> {
    const doc = await this.configStore.read()
    const assignment = doc.tier_assignments.find((t) => t.tier === tier)
    if (!assignment)
      throw new AgentError({
        code: ErrorCode.MODEL_NOT_FOUND,
        message: `tier ${tier} has no assignment`,
        source: 'app',
        context: { tier },
      })
    const { providerId, modelId } = assignment.modelRef
    const updated = await this.configStore.update((current) => ({
      ...current,
      model_profiles: current.model_profiles.map((m) =>
        m.providerId === providerId && m.id === modelId ? update(m) : m,
      ),
    }))
    // 档位存在但指向的 profile 不在配置里（悬空分配）：上面的 map 一个都没改。
    // 同样是"没写成"，同样不能报成功。
    if (!updated.model_profiles.some((m) => m.providerId === providerId && m.id === modelId))
      throw new AgentError({
        code: ErrorCode.MODEL_NOT_FOUND,
        message: `tier ${tier} points at a missing model: ${providerId}/${modelId}`,
        source: 'app',
        context: { tier, providerId, modelId },
      })
  }

  /** 待回答的提问。 */
  listPendingUserInputs(sessionId?: SessionId): readonly PendingUserInputView[] {
    return this.userInputBroker?.listPending(sessionId) ?? []
  }

  // ── 生命周期 ───────────────────────────────────────────────────

  /** 等待全部待处理的事件写入完成。优雅关闭时调用。 */
  async flush(): Promise<void> {
    await this.bus.flush()
    await this.observationSink.flush?.()
  }

  /**
   * 释放资源。**先取消在飞的 turn**，再断开订阅者。
   *
   * 不做 `await` 到底——调用方（Web server 的优雅关闭）需要自己控制等待上限，
   * 用 `awaitTurn()` / `Promise.allSettled` 配合超时。
   */
  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    for (const controller of this.#controllers.values()) controller.abort()
    this.subAgentManager.shutdown()
    void this.mcpManager.shutdown()
    this.bus.close()
    this.eventLog.close()
  }

  get disposed(): boolean {
    return this.#disposed
  }

  #assertAlive(): void {
    if (this.#disposed)
      throw new AgentError({
        code: ErrorCode.WEB_SHUTTING_DOWN,
        message: 'application is shutting down',
        source: 'app',
      })
  }

  /**
   * 取该 principal 的 runtime，首次访问时创建。
   *
   * **必须 per-principal**：`AgentRuntimeOptions.principalId` 在构造期固定，
   * 且它同时决定 `beginTurn(…principalId)` 与 `ToolContext.principalId`。
   * Web 下每个用户一个 principal，因此只能一个 principal 一个实例。
   */
  #runtime(principalId: PrincipalId): AgentRuntime {
    const existing = this.#runtimes.get(principalId)
    if (existing) return existing
    const runtime = new AgentRuntime({
      chatStore: this.chatStore,
      contextBuilder: this.contextBuilder,
      toolExecutor: this.executor,
      eventSink: this.bus,
      observationSink: this.observationSink,
      router: this.router,
      providerFactory: this.#providerFactory,
      compactor: this.compactor,
      workspaceRoot: this.workspaceRoot,
      principalId,
      clock: this.#clock,
      ...(this.#mode === undefined ? {} : { mode: this.#mode }),
      ...(this.#budget === undefined ? {} : { budget: this.#budget }),
      ...(this.#maxTurns === undefined ? {} : { maxTurns: this.#maxTurns }),
      skillRegistry: this.skillRegistry,
    })
    this.#runtimes.set(principalId, runtime)
    return runtime
  }

  /** 删除过期的幂等记录。`ChatStore` 自身没有剪枝能力。 */
  async #pruneIdempotency(): Promise<void> {
    const cutoff = Date.parse(this.#clock.now()) - this.policy.idempotencyTtlMs
    if (!Number.isFinite(cutoff)) return
    const doc = await this.chatStore.read()
    const kept = doc.runtime.idempotency.filter((record) => {
      const at = Date.parse(record.createdAt)
      return !Number.isFinite(at) || at >= cutoff
    })
    if (kept.length === doc.runtime.idempotency.length) return
    await this.chatStore.update((current) => ({
      ...current,
      runtime: { ...current.runtime, idempotency: kept, revision: current.runtime.revision + 1 },
    }))
  }
}

/** 统一的启动错误包装，让 CLI 能打印一条可读原因后退出。 */
export function describeStartupFailure(error: unknown): AgentError {
  return toAgentError(error, 'app.startup')
}
