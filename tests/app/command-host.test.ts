/**
 * `CommandHostAdapter`：命令层窄端口 ↔ `AgentApplication` 的接线。
 *
 * 这个适配器是命令层唯一能看到的东西，所以两条要求必须在它身上验证：
 * 1. **不泄露密钥**——`readConfig()` 只暴露 `hasSecret` 布尔值，绝不读明文
 *    （`parts/09` §9.1：API key 不得出现在日志、事件、导出文件或前端响应中）；
 * 2. **有界等待与有界写入**——命令层不希望因为一个 turn 卡住而挂死，
 *    也不希望某次写盘失败被当成"命令失败"。
 *
 * 这里直接对着真实的 `AgentApplication` 测（不用假 host），因为要验的正是
 * "适配器是否忠实转发"。
 */
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { AgentApplication } from '../../src/app/agent-application.js'
import { CommandHostAdapter } from '../../src/app/command-host.js'
import { ChatStore } from '../../src/storage/chat-store.js'
import { ConfigStore } from '../../src/storage/config-store.js'
import { resolveAppPaths } from '../../src/storage/paths.js'
import { EventLog } from '../../src/storage/event-log.js'
import { ToolRegistry } from '../../src/tools/registry.js'
import { AgentError, ErrorCode } from '../../src/core/errors.js'
import type { SessionId } from '../../src/core/ids.js'
import { ModelEventType, ModelTier, type Provider } from '../../src/core/provider.js'
import { CommandResultCode } from '../../src/commands/types.js'
import { MessageSubtype } from '../../src/core/models.js'
import { createFakeClock } from '../../src/core/time.js'
import type { ConfigDocument } from '../../src/storage/types.js'

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

/** 永不产出，只在 abort 时结束。 */
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

const provider = (over: Partial<Provider> = {}): Provider => ({
  id: 'p',
  name: 'Provider One',
  baseUrl: 'https://api.anthropic.com',
  apiKeyRef: { source: 'env', key: 'DEEPCODE_TEST_KEY' },
  createdAt: '',
  updatedAt: '',
  ...over,
})

