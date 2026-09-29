import { access, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { AgentApplication } from '../../src/app/agent-application.js'
import { EventBus, type EventSubscriber } from '../../src/app/event-bus.js'
import { DEFAULT_APP_POLICY, loadAppPolicy } from '../../src/app/policy.js'
import { canAccess, ensureLocalPrincipal } from '../../src/app/principal.js'
import { ChatStore } from '../../src/storage/chat-store.js'
import { ConfigStore } from '../../src/storage/config-store.js'
import { resolveAppPaths } from '../../src/storage/paths.js'
import { ToolRegistry } from '../../src/tools/registry.js'
import { createFileWriteTool } from '../../src/tools/builtins.js'
import { ErrorCode } from '../../src/core/errors.js'
import { PermissionMode } from '../../src/core/tool.js'
import { type PrincipalId } from '../../src/core/ids.js'
import { ModelEventType, type Provider } from '../../src/core/provider.js'
import type { ConfigDocument } from '../../src/storage/types.js'
import type { TurnStreamEvent } from '../../src/core/turn.js'
import type { RuntimeEventEnvelope } from '../../src/core/events.js'

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
      supportsThinking: false,
      supportsTools: true,
      supportsVision: false,
      supports1MContext: false,
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
})

/** 一次文本响应后结束的假 provider 工厂。 */
const textProviderFactory = (text: string) =>
  (() => ({
    stream: () => ({
      usage: { inputTokens: 5, outputTokens: 2 },
      async *[Symbol.asyncIterator]() {
        await Promise.resolve()
        yield { type: ModelEventType.TEXT, content: text } as never
      },
    }),
    probe: () => Promise.resolve({ ok: true }),
  })) as never

async function harness(text = '完成') {
  const dir = await mkdtemp(join(tmpdir(), 'deepcode-app-'))
  const paths = resolveAppPaths({ home: dir, cwd: dir })
  const configStore = new ConfigStore(paths)
  await configStore.save(config())
  const chatStore = new ChatStore(paths)

  const app = await AgentApplication.create({
    paths,
    workspaceRoot: dir,
    configStore,
    chatStore,
    registry: new ToolRegistry(),
    providerFactory: textProviderFactory(text),
  })
  return { dir, paths, app, configStore, chatStore }
}

class Recorder implements EventSubscriber {
  readonly events: RuntimeEventEnvelope[] = []
  onEvent(event: RuntimeEventEnvelope): void {
    this.events.push(event)
  }
  get types(): string[] {
    return this.events.map((e) => e.type)
  }
}

describe('AgentApplication：装配', () => {
  it('每个 turn 的所选模式同时控制工具执行与恢复快照', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deepcode-mode-'))
    const paths = resolveAppPaths({ home: dir, cwd: dir })
    const configStore = new ConfigStore(paths)
    await configStore.save(config())
    let calls = 0
    const systems: string[] = []
    const providerFactory = (() => ({
      stream: (request: { system?: string }) => ({
        usage: { inputTokens: 1, outputTokens: 1 },
        async *[Symbol.asyncIterator]() {
          await Promise.resolve()
          systems.push(request.system ?? '')
          calls += 1
          if (calls % 2 === 1)
            yield {
              type: ModelEventType.TOOL_USE,
              id: `write-${calls}`,
              name: 'file_write',
              input: { path: 'mode.txt', content: '已写入' },
            } as never
          else yield { type: ModelEventType.TEXT, content: '完成' } as never
        },
      }),
      probe: () => Promise.resolve({ ok: true }),
    })) as never
    const registry = new ToolRegistry()
    registry.register(createFileWriteTool())
    const app = await AgentApplication.create({
      paths,
      workspaceRoot: dir,
      configStore,
      registry,
      providerFactory,
    })
    const session = await app.createSession(app.localPrincipalId)

    await app.submitTurn({
      principalId: app.localPrincipalId,
      sessionId: session.id,
      prompt: '只做计划',
      mode: PermissionMode.PLAN,
    })
    await expect(access(join(dir, 'mode.txt'))).rejects.toThrow()
    expect((await app.chatStore.read()).runtime.turns.at(-1)?.mode).toBe(PermissionMode.PLAN)
    expect(systems[0]).toContain('Current mode: PLAN')
    expect(systems[0]).toContain('ask_user_question')

    await app.submitTurn({
      principalId: app.localPrincipalId,
      sessionId: session.id,
      prompt: '执行修改',
      mode: PermissionMode.AUTO_EDIT,
    })
    expect(await readFile(join(dir, 'mode.txt'), 'utf8')).toBe('已写入')
    expect((await app.chatStore.read()).runtime.turns.at(-1)?.mode).toBe(PermissionMode.AUTO_EDIT)
    expect(systems[2]).toContain('Current mode: AUTO_EDIT')
    app.dispose()
  })

  it('创建后可端到端跑完一个 turn', async () => {
    const { app } = await harness('你好')

    const session = await app.createSession(app.localPrincipalId)
    const { result } = await app.submitTurn({
      principalId: app.localPrincipalId,
      sessionId: session.id,
      prompt: '打个招呼',
    })

    expect(result.status).toBe('completed')
    expect(result.final_text).toBe('你好')
  })

  it('事件经总线落盘，可被订阅者与补发同时看到', async () => {
    const { app } = await harness()
    const session = await app.createSession(app.localPrincipalId)

    const recorder = new Recorder()
    await app.attach(recorder, { sessionId: session.id })
    await app.submitTurn({
      principalId: app.localPrincipalId,
      sessionId: session.id,
      prompt: 'go',
    })
    await app.flush()

    expect(recorder.types).toContain('turn_start')
    expect(recorder.types).toContain('turn_end')
    // 落盘的是同一批事件
    const persisted = (await app.eventLog.list(session.id)) as unknown as TurnStreamEvent[]
    expect(persisted.map((e) => e.type)).toEqual(recorder.types)
  })

  it('恢复扫描结果在启动时可用', async () => {
    const { app } = await harness()
    const snapshot = app.recovery()
    expect(snapshot.unfinishedTurns).toEqual([])
    expect(snapshot.pendingPermissions).toEqual([])
  })
})

