import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { AgentApplication } from '../../src/app/agent-application.js'
import { UserInputBroker } from '../../src/app/user-input-broker.js'
import type { EventPublisher, EventSubscriber } from '../../src/app/event-bus.js'
import { DEFAULT_APP_POLICY, type AppPolicy } from '../../src/app/policy.js'
import { ChatStore } from '../../src/storage/chat-store.js'
import { ConfigStore } from '../../src/storage/config-store.js'
import { resolveAppPaths } from '../../src/storage/paths.js'
import { ErrorCode } from '../../src/core/errors.js'
import { createPermissionRequestId, createSessionId, type PrincipalId } from '../../src/core/ids.js'
import { UserInputRequestStatus, type UserInputRequest } from '../../src/core/input.js'
import { ModelEventType, type Provider } from '../../src/core/provider.js'
import { createFakeClock } from '../../src/core/time.js'
import type { ConfigDocument } from '../../src/storage/types.js'
import type { RuntimeEventEnvelope } from '../../src/core/events.js'

class FakePublisher implements EventPublisher {
  readonly published: { type: string; data: unknown }[] = []
  publish(input: { type: string; data: unknown }): Promise<RuntimeEventEnvelope> {
    this.published.push({ type: input.type, data: input.data })
    return Promise.resolve({} as RuntimeEventEnvelope)
  }
  types(): string[] {
    return this.published.map((p) => p.type)
  }
}

const makeRequest = (over: Partial<UserInputRequest> = {}): UserInputRequest => ({
  request_id: createPermissionRequestId(),
  session_id: createSessionId(),
  turn_id: 'turn_1' as UserInputRequest['turn_id'],
  tool_call_id: 'call_1' as UserInputRequest['tool_call_id'],
  tool_name: 'ask_user_question',
  questions: [
    {
      question: '用哪种方案？',
      header: '方案',
      options: [
        { label: '方案 A', description: '改动小' },
        { label: '方案 B', description: '更彻底' },
      ],
    },
  ],
  created_at: '2026-09-15T00:00:00.000Z',
  expires_at: 1_000_000 + 60_000,
  ...over,
})