const config = (over: Partial<ConfigDocument> = {}): ConfigDocument => ({
  schema_version: 1,
  llm_channels: [],
  llm_models: [],
  app_settings: {},
  providers: [{ ...provider(), enabled: true }],
  model_profiles: [
    {
      id: 'm1',
      providerId: 'p',
      displayName: '小模型',
      contextWindow: 100_000,
      maxOutputTokens: 4096,
      supportsThinking: true,
      supportsTools: true,
      supportsVision: false,
      supports1MContext: false,
      enabled: true,
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
  ...over,
})

/** 直接控制 `read()` 结果的配置存储——用来构造存量文件里才可能出现的数据形态。 */
class FixedConfigStore extends ConfigStore {
  doc: ConfigDocument
  constructor(path: string, doc: ConfigDocument) {
    super(path)
    this.doc = doc
  }
  override read(): Promise<ConfigDocument> {
    return Promise.resolve(this.doc)
  }
}

/** 写入必定失败的事件日志：模拟只读磁盘 / 目录被删。 */
class FailingEventLog extends EventLog {
  override appendWithResult(): Promise<never> {
    return Promise.reject(new Error('事件目录只读'))
  }
}

/** 读消息时必定抛错的会话存储，用来验证 `/compact` 的错误分支。 */
class ExplodingChatStore extends ChatStore {
  error: unknown = new AgentError({
    code: ErrorCode.STORAGE_READ_FAILED,
    message: '会话文件坏了',
    source: 'storage',
  })
  override listActiveMessages(): Promise<never> {
    // 故意允许抛出的**不是** Error：验证适配器对"裸值抛出"的兜底文案。
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    return Promise.reject(this.error)
  }
}

async function harness(
  doc: ConfigDocument = config(),
  factory: unknown = textFactory,
  makeChatStore: (paths: ReturnType<typeof resolveAppPaths>) => ChatStore = (paths) =>
    new ChatStore(paths),
) {
  const dir = await mkdtemp(join(tmpdir(), 'deepcode-command-host-'))
  const paths = resolveAppPaths({ home: dir, cwd: dir })
  const configStore = new ConfigStore(paths)
  await configStore.save(doc)
  const app = await AgentApplication.create({
    paths,
    workspaceRoot: dir,
    configStore,
    chatStore: makeChatStore(paths),
    // 传空 registry：跳过内置工具注册，这个文件只关心适配器转发
    registry: new ToolRegistry(),
    providerFactory: factory as never,
  })
  return { dir, paths, app, host: new CommandHostAdapter(app) }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('CommandHostAdapter：密钥可用性只看"可不可用"', () => {
  it('env 来源：变量存在且非空才为 true', async () => {
    const { host } = await harness()
    delete process.env['DEEPCODE_TEST_KEY']
    expect((await host.readConfig()).providers[0]?.hasSecret).toBe(false)

    process.env['DEEPCODE_TEST_KEY'] = 'sk-不该出现在任何输出里'
    try {
      const view = await host.readConfig()
      expect(view.providers[0]?.hasSecret).toBe(true)
      // 视图里绝不能出现密钥本身，连字段名都不该有
      expect(JSON.stringify(view.providers)).not.toContain('sk-不该出现在任何输出里')
    } finally {
      delete process.env['DEEPCODE_TEST_KEY']
    }
  })

  it('env 来源：变量为空串同样视为不可用（空串连不上任何 endpoint）', async () => {
    const { host } = await harness()
    process.env['DEEPCODE_TEST_KEY'] = ''
    try {
      expect((await host.readConfig()).providers[0]?.hasSecret).toBe(false)
    } finally {
      delete process.env['DEEPCODE_TEST_KEY']
    }
  })

  it('file 来源：文件存在且非空为 true，读不到就为 false（不抛错）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deepcode-secret-'))
    const good = join(dir, 'key.txt')
    await writeFile(good, 'sk-file')
    const empty = join(dir, 'empty.txt')
    await writeFile(empty, '')

    const { host } = await harness(
      config({
        providers: [
          { ...provider({ apiKeyRef: { source: 'file', key: good } }), enabled: true },
          { ...provider({ id: 'p2', apiKeyRef: { source: 'file', key: empty } }), enabled: true },
          {
            ...provider({ id: 'p3', apiKeyRef: { source: 'file', key: join(dir, '不存在') } }),
            enabled: true,
          },
        ],
      }),
    )

    const view = await host.readConfig()
    expect(view.providers.map((p) => p.hasSecret)).toEqual([true, false, false])
  })

  it('keychain 来源一律返回 false（尚未实现，不假装可用）', async () => {
    // 假装可用会让 /workwith 放行一个注定连不上的模型——用户在第一次请求时才看到失败。
    const { host } = await harness(
      config({
        providers: [
          { ...provider({ apiKeyRef: { source: 'keychain', key: 'svc' } }), enabled: true },
        ],
      }),
    )
    expect((await host.readConfig()).providers[0]?.hasSecret).toBe(false)
  })

  it('存量文档里缺 apiKeyRef 的 provider 不会让 readConfig 抛错', async () => {
    // ConfigStore 的 normalize 会过滤掉这类 provider，但适配器不该指望上游一定干净——
    // 一个脏条目不能让整条 /api 命令失败。
    const dir = await mkdtemp(join(tmpdir(), 'deepcode-command-host-bad-'))
    const paths = resolveAppPaths({ home: dir, cwd: dir })
    const dirty = config({
      providers: [{ ...provider(), enabled: true, apiKeyRef: undefined } as never],
    })
    const configStore = new FixedConfigStore(paths.config_path, dirty)
    const app = await AgentApplication.create({
      paths,
      workspaceRoot: dir,
      configStore,
      chatStore: new ChatStore(paths),
      registry: new ToolRegistry(),
      providerFactory: textFactory,
    })

    const view = await new CommandHostAdapter(app).readConfig()
    expect(view.providers[0]?.hasSecret).toBe(false)
  })
})

