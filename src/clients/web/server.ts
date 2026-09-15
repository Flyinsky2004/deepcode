/**
 * Web 服务器的装配与生命周期。
 *
 * ## 启动顺序即契约（`parts/09` §1.2）
 *
 * 「加载配置 → 初始化 storage/event log → 初始化 provider/tools/skills/MCP →
 * 绑定监听 → 输出访问地址。任何必需组件初始化失败都不能启动一个'半可用'服务。」
 *
 * 前两步由调用方通过已建好的 `AgentApplication` 完成（组合根已经在 `create()`
 * 里做完并做过恢复扫描）。本模块负责后半段：**绑定**（可能失败）→ **打印地址**
 * （只有在真的绑上之后）。
 *
 * ## 绝不降级
 *
 * 监听策略判定失败、绑定失败、`--cors *`、`--auth password` 未实现——
 * 每一种都是"返回失败并让调用方退出"，**没有一条重试或回退路径**。
 * `local` 模式下 `127.0.0.1` 绑上而 `::1` 失败时同样整体失败：
 * 部分可用比不可用更危险，因为用户会以为自己在 loopback-only 下运行。
 *
 * ## 关闭顺序即契约（`parts/09` §1.1）
 *
 * 拒绝新请求 → 向活动 turn 发 cancel → **有界**等待 → `app.flush()` →
 * `app.dispose()` → WebSocket `close(1001)` → 返回报告。
 * 每一步的等待上限都来自 `AppPolicy`，且所有定时器都 `unref()`——
 * 漏掉 `unref()` 的表现是"进程怎么也不退出"。
 */

import { existsSync, readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ErrorCode } from '../../core/errors.js'
import type { SessionId } from '../../core/ids.js'
import type { AgentApplication } from '../../app/agent-application.js'
import { CommandHostAdapter } from '../../app/command-host.js'
import { DEFAULT_APP_POLICY, type AppPolicy } from '../../app/policy.js'
import type { CommandRegistry } from '../../commands/registry.js'
import { createBuiltinCommandRegistry } from '../../commands/index.js'
import type { CommandHost } from '../../commands/types.js'

import { AuthService, formatAccessNotice, generateToken } from './auth.js'
import { HttpRouter } from './http-router.js'
import {
  AuthMode,
  DEFAULT_WEB_PORT,
  ListenScope,
  evaluateBindResults,
  evaluateListen,
  formatAddress,
  systemListenDeps,
  type BindOutcome,
  type ListenAddress,
  type ListenPolicyDeps,
} from './listen-policy.js'
import { allowedOriginList, resolveCors } from './origin.js'
import { ConnectionLimiter, TokenBucketLimiter } from './rate-limit.js'
import { WebSocketStream } from './ws-stream.js'
import { consoleLogger, type WebLogger } from './logger.js'

/** 启动参数。字段与 `parts/09` §1.1 的命令行一一对应。 */
export interface WebServerOptions {
  readonly app: AgentApplication
  readonly listen?: ListenScope
  readonly host?: string | undefined
  readonly port?: number
  /** `--port` 是否被显式传入。`--port 0` 只在显式为真时允许。 */
  readonly portExplicit?: boolean
  readonly auth?: AuthMode
  /** `--token`。未提供且 `--auth token` 时启动生成并只显示一次。 */
  readonly token?: string | undefined
  readonly cors?: string | undefined
  readonly logger?: WebLogger
  readonly deps?: ListenPolicyDeps
  readonly now?: () => number
  readonly staticDir?: string
  /**
   * 关闭时是否 `app.dispose()`。
   *
   * 默认 `true`（CLI 场景：进程退出，组合根与服务器同生命周期）。
   * 嵌入式/测试场景可关掉，由宿主自己决定何时释放。
   */
  readonly disposeApplication?: boolean
  /**
   * 命令桥。**整体可缺省，也可只覆盖其中一半**。
   *
   * 缺省时自动装配：宿主用 `CommandHostAdapter(app)`，注册表用内置命令集。
   * 之所以给默认值而不是"缺省即报错"：`app` 本来就是必传参数，
   * 命令宿主由它唯一确定；让调用方每次手动装配一遍只会制造两份会漂移的装配。
   * 显式注入保留给测试（换成桩注册表 / 桩宿主）。
   */
  readonly commands?:
    | {
        readonly registry?: CommandRegistry | undefined
        readonly host?: CommandHost | undefined
      }
    | undefined
  readonly version?: string
}

