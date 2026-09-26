/**
 * WebSocket 事件流。
 *
 * ## 重连语义：不丢也不重
 *
 * `parts/09` §1.1 要求「WebSocket 重连必须支持 `lastEventId`，服务器从持久化
 * 事件日志补发，不能只依赖内存队列」。客户端把最后一次收到的 `eventId` 带回来，
 * `EventBus` 从事件日志里补发之后的部分——补发的排队、去重与"补发完毕"标记
 * 全部由 `EventBus` 负责，这一层只做**协议映射**，不重新实现补发。
 *
 * ⚠️ 有一条容易写错：**`replay_complete` 才是"已追平"的判据**，不是
 * `subscribed`。`EventBus` 的补发是通过微任务投递的，可能早于 `attach()`
 * 的 promise 落地，所以 `subscribed` 帧**可能排在补发事件之后**。
 * 客户端必须用 `replay_complete` 结束 loading 态。
 *
 * ## 锚点失效 → `resync_required`，而不是断开
 *
 * `EVENT_RESYNC_REQUIRED` 表示客户端给的 `lastEventId` 已经不在日志里了
 * （或补发积压过大）。此时**不能**改成"补发全量"——那会让客户端把整个
 * transcript 重绘一遍，正是"重连不重复"要避免的。正确做法是明确告诉它
 * "你的锚点没用了，去重建视图"，连接保持打开，客户端重新订阅即可。
 */

import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

import { WebSocketServer, type WebSocket } from 'ws'

import { AgentError, ErrorCode } from '../../core/errors.js'
import type { PrincipalId, SessionId } from '../../core/ids.js'
import type { EventSubscription } from '../../app/event-bus.js'
import type { AgentApplication } from '../../app/agent-application.js'
import type { AppPolicy } from '../../app/policy.js'

import type { AuthService } from './auth.js'
import { toEventDto } from './dto.js'
import { allowedOriginList, isOriginAllowed, type OriginPolicy } from './origin.js'
import type { ConnectionLimiter } from './rate-limit.js'
import type { WebLogger } from './logger.js'

/** 服务端 → 客户端的控制帧与事件帧。 */
export type ServerFrame =
  /** 握手完成，可以发 `subscribe` 了。**不是**"已追平"。 */
  | { readonly type: 'ready'; readonly principalId: string }
  | { readonly type: 'subscribed'; readonly sessionId: string; readonly replayed: number }
  | { readonly type: 'event'; readonly event: ReturnType<typeof toEventDto> }
  | { readonly type: 'replay_complete'; readonly lastSequence: number }
  /** 锚点失效或补发积压过大。客户端应重建视图后重新 `subscribe`。 */
  | { readonly type: 'resync_required'; readonly code: string; readonly message: string }
  | { readonly type: 'error'; readonly code: string; readonly message: string }
  | { readonly type: 'pong' }

/** 客户端 → 服务端的控制帧。 */
type ClientFrame =
  | { readonly type: 'subscribe'; readonly sessionId?: string; readonly lastEventId?: string }
  | { readonly type: 'unsubscribe' }
  | { readonly type: 'ping' }

/** 单条连接的状态。 */
interface Connection {
  readonly socket: WebSocket
  readonly principalId: PrincipalId
  readonly release: () => void
  /** 当前订阅。重订阅时先退掉旧的。 */
  subscription: EventSubscription | undefined
  sessionId: SessionId | undefined
  /** 最近一次**入站**活动的时刻。出站不计——否则一个僵死的连接会被自己的事件养着。 */
  lastActivityMs: number
}

export interface WebSocketStreamOptions {
  readonly app: AgentApplication
  readonly projectId?: string
  readonly auth: AuthService
  readonly origins: OriginPolicy
  readonly policy: AppPolicy
  readonly connections: ConnectionLimiter
  readonly logger: WebLogger
  readonly now: () => number
  readonly shuttingDown: () => boolean
}

/** 关闭码。1013 = 稍后重试（连接数超限、订阅被断开）；1001 = 服务端离开。 */
const CLOSE_TRY_AGAIN_LATER = 1013
const CLOSE_GOING_AWAY = 1001

export class WebSocketStream {
  readonly #options: WebSocketStreamOptions
  readonly #wss: WebSocketServer
  readonly #connections = new Set<Connection>()
  /** `waitForClose` 的唤醒者。连接清零时逐个通知。 */
  readonly #closeWaiters = new Set<() => void>()
  #timer: ReturnType<typeof setInterval> | undefined
  #disposed = false

