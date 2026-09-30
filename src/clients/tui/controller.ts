/**
 * TUI 控制器：状态机 + 效果执行 + 事件订阅。
 *
 * 它把三件事接起来，而这三件事各自都不依赖 React：
 *
 * ```
 * AgentApplication ──事件──▶ applyEvent ──▶ TuiState ──▶ 视图（app.tsx）
 *        ▲                                      │
 *        └──────────── 效果（submitTurn / resolvePermission / …）
 * ```
 *
 * ## 为什么不让 React 组件直接调 `AgentApplication`
 *
 * `parts/09` §1 的边界是"UI 只能发 `UserMessage` / `CommandRequest` /
 * `PermissionResolution` / `CancelRequest`，只能消费事件流"。把这条边界放在
 * 控制器里，组件就只剩渲染——顺带得到一个可脱离 Ink 测试的装配
 * （`tests/tui/*.test.ts` 里绝大多数断言都不需要起渲染器）。
 *
 * ## 消息区的真相源
 *
 * `refreshHistory()` 每次都从 `ChatStore.listMessages()` 读盘（§12.1 不变量 3）。
 * 内存里**不维护消息列表**——那样会在"引擎写了但 UI 没同步"时出现两份历史。
 */

import type { AgentApplication } from '../../app/agent-application.js'
import { CommandResultCode, type CommandResult } from '../../commands/types.js'
import type { CommandRegistry } from '../../commands/registry.js'
import type { CommandHost } from '../../commands/types.js'
import type { RuntimeEventEnvelope } from '../../core/events.js'
import type { SessionId } from '../../core/ids.js'
import { MessageSubtype } from '../../core/models.js'
import { PermissionMode } from '../../core/tool.js'

import { applyEvent } from './events.js'
import { applyInputChanged, editInputValue, submitInput, type CommandEntry } from './input.js'
import { handleKey, type KeyInput } from './keys.js'
import { translate } from './i18n/index.js'
import { TKey } from './i18n/keys.js'
import { Language } from './i18n/keys.js'
import { commandNameOf, commandViewOf } from './command-view.js'
import { describePrimaryModel, extractTodos } from './sources.js'
import { createInitialState, type Panel, type TuiEffect, type TuiState } from './types.js'

/** spinner 帧间隔（`app.py:466`，120ms）。 */
export const SPINNER_INTERVAL_MS = 120

/** 流式重绘节流窗口（`_stream_render_interval = 0.05`）。 */
export const STREAM_RENDER_INTERVAL_MS = 50

/** 控制器需要的依赖。 */
export interface TuiControllerOptions {
  readonly app: AgentApplication
  readonly registry: CommandRegistry
  readonly host: CommandHost
  /** 命令菜单的数据源。默认取 `registry.list()`。 */
  readonly commands?: readonly CommandEntry[]
  /** 注入时钟，便于测试双击 Esc 与节流。 */
  readonly now?: () => number
  /** 注入定时器，便于测试 spinner。 */
  readonly setTimeoutFn?: (handler: () => void, ms: number) => unknown
  readonly clearTimeoutFn?: (handle: unknown) => void
}

/** 一次 `applyInput` 的结果（供测试断言"这键被谁吃了"）。 */
export interface InputApplyResult {
  readonly handledByApp: boolean
}

/**
 * 控制器。
 *
 * 状态通过 `getState()` 暴露；`subscribe()` 用于 React 的
 * `useSyncExternalStore`。
 */
export class TuiController {
  readonly #app: AgentApplication
  readonly #registry: CommandRegistry
  readonly #host: CommandHost
  readonly #commands: readonly CommandEntry[]
  readonly #now: () => number
  readonly #setTimeout: (handler: () => void, ms: number) => unknown
  readonly #clearTimeout: (handle: unknown) => void

  #state: TuiState
  /** 已发布的快照（50ms 节流的产物）。 */
  #published: TuiState
  #listeners = new Set<() => void>()
  #subscription: { unsubscribe(): void } | undefined
  #spinnerTimer: unknown
  #disposed = false
  /** 命令执行用的 AbortController（关闭时一并中止）。 */
  #commandAbort = new AbortController()