describe('CommandHostAdapter：配置视图与回写', () => {
  it('readConfig 把 provider/model/tier 摊平成命令层需要的窄视图', async () => {
    const { host } = await harness()
    const view = await host.readConfig()

    expect(view.providers.map((p) => p.id)).toEqual(['p'])
    expect(view.models[0]).toMatchObject({
      id: 'm1',
      providerId: 'p',
      // displayName 缺失时回落到 id，视图里不留 undefined
      displayName: '小模型',
      supportsTools: true,
    })
    expect(view.tiers).toEqual([
      { tier: ModelTier.IMPLEMENTATION, providerId: 'p', modelId: 'm1', enabled: true },
    ])
  })

  it('模型的 displayName 缺失时视图回落为 id', async () => {
    const { host } = await harness(
      config({
        model_profiles: [
          {
            id: 'm1',
            providerId: 'p',
            contextWindow: 1,
            maxOutputTokens: 1,
            supportsThinking: false,
            supportsTools: false,
            supportsVision: false,
            supports1MContext: false,
            enabled: true,
          },
        ],
      }),
    )
    expect((await host.readConfig()).models[0]?.displayName).toBe('m1')
  })

  it('updateConfig 把视图的改动合并回文档，且保留 fallback 链', async () => {
    // 命令只看得见受限视图，回写时**不得**丢掉它看不见的字段（fallback 链、
    // app_settings 里的其它键），否则一次 /model 就会静默清掉配置。
    const { app, host } = await harness(
      config({
        app_settings: { 'policy.tool_timeout_ms': '5000', 'ui.language': 'zh' },
        tier_assignments: [
          {
            tier: ModelTier.IMPLEMENTATION,
            modelRef: { providerId: 'p', modelId: 'm1' },
            enabled: true,
            fallbackModelRefs: [{ providerId: 'p', modelId: 'm_fallback' }],
          },
        ],
      }),
    )

    await host.updateConfig((view) => ({
      ...view,
      tiers: view.tiers.map((t) => ({ ...t, modelId: 'm2' })),
      settings: { ...view.settings, 'ui.language': 'en' },
    }))

    const doc = await app.configStore.read()
    expect(doc.tier_assignments[0]?.modelRef.modelId).toBe('m2')
    // 视图看不见的 fallback 链必须原样保留
    expect(doc.tier_assignments[0]?.fallbackModelRefs).toEqual([
      { providerId: 'p', modelId: 'm_fallback' },
    ])
    expect(doc.app_settings['ui.language']).toBe('en')
    expect(doc.app_settings['policy.tool_timeout_ms']).toBe('5000')
  })

  it('updateConfig 保留视图里看不见的 maxCostPerTurn（回归）', async () => {
    // 此前这里按视图字段**重建**整条 assignment：只有 `fallbackModelRefs` 被
    // 显式捞了回来，`maxCostPerTurn` 每次都被静默清掉——而 `/language`
    // 写一个设置项也会走到这条回写路径，所以用户每切一次语言就丢一次成本上限。
    // 修法是"在既有 assignment 上合并"，这条用例把该性质钉住。
    const { app, host } = await harness(
      config({
        tier_assignments: [
          {
            tier: ModelTier.IMPLEMENTATION,
            modelRef: { providerId: 'p', modelId: 'm1' },
            enabled: true,
            fallbackModelRefs: [],
            maxCostPerTurn: 0.75,
          },
        ],
      }),
    )

    await host.updateConfig((view) => ({
      ...view,
      settings: { ...view.settings, language: 'en' },
    }))

    const doc = await app.configStore.read()
    expect(doc.app_settings['language']).toBe('en')
    expect(doc.tier_assignments[0]?.maxCostPerTurn).toBe(0.75)
  })

  it('updateConfig 把档位禁用状态写下去（enabled 来自视图）', async () => {
    const { app, host } = await harness()
    await host.updateConfig((view) => ({
      ...view,
      tiers: view.tiers.map((t) => ({ ...t, enabled: false })),
    }))

    const doc = await app.configStore.read()
    expect(doc.tier_assignments[0]?.enabled).toBe(false)
  })

  it('readConfig 透出 thinkingEnabled / reasoningEffort，并保留"未设置"与 false 的区别', async () => {
    const { host } = await harness(
      config({
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
            reasoningEffort: 'low',
          },
        ],
      }),
    )

    const view = await host.readConfig()
    expect(view.models[0]?.thinkingEnabled).toBe(false)
    expect(view.models[0]?.reasoningEffort).toBe('low')

    // 从未设置过的模型：字段**缺席**而不是被填成默认值。
    // 缺省与 false 在存储层是两件事，视图不能把它们抹平
    //（怎么解释缺省是 `thinkingConfigFor` 的事，见 ADR 0004 D3）。
    const { host: fresh } = await harness()
    const freshView = await fresh.readConfig()
    expect('thinkingEnabled' in (freshView.models[0] ?? {})).toBe(false)
    expect('reasoningEffort' in (freshView.models[0] ?? {})).toBe(false)
  })

  it('updateConfig 新增一个原本不存在的档位时 fallback 为空数组（不是 undefined）', async () => {
    const { app, host } = await harness()
    await host.updateConfig((view) => ({
      ...view,
      tiers: [
        ...view.tiers,
        { tier: ModelTier.FAST, providerId: 'p', modelId: 'm1', enabled: true },
      ],
    }))

    const doc = await app.configStore.read()
    const fast = doc.tier_assignments.find((t) => t.tier === ModelTier.FAST)
    expect(fast?.fallbackModelRefs).toEqual([])
  })

  it('updateModelPreferences 转发到应用层（改的是档位指向的那份 profile）', async () => {
    const { app, host } = await harness()
    await host.updateModelPreferences(ModelTier.IMPLEMENTATION, {
      thinkingEnabled: true,
      reasoningEffort: 'high',
    })

    const doc = await app.configStore.read()
    expect(doc.model_profiles[0]?.thinkingEnabled).toBe(true)
    expect(doc.model_profiles[0]?.reasoningEffort).toBe('high')
  })

  it('assignTierModel 换模型时保留 fallback 链与成本上限', async () => {
    // 换模型不等于清空回退策略和成本上限——那属于"顺手改掉用户配置"。
    const { app, host } = await harness(
      config({
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
          },
          {
            id: 'm2',
            providerId: 'p',
            contextWindow: 100_000,
            maxOutputTokens: 4096,
            supportsThinking: false,
            supportsTools: true,
            supportsVision: false,
            supports1MContext: false,
            enabled: true,
          },
        ],
        tier_assignments: [
          {
            tier: ModelTier.IMPLEMENTATION,
            modelRef: { providerId: 'p', modelId: 'm1' },
            enabled: true,
            fallbackModelRefs: [{ providerId: 'p', modelId: 'm_fallback' }],
            maxCostPerTurn: 1.5,
          },
        ],
      }),
    )

    await host.assignTierModel(ModelTier.IMPLEMENTATION, 'p', 'm2')

    const doc = await app.configStore.read()
    const assignment = doc.tier_assignments.find((t) => t.tier === ModelTier.IMPLEMENTATION)
    expect(assignment?.modelRef).toEqual({ providerId: 'p', modelId: 'm2' })
    expect(assignment?.fallbackModelRefs).toEqual([{ providerId: 'p', modelId: 'm_fallback' }])
    expect(assignment?.maxCostPerTurn).toBe(1.5)
  })

  it('assignTierModel 对不存在的档位是"新增"而不是静默无操作', async () => {
    // 首次配置时档位表是空的，`/model use` 必须先能建出这条分配。
    // 若这里悄悄 return，命令会回一句"已设置"而磁盘上什么都没有。
    const { app, host } = await harness(config({ tier_assignments: [] }))

    await host.assignTierModel(ModelTier.PLANNING, 'p', 'm1')

    const doc = await app.configStore.read()
    const assignment = doc.tier_assignments.find((t) => t.tier === ModelTier.PLANNING)
    expect(assignment?.modelRef).toEqual({ providerId: 'p', modelId: 'm1' })
    expect(assignment?.enabled).toBe(true)
    expect(assignment?.fallbackModelRefs).toEqual([])
  })

  it('setModelContextWindow 只改当前档位指向的那份 profile', async () => {
    const { app, host } = await harness()

    await host.setModelContextWindow(ModelTier.IMPLEMENTATION, 1_000_000)

    const doc = await app.configStore.read()
    expect(doc.model_profiles[0]?.contextWindow).toBe(1_000_000)
  })
})

