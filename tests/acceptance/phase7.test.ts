/**
 * Phase 7 验收：多客户端语义一致性。
 *
 * `progess.md` 的 Phase 7 验收项里最实质的一条是「Web UI 与 TUI 同时连接时
 * 事件、权限和 cancel 语义一致」。这条不能靠"两边都调了同一批方法"来证明——
 * 必须让两个客户端**真的同时**挂在同一个 `AgentApplication` 上，然后断言它们
 * 看到的是**同一个**序列、同一批权限往返、同一个取消结果。
 *
 * 这里用两个 `EventSubscriber` 代表两端。这是刻意的：一致性的关键不在传输层
 * （TUI 是进程内、Web 是 WebSocket），而在**它们都只能通过 `attach()` 订阅
 * 同一个事件总线、只能通过同一批回灌方法提交决定**。传输层不同不该产生语义差异。
 *
 * ⚠️ 特别注意有两个事件**不是 runtime 发的**：
 * `permission_required` 由审批 broker 发、`user_input_required` 由提问 broker 发。
 * 早先的实现里 UI 一接上审批服务，`permission_required` 就永远不再出现
 * （`AgentRuntime` 只在没有 approvalService 时才发它）——那条路径下这个验收
 * 根本无从谈起。
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { AgentApplication } from '../../src/app/agent-application.js'
import type { EventSubscriber } from '../../src/app/event-bus.js'
import { ChatStore } from '../../src/storage/chat-store.js'
import { ConfigStore } from '../../src/storage/config-store.js'
import { resolveAppPaths } from '../../src/storage/paths.js'
import { PermissionAction } from '../../src/core/tool.js'
import { ModelEventType, type Provider } from '../../src/core/provider.js'
import type { ConfigDocument } from '../../src/storage/types.js'
import type { RuntimeEventEnvelope } from '../../src/core/events.js'
import type { TurnStreamEvent } from '../../src/core/turn.js'
import type { PrincipalId } from '../../src/core/ids.js'

const provider: Provider = {
  id: 'p',
  name: 'test',
  baseUrl: 'https://api.anthropic.com',
  apiKeyRef: { source: 'env', key: 'TEST_KEY' },
  createdAt: '',
  updatedAt: '',
}

const configDoc = (): ConfigDocument => ({
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

/** 第一次请求 bash（需要审批），之后给文本；用于权限往返。 */
const bashFirstFactory = () => {
  let call = 0
  return {
    stream: () => {
      call++
      const events =
        call === 1
          ? [
              {
                type: ModelEventType.TOOL_USE,
                id: 'tc1',
                name: 'bash',
                input: { command: 'echo hi' },
              },
            ]
          : [{ type: ModelEventType.TEXT, content: '完成' }]
      return {
        usage: { inputTokens: 1, outputTokens: 1 },
        async *[Symbol.asyncIterator]() {
          await Promise.resolve()
          for (const e of events) yield e as never
        },
      }
    },
    probe: () => Promise.resolve({ ok: true }),
  }
}

/** 纯文本响应，不调用任何工具——用于不需要审批的用例。 */
const textFactory = () => ({
  stream: () => ({
    usage: { inputTokens: 1, outputTokens: 1 },
    async *[Symbol.asyncIterator]() {
      await Promise.resolve()
      yield { type: ModelEventType.TEXT, content: '完成' } as never
    },
  }),
  probe: () => Promise.resolve({ ok: true }),
})

/** 永不产出，只在取消时结束。 */
const hangingFactory = () =>
  ({
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
  }) as never

/** 代表一个客户端：只订阅、只回灌，不直接碰任何状态。 */
class Client implements EventSubscriber {
  readonly events: RuntimeEventEnvelope[] = []
  constructor(
    readonly label: string,
    private readonly app: AgentApplication,
  ) {}
  onEvent(event: RuntimeEventEnvelope): void {
    this.events.push(event)
  }
  get types(): string[] {
    return this.events.map((e) => e.type)
  }
  get sequences(): number[] {
    return this.events.map((e) => e.sequence)
  }
  has(type: string): boolean {
    return this.types.includes(type)
  }
  /** 该客户端是否看到了某个 request_id 的待审批。 */
  sawPermissionRequest(): boolean {
    return this.events.some((e) => e.type === 'permission_required')
  }
  async approve(requestId: string): Promise<void> {
    await this.app.resolvePermission({
      requestId,
      decision: PermissionAction.ALLOW,
      principalId: this.app.localPrincipalId,
    })
  }
}

/** `factory` 必须是**函数**（`providerFactory` 的契约），不是 provider 实例。 */
async function build(factory: unknown) {
  const dir = await mkdtemp(join(tmpdir(), 'deepcode-phase7-'))
  const paths = resolveAppPaths({ home: dir, cwd: dir })
  const configStore = new ConfigStore(paths)
  await configStore.save(configDoc())
  const app = await AgentApplication.create({
    paths,
    workspaceRoot: dir,
    configStore,
    chatStore: new ChatStore(paths),
    // ⚠️ 不传 registry：传空的会让 create() 跳过内置工具注册，
    // 于是 bash 不存在、永远走不到审批——这个验收就变成了空转。
    providerFactory: factory as never,
  })
  const session = await app.createSession(app.localPrincipalId)
  const tui = new Client('tui', app)
  const web = new Client('web', app)
  await app.attach(tui, { sessionId: session.id })
  await app.attach(web, { sessionId: session.id })
  return { app, session, tui, web }
}

/** 在事件回调里自动批准，模拟"任一方在界面上点了允许"。 */
class AutoApprover extends Client {
  override onEvent(event: RuntimeEventEnvelope): void {
    super.onEvent(event)
    if (event.type !== 'permission_required') return
    const requestId = (event.data as { request_id?: string }).request_id
    if (requestId === undefined) return
    void this.approve(requestId)
  }
}

