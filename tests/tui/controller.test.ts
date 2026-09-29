/**
 * 控制器端到端：真 `AgentApplication` + 假 provider。
 *
 * 这一层验的是"装配是否真的接通了"——事件能不能驱动界面、界面能不能
 * 把决议回灌回去、关闭时资源有没有释放。判定逻辑本身在
 * `keys/events/input/status-bar` 的单测里，这里不重复。
 */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { AgentApplication } from '../../src/app/agent-application.js'
import { CommandHostAdapter } from '../../src/app/command-host.js'
import { createBuiltinCommandRegistry } from '../../src/commands/index.js'
import type { CommandDefinition, CommandResult } from '../../src/commands/types.js'
import { CommandRegistry } from '../../src/commands/registry.js'
import type { UserInputRequest } from '../../src/core/input.js'
import { ModelEventType, type Provider } from '../../src/core/provider.js'
import type { PermissionRequest } from '../../src/core/tool.js'
import { ChatStore } from '../../src/storage/chat-store.js'
import { ConfigStore } from '../../src/storage/config-store.js'
import { resolveAppPaths } from '../../src/storage/paths.js'
import type { ConfigDocument } from '../../src/storage/types.js'
import type { SessionId } from '../../src/core/ids.js'
import { ToolRegistry } from '../../src/tools/registry.js'
import { TuiController } from '../../src/clients/tui/controller.js'
import { describePrimaryModel, extractTodos } from '../../src/clients/tui/sources.js'

const PROVIDER: Provider = {
  id: 'p',
  name: 'TestProvider',
  baseUrl: 'https://api.anthropic.com',
  apiKeyRef: { source: 'env', key: 'TEST_KEY' },
  createdAt: '',
  updatedAt: '',
}

function configDocument(): ConfigDocument {
  return {
    schema_version: 1,
    llm_channels: [],
    llm_models: [],
    app_settings: {},
    providers: [{ ...PROVIDER, enabled: true }],
    model_profiles: [
      {
        id: 'm1',
        providerId: 'p',
        displayName: 'test-model',
        contextWindow: 200_000,
        maxOutputTokens: 8192,
        supportsThinking: true,
        supportsTools: true,
        supportsVision: false,
        supports1MContext: false,
        thinkingEnabled: true,
        reasoningEffort: 'medium',
        inputCostPerMillion: 1,
        outputCostPerMillion: 2,
        enabled: true,
      },
    ],
    tier_assignments: [
      {
        tier: 'implementation',
        modelRef: { providerId: 'p', modelId: 'm1' },
        enabled: true,
        fallbackModelRefs: [],
      },
    ],
  }
}

/** 假 provider：先吐一段文本，然后结束。 */
function textProviderFactory(
  chunks: readonly string[],
  usage = { inputTokens: 100, outputTokens: 20 },
) {
  return (() => ({
    stream: () => ({
      usage,
      async *[Symbol.asyncIterator]() {
        for (const content of chunks) {
          await Promise.resolve()
          yield { type: ModelEventType.TEXT, content } as never
        }
      },
    }),
    probe: () => Promise.resolve({ ok: true }),
  })) as never
}

/**
 * 假 provider：吐一段文本后一直挂着，**直到 signal 中止**。
 *
 * ️ 必须真的响应 `signal`：真实 provider（`providers/anthropic.ts` 用
 * `withTimeout(signal, …)`）会在取消时中断请求。一个忽略 signal 的假 provider
 * 会让"按 Esc 取消"永远等不到 `turn_end`，测试于是测不出取消路径。
 */
