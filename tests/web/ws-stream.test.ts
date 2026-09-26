/**
 * WebSocket 事件流：真 `ws` 客户端 + 真服务器。
 *
 * 这里要验证的是 `parts/09` §1.1 那句最容易写错的要求：
 * 「WebSocket 重连必须支持 `lastEventId`，服务器从持久化事件日志补发，
 * **不能只依赖内存队列**」，且「断线重连不会丢失或重复 turn」。
 *
 * "不丢"与"不重"必须同时断言——只测其中一条的实现通常会把另一条弄坏。
 */

import { afterEach, describe, expect, it } from 'vitest'

import { WebSocket } from 'ws'

import { ErrorCode } from '../../src/core/errors.js'
import { AuthMode } from '../../src/clients/web/listen-policy.js'
import { postJson, startHarness, type WebHarness } from './harness.js'

const open: WebHarness[] = []
const sockets: WebSocket[] = []

async function harness(options: Parameters<typeof startHarness>[0] = {}): Promise<WebHarness> {
  const created = await startHarness(options)
  open.push(created)
  return created
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close()
  await Promise.all(open.splice(0).map((item) => item.close()))
})

interface Frame {
  readonly type: string
  readonly [key: string]: unknown
}

/** 一个把收到的帧累计下来的测试客户端。 */
class Client {
  readonly frames: Frame[] = []
  readonly socket: WebSocket
  #closed = false
  #error: Error | undefined

  constructor(socket: WebSocket) {
    this.socket = socket
    sockets.push(socket)
    socket.on('message', (data: Buffer) => {
      try {
        this.frames.push(JSON.parse(data.toString('utf8')) as Frame)
      } catch {
        /* 非 JSON 帧：本协议不发这种，忽略即可 */
      }
    })
    socket.on('close', () => {
      this.#closed = true
    })
    // 必须接住 `error`：一是 `ws` 的 error 事件没人处理会直接抛出，
    // 二是握手失败的原因（401/403/503）只在这条通道上，丢了就只能看到超时。
    socket.on('error', (error: Error) => {
      this.#error = error
    })
  }

  get closed(): boolean {
    return this.#closed
  }

  send(frame: unknown): void {
    this.socket.send(JSON.stringify(frame))
  }

  /** 等待某个条件成立。用它替代固定 sleep。 */
  async waitFor(predicate: () => boolean, timeoutMs = 2_500): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (predicate()) return
      if (this.#error !== undefined) throw this.#error
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    const seen = this.frames.map((frame) => frame.type).join(', ')
    throw new Error(
      `等待超时；已收到帧：${seen === '' ? '(无)' : seen}` +
        (this.#error === undefined ? '' : `；socket 错误：${this.#error.message}`),
    )
  }

  /** 事件帧里的运行时事件。 */
  get events(): Frame[] {
    return this.frames
      .filter((frame) => frame.type === 'event')
      .map((frame) => frame['event'] as Frame)
  }

  eventIds(): string[] {
    return this.events.map((event) => String(event['eventId']))
  }

  types(): string[] {
    return this.events.map((event) => String(event['type']))
  }

  close(): void {
    this.socket.close()
  }
}

/** 轮询等待某个条件成立。用它替代固定 sleep，避免 flaky。 */
async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('等待超时')
}

/** 建立一条已就绪的连接（收到 `ready`）。 */
async function connect(
  h: WebHarness,
  options: {
    readonly sessionId?: string
    readonly lastEventId?: string
    readonly ticket?: string
    readonly origin?: string | null
    readonly headers?: Record<string, string>
  } = {},
): Promise<Client> {
  let ticket = options.ticket
  if (ticket === undefined) {
    const issued = await postJson(h, '/api/ws-ticket', {})
    ticket = ((await issued.json()) as { ticket: string }).ticket
  }

  const params = new URLSearchParams({ ticket })
  const url = `ws://127.0.0.1:${String(h.server.port)}/api/stream?${params.toString()}`
  const headers: Record<string, string> = { ...options.headers }
  if (options.origin !== null) headers['Origin'] = options.origin ?? h.baseUrl

  const socket = new WebSocket(url, { headers })
  const client = new Client(socket)
  await client.waitFor(() => client.frames.some((frame) => frame.type === 'ready'))

  // `ready` 只表示握手完成。订阅必须由客户端显式发起——协议刻意把这两步
  // 分开，好让同一个 socket 在 `resync_required` 之后重新订阅。
  if (options.sessionId !== undefined) {
    client.send({
      type: 'subscribe',
      sessionId: options.sessionId,
      ...(options.lastEventId === undefined ? {} : { lastEventId: options.lastEventId }),
    })
  }
  return client
}