/** 启动失败。调用方应打印 `reason` 后退出——**不要**重试。 */
export interface WebServerStartFailure {
  readonly ok: false
  readonly code: ErrorCode
  readonly reason: string
}

/** 启动成功。 */
export interface WebServerStartSuccess {
  readonly ok: true
  readonly server: WebServer
}

export type WebServerStart = WebServerStartSuccess | WebServerStartFailure

/** 请求处理器、WS 层与 `WebServer` 实例共享的可变状态。见 `WebServer.#state`。 */
interface WebServerState {
  shuttingDown: boolean
  refusedRequests: number
}

/** 关闭报告。 */
export interface ShutdownReport {
  /** 关闭期间被 503 拒绝的请求数。 */
  readonly refusedRequests: number
  /** 被主动取消的 turn 数。 */
  readonly cancelledTurns: number
  /** 是否有 turn 在宽限期内没有结束（超时后不再等待）。 */
  readonly turnsTimedOut: boolean
  /** 是否有持久化写入在宽限期内没有完成。 */
  readonly flushTimedOut: boolean
  readonly durationMs: number
}

/**
 * 解析静态资源目录。
 *
 * 编译产物（`dist/clients/web/server.js`）与源码（`src/clients/web/server.ts`）
 * 到 `static/` 的相对深度**相同**，所以 `./static/` 在两种情况下都指向正确位置；
 * 只有当 `pnpm build` 忘了跑 `copy-static.mjs` 时 `dist` 下才没有它，
 * 那时回落到源码树而不是给出 404——本地 `node dist/...` 调试因此仍然可用。
 */
export function resolveStaticDir(explicit?: string): string {
  if (explicit !== undefined && explicit !== '') return explicit

  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(here, 'static'),
    join(here, '..', '..', '..', 'src', 'clients', 'web', 'static'),
  ]
  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  return candidates[0] ?? join(here, 'static')
}

/** 从 `package.json` 读版本，用于 `/api/health`。读不到就退化为 `0.0.0`。 */
function readVersion(): string {
  try {
    const raw = readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (parsed !== null && typeof parsed === 'object') {
      const version = (parsed as { version?: unknown }).version
      if (typeof version === 'string' && version !== '') return version
    }
  } catch {
    /* 打包/裁剪后的部署可能没有 package.json；健康检查不该因此失败。 */
  }
  return '0.0.0'
}

export class WebServer {
  readonly #app: AgentApplication
  readonly #policy: AppPolicy
  readonly #servers: readonly Server[]
  readonly #stream: WebSocketStream
  readonly #logger: WebLogger
  readonly #disposeApplication: boolean
  readonly port: number
  readonly addresses: readonly ListenAddress[]
  readonly urls: readonly string[]
  readonly token: string | undefined
  readonly authMode: AuthMode

  #closePromise: Promise<ShutdownReport> | undefined
  /**
   * 与请求处理器、WS 层共享的可变状态。
   *
   * 必须是**同一个对象**：请求处理器在 `WebServer` 实例构造之前就挂上了，
   * 路由拿到的关闭标志是闭包。若实例改自己的字段、闭包读局部变量，
   * "先拒绝新请求"这一步会静默失效——没有报错，只是不再生效。
   */
  readonly #state: WebServerState

  private constructor(input: {
    app: AgentApplication
    servers: readonly Server[]
    stream: WebSocketStream
    logger: WebLogger
    disposeApplication: boolean
    port: number
    addresses: readonly ListenAddress[]
    token: string | undefined
    authMode: AuthMode
    state: WebServerState
  }) {
    this.#app = input.app
    this.#policy = input.app.policy
    this.#state = input.state
    this.#servers = input.servers
    this.#stream = input.stream
    this.#logger = input.logger
    this.#disposeApplication = input.disposeApplication
    this.port = input.port
    this.addresses = input.addresses
    this.token = input.token
    this.authMode = input.authMode
    this.urls = input.addresses.map(
      (address) => `http://${formatAddress(address)}:${String(input.port)}`,
    )
  }

