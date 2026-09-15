import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { AgentApplication } from '../../src/app/agent-application.js'
import { ApprovalBroker } from '../../src/app/approval-broker.js'
import { type EventPublisher, type EventSubscriber } from '../../src/app/event-bus.js'
import { DEFAULT_APP_POLICY, type AppPolicy } from '../../src/app/policy.js'
import { ChatStore } from '../../src/storage/chat-store.js'
import { ConfigStore } from '../../src/storage/config-store.js'
import { resolveAppPaths } from '../../src/storage/paths.js'
import { ErrorCode } from '../../src/core/errors.js'
import { createSessionId, type PrincipalId } from '../../src/core/ids.js'
import { ModelEventType, type Provider } from '../../src/core/provider.js'
import { PermissionAction, type PermissionRequest } from '../../src/core/tool.js'
import { createFakeClock } from '../../src/core/time.js'
import type { ConfigDocument } from '../../src/storage/types.js'
import type { RuntimeEventEnvelope } from '../../src/core/events.js'
import type { TurnStreamEvent } from '../../src/core/turn.js'

/** 记录所有 publish 调用的假发布者。 */
class FakePublisher implements EventPublisher {
  readonly published: { type: string; data: unknown; sessionId: string }[] = []
  publish(input: {
    readonly sessionId: Parameters<EventPublisher['publish']>[0]['sessionId']
    readonly type: string
    readonly data: unknown
  }): Promise<RuntimeEventEnvelope> {
    this.published.push({ type: input.type, data: input.data, sessionId: input.sessionId })
    return Promise.resolve({} as RuntimeEventEnvelope)
  }
  types(): string[] {
    return this.published.map((p) => p.type)
  }
}

const request = (over: Partial<PermissionRequest> = {}): PermissionRequest => ({
  request_id: 'req_1',
  session_id: createSessionId(),
  turn_id: 'turn_1' as PermissionRequest['turn_id'],
  tool_call_id: 'call_1' as PermissionRequest['tool_call_id'],
  tool_name: 'bash',
  args_preview: '{"command":"[redacted]"}',
  risk_level: 'high',
  reason: 'high-risk action requires approval',
  status: 'PENDING_USER_APPROVAL',
  created_at: '2026-09-15T00:00:00.000Z',
  expires_at: 0,
  resolved_at: null,
  resolved_by: '',
  resolution: '',
  ...over,
})

const broker = (policy: Partial<AppPolicy> = {}, nowMs = 1_000_000) => {
  const publisher = new FakePublisher()
  const clock = createFakeClock(nowMs)
  const b = new ApprovalBroker({
    publisher,
    policy: { ...DEFAULT_APP_POLICY, ...policy },
    clock,
  })
  return { broker: b, publisher, clock }
}