describe('握手与鉴权', () => {
  it('本机无 token 模式可直接建立 WebSocket', async () => {
    const h = await harness({ server: { auth: AuthMode.NONE, token: undefined } })
    const socket = new WebSocket(`ws://127.0.0.1:${String(h.server.port)}/api/stream`, {
      headers: { Origin: h.baseUrl },
    })
    const client = new Client(socket)
    await client.waitFor(() => client.frames.some((frame) => frame.type === 'ready'))
  })

  it('ticket 认证通过并收到 ready', async () => {
    const h = await harness()
    const client = await connect(h)
    expect(client.frames[0]?.type).toBe('ready')
  })

  it('⚠️ 缺少 Origin 直接拒绝握手', async () => {
    const h = await harness()
    const issued = await postJson(h, '/api/ws-ticket', {})
    const ticket = ((await issued.json()) as { ticket: string }).ticket

    const socket = new WebSocket(
      `ws://127.0.0.1:${String(h.server.port)}/api/stream?ticket=${ticket}`,
      { headers: {} },
    )
    sockets.push(socket)
    const error = await new Promise<Error>((resolve) => {
      socket.on('error', resolve)
    })
    // 握手阶段被拒：`ws` 客户端只能看到 "Unexpected server response: 403"
    expect(error.message).toContain('403')
  })

  it('⚠️ query 里的 token 被拒绝（ticket 才是唯一允许的凭据）', async () => {
    const h = await harness()
    const socket = new WebSocket(
      `ws://127.0.0.1:${String(h.server.port)}/api/stream?token=${h.token}`,
      { headers: { Origin: h.baseUrl } },
    )
    sockets.push(socket)
    const error = await new Promise<Error>((resolve) => {
      socket.on('error', resolve)
    })
    expect(error.message).toContain('401')
  })

  it('无效 ticket 被拒绝', async () => {
    const h = await harness()
    const socket = new WebSocket(
      `ws://127.0.0.1:${String(h.server.port)}/api/stream?ticket=never-issued`,
      { headers: { Origin: h.baseUrl } },
    )
    sockets.push(socket)
    const error = await new Promise<Error>((resolve) => {
      socket.on('error', resolve)
    })
    expect(error.message).toContain('401')
  })

  it('ticket 绑定 Origin：换来源被拒', async () => {
    const h = await harness()
    const issued = await postJson(h, '/api/ws-ticket', {})
    const ticket = ((await issued.json()) as { ticket: string }).ticket

    const socket = new WebSocket(
      `ws://127.0.0.1:${String(h.server.port)}/api/stream?ticket=${ticket}`,
      { headers: { Origin: 'http://evil.example' } },
    )
    sockets.push(socket)
    const error = await new Promise<Error>((resolve) => {
      socket.on('error', resolve)
    })
    // 来源不在白名单里，握手阶段就被 403 挡下
    expect(error.message).toContain('403')
  })

  it('Bearer 头的方式也可用（脚本客户端）', async () => {
    const h = await harness()
    const socket = new WebSocket(`ws://127.0.0.1:${String(h.server.port)}/api/stream`, {
      headers: { Origin: h.baseUrl, Authorization: `Bearer ${h.token}` },
    })
    const client = new Client(socket)
    await client.waitFor(() => client.frames.some((frame) => frame.type === 'ready'))
  })

  it('关闭中拒绝新的升级请求', async () => {
    const h = await harness()
    // ticket 必须**在关闭前**拿到：关闭后连 `POST /api/ws-ticket` 都会 503。
    const issued = await postJson(h, '/api/ws-ticket', {})
    const ticket = ((await issued.json()) as { ticket: string }).ticket

    const closing = h.server.close()
    await expect(connect(h, { ticket })).rejects.toThrow()
    await closing
  })
})