  /** 当前 WebSocket 连接数。供诊断与测试观察租约释放。 */
  get connectionCount(): number {
    return this.#stream.size
  }

  /** 静态装配入口。参数校验与判定的失败都在这里返回，不抛。 */
  static async start(options: WebServerOptions): Promise<WebServerStart> {
    const app = options.app
    const policy = app.policy ?? DEFAULT_APP_POLICY
    const logger = options.logger ?? consoleLogger
    const now = options.now ?? ((): number => Date.now())
    const deps = options.deps ?? systemListenDeps()
    const listen = options.listen ?? ListenScope.LOCAL
    const authMode = options.auth ?? AuthMode.TOKEN
    const port = options.port ?? DEFAULT_WEB_PORT
    const portExplicit = options.portExplicit ?? false

    // ── ① 监听策略 ────────────────────────────────────────────────
    const decision = await evaluateListen(
      { listen, host: options.host, port, portExplicit, auth: authMode },
      deps,
    )
    if (!decision.ok) return { ok: false, code: decision.code, reason: decision.reason }

    // ── ② `--auth password` 尚未实现 ──────────────────────────────
    //
    // 明确失败而不是"当作 token 处理"：password 模式需要登录表单、凭据存储与
    // 自己的限流策略，把它伪装成 token 会让用户以为自己设的密码在起作用。
    // `public` 下 `--auth password` 能通过策略校验但走不到这里就成功了——
    // 它需要的是"非 none"，而 token 同样满足。
    if (authMode === AuthMode.PASSWORD)
      return {
        ok: false,
        code: ErrorCode.WEB_AUTH_FAILED,
        reason: '--auth password 尚未实现；请使用 --auth token（public 模式下同样满足要求）',
      }

    // ── ③ CORS。默认仅同源；`*` 直接拒绝 ────────────────────────
    //
    // 这里用**请求的** port 只是为了尽早失败（`*`、非法来源格式）。
    // 真正的来源表必须在**绑定之后**用实际端口重建——`--port 0` 时请求端口
    // 恒为 0，拿它算出来的同源表是 `http://127.0.0.1:0`，于是浏览器发来的
    // 每一个带 Origin 的请求都会被判为跨源。这是一个只会在随机端口下出现、
    // 且症状是"全部 403"的坑。
    const corsCheck = resolveCors(options.cors, port)
    if (!corsCheck.ok) return { ok: false, code: corsCheck.code, reason: corsCheck.reason }

    // ── ④ 认证服务 ────────────────────────────────────────────────
    const token = authMode === AuthMode.NONE ? undefined : (options.token ?? generateToken())
    const auth = new AuthService({
      mode: authMode,
      token: token ?? '',
      principalId: app.localPrincipalId,
      now,
      logger,
    })

    // ── ⑤ 限流与连接数：数值**全部**来自 AppPolicy ────────────────
    const limiter = new TokenBucketLimiter({
      perMinute: policy.httpRequestsPerMinute,
      burst: policy.httpBurst,
      now,
    })
    const authFailures = new TokenBucketLimiter({
      perMinute: policy.authFailuresPerMinute,
      burst: policy.authFailuresPerMinute,
      now,
    })
    const connections = new ConnectionLimiter({
      total: policy.wsConnectionsTotal,
      perPrincipal: policy.wsConnectionsPerPrincipal,
    })

    const startedAtMs = now()

    // 关闭标志必须是**共享的可变状态**，不能是 `start()` 里的局部 `let`：
    // 路由与 WS 拿到的是闭包，而 `#shutdown()` 改的是实例字段——两者若不指向
    // 同一个对象，"拒绝新请求"这一步会静默失效（闭包永远读到 `false`）。
    const state: WebServerState = { shuttingDown: false, refusedRequests: 0 }

    // 路由与 WS 必须在**绑定之后**才能构造（同源来源表需要实际端口），
    // 而请求处理器必须在 `listen()` 之前就挂上。用两个可变引用弥合这个顺序。
    // 用一个持有者对象而不是两个 `let`：`prefer-const` 会把"声明后只赋值一次"
    // 的 `let` 判成常量，而这里的赋值必须在闭包挂上**之后**才发生。
    const pending: { router?: HttpRouter; stream?: WebSocketStream } = {}

    // ── ⑥ 绑定 ───────────────────────────────────────────────────
    const servers: Server[] = []
    const outcomes: BindOutcome[] = []
    let boundPort = port

    for (const address of decision.addresses) {
      const server = createServer((req, res) => {
        if (state.shuttingDown) state.refusedRequests += 1
        const active = pending.router
        if (active === undefined) {
          // 赋值前到来的请求：还没初始化完，「不可用」就是正确的回答。
          res.statusCode = 503
          res.setHeader('Connection', 'close')
          res.end()
          return
        }
        void active.handle(req, res).catch((error: unknown) => {
          logger.error(`[web] 未捕获的请求处理异常：${String(error)}`)
          if (!res.headersSent) {
            res.statusCode = 500
            res.end()
          } else {
            res.end()
          }
        })
      })
      server.on('upgrade', (req: IncomingMessage, socket, head) => {
        const active = pending.stream
        if (active === undefined) {
          socket.destroy()
          return
        }
        active.handleUpgrade(req, socket, head)
      })
      // 客户端在响应前断开是常态（刷新、取消），不该变成未捕获异常。
      server.on('clientError', (_error, socket) => {
        socket.destroy()
      })

      try {
        await listenOn(server, address, boundPort)
        if (boundPort === 0) {
          const info = server.address() as AddressInfo | null
          boundPort = info?.port ?? 0
        }
        servers.push(server)
        outcomes.push({ host: address.host, family: address.family })
      } catch (error) {
        outcomes.push({
          host: address.host,
          family: address.family,
          error: error instanceof Error ? error.message : String(error),
        })
        // 一个地址失败就整体失败：**不降级**（见文件头）。
        break
      }
    }

    const bindResult = evaluateBindResults(listen, decision.addresses, outcomes)
    if (!bindResult.ok) {
      for (const server of servers) server.close()
      return { ok: false, code: bindResult.code, reason: bindResult.reason }
    }

    // ── ⑦ 用**实际端口**重建同源来源表，然后构造路由与 WS ────────
    //
    // 来源表必须用 `boundPort` 而不是请求端口：`--port 0` 时后者恒为 0，
    // 算出来的同源是 `http://127.0.0.1:0`，浏览器发来的每个带 Origin 的请求
    // 都会被判成跨源——症状是"随机端口下全部 403"。
    const cors = resolveCors(options.cors, boundPort)
    if (!cors.ok) {
      for (const item of servers) item.close()
      return { ok: false, code: cors.code, reason: cors.reason }
    }

    pending.stream = new WebSocketStream({
      app,
      auth,
      origins: cors.policy,
      policy,
      connections,
      logger,
      now,
      shuttingDown: () => state.shuttingDown,
    })

    pending.router = new HttpRouter({
      app,
      policy,
      auth,
      origins: cors.policy,
      limiter,
      authFailures,
      staticDir: resolveStaticDir(options.staticDir),
      startedAtMs,
      now,
      logger,
      version: options.version ?? readVersion(),
      shuttingDown: () => state.shuttingDown,
      commands: {
        registry: options.commands?.registry ?? createBuiltinCommandRegistry(),
        host: options.commands?.host ?? new CommandHostAdapter(app),
      },
    })

    // ── ⑧ 输出访问地址（只有真的绑上之后）────────────────────────
    pending.stream.start()
    const primaryUrl = `http://${formatAddress(bindResult.addresses[0] ?? { host: '127.0.0.1', family: 4 })}:${String(boundPort)}`
    for (const line of formatAccessNotice({
      url: primaryUrl,
      token,
      authMode,
      warnings: [...decision.warnings, ...bindResult.warnings],
    }))
      logger.error(line)
    if (cors.policy.extra.length > 0)
      logger.warn(
        `[web-ui] 跨源来源：${cors.policy.extra.join(', ')}（同源：${allowedOriginList(cors.policy).join(', ')}）`,
      )

    const server = new WebServer({
      app,
      servers,
      stream: pending.stream,
      logger,
      disposeApplication: options.disposeApplication ?? true,
      port: boundPort,
      addresses: bindResult.addresses,
      token,
      authMode,
      state,
    })

    return { ok: true, server }
  }

