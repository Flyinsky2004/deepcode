/**
 * UserInputBroker 的剩余分支：**入口参数边界与"没有答案"的语义**。
 *
 * `user-input-broker.test.ts` 覆盖了事件发射、超时与取消。这里补三类：
 * - `answer()` / `request()` 面对未知或已解决的 requestId 时的答复；
 * - `listPending()` / `cancelSession()` 的范围参数；
 * - **已经 abort 的信号**与 `answers: null`——这是与审批 broker 最实质的差别，
 *   超时/取消产出的是"没答案"（`answers === null`）而**不是**某种拒绝，
 *   turn 必须继续跑。这条差别抹平就会让模型行为不等价。
 */
import { describe, expect, it } from 'vitest'

import { UserInputBroker, userInputError } from '../../src/app/user-input-broker.js'
import type { EventPublisher } from '../../src/app/event-bus.js'
import { DEFAULT_APP_POLICY, type AppPolicy } from '../../src/app/policy.js'
import { AgentError, ErrorCode } from '../../src/core/errors.js'
import { createPermissionRequestId, createSessionId, type PrincipalId } from '../../src/core/ids.js'

const LOCAL = 'local' as PrincipalId
import type { UserInputRequest } from '../../src/core/input.js'
import { createFakeClock } from '../../src/core/time.js'
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