describe('订阅与事件投递', () => {
  it('订阅后收到 subscribed 与 replay_complete', async () => {
    const h = await harness()
    const sessionId = await h.newSession()
    const client = await connect(h, { sessionId })

    await client.waitFor(() => client.frames.some((frame) => frame.type === 'replay_complete'))
    expect(client.frames.some((frame) => frame.type === 'subscribed')).toBe(true)
  })

  it('type 为 sessionId 的消息要带 sessionId，缺了则报错', async () => {
    const h = await harness()
    const client = await connect(h)
    client.send({ type: 'subscribe' })
    await client.waitFor(() => client.frames.some((frame) => frame.type === 'error'))
  })

  it('未知控制帧回 error 而不是静默忽略', async () => {
    const h = await harness()
    const client = await connect(h)
    client.send({ type: 'nonsense' })
    await client.waitFor(() => client.frames.some((frame) => frame.type === 'error'))
  })

  it('非法 JSON 回 error', async () => {
    const h = await harness()
    const client = await connect(h)
    client.socket.send('{ not json')
    await client.waitFor(() => client.frames.some((frame) => frame.type === 'error'))
  })

  it('ping → pong', async () => {
    const h = await harness()
    const client = await connect(h)
    client.send({ type: 'ping' })
    await client.waitFor(() => client.frames.some((frame) => frame.type === 'pong'))
  })

  it('unsubscribe 之后不再收到事件（但连接保持）', async () => {
    const h = await harness({ text: '回答' })
    const sessionId = await h.newSession()
    const client = await connect(h, { sessionId })
    await client.waitFor(() => client.frames.some((frame) => frame.type === 'replay_complete'))

    await postJson(h, `/api/sessions/${sessionId}/turns`, { prompt: '第一次' })
    await client.waitFor(() => client.types().includes('turn_end'))
    const countAfterFirst = client.events.length

    client.send({ type: 'unsubscribe' })
    // 退订在服务端是排到该会话串行链上的异步动作；用一次往返把它排空。
    await h.fetch('/api/health')
    await postJson(h, `/api/sessions/${sessionId}/turns`, { prompt: '第二次' })
    await new Promise((resolve) => setTimeout(resolve, 150))

    expect(client.events.length).toBe(countAfterFirst)
    expect(client.closed).toBe(false)
  })

  it('重新订阅会退掉旧订阅，事件不会发两遍', async () => {
    const h = await harness({ text: '回答' })
    const sessionId = await h.newSession()
    const client = await connect(h, { sessionId })
    await client.waitFor(() => client.frames.some((frame) => frame.type === 'replay_complete'))

    // 同一条 socket 上再订阅一次
    client.send({ type: 'subscribe', sessionId })
    await client.waitFor(
      () => client.frames.filter((frame) => frame.type === 'subscribed').length >= 2,
    )

    await postJson(h, `/api/sessions/${sessionId}/turns`, { prompt: '一次' })
    await client.waitFor(() => client.types().includes('turn_end'))

    // 单份：一条 turn_start，一条 turn_end
    expect(client.types().filter((type) => type === 'turn_start')).toHaveLength(1)
    expect(client.types().filter((type) => type === 'turn_end')).toHaveLength(1)
  })

  it('⚠️ 空闲超时后强制断开（半开连接不会响应关闭帧）', async () => {
    const h = await harness({
      policy: { wsIdleTimeoutMs: 10, wsPingIntervalMs: 1 },
    })
    const client = await connect(h)
    // 保活定时器被钳到最小 1 秒，因此这条断言最快也要等约 1 秒。
    const code = await new Promise<number>((resolve) => {
      client.socket.on('close', resolve)
    })
    expect(code).toBe(1006)
  }, 10_000)

  it('无权访问的会话 → error 帧（且用 SESSION_NOT_FOUND 掩盖是否存在）', async () => {
    const h = await harness()
    const client = await connect(h, { sessionId: 'not-mine' })
    await client.waitFor(() => client.frames.some((frame) => frame.type === 'error'))
    const error = client.frames.find((frame) => frame.type === 'error')
    expect(error?.['code']).toBe(ErrorCode.SESSION_NOT_FOUND)
  })

  it('turn 事件实时到达，且 turn_end 也在其中', async () => {
    const h = await harness({ text: '回答' })
    const sessionId = await h.newSession()
    const client = await connect(h, { sessionId })
    await client.waitFor(() => client.frames.some((frame) => frame.type === 'replay_complete'))

    await postJson(h, `/api/sessions/${sessionId}/turns`, { prompt: '提问' })
    await client.waitFor(() => client.types().includes('turn_end'))

    expect(client.types()).toContain('turn_start')
    expect(client.types()).toContain('text')
  })

  it('⚠️ 事件载荷经 DTO 脱敏后才发出去', async () => {
    const h = await harness({ text: 'ok' })
    const sessionId = await h.newSession()
    const client = await connect(h, { sessionId })
    await client.waitFor(() => client.frames.some((frame) => frame.type === 'replay_complete'))

    await postJson(h, `/api/sessions/${sessionId}/turns`, { prompt: '提问' })
    await client.waitFor(() => client.types().includes('turn_end'))

    // 每一帧都应当是 DTO 形态（camelCase 字段），而不是内核事件的原始形状
    const first = client.events[0]
    expect(first).toHaveProperty('eventId')
    expect(first).toHaveProperty('sessionId')
    expect(first).not.toHaveProperty('session_id')
  })

  it('多标签页可以订阅同一个会话', async () => {
    const h = await harness({ text: '回答' })
    const sessionId = await h.newSession()
    const first = await connect(h, { sessionId })
    const second = await connect(h, { sessionId })
    await first.waitFor(() => first.frames.some((f) => f.type === 'replay_complete'))
    await second.waitFor(() => second.frames.some((f) => f.type === 'replay_complete'))

    await postJson(h, `/api/sessions/${sessionId}/turns`, { prompt: '提问' })
    await first.waitFor(() => first.types().includes('turn_end'))
    await second.waitFor(() => second.types().includes('turn_end'))
  })
})