  constructor(options: WebSocketStreamOptions) {
    this.#options = options
    this.#wss = new WebSocketServer({
      noServer: true,
      // 消息上限直接交给 `ws`：超限帧由它关闭（1009），我们不必先把
      // 整个消息读进内存再判断——那正是"上限"要防的事情。
      maxPayload: options.policy.wsMessageLimitBytes,
    })
  }

  /** 当前连接数。测试与关闭报告用。 */
  get size(): number {
    return this.#connections.size
  }

  /**
   * 启动保活与空闲检查。
   *
   * 单个定时器同时承担两件事：发 ping、踢掉超时空闲连接。合成一个定时器
   * 是因为两者共享同一个"最近活动时刻"，分开写只会让两处判断漂移。
   *
   * ⚠️ `unref()` 是必须的：否则这个定时器会让 Node 进程在关闭后继续存活，
   * 表现为"ctrl-c 之后命令不返回"。
   */
  start(): void {
    if (this.#timer !== undefined) return
    this.#timer = setInterval(
      () => {
        this.#tick()
      },
      Math.max(1_000, this.#options.policy.wsPingIntervalMs),
    )
    this.#timer.unref?.()
  }

  /** 处理 HTTP upgrade。由 `server.ts` 挂到 `server.on('upgrade')`。 */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

    if (this.#disposed || this.#options.shuttingDown()) {
      rejectUpgrade(socket, 503, ErrorCode.WEB_SHUTTING_DOWN, '服务正在关闭')
      return
    }

    // ① URL 里的凭据。`ticket` 是**唯一**允许出现在 query 里的凭据，
    //    且它是一次性、30 秒、绑定 Origin 的；token 则绝对不允许。
    const queryFailure = this.#options.auth.checkQueryString(url.searchParams, 'ws:/api/stream')
    if (queryFailure) {
      rejectUpgrade(socket, 401, queryFailure.code, queryFailure.reason)
      return
    }

    // ② Origin 是**必填**。浏览器一定会带；不带 Origin 的升级请求只可能来自
    //    非浏览器客户端，而那些客户端可以直接用 Bearer 头，不需要走这里。
    const origin = headerValue(req.headers.origin)
    if (origin === undefined || !isOriginAllowed(origin, this.#options.origins)) {
      this.#options.logger.warn(
        `[web-ws] 拒绝升级：Origin=${origin ?? '(缺失)'}（允许：${allowedOriginList(this.#options.origins).join(', ')}）`,
      )
      rejectUpgrade(socket, 403, ErrorCode.WEB_ORIGIN_REJECTED, 'Origin 缺失或未被允许')
      return
    }

    // ③ 认证：ticket 优先（浏览器路径），否则 Bearer（脚本路径）。
    const ticket = url.searchParams.get('ticket') ?? undefined
    const auth =
      ticket !== undefined
        ? this.#options.auth.consumeTicket(ticket, origin)
        : this.#options.auth.authenticateBearer(
            headerValue(req.headers.authorization),
            'ws:/api/stream',
          )
    if (!auth.ok) {
      rejectUpgrade(socket, 401, auth.code, auth.reason)
      return
    }

    const selected = url.searchParams.get('project')
    if (
      selected !== null &&
      this.#options.projectId !== undefined &&
      selected !== this.#options.projectId
    ) {
      rejectUpgrade(socket, 404, ErrorCode.SESSION_NOT_FOUND, '项目未打开')
      return
    }

    // ④ 升级。连接数上限**刻意放在升级之后**：握手阶段拒绝时浏览器只能拿到
    //    一个无信息的 error 事件，客户端无法区分"服务没起来"和"人满了"；
    //    1013 是可判定的，客户端能据此退避重试。
    this.#wss.handleUpgrade(req, socket, head, (ws) => {
      this.#onConnection(ws, auth.principalId, origin)
    })
  }

  /** 断开全部连接。优雅关闭时调用。 */
  closeAll(reason = 'server shutting down'): void {
    for (const connection of [...this.#connections]) {
      try {
        connection.socket.close(CLOSE_GOING_AWAY, reason)
      } catch {
        connection.socket.terminate()
      }
    }
  }

  /** 等待连接真正关闭，**有界**。超时后强制断开。 */
  async waitForClose(timeoutMs: number): Promise<void> {
    if (this.#connections.size === 0) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(
        () => {
          for (const connection of [...this.#connections]) connection.socket.terminate()
          resolve()
        },
        Math.max(0, timeoutMs),
      )
      timer.unref?.()

      const check = (): void => {
        if (this.#connections.size > 0) return
        clearTimeout(timer)
        resolve()
      }
      this.#closeWaiters.add(check)
      // 已经空了的话上面的 add 不会被触发，补一次同步检查。
      check()
    })
  }

  /** 释放定时器与全部连接。 */
  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    if (this.#timer !== undefined) clearInterval(this.#timer)
    this.#timer = undefined
    this.closeAll()
    this.#wss.close()
  }

  // ─ 内部 ───────────────────────────────────────────────────────

  #onConnection(socket: WebSocket, principalId: PrincipalId, origin: string): void {
    const decision = this.#options.connections.acquire(principalId)
    if (!decision.ok) {
      this.#options.logger.warn(`[web-ws] ${decision.reason}`)
      sendFrame(socket, {
        type: 'error',
        code: ErrorCode.WEB_CONNECTION_LIMIT,
        message: decision.reason,
      })
      socket.close(CLOSE_TRY_AGAIN_LATER, decision.reason)
      return
    }

    const connection: Connection = {
      socket,
      principalId,
      // 显式包一层而不是直接取方法引用：`release` 内部用了 `this`，
      // 拆下来单独传会在调用时丢失接收者。
      release: () => {
        decision.lease.release()
      },
      subscription: undefined,
      sessionId: undefined,
      lastActivityMs: this.#options.now(),
    }
    this.#connections.add(connection)

    socket.on('message', (data: Buffer, isBinary: boolean) => {
      connection.lastActivityMs = this.#options.now()
      if (isBinary) return
      this.#onClientMessage(connection, data.toString('utf8'))
    })
    socket.on('pong', () => {
      connection.lastActivityMs = this.#options.now()
    })
    socket.on('close', () => {
      this.#teardown(connection)
    })
    socket.on('error', (error: Error) => {
      // 不接这个事件会让 `ws` 抛出未捕获异常，把整个进程带走。
      this.#options.logger.warn(`[web-ws] 连接错误：${error.message}（origin=${origin}）`)
      this.#teardown(connection)
    })

    // 连接就绪信号。刻意**不用** `replay_complete`——那一帧的语义是"补发已追平"，
    // 复用会让客户端在还没订阅的时候就以为自己已经同步完了。
    sendFrame(socket, { type: 'ready', principalId })
  }

  #onClientMessage(connection: Connection, text: string): void {
    let frame: ClientFrame
    try {
      const parsed: unknown = JSON.parse(text)
      if (parsed === null || typeof parsed !== 'object') throw new Error('not an object')
      frame = parsed as ClientFrame
    } catch {
      sendFrame(connection.socket, {
        type: 'error',
        code: ErrorCode.VALIDATION_FAILED,
        message: '控制帧必须是 JSON 对象',
      })
      return
    }

    switch (frame.type) {
      case 'ping':
        sendFrame(connection.socket, { type: 'pong' })
        return
      case 'unsubscribe':
        connection.subscription?.unsubscribe()
        connection.subscription = undefined
        connection.sessionId = undefined
        return
      case 'subscribe':
        void this.#subscribe(connection, frame.sessionId, frame.lastEventId)
        return
      default:
        sendFrame(connection.socket, {
          type: 'error',
          code: ErrorCode.VALIDATION_FAILED,
          message: `未知控制帧：${String((frame as { type?: unknown }).type)}`,
        })
    }
  }

  async #subscribe(
    connection: Connection,
    rawSessionId: string | undefined,
    lastEventId: string | undefined,
  ): Promise<void> {
    if (rawSessionId === undefined || rawSessionId === '') {
      sendFrame(connection.socket, {
        type: 'error',
        code: ErrorCode.VALIDATION_FAILED,
        message: 'subscribe 必须带 sessionId',
      })
      return
    }
    const sessionId = rawSessionId as SessionId

    // 旧的订阅必须先退掉：同一个 socket 上留着两条订阅会让事件发两遍，
    // 而客户端已经"重新订阅"过了，它不会预期收到双份。
    connection.subscription?.unsubscribe()
    connection.subscription = undefined

    try {
      await this.#options.app.getSession(connection.principalId, sessionId)
    } catch {
      // 无权限与不存在返回同一个码，避免把会话枚举出去（§1.1）。
      sendFrame(connection.socket, {
        type: 'error',
        code: ErrorCode.SESSION_NOT_FOUND,
        message: '会话不存在或无权访问',
      })
      return
    }

    try {
      const subscription = await this.#options.app.attach(
        {
          onEvent: (event) => {
            // 出站背压：客户端读得太慢时宁可直接断开。事件没丢——它已经落盘，
            // 客户端带 lastEventId 重连即可补齐；继续往 socket 里灌才会真的丢。
            if (connection.socket.bufferedAmount > this.#options.policy.wsMessageLimitBytes) {
              connection.socket.terminate()
              return
            }
            sendFrame(connection.socket, { type: 'event', event: toEventDto(event) })
          },
          onError: (error: AgentError) => {
            sendFrame(connection.socket, {
              type: 'error',
              code: error.code,
              message: error.message,
            })
            // 订阅者被断开（背压溢出/内部错误）。关掉连接让客户端重连补发。
            connection.socket.close(CLOSE_TRY_AGAIN_LATER, error.code)
          },
          onReplayComplete: (lastSequence) => {
            sendFrame(connection.socket, { type: 'replay_complete', lastSequence })
          },
        },
        { sessionId, ...(lastEventId === undefined ? {} : { lastEventId }) },
      )
      connection.subscription = subscription
      connection.sessionId = sessionId
      sendFrame(connection.socket, {
        type: 'subscribed',
        sessionId,
        replayed: subscription.replayed,
      })
    } catch (error) {
      const agentError = AgentError.is(error)
        ? error
        : new AgentError({
            code: ErrorCode.INTERNAL_ERROR,
            message: error instanceof Error ? error.message : String(error),
            source: 'web.ws',
          })

      if (agentError.code === ErrorCode.EVENT_RESYNC_REQUIRED) {
        // 让客户端重建视图后重新 subscribe —— **不是**补发全量。
        sendFrame(connection.socket, {
          type: 'resync_required',
          code: agentError.code,
          message: agentError.message,
        })
        return
      }

      sendFrame(connection.socket, {
        type: 'error',
        code: agentError.code,
        message: agentError.message,
      })
    }
  }

  #teardown(connection: Connection): void {
    connection.subscription?.unsubscribe()
    connection.subscription = undefined
    connection.sessionId = undefined
    this.#connections.delete(connection)
    connection.release()
    for (const waiter of this.#closeWaiters) waiter()
  }

  #tick(): void {
    const now = this.#options.now()
    const idleLimit = this.#options.policy.wsIdleTimeoutMs
    for (const connection of [...this.#connections]) {
      if (now - connection.lastActivityMs > idleLimit) {
        // `terminate()` 而不是 `close()`：半开的连接不会响应关闭帧，
        // 而"空闲超时"针对的正是这种连接。
        connection.socket.terminate()
        continue
      }
      try {
        connection.socket.ping()
      } catch {
        connection.socket.terminate()
      }
    }
  }
}