const NOW = 1_000_000
const broker = (policy: Partial<AppPolicy> = {}, allowed?: PrincipalId) => {
  const publisher = new FakePublisher()
  const b = new UserInputBroker({
    publisher,
    policy: { ...DEFAULT_APP_POLICY, ...policy },
    clock: createFakeClock(NOW),
    ...(allowed === undefined ? {} : { authorize: (who: PrincipalId) => who === allowed }),
  })
  return { broker: b, publisher }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('UserInputBroker：未知与已解决的 requestId', () => {
  it('answer() 面对不存在的 requestId → SESSION_NOT_FOUND，且不发事件', async () => {
    const { broker: b, publisher } = broker()
    const result = await b.answer({
      requestId: 'req_从未存在',
      answers: [['方案 A']],
      principalId: 'local' as PrincipalId,
    })

    expect(result).toMatchObject({ ok: false, code: ErrorCode.SESSION_NOT_FOUND })
    expect(publisher.types()).toEqual([])
  })

  it('已解决的 requestId 再次 request() 直接回放，不重复弹窗', async () => {
    // 重连、重试、恢复都会重复调用 request()；重复弹窗在提问上比审批更烦人
    // （会打断用户当前正在输入的内容）。
    const { broker: b, publisher } = broker()
    const req = makeRequest()
    const pending = b.request(req, new AbortController().signal)
    await settle()

    await b.answer({
      requestId: req.request_id,
      answers: [['方案 A']],
      principalId: 'local' as PrincipalId,
    })
    await pending

    const again = await b.request(req, new AbortController().signal)
    expect(again.answers).toEqual([['方案 A']])
    expect(publisher.types()).toEqual(['user_input_required', 'user_input_resolved'])
  })

  it('空问题列表的"空答案"会被记进已解决表，重复 request() 不再走空问题分支', async () => {
    const { broker: b, publisher } = broker()
    const req = makeRequest({ questions: [] })

    const first = await b.request(req, new AbortController().signal)
    const second = await b.request(req, new AbortController().signal)

    expect(first.answers).toEqual([])
    expect(second.answers).toEqual([])
    expect(publisher.types()).toEqual([])
  })

  it('answer() 的 reason 会被带进决议', async () => {
    const { broker: b } = broker()
    const req = makeRequest()
    const pending = b.request(req, new AbortController().signal)
    await settle()

    const result = await b.answer({
      requestId: req.request_id,
      answers: [['方案 B']],
      principalId: 'local' as PrincipalId,
      reason: '用户选的 B',
    })

    expect(result.ok && result.resolution.reason).toBe('用户选的 B')
    await pending
  })

  it('无权者不能回答，且提问不被消耗', async () => {
    const { broker: b } = broker({}, LOCAL)
    const req = makeRequest()
    const pending = b.request(req, new AbortController().signal)
    await settle()

    const denied = await b.answer({
      requestId: req.request_id,
      answers: [['方案 A']],
      principalId: 'other' as PrincipalId,
    })
    expect(denied).toMatchObject({ ok: false, code: ErrorCode.PERMISSION_DENIED })
    // 仍然在等真正有权限的人
    expect(b.listPending()).toHaveLength(1)

    b.cancelAll('清理')
    await pending
  })
})

describe('UserInputBroker：范围参数', () => {
  it('listPending() 不带参数时返回全部会话的提问', async () => {
    const { broker: b } = broker()
    const signal = new AbortController().signal
    const s1 = createSessionId()
    const s2 = createSessionId()

    const one = b.request(makeRequest({ session_id: s1 }), signal)
    const two = b.request(makeRequest({ session_id: s2 }), signal)
    await settle()

    expect(b.listPending()).toHaveLength(2)
    expect(b.listPending(s1)).toHaveLength(1)
    expect(b.listPending('不存在的会话')).toEqual([])

    b.cancelAll('清理')
    await Promise.all([one, two])
  })

  it('cancelSession 只结清目标会话，别的会话一条都不动', async () => {
    // 逐个条目筛会话的循环必须真的跳过不匹配项——否则取消一个会话的 turn
    // 会把另一个会话正在等的提问也一起取消掉。
    const { broker: b } = broker()
    const signal = new AbortController().signal
    const mine = createSessionId()
    const other = createSessionId()

    const kept = b.request(makeRequest({ session_id: other }), signal)
    const dropped = b.request(makeRequest({ session_id: mine }), signal)
    await settle()

    expect(b.cancelSession(mine, 'turn 被取消')).toBe(1)
    expect(b.listPending().map((p) => p.sessionId)).toEqual([other])

    // 目标会话之外的提问仍在等待，且没被塞进已解决表
    expect(b.listPending()[0]?.sessionId).toBe(other)
    expect(b.listPending()[0]?.requestId).toBeTruthy()

    expect(b.cancelSession('压根不存在的会话', '关闭')).toBe(0)
    expect(b.listPending()).toHaveLength(1)

    const resolution = await dropped
    expect(resolution.answers).toBeNull()

    b.cancelAll('清理')
    await kept
  })

  it('cancelAll 把每一条都按"没有答案"结清并广播', async () => {
    const { broker: b, publisher } = broker()
    const signal = new AbortController().signal
    const one = b.request(makeRequest(), signal)
    const two = b.request(makeRequest(), signal)
    await settle()

    expect(b.cancelAll('服务关闭')).toBe(2)
    const [r1, r2] = await Promise.all([one, two])

    // 不是拒绝——是"没有答案"，answers 为 null 才是它的表达
    expect(r1.answers).toBeNull()
    expect(r2.answers).toBeNull()
    expect(r1.resolvedBy).toBe('system')
    expect(r1.reason).toBe('服务关闭')
    expect(publisher.types().filter((t) => t === 'user_input_resolved')).toHaveLength(2)
  })
})

describe('UserInputBroker：已经 abort 的信号', () => {
  it('传入 aborted 的信号时立刻返回"没有答案"，turn 不被挂住', async () => {
    const { broker: b } = broker()
    const aborted = new AbortController()
    aborted.abort()

    const resolution = await b.request(makeRequest(), aborted.signal)

    // 关键：不是拒绝，是没答案；executor 会回灌 `{"_timeout": true}` 让模型继续
    expect(resolution.answers).toBeNull()
    expect(resolution.resolvedBy).toBe('system')
    expect(resolution.reason).toMatch(/取消/)

    b.cancelAll('清理')
  })

  it('等待期间 abort：同样产出"没有答案"', async () => {
    const { broker: b } = broker()
    const controller = new AbortController()
    const pending = b.request(makeRequest(), controller.signal)
    await settle()

    controller.abort()
    const resolution = await pending

    expect(resolution.answers).toBeNull()
    expect(resolution.resolvedBy).toBe('system')
  })

  it('已 abort 的路径与"中途 abort"语义一致：摘队列、归档、广播（不再留幽灵项）', async () => {
    // 这里原本固化的是一个缺陷（已修）：
    //
    // `#wait` 在 `signal.aborted` 时**直接 resolve**，既不 `#settle` 也不广播，
    // 而"等待期间才 abort"的 `onAbort` 路径是完整的——同一条语义两份实现，
    // 其中一份漏了收尾。于是该项仍留在 `#pending` 占着 `userInputQueueLimit`
    // 名额，且定时器到点后会再发一条 `user_input_resolved`。
    //
    // 现在快路径复用 `onAbort`，与中途 abort 完全一致。
    const { broker: b, publisher } = broker({ userInputTimeoutMs: 5 })
    const aborted = new AbortController()
    aborted.abort()

    const resolution = await b.request(makeRequest({ expires_at: NOW + 3 }), aborted.signal)
    expect(resolution.answers).toBeNull()
    expect(resolution.resolvedBy).toBe('system')

    // 立刻摘掉，不再占用名额
    expect(b.listPending()).toHaveLength(0)
    // 收尾时**当场**广播。没有 `user_input_required`：请求在创建时就已被取消，
    // 广播"待回答"只会让 UI 弹出一个已经结束的问卷。
    expect(publisher.types()).toEqual(['user_input_resolved'])

    // 定时器到点后不得再补发一条
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(publisher.types()).toEqual(['user_input_resolved'])
    expect(b.listPending()).toHaveLength(0)
  })
})

describe('userInputError：启动错误包装', () => {
  it('AgentError 原样透传', () => {
    const original = new AgentError({
      code: ErrorCode.SESSION_NOT_FOUND,
      message: '没了',
      source: 'app',
    })
    expect(userInputError(original)).toBe(original)
  })

  it('非 AgentError 被包成 INTERNAL_ERROR', () => {
    const wrapped = userInputError(new Error('通道断了'))
    expect(wrapped.code).toBe(ErrorCode.INTERNAL_ERROR)
    expect(wrapped.message).toContain('通道断了')
    expect(wrapped.source).toBe('user-input')
  })

  it('非 Error 的抛出值也能被包起来', () => {
    expect(userInputError({ weird: true }).message).toBeTruthy()
  })
})
