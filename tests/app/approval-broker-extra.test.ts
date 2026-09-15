/**
 * ApprovalBroker 的剩余分支：**入口参数的边界与错误契约**。
 *
 * `approval-broker.test.ts` 覆盖了幂等、先到先得、超时与队列。这里补三类：
 * - `resolve()` 面对"这个 requestId 我根本不知道"时的答复（必须能区分
 *   "不存在"与"无权"，因为调用方已经证明它知道这个 id）；
 * - `listPending()` 的范围参数（刚连上的客户端要么拉某个会话、要么拉全部）；
 * - **已经 abort 的信号**——`ToolExecutor` 在 turn 被取消后仍会走到这里，
 *   这时必须立刻按 deny 返回，而不是挂到 120 秒超时。
 */
import { describe, expect, it } from 'vitest'

import { ApprovalBroker, approvalError } from '../../src/app/approval-broker.js'
import type { EventPublisher } from '../../src/app/event-bus.js'
import { DEFAULT_APP_POLICY, type AppPolicy } from '../../src/app/policy.js'
import { AgentError, ErrorCode } from '../../src/core/errors.js'
import { createSessionId, type PrincipalId } from '../../src/core/ids.js'
import { PermissionAction, type PermissionRequest } from '../../src/core/tool.js'
import { createFakeClock } from '../../src/core/time.js'
import type { RuntimeEventEnvelope } from '../../src/core/events.js'

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
  expires_at: 1_000_000 + 60_000,
  resolved_at: null,
  resolved_by: '',
  resolution: '',
  ...over,
})