function hangingProviderFactory() {
  return (() => ({
    stream: (_request: unknown, signal: AbortSignal) => ({
      usage: { inputTokens: 1, outputTokens: 0 },
      async *[Symbol.asyncIterator]() {
        yield { type: ModelEventType.TEXT, content: 'partial' } as never
        await new Promise((_resolve, reject) => {
          if (signal.aborted) {
            reject(new Error('aborted'))
            return
          }
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
        yield { type: ModelEventType.TEXT, content: 'never' } as never
      },
    }),
    probe: () => Promise.resolve({ ok: true }),
  })) as never
}

/**
 * 读操作被人为放慢的 `ChatStore`。
 *
 * 用途：把"两步提交之间的窗口"**确定性**地摊开，从而证明某条断言是脆的，
 * 而不是靠机器恰好够快来通过。生产代码不受影响。
 */
class SlowReadChatStore extends ChatStore {
  readonly #delayMs: number
  constructor(paths: ConstructorParameters<typeof ChatStore>[0], delayMs: number) {
    super(paths)
    this.#delayMs = delayMs
  }
  override async listMessages(sessionId: SessionId) {
    await new Promise((resolve) => setTimeout(resolve, this.#delayMs))
    return super.listMessages(sessionId)
  }
  override async getConversation(sessionId: SessionId) {
    await new Promise((resolve) => setTimeout(resolve, this.#delayMs))
    return super.getConversation(sessionId)
  }
}

async function harness(providerFactory: unknown, options: { readonly slowReadsMs?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'deepcode-tui-'))
  const paths = resolveAppPaths({ home: dir, cwd: dir })
  const configStore = new ConfigStore(paths)
  await configStore.save(configDocument())
  const chatStore =
    options.slowReadsMs === undefined
      ? new ChatStore(paths)
      : new SlowReadChatStore(paths, options.slowReadsMs)

  const app = await AgentApplication.create({
    paths,
    workspaceRoot: dir,
    configStore,
    chatStore,
    registry: new ToolRegistry(),
    providerFactory: providerFactory as never,
  })

  // 与三端共用同一份内置注册表（`src/commands/definitions/index.ts`）
  const registry = createBuiltinCommandRegistry()
  const host = new CommandHostAdapter(app)

  let nowMs = 1_000_000
  const timers: Array<{ handler: () => void }> = []
  const controller = new TuiController({
    app,
    registry,
    host,
    now: () => nowMs,
    // 注入定时器：测试可以手动推进 spinner，而不是等真实时间。
    setTimeoutFn: (handler) => {
      const entry = { handler }
      timers.push(entry)
      return entry
    },
    clearTimeoutFn: (handle) => {
      const entry = handle as { handler: () => void }
      const index = timers.indexOf(entry)
      if (index >= 0) timers.splice(index, 1)
    },
  })

  return {
    dir,
    app,
    chatStore,
    configStore,
    controller,
    advanceTime: (delta: number) => {
      nowMs += delta
    },
    /** 触发一次 spinner tick。 */
    tick: () => {
      const pending = [...timers]
      for (const entry of pending) entry.handler()
    },
  }
}

/**
 * 提交一条消息并等这一轮真正结束。
 *
 * ⚠️ 不能只 `waitFor(() => !streaming)`——提交前 streaming 本来就是 false，
 * 那个条件会立刻成立，断言会跑在提交之前（本文件最早的一版就是这么错的）。
 * 这里等的是"会话已建 + 这一轮结束 + 存储里多了一条消息"。
 */
async function submitAndSettle(
  controller: TuiController,
  text: string,
  timeoutMs = 8_000,
): Promise<SessionId> {
  const before = controller.getState().messages.length
  controller.setInput(text)
  controller.applyKey({ name: 'enter' })
  await waitFor(
    () =>
      controller.getState().sessionId !== undefined &&
      !controller.getState().streaming &&
      controller.getState().messages.length > before,
    timeoutMs,
  )
  return controller.getState().sessionId!
}

/** 等待某条消息落盘（重提 / 提交完成的证据）。 */
async function waitForStored(
  chatStore: ChatStore,
  sessionId: SessionId,
  content: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const messages = await chatStore.listMessages(sessionId)
    if (messages.some((message) => message.content === content)) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`等待超时：存储里始终没有 ${content}`)
}

/** 等待配置项被写盘（`/language` 的落盘是异步效果）。 */
async function waitForConfig(
  configStore: ConfigStore,
  key: string,
  value: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await configStore.read()).app_settings[key] === value) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`等待超时：配置 ${key} 始终不是 ${value}`)
}

/**
 * 造一个只返回固定结果的命令。
 *
 * 用来验证 UI **是否遵守 `CommandResult` 契约**（`code` 决定渲染成文本、
 * 面板还是选择列表）——目前注册表里只有 `/workwith`，它只返回 `ok` /
 * `invalid_arguments`，那几条分支否则无从触发。
 */
function fakeCommand(input: {
  readonly name: string
  readonly result: CommandResult
}): CommandDefinition {
  return {
    name: input.name,
    description: '测试用命令',
    parameters: { positionals: [] },
    interrupt: 'never',
    permission: { kind: 'always' },
    auditEvent: `command.${input.name}`,
    idempotency: { kind: 'read-only' },
    persistResult: false,
    execute: () => Promise.resolve(input.result),
  }
}

/**
 * 等待条件成立（有界轮询）。
 *
 * 超时是**兜底**而不是断言本身：条件才是断言的真凭据。给到 5 秒是因为
 * 全仓并行跑时 CPU 争用会让文件 I/O 明显变慢（本地单跑 2 秒绰绰有余），
 * 而"因为机器忙所以失败"不是有用的信号。
 */
async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('等待超时：条件始终不成立')
}

describe('describePrimaryModel', () => {
  it('解析 implementation 档位的 provider/model', () => {
    expect(describePrimaryModel(configDocument())).toEqual({
      providerName: 'TestProvider',
      modelName: 'test-model',
      thinkingEnabled: true,
      reasoningEffort: 'medium',
      contextWindow: 200_000,
      maxOutputTokens: 8192,
      tier: 'implementation',
      inputCostPerMillion: 1,
      outputCostPerMillion: 2,
    })
  })

  it('档位未启用或模型缺失时返回 undefined（状态栏显示"无模型"）', () => {
    const disabled = configDocument()
    expect(
      describePrimaryModel({
        ...disabled,
        tier_assignments: disabled.tier_assignments.map((a) => ({ ...a, enabled: false })),
      }),
    ).toBeUndefined()
    expect(describePrimaryModel({ ...disabled, model_profiles: [] })).toBeUndefined()
    expect(describePrimaryModel({ ...disabled, providers: [] })).toBeUndefined()
  })
})

describe('extractTodos', () => {
  it('取最近一次 todo_write 的待办', () => {
    const messages = [
      {
        subtype: 'tool_result',
        meta: JSON.stringify({
          tool_name: 'todo_write',
          todos: [{ content: 'old', status: 'pending' }],
        }),
      },
      { subtype: 'normal', meta: '{}' },
      {
        subtype: 'tool_result',
        meta: JSON.stringify({
          tool_name: 'todo_write',
          todos: [{ content: 'new', status: 'completed' }],
        }),
      },
    ]
    expect(extractTodos(messages)).toEqual([{ content: 'new', status: 'completed' }])
  })

  it('跳过非 todo_write 的工具结果与坏 meta', () => {
    const messages = [
      { subtype: 'tool_result', meta: '{bad' },
      { subtype: 'tool_result', meta: JSON.stringify({ tool_name: 'bash' }) },
    ]
    expect(extractTodos(messages)).toEqual([])
  })

  it('todo_write 的 todos 不是数组时返回空', () => {
    expect(
      extractTodos([{ subtype: 'tool_result', meta: JSON.stringify({ tool_name: 'todo_write' }) }]),
    ).toEqual([])
  })

  it('过滤掉没有内容的条目并补默认状态', () => {
    const entries = extractTodos([
      {
        subtype: 'tool_result',
        meta: JSON.stringify({
          tool_name: 'todo_write',
          todos: [{ content: '', status: 'pending' }, { content: 'x' }],
        }),
      },
    ])
    expect(entries).toEqual([{ content: 'x', status: 'pending' }])
  })
})