describe('AgentApplication：并发与取消', () => {
  it('同一会话的第二个 turn 返回 SESSION_BUSY', async () => {
    const { app } = await harness()
    const session = await app.createSession(app.localPrincipalId)

    const first = app.submitTurn({
      principalId: app.localPrincipalId,
      sessionId: session.id,
      prompt: '第一个',
    })
    await expect(
      app.submitTurn({
        principalId: app.localPrincipalId,
        sessionId: session.id,
        prompt: '第二个',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.SESSION_BUSY })

    await first
  })

  it('不同会话可以并发', async () => {
    const { app } = await harness()
    const a = await app.createSession(app.localPrincipalId)
    const b = await app.createSession(app.localPrincipalId)

    const [ra, rb] = await Promise.all([
      app.submitTurn({ principalId: app.localPrincipalId, sessionId: a.id, prompt: 'a' }),
      app.submitTurn({ principalId: app.localPrincipalId, sessionId: b.id, prompt: 'b' }),
    ])

    expect(ra.result.status).toBe('completed')
    expect(rb.result.status).toBe('completed')
  })

  it('cancelTurn 之后 awaitTurn 能等到 turn 真正结束', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deepcode-app-cancel-'))
    const paths = resolveAppPaths({ home: dir, cwd: dir })
    const configStore = new ConfigStore(paths)
    await configStore.save(config())

    const hangingFactory = (() => ({
      stream: (_req: unknown, signal: AbortSignal) => ({
        usage: { inputTokens: 0, outputTokens: 0 },
        [Symbol.asyncIterator]() {
          return {
            next: (): Promise<IteratorResult<never>> =>
              new Promise((_r, reject) => {
                if (signal.aborted) reject(new Error('aborted'))
                signal.addEventListener('abort', () => reject(new Error('aborted')), {
                  once: true,
                })
              }),
          }
        },
      }),
      probe: () => Promise.resolve({ ok: true }),
    })) as never

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
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(app.isBusy(session.id)).toBe(true)
    expect(app.cancelTurn(session.id)).toBe(true)

    // abort 不会同步清 runtime.busy —— 必须靠 awaitTurn 等到 finish() 写完存储
    const settled = await app.awaitTurn(session.id)
    expect(settled?.status).toBe('cancelled')
    expect(app.isBusy(session.id)).toBe(false)

    await pending
    await app.flush()
    const events = (await app.eventLog.list(session.id)) as unknown as TurnStreamEvent[]
    const end = events.find((e) => e.type === 'turn_end')
    expect(end?.data.cancelled).toBe(true)
  })

  it('对没有在飞 turn 的会话取消返回 false', async () => {
    const { app } = await harness()
    const session = await app.createSession(app.localPrincipalId)
    expect(app.cancelTurn(session.id)).toBe(false)
  })
})