  constructor(options: TuiControllerOptions) {
    this.#app = options.app
    this.#registry = options.registry
    this.#host = options.host
    this.#commands =
      options.commands ??
      options.registry.list().map((definition) => ({
        name: definition.name,
        description: definition.description,
      }))
    this.#now = options.now ?? (() => Date.now())
    this.#setTimeout = options.setTimeoutFn ?? ((handler, ms) => setTimeout(handler, ms))
    this.#clearTimeout = options.clearTimeoutFn ?? ((handle) => clearTimeout(handle as never))

    this.#state = createInitialState({ principalId: options.app.localPrincipalId })
    this.#published = this.#state
  }

  // ─ 对外读取 ───────────────────────────────────────────────────

  /** 完整状态（不受节流影响）。 */
  getState(): TuiState {
    return this.#state
  }

  /** React `useSyncExternalStore` 的快照（流式文本受 50ms 节流）。 */
  getSnapshot(): TuiState {
    return this.#published
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  /** 命令候选（渲染命令菜单用）。 */
  get commands(): readonly CommandEntry[] {
    return this.#commands
  }

  // ─ 生命周期 ───────────────────────────────────────────────────

  /**
   * 订阅事件流、读回持久化设置、把恢复扫描的结果落到界面。
   *
   * 语言必须在**首次渲染之前**读回来（旧实现 `_load_language()` 排在
   * `compose()` 的 widget 构造之前，否则首屏文案是错的）。
   */
  async start(): Promise<void> {
    await this.#loadLanguage()
    await this.#refreshStatusModel()
    await this.#bindSubscription()
    this.#commit(this.#state)
  }

  /** 读 `app_settings.language`（非法值退回当前语言）。 */
  async #loadLanguage(): Promise<void> {
    try {
      const config = await this.#app.configStore.read()
      const stored = config.app_settings['language']
      if (stored === Language.EN || stored === Language.ZH)
        this.#commit({ ...this.#state, language: stored })
    } catch {
      // 读不到配置就沿用默认语言——这是展示设置，不值得让启动失败。
    }
  }