describe('端到端：提交消息', () => {
  it('提交后进入流式，turn_end 后回到正常态并读到存储里的消息', async () => {
    const { app, controller } = await harness(textProviderFactory(['你好', '，世界']))
    await controller.start()

    // 首屏：首页可见、无会话
    expect(controller.getState().emptyStateVisible).toBe(true)
    expect(controller.getState().sessionId).toBeUndefined()

    await submitAndSettle(controller, '打个招呼')

    const state = controller.getState()
    // 消息区真相源是存储：user 消息由 ChatStore.beginTurn 写入，UI 只读
    const stored = await app.chatStore.listMessages(state.sessionId!)
    expect(stored.length).toBeGreaterThan(0)
    expect(state.messages.map((m) => m.id)).toEqual(stored.map((m) => m.id))
    // 输入框已清空，首页已隐藏
    expect(state.input).toBe('')
    expect(state.emptyStateVisible).toBe(false)
    // 记账来自 turn_end
    expect(state.lastInputTokens).toBe(100)
    expect(state.totalOutputTokens).toBe(20)
    // 状态栏：有会话、有 token、有成本
    expect(state.statusModel).toMatchObject({
      providerName: 'TestProvider',
      modelName: 'test-model',
    })
  })

  it('会话标题取首条消息前 80 字符（惰性建会话）', async () => {
    const { app, controller } = await harness(textProviderFactory(['ok']))
    await controller.start()
    const long = 'x'.repeat(200)
    const sessionId = await submitAndSettle(controller, long)
    const session = await app.getSession(app.localPrincipalId, sessionId)
    expect(session.title).toBe(long.slice(0, 80))
  })

  it('提交的 prompt 进入输入历史，命令也记录', async () => {
    const { controller } = await harness(textProviderFactory(['ok']))
    await controller.start()
    await submitAndSettle(controller, '第一条')
    expect(controller.getState().promptHistory).toContain('第一条')

    // 命令**不**记入历史：旧实现里 step 9（斜杠命令）在 step 11 之前 return，
    // `_record_prompt_history` 根本不会被调用。`parts/05` §3.6 那句"命令也记录"
    // 与源码不符——旧测试 `test_prompt_history_restores_draft_and_skips_commands`
    // 的断言（按 up 得到的是上一条**普通**消息）才是实际行为。
    controller.setInput('/language zh')
    controller.applyKey({ name: 'enter' })
    await waitFor(() => controller.getState().language === 'zh')
    expect(controller.getState().promptHistory).not.toContain('/language zh')
    expect(controller.getState().promptHistory).toEqual(['第一条'])
  })

  it('提交失败时回到非流式并显示错误（不永久转圈）', async () => {
    // 无 tier assignment → 路由失败
    const dir = await mkdtemp(join(tmpdir(), 'deepcode-tui-'))
    const paths = resolveAppPaths({ home: dir, cwd: dir })
    const configStore = new ConfigStore(paths)
    await configStore.save({ ...configDocument(), tier_assignments: [] })
    const app = await AgentApplication.create({
      paths,
      workspaceRoot: dir,
      configStore,
      chatStore: new ChatStore(paths),
      registry: new ToolRegistry(),
      providerFactory: textProviderFactory(['x']),
    })
    const controller = new TuiController({
      app,
      registry: new CommandRegistry(),
      host: new CommandHostAdapter(app),
    })
    await controller.start()
    controller.setInput('hi')
    controller.applyKey({ name: 'enter' })
    await waitFor(() => controller.getState().lastError !== undefined)
    expect(controller.getState().lastError).toContain('no model assigned')
    // 关键：不能永远停在流式态
    expect(controller.getState().streaming).toBe(false)
  })
})

describe('端到端：流式与取消', () => {
  it('流式期状态栏显示 spinner 与粗估 token', async () => {
    const { controller, tick } = await harness(hangingProviderFactory())
    await controller.start()
    controller.setInput('跑一个长任务')
    controller.applyKey({ name: 'enter' })

    await waitFor(() => controller.getState().streaming)
    await waitFor(() => controller.getState().streamingText === 'partial')

    // 手动推一帧 spinner
    tick()
    controller.flushPublished()
    expect(controller.getState().spinnerFrame).toBe(1)
    // 'partial' 是 7 个字符 → max(1, 7 // 4) = 1
    expect(controller.getState().streamingTokens).toBe(1)

    controller.applyKey({ name: 'escape' })
    await waitFor(() => !controller.getState().streaming)
  })

  it('流式中按 Enter = 排队 + 取消 + 自动重提', async () => {
    const { app, controller } = await harness(hangingProviderFactory())
    await controller.start()
    controller.setInput('第一条')
    controller.applyKey({ name: 'enter' })
    await waitFor(() => controller.getState().streaming)

    controller.setInput('第二条')
    controller.applyKey({ name: 'enter' })
    expect(controller.getState().pendingPrompt).toBe('第二条')

    // 取消会走到 turn_end(cancelled) → 自动重提排队的 prompt。
    // ️ 不能等 `isBusy === false`：重提的那一轮用的是同一个挂住的 provider，
    // 它同样不会结束。这里等的是"第二条消息已经落盘"（那正是重提发生的证据）。
    const sessionId = controller.getState().sessionId!
    await waitForStored(app.chatStore, sessionId, '第二条')
    expect(controller.getState().pendingPrompt).toBeUndefined()
  }, 10_000)

  it('T-15：shutdown 取消在飞 turn、冲刷并释放应用', async () => {
    const { app, controller } = await harness(hangingProviderFactory())
    await controller.start()
    controller.setInput('长任务')
    controller.applyKey({ name: 'enter' })
    await waitFor(() => controller.getState().streaming)

    await controller.shutdown()
    expect(app.disposed).toBe(true)
    await expect(
      app.submitTurn({
        principalId: app.localPrincipalId,
        sessionId: controller.getState().sessionId!,
        prompt: 'after dispose',
      }),
    ).rejects.toThrow()
    // 幂等：重复关闭不抛错
    await controller.shutdown()
  }, 10_000)
})