describe('AgentApplication：会话归属', () => {
  it('读取他人会话返回 SESSION_NOT_FOUND（不泄露存在性）', async () => {
    const { app } = await harness()
    const session = await app.createSession(app.localPrincipalId)

    await expect(
      app.getSession('principal_other' as PrincipalId, session.id),
    ).rejects.toMatchObject({ code: ErrorCode.SESSION_NOT_FOUND })
  })

  it('列表只返回本 principal 可见的会话', async () => {
    const { app } = await harness()
    const mine = await app.createSession(app.localPrincipalId)
    const theirs = await app.createSession('principal_other' as PrincipalId)

    const visible = await app.listSessions(app.localPrincipalId)
    const ids = visible.map((c) => c.id)
    expect(ids).toContain(mine.id)
    expect(ids).not.toContain(theirs.id)
  })

  it('无权限时提交 turn 同样被拒', async () => {
    const { app } = await harness()
    const session = await app.createSession('principal_other' as PrincipalId)

    await expect(
      app.submitTurn({
        principalId: app.localPrincipalId,
        sessionId: session.id,
        prompt: 'x',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.SESSION_NOT_FOUND })
  })

  it('dispose 之后拒绝新 turn', async () => {
    const { app } = await harness()
    const session = await app.createSession(app.localPrincipalId)
    app.dispose()

    await expect(
      app.submitTurn({ principalId: app.localPrincipalId, sessionId: session.id, prompt: 'x' }),
    ).rejects.toMatchObject({ code: ErrorCode.WEB_SHUTTING_DOWN })
  })
})

describe('principal：本机身份', () => {
  it('首次生成并持久化，二次读取得到同一个值', async () => {
    const { configStore, chatStore } = await harness()

    const first = await ensureLocalPrincipal(configStore, chatStore)
    const second = await ensureLocalPrincipal(configStore, chatStore)

    expect(second.principalId).toBe(first.principalId)
  })

  it('认领 principal_id 为空的历史会话，且只认领一次', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deepcode-claim-'))
    const paths = resolveAppPaths({ home: dir, cwd: dir })
    const configStore = new ConfigStore(paths)
    await configStore.save(config())
    const chatStore = new ChatStore(paths)
    // 旧数据：没有 principal_id
    const legacy = await chatStore.createConversation('旧会话')

    const first = await ensureLocalPrincipal(configStore, chatStore)
    expect(first.claimed).toBe(1)
    expect((await chatStore.getConversation(legacy.id)).principal_id).toBe(first.principalId)

    const second = await ensureLocalPrincipal(configStore, chatStore)
    expect(second.claimed).toBe(0)
  })

  it('canAccess 让本机 principal 访问空归属的旧会话', () => {
    expect(canAccess('local', { principal_id: '' }, 'local')).toBe(true)
    // 其他 principal 不能借道空归属读到迁移前的历史
    expect(canAccess('other', { principal_id: '' }, 'local')).toBe(false)
    expect(canAccess('other', { principal_id: 'other' }, 'local')).toBe(true)
    expect(canAccess('other', { principal_id: 'local' }, 'local')).toBe(false)
  })
})

describe('policy', () => {
  it('默认值覆盖全部字段', () => {
    expect(loadAppPolicy(undefined)).toEqual(DEFAULT_APP_POLICY)
  })

  it('app_settings 里的 policy.* 可逐项覆盖', () => {
    const policy = loadAppPolicy({
      ...config(),
      app_settings: { 'policy.tool_timeout_ms': '5000', 'policy.http_burst': '7' },
    })
    expect(policy.toolTimeoutMs).toBe(5000)
    expect(policy.httpBurst).toBe(7)
    expect(policy.approvalTimeoutMs).toBe(DEFAULT_APP_POLICY.approvalTimeoutMs)
  })

  it('未知的 policy 键直接报错，而不是静默忽略', () => {
    expect(() =>
      loadAppPolicy({ ...config(), app_settings: { 'policy.tool_timeot_ms': '5000' } }),
    ).toThrow(/未知的策略设置项/)
  })

  it('非数字值报错', () => {
    expect(() =>
      loadAppPolicy({ ...config(), app_settings: { 'policy.tool_timeout_ms': 'abc' } }),
    ).toThrow(/必须是非负数字/)
  })
})

describe('EventBus 与 AgentApplication 的接线', () => {
  it('runtime 的事件出口就是总线本身', async () => {
    const { app } = await harness()
    const session = await app.createSession(app.localPrincipalId)
    await app.submitTurn({ principalId: app.localPrincipalId, sessionId: session.id, prompt: 'x' })

    // 若有人把 eventSink 换成别的东西，事件就不会落进这个 EventLog
    expect(app.eventLog).toBeDefined()
    expect(app.bus).toBeInstanceOf(EventBus)
  })

  it('未订阅时事件仍完整落盘', async () => {
    const { app } = await harness()
    const session = await app.createSession(app.localPrincipalId)
    await app.submitTurn({ principalId: app.localPrincipalId, sessionId: session.id, prompt: 'x' })
    await app.flush()

    const events = await app.eventLog.list(session.id)
    expect(events.length).toBeGreaterThan(0)
  })

  it('未知会话的补发锚点要求重建', async () => {
    const { app } = await harness()
    const session = await app.createSession(app.localPrincipalId)
    await expect(
      app.attach(new Recorder(), { sessionId: session.id, lastEventId: 'evt_nope' }),
    ).rejects.toMatchObject({ code: ErrorCode.EVENT_RESYNC_REQUIRED })
  })
})
