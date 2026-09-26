/**
 * HTTP 集成测试：真 `node:http` + 真 `fetch` + 临时端口。
 *
 * 这里不 mock 任何传输层的东西——鉴权、幂等、Origin、请求体上限、优雅关闭
 * 全都是**协议行为**，用替身测出来的"通过"不能说明浏览器能用。
 */

import { afterEach, describe, expect, it } from 'vitest'

import { ErrorCode } from '../../src/core/errors.js'
import type { SessionId } from '../../src/core/ids.js'
import { ListenScope, AuthMode } from '../../src/clients/web/listen-policy.js'
import { WebServer } from '../../src/clients/web/server.js'
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

describe('健康检查', () => {
  it('不需要凭据，只有三个字段', async () => {
    const h = await harness()
    // 完全不带 Authorization
    const response = await fetch(`${h.baseUrl}/api/health`)
    expect(response.status).toBe(200)

    const body = await readJson<Record<string, unknown>>(response)
    expect(Object.keys(body).sort()).toEqual(['ok', 'uptimeMs', 'version'])
    expect(body['ok']).toBe(true)
  })

  it('不带 Origin 也放行（编排系统的探活不会带它）', async () => {
    const h = await harness()
    const response = await fetch(`${h.baseUrl}/api/health`)
    expect(response.status).toBe(200)
  })
})

describe('鉴权', () => {
  it('本机无 token 模式仍拒绝跨源写操作', async () => {
    const h = await harness({ server: { auth: AuthMode.NONE, token: undefined } })
    expect((await fetch(`${h.baseUrl}/api/projects`)).status).toBe(200)

    const crossOrigin = await fetch(`${h.baseUrl}/api/sessions`, {
      method: 'POST',
      headers: {
        Origin: 'http://evil.example',
        'Content-Type': 'application/json',
        'Idempotency-Key': crypto.randomUUID(),
      },
      body: JSON.stringify({ title: 'x' }),
    })
    expect(crossOrigin.status).toBe(403)
  })

  it('无凭据 → 401 + WWW-Authenticate', async () => {
    const h = await harness()
    const response = await fetch(`${h.baseUrl}/api/sessions`)
    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toBe('Bearer')

    const body = await readJson<{ error: { code: string } }>(response)
    expect(body.error.code).toBe(ErrorCode.WEB_AUTH_FAILED)
  })

  it('错误 token → 401，正确 token → 200', async () => {
    const h = await harness()
    expect(
      (await h.fetch('/api/sessions', { headers: { Authorization: 'Bearer wrong' } })).status,
    ).toBe(401)
    expect((await h.fetch('/api/sessions')).status).toBe(200)
  })

  it('非 Bearer 方案 → 401', async () => {
    const h = await harness()
    const response = await h.fetch('/api/sessions', { headers: { Authorization: 'Basic xyz' } })
    expect(response.status).toBe(401)
  })

  it('⚠️ query string 里的 token 被拒绝——**即使** Bearer 是对的', async () => {
    const h = await harness()
    const response = await h.fetch(`/api/sessions?token=${h.token}`)
    expect(response.status).toBe(401)
    const body = await readJson<{ error: { code: string; message: string } }>(response)
    expect(body.error.code).toBe(ErrorCode.WEB_AUTH_FAILED)
    expect(body.error.message).toContain('query string')
  })

  it('静态资源不需要凭据（浏览器导航无法设置请求头）', async () => {
    const h = await harness()
    expect((await fetch(`${h.baseUrl}/`)).status).toBe(200)
  })

  it('连续认证失败会触发独立的失败限流', async () => {
    const h = await harness({ policy: { authFailuresPerMinute: 2 } })
    const bad = { headers: { Authorization: 'Bearer wrong' } }
    await h.fetch('/api/sessions', bad)
    await h.fetch('/api/sessions', bad)
    const limited = await h.fetch('/api/sessions', bad)
    expect(limited.status).toBe(429)
  })
})