describe('重连：不丢也不重', () => {
  it('⚠️ lastEventId 补发断线期间的事件，且不重复', async () => {
    const h = await harness({ text: '回答' })
    const sessionId = await h.newSession()

    const first = await connect(h, { sessionId })
    await first.waitFor(() => first.frames.some((frame) => frame.type === 'replay_complete'))

    await postJson(h, `/api/sessions/${sessionId}/turns`, { prompt: '第一个' })
    await first.waitFor(() => first.types().includes('turn_end'))

    const anchor = first.eventIds().at(-1) ?? ''
    const seenBefore = new Set(first.eventIds())
    first.close()
    await first.waitFor(() => first.closed)

    // 断线期间跑完第二个 turn：它的事件只落进事件日志，没有任何订阅者在听。
    await postJson(h, `/api/sessions/${sessionId}/turns`, { prompt: '第二个' })

    const second = await connect(h, { sessionId, lastEventId: anchor })
    await second.waitFor(() => second.frames.some((frame) => frame.type === 'replay_complete'))

    const replayed = second.eventIds()
    expect(replayed.length).toBeGreaterThan(0)

    // 不重：没有任何一个 eventId 出现两次
    expect(new Set(replayed).size).toBe(replayed.length)
    // 不重：也不包含锚点之前那些已经看过的事件
    for (const id of replayed) expect(seenBefore.has(id)).toBe(false)
    // 不丢：第二个 turn 的起止都在补发里
    expect(second.types()).toContain('turn_start')
    expect(second.types()).toContain('turn_end')

    // 补发之后转实时：再来一个 turn 仍然收得到
    await postJson(h, `/api/sessions/${sessionId}/turns`, { prompt: '第三个' })
    await second.waitFor(() => second.types().filter((type) => type === 'turn_end').length >= 2)
  })

  it('补发为空时也会下发 replay_complete（否则客户端永远等不到追平）', async () => {
    const h = await harness({ text: '回答' })
    const sessionId = await h.newSession()

    const first = await connect(h, { sessionId })
    await first.waitFor(() => first.frames.some((frame) => frame.type === 'replay_complete'))
    await postJson(h, `/api/sessions/${sessionId}/turns`, { prompt: '唯一一个' })
    await first.waitFor(() => first.types().includes('turn_end'))

    const anchor = first.eventIds().at(-1) ?? ''
    const second = await connect(h, { sessionId, lastEventId: anchor })
    await second.waitFor(() => second.frames.some((frame) => frame.type === 'replay_complete'))

    expect(second.events).toHaveLength(0)
  })

  it('⚠️ 未知锚点 → resync_required，而不是补发全量', async () => {
    const h = await harness({ text: '回答' })
    const sessionId = await h.newSession()
    await h.app.chatStore.read()

    const client = await connect(h, { sessionId, lastEventId: 'nonexistent-anchor' })
    await client.waitFor(() => client.frames.some((frame) => frame.type === 'resync_required'))

    const frame = client.frames.find((item) => item.type === 'resync_required')
    expect(frame?.['code']).toBe(ErrorCode.EVENT_RESYNC_REQUIRED)
    // 连接**保持打开**：客户端重建视图后可以直接重新 subscribe
    expect(client.closed).toBe(false)

    // 同一条 socket 上重新订阅即可，不需要重连——这正是"保持打开"的意义。
    client.send({ type: 'subscribe', sessionId })
    await client.waitFor(() => client.frames.some((frame) => frame.type === 'subscribed'))
    await client.waitFor(() => client.frames.some((frame) => frame.type === 'replay_complete'))
  })

  it('replay_complete 之后才是"已追平"：subscribed 可能排在补发事件之后', async () => {
    // 这条断言锁的是协议约定本身——客户端必须用 replay_complete 结束 loading，
    // 而不是用 subscribed。这里只要求两帧都存在，顺序不作要求。
    const h = await harness({ text: '回答' })
    const sessionId = await h.newSession()
    await postJson(h, `/api/sessions/${sessionId}/turns`, { prompt: '先跑一个' })

    const client = await connect(h, { sessionId })
    await client.waitFor(() => client.frames.some((frame) => frame.type === 'replay_complete'))
    expect(client.frames.some((frame) => frame.type === 'subscribed')).toBe(true)
  })
})

