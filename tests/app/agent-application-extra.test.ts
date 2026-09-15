/**
 * `AgentApplication` 的组合根与生命周期分支。
 *
 * `agent-application.test.ts` 覆盖了正常装配与主流程。这里补的是**装配开关**：
 * - 每个"测试注入点"缺省时 `create()` 自建，注入时不新建（`broker` 变成
 *   `undefined`，对应的回灌方法要给出**可读的拒绝**而不是静默失败）；
 * - `currentTurnId()` 这个给 Web `POST /turns/:id/cancel` 用的反查口子；
 * - 启动时的**幂等记录剪枝**——剪错会把还没过期的记录删掉，导致刷新页面
 *   重跑一次副作用；
 * - `dispose()` 的幂等。
 */
import { mkdtemp } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { AgentApplication, describeStartupFailure } from '../../src/app/agent-application.js'
import { DEFAULT_APP_POLICY } from '../../src/app/policy.js'
import { ChatStore } from '../../src/storage/chat-store.js'
import { ConfigStore } from '../../src/storage/config-store.js'
import { resolveAppPaths } from '../../src/storage/paths.js'
import { ToolRegistry } from '../../src/tools/registry.js'
import { AgentError, ErrorCode } from '../../src/core/errors.js'
import type { UserInputRequest, UserInputService } from '../../src/core/input.js'
import { ModelEventType, ModelTier, type Provider } from '../../src/core/provider.js'
import {
  PermissionAction,
  type ApprovalService,
  type PermissionRequest,
} from '../../src/core/tool.js'
import { createFakeClock, type Clock } from '../../src/core/time.js'
import { DEFAULT_BUDGET } from '../../src/core/budget.js'
import { TerminalReason, TurnStatus } from '../../src/core/turn.js'
import type { ConfigDocument } from '../../src/storage/types.js'

const provider: Provider = {
  id: 'p',
  name: 'test',
  baseUrl: 'https://api.anthropic.com',
  apiKeyRef: { source: 'env', key: 'TEST_KEY' },
  createdAt: '',
  updatedAt: '',
}

const config = (): ConfigDocument => ({
  schema_version: 1,
  llm_channels: [],
  llm_models: [],
  app_settings: {},
  providers: [{ ...provider, enabled: true }],
  model_profiles: [
    {
      id: 'm1',
      providerId: 'p',
      contextWindow: 100_000,
      maxOutputTokens: 4096,
      supportsThinking: true,
      supportsTools: true,
      supportsVision: false,
      supports1MContext: false,
      enabled: true,
      thinkingEnabled: false,
    },
  ],
  tier_assignments: [
    {
      tier: ModelTier.IMPLEMENTATION,
      modelRef: { providerId: 'p', modelId: 'm1' },
      enabled: true,
      fallbackModelRefs: [],
    },
  ],
})

const textFactory = (() => ({
  stream: () => ({
    usage: { inputTokens: 1, outputTokens: 1 },
    async *[Symbol.asyncIterator]() {
      await Promise.resolve()
      yield { type: ModelEventType.TEXT, content: '完成' } as never
    },
  }),
  probe: () => Promise.resolve({ ok: true }),
})) as never

const hangingFactory = (() => ({
  stream: (_req: unknown, signal: AbortSignal) => ({
    usage: { inputTokens: 0, outputTokens: 0 },
    [Symbol.asyncIterator]() {
      return {
        next: (): Promise<IteratorResult<never>> =>
          new Promise((_r, reject) => {
            if (signal.aborted) reject(new Error('aborted'))
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
          }),
      }
    },
  }),
  probe: () => Promise.resolve({ ok: true }),
})) as never

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** 只满足接口、不做任何事的审批/提问替身——用来验证"注入后 broker 为 undefined"。 */
const approvalStub: ApprovalService = {
  request: (req: PermissionRequest) =>
    Promise.resolve({
      requestId: req.request_id,
      decision: PermissionAction.DENY,
      resolvedBy: 'system',
      reason: '测试替身',
    }),
}
const userInputStub: UserInputService = {
  request: (req: UserInputRequest) =>
    Promise.resolve({ requestId: req.request_id, answers: null, resolvedBy: 'system' }),
}