describe('Origin / CSRF', () => {
  it('⚠️ 写操作缺少 Origin → 403', async () => {
    const h = await harness()
    const response = await postJson(h, '/api/sessions', { title: 'x' }, { origin: null })
    expect(response.status).toBe(403)
    const body = await readJson<{ error: { code: string } }>(response)
    expect(body.error.code).toBe(ErrorCode.WEB_ORIGIN_REJECTED)
  })

  it('写操作带非法 Origin → 403', async () => {
    const h = await harness()
    const response = await postJson(
      h,
      '/api/sessions',
      { title: 'x' },
      { origin: 'http://evil.example' },
    )
    expect(response.status).toBe(403)
  })

  it('读取带回非法 Origin 同样拒绝（不只是写操作）', async () => {
    const h = await harness()
    const response = await h.fetch('/api/sessions', { headers: { Origin: 'http://evil.example' } })
    expect(response.status).toBe(403)
  })

  it('合法 Origin 放行并回显具体来源（不是 *）', async () => {
    const h = await harness()
    const response = await postJson(h, '/api/sessions', { title: 'x' })
    expect(response.status).toBe(201)
    expect(response.headers.get('access-control-allow-origin')).toBe(h.baseUrl)
    expect(response.headers.get('access-control-allow-origin')).not.toBe('*')
  })

  it('preflight 返回允许的方法与头（含 Idempotency-Key）', async () => {
    const h = await harness()
    const response = await fetch(`${h.baseUrl}/api/sessions`, {
      method: 'OPTIONS',
      headers: { Origin: h.baseUrl, 'Access-Control-Request-Method': 'POST' },
    })
    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-headers')).toContain('Idempotency-Key')
    expect(response.headers.get('access-control-allow-methods')).toContain('POST')
  })
})

describe('幂等', () => {
  it('⚠️ 写操作缺 Idempotency-Key → 400', async () => {
    const h = await harness()
    const response = await fetch(`${h.baseUrl}/api/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${h.token}`,
        Origin: h.baseUrl,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title: 'x' }),
    })
    expect(response.status).toBe(400)
    const body = await readJson<{ error: { message: string } }>(response)
    expect(body.error.message).toContain('Idempotency-Key')
  })

  it('同 key 同内容 → 回放，且带 Idempotent-Replay 头', async () => {
    const h = await harness()
    const key = 'replay-key'
    const first = await postJson(h, '/api/sessions', { title: '会话 A' }, { idempotencyKey: key })
    const firstBody = await readJson<{ sessionId: string }>(first)
    expect(first.status).toBe(201)

    const second = await postJson(h, '/api/sessions', { title: '会话 A' }, { idempotencyKey: key })
    expect(second.status).toBe(200)
    expect(second.headers.get('idempotent-replay')).toBe('true')
    expect((await readJson<{ sessionId: string }>(second)).sessionId).toBe(firstBody.sessionId)
  })

  it('⚠️ 同 key 异内容 → 409（而不是悄悄执行第二遍）', async () => {
    const h = await harness()
    const key = 'conflict-key'
    await postJson(h, '/api/sessions', { title: 'A' }, { idempotencyKey: key })
    const second = await postJson(h, '/api/sessions', { title: 'B' }, { idempotencyKey: key })
    expect(second.status).toBe(409)
  })

  it('turn 提交：同 key 重放不重跑', async () => {
    const h = await harness({ text: '结果' })
    const sessionId = await h.newSession()
    const key = 'turn-key'

    const first = await postJson(
      h,
      `/api/sessions/${sessionId}/turns`,
      { prompt: '你好' },
      { idempotencyKey: key },
    )
    expect(first.status).toBe(200)
    const firstBody = await readJson<{ turnId: string; state: string }>(first)
    expect(firstBody.state).toBe('done')

    const second = await postJson(
      h,
      `/api/sessions/${sessionId}/turns`,
      { prompt: '你好' },
      { idempotencyKey: key },
    )
    expect(second.status).toBe(200)
    expect(second.headers.get('idempotent-replay')).toBe('true')
    expect((await readJson<{ turnId: string }>(second)).turnId).toBe(firstBody.turnId)
  })
})