describe('连接数与关闭', () => {
  it('⚠️ 超出连接数上限 → 升级后以 1013 关闭', async () => {
    const h = await harness({ policy: { wsConnectionsTotal: 1 } })
    const first = await connect(h)
    expect(first.frames[0]?.type).toBe('ready')

    const issued = await postJson(h, '/api/ws-ticket', {})
    const ticket = ((await issued.json()) as { ticket: string }).ticket
    const socket = new WebSocket(
      `ws://127.0.0.1:${String(h.server.port)}/api/stream?ticket=${ticket}`,
      { headers: { Origin: h.baseUrl } },
    )
    sockets.push(socket)

    const code = await new Promise<number>((resolve) => {
      socket.on('close', resolve)
    })
    expect(code).toBe(1013)
  })

  it('释放后可以重新连接', async () => {
    const h = await harness({ policy: { wsConnectionsTotal: 1 } })
    const first = await connect(h)
    first.close()
    await first.waitFor(() => first.closed)
    // 服务端释放租约是异步的（close 事件 → teardown），轮询而不是假定即时。
    await waitUntil(() => h.server.connectionCount === 0)

    const second = await connect(h)
    expect(second.frames.some((frame) => frame.type === 'ready')).toBe(true)
  })

  it('服务关闭时以 1001 断开', async () => {
    const h = await harness()
    const client = await connect(h)
    const codePromise = new Promise<number>((resolve) => {
      client.socket.on('close', resolve)
    })
    await h.server.close()
    expect(await codePromise).toBe(1001)
  })
})