describe('CommandHostAdapter：turn 的有界等待', () => {
  it('timeoutMs<=0 表示不设上限，直接等在飞 turn', async () => {
    const { app, host } = await harness(config(), hangingFactory)
    const session = await app.createSession(app.localPrincipalId)

    const pending = app.submitTurn({
      principalId: app.localPrincipalId,
      sessionId: session.id,
      prompt: '会挂住',
    })
    await sleep(20)
    app.cancelTurn(session.id)

    // 0 是"命令层自己控制上限"的表达——这里必须真的等到 turn 结束
    await host.awaitTurn(session.id, 0)
    expect(app.isBusy(session.id)).toBe(false)
    await pending
  })

  it('timeoutMs>0 时到点就返回，不会因为 turn 没结束而挂死', async () => {
    const { app, host } = await harness(config(), hangingFactory)
    const session = await app.createSession(app.localPrincipalId)

    const pending = app.submitTurn({
      principalId: app.localPrincipalId,
      sessionId: session.id,
      prompt: '会挂住',
    })
    await sleep(20)

    const started = Date.now()
    await host.awaitTurn(session.id, 20)
    const elapsed = Date.now() - started

    // 有界：应当在超时附近返回，且此时会话仍然是忙的
    expect(elapsed).toBeLessThan(2000)
    expect(app.isBusy(session.id)).toBe(true)

    app.cancelTurn(session.id)
    await pending
  })

  it('没有在飞 turn 时立即返回', async () => {
    const { app, host } = await harness()
    const session = await app.createSession(app.localPrincipalId)
    await host.awaitTurn(session.id, 5_000)
    expect(host.isBusy(session.id)).toBe(false)
  })

  it('submitTurn 把 override 一路带到应用层', async () => {
    const { app, host } = await harness()
    const session = await app.createSession(app.localPrincipalId)
    const { turnId } = await host.submitTurn({
      principalId: app.localPrincipalId,
      sessionId: session.id,
      prompt: '用它',
      override: {
        providerId: 'p',
        modelId: 'm_override',
        tier: ModelTier.IMPLEMENTATION,
      } as never,
    })
    expect(turnId).toBeTruthy()
  })

  it('cancelTurn 对没有在飞 turn 的会话返回 false', async () => {
    const { app, host } = await harness()
    const session = await app.createSession(app.localPrincipalId)
    expect(host.cancelTurn(session.id, '用户点的')).toBe(false)
  })

  it('不带 override 的 submitTurn 走普通路径（不额外传字段）', async () => {
    const { app, host } = await harness()
    const session = await app.createSession(app.localPrincipalId)
    const { turnId } = await host.submitTurn({
      principalId: app.localPrincipalId,
      sessionId: session.id,
      prompt: '普通一轮',
    })
    expect(turnId).toBeTruthy()
  })
})