  /**
   * 优雅关闭（T-15）。
   *
   * 旧实现**没有 `on_unmount`**，清理只写在 `action_quit` 里，异常退出时
   * MCP 与可观测性都不清理（§12.2 最后一项）。这里把顺序固定下来：
   * 取消在飞 turn → 断开订阅 → 冲刷事件日志 → 释放应用。
   */
  async shutdown(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    this.#stopSpinner()
    this.#commandAbort.abort()
    for (const sessionId of this.#sessionIds()) this.#app.cancelTurn(sessionId, 'shutdown')
    this.#subscription?.unsubscribe()
    this.#subscription = undefined
    await this.#app.flush().catch(() => undefined)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        this.#app.shutdown(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, this.#app.policy.shutdownPersistMs)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  #sessionIds(): readonly SessionId[] {
    return this.#state.sessionId === undefined ? [] : [this.#state.sessionId]
  }

  // ── 输入入口（供 Ink 组件调用）──────────────────────────────────

  /**
   * 处理一次按键。
   *
   * 顺序与旧实现一致：**应用层先判**（`App.on_key`），未被接管的键再交给
   * 输入框编辑器（Textual `Input`），编辑器改动了值就触发
   * `on_input_changed`（§3.3/§3.4）。
   */
  applyKey(key: KeyInput): InputApplyResult {
    const decided = handleKey(this.#state, key, this.#now())
    if (decided.handled) {
      this.#commit(decided.state)
      void this.#runEffects(decided.effects)
      return { handledByApp: true }
    }

    if (key.name === 'enter') {
      const submitted = submitInput(decided.state, { commands: this.#commands })
      this.#commit(submitted.state)
      void this.#runEffects(submitted.effects)
      return { handledByApp: true }
    }

    const edited = editInputValue(decided.state.input, decided.state.cursor, key)
    if (!edited.changed) {
      // 值没变但光标可能动了（左右 / Home / End）——输入框的光标位置是可见的，
      // 因此同样要提交一次，否则光标移动不会重绘。
      if (edited.cursor !== decided.state.cursor)
        this.#commit({ ...decided.state, cursor: edited.cursor })
      return { handledByApp: false }
    }
    const moved = {
      ...decided.state,
      input: edited.value,
      cursor: edited.cursor,
    }
    this.#commit(applyInputChanged(moved, this.#inputContext()))
    return { handledByApp: false }
  }

  /** 直接设置输入框内容（测试与粘贴用）。 */
  setInput(value: string): void {
    const next = { ...this.#state, input: value, cursor: value.length }
    this.#commit(applyInputChanged(next, this.#inputContext()))
  }

  #inputContext(): { commands: readonly CommandEntry[]; workspaceRoot: string } {
    return { commands: this.#commands, workspaceRoot: this.#app.workspaceRoot }
  }

  // ── 效果执行 ───────────────────────────────────────────────────

  /**
   * 按序执行效果。
   *
   * 单个效果失败**不中断后续效果**，也不静默吞掉：错误升级成 `lastError`
   * 显示在消息区（`CLAUDE.md`：错误必须显式处理，不得静默吞掉）。
   * 中断整条链会让"提交成功但历史没刷新"这类半完成状态更难诊断。
   */
  async #runEffects(effects: readonly TuiEffect[]): Promise<void> {
    for (const effect of effects) {
      if (this.#disposed) return
      try {
        await this.#runEffect(effect)
      } catch (error) {
        this.#commit({
          ...this.#state,
          lastError: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  async #runEffect(effect: TuiEffect): Promise<void> {
    switch (effect.kind) {
      case 'cancel-turn': {
        const sessionId = this.#state.sessionId
        if (sessionId !== undefined) this.#app.cancelTurn(sessionId, effect.reason)
        return
      }

      case 'resolve-permission': {
        const sessionId = this.#state.sessionId
        await this.#app.resolvePermission({
          requestId: effect.requestId,
          decision: effect.decision,
          principalId: this.#app.localPrincipalId,
          resolvedBy: 'user',
          ...(effect.grantScope === 'tool' && sessionId !== undefined
            ? {
                grantScope: {
                  kind: 'tool' as const,
                  toolName: effect.toolName,
                  sessionId,
                  // 授权必须有过期时间，统一由应用策略生成。
                  expiresAt: this.#app.grantExpiresAt(),
                },
              }
            : {}),
          reason: effect.reason,
        })
        await this.#refreshStatusModel()
        return
      }

      case 'answer-user-input':
        await this.#app.answerUserInput({
          requestId: effect.requestId,
          principalId: this.#app.localPrincipalId,
          answers: effect.answers,
          reason: effect.reason,
        })
        return

      case 'render-history':
        await this.refreshHistory()
        return

      case 'refresh-todos':
        await this.refreshTodos()
        return

      case 'select-session':
        this.#commit({
          ...this.#state,
          sessionId: effect.sessionId as SessionId,
          messages: [],
          todos: [],
          todoVisible: false,
          panel: undefined,
          notice: undefined,
          emptyStateVisible: false,
        })
        await this.#loadPromptHistory(effect.sessionId as SessionId)
        await this.#restoreAccounting(effect.sessionId as SessionId)
        await this.#bindSubscription()
        return

      case 'load-prompt-history':
        if (this.#state.sessionId !== undefined)
          await this.#loadPromptHistory(this.#state.sessionId)
        return

      case 'submit-prompt':
        await this.submitPrompt(effect.prompt)
        return

      case 'run-command':
        await this.runCommand(effect.raw)
        return

      case 'shutdown':
        await this.shutdown()
        return

      default:
        return
    }
  }

  // ── 会话与提交 ─────────────────────────────────────────────────

  /**
   * 提交一条用户消息。
   *
   * 会话**惰性创建**，标题取 `prompt.slice(0, 80)`（§3.5 第 10 步）。
   * 用户消息不由 UI 落盘（`ChatStore.beginTurn()` 已写），
   * 见 `input.ts` 的差异说明。
   */
  async submitPrompt(prompt: string): Promise<void> {
    const sessionId = await this.#ensureSession(prompt.slice(0, 80))
    if (sessionId === undefined) return

    this.#commit({
      ...this.#state,
      promptHistory: [...this.#state.promptHistory, prompt],
      historyIndex: undefined,
      historyDraft: '',
      // 提交即进入流式（`_start_spinner()` 在 `_submit_via_engine` 之前调用）。
      streaming: true,
      spinnerFrame: 0,
      streamingText: '',
      streamingTokens: 0,
      lastStreamRenderAt: 0,
      emptyStateVisible: false,
    })
    this.#startSpinner()

    let failure: string | undefined
    try {
      const { result } = await this.#app.submitTurn({
        principalId: this.#app.localPrincipalId,
        sessionId,
        prompt,
        mode:
          [
            PermissionMode.NORMAL,
            PermissionMode.AUTO_EDIT,
            PermissionMode.YOLO,
            PermissionMode.PLAN,
          ][this.#state.mode] ?? PermissionMode.NORMAL,
      })
      // ⚠️ **失败的 turn 不一定抛异常**：runtime 的 `finish(FAILED, ERROR)`
      // 把错误收进 `TurnResult` 后正常返回，因此这里必须检查结果状态——
      // 只看 `catch` 会让"模型不可用"这类失败静默通过
      // （旧实现也是这么做的：`if result.status == "error" and result.error`）。
      //
      // `partial` **不是失败**（`parts/09` §7.4：不得伪装成失败），
      // 因此只在 `failed` 且确实带错误信息时提示。
      if (result.status === 'failed' && result.error) failure = result.error
    } catch (error) {
      // 提交本身失败（会话忙、已关闭……）也必须让界面回到非流式状态，
      // 否则状态栏会永远转下去。
      this.#stopSpinner()
      failure = error instanceof Error ? error.message : String(error)
      this.#commit({ ...this.#state, streaming: false })
    }
    await this.refreshHistory()
    // 失败原因写进 `lastError`（不是 `notice`）：失败路径上 `turn_end` 会紧跟
    // 一次历史重绘，`notice` 会被那次重绘清掉，用户什么也看不到。
    if (failure !== undefined) this.#commit({ ...this.#state, lastError: failure })
  }