const NOW = 1_000_000
const broker = (policy: Partial<AppPolicy> = {}, authorize?: (who: PrincipalId) => boolean) => {
  const publisher = new FakePublisher()
  const b = new ApprovalBroker({
    publisher,
    policy: { ...DEFAULT_APP_POLICY, ...policy },
    clock: createFakeClock(NOW),
    ...(authorize === undefined ? {} : { authorize: (who: PrincipalId) => authorize(who) }),
  })
  return { broker: b, publisher }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('ApprovalBroker：未知 requestId 的答复', () => {
  it('完全不认识的 requestId → SESSION_NOT_FOUND（不是"无权"）', async () => {
    const { broker: b, publisher } = broker()
    const result = await b.resolve({
      requestId: 'req_从未存在',
      decision: PermissionAction.ALLOW,
      principalId: 'local' as PrincipalId,
    })

    expect(result).toMatchObject({ ok: false, code: ErrorCode.SESSION_NOT_FOUND })
    // 不存在的请求不该产生任何事件——否则 UI 会收到一条无法对应的 permission_resolved
    expect(publisher.types()).toEqual([])
  })

  it('已超时/已取消的请求再 resolve → 回放存档决议并标 duplicate（浏览器重发是正常路径）', async () => {
    const { broker: b } = broker({ approvalTimeoutMs: 5 })
    const req = request({ expires_at: NOW + 3 })
    const timedOut = await b.request(req, new AbortController().signal)
    expect(timedOut.decision).toBe(PermissionAction.DENY)

    const late = await b.resolve({
      requestId: req.request_id,
      decision: PermissionAction.ALLOW,
      principalId: 'local' as PrincipalId,
    })
    // 迟到的"允许"必须被忽略，而不是覆盖已经发生的拒绝
    expect(late).toMatchObject({ ok: true, duplicate: true })
    expect(late.ok && late.resolution.decision).toBe(PermissionAction.DENY)
  })

  it('权限校验在"不存在"之前：无权者提交未知 id 仍得到 SESSION_NOT_FOUND', async () => {
    // 不泄露"这个 id 是否存在"给无权者——但要通过"先查表再鉴权"的顺序保证
    const { broker: b } = broker({}, (who) => who === 'local')
    const result = await b.resolve({
      requestId: 'req_未知',
      decision: PermissionAction.ALLOW,
      principalId: 'other' as PrincipalId,
    })
    expect(result).toMatchObject({ ok: false, code: ErrorCode.SESSION_NOT_FOUND })
  })
})

describe('ApprovalBroker：决议的可选字段与视图', () => {
  it('resolution 原样带上 grantScope 与 reason', async () => {
    const { broker: b } = broker()
    const req = request()
    const pending = b.request(req, new AbortController().signal)
    await settle()

    const result = await b.resolve({
      requestId: req.request_id,
      decision: PermissionAction.ALLOW,
      principalId: 'local' as PrincipalId,
      grantScope: { kind: 'session', sessionId: req.session_id, expiresAt: NOW + 1000 } as never,
      reason: '用户点的允许',
    })

    expect(result.ok).toBe(true)
    expect(result.ok && result.resolution.grantScope).toBeDefined()
    expect(result.ok && result.resolution.reason).toBe('用户点的允许')
    await pending
  })

  it('resolvedBy 缺省为 user', async () => {
    const { broker: b } = broker()
    const req = request()
    const pending = b.request(req, new AbortController().signal)
    await settle()

    const result = await b.resolve({
      requestId: req.request_id,
      decision: PermissionAction.DENY,
      principalId: 'local' as PrincipalId,
    })
    expect(result.ok && result.resolution.resolvedBy).toBe('user')
    await pending
  })

  it('listPending() 不带参数时返回全部会话的待审批项', async () => {
    // 刚连上的客户端还不知道自己在哪个会话，必须能拉全量补齐错过的审批
    const { broker: b } = broker()
    const signal = new AbortController().signal
    const s1 = createSessionId()
    const s2 = createSessionId()

    const one = b.request(request({ request_id: 'r1', session_id: s1 }), signal)
    const two = b.request(request({ request_id: 'r2', session_id: s2 }), signal)
    await settle()

    expect(b.listPending()).toHaveLength(2)
    expect(b.listPending(s1).map((p) => p.requestId)).toEqual(['r1'])

    b.cancelAll('test')
    await Promise.all([one, two])
  })

  it('普通请求的 secondConfirmation 为 false（只有 executor 追加的后缀才为 true）', async () => {
    const { broker: b } = broker()
    const pending = b.request(request(), new AbortController().signal)
    await settle()
    expect(b.listPending()[0]?.secondConfirmation).toBe(false)
    b.cancelAll('test')
    await pending
  })
})

describe('ApprovalBroker：已经 abort 的信号', () => {
  it('传入 aborted 的信号时立刻按 deny 返回，不挂到超时', async () => {
    // turn 被取消后 `ToolExecutor` 仍会带着已 abort 的 signal 走到这里；
    // 若这里挂起，用户点完取消还要再等满审批超时才能看到 turn 结束。
    const { broker: b } = broker()
    const aborted = new AbortController()
    aborted.abort()

    const resolution = await b.request(request(), aborted.signal)

    expect(resolution.decision).toBe(PermissionAction.DENY)
    expect(resolution.resolvedBy).toBe('system')
    expect(resolution.reason).toMatch(/取消/)

    b.cancelAll('清理')
  })

  it('已 abort 的路径与"中途 abort"语义一致：摘队列、归档、广播（不再留幽灵项）', async () => {
    // 这里原本固化的是一个缺陷（已修）：
    //
    // `#wait` 在 `signal.aborted` 时**直接 resolve**，既不 `#settle` 也不发
    // `permission_resolved`，而"等待期间才 abort"的 `onAbort` 路径是完整的——
    // 同一条语义两份实现，其中一份漏了收尾。后果三条：
    //   1. 该项仍留在 `#pending` 占着 `approvalQueueLimit` 名额，最终会把真实审批
    //      挤成"队列已满"而拒绝（这条最严重）；
    //   2. 它仍会发出 `permission_required`，UI 可能弹出一个**已经取消掉的**审批框；
    //   3. 它的定时器到点后会再发一次 `permission_resolved`，而调用方早已拿到答案。
    //
    // 现在快路径直接复用 `onAbort`（不另写一份收尾），与中途 abort 完全一致。
    const { broker: b, publisher } = broker({ approvalTimeoutMs: 5 })
    const aborted = new AbortController()
    aborted.abort()

    const resolution = await b.request(request({ expires_at: NOW + 3 }), aborted.signal)
    expect(resolution.decision).toBe(PermissionAction.DENY)
    expect(resolution.resolvedBy).toBe('system')

    // 1：立刻从队列摘掉，不再占用名额
    expect(b.listPending()).toHaveLength(0)
    // 3：收尾时**当场**广播，而不是等定时器到点补发。
    //
    // 注意这里**没有** `permission_required`：请求在创建时就已被取消，
    // 广播"待审批"只会让 UI 弹出一个已经结束的框，前端还会拿到一个
    // "未见过就已解决"的 request_id。所以 `request()` 在 `signal.aborted`
    // 时只发 `permission_resolved`——先 resolved 后 required 的顺序是错的。
    expect(publisher.types()).toEqual(['permission_resolved'])

    // 定时器到点后不得再补发一条
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(publisher.types()).toEqual(['permission_resolved'])
    expect(b.listPending()).toHaveLength(0)
  })

  it('已 abort 的路径不会挤占审批队列名额', async () => {
    // 直接验证上面第 1 条后果的**实际影响**：队列上限为 1 时，
    // 一次"带着已 abort 信号"的请求若留下幽灵项，紧随其后的真实审批会被拒。
    const { broker: b } = broker({ approvalQueueLimit: 1 })
    const aborted = new AbortController()
    aborted.abort()
    await b.request(request({ request_id: 'r-aborted' }), aborted.signal)

    const controller = new AbortController()
    const real = b.request(request({ request_id: 'r-real' }), controller.signal)
    await settle()
    expect(b.listPending().map((p) => p.requestId)).toEqual(['r-real'])
    controller.abort()
    await real
  })

  it('等待期间 abort：同样按 deny 处理且广播已解决', async () => {
    const { broker: b, publisher } = broker()
    const controller = new AbortController()
    const pending = b.request(request(), controller.signal)
    await settle()

    controller.abort()
    const resolution = await pending

    expect(resolution.decision).toBe(PermissionAction.DENY)
    expect(publisher.types()).toEqual(['permission_required', 'permission_resolved'])
  })
})

describe('approvalError：启动错误包装', () => {
  it('AgentError 原样透传（不重复包装，保留原 source 与 code）', () => {
    const original = new AgentError({
      code: ErrorCode.VALIDATION_FAILED,
      message: '配置有问题',
      source: 'app.policy',
    })
    expect(approvalError(original)).toBe(original)
  })

  it('非 AgentError 被包成 INTERNAL_ERROR 且带上原文', () => {
    const wrapped = approvalError(new Error('连接被重置'))
    expect(wrapped.code).toBe(ErrorCode.INTERNAL_ERROR)
    expect(wrapped.message).toContain('连接被重置')
    expect(wrapped.source).toBe('approval')
  })

  it('非 Error 的抛出值也能被包起来', () => {
    expect(approvalError('裸字符串').message).toContain('裸字符串')
  })
})