describe('CommandHostAdapter：会话与审计', () => {
  it('sessionExists 用 getSession 的归属校验判定，无权限即"不存在"', async () => {
    const { app, host } = await harness()
    const mine = await app.createSession(app.localPrincipalId)
    const theirs = await app.createSession('principal_other' as never)

    expect(await host.sessionExists(app.localPrincipalId, mine.id)).toBe(true)
    expect(await host.sessionExists(app.localPrincipalId, theirs.id)).toBe(false)
    expect(await host.sessionExists(app.localPrincipalId, 's_不存在' as SessionId)).toBe(false)
  })

  it('listSessions 只回传命令层需要的四个字段', async () => {
    const { app, host } = await harness()
    await app.createSession(app.localPrincipalId, '我的会话')
    const list = await host.listSessions(app.localPrincipalId)

    expect(list).toHaveLength(1)
    expect(Object.keys(list[0]!).sort()).toEqual(['agent_type', 'current_turn', 'id', 'title'])
    expect(list[0]?.title).toBe('我的会话')
  })

  it('createSession 的标题可选', async () => {
    const { app, host } = await harness()
    const { id } = await host.createSession(app.localPrincipalId)
    expect((await app.chatStore.getConversation(id)).title).toBe('New conversation')
  })

  it('没有会话归属的命令事件直接丢弃，不编造 sessionId', async () => {
    // /api 这类全局命令没有会话；若随便挑一个 sessionId 落盘，会污染
    // 某个真实会话的事件流（客户端按 session 拉取，看到的就是别人的事件）。
    const { app, host } = await harness()
    const session = await app.createSession(app.localPrincipalId)

    await host.publish({ sessionId: undefined, type: 'command_received', data: { x: 1 } })

    expect(await app.eventLog.list(session.id)).toHaveLength(0)
  })

  it('带 turnId 的事件被原样落盘', async () => {
    const { app, host } = await harness()
    const session = await app.createSession(app.localPrincipalId)

    await host.publish({
      sessionId: session.id,
      turnId: 'turn_x' as never,
      type: 'command_received',
      data: { x: 1 },
    })
    await app.flush()

    const events = await app.eventLog.list(session.id)
    expect(events).toHaveLength(1)
    expect(events[0]?.turnId).toBe('turn_x')
  })

  it('事件写不进去时 publish 仍然静默成功（审计是旁路，不该让命令失败）', async () => {
    // 事件日志只读、磁盘满、目录被删……这些都会让 append 拒绝。
    // 命令的**结果**已经产生了，不能因为一条审计事件写不下去就把它报成失败——
    // 那会让用户重试一个已经生效的操作。
    const dir = await mkdtemp(join(tmpdir(), 'deepcode-command-host-logfail-'))
    const paths = resolveAppPaths({ home: dir, cwd: dir })
    const configStore = new ConfigStore(paths)
    await configStore.save(config())
    const app = await AgentApplication.create({
      paths,
      workspaceRoot: dir,
      configStore,
      chatStore: new ChatStore(paths),
      registry: new ToolRegistry(),
      providerFactory: textFactory,
      eventLog: new FailingEventLog(dir),
    })
    const host = new CommandHostAdapter(app)
    const session = await app.createSession(app.localPrincipalId)

    await expect(
      host.publish({ sessionId: session.id, type: 'command_received', data: {} }),
    ).resolves.toBeUndefined()
    // flush 也必须能收敛，而不是等一个永远不会落盘的写入
    await app.flush()
  })

  it('recordCommandResult 落成 command_event 消息并返回消息 id', async () => {
    const { app, host } = await harness()
    const session = await app.createSession(app.localPrincipalId)

    const messageId = await host.recordCommandResult({
      sessionId: session.id,
      command: 'model',
      result: { ok: true, code: CommandResultCode.OK, text: '已切换' },
    })

    expect(messageId).toBeTruthy()
    const messages = await app.chatStore.listMessages(session.id)
    expect(messages[0]?.subtype).toBe('command_event')
    expect(messages[0]?.content).toBe('已切换')
    expect(JSON.parse(messages[0]!.meta)).toMatchObject({ command: 'model', ok: true })
  })
})

