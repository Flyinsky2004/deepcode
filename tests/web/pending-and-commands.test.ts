/**
 * 审批 / 提问 / 命令三条"回灌"路径的 HTTP 往返。
 *
 * 这三条都有一个共同点：**事件由 broker 发出，决议由 HTTP 提交**。
 * 事件方向（`permission_required` 由 broker 广播）与命令方向（`resolvePermission`
 * 回灌）分别由 `tests/app/*` 与这里覆盖；这一组补的是"浏览器这一端真的能
 * 把决议送到 runtime 手里"。
 *
 * 权限请求与提问都直接构造内核对象并调用 broker —— 用真实工具去触发它们
 * 需要跑满一轮模型 + 工具调用，而这里要验证的是**传输与授权**，不是工具执行。
 */

import { describe, expect, it, afterEach } from 'vitest'

import { ErrorCode } from '../../src/core/errors.js'
import type { SessionId, ToolCallId, TurnId } from '../../src/core/ids.js'
import { PermissionRequestStatus, type PermissionRequest } from '../../src/core/tool.js'
import type { UserInputRequest } from '../../src/core/input.js'
import { PermissionRequestStatus as Status } from '../../src/core/tool.js'
import { CommandRegistry } from '../../src/commands/registry.js'
import { CommandResultCode, type CommandHost } from '../../src/commands/types.js'
import { startHarness, postJson, readJson, type WebHarness } from './harness.js'

const open: WebHarness[] = []

async function harness(options: Parameters<typeof startHarness>[0] = {}): Promise<WebHarness> {
  const created = await startHarness(options)
  open.push(created)
  return created
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((item) => item.close()))
})

function permissionRequest(
  sessionId: string,
  overrides: Partial<PermissionRequest> = {},
): PermissionRequest {
  return {
    request_id: `req-${Math.random().toString(36).slice(2)}`,
    session_id: sessionId as SessionId,
    turn_id: 'turn_1_x' as TurnId,
    tool_call_id: 'call-1' as ToolCallId,
    tool_name: 'file_write',
    args_preview: 'path=notes.txt',
    risk_level: 'medium',
    reason: '需要写入工作区文件',
    status: Status.PENDING_USER_APPROVAL,
    created_at: new Date().toISOString(),
    expires_at: Date.now() + 60_000,
    resolved_at: null,
    resolved_by: '',
    resolution: '',
    ...overrides,
  }
}