describe('端到端：权限往返闭环', () => {
  function permissionRequest(sessionId: string): PermissionRequest {
    return {
      request_id: 'req-1',
      session_id: sessionId,
      turn_id: 'turn-1',
      tool_call_id: 'call-1',
      tool_name: 'file_write',
      args_preview: '{"path":"a.ts"}',
      risk_level: 'high',
      reason: 'tool requires approval',
      status: 'PENDING_USER_APPROVAL',
      created_at: '2026-09-15T00:00:00.000Z',
      expires_at: Date.now() + 60_000,
      resolved_at: null,
      resolved_by: '',
      resolution: '',
    } as PermissionRequest
  }

  it('审批事件入队 → 按 y → broker 收到 allow 决议', async () => {
    const { app, controller } = await harness(textProviderFactory(['ok']))
    await controller.start()
    // ⚠️ 必须用**控制器真正绑定的**会话：控制器在首次提交时惰性建会话，
    // 另建一个会话再发事件，控制器是收不到的（事件按 session 分发）。
    const sessionId = await submitAndSettle(controller, 'hi')

    // 用真 broker 发一次请求（等同于 executor 走到审批路径）
    const controllerAbort = new AbortController()
    const pending = app.broker!.request(permissionRequest(sessionId), controllerAbort.signal)

    await waitFor(() => controller.getState().permissionQueue.length === 1)
    expect(controller.getState().permissionQueue[0]).toMatchObject({
      requestId: 'req-1',
      toolName: 'file_write',
      riskLevel: 'high',
    })
    // 输入框切到审批文案（`_set_input_prompt(PERM_LABEL, PERM_PLACEHOLDER)`）
    expect(controller.getState().inputPrompt).toEqual({ kind: 'permission' })

    controller.applyKey({ name: 'char', char: 'y' })
    const resolution = await pending
    expect(resolution.decision).toBe('allow')
    expect(resolution.resolvedBy).toBe('user')
    expect(controller.getState().permissionQueue).toEqual([])
  })

  it('按 a → allow 且带 tool 范围的授权', async () => {
    const { app, controller } = await harness(textProviderFactory(['ok']))
    await controller.start()
    const sessionId = await submitAndSettle(controller, 'hi')
    const abort = new AbortController()
    const pending = app.broker!.request(permissionRequest(sessionId), abort.signal)
    await waitFor(() => controller.getState().permissionQueue.length === 1)

    controller.applyKey({ name: 'char', char: 'a' })
    const resolution = await pending
    expect(resolution.decision).toBe('allow')
    expect(resolution.grantScope).toMatchObject({ kind: 'tool', toolName: 'file_write' })
  })

  it('按 n → deny', async () => {
    const { app, controller } = await harness(textProviderFactory(['ok']))
    await controller.start()
    const sessionId = await submitAndSettle(controller, 'hi')
    const abort = new AbortController()
    const pending = app.broker!.request(permissionRequest(sessionId), abort.signal)
    await waitFor(() => controller.getState().permissionQueue.length === 1)

    controller.applyKey({ name: 'char', char: 'n' })
    expect((await pending).decision).toBe('deny')
  })

  it('双击 Esc → deny（单次不行）', async () => {
    const { app, controller } = await harness(textProviderFactory(['ok']))
    await controller.start()
    const sessionId = await submitAndSettle(controller, 'hi')
    const abort = new AbortController()
    const pending = app.broker!.request(permissionRequest(sessionId), abort.signal)
    await waitFor(() => controller.getState().permissionQueue.length === 1)

    controller.applyKey({ name: 'escape' })
    expect(controller.getState().permissionQueue).toHaveLength(1)
    controller.applyKey({ name: 'escape' })
    expect((await pending).decision).toBe('deny')
  })

  it('菜单项 Enter 也能批准（语境分派到权限决议）', async () => {
    const { app, controller } = await harness(textProviderFactory(['ok']))
    await controller.start()
    const sessionId = await submitAndSettle(controller, 'hi')
    const abort = new AbortController()
    const pending = app.broker!.request(permissionRequest(sessionId), abort.signal)
    await waitFor(() => controller.getState().permissionQueue.length === 1)

    controller.applyKey({ name: 'enter' })
    await pending
    expect(app.broker!.listPending()).toEqual([])
  })
})

describe('端到端：问卷闭环', () => {
  function userInputRequest(sessionId: string, multiSelect = false): UserInputRequest {
    return {
      request_id: 'q-1',
      session_id: sessionId,
      turn_id: 'turn-1',
      tool_call_id: 'call-1',
      tool_name: 'ask_user_question',
      questions: [
        {
          question: '选哪个？',
          header: 'Choice',
          options: [
            { label: 'alpha', description: 'first' },
            { label: 'beta', description: 'second' },
          ],
          ...(multiSelect ? { multiSelect: true } : {}),
        },
      ],
      created_at: '2026-09-15T00:00:00.000Z',
      expires_at: Date.now() + 60_000,
    } as unknown as UserInputRequest
  }

  it('user_input_required → 方向键 + Enter → broker 收到答案', async () => {
    const { app, controller } = await harness(textProviderFactory(['ok']))
    await controller.start()
    const sessionId = await submitAndSettle(controller, 'hi')
    const abort = new AbortController()
    const pending = app.userInputBroker!.request(userInputRequest(sessionId), abort.signal)

    await waitFor(() => controller.getState().questionnaire !== undefined)
    expect(controller.getState().questionnaire?.questions[0]?.header).toBe('Choice')

    controller.applyKey({ name: 'down' }) // alpha → beta
    controller.applyKey({ name: 'enter' })

    const resolution = await pending
    expect(resolution.answers).toEqual([['beta']])
    expect(resolution.resolvedBy).toBe('user')
    expect(controller.getState().questionnaire).toBeUndefined()
  })

  it('多选题用 space 切换选中集', async () => {
    const { app, controller } = await harness(textProviderFactory(['ok']))
    await controller.start()
    const sessionId = await submitAndSettle(controller, 'hi')
    const abort = new AbortController()
    const pending = app.userInputBroker!.request(userInputRequest(sessionId, true), abort.signal)
    await waitFor(() => controller.getState().questionnaire !== undefined)

    controller.applyKey({ name: 'space' }) // 选中 alpha
    controller.applyKey({ name: 'down' }) // 光标到 beta
    controller.applyKey({ name: 'space' }) // 选中 beta
    controller.applyKey({ name: 'enter' })

    expect((await pending).answers).toEqual([['alpha', 'beta']])
  })

  it('空问题列表立即作答（turn 不会卡住）', async () => {
    const { app, controller } = await harness(textProviderFactory(['ok']))
    await controller.start()
    const sessionId = await submitAndSettle(controller, 'hi')
    const request = { ...userInputRequest(sessionId), questions: [] } as UserInputRequest
    const abort = new AbortController()
    const pending = app.userInputBroker!.request(request, abort.signal)

    const resolution = await pending
    expect(resolution.answers).toEqual([])
    expect(controller.getState().questionnaire).toBeUndefined()
  })
})