/** 让 broker 的发布落定。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('ApprovalBroker：事件发射（Phase 7 的关键修复）', () => {
  it('挂起审批时由 broker 发出 permission_required', async () => {
    const { broker: b, publisher } = broker()
    const req = request({ expires_at: 1_000_000 + 60_000 })
    const controller = new AbortController()

    const pending = b.request(req, controller.signal)
    await settle()

    expect(publisher.types()).toEqual(['permission_required'])
    const data = publisher.published[0]?.data as Record<string, unknown>
    expect(data['request_id']).toBe('req_1')
    expect(data['tool_name']).toBe('bash')
    // 参数使用执行器生成的**已脱敏**摘要，不要重新序列化原始 input
    expect(data['args_preview']).toBe('{"command":"[redacted]"}')
    expect(data['risk_level']).toBe('high')

    controller.abort()
    await pending
  })

  it('重复 request() 不重复弹窗（幂等）', async () => {
    const { broker: b, publisher } = broker()
    const req = request({ expires_at: 1_000_000 + 60_000 })
    const controller = new AbortController()

    const first = b.request(req, controller.signal)
    await settle()
    const second = b.request(req, controller.signal)
    await settle()

    // 只发过一次事件——重连/重试不应该让用户看到两个对话框
    expect(publisher.types()).toEqual(['permission_required'])

    controller.abort()
    await Promise.all([first, second])
  })

  it('解决时发出 permission_resolved，让其他连接收起对话框', async () => {
    const { broker: b, publisher } = broker()
    const req = request({ expires_at: 1_000_000 + 60_000 })
    const pending = b.request(req, new AbortController().signal)
    await settle()

    await b.resolve({
      requestId: req.request_id,
      decision: PermissionAction.ALLOW,
      principalId: 'local' as PrincipalId,
    })

    expect(publisher.types()).toEqual(['permission_required', 'permission_resolved'])
    expect(await pending).toMatchObject({ decision: PermissionAction.ALLOW, resolvedBy: 'user' })
  })
})

describe('ApprovalBroker：幂等与先到先得', () => {
  it('同一 request_id 重复 resolve 返回首次结果且标记 duplicate', async () => {
    const { broker: b } = broker()
    const req = request({ expires_at: 1_000_000 + 60_000 })
    const pending = b.request(req, new AbortController().signal)
    await settle()

    const first = await b.resolve({
      requestId: req.request_id,
      decision: PermissionAction.ALLOW,
      principalId: 'local' as PrincipalId,
    })
    const second = await b.resolve({
      requestId: req.request_id,
      decision: PermissionAction.DENY,
      principalId: 'local' as PrincipalId,
    })

    expect(first).toMatchObject({ ok: true, duplicate: false })
    // 浏览器重发不是错误，应当回放首次决议
    expect(second).toMatchObject({ ok: true, duplicate: true })
    expect(second.ok && second.resolution.decision).toBe(PermissionAction.ALLOW)
    await pending
  })

  it('已解决的请求再次 request() 直接回放，不重新弹窗', async () => {
    const { broker: b, publisher } = broker()
    const req = request({ expires_at: 1_000_000 + 60_000 })
    const pending = b.request(req, new AbortController().signal)
    await settle()
    await b.resolve({
      requestId: req.request_id,
      decision: PermissionAction.DENY,
      principalId: 'local' as PrincipalId,
    })
    await pending

    const again = await b.request(req, new AbortController().signal)
    expect(again.decision).toBe(PermissionAction.DENY)
    // 只发过「请求 + 解决」两条，没有第二条 permission_required
    expect(publisher.types()).toEqual(['permission_required', 'permission_resolved'])
  })

  it('无权者不能解决审批', async () => {
    const publisher = new FakePublisher()
    const b = new ApprovalBroker({
      publisher,
      policy: DEFAULT_APP_POLICY,
      clock: createFakeClock(1_000_000),
      authorize: (who) => who === 'local',
    })
    const req = request({ expires_at: 1_000_000 + 60_000 })
    const pending = b.request(req, new AbortController().signal)
    await settle()

    const denied = await b.resolve({
      requestId: req.request_id,
      decision: PermissionAction.ALLOW,
      principalId: 'other' as PrincipalId,
    })

    expect(denied).toMatchObject({ ok: false, code: ErrorCode.PERMISSION_DENIED })
    // 审批仍在等待，没有被别人的提交解决掉
    expect(b.listPending()).toHaveLength(1)

    b.cancelAll('test')
    await pending
  })
})

describe('ApprovalBroker：超时、取消与队列', () => {
  it('超时按 deny 处理，且以 system 身份', async () => {
    const { broker: b, publisher } = broker({ approvalTimeoutMs: 5 })
    const req = request({ expires_at: 1_000_000 + 3 })
    const resolution = await b.request(req, new AbortController().signal)

    expect(resolution.decision).toBe(PermissionAction.DENY)
    expect(resolution.resolvedBy).toBe('system')
    expect(resolution.reason).toMatch(/超时/)
    expect(publisher.types()).toContain('permission_resolved')
  })

  it('取消等待同样按 deny 处理，并从队列摘除', async () => {
    const { broker: b } = broker()
    const req = request({ expires_at: 1_000_000 + 60_000 })
    const controller = new AbortController()

    const pending = b.request(req, controller.signal)
    await settle()
    expect(b.listPending()).toHaveLength(1)

    controller.abort()
    const resolution = await pending

    expect(resolution.decision).toBe(PermissionAction.DENY)
    expect(resolution.resolvedBy).toBe('system')
    // 不能留在队列里占名额
    expect(b.listPending()).toHaveLength(0)
  })

  it('队列满时立即拒绝，而不是无限排队', async () => {
    const { broker: b } = broker({ approvalQueueLimit: 1 })
    const signal = new AbortController().signal

    const first = b.request(request({ request_id: 'r1', expires_at: 1_000_000 + 60_000 }), signal)
    await settle()

    const second = await b.request(
      request({ request_id: 'r2', expires_at: 1_000_000 + 60_000 }),
      signal,
    )

    expect(second.decision).toBe(PermissionAction.DENY)
    expect(second.reason).toMatch(/队列已满/)
    b.cancelAll('test')
    await first
  })

  it('并发的两个请求都能被看到，互不覆盖（缺陷 T-2 的修正）', async () => {
    const { broker: b } = broker()
    const signal = new AbortController().signal

    const a = b.request(request({ request_id: 'ra', expires_at: 1_000_000 + 60_000 }), signal)
    const c = b.request(request({ request_id: 'rb', expires_at: 1_000_000 + 60_000 }), signal)
    await settle()

    // 旧实现是单槽位，第二个会覆盖第一个
    expect(
      b
        .listPending()
        .map((p) => p.requestId)
        .sort(),
    ).toEqual(['ra', 'rb'])

    b.cancelAll('test')
    await Promise.all([a, c])
  })

  it('cancelSession 只影响目标会话', async () => {
    const { broker: b } = broker()
    const signal = new AbortController().signal
    const s1 = createSessionId()
    const s2 = createSessionId()

    const one = b.request(
      request({ request_id: 'r1', session_id: s1, expires_at: 1_000_000 + 60_000 }),
      signal,
    )
    const two = b.request(
      request({ request_id: 'r2', session_id: s2, expires_at: 1_000_000 + 60_000 }),
      signal,
    )
    await settle()

    expect(b.cancelSession(s1, 'turn cancelled')).toBe(1)
    expect(b.listPending().map((p) => p.sessionId)).toEqual([s2])

    b.cancelAll('test')
    await Promise.all([one, two])
  })

  it('识别高风险二次确认的请求', async () => {
    const { broker: b } = broker()
    const signal = new AbortController().signal
    const pending = b.request(
      request({
        reason: 'high-risk action requires approval (second confirmation)',
        expires_at: 1_000_000 + 60_000,
      }),
      signal,
    )
    await settle()

    expect(b.listPending()[0]?.secondConfirmation).toBe(true)
    b.cancelAll('test')
    await pending
  })
})

describe('端到端：装上审批服务后审批事件仍然可见', () => {
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

  /** 先请求 bash，再根据工具结果给出一段文本。 */
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

  class Recorder implements EventSubscriber {
    readonly events: RuntimeEventEnvelope[] = []
    onEvent(event: RuntimeEventEnvelope): void {
      this.events.push(event)
    }
    get types(): string[] {
      return this.events.map((e) => e.type)
    }
  }

  /**
   * 像真实 UI 那样工作：收到 `permission_required` 就立刻批准。
   *
   * 不用轮询——轮询窗口与 turn 的推进速度耦合，会让测试变得不确定；
   * 而且事件驱动正是 UI 实际的行为，顺带验证了"事件回调里可以回灌决议"。
   */
  class AutoApprover extends Recorder {
    resolved = 0
    constructor(
      private readonly app: AgentApplication,
      private readonly decision: PermissionAction = PermissionAction.ALLOW,
    ) {
      super()
    }
    override onEvent(event: RuntimeEventEnvelope): void {
      super.onEvent(event)
      if (event.type !== 'permission_required') return
      const requestId = (event.data as { request_id?: string }).request_id
      if (requestId === undefined) return
      this.resolved++
      void this.app.resolvePermission({
        requestId,
        decision: this.decision,
        principalId: this.app.localPrincipalId,
      })
    }
  }

  it('broker 存在时 permission_required 仍然被发出（修复前这条事件永不出现）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deepcode-approval-'))
    const paths = resolveAppPaths({ home: dir, cwd: dir })
    const configStore = new ConfigStore(paths)
    await configStore.save(configDoc())

    const app = await AgentApplication.create({
      paths,
      workspaceRoot: dir,
      configStore,
      chatStore: new ChatStore(paths),
      // 不传 registry：由 create() 注册内置工具，bash 才存在
      providerFactory: bashFirstFactory,
    })
    expect(app.broker).toBeDefined()

    const session = await app.createSession(app.localPrincipalId)
    const recorder = new AutoApprover(app)
    await app.attach(recorder, { sessionId: session.id })

    const { result } = await app.submitTurn({
      principalId: app.localPrincipalId,
      sessionId: session.id,
      prompt: '跑一下',
    })

    expect(recorder.resolved).toBeGreaterThan(0)
    // 关键断言：装上 broker 之后，UI 依然能通过事件流看到待审批并解决它
    expect(recorder.types).toContain('permission_required')
    expect(recorder.types).toContain('permission_resolved')
    // 批准之后工具真的执行了，turn 正常收尾
    expect(result.status).toBe('completed')
  }, 20_000)

  it('事件落盘后可补发，重连的客户端不会漏掉审批项', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deepcode-approval-replay-'))
    const paths = resolveAppPaths({ home: dir, cwd: dir })
    const configStore = new ConfigStore(paths)
    await configStore.save(configDoc())

    const app = await AgentApplication.create({
      paths,
      workspaceRoot: dir,
      configStore,
      chatStore: new ChatStore(paths),
      // 不传 registry：由 create() 注册内置工具，bash 才存在
      providerFactory: bashFirstFactory,
    })
    const session = await app.createSession(app.localPrincipalId)
    await app.attach(new AutoApprover(app), { sessionId: session.id })

    await app.submitTurn({
      principalId: app.localPrincipalId,
      sessionId: session.id,
      prompt: '跑一下',
    })
    await app.flush()

    // 事后用锚点补发，应当能看到审批事件——正是"不能只依赖内存队列"的要求
    const persisted = (await app.eventLog.list(session.id)) as unknown as TurnStreamEvent[]
    expect(persisted.map((e) => e.type)).toContain('permission_required')
  }, 20_000)
})