  async #ensureSession(title: string): Promise<SessionId | undefined> {
    if (this.#state.sessionId !== undefined) return this.#state.sessionId
    try {
      const { id } = await this.#app.createSession(this.#app.localPrincipalId, title)
      this.#commit({ ...this.#state, sessionId: id })
      await this.#bindSubscription()
      return id
    } catch (error) {
      this.#commit({
        ...this.#state,
        notice: translate(this.#state.language, TKey.MISC_ERROR_PREFIX, {
          error: error instanceof Error ? error.message : String(error),
        }),
      })
      return undefined
    }
  }

  // ── 命令 ───────────────────────────────────────────────────────

  /**
   * 执行一条斜杠命令。
   *
   * **除 `/quit` 外一律交给 `CommandRegistry`**（`parts/09` §6：「Slash command
   * 是独立的 `CommandRegistry`，与 TUI 无关」）。TUI 只做两件事：调用，
   * 以及按 `CommandResult.code` / `data.kind` 把结果**渲染**出来。
   *
   * ⚠️ 曾经的 `/clear` / `/language` / `/sessions` 本地实现已删除：那是命令层
   * 知识而不是表现层知识，各客户端各写一份会产生**静默漂移**——用户在 TUI 里
   * 能用、在浏览器里报"未知命令"，而两边代码看起来都没问题。
   *
   * `/quit` 留在 TUI：它是纯表现层动作（退出进程），命令层不该知道。
   */
  async runCommand(raw: string): Promise<void> {
    const name = raw.trim().split(/\s+/)[0] ?? ''
    if (name === '/quit' || name === '/exit') return this.shutdown()

    const result = await this.#registry
      .execute(
        {
          raw,
          principalId: this.#app.localPrincipalId,
          ...(this.#state.sessionId === undefined ? {} : { sessionId: this.#state.sessionId }),
          signal: this.#commandAbort.signal,
        },
        this.#host,
      )
      .catch((error: unknown): CommandResult => ({
        ok: false,
        code: CommandResultCode.FAILED,
        text: error instanceof Error ? error.message : String(error),
      }))

    // ️ 顺序：先刷新历史与状态栏，**再**呈现结果。
    // `refreshHistory()` 会清掉 `notice`（临时提示的语义），先呈现结果的话
    // 文本输出（`code: 'ok'`）会被紧随的重绘抹掉（实测踩到过）。
    await this.#refreshStatusModel()
    await this.refreshHistory()
    await this.#presentCommandResult(raw, result)
  }

  /**
   * 呈现命令结果：把命令层的结果映射成界面意图再落地。
   *
   * 映射表本身是纯函数（`command-view.ts`），这里只负责把它**落到状态与效果**：
   * 文本/面板/选择列表是状态更新，切会话与换语言要发效果。
   */
  async #presentCommandResult(raw: string, result: CommandResult): Promise<void> {
    const view = commandViewOf({
      raw,
      result,
      known: this.#registry.get(commandNameOf(raw)) !== undefined,
      language: this.#state.language,
    })

    switch (view.kind) {
      case 'switch-session':
        // 先切会话（那一步会重绘消息区并清掉临时提示），**再**写提示文本——
        // 顺序反了的话 `/clear` 的"已开始新会话"会被紧随的重绘抹掉。
        await this.#runEffects([
          { kind: 'select-session', sessionId: view.sessionId },
          { kind: 'render-history' },
        ])
        this.#commitCommandText(view.text)
        return

      case 'set-language':
        this.#applyLanguage(view.language, view.text)
        return

      case 'selection':
        this.#commit({
          ...this.#state,
          panel: undefined,
          notice: undefined,
          selection: view.selection,
        })
        return

      case 'panel':
        this.#showPanel({ title: view.title, body: view.body })
        return

      case 'text':
        this.#commitCommandText(view.text)
        return
    }
  }

  /**
   * 把一段命令文本显示在消息区。
   *
   * 同时收起首页：文本渲染在**消息区**，首页占着那块地方会让命令输出完全
   * 不可见（旧实现里任何命令输出都走 `_show_panel`，同样会收起首页）。
   */
  #commitCommandText(text: string): void {
    this.#commit({
      ...this.#state,
      panel: undefined,
      emptyStateVisible: false,
      notice: text,
    })
  }

  /**
   * 应用 `/language` 的结果。
   *
   * **只换翻译表，不写设置**：落盘是命令层的职责（`CommandHost.updateConfig`
   * 现在能回写 `app_settings`），各客户端各写一遍正是要消除的漂移。
   * UI 侧的 `persist-language` 效果因此已删除——它曾经是必要的补偿，
   * 现在只会变成一次幂等的重复写。
   */
  #applyLanguage(requested: string, text: string): void {
    if (requested !== Language.EN && requested !== Language.ZH) {
      this.#commitCommandText(text)
      return
    }
    this.#commit({
      ...this.#state,
      language: requested,
      panel: undefined,
      emptyStateVisible: false,
      notice: text,
      selection: undefined,
      menuNotice: undefined,
    })
  }

  // ── 视图刷新 ───────────────────────────────────────────────────

  /**
   * 从存储重绘消息区（§12.1 不变量 3）。
   *
   * 面板（BUG-COMPAT：覆盖式）与临时提示都在这里被清掉——旧实现的
   * `_sync_message_widgets` 会删掉全部 `__` 前缀 widget。
   */
  async refreshHistory(): Promise<void> {
    const sessionId = this.#state.sessionId
    if (sessionId === undefined) {
      this.#commit({ ...this.#state, messages: [], notice: undefined })
      return
    }
    const messages = await this.#app.chatStore.listMessages(sessionId)
    this.#commit({
      ...this.#state,
      messages,
      notice: undefined,
      panel: undefined,
      emptyStateVisible: messages.length === 0 ? this.#state.emptyStateVisible : false,
    })
  }

  /**
   * 刷新待办面板（`_refresh_todos_from_context`）。
   *
   * 数据来源与旧实现不同：旧实现读 `ToolContext.turn_state["todos"]`（进程内共享
   * 状态，UI 本来不该碰）。这里从**已落盘**的 `todo_write` 工具结果消息的 meta
   * 里读 `todos`——`agent-runtime.ts` 把 `result.data` 摊进了 meta，
   * 因此存储里就有这份数据，不需要给 UI 开后门。
   *
   * BUG-COMPAT（§12.2 第 11 项）：`todos` 为空时**直接返回，不清空面板**。
   */
  async refreshTodos(): Promise<void> {
    const sessionId = this.#state.sessionId
    if (sessionId === undefined) return
    const messages = await this.#app.chatStore.listMessages(sessionId)
    const todos = extractTodos(messages)
    // 空列表 → 保持面板原样（只在 turn_start 时清空）。
    if (todos.length === 0) return
    this.#commit({ ...this.#state, todos, todoVisible: true })
  }

  /** 恢复会话级的 token 记账（`session_select` 分支）。 */
  async #restoreAccounting(sessionId: SessionId): Promise<void> {
    const conversation = await this.#app.chatStore.getConversation(sessionId)
    this.#commit({
      ...this.#state,
      totalOutputTokens: conversation.total_output_tokens,
      lastInputTokens: conversation.last_input_tokens,
    })
  }

  /** 读输入历史（`_load_prompt_history`：只收 `role=user & subtype=normal`）。 */
  async #loadPromptHistory(sessionId: SessionId): Promise<void> {
    const messages = await this.#app.chatStore.listMessages(sessionId)
    const history = messages
      .filter((message) => message.role === 'user' && message.subtype === MessageSubtype.NORMAL)
      .map((message) => message.content)
    this.#commit({ ...this.#state, promptHistory: history })
  }

  /** 从配置解析状态栏要展示的主模型（`get_primary_llm_model` 的对应物）。 */
  async #refreshStatusModel(): Promise<void> {
    const config = await this.#app.configStore.read()
    this.#commit({ ...this.#state, statusModel: describePrimaryModel(config) })
  }

  // ── 事件订阅 ───────────────────────────────────────────────────

  async #bindSubscription(): Promise<void> {
    const sessionId = this.#state.sessionId
    if (sessionId === undefined) return
    const previous = this.#subscription
    this.#subscription = await this.#app.attach(
      {
        onEvent: (event: RuntimeEventEnvelope) => {
          const applied = applyEvent(this.#state, event)
          this.#commit(applied.state)
          void this.#runEffects(applied.effects)
          if (event.type === 'turn_end' || event.type === 'error') void this.#refreshStatusModel()
        },
      },
      { sessionId },
    )
    // 订阅是"每个会话一份"：换会话时先断旧订阅，避免两份事件都写同一状态。
    previous?.unsubscribe()
  }

  // ─ 面板与提交 ─────────────────────────────────────────────────

  /**
   * `_show_panel(title, body)`。
   *
   * BUG-COMPAT（§12.2 第 14 项）：面板**清空整个消息区**并覆盖渲染，
   * 因此设置界面会盖住对话，返回需要显式 `refreshHistory()`。
   */
  #showPanel(panel: Panel): void {
    this.#commit({
      ...this.#state,
      panel,
      notice: undefined,
      emptyStateVisible: false,
      selection: undefined,
    })
  }

  // ─ spinner 与发布 ─────────────────────────────────────────────

  /** 启动 spinner（120ms/帧）。 */
  #startSpinner(): void {
    this.#stopSpinner()
    const tick = (): void => {
      if (this.#disposed || !this.#state.streaming) {
        this.#spinnerTimer = undefined
        return
      }
      this.#commit({
        ...this.#state,
        spinnerFrame: (this.#state.spinnerFrame + 1) % 4,
      })
      this.#spinnerTimer = this.#setTimeout(tick, SPINNER_INTERVAL_MS)
    }
    this.#spinnerTimer = this.#setTimeout(tick, SPINNER_INTERVAL_MS)
  }

  #stopSpinner(): void {
    if (this.#spinnerTimer !== undefined) {
      this.#clearTimeout(this.#spinnerTimer)
      this.#spinnerTimer = undefined
    }
  }

  /**
   * 提交新状态并通知订阅者。
   *
   * **50ms 节流只作用于"流式文本推进"**：其余变化（按键、事件）立即发布。
   * 旧实现节流的是 widget 重绘而不是累积（`_streaming_assistant_text` 每次
   * 都累加，只有 `_render_streaming_assistant()` 被节流），这里等价地
   * 让 `#state` 始终最新、`#published` 每 50ms 追一次。
   */
  #commit(next: TuiState): void {
    this.#state = next
    const now = this.#now()

    // "流式推进" = 新文本是旧文本的**严格延长**。
    //
    // ️ 判据必须是"延长"而不是"文本变了"：`turn_end` 会把 `streamingText`
    // 清空，如果清除也被算作推进，它就会落在 50ms 窗口里被丢掉——发布出去的
    // 快照会永远停在"流式中"，状态栏一直转圈（实测踩到过）。
    const advanced =
      next.streamingText.length > this.#published.streamingText.length &&
      next.streamingText.startsWith(this.#published.streamingText)
    const throttled =
      advanced &&
      this.#published.streamingText !== '' &&
      now - this.#published.lastStreamRenderAt < STREAM_RENDER_INTERVAL_MS

    if (throttled) {
      // 内部状态照常最新，只是这一帧不发布（等价于旧实现"累积立即、重绘节流"）。
      this.#published = { ...this.#published, streamingTokens: next.streamingTokens }
      return
    }
    this.#published = { ...next, lastStreamRenderAt: next.streamingText ? now : 0 }
    for (const listener of this.#listeners) listener()
  }

  /** 强制发布当前状态（测试与手动刷新用）。 */
  flushPublished(): void {
    this.#published = this.#state
    for (const listener of this.#listeners) listener()
  }
}

// ── 纯辅助函数 ────────────────────────────────────────────────────