describe('端到端：命令', () => {
  it('/language <lang> 切换语言并落盘（命令层给出 data.kind: set_language）', async () => {
    const { configStore, controller } = await harness(textProviderFactory(['ok']))
    await controller.start()
    expect(controller.getState().language).toBe('en')

    controller.setInput('/language zh')
    controller.applyKey({ name: 'enter' })
    // 语言与提示在**同一次提交**里落地，但这里仍然只等"要断言的那个值"——
    // 依赖"另一次提交同原子"会在别人重构时悄悄变成竞态。
    await waitFor(() => controller.getState().notice?.includes('界面语言已切换为 zh') === true)
    expect(controller.getState().language).toBe('zh')
    // 落盘由**命令层**完成（TUI 不再自己写设置）；这里等的是配置文件的最终状态
    await waitForConfig(configStore, 'language', 'zh')

    // 再切回英文
    controller.setInput('/language en')
    controller.applyKey({ name: 'enter' })
    await waitFor(() => controller.getState().language === 'en')
  })

  it('/language 不带参数只报告当前语言（命令层的只读分支）', async () => {
    const { controller } = await harness(textProviderFactory(['ok']))
    await controller.start()
    controller.setInput('/language')
    controller.applyKey({ name: 'enter' })
    await waitFor(() => controller.getState().notice !== undefined)
    expect(controller.getState().notice).toContain('/language zh')
    // 语言没变
    expect(controller.getState().language).toBe('en')
  })

  it('/language <非法值> 被命令层拒绝，不改变语言', async () => {
    const { controller } = await harness(textProviderFactory(['ok']))
    await controller.start()
    controller.setInput('/language fr')
    controller.applyKey({ name: 'enter' })
    await waitFor(() => controller.getState().panel !== undefined)
    expect(controller.getState().language).toBe('en')
    expect(controller.getState().panel?.title).toBe('/language')
  })

  it('启动时读回持久化的语言（旧实现的 _load_language）', async () => {
    const { configStore, controller } = await harness(textProviderFactory(['ok']))
    await configStore.update((doc) => ({
      ...doc,
      app_settings: { ...doc.app_settings, language: 'zh' },
    }))
    await controller.start()
    expect(controller.getState().language).toBe('zh')
  })

  /**
   * `notice` 是**第二步**才写的——这条用例把那个窗口确定性地摊开。
   *
   * 实测（人为把两次存储读各放慢 150ms，记录三件事首次成立的时间）：
   *
   * ```
   * 会话切换 t=228ms   消息区清空 t=228ms   提示文本 t=683ms
   * ```
   *
   * 前两者来自 `select-session` 的**同一次提交**，提示文本要等之后的
   * `#loadPromptHistory` + `#restoreAccounting` 两次读。也就是说：先等
   * `sessionId`/`messages` 再断言 `notice`，会稳定地读到一个"还没写上去"的值。
   *
   * ️ 失败原因**不是**"重绘把 notice 清掉了"：`#commitCommandText` 是这条链的
   * 最后一步，之后没有任何提交。用这条用例把机制钉住，避免以后有人按错的
   * 猜测去"修"实现。
   */
  it('/clear 的提示文本晚于会话切换（两步提交，不能先等 A 再断言 B）', async () => {
    const { controller } = await harness(textProviderFactory(['ok']), { slowReadsMs: 150 })
    await controller.start()
    const previous = await submitAndSettle(controller, 'hi')

    controller.setInput('/clear')
    controller.applyKey({ name: 'enter' })

    await waitFor(() => controller.getState().sessionId !== previous)
    await waitFor(() => controller.getState().messages.length === 0)
    // ⚠️ 旧断言形式就在这一行失败：会话已切、消息区已清，但提示还没写。
    expect(controller.getState().notice).toBeUndefined()

    // 提示随后到达（等它本身，而不是等别的条件）
    await waitFor(() => controller.getState().notice?.includes('已开始新会话') === true)
    expect(controller.getState().sessionId).not.toBe(previous)
  })

  it('/clear 新建并切到一个新会话（命令层给出 data.kind: switch_session）', async () => {
    const { app, controller } = await harness(textProviderFactory(['ok']))
    await controller.start()
    const previous = await submitAndSettle(controller, 'hi')

    controller.setInput('/clear')
    controller.applyKey({ name: 'enter' })
    await waitFor(() => controller.getState().sessionId !== previous)
    // /clear 的结果分两步落地：先切会话并重绘，**再**写提示文本。所以必须
    // 抓提示出现的时刻，而不是先等别的条件、再回头断言它。
    //
    // ️ 注意机制：失败原因**不是**"重绘把 notice 清掉了"——提示是这条链的
    // 最后一步，之后没有任何提交（实测见下一条用例）。仅仅因为那是**还没写**，
    // 先等 A、再等 B 的写法会在它存在之前就读它。
    await waitFor(() => controller.getState().notice?.includes('已开始新会话') === true)
    // 此刻切换早已完成，这几项是稳定值
    const state = controller.getState()
    expect(state.notice).toContain('已开始新会话')
    expect(state.sessionId).not.toBe(previous)
    await waitFor(() => controller.getState().messages.length === 0)
    // 新会话确实存在于存储里
    const sessions = await app.listSessions(app.localPrincipalId)
    expect(sessions.some((session) => session.id === state.sessionId)).toBe(true)
  })

  it('/sessions 无会话时按命令层文本输出', async () => {
    const { controller } = await harness(textProviderFactory(['ok']))
    await controller.start()
    controller.setInput('/sessions')
    controller.applyKey({ name: 'enter' })
    await waitFor(() => controller.getState().notice !== undefined)
    expect(controller.getState().notice).toContain('还没有任何会话')
    expect(controller.getState().panel).toBeUndefined()
  })

  it('/sessions 有会话时给出选择列表（data.kind: session_select）', async () => {
    const { app, controller } = await harness(textProviderFactory(['ok']))
    await controller.start()
    await app.createSession(app.localPrincipalId, '既有会话')
    controller.setInput('/sessions')
    controller.applyKey({ name: 'enter' })
    await waitFor(() => controller.getState().selection !== undefined)
    const state = controller.getState()
    expect(state.selection?.context).toBe('session_select')
    expect(state.selection?.items.map((item) => item.title)).toContain('既有会话')
    expect(state.selection?.footer).toContain('Enter')
  })

  it('选择另一个会话 → 切换视图、恢复记账与输入历史', async () => {
    const { app, controller } = await harness(textProviderFactory(['ok']))
    await controller.start()
    // 先在一个会话里说一句，再切到另一个会话，验证历史确实来自被选中的那个
    const first = await submitAndSettle(controller, '第一条消息')
    const second = await app.createSession(app.localPrincipalId, '另一个会话')

    controller.setInput('/sessions')
    controller.applyKey({ name: 'enter' })
    await waitFor(() => controller.getState().selection !== undefined)

    // 选中"另一个会话"（列表顺序与 listSessions 一致）
    const items = controller.getState().selection!.items
    const target = items.findIndex((item) => item.key === second.id)
    expect(target).toBeGreaterThanOrEqual(0)
    for (let index = 0; index < target; index += 1) controller.applyKey({ name: 'down' })
    controller.applyKey({ name: 'enter' })

    await waitFor(() => controller.getState().sessionId === second.id)
    // 切换是异步效果：等输入历史被重新读出来（`_load_prompt_history`）
    await waitFor(() => controller.getState().promptHistory.length === 0)
    expect(controller.getState().selection).toBeUndefined()
    expect(controller.getState().messages).toEqual([])

    // 切回第一个会话 → 历史里有那条消息
    controller.setInput('/sessions')
    controller.applyKey({ name: 'enter' })
    await waitFor(() => controller.getState().selection !== undefined)
    const back = controller.getState().selection!.items.findIndex((item) => item.key === first)
    for (let index = 0; index < back; index += 1) controller.applyKey({ name: 'down' })
    controller.applyKey({ name: 'enter' })
    await waitFor(() => controller.getState().sessionId === first)
    await waitFor(() => controller.getState().promptHistory.length === 1)
    expect(controller.getState().promptHistory).toEqual(['第一条消息'])
  })

  it('命令返回 panel 时渲染面板（CommandResult 契约）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deepcode-tui-'))
    const paths = resolveAppPaths({ home: dir, cwd: dir })
    const configStore = new ConfigStore(paths)
    await configStore.save(configDocument())
    const app = await AgentApplication.create({
      paths,
      workspaceRoot: dir,
      configStore,
      chatStore: new ChatStore(paths),
      registry: new ToolRegistry(),
      providerFactory: textProviderFactory(['ok']),
    })
    const registry = new CommandRegistry()
    registry.register(
      fakeCommand({
        name: 'panelful',
        result: {
          ok: true,
          code: 'panel',
          text: 'Panel title',
          data: { body: 'Panel body' },
        },
      }),
    )
    const controller = new TuiController({ app, registry, host: new CommandHostAdapter(app) })
    await controller.start()

    controller.setInput('/panelful')
    controller.applyKey({ name: 'enter' })
    await waitFor(() => controller.getState().panel !== undefined)
    // 面板标题固定是命令名，正文优先取 `data.body`（`panel` 契约）
    expect(controller.getState().panel).toEqual({ title: '/panelful', body: 'Panel body' })
  })

  it('命令返回 selection 时渲染选择列表（含语境与字符串字段兜底）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deepcode-tui-'))
    const paths = resolveAppPaths({ home: dir, cwd: dir })
    const configStore = new ConfigStore(paths)
    await configStore.save(configDocument())
    const app = await AgentApplication.create({
      paths,
      workspaceRoot: dir,
      configStore,
      chatStore: new ChatStore(paths),
      registry: new ToolRegistry(),
      providerFactory: textProviderFactory(['ok']),
    })
    const registry = new CommandRegistry()
    registry.register(
      fakeCommand({
        name: 'listful',
        result: {
          ok: true,
          code: 'selection',
          text: 'Pick one',
          data: {
            context: 'session_select',
            title: 'Pick one',
            // 非字符串字段一律当空串（命令返回的 data 不可信）
            items: [{ key: 'k1', title: 'First', description: 42 }],
          },
        },
      }),
    )
    const controller = new TuiController({ app, registry, host: new CommandHostAdapter(app) })
    await controller.start()

    controller.setInput('/listful')
    controller.applyKey({ name: 'enter' })
    await waitFor(() => controller.getState().selection !== undefined)
    expect(controller.getState().selection).toMatchObject({
      context: 'session_select',
      title: 'Pick one',
      items: [{ key: 'k1', title: 'First', description: '' }],
    })
  })

  it('命令返回 ok 时直接输出文本', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deepcode-tui-'))
    const paths = resolveAppPaths({ home: dir, cwd: dir })
    const configStore = new ConfigStore(paths)
    await configStore.save(configDocument())
    const app = await AgentApplication.create({
      paths,
      workspaceRoot: dir,
      configStore,
      chatStore: new ChatStore(paths),
      registry: new ToolRegistry(),
      providerFactory: textProviderFactory(['ok']),
    })
    const registry = new CommandRegistry()
    registry.register(
      fakeCommand({
        name: 'plainful',
        result: { ok: true, code: 'ok', text: 'done and dusted' },
      }),
    )
    const controller = new TuiController({ app, registry, host: new CommandHostAdapter(app) })
    await controller.start()

    controller.setInput('/plainful')
    controller.applyKey({ name: 'enter' })
    await waitFor(() => controller.getState().notice === 'done and dusted')
    expect(controller.getState().panel).toBeUndefined()
  })

  it('未知命令 → "未知命令"面板（命令层的 NOT_AVAILABLE）', async () => {
    const { controller } = await harness(textProviderFactory(['ok']))
    await controller.start()
    controller.setInput('/nope')
    controller.applyKey({ name: 'enter' })
    await waitFor(() => controller.getState().panel !== undefined)
    expect(controller.getState().panel?.title).toBe('Unknown command')
  })

  it('/workwith 缺参数 → 命令失败面板（不提交模型请求）', async () => {
    const { controller } = await harness(textProviderFactory(['ok']))
    await controller.start()
    controller.setInput('/workwith')
    controller.applyKey({ name: 'enter' })
    await waitFor(() => controller.getState().panel !== undefined)
    // 命令**存在**（缺参数），因此标题是命令名而不是"未知命令"
    expect(controller.getState().panel?.title).toBe('/workwith')
    expect(controller.getState().panel?.body).toContain('缺少参数')
  })

  it('命令菜单来自命令层的注册表（不是 TUI 自建），前缀过滤', async () => {
    const { controller } = await harness(textProviderFactory(['ok']))
    await controller.start()
    // TUI 只做投影，不拥有命令清单。
    // ⚠️ 断言**集合**而不是顺序：注册顺序是命令层的内部安排（它的测试负责），
    // TUI 只承诺"照它给的顺序渲染"。写死顺序会让命令层调整顺序时误伤这里。
    // 用 Set 比较：既不看顺序，也不依赖我手写的字典序（`langfuse` 与
    // `language` 的先后就够容易写错一次）。
    expect(new Set(controller.commands.map((command) => command.name))).toEqual(
      new Set([
        '1M',
        'api',
        'clear',
        'compact',
        'effort',
        'init',
        'language',
        'langfuse',
        'mcp',
        'model',
        'reasoning',
        'sessions',
        'skills',
        'thinking',
        'workwith',
      ]),
    )
    controller.setInput('/work')
    expect(controller.getState().selection?.items[0]?.key).toBe('/workwith')
  })

  it('/mcp 显示真实 MCP 状态而不是占位错误', async () => {
    const { controller } = await harness(textProviderFactory(['ok']))
    await controller.start()
    controller.setInput('/mcp')
    controller.applyKey({ name: 'enter' })
    await waitFor(() => controller.getState().panel !== undefined)
    const panel = controller.getState().panel!
    // 标题是命令名（命令**存在**），正文显示真实的空配置状态。
    expect(panel.title).toBe('/mcp')
    expect(panel.body).toContain('MCP')
    expect(panel.body).toContain('尚未配置')
  })

  it('无可选参数的命令走面板（/model 列出档位）', async () => {
    const { controller } = await harness(textProviderFactory(['ok']))
    await controller.start()
    controller.setInput('/model')
    controller.applyKey({ name: 'enter' })
    await waitFor(() => controller.getState().panel !== undefined)
    const panel = controller.getState().panel!
    expect(panel.title).toBe('/model')
    expect(panel.body).toContain('implementation')
  })
})