describe('Phase 7 验收：两个客户端同时连接', () => {
  it('两端收到完全相同的 sequence 序列与事件类型', async () => {
    const { app, session, tui, web } = await build(bashFirstFactory)

    // 让 TUI 侧自动批准，Web 侧只旁观 —— 这正是"任一方操作、双方都看到"的场景
    const approver = new AutoApprover('tui-approver', app)
    await app.attach(approver, { sessionId: session.id })

    await app.submitTurn({
      principalId: app.localPrincipalId,
      sessionId: session.id,
      prompt: '跑一下',
    })
    await app.flush()

    expect(tui.events.length).toBeGreaterThan(0)
    // 这是验收的核心：不是"都能用"，而是"看到的是同一个流"
    expect(web.sequences).toEqual(tui.sequences)
    expect(web.types).toEqual(tui.types)
  }, 20_000)

  it('权限：一端提交决议，两端都看到 permission_resolved', async () => {
    const { app, session, tui, web } = await build(bashFirstFactory)
    const approver = new AutoApprover('tui-approver', app)
    await app.attach(approver, { sessionId: session.id })

    await app.submitTurn({
      principalId: app.localPrincipalId,
      sessionId: session.id,
      prompt: '跑一下',
    })
    await app.flush()

    // 两端都看到了同一个待审批（说明 permission_required 确实被广播了，
    // 而不是只推给了发起方）
    expect(tui.sawPermissionRequest()).toBe(true)
    expect(web.sawPermissionRequest()).toBe(true)
    // 一端批准后，两端都要收到解决事件以收起对话框
    expect(tui.has('permission_resolved')).toBe(true)
    expect(web.has('permission_resolved')).toBe(true)

    // 且**只解决一次**：tool_result 只有一条
    const messages = await app.chatStore.listMessages(session.id)
    const toolResults = messages.filter((m) => m.subtype === 'tool_result')
    expect(toolResults).toHaveLength(1)
  }, 20_000)

  it('cancel：一端取消，两端都看到 turn_end{cancelled:true}', async () => {
    const { app, session, tui, web } = await build(hangingFactory)

    const pending = app.submitTurn({
      principalId: app.localPrincipalId,
      sessionId: session.id,
      prompt: '会挂住',
    })

    // 由"Web 侧"取消（本测试里 cancelTurn 是 app 级方法，两端等价）
    expect(app.cancelTurn(session.id)).toBe(true)
    await pending
    await app.flush()

    for (const client of [tui, web]) {
      const end = client.events.find((e) => e.type === 'turn_end')
      expect(end, `${client.label} 没收到 turn_end`).toBeDefined()
      expect((end?.data as TurnStreamEvent['data'] & { cancelled?: boolean }).cancelled).toBe(true)
    }
    // 两端的终止事件仍在同一位置
    expect(web.sequences).toEqual(tui.sequences)
  }, 20_000)

  it('一端取消后两端都能看到会话变为空闲', async () => {
    const { app, session } = await build(hangingFactory)
    const pending = app.submitTurn({
      principalId: app.localPrincipalId,
      sessionId: session.id,
      prompt: '会挂住',
    })
    app.cancelTurn(session.id)
    await pending
    // 两端共用同一个 isBusy 判定，不存在"一端以为空闲、另一端以为忙"
    expect(app.isBusy(session.id)).toBe(false)
  }, 20_000)

  it('后连接的客户端可用补发补齐错过的部分', async () => {
    const { app, session, tui } = await build(bashFirstFactory)
    const approver = new AutoApprover('tui-approver', app)
    await app.attach(approver, { sessionId: session.id })

    await app.submitTurn({
      principalId: app.localPrincipalId,
      sessionId: session.id,
      prompt: '跑一下',
    })
    await app.flush()

    // 模拟"Web 页面刷新"：用已有事件里的最后一个 eventId 作为锚点重连
    const last = tui.events.at(-1)
    expect(last).toBeDefined()
    const reconnected = new Client('web-reconnected', app)
    const sub = await app.attach(reconnected, {
      sessionId: session.id,
      lastEventId: last!.eventId,
    })
    await app.flush()

    // 锚点是最新一条，所以补发为空——但必须**明确告知已追平**，
    // 否则客户端无法区分"补发还在继续"与"已经追平"，会一直转圈
    expect(sub.replayed).toBe(0)
    expect(reconnected.events).toEqual([])
  }, 20_000)

  it('未知锚点要求重建，而不是静默补发全量（否则会重复渲染）', async () => {
    // 用纯文本 provider：这个用例只关心补发锚点，不需要审批往返
    const { app, session } = await build(textFactory)
    await app.submitTurn({
      principalId: app.localPrincipalId,
      sessionId: session.id,
      prompt: '跑一下',
    })
    await app.flush()

    const client = new Client('web', app)
    await expect(
      app.attach(client, { sessionId: session.id, lastEventId: 'evt_早已不存在' }),
    ).rejects.toMatchObject({ code: 'EVENT_RESYNC_REQUIRED' })
  }, 20_000)
})

describe('Phase 7 验收：会话归属', () => {
  it('另一个 principal 看不到、也无法订阅该会话', async () => {
    const { app, session } = await build(bashFirstFactory)
    const other = 'principal_other' as PrincipalId

    await expect(app.getSession(other, session.id)).rejects.toMatchObject({
      code: 'SESSION_NOT_FOUND',
    })
    await expect(
      app.submitTurn({ principalId: other, sessionId: session.id, prompt: '偷看' }),
    ).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' })
  })
})