const broker = (policy: Partial<AppPolicy> = {}, nowMs = 1_000_000) => {
  const publisher = new FakePublisher()
  const b = new UserInputBroker({
    publisher,
    policy: { ...DEFAULT_APP_POLICY, ...policy },
    clock: createFakeClock(nowMs),
  })
  return { broker: b, publisher }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('UserInputBroker：事件发射', () => {
  it('挂起提问时发出 user_input_required（修复前这条事件永不出现）', async () => {
    const { broker: b, publisher } = broker()
    const controller = new AbortController()
    const request = makeRequest()

    const pending = b.request(request, controller.signal)
    await settle()

    expect(publisher.types()).toEqual(['user_input_required'])
    const data = publisher.published[0]?.data as Record<string, unknown>
    expect(data['request_id']).toBe(request.request_id)
    expect(data['tool_name']).toBe('ask_user_question')
    expect(Array.isArray(data['questions'])).toBe(true)

    controller.abort()
    await pending
  })

  it('作答后发出 user_input_resolved', async () => {
    const { broker: b, publisher } = broker()
    const request = makeRequest()
    const pending = b.request(request, new AbortController().signal)
    await settle()

    await b.answer({
      requestId: request.request_id,
      answers: [['方案 A']],
      principalId: 'local' as PrincipalId,
    })

    expect(publisher.types()).toEqual(['user_input_required', 'user_input_resolved'])
    expect(await pending).toMatchObject({ answers: [['方案 A']], resolvedBy: 'user' })
  })

  it('空问题列表直接返回 _empty 的语义，不打扰用户', async () => {
    const { broker: b, publisher } = broker()
    const request = makeRequest({ questions: [] })
    const resolution = await b.request(request, new AbortController().signal)

    expect(resolution.answers).toEqual([])
    // 没有真正需要用户做的事，就不应该弹窗
    expect(publisher.types()).toEqual([])
  })
})

describe('UserInputBroker：超时不是拒绝', () => {
  it('超时返回 answers === null，而不是某种"拒绝"', async () => {
    const { broker: b } = broker({ userInputTimeoutMs: 5 })
    const request = makeRequest({ expires_at: 1_000_000 + 3 })

    const resolution = await b.request(request, new AbortController().signal)

    // 这是与 ApprovalBroker 的关键差别：权限超时按 deny，提问超时只是"没答案"
    expect(resolution.answers).toBeNull()
    expect(resolution.resolvedBy).toBe('system')
    expect(resolution.reason).toMatch(/超时/)
  })

  it('取消同样返回 answers === null，并从队列摘除', async () => {
    const { broker: b } = broker()
    const controller = new AbortController()
    const pending = b.request(makeRequest(), controller.signal)
    await settle()
    expect(b.listPending()).toHaveLength(1)

    controller.abort()
    const resolution = await pending

    expect(resolution.answers).toBeNull()
    expect(b.listPending()).toHaveLength(0)
  })

  it('APS 队列满时立即返回"无答案"，不无限排队', async () => {
    const { broker: b } = broker({ userInputQueueLimit: 1 })
    const signal = new AbortController().signal

    const first = b.request(makeRequest(), signal)
    await settle()
    const second = await b.request(makeRequest(), signal)

    expect(second.answers).toBeNull()
    expect(second.reason).toMatch(/队列已满/)
    b.cancelAll('test')
    await first
  })
})

describe('UserInputBroker：幂等', () => {
  it('重复 answer 返回首次结果并标记 duplicate', async () => {
    const { broker: b } = broker()
    const request = makeRequest()
    const pending = b.request(request, new AbortController().signal)
    await settle()

    const first = await b.answer({
      requestId: request.request_id,
      answers: [['方案 A']],
      principalId: 'local' as PrincipalId,
    })
    const second = await b.answer({
      requestId: request.request_id,
      answers: [['方案 B']],
      principalId: 'local' as PrincipalId,
    })

    expect(first).toMatchObject({ ok: true, duplicate: false })
    expect(second).toMatchObject({ ok: true, duplicate: true })
    expect(second.ok && second.resolution.answers).toEqual([['方案 A']])
    await pending
  })

  it('重复 request 不重复弹窗', async () => {
    const { broker: b, publisher } = broker()
    const request = makeRequest()
    const controller = new AbortController()

    const first = b.request(request, controller.signal)
    await settle()
    const second = b.request(request, controller.signal)
    await settle()

    expect(publisher.types()).toEqual(['user_input_required'])
    controller.abort()
    await Promise.all([first, second])
  })

  it('无权者不能作答', async () => {
    const publisher = new FakePublisher()
    const b = new UserInputBroker({
      publisher,
      policy: DEFAULT_APP_POLICY,
      clock: createFakeClock(1_000_000),
      authorize: (who) => who === 'local',
    })
    const request = makeRequest()
    const pending = b.request(request, new AbortController().signal)
    await settle()

    const denied = await b.answer({
      requestId: request.request_id,
      answers: [['方案 A']],
      principalId: 'other' as PrincipalId,
    })

    expect(denied).toMatchObject({ ok: false, code: ErrorCode.PERMISSION_DENIED })
    expect(b.listPending()).toHaveLength(1)
    b.cancelAll('test')
    await pending
  })
})

describe('端到端：ask_user_question 真正可用', () => {
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

  /** 先问问题，拿到结果后给一段文本。 */
  const askFirstFactory = () => {
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
                  name: 'ask_user_question',
                  input: {
                    questions: [
                      {
                        question: '选哪个？',
                        header: '选择',
                        options: [
                          { label: 'A', description: '甲' },
                          { label: 'B', description: '乙' },
                        ],
                      },
                    ],
                  },
                },
              ]
            : [{ type: ModelEventType.TEXT, content: '好的' }]
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

  class AutoAnswer implements EventSubscriber {
    readonly events: RuntimeEventEnvelope[] = []
    answers: unknown = null
    constructor(private readonly app: AgentApplication) {}
    onEvent(event: RuntimeEventEnvelope): void {
      this.events.push(event)
      if (event.type !== 'user_input_required') return
      const requestId = (event.data as { request_id?: string }).request_id
      if (requestId === undefined) return
      void this.app
        .answerUserInput({
          requestId,
          answers: [['A']],
          principalId: this.app.localPrincipalId,
        })
        .then((r) => {
          this.answers = r
        })
    }
    get types(): string[] {
      return this.events.map((e) => e.type)
    }
  }

  const build = async (name: string, policy: Partial<AppPolicy> = {}) => {
    const dir = await mkdtemp(join(tmpdir(), name))
    const paths = resolveAppPaths({ home: dir, cwd: dir })
    const configStore = new ConfigStore(paths)
    await configStore.save(configDoc())
    const app = await AgentApplication.create({
      paths,
      workspaceRoot: dir,
      configStore,
      chatStore: new ChatStore(paths),
      policy,
      providerFactory: askFirstFactory,
    })
    return { dir, paths, app }
  }

  it('问卷可被回答，答案回灌给模型并让 turn 继续', async () => {
    const { app } = await build('deepcode-ask-')
    expect(app.userInputBroker).toBeDefined()

    const session = await app.createSession(app.localPrincipalId)
    const spy = new AutoAnswer(app)
    await app.attach(spy, { sessionId: session.id })

    const { result } = await app.submitTurn({
      principalId: app.localPrincipalId,
      sessionId: session.id,
      prompt: '问一下',
    })

    expect(spy.types).toContain('user_input_required')
    expect(spy.types).toContain('user_input_resolved')
    // 拿到答案后 turn 继续跑完，而不是提前终止
    expect(result.status).toBe('completed')

    // 答案以 {answers:[...]} 的形状回灌，且写进了 transcript
    const messages = await app.chatStore.listMessages(session.id)
    const toolResult = messages.find((m) => m.subtype === 'tool_result')
    expect(toolResult).toBeDefined()
    expect(toolResult?.content).toContain('A')
  }, 20_000)

  it('提问请求与作答都被持久化，并可从恢复扫描中读出状态', async () => {
    const { app } = await build('deepcode-ask-persist-')
    const session = await app.createSession(app.localPrincipalId)
    await app.attach(new AutoAnswer(app), { sessionId: session.id })

    await app.submitTurn({
      principalId: app.localPrincipalId,
      sessionId: session.id,
      prompt: '问一下',
    })

    const persisted = await app.chatStore.listUserInputRequests(session.id)
    expect(persisted).toHaveLength(1)
    expect(persisted[0]?.status).toBe(UserInputRequestStatus.ANSWERED)
    expect(persisted[0]?.answers).toEqual([['A']])
    expect(persisted[0]?.resolved_by).toBe('user')
  }, 20_000)

  it('没有 UI 作答时等到超时，回灌 _timeout 并继续跑（而不是失败）', async () => {
    // ️ 这里**不能**期望"立刻返回"：没有订阅者不等于"没有人会来回答"——
    // 用户可能正在打开终端或刷新页面。等满超时才是规格行为
    // （parts/05 §7.7：120 秒后回灌 {"_timeout": true}）。测试把超时调小以免拖慢。
    const { app } = await build('deepcode-ask-timeout-', { userInputTimeoutMs: 50 })
    const session = await app.createSession(app.localPrincipalId)
    // 刻意不挂订阅者：模拟"没有 UI 在听"

    const { result } = await app.submitTurn({
      principalId: app.localPrincipalId,
      sessionId: session.id,
      prompt: '问一下',
    })

    // 关键：turn 正常完成，而不是因为没人回答而失败
    expect(result.status).toBe('completed')

    const messages = await app.chatStore.listMessages(session.id)
    const toolResult = messages.find((m) => m.subtype === 'tool_result')
    // 形状来自旧实现，必须逐字保留
    expect(toolResult?.content).toContain('_timeout')
  }, 20_000)
})