describe('端到端：待办面板', () => {
  async function writeTodoMessage(
    app: AgentApplication,
    sessionId: SessionId,
    todos: readonly { content: string; status: string }[],
  ): Promise<void> {
    await app.chatStore.addMessage({
      conversation_id: sessionId,
      role: 'tool',
      content: JSON.stringify({ tool_use_id: 'c1', content: 'Todo list updated.' }),
      turn_id: 'turn-1' as never,
      subtype: 'tool_result',
      tool_call_id: 'c1',
      meta: JSON.stringify({ tool_name: 'todo_write', ok: true, todos }),
      agent_type: '',
    })
  }

  it('todo_write 的工具结果事件触发刷新（数据来自存储的 meta）', async () => {
    const { app, controller } = await harness(textProviderFactory(['ok']))
    await controller.start()
    const sessionId = await submitAndSettle(controller, 'hi')

    await writeTodoMessage(app, sessionId, [
      { content: '写测试', status: 'completed' },
      { content: '改实现', status: 'in_progress' },
    ])
    await app.bus.publish({ sessionId, type: 'tool_result', data: { name: 'todo_write' } })
    await waitFor(() => controller.getState().todos.length === 2)

    expect(controller.getState().todoVisible).toBe(true)
    expect(controller.getState().todos.map((todo) => todo.status)).toEqual([
      'completed',
      'in_progress',
    ])
  })

  it('其他工具的结果事件不刷新待办', async () => {
    const { app, controller } = await harness(textProviderFactory(['ok']))
    await controller.start()
    const sessionId = await submitAndSettle(controller, 'hi')
    await writeTodoMessage(app, sessionId, [{ content: 'x', status: 'pending' }])
    await app.bus.publish({ sessionId, type: 'tool_result', data: { name: 'file_read' } })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(controller.getState().todos).toEqual([])
  })

  // BUG-COMPAT（§12.2 第 11 项）：`todos` 为空时**不清空面板**，
  // 只在新一轮 turn 开始时清空。
  it('BUG-COMPAT：空待办列表不清空已有面板', async () => {
    const { app, controller } = await harness(textProviderFactory(['ok']))
    await controller.start()
    const sessionId = await submitAndSettle(controller, 'hi')

    await writeTodoMessage(app, sessionId, [{ content: '先有', status: 'pending' }])
    await app.bus.publish({ sessionId, type: 'tool_result', data: { name: 'todo_write' } })
    await waitFor(() => controller.getState().todos.length === 1)

    // 再落一条空列表，面板保持不变
    await writeTodoMessage(app, sessionId, [])
    await app.bus.publish({ sessionId, type: 'tool_result', data: { name: 'todo_write' } })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(controller.getState().todos.map((todo) => todo.content)).toEqual(['先有'])

    // `turn_start` 才清空
    await app.bus.publish({ sessionId, type: 'turn_start', data: { turn_number: 2 } })
    await waitFor(() => controller.getState().todos.length === 0)
    expect(controller.getState().todoVisible).toBe(false)
  })
})