function pathsIn(dir: string) {
  return resolveAppPaths({ home: dir, cwd: dir })
}

describe('AgentApplication.create：全部注入点缺省时自建', () => {
  it('不传 paths/configStore/chatStore/providerFactory 也能装配成功', async () => {
    // 默认路径来自 `homedir()` 与 `process.cwd()`，所以这里临时把它们指到
    // 临时目录——否则这个测试会往用户真实的 `~/.deepcode` 里写东西。
    const dir = await mkdtemp(join(tmpdir(), 'deepcode-app-default-'))
    const home = join(dir, 'home')
    const cwd = join(dir, 'cwd')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(home, { recursive: true })
    await mkdir(cwd, { recursive: true })

    const previousHome = process.env['HOME']
    const previousCwd = process.cwd()
    try {
      process.env['HOME'] = home
      process.chdir(cwd)

      const app = await AgentApplication.create({})

      // cwd 可能经过符号链接（macOS 的 /var → /private/var），故用 realpath 比对
      const realCwd = realpathSync(cwd)
      expect(app.paths.project_dir).toBe(join(realCwd, '.deepcode'))
      // `homedir()` 直接读 $HOME，不做 realpath；cwd 则来自已是真实路径的 process.cwd()
      expect(app.paths.global_dir).toBe(join(home, '.deepcode'))
      // workspaceRoot 缺省时由 project_dir 去掉 `/.deepcode` 后缀推出
      expect(app.workspaceRoot).toBe(realCwd)
      expect(app.configStore).toBeInstanceOf(ConfigStore)
      expect(app.chatStore).toBeInstanceOf(ChatStore)
      // 未注入 broker/提问服务 → 默认那套（事件由 broker 发）
      expect(app.broker).toBeDefined()
      expect(app.userInputBroker).toBeDefined()
      // 默认 provider 工厂是 Anthropic Messages（不发起请求就不会用到密钥）
      expect(app.localPrincipalId).toBeTruthy()

      app.dispose()
    } finally {
      process.chdir(previousCwd)
      if (previousHome === undefined) delete process.env['HOME']
      else process.env['HOME'] = previousHome
    }
  })

  it('注入自定义 approvalService / userInputService 时不建 broker（避免双重弹窗）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deepcode-app-inject-'))
    const paths = pathsIn(dir)
    const configStore = new ConfigStore(paths)
    await configStore.save(config())

    const app = await AgentApplication.create({
      paths,
      workspaceRoot: dir,
      configStore,
      chatStore: new ChatStore(paths),
      registry: new ToolRegistry(),
      providerFactory: textFactory,
      approvalService: approvalStub,
      userInputService: userInputStub,
    })

    expect(app.broker).toBeUndefined()
    expect(app.userInputBroker).toBeUndefined()

    // 回灌入口必须给出**可读的拒绝**，而不是抛异常或静默成功
    const permission = await app.resolvePermission({
      requestId: 'req_1',
      decision: PermissionAction.ALLOW,
      principalId: app.localPrincipalId,
    })
    expect(permission).toMatchObject({ ok: false, code: ErrorCode.INTERNAL_ERROR })
    expect(permission.ok === false && permission.message).toContain('approvalService')

    const answer = await app.answerUserInput({
      requestId: 'req_1',
      answers: [['a']],
      principalId: app.localPrincipalId,
    })
    expect(answer).toMatchObject({ ok: false, code: ErrorCode.INTERNAL_ERROR })
    expect(answer.ok === false && answer.message).toContain('userInputService')

    // 待办列表在无 broker 时是空数组而不是 undefined（客户端不该做空值分支）
    expect(app.listPendingApprovals()).toEqual([])
    expect(app.listPendingUserInputs()).toEqual([])
    expect(app.listPendingApprovals('s_任意' as never)).toEqual([])

    app.dispose()
  })

  it('注入 mode/budget/maxTurns 时被带进 runtime', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deepcode-app-opts-'))
    const paths = pathsIn(dir)
    const configStore = new ConfigStore(paths)
    await configStore.save(config())

    const app = await AgentApplication.create({
      paths,
      workspaceRoot: dir,
      configStore,
      chatStore: new ChatStore(paths),
      registry: new ToolRegistry(),
      providerFactory: textFactory,
      mode: 'plan',
      budget: DEFAULT_BUDGET,
      maxTurns: 3,
    })

    const session = await app.createSession(app.localPrincipalId)
    const { result } = await app.submitTurn({
      principalId: app.localPrincipalId,
      sessionId: session.id,
      prompt: '跑一下',
    })
    expect(result.status).toBe('completed')
    app.dispose()
  })
})