describe('审批：HTTP 往返', () => {
  it('待审批项出现在 /api/pending，并可按 requestId 批准', async () => {
    const h = await harness()
    const sessionId = await h.newSession()

    const broker = h.app.broker
    expect(broker).toBeDefined()
    const request = permissionRequest(sessionId)
    // 挂起请求（不 await：它在等决议）
    const waiting = broker?.request(request, new AbortController().signal)

    const pending = await readJson<{ approvals: { requestId: string }[] }>(
      await h.fetch('/api/pending'),
    )
    expect(pending.approvals.map((item) => item.requestId)).toContain(request.request_id)

    const response = await postJson(h, `/api/permissions/${request.request_id}`, {
      decision: 'allow',
    })
    expect(response.status).toBe(200)

    // 决议真的送到了 broker：挂起的那次调用带着 allow 返回
    await expect(waiting).resolves.toMatchObject({ decision: 'allow' })

    // 已结束的请求不再出现在待办里
    const after = await readJson<{ approvals: unknown[] }>(await h.fetch('/api/pending'))
    expect(after.approvals).toHaveLength(0)
  })

  it('拒绝同样生效', async () => {
    const h = await harness()
    const sessionId = await h.newSession()
    const request = permissionRequest(sessionId)
    const waiting = h.app.broker?.request(request, new AbortController().signal)

    const response = await postJson(h, `/api/permissions/${request.request_id}`, {
      decision: 'deny',
      reason: '太危险',
    })
    expect(response.status).toBe(200)
    await expect(waiting).resolves.toMatchObject({ decision: 'deny' })
  })

  it('重复提交是幂等的（浏览器重发不是错误）', async () => {
    const h = await harness()
    const sessionId = await h.newSession()
    const request = permissionRequest(sessionId)
    const waiting = h.app.broker?.request(request, new AbortController().signal)

    const first = await postJson(h, `/api/permissions/${request.request_id}`, { decision: 'allow' })
    const second = await postJson(h, `/api/permissions/${request.request_id}`, { decision: 'deny' })

    expect((await readJson<{ duplicate: boolean }>(first)).duplicate).toBe(false)
    const replay = await readJson<{ duplicate: boolean; decision: string }>(second)
    expect(replay.duplicate).toBe(true)
    // 首次决议胜出，后到的 deny 不会翻案
    expect(replay.decision).toBe('allow')
    await waiting
  })

  it('grantScope: once 被接受（一次性授权，用 toolCallId 绑定）', async () => {
    const h = await harness()
    const sessionId = await h.newSession()
    const request = permissionRequest(sessionId)
    const waiting = h.app.broker?.request(request, new AbortController().signal)

    const response = await postJson(h, `/api/permissions/${request.request_id}`, {
      decision: 'allow',
      grantScope: 'once',
    })
    expect(response.status).toBe(200)
    const resolution = await waiting
    expect(resolution?.grantScope).toEqual({ kind: 'allow-once', toolCallId: 'call-1' })
  })

  it('⚠️ 未开放的持久授权范围被明确拒绝，而不是静默降级成一次授权', async () => {
    const h = await harness()
    const sessionId = await h.newSession()
    const request = permissionRequest(sessionId)
    void h.app.broker?.request(request, new AbortController().signal)

    const response = await postJson(h, `/api/permissions/${request.request_id}`, {
      decision: 'allow',
      grantScope: 'session',
    })
    expect(response.status).toBe(400)
    const body = await readJson<{ error: { message: string } }>(response)
    expect(body.error.message).toContain('grantScope')
  })

  it('别人会话的待审批项不出现在我的 /api/pending 里', async () => {
    const h = await harness()
    const foreign = await h.app.chatStore.createConversation('别人的', '', '', 'other')
    const request = permissionRequest(foreign.id)
    void h.app.broker?.request(request, new AbortController().signal)

    const pending = await readJson<{ approvals: unknown[] }>(await h.fetch('/api/pending'))
    expect(pending.approvals).toHaveLength(0)
  })
})

describe('提问：HTTP 往返', () => {
  const question = {
    request_id: 'q-1' as never,
    session_id: '' as SessionId,
    turn_id: 'turn_1_x' as TurnId,
    tool_call_id: 'call-q' as ToolCallId,
    tool_name: 'ask_user_question',
    questions: [
      {
        question: '用哪个数据库？',
        header: '数据库',
        options: [
          { label: 'postgres', description: '关系型' },
          { label: 'sqlite', description: '嵌入式' },
        ],
      },
    ],
    created_at: new Date().toISOString() as never,
    expires_at: Date.now() + 60_000,
  }

  it('待回答的提问出现在 /api/pending，并可按 requestId 作答', async () => {
    const h = await harness()
    const sessionId = await h.newSession()

    const broker = h.app.userInputBroker
    expect(broker).toBeDefined()
    const request: UserInputRequest = { ...question, session_id: sessionId }
    const waiting = broker?.request(request, new AbortController().signal)

    const pending = await readJson<{ userInputs: { requestId: string; questions: unknown[] }[] }>(
      await h.fetch('/api/pending'),
    )
    expect(pending.userInputs[0]?.requestId).toBe('q-1')
    expect(pending.userInputs[0]?.questions).toHaveLength(1)

    const response = await postJson(h, '/api/user-inputs/q-1', {
      answers: [['postgres']],
    })
    expect(response.status).toBe(200)
    await expect(waiting).resolves.toMatchObject({ answers: [['postgres']] })
  })

  it('answers 为 null 表示放弃作答（等价于超时，turn 继续跑）', async () => {
    const h = await harness()
    const sessionId = await h.newSession()
    const request: UserInputRequest = {
      ...question,
      request_id: 'q-2' as never,
      session_id: sessionId,
    }
    const waiting = h.app.userInputBroker?.request(request, new AbortController().signal)

    const response = await postJson(h, '/api/user-inputs/q-2', { answers: null })
    expect(response.status).toBe(200)
    // 放弃作答**不是拒绝**：answers 为 null 才是它的表达（parts/09 提问语义）
    await expect(waiting).resolves.toMatchObject({ answers: null })
  })

  it('answers 不是数组时 → 400', async () => {
    const h = await harness()
    const response = await postJson(h, '/api/user-inputs/q-3', { answers: 'postgres' })
    expect(response.status).toBe(400)
  })
})