describe('端到端：事件驱动界面', () => {
  it('T-6：mode.change 事件切换模式（权限模式切换的表现层一半）', async () => {
    const { app, controller } = await harness(textProviderFactory(['ok']))
    await controller.start()
    const sessionId = await submitAndSettle(controller, 'hi')

    await app.bus.publish({ sessionId, type: 'mode.change', data: { mode: 'plan' } })
    await waitFor(() => controller.getState().mode === 3)
  })

  it('shift+tab 循环模式并驱动状态栏标签', async () => {
    const { controller, chatStore } = await harness(textProviderFactory(['ok']))
    await controller.start()
    expect(controller.getState().mode).toBe(0)
    controller.applyKey({ name: 'shift+tab' })
    expect(controller.getState().mode).toBe(1)
    await submitAndSettle(controller, '用自动编辑模式处理')
    expect((await chatStore.read()).runtime.turns.at(-1)?.mode).toBe('auto_edit')
    controller.applyKey({ name: 'shift+tab' })
    controller.applyKey({ name: 'shift+tab' })
    await submitAndSettle(controller, '只制定计划')
    expect((await chatStore.read()).runtime.turns.at(-1)?.mode).toBe('plan')
  })

  it('permission_resolved 事件会收起本地对话框（超时 / 其他客户端）', async () => {
    const { app, controller } = await harness(textProviderFactory(['ok']))
    await controller.start()
    const sessionId = await submitAndSettle(controller, 'hi')
    const abort = new AbortController()
    const pending = app.broker!.request(
      {
        request_id: 'req-timeout',
        session_id: sessionId,
        turn_id: 'turn-1',
        tool_call_id: 'call-1',
        tool_name: 'bash',
        args_preview: '{}',
        risk_level: 'low',
        reason: '',
        status: 'PENDING_USER_APPROVAL',
        created_at: '2026-09-15T00:00:00.000Z',
        expires_at: Date.now() + 60_000,
        resolved_at: null,
        resolved_by: '',
        resolution: '',
      } as never,
      abort.signal,
    )
    await waitFor(() => controller.getState().permissionQueue.length === 1)

    await app.resolvePermission({
      requestId: 'req-timeout',
      decision: 'deny',
      principalId: app.localPrincipalId,
      resolvedBy: 'system',
      reason: 'timeout',
    })
    await pending
    await waitFor(() => controller.getState().permissionQueue.length === 0)
  })
})