describe('AgentApplication：currentTurnId 反查', () => {
  it('没有活跃 turn 时返回 undefined（Web 的 cancel 路由据此回 404）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deepcode-app-turnid-'))
    const paths = pathsIn(dir)
    const configStore = new ConfigStore(paths)
    await configStore.save(config())
    const app = await AgentApplication.create({
      paths,
      workspaceRoot: dir,
      configStore,
      chatStore: new ChatStore(paths),
      registry: new ToolRegistry(),
      providerFactory: hangingFactory,
    })

    const session = await app.createSession(app.localPrincipalId)
    expect(await app.currentTurnId(session.id)).toBeUndefined()
    // 别的会话也一样
    expect(await app.currentTurnId('s_不存在' as never)).toBeUndefined()
    app.dispose()
  })

  it('turn 在飞时能反查出 turnId（否则只能全表扫描 chat.json）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deepcode-app-turnid2-'))
    const paths = pathsIn(dir)
    const configStore = new ConfigStore(paths)
    await configStore.save(config())
    const app = await AgentApplication.create({
      paths,
      workspaceRoot: dir,
      configStore,
      chatStore: new ChatStore(paths),
      registry: new ToolRegistry(),
      providerFactory: hangingFactory,
    })

    const session = await app.createSession(app.localPrincipalId)
    const pending = app.submitTurn({
      principalId: app.localPrincipalId,
      sessionId: session.id,
      prompt: '会挂住',
    })
    // 轮询而不是定长 sleep：turn 的 phase 是 runtime 落盘之后才可见的，
    // 满负载跑整套测试时 30ms 并不总是够。
    let turnId: Awaited<ReturnType<typeof app.currentTurnId>>
    for (let i = 0; i < 200; i++) {
      turnId = await app.currentTurnId(session.id)
      if (turnId !== undefined) break
      await sleep(10)
    }
    expect(turnId).toBeTruthy()

    app.cancelTurn(session.id)
    await pending
    // 结束后不再是活跃 turn
    expect(await app.currentTurnId(session.id)).toBeUndefined()
    app.dispose()
  })
})