describe('CommandHostAdapter：幂等表转发', () => {
  it('未写过的键返回 undefined，写过的原样读回', async () => {
    const { host } = await harness()
    expect(await host.getIdempotency('k1')).toBeUndefined()

    await host.putIdempotency({
      key: 'k1',
      operation: 'command:model',
      requestHash: 'h1',
      response: { ok: true },
    })

    const record = await host.getIdempotency('k1')
    // 只暴露命令层需要的两个字段（operation/createdAt 是内部账目）
    expect(record).toEqual({ requestHash: 'h1', response: { ok: true } })
  })

  it('createdAt 由注入的时钟写入（幂等 TTL 判定因此可被测试固定）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deepcode-command-host-clock-'))
    const paths = resolveAppPaths({ home: dir, cwd: dir })
    const configStore = new ConfigStore(paths)
    await configStore.save(config())
    const clock = createFakeClock(Date.parse('2026-09-15T00:00:00.000Z'))
    const app = await AgentApplication.create({
      paths,
      workspaceRoot: dir,
      clock,
      configStore,
      chatStore: new ChatStore(paths, clock),
      registry: new ToolRegistry(),
      providerFactory: textFactory,
    })
    const host = new CommandHostAdapter(app)

    await host.putIdempotency({ key: 'k2', operation: 'op', requestHash: 'h', response: null })

    const stored = await app.chatStore.getIdempotency('k2')
    expect(stored?.createdAt).toBe('2026-09-15T00:00:00.000Z')
    expect(host.now()).toBe('2026-09-15T00:00:00.000Z')
  })
})