describe('端到端：界面状态机', () => {
  it('按键驱动输入框，Enter 提交后清空', async () => {
    const { controller } = await harness(textProviderFactory(['ok']))
    await controller.start()
    for (const char of 'hello') controller.applyKey({ name: 'char', char })
    expect(controller.getState().input).toBe('hello')
    expect(controller.getState().cursor).toBe(5)

    controller.applyKey({ name: 'backspace' })
    expect(controller.getState().input).toBe('hell')

    controller.applyKey({ name: 'home' })
    expect(controller.getState().cursor).toBe(0)
    controller.applyKey({ name: 'char', char: 'X' })
    expect(controller.getState().input).toBe('Xhell')

    // 光标移动也要反映到状态（左右 / End）
    controller.applyKey({ name: 'left' })
    expect(controller.getState().cursor).toBe(0)
    controller.applyKey({ name: 'end' })
    expect(controller.getState().cursor).toBe(controller.getState().input.length)
  })

  it('双击 Esc 清空输入', async () => {
    const { controller, advanceTime } = await harness(textProviderFactory(['ok']))
    await controller.start()
    controller.setInput('draft')
    controller.applyKey({ name: 'escape' })
    expect(controller.getState().input).toBe('draft')
    advanceTime(100)
    controller.applyKey({ name: 'escape' })
    expect(controller.getState().input).toBe('')
  })

  it('up 翻输入历史', async () => {
    const { controller } = await harness(textProviderFactory(['ok']))
    await controller.start()
    await submitAndSettle(controller, '第一条')

    controller.applyKey({ name: 'up' })
    expect(controller.getState().input).toBe('第一条')
    controller.applyKey({ name: 'down' })
    expect(controller.getState().input).toBe('')
  })

  it('50ms 节流：快照落后于内部状态，但状态本身始终最新', async () => {
    const { app, controller, advanceTime } = await harness(hangingProviderFactory())
    await controller.start()
    controller.setInput('长任务')
    controller.applyKey({ name: 'enter' })
    await waitFor(() => controller.getState().streaming)
    const sessionId = controller.getState().sessionId!
    // 等真实 provider 的首段文本与 turn_start 都处理完，再单独检验节流。
    // 仅等 `streaming` 会在提交入口提前成立，后台事件可能恰好把 B 冲进快照。
    await waitFor(() => controller.getState().streamingText.includes('partial'))
    controller.flushPublished()
    advanceTime(60)

    // 越过上一帧的节流窗口，第一次手动推进会发布。
    await app.bus.publish({ sessionId, type: 'text', data: { content: 'A' } })
    await waitFor(() => controller.getSnapshot().streamingText.endsWith('A'))

    // 50ms 窗口内的第二次推进：**内部状态更新，快照不更新**
    await app.bus.publish({ sessionId, type: 'text', data: { content: 'B' } })
    await waitFor(() => controller.getState().streamingText.endsWith('B'))
    expect(controller.getSnapshot().streamingText).not.toContain('B')

    // 越过窗口后恢复发布
    advanceTime(60)
    await app.bus.publish({ sessionId, type: 'text', data: { content: 'C' } })
    await waitFor(() => controller.getSnapshot().streamingText.includes('C'))
    expect(controller.getSnapshot().streamingText).toBe(controller.getState().streamingText)
  }, 10_000)
})