describe('AgentApplication：等待与生命周期', () => {
  it('awaitTurn 对没有在飞 turn 的会话立即返回 undefined', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deepcode-app-await-'))
    const paths = pathsIn(dir)
    const configStore = new ConfigStore(paths)
    await configStore.save(config())
    const app = await AgentApplication.create({
      paths,
      workspaceRoot: dir,
      configStore,
      chatStore: new ChatStore(paths),
      registry: new ToolRegistry(),
      providerFactory: textFactory,
    })
    const session = await app.createSession(app.localPrincipalId)

    expect(await app.awaitTurn(session.id)).toBeUndefined()
    app.dispose()
  })

  it('预算在首个模型调用前耗尽：turn 正常返回 partial，awaitTurn 也能等到它', async () => {
    // 这里原本固化的是一个缺陷（已按 ADR 0003 修正）：
    //
    // 预算在**首个模型调用之前**耗尽（`maxWallTimeMs: 0`）时，`AgentRuntime.finish()`
    // 试图做 `building_context -> budget_exceeded` 迁移，而迁移表里没有这条边，
    // 于是整个 turn 以 `INVALID_STATE_TRANSITION` **拒绝**收场——一个纯粹的资源限制
    // 被当成"内部状态机错误"抛给用户。真实触发路径是"turn 在第一次模型调用前就因为
    // 存储慢 / 上下文巨大而超时"，不只是 0 这个极端值。
    //
    // 修正后：预算耗尽统一绕行 finalizing，且收尾调用都 await 了，
    // turn 正常产出 `partial` 结果；`awaitTurn` 仍必须能等到它。
    const dir = await mkdtemp(join(tmpdir(), 'deepcode-app-await2-'))
    const paths = pathsIn(dir)
    const configStore = new ConfigStore(paths)
    await configStore.save(config())
    const app = await AgentApplication.create({
      paths,
      workspaceRoot: dir,
      configStore,
      chatStore: new ChatStore(paths),
      registry: new ToolRegistry(),
      providerFactory: textFactory,
      budget: { ...DEFAULT_BUDGET, maxWallTimeMs: 0 },
    })
    const session = await app.createSession(app.localPrincipalId)

    const pending = app.submitTurn({
      principalId: app.localPrincipalId,
      sessionId: session.id,
      prompt: '会超预算',
    })
    const submitted = await pending
    expect(submitted.result.status).toBe(TurnStatus.PARTIAL)
    expect(submitted.result.terminal_reason).toBe(TerminalReason.BUDGET_EXCEEDED)
    // awaitTurn 在这个会话上已经无事可等——turn 已收尾，返回 undefined 是正常语义。
    expect(await app.awaitTurn(session.id)).toBeUndefined()
    app.dispose()
  })

  it('dispose() 幂等：重复调用不会二次关闭事件日志或重复 abort', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deepcode-app-dispose-'))
    const paths = pathsIn(dir)
    const configStore = new ConfigStore(paths)
    await configStore.save(config())
    const app = await AgentApplication.create({
      paths,
      workspaceRoot: dir,
      configStore,
      chatStore: new ChatStore(paths),
      registry: new ToolRegistry(),
      providerFactory: textFactory,
    })

    expect(app.disposed).toBe(false)
    app.dispose()
    expect(app.disposed).toBe(true)
    // 第二次必须是空操作，否则重复释放会让并发关闭路径炸掉
    expect(() => app.dispose()).not.toThrow()
  })

  it('dispose 之后恢复扫描结果仍然可读（不返回 undefined）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deepcode-app-recovery-'))
    const paths = pathsIn(dir)
    const configStore = new ConfigStore(paths)
    await configStore.save(config())
    const app = await AgentApplication.create({
      paths,
      workspaceRoot: dir,
      configStore,
      chatStore: new ChatStore(paths),
      registry: new ToolRegistry(),
      providerFactory: textFactory,
    })

    const snapshot = app.recovery()
    expect(snapshot).toMatchObject({
      unfinishedTurns: [],
      pendingPermissions: [],
      pendingUserInputs: [],
      unknownExecutions: [],
    })
    app.dispose()
  })
})