describe('命令：HTTP 往返', () => {
  /** 最小的 `CommandHost` 替身：命令层要什么就给什么，全都不做副作用。 */
  function stubHost(h: WebHarness): CommandHost {
    return {
      localPrincipalId: h.app.localPrincipalId,
      listSessions: () => Promise.resolve([]),
      createSession: () => Promise.resolve({ id: 's-new' as SessionId }),
      sessionExists: () => Promise.resolve(true),
      isBusy: () => false,
      cancelTurn: () => false,
      awaitTurn: () => Promise.resolve(),
      submitTurn: () => Promise.resolve({ turnId: 'turn_1_x' as TurnId }),
      readConfig: () =>
        Promise.resolve({
          providers: [],
          models: [],
          tiers: [],
          settings: {},
          raw: {},
        }),
      updateConfig: () => Promise.resolve(),
      updateModelPreferences: () => Promise.resolve(),
      assignTierModel: () => Promise.resolve(),
      setModelContextWindow: () => Promise.resolve(),
      publish: () => Promise.resolve(),
      getIdempotency: () => Promise.resolve(undefined),
      putIdempotency: () => Promise.resolve(),
      recordCommandResult: () => Promise.resolve(undefined),
      compact: () => Promise.resolve({ ok: true, code: CommandResultCode.OK, text: '已压缩' }),
      now: () => new Date().toISOString(),
    }
  }

  function registry(): CommandRegistry {
    const commands = new CommandRegistry()
    commands.register({
      name: 'echo',
      description: '回显参数',
      parameters: {
        positionals: [
          {
            name: 'text',
            required: true,
            description: '要回显的文本',
            schema: { safeParse: () => ({ success: true }) } as never,
          },
        ],
      },
      interrupt: 'never',
      permission: { kind: 'always' },
      auditEvent: 'command_received',
      idempotency: { kind: 'keyed', ttlMs: 60_000 },
      persistResult: false,
      execute: (ctx) =>
        Promise.resolve({
          ok: true,
          code: CommandResultCode.OK,
          text: `echo: ${typeof ctx.args['text'] === 'string' ? ctx.args['text'] : ''}`,
        }),
    })
    return commands
  }

  async function commandHarness(): Promise<WebHarness> {
    const h = await startHarness({ policy: {} })
    open.push(h)
    return h
  }

  it('命令结果经 HTTP 返回，并被脱敏', async () => {
    const h = await commandHarness()
    // 命令桥是注入的：`CommandHost` 的实现属于组合根，Web 层只是转发。
    const withCommands = await startHarness({
      server: { commands: { registry: registry(), host: stubHost(h) } },
    })
    open.push(withCommands)

    const response = await postJson(withCommands, '/api/commands', { command: '/echo 你好' })
    expect(response.status).toBe(200)
    const body = await readJson<{ ok: boolean; text: string }>(response)
    expect(body.ok).toBe(true)
    expect(body.text).toBe('echo: 你好')
  })

  it('未知命令返回错误码而不是 500', async () => {
    const h = await harness()
    const withCommands = await startHarness({
      server: { commands: { registry: registry(), host: stubHost(h) } },
    })
    open.push(withCommands)

    const response = await postJson(withCommands, '/api/commands', { command: '/nope' })
    expect(response.status).toBe(501)
    expect((await readJson<{ error: { code: string } }>(response)).error.code).toBe(
      ErrorCode.COMMAND_NOT_AVAILABLE,
    )
  })

  it('command 字段缺失 → 400', async () => {
    const h = await harness()
    const withCommands = await startHarness({
      server: { commands: { registry: registry(), host: stubHost(h) } },
    })
    open.push(withCommands)

    const response = await postJson(withCommands, '/api/commands', { command: '   ' })
    expect(response.status).toBe(400)
  })

  it('带 sessionId 时先做归属校验', async () => {
    const h = await harness()
    const withCommands = await startHarness({
      server: { commands: { registry: registry(), host: stubHost(h) } },
    })
    open.push(withCommands)

    const response = await postJson(withCommands, '/api/commands', {
      command: '/echo x',
      sessionId: 'not-mine',
    })
    expect(response.status).toBe(404)
  })
})