describe('turn 提交与并发', () => {
  it('提交后返回 turnId 与结果', async () => {
    const h = await harness({ text: '你好呀' })
    const sessionId = await h.newSession()

    const response = await postJson(h, `/api/sessions/${sessionId}/turns`, { prompt: '打招呼' })
    expect(response.status).toBe(200)

    const body = await readJson<{
      requestId: string
      sessionId: string
      turnId: string
      result: { status: string; finalText: string }
    }>(response)
    expect(body.sessionId).toBe(sessionId)
    expect(body.turnId).toMatch(/^turn_1_/)
    expect(body.result.status).toBe('completed')
    expect(body.result.finalText).toBe('你好呀')
  })

  it('⚠️ 同会话第二个 turn → 409 SESSION_BUSY', async () => {
    const h = await harness({ hang: true })
    const sessionId = await h.newSession()

    // 第一个请求会挂住（provider 不会自己结束），于是第二个必然撞上忙碌。
    const first = postJson(h, `/api/sessions/${sessionId}/turns`, { prompt: '第一个' })
    await waitFor(() => h.app.isBusy(sessionId))

    const second = await postJson(h, `/api/sessions/${sessionId}/turns`, { prompt: '第二个' })
    expect(second.status).toBe(409)
    const body = await readJson<{ error: { code: string } }>(second)
    expect(body.error.code).toBe(ErrorCode.SESSION_BUSY)

    // 收尾：取消掉挂着的那个
    // 竞态已在 `AgentApplication.submitTurn` 修好（controller 与 in-flight
    // 现在和占位在同一个同步段登记）。这里直接断言「一次就成功」——
    // 它同时是那条修复的回归测试：退回轮询会把竞态重新藏起来。
    expect(h.app.cancelTurn(sessionId, 'test')).toBe(true)
    await first
  })

  it('并发同 key：第二个拿到 202 running 而不是再跑一次', async () => {
    const h = await harness({ hang: true })
    const sessionId = await h.newSession()
    const key = 'concurrent-key'

    const first = postJson(
      h,
      `/api/sessions/${sessionId}/turns`,
      { prompt: '同一个' },
      { idempotencyKey: key },
    )
    await waitFor(() => h.app.isBusy(sessionId))

    const second = await postJson(
      h,
      `/api/sessions/${sessionId}/turns`,
      { prompt: '同一个' },
      { idempotencyKey: key },
    )
    expect(second.status).toBe(202)
    expect((await readJson<{ state: string }>(second)).state).toBe('running')

    // 竞态已在 `AgentApplication.submitTurn` 修好（controller 与 in-flight
    // 现在和占位在同一个同步段登记）。这里直接断言「一次就成功」——
    // 它同时是那条修复的回归测试：退回轮询会把竞态重新藏起来。
    expect(h.app.cancelTurn(sessionId, 'test')).toBe(true)
    await first
  })

  it('⚠️ 提交失败时占位记录被清掉，重试可以真正重跑', async () => {
    const h = await harness({ hang: true })
    const sessionId = await h.newSession()
    const key = 'retry-key'

    // 先让会话忙起来——SESSION_BUSY 是"提交失败"里最常见的一种。
    // 若那时仍把 {state:running} 留在幂等表里，后续重试会永远回放
    // 那个占位（客户端表现为"刷新了还是提示会话忙"）。
    const blocking = h.app.submitTurn({
      principalId: h.app.localPrincipalId,
      sessionId,
      prompt: '占住会话',
    })
    await waitFor(() => h.app.isBusy(sessionId))

    const busy = await postJson(
      h,
      `/api/sessions/${sessionId}/turns`,
      { prompt: '被挤掉的那个' },
      { idempotencyKey: key },
    )
    expect(busy.status).toBe(409)
    expect((await readJson<{ error: { code: string } }>(busy)).error.code).toBe(
      ErrorCode.SESSION_BUSY,
    )

    // 竞态已在 `AgentApplication.submitTurn` 修好（controller 与 in-flight
    // 现在和占位在同一个同步段登记）。这里直接断言「一次就成功」——
    // 它同时是那条修复的回归测试：退回轮询会把竞态重新藏起来。
    expect(h.app.cancelTurn(sessionId, 'test')).toBe(true)
    await blocking
    await waitFor(() => !h.app.isBusy(sessionId))

    const retry = postJson(
      h,
      `/api/sessions/${sessionId}/turns`,
      { prompt: '被挤掉的那个' },
      { idempotencyKey: key },
    )
    await waitFor(() => h.app.isBusy(sessionId))
    expect(h.app.isBusy(sessionId)).toBe(true)
    // 竞态已在 `AgentApplication.submitTurn` 修好（controller 与 in-flight
    // 现在和占位在同一个同步段登记）。这里直接断言「一次就成功」——
    // 它同时是那条修复的回归测试：退回轮询会把竞态重新藏起来。
    expect(h.app.cancelTurn(sessionId, 'test')).toBe(true)
    await retry
  })

  it('取消是正常的终态：同 key 重放返回已取消的结果，而不是重跑', async () => {
    const h = await harness({ hang: true })
    const sessionId = await h.newSession()
    const key = 'cancel-key'

    const first = postJson(
      h,
      `/api/sessions/${sessionId}/turns`,
      { prompt: '要取消的' },
      { idempotencyKey: key },
    )
    await waitFor(() => h.app.isBusy(sessionId))
    // 竞态已在 `AgentApplication.submitTurn` 修好（controller 与 in-flight
    // 现在和占位在同一个同步段登记）。这里直接断言「一次就成功」——
    // 它同时是那条修复的回归测试：退回轮询会把竞态重新藏起来。
    expect(h.app.cancelTurn(sessionId, 'test')).toBe(true)
    const firstBody = await readJson<{ state: string; result: { cancelled: boolean } }>(await first)
    expect(firstBody.state).toBe('done')
    expect(firstBody.result.cancelled).toBe(true)

    // 取消不是"失败"——它是 turn 的合法终态，重放它才是正确的幂等语义。
    const replay = await postJson(
      h,
      `/api/sessions/${sessionId}/turns`,
      { prompt: '要取消的' },
      { idempotencyKey: key },
    )
    expect(replay.status).toBe(200)
    expect(replay.headers.get('idempotent-replay')).toBe('true')
    expect((await readJson<{ result: { cancelled: boolean } }>(replay)).result.cancelled).toBe(true)
  })

  it('prompt 为空 → 400', async () => {
    const h = await harness()
    const sessionId = await h.newSession()
    const response = await postJson(h, `/api/sessions/${sessionId}/turns`, { prompt: '   ' })
    expect(response.status).toBe(400)
  })

  it('不存在的会话 → 404 SESSION_NOT_FOUND（不是 PERMISSION_DENIED）', async () => {
    const h = await harness()
    const response = await postJson(h, '/api/sessions/does-not-exist/turns', { prompt: 'x' })
    expect(response.status).toBe(404)
    const body = await readJson<{ error: { code: string } }>(response)
    expect(body.error.code).toBe(ErrorCode.SESSION_NOT_FOUND)
  })

  it('⚠️ 别人 principal 的会话同样返回 SESSION_NOT_FOUND（不泄露会话是否存在）', async () => {
    const h = await harness()
    // 直接造一个属于别的 principal 的会话
    const foreign = await h.app.chatStore.createConversation('别人的', '', '', 'other')

    const messages = await h.fetch(`/api/sessions/${foreign.id}/messages`)
    expect(messages.status).toBe(404)
    expect((await readJson<{ error: { code: string } }>(messages)).error.code).toBe(
      ErrorCode.SESSION_NOT_FOUND,
    )

    const turns = await postJson(h, `/api/sessions/${foreign.id}/turns`, { prompt: 'x' })
    expect(turns.status).toBe(404)
  })
})