describe('AgentApplication：模型偏好的可选字段', () => {
  async function build() {
    const dir = await mkdtemp(join(tmpdir(), 'deepcode-app-pref-'))
    const paths = pathsIn(dir)
    const configStore = new ConfigStore(paths)
    await configStore.save(config())
    const app = await AgentApplication.create({
      paths,
      workspaceRoot: dir,
      configStore,
      chatStore: new ChatStore(paths),
      registry: new ToolRegistry(),
      providerFactory: textFactory,
    })
    return { app, dir }
  }

  /**
   * 未分配的档位 → **抛 `MODEL_NOT_FOUND`**，不是静默跳过。
   *
   * 早先这里 `return`：写入被无声丢弃而调用方拿到"成功"。
   * 与 ADR 0004 D9 修掉的是同一族问题（"让我改东西，什么也没改，还不告诉我"）。
   * 命令层在调用前已用 `findPrimaryModel` 挡了一道，所以正常路径看不到这个错误；
   * 它挡住的是并发删除档位、以及指向已删 profile 的悬空分配。
   *
   * 这条用例同时守住"不误改别的模型"——检查在写之前发生。
   */
  it('未分配的档位抛 MODEL_NOT_FOUND，且不误改别的模型', async () => {
    const { app } = await build()
    const before = await app.configStore.read()

    await expect(
      app.updateModelPreferences(ModelTier.FAST, { thinkingEnabled: true }),
    ).rejects.toMatchObject({ code: ErrorCode.MODEL_NOT_FOUND })

    const after = await app.configStore.read()
    expect(after.model_profiles).toEqual(before.model_profiles)
    app.dispose()
  })

  it('档位指向一个已被删除的 profile 时同样抛错（悬空分配）', async () => {
    const { app } = await build()
    const before = await app.configStore.read()

    await expect(app.setModelContextWindow(ModelTier.FAST, 1_000_000)).rejects.toMatchObject({
      code: ErrorCode.MODEL_NOT_FOUND,
    })

    expect((await app.configStore.read()).model_profiles).toEqual(before.model_profiles)
    app.dispose()
  })

  it('只给 thinkingEnabled 时不覆盖已有的 reasoningEffort（反之亦然）', async () => {
    // 两个偏好互相独立：一次 /thinking 不该顺手把 /effort 的设置清掉。
    const { app } = await build()
    await app.updateModelPreferences(ModelTier.IMPLEMENTATION, { reasoningEffort: 'high' })
    await app.updateModelPreferences(ModelTier.IMPLEMENTATION, { thinkingEnabled: true })

    const doc = await app.configStore.read()
    expect(doc.model_profiles[0]?.thinkingEnabled).toBe(true)
    expect(doc.model_profiles[0]?.reasoningEffort).toBe('high')
    app.dispose()
  })

  it('两个字段都给时同时生效', async () => {
    const { app } = await build()
    await app.updateModelPreferences(ModelTier.IMPLEMENTATION, {
      thinkingEnabled: false,
      reasoningEffort: 'low',
    })
    const doc = await app.configStore.read()
    expect(doc.model_profiles[0]?.thinkingEnabled).toBe(false)
    expect(doc.model_profiles[0]?.reasoningEffort).toBe('low')
    app.dispose()
  })
})