describe('内置命令：默认装配的端到端', () => {
  it('⚠️ 不注入任何东西：/workwith 走通命令层并真的跑了一个 turn', async () => {
    // `CommandHostAdapter` 会读 `SecretRef` 判断凭据**是否可用**
    // （只判可用性，不读明文）。这里给环境变量一个值让它通过能力校验。
    const previous = process.env['TEST_KEY']
    process.env['TEST_KEY'] = 'test-value'
    try {
      const h = await harness({ text: '已按指定模型完成' })
      const sessionId = await h.newSession()

      const response = await postJson(h, '/api/commands', {
        command: '/workwith p/m1 接下来做那件事',
        sessionId,
      })

      expect(response.status).toBe(200)
      const body = await readJson<{ ok: boolean; text: string }>(response)
      expect(body.ok).toBe(true)

      // 命令真的提交了 turn：消息历史里有这次任务
      const messages = await readJson<{ messages: { role: string; content: string }[] }>(
        await h.fetch(`/api/sessions/${sessionId}/messages`),
      )
      expect(messages.messages.some((message) => message.content.includes('接下来做那件事'))).toBe(
        true,
      )
    } finally {
      if (previous === undefined) delete process.env['TEST_KEY']
      else process.env['TEST_KEY'] = previous
    }
  })

  it('⚠️ 命令层的 errorCode 被原样透出，语义不同的失败不会塌成同一个响应', async () => {
    const h = await harness()
    const sessionId = await h.newSession()

    const run = async (command: string): Promise<{ status: number; code: string }> => {
      const response = await postJson(h, '/api/commands', { command, sessionId })
      const body = await readJson<{ error: { code: string } }>(response)
      return { status: response.status, code: body.error.code }
    }

    // 引用**格式**就不对（没有 `/`）→ 400 参数问题
    expect(await run('/workwith noslash 做点事')).toEqual({
      status: 400,
      code: ErrorCode.INVALID_COMMAND_ARGUMENTS,
    })

    // 引用合法但模型不存在 → 404。与"参数写错"是不同的两件事：
    // 前者用户改引用就能成功，后者说明这个模型根本不在配置里。
    expect(await run('/workwith p/nope 做点事')).toEqual({
      status: 404,
      code: ErrorCode.MODEL_NOT_FOUND,
    })

    // 凭据不可用 → 502：这是**上游**的问题，不是调用方的凭据不对。
    // 用 401 会把"供应商的 key 失效了"说成"你的登录不对"。
    expect(await run('/workwith p/m1 做点事')).toEqual({
      status: 502,
      code: ErrorCode.PROVIDER_AUTH_FAILED,
    })
  })

  it('⚠️ 模型存在但能力不满足 → 与"参数写错"是不同的码', async () => {
    const previous = process.env['TEST_KEY']
    process.env['TEST_KEY'] = 'test-value'
    try {
      const h = await harness({
        mutateConfig: (doc) => ({
          ...doc,
          // 追加一个"不支持工具调用"的模型。凭据可用时才会走到能力校验，
          // 所以这条必须与上一条分开跑（上一条刻意不设环境变量）。
          model_profiles: [
            ...doc.model_profiles,
            {
              id: 'm2',
              providerId: 'p',
              contextWindow: 8_000,
              maxOutputTokens: 1_024,
              supportsThinking: false,
              supportsTools: false,
              supportsVision: false,
              supports1MContext: false,
              enabled: true,
            },
          ],
        }),
      })
      const sessionId = await h.newSession()

      const response = await postJson(h, '/api/commands', {
        command: '/workwith p/m2 做点事',
        sessionId,
      })
      const body = await readJson<{ error: { code: string } }>(response)

      expect(response.status).toBe(400)
      expect(body.error.code).toBe(ErrorCode.MODEL_CAPABILITY_UNAVAILABLE)
      // 与"引用写错"必须是**不同的码**——对用户是完全不同的两件事，
      // 塌成同一个就等于白填了这个映射。
      expect(body.error.code).not.toBe(ErrorCode.INVALID_COMMAND_ARGUMENTS)
    } finally {
      if (previous === undefined) delete process.env['TEST_KEY']
      else process.env['TEST_KEY'] = previous
    }
  })

  it('Web 与 TUI 共用同一份注册表：/sessions 与 /clear 在浏览器里同样可用', async () => {
    const h = await harness()
    await h.newSession()

    // `/sessions` 返回 selection（UI 需要知道"这是可选项列表"，而不是一段文本）
    const sessions = await readJson<{ ok: boolean; code: string; text: string }>(
      await postJson(h, '/api/commands', { command: '/sessions' }),
    )
    expect(sessions.ok).toBe(true)
    expect(sessions.code).toBe('selection')

    const cleared = await readJson<{ ok: boolean; text: string }>(
      await postJson(h, '/api/commands', { command: '/clear' }),
    )
    expect(cleared.ok).toBe(true)
    expect(cleared.text).toContain('新会话')
  })

  it('诚实降级命令回 NOT_AVAILABLE 并说明原因，不返回假数据', async () => {
    const h = await harness()
    const sessionId = await h.newSession()

    const response = await postJson(h, '/api/commands', { command: '/skills', sessionId })
    expect(response.status).toBe(501)

    const body = await readJson<{ error: { code: string }; text: string; data: unknown }>(response)
    expect(body.error.code).toBe(ErrorCode.COMMAND_NOT_AVAILABLE)
    expect(body.text).toContain('尚未实现')
    // 不谎报成功、也不用空列表假装可用
    expect(body.text).toContain('不产生任何效果')
  })

  it('没有会话时 /workwith 明确拒绝', async () => {
    const h = await harness()
    const response = await postJson(h, '/api/commands', { command: '/workwith p/m1 做点事' })
    expect(response.status).toBe(400)
    const body = await readJson<{ text: string }>(response)
    expect(body.text).toContain('会话')
  })
})

describe('已结束的审批请求', () => {
  it('grantScope: once 用在已结束的请求上 → 409 而不是静默忽略', async () => {
    const h = await harness()
    const sessionId = await h.newSession()
    const request = permissionRequest(sessionId, {
      request_id: 'req-done',
      status: PermissionRequestStatus.PENDING_USER_APPROVAL,
    })
    const waiting = h.app.broker?.request(request, new AbortController().signal)
    await postJson(h, '/api/permissions/req-done', { decision: 'allow' })
    await waiting

    const response = await postJson(h, '/api/permissions/req-done', {
      decision: 'allow',
      grantScope: 'once',
    })
    // 已结束 → 不在待办里 → 无法建立一次性授权。必须明说，否则用户会以为
    // "我勾了仅本次允许"而实际上什么也没建立。
    expect(response.status).toBe(409)
  })
})