describe('取消', () => {
  it('按 turnId 取消挂起的 turn', async () => {
    const h = await harness({ hang: true })
    const sessionId = await h.newSession()

    const submit = postJson(h, `/api/sessions/${sessionId}/turns`, { prompt: '跑很久' })
    await waitFor(() => h.app.isBusy(sessionId))

    const cancel = await postJson(h, '/api/turns/turn_1_x/cancel', { sessionId })
    expect(cancel.status).toBe(200)
    expect((await readJson<{ cancelled: boolean }>(cancel)).cancelled).toBe(true)

    await submit
  })

  it('未知 turnId → 404', async () => {
    const h = await harness()
    const response = await postJson(h, '/api/turns/turn_9_zzz/cancel', {})
    expect(response.status).toBe(404)
  })

  it('⚠️ 只给 turnId（不给 sessionId）也能取消——靠 currentTurnId 反查', async () => {
    const h = await harness({ hang: true })
    const sessionId = await h.newSession()

    const submit = postJson(h, `/api/sessions/${sessionId}/turns`, { prompt: '跑很久' })
    await waitFor(() => h.app.isBusy(sessionId))

    // runtime 生成的 turnId 在请求时不可知，所以从活跃 turn 里读出来
    const turnId = await waitForTurnId(h, sessionId)

    const cancel = await postJson(h, `/api/turns/${turnId}/cancel`, {})
    expect(cancel.status).toBe(200)
    const body = await readJson<{ cancelled: boolean; sessionId: string }>(cancel)
    expect(body.cancelled).toBe(true)
    expect(body.sessionId).toBe(sessionId)

    await submit
  })
})