  /**
   * 优雅关闭。**幂等**——重复调用返回同一个报告。
   *
   * 顺序见文件头。每一段等待都有上限：一个卡住的 turn 或客户端不能让进程
   * 永远退不出去。
   */
  async close(): Promise<ShutdownReport> {
    this.#closePromise ??= this.#shutdown()
    return this.#closePromise
  }

  async #shutdown(): Promise<ShutdownReport> {
    const startedAt = Date.now()
    // ① 先拒绝新请求。后面的每一步都建立在这一步之上——若这里没生效，
    // 关闭过程中的新请求会继续驱动一个正在被拆掉的组合根。
    this.#state.shuttingDown = true

    // ② 取消活动 turn。
    let cancelledTurns = 0
    let busy: SessionId[] = []
    try {
      const sessions = await this.#app.listSessions(this.#app.localPrincipalId)
      busy = sessions.filter((session) => this.#app.isBusy(session.id)).map((session) => session.id)
      for (const sessionId of busy)
        if (this.#app.cancelTurn(sessionId, 'server-shutdown')) cancelledTurns += 1
    } catch (error) {
      this.#logger.warn(`[web-ui] 关闭时枚举活动 turn 失败：${String(error)}`)
    }

    // ③ 有界等待 turn 结束。
    let turnsTimedOut = false
    if (busy.length > 0) {
      const settled = Promise.allSettled(busy.map((id) => this.#app.awaitTurn(id))).then(
        () => 'settled' as const,
      )
      const raced = await this.#withTimeout(settled, this.#policy.shutdownGraceMs)
      turnsTimedOut = raced === 'timeout'
    }

    // ④ 落盘。事件日志的写入必须完成，否则恢复时会缺事件。
    const flushed = await this.#withTimeout(this.#app.flush(), this.#policy.shutdownPersistMs)
    const flushTimedOut = flushed === 'timeout'

    // ⑤ 释放组合根。放在 flush 之后——dispose 会关掉事件日志。
    if (this.#disposeApplication) {
      try {
        this.#app.dispose()
      } catch (error) {
        this.#logger.warn(`[web-ui] dispose 失败：${String(error)}`)
      }
    }

    // ⑥ WebSocket 1001。
    this.#stream.closeAll()
    await this.#stream.waitForClose(this.#policy.shutdownPersistMs)
    this.#stream.dispose()

    // ⑦ HTTP server。先停止接受新连接，再在宽限期后强制断开残留连接。
    await Promise.all(this.#servers.map((server) => this.#closeServer(server)))

    return {
      refusedRequests: this.#state.refusedRequests,
      cancelledTurns,
      turnsTimedOut,
      flushTimedOut,
      durationMs: Date.now() - startedAt,
    }
  }

  async #closeServer(server: Server): Promise<void> {
    if (!server.listening) return
    await new Promise<void>((resolve) => {
      const done = (): void => {
        resolve()
      }
      server.close(done)
      server.closeIdleConnections?.()
      const timer = setTimeout(() => {
        // 还有 keep-alive 连接挂着时 `close()` 不会回调。宽限期一到就强制断开。
        server.closeAllConnections?.()
        resolve()
      }, this.#policy.shutdownPersistMs)
      timer.unref?.()
    })
  }

  /** 与超时竞速。返回 `'timeout'` 表示超时（调用方据此记录，**不**因此报错）。 */
  async #withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | 'timeout'> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return 'timeout'
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        resolve('timeout')
      }, timeoutMs)
      timer.unref?.()
    })
    try {
      return await Promise.race([promise, timeout])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
}

/** `server.listen()` 的 promise 包装，解析出该地址族的正确参数。 */
function listenOn(server: Server, address: ListenAddress, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.removeListener('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.removeListener('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen({
      host: address.host,
      port,
      // `family` 与 `host` 同时给出时 Node 会以 host 为准；显式写出来是为了
      // 让 `::` 这类通配地址不会被解析成 IPv4。
      family: address.family,
      exclusive: false,
    })
  })
}

/** 便捷入口：等价于 `WebServer.start(options)`。 */
export function startWebServer(options: WebServerOptions): Promise<WebServerStart> {
  return WebServer.start(options)
}

/** 供 CLI 判断：这个失败是否可以在打印原因后直接退出（恒为真，语义化命名）。 */
export function isStartupFailure(result: WebServerStart): result is WebServerStartFailure {
  return !result.ok
}