// ── 辅助 ──────────────────────────────────────────────────────────

function sendFrame(socket: WebSocket, frame: ServerFrame): void {
  if (socket.readyState !== socket.OPEN) return
  try {
    socket.send(JSON.stringify(frame))
  } catch {
    /* 连接已在关闭过程中；事件没有丢，重连会补发。 */
  }
}

function headerValue(value: string | readonly string[] | undefined): string | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string') return value
  return value[0]
}

/** 在升级**之前**拒绝一个 WebSocket 请求：只能直接往 socket 写 HTTP 响应。 */
function rejectUpgrade(socket: Duplex, status: number, code: ErrorCode, message: string): void {
  const reason =
    status === 401
      ? 'Unauthorized'
      : status === 403
        ? 'Forbidden'
        : status === 404
          ? 'Not Found'
          : status === 503
            ? 'Service Unavailable'
            : 'Bad Request'
  const body = JSON.stringify({ error: { code, message } })
  socket.write(
    `HTTP/1.1 ${String(status)} ${reason}\r\n` +
      'Connection: close\r\n' +
      'Content-Type: application/json; charset=utf-8\r\n' +
      `Content-Length: ${String(Buffer.byteLength(body))}\r\n` +
      '\r\n' +
      body,
  )
  socket.destroy()
}