describe('会话与消息', () => {
  it('列表只返回本 principal 的会话', async () => {
    const h = await harness()
    await h.newSession()
    await h.app.chatStore.createConversation('别人的', '', '', 'other')

    const body = await readJson<{ sessions: { title: string }[] }>(await h.fetch('/api/sessions'))
    for (const session of body.sessions) expect(session.title).not.toBe('别人的')
  })

  it('消息接口返回 transcript', async () => {
    const h = await harness({ text: '回答' })
    const sessionId = await h.newSession()
    await postJson(h, `/api/sessions/${sessionId}/turns`, { prompt: '提问' })

    const body = await readJson<{ messages: { role: string; content: string }[] }>(
      await h.fetch(`/api/sessions/${sessionId}/messages`),
    )
    expect(body.messages.length).toBeGreaterThan(0)
    expect(body.messages.some((message) => message.role === 'user')).toBe(true)
  })

  it('配置接口不泄露假密钥', async () => {
    const secret = 'sk-ant-LEAKME0123456789abcdef'
    const h = await harness({
      mutateConfig: (doc) => ({
        ...doc,
        llm_channels: [{ api_key: secret }],
        app_settings: { ...doc.app_settings, api_key: secret },
      }),
    })
    const text = await (await h.fetch('/api/config')).text()
    expect(text).not.toContain(secret)
    expect(text).not.toContain('api_key')
  })
})