describe('AgentApplication：启动时的幂等记录剪枝', () => {
  it('剪掉过期的、保留未过期的与时间戳损坏的', async () => {
    // 剪枝是 ChatStore 没有的能力（它只管读写）。三种记录必须分别对待：
    // 过期 → 删；未过期 → 留（删了会让刷新页面重跑一次副作用）；
    // createdAt 解析不出时间 → 留（宁可留着也不能因为一条脏记录删掉它）。
    const dir = await mkdtemp(join(tmpdir(), 'deepcode-app-prune-'))
    const paths = pathsIn(dir)
    const configStore = new ConfigStore(paths)
    await configStore.save(config())

    const clock = createFakeClock(Date.parse('2026-09-15T00:00:00.000Z'))
    const chatStore = new ChatStore(paths, clock)
    await chatStore.initialize()
    await chatStore.putIdempotency({
      key: 'k_old',
      operation: 'op',
      requestHash: 'h',
      response: null,
      createdAt: '2000-01-01T00:00:00.000Z',
    })
    await chatStore.putIdempotency({
      key: 'k_new',
      operation: 'op',
      requestHash: 'h',
      response: null,
      createdAt: '2026-09-14T23:59:00.000Z',
    })
    await chatStore.putIdempotency({
      key: 'k_broken',
      operation: 'op',
      requestHash: 'h',
      response: null,
      createdAt: '不是日期',
    })

    const app = await AgentApplication.create({
      paths,
      workspaceRoot: dir,
      clock,
      configStore,
      chatStore,
      registry: new ToolRegistry(),
      providerFactory: textFactory,
    })

    const doc = await chatStore.read()
    expect(doc.runtime.idempotency.map((r) => r.key).sort()).toEqual(['k_broken', 'k_new'])
    app.dispose()
  })

  it('没有记录需要剪时不写盘（revision 不变，避免无谓的磁盘写与事件噪音）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deepcode-app-prune2-'))
    const paths = pathsIn(dir)
    const configStore = new ConfigStore(paths)
    await configStore.save(config())
    const chatStore = new ChatStore(paths)
    await chatStore.initialize()
    await chatStore.putIdempotency({
      key: 'k_keep',
      operation: 'op',
      requestHash: 'h',
      response: null,
      createdAt: new Date().toISOString(),
    })
    const before = (await chatStore.read()).runtime.revision

    const app = await AgentApplication.create({
      paths,
      workspaceRoot: dir,
      configStore,
      chatStore,
      registry: new ToolRegistry(),
      providerFactory: textFactory,
    })

    expect((await chatStore.read()).runtime.revision).toBe(before)
    app.dispose()
  })

  it('时钟给出无法解析的时刻时整段跳过剪枝，而不是把所有记录当成过期删光', async () => {
    // ⚠️ 值得固化的防御：`Date.parse` 返回 NaN 时 `at >= cutoff` 恒为 false，
    // 若不做这层保护，一次时钟异常就会把整张幂等表清空——用户刷新页面
    // 会重跑所有副作用。这里用"坏时钟"验证它选择的是"什么都不做"。
    const dir = await mkdtemp(join(tmpdir(), 'deepcode-app-prune3-'))
    const paths = pathsIn(dir)
    const configStore = new ConfigStore(paths)
    await configStore.save(config())

    const chatStore = new ChatStore(paths)
    await chatStore.initialize()
    await chatStore.putIdempotency({
      key: 'k1',
      operation: 'op',
      requestHash: 'h',
      response: null,
      createdAt: '2026-09-15T00:00:00.000Z',
    })

    const brokenClock: Clock = {
      now: () => '不是日期',
      nowMs: () => Date.parse('2026-09-15T00:00:00.000Z'),
    }
    const app = await AgentApplication.create({
      paths,
      workspaceRoot: dir,
      clock: brokenClock,
      configStore,
      chatStore,
      registry: new ToolRegistry(),
      providerFactory: textFactory,
    })

    expect((await chatStore.read()).runtime.idempotency.map((r) => r.key)).toEqual(['k1'])
    app.dispose()
  })
})

describe('describeStartupFailure：CLI 的启动错误出口', () => {
  it('已经带错误码的直接透传（保留 source 与 code）', () => {
    const original = new AgentError({
      code: ErrorCode.STORAGE_SCHEMA_UNSUPPORTED,
      message: 'schema 太新',
      source: 'config',
    })
    expect(describeStartupFailure(original)).toBe(original)
  })

  it('普通异常被包上启动上下文，方便 CLI 打印一条可读原因', () => {
    const wrapped = describeStartupFailure(new Error('端口被占用'))
    expect(wrapped.message).toContain('端口被占用')
    expect(wrapped.source).toBe('app.startup')
  })

  it('非 Error 的抛出值也能得到可读消息', () => {
    expect(describeStartupFailure('裸字符串').message).toBeTruthy()
    expect(DEFAULT_APP_POLICY.idempotencyTtlMs).toBeGreaterThan(0)
  })
})