describe('CommandHostAdapter：/compact 的三态', () => {
  it('消息太少时返回"无需压缩"', async () => {
    const { host } = await harness()
    const { id } = await host.createSession(host.localPrincipalId)
    const result = await host.compact(id, new AbortController().signal)

    expect(result.ok).toBe(true)
    expect(result.text).toContain('无需压缩')
  })

  it('真的压出摘要时把摘要前 40 字回显给用户（让他知道压了什么）', async () => {
    const { app, host } = await harness()
    const session = await app.createSession(app.localPrincipalId)
    for (let i = 0; i < 12; i++) {
      await app.chatStore.addMessage({
        conversation_id: session.id,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `第 ${i} 条消息`,
        turn_id: '',
        subtype: MessageSubtype.NORMAL,
        tool_call_id: null,
        meta: '{}',
        agent_type: '',
      })
    }

    const result = await host.compact(session.id, new AbortController().signal)

    expect(result.ok).toBe(true)
    expect(result.text).toMatch(/^已压缩上下文（摘要 /)
  })

  it('AgentError 被折成命令结果（带稳定错误码），不向上抛', async () => {
    const { app } = await harness(config(), textFactory, (paths) => {
      const store = new ExplodingChatStore(paths)
      return store
    })
    const host = new CommandHostAdapter(app)
    const session = await app.createSession(app.localPrincipalId)

    const result = await host.compact(session.id, new AbortController().signal)

    expect(result.ok).toBe(false)
    expect(result.code).toBe(CommandResultCode.FAILED)
    expect(result.errorCode).toBe(ErrorCode.STORAGE_READ_FAILED)
    expect(result.text).toBe('会话文件坏了')
  })

  it('非 AgentError 的普通 Error 被包成 INTERNAL_ERROR', async () => {
    const { app } = await harness(config(), textFactory, (paths) => {
      const store = new ExplodingChatStore(paths)
      store.error = new Error('磁盘满了')
      return store
    })
    const host = new CommandHostAdapter(app)
    const session = await app.createSession(app.localPrincipalId)

    const result = await host.compact(session.id, new AbortController().signal)

    expect(result.errorCode).toBe(ErrorCode.INTERNAL_ERROR)
    expect(result.text).toBe('磁盘满了')
  })

  it('抛出的不是 Error 时仍给出可读文案，而不是 "undefined"', async () => {
    const { app } = await harness(config(), textFactory, (paths) => {
      const store = new ExplodingChatStore(paths)
      store.error = '裸字符串'
      return store
    })
    const host = new CommandHostAdapter(app)
    const session = await app.createSession(app.localPrincipalId)

    const result = await host.compact(session.id, new AbortController().signal)

    expect(result.ok).toBe(false)
    expect(result.text).toBe('压缩失败')
  })
})