describe('未实现的接口明确报错', () => {
  it('SSE 返回 501，而不是一个永远空的事件流', async () => {
    const h = await harness()
    const response = await h.fetch('/api/events')
    expect(response.status).toBe(501)
    expect((await readJson<{ error: { code: string } }>(response)).error.code).toBe(
      ErrorCode.COMMAND_NOT_AVAILABLE,
    )
  })

  it('未知命令由**命令层**回答 501（而不是基础设施没接上）', async () => {
    const h = await harness()
    const response = await postJson(h, '/api/commands', { command: '/definitely-not-a-command' })
    expect(response.status).toBe(501)
    expect((await readJson<{ error: { code: string } }>(response)).error.code).toBe(
      ErrorCode.COMMAND_NOT_AVAILABLE,
    )
  })

  it('⚠️ 命令宿主是自动装配的：不注入任何东西也能跑到命令层', async () => {
    const h = await harness()
    // `/workwith` 是内置命令。不给参数 → 命令层的参数校验失败（400），
    // 这说明请求真的走到了 `CommandRegistry`，而不是在传输层被挡下。
    const response = await postJson(h, '/api/commands', { command: '/workwith' })
    expect(response.status).toBe(400)

    const body = await readJson<{ error: { code: string }; text: string }>(response)
    expect(body.error.code).toBe(ErrorCode.INVALID_COMMAND_ARGUMENTS)
    // 消息来自 `/workwith` 自己的参数校验（`缺少参数：ref`），
    // 而不是传输层的任何兜底文案——这正是"请求真的到了命令层"的证据。
    expect(body.text).toContain('缺少参数')
  })

  it('未知 API 路径 → 404', async () => {
    const h = await harness()
    expect((await h.fetch('/api/nope')).status).toBe(404)
  })

  it('未知审批 requestId → 404（不泄露它是否存在过）', async () => {
    const h = await harness()
    const response = await postJson(h, '/api/permissions/unknown-id', { decision: 'allow' })
    expect(response.status).toBe(404)
  })

  it('非法 decision → 400', async () => {
    const h = await harness()
    const response = await postJson(h, '/api/permissions/x', { decision: 'maybe' })
    expect(response.status).toBe(400)
  })
})

describe('请求体上限', () => {
  it('⚠️ 超限 → 413，且响应真的发得出去', async () => {
    const h = await harness({ policy: { httpBodyLimitBytes: 512 } })
    const sessionId = await h.newSession()

    const response = await postJson(h, `/api/sessions/${sessionId}/turns`, {
      prompt: 'x'.repeat(4096),
    })
    // 关键点：`req.destroy()` 早于响应写出的话，客户端只会看到一个连接被重置。
    expect(response.status).toBe(413)
    const body = await readJson<{ error: { code: string } }>(response)
    expect(body.error.code).toBe(ErrorCode.WEB_PAYLOAD_TOO_LARGE)
  })

  it('未超限的请求正常处理', async () => {
    const h = await harness({ policy: { httpBodyLimitBytes: 4096 } })
    const response = await postJson(h, '/api/sessions', { title: 'x'.repeat(100) })
    expect(response.status).toBe(201)
  })
})

describe('静态资源', () => {
  it('GET / 返回 index.html，带 CSP', async () => {
    const h = await harness()
    const response = await fetch(`${h.baseUrl}/`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'")
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('x-frame-options')).toBe('DENY')
  })

  it('⚠️ index.html 没有内联 script / style（否则 CSP 会拦掉）', async () => {
    const h = await harness()
    const html = await (await fetch(`${h.baseUrl}/`)).text()
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/i)
    expect(html).not.toMatch(/<style[\s>]/i)
    expect(html).not.toMatch(/\sstyle="/i)
    expect(html).toContain('src="/app.js"')
  })

  it('app.js 与 styles.css 可服务，且 API 才有 no-store', async () => {
    const h = await harness()

    const script = await fetch(`${h.baseUrl}/app.js`)
    expect(script.status).toBe(200)
    expect(script.headers.get('content-type')).toContain('javascript')

    const css = await fetch(`${h.baseUrl}/styles.css`)
    expect(css.status).toBe(200)
    expect(css.headers.get('content-type')).toContain('text/css')
    expect(css.headers.get('cache-control')).toBe('no-cache')

    const markdownParser = await fetch(`${h.baseUrl}/vendor/marked.js`)
    expect(markdownParser.status).toBe(200)
    expect(markdownParser.headers.get('content-type')).toContain('javascript')
    expect(await markdownParser.text()).toContain('marked')

    const api = await h.fetch('/api/sessions')
    expect(api.headers.get('cache-control')).toBe('no-store')
  })

  it('app.js 不写内联样式（CSP 没有 unsafe-inline）', async () => {
    const h = await harness()
    const source = await (await fetch(`${h.baseUrl}/app.js`)).text()
    expect(source).not.toMatch(/\.style\.[a-zA-Z]/)
    expect(source).not.toMatch(/setAttribute\(\s*['"]style['"]/)
  })

  it('⚠️ 路径穿越被挡住', async () => {
    const h = await harness()
    for (const path of [
      '/../package.json',
      '/..%2fpackage.json',
      '/%2e%2e/package.json',
      '/static/../../package.json',
    ]) {
      const response = await fetch(`${h.baseUrl}${path}`)
      expect([400, 404]).toContain(response.status)
      const text = await response.text()
      expect(text).not.toContain('"name": "deepcode"')
    }
  })

  it('不存在的静态文件 → 404', async () => {
    const h = await harness()
    expect((await fetch(`${h.baseUrl}/nope.js`)).status).toBe(404)
  })

  it('项目、对话、命令和设置路由可直接打开，未知路由仍返回 404', async () => {
    const h = await harness()
    const projectId = 'a'.repeat(24)
    for (const path of [
      '/projects',
      `/projects/${projectId}`,
      `/projects/${projectId}/chats/123e4567-e89b-12d3-a456-426614174000`,
      '/commands',
      '/settings',
    ]) {
      const response = await fetch(`${h.baseUrl}${path}`)
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('text/html')
      expect(await response.text()).toContain('id="app"')
    }
    expect((await fetch(`${h.baseUrl}/projects/not-an-id`)).status).toBe(404)
    expect((await fetch(`${h.baseUrl}/projects/${projectId}/unknown`)).status).toBe(404)
  })

  it('HEAD 只回头不带体', async () => {
    const h = await harness()
    const response = await fetch(`${h.baseUrl}/index.html`, { method: 'HEAD' })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-length')).toBeTruthy()
    expect(await response.text()).toBe('')
  })

  it('非法百分号编码 → 400（不退回原始串解析）', async () => {
    const h = await harness()
    const response = await fetch(`${h.baseUrl}/%zz`)
    expect(response.status).toBe(400)
  })

  it('静态资源上的写方法 → 405', async () => {
    const h = await harness()
    const response = await fetch(`${h.baseUrl}/app.js`, { method: 'POST' })
    expect(response.status).toBe(405)
  })
})

describe('限流', () => {
  it('超限 → 429 + Retry-After', async () => {
    const h = await harness({ policy: { httpBurst: 2, httpRequestsPerMinute: 1 } })
    await h.fetch('/api/sessions')
    await h.fetch('/api/sessions')
    const limited = await h.fetch('/api/sessions')
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBeTruthy()
  })

  it('健康检查不受限流影响', async () => {
    const h = await harness({ policy: { httpBurst: 1, httpRequestsPerMinute: 0 } })
    await h.fetch('/api/sessions').catch(() => undefined)
    expect((await fetch(`${h.baseUrl}/api/health`)).status).toBe(200)
    expect((await fetch(`${h.baseUrl}/api/health`)).status).toBe(200)
  })
})

describe('启动失败不降级', () => {
  it('public + auth none 被拒绝', async () => {
    const { app } = await harness()
    const started = await WebServer.start({
      app,
      listen: ListenScope.PUBLIC,
      auth: AuthMode.NONE,
      port: 0,
      portExplicit: true,
      disposeApplication: false,
    })
    expect(started.ok).toBe(false)
    if (started.ok) return
    expect(started.code).toBe(ErrorCode.WEB_AUTH_FAILED)
  })

  it('--cors * 被拒绝', async () => {
    const { app } = await harness()
    const started = await WebServer.start({
      app,
      host: '127.0.0.1',
      port: 0,
      portExplicit: true,
      cors: '*',
      disposeApplication: false,
    })
    expect(started.ok).toBe(false)
    if (started.ok) return
    expect(started.code).toBe(ErrorCode.WEB_ORIGIN_REJECTED)
  })

  it('--auth password 未实现时明确失败，而不是当成 token', async () => {
    const { app } = await harness()
    const started = await WebServer.start({
      app,
      host: '127.0.0.1',
      port: 0,
      portExplicit: true,
      auth: AuthMode.PASSWORD,
      disposeApplication: false,
    })
    expect(started.ok).toBe(false)
    if (started.ok) return
    expect(started.reason).toContain('password')
  })

  it('端口被占用时启动失败并说明原因', async () => {
    const h = await harness()
    const { app } = await harness()
    const started = await WebServer.start({
      app,
      host: '127.0.0.1',
      port: h.server.port,
      portExplicit: true,
      disposeApplication: false,
    })
    expect(started.ok).toBe(false)
    if (started.ok) return
    expect(started.reason).toContain('监听失败')
  })

  it('未显式传入的 --port 0 被拒绝', async () => {
    const { app } = await harness()
    const started = await WebServer.start({
      app,
      host: '127.0.0.1',
      port: 0,
      disposeApplication: false,
    })
    expect(started.ok).toBe(false)
  })

  it('启动提示里包含 token（用户只有这一次机会拿到它）', async () => {
    const h = await harness()
    expect(h.logger.all().join('\n')).toContain(h.token)
  })
})

describe('优雅关闭', () => {
  it('⚠️ 拒绝新请求 → 取消活动 turn → 有界等待 → flush', async () => {
    const h = await harness({ hang: true, policy: { shutdownGraceMs: 5_000 } })
    const sessionId = await h.newSession()

    const submit = postJson(h, `/api/sessions/${sessionId}/turns`, { prompt: '跑很久' })
    await waitFor(() => h.app.isBusy(sessionId))

    // 关闭开始后，新请求必须被 503 挡住，且连接会被关闭。
    const closing = h.server.close()
    const refused = await fetch(`${h.baseUrl}/api/health`).catch(() => undefined)
    expect(refused?.status).toBe(503)
    expect(refused?.headers.get('connection')).toBe('close')

    const report = await closing
    expect(report.cancelledTurns).toBe(1)
    expect(report.refusedRequests).toBeGreaterThan(0)
    expect(report.turnsTimedOut).toBe(false)
    expect(report.flushTimedOut).toBe(false)

    // 被取消的 turn 应当以 cancelled 结束，而不是永远挂着。
    const response = await submit
    const body = await readJson<{ result: { status: string; cancelled: boolean } }>(response)
    expect(body.result.cancelled).toBe(true)
  })

  it('重复 close 返回同一个报告（幂等）', async () => {
    const h = await harness()
    const first = await h.server.close()
    const second = await h.server.close()
    expect(second).toEqual(first)
  })

  it('关闭后端口不再接受连接', async () => {
    const h = await harness()
    const baseUrl = h.baseUrl
    await h.server.close()
    await expect(fetch(`${baseUrl}/api/health`)).rejects.toThrow()
  })
})

/**
 * 等待某会话出现活跃 turn，并把它的 turnId 取出来。
 *
 * turn ID 由 runtime 在 `beginTurn` 时生成，提交请求里给不出来——这也正是
 * `POST /api/turns/:id/cancel` 必须支持"只给 turnId"的原因。
 */
async function waitForTurnId(h: WebHarness, sessionId: SessionId): Promise<string> {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    const active = await h.app.currentTurnId(sessionId)
    if (active !== undefined) return active
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('等不到活跃 turn')
}

/** 轮询等待某个条件成立。用它替代 sleep，避免 flaky 的固定等待。 */
async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('等待超时')
}
