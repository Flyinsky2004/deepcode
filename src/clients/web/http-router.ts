/**
 * HTTP 路由：Web UI 的**唯一**写入口。
 *
 * ## 请求处理顺序（每一步都有理由，不要重排）
 *
 * 1. **安全头**——包括错误响应也要带。少发一次 CSP 就等于那个响应里没有 CSP。
 * 2. **关闭中**→ 503 + `Connection: close`（`parts/09` §1.1 优雅关闭第一步）。
 * 3. **query token 拒绝**——先于凭据校验。带着合法 Bearer 但把 token 塞进 URL
 *    的请求同样拒绝，否则"URL 不含 token"只约束了守规矩的人。
 * 4. **限流**——loopback 与 `/api/health` 除外（本机 Web UI 请求频繁；探活不能被限流）。
 * 5. **健康检查**——token 模式下唯一不需要凭据的 API，响应里没有可泄露的内容。
 * 6. **静态资源**——不鉴权。浏览器导航无法设置请求头，鉴权只能发生在 API 上；
 *    静态文件里也没有任何秘密。
 * 7. **Origin**——写操作必须带且必须通过；`/api/*` 只要带了 Origin 就必须通过。
 * 8. **认证**——`Authorization: Bearer`。默认 local 或 `--auth none` 时直接放行（`public` 下
 *    这条路在启动阶段就已被监听策略堵死）。
 * 9. **路由**——每个 `/api/sessions/:id/...` 都**重新**做一次 `getSession()`
 *    归属校验，不信任 URL 里的 id。
 *
 * ## 两条容易写错的地方
 *
 * - **无权限返回 `SESSION_NOT_FOUND`，不是 `PERMISSION_DENIED`**。后者会告诉
 *   调用方"这个会话确实存在，只是不归你"——在 Web 上那是一个会话枚举接口。
 * - **`POST /api/sessions/:id/turns` 的 turnId 在请求时不可知**（由 runtime
 *   内部按会话自增生成）。所以幂等记录必须先写 `{state:'running'}`，
 *   turn 建好后再改成 `{state:'done', turnId}`。这条正是"刷新页面不会重复
 *   提交 turn"的实现。
 */

import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { ErrorCode, toAgentError } from '../../core/errors.js'
import type { PrincipalId, SessionId, ToolCallId } from '../../core/ids.js'
import { createModelOverrideId } from '../../core/ids.js'
import { MessageRole, MessageSubtype } from '../../core/models.js'
import type { ModelOverride } from '../../core/provider.js'
import { PermissionMode, type GrantScope } from '../../core/tool.js'
import type { CommandHost, CommandResult } from '../../commands/types.js'
import type { CommandRegistry } from '../../commands/registry.js'
import type { AgentApplication } from '../../app/agent-application.js'
import type { PendingApprovalView } from '../../app/approval-broker.js'
import type { PendingUserInputView } from '../../app/user-input-broker.js'
import type { AppPolicy } from '../../app/policy.js'
import type { IdempotencyRecord } from '../../storage/types.js'

import type { AuthService } from './auth.js'
import {
  ALLOWED_HEADERS,
  ALLOWED_METHODS,
  allowedOriginList,
  isApiPath,
  isOriginAllowed,
  securityHeaders,
  type OriginPolicy,
} from './origin.js'
import { checkClientRateLimit, type TokenBucketLimiter } from './rate-limit.js'
import type { WebLogger } from './logger.js'
import {
  redactSecrets,
  toConfigDto,
  toHealthDto,
  toMessageDto,
  toPendingApprovalDto,
  toPendingUserInputDto,
  toSessionDto,
  toTurnResultDto,
} from './dto.js'
import { serveStatic } from './static-files.js'
import { applyConfigAction } from './config-actions.js'

/** 命令执行桥：注册表 + 宿主。由 `server.ts` 装配，**永远存在**。 */
export interface CommandBridge {
  readonly registry: CommandRegistry
  readonly host: CommandHost
}

export interface ProjectBridge {
  list(): Promise<readonly { id: string; path: string; name: string; lastOpenedAt: string }[]>
  open(path: string): Promise<{ id: string; path: string; name: string }>
  browse(
    path?: string,
  ): Promise<{ path: string; parent: string | null; directories: readonly string[] }>
}

/** 路由运行所需的一切。由 `server.ts` 装配。 */
export interface WebContext {
  readonly app: AgentApplication
  readonly policy: AppPolicy
  readonly auth: AuthService
  readonly origins: OriginPolicy
  /** 普通请求限流。 */
  readonly limiter: TokenBucketLimiter
  /** 认证失败限流（`authFailuresPerMinute`）。 */
  readonly authFailures: TokenBucketLimiter
  readonly staticDir: string
  readonly startedAtMs: number
  readonly now: () => number
  readonly logger: WebLogger
  readonly version: string
  readonly shuttingDown: () => boolean
  /**
   * 命令桥。**必填**——`server.ts` 缺省时自动装 `CommandHostAdapter`，
   * 因此不存在"没接上"这个状态。
   *
   * 刻意不给它留一个"缺省即 501"的分支：那会让"忘了注入"与"命令层不支持"
   * 这两种完全不同的情况返回同一个响应，而排查方向截然相反。
   */
  readonly commands: CommandBridge
  readonly projectId?: string
  readonly projects?: ProjectBridge
}

/**
 * 错误码 → HTTP 状态。未登记的一律 500，**不猜**。
 *
 * 分档规则（登记新码时按它判断，别按"像不像"）：
 * - **4xx**：调用方改一改就能成功（参数、权限、状态冲突、能力不匹配）。
 * - **502/503**：**上游**的问题（provider 拒绝、连不上、暂时不可用），
 *   本服务本身是健康的。
 * - **500**：本服务内部出错，或没有更贴切的归类。
 *
 * ⚠️ 两个码的语义必须**分开**，不能合并成同一个 4xx 就了事：
 * `INVALID_COMMAND_ARGUMENTS`（引用写错了）与 `MODEL_CAPABILITY_UNAVAILABLE`
 * （模型存在、但干不了这活）对用户是完全不同的两件事。HTTP 状态可以相同
 * ——客户端本来就该按响应体里的 `error.code` 分支，状态只是粗分类。
 */
const STATUS_BY_CODE: Readonly<Partial<Record<ErrorCode, number>>> = {
  [ErrorCode.VALIDATION_FAILED]: 400,
  [ErrorCode.INVALID_COMMAND_ARGUMENTS]: 400,
  // 模型存在但能力不满足（如不支持工具调用）：请求本身无法被这个模型满足
  [ErrorCode.MODEL_CAPABILITY_UNAVAILABLE]: 400,
  [ErrorCode.CONTEXT_EXCEEDED]: 400,
  [ErrorCode.WEB_AUTH_FAILED]: 401,
  [ErrorCode.PERMISSION_DENIED]: 403,
  [ErrorCode.WEB_ORIGIN_REJECTED]: 403,
  [ErrorCode.SESSION_NOT_FOUND]: 404,
  [ErrorCode.TOOL_NOT_FOUND]: 404,
  [ErrorCode.MODEL_NOT_FOUND]: 404,
  [ErrorCode.SESSION_BUSY]: 409,
  [ErrorCode.INVALID_STATE_TRANSITION]: 409,
  // 客户端给的补发锚点失效：重建视图后重试即可
  [ErrorCode.EVENT_RESYNC_REQUIRED]: 409,
  [ErrorCode.WEB_PAYLOAD_TOO_LARGE]: 413,
  [ErrorCode.WEB_RATE_LIMITED]: 429,
  [ErrorCode.PROVIDER_RATE_LIMITED]: 429,
  [ErrorCode.BUDGET_EXCEEDED]: 429,
  [ErrorCode.COMMAND_NOT_AVAILABLE]: 501,
  // 上游（provider）的问题——本服务是好的，502 才是准确的说法，
  // 用 401 会把"供应商凭据失效"说成"你的凭据不对"。
  [ErrorCode.PROVIDER_AUTH_FAILED]: 502,
  [ErrorCode.PROVIDER_CONNECTION_FAILED]: 502,
  [ErrorCode.PROVIDER_STREAM_INVALID]: 502,
  [ErrorCode.PROVIDER_UNAVAILABLE]: 503,
  [ErrorCode.WEB_CONNECTION_LIMIT]: 503,
  [ErrorCode.EVENT_STREAM_BACKPRESSURE]: 503,
  [ErrorCode.WEB_SHUTTING_DOWN]: 503,
}

/** 该错误码对应的 HTTP 状态。 */
export function statusForCode(code: ErrorCode): number {
  return STATUS_BY_CODE[code] ?? 500
}

interface JsonBody {
  readonly [key: string]: unknown
}

/** 读取请求体的结果。 */
type BodyResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly code: ErrorCode; readonly reason: string }

/**
 * 流式读取请求体，**超限立即中止**。
 *
 * 这里刻意**不用** `for await (const chunk of req)`：在 `for await` 里 `return`
 * 会调用迭代器的 `return()`，而它对可读流的实现是 `destroy()`——socket 会被
 * 立刻销毁，413 响应根本发不出去。改成显式事件 + `pause()` 后，"停止读取"
 * 与"写响应"两件事的顺序才由我们掌握。
 */
function readBody(req: IncomingMessage, limit: number): Promise<BodyResult> {
  return new Promise<BodyResult>((resolve) => {
    const chunks: Buffer[] = []
    let total = 0
    let settled = false

    const settle = (result: BodyResult): void => {
      if (settled) return
      settled = true
      resolve(result)
    }

    req.on('data', (chunk: Buffer) => {
      total += chunk.byteLength
      if (total > limit) {
        // 立刻停止读取：剩余字节不再进入内存。
        // 响应与销毁交给调用方——它才知道 socket 当前的状态。
        req.pause()
        settle({
          ok: false,
          code: ErrorCode.WEB_PAYLOAD_TOO_LARGE,
          reason: `请求体超过上限 ${String(limit)} 字节`,
        })
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      settle({ ok: true, text: Buffer.concat(chunks).toString('utf8') })
    })
    req.on('error', () => {
      settle({ ok: false, code: ErrorCode.VALIDATION_FAILED, reason: '读取请求体失败' })
    })
    req.on('aborted', () => {
      settle({ ok: false, code: ErrorCode.VALIDATION_FAILED, reason: '客户端提前断开' })
    })
  })
}

/** 幂等记录里 `response` 的形状（`POST /turns` 用）。 */
interface TurnIdempotencyResponse {
  readonly state: 'running' | 'done'
  readonly turnId?: string
  readonly result?: unknown
  readonly code?: string
  readonly message?: string
}

export class HttpRouter {
  readonly #ctx: WebContext

  constructor(context: WebContext) {
    this.#ctx = context
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const isApi = isApiPath(url.pathname)

    for (const [name, value] of Object.entries(securityHeaders({ isApi }))) {
      res.setHeader(name, value)
    }

    // ① 优雅关闭：先拒绝新请求，并让连接在响应后关闭。
    if (this.#ctx.shuttingDown()) {
      res.setHeader('Connection', 'close')
      sendError(res, 503, ErrorCode.WEB_SHUTTING_DOWN, '服务正在关闭，请稍后重试')
      return
    }

    // ② query string 里的凭据。**先于认证**，见文件头说明。
    const queryFailure = this.#ctx.auth.checkQueryString(url.searchParams, url.pathname)
    if (queryFailure) {
      res.setHeader('Connection', 'close')
      sendError(res, 401, queryFailure.code, queryFailure.reason)
      return
    }

    // ③ 限流。本机访问与健康检查豁免；只按 socket.remoteAddress 判断本机。
    if (url.pathname !== '/api/health') {
      const decision = checkClientRateLimit(this.#ctx.limiter, req.socket.remoteAddress)
      if (decision !== undefined && !decision.ok) {
        const retryAfterSec = Number.isFinite(decision.retryAfterMs)
          ? Math.ceil(decision.retryAfterMs / 1000)
          : 60
        res.setHeader('Retry-After', String(retryAfterSec))
        sendError(res, 429, ErrorCode.WEB_RATE_LIMITED, '请求过于频繁')
        return
      }
    }

    // ④ 健康检查。
    //
    // token 模式下它是**唯一**不需要凭据的 API：响应里只有 `ok` / `version` / `uptimeMs`
    // 三个字段，没有任何配置、密钥或路径（规格明列要求）。放在这里而不是
    // 鉴权之后，是因为"探活不需要 token"与上一步"探活不被限流"必须是
    // 同一条策略——否则编排系统会先被 401 判死，再被 429 判死。
    if (url.pathname === '/api/health' && (req.method === 'GET' || req.method === 'HEAD')) {
      sendJson(
        res,
        200,
        toHealthDto({
          version: this.#ctx.version,
          uptimeMs: this.#ctx.now() - this.#ctx.startedAtMs,
        }),
      )
      return
    }

    // ⑤ 静态资源。不鉴权（浏览器导航无法带请求头），仍受 CSP 约束。
    if (!isApi) {
      await serveStatic(req, res, url.pathname, this.#ctx.staticDir)
      return
    }

    // ⑥ Origin。写操作必须带；读取只要带了就必须合法。
    const origin = headerValue(req.headers.origin)
    const isWrite = req.method !== 'GET' && req.method !== 'HEAD'
    if (isWrite && origin === undefined) {
      sendError(
        res,
        403,
        ErrorCode.WEB_ORIGIN_REJECTED,
        '写操作必须携带 Origin 请求头（CSRF 防护）',
      )
      return
    }
    if (origin !== undefined && !isOriginAllowed(origin, this.#ctx.origins)) {
      this.#ctx.logger.warn(
        `[web] 拒绝来源 ${origin}（允许：${allowedOriginList(this.#ctx.origins).join(', ')}）`,
      )
      sendError(res, 403, ErrorCode.WEB_ORIGIN_REJECTED, '来源未被允许')
      return
    }

    // ⑦ CORS preflight。只有通过上面校验的来源才会走到这里。
    if (req.method === 'OPTIONS') {
      if (origin !== undefined) this.#writeCorsHeaders(res, origin)
      res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS)
      res.setHeader('Access-Control-Allow-Headers', ALLOWED_HEADERS)
      res.setHeader('Access-Control-Max-Age', '600')
      res.statusCode = 204
      res.end()
      return
    }

    //  认证。
    const auth = this.#ctx.auth.authenticateBearer(
      headerValue(req.headers.authorization),
      url.pathname,
    )
    if (!auth.ok) {
      const failures = checkClientRateLimit(this.#ctx.authFailures, req.socket.remoteAddress)
      if (failures !== undefined && !failures.ok) {
        res.setHeader('Connection', 'close')
        res.setHeader('Retry-After', '60')
        sendError(res, 429, ErrorCode.WEB_RATE_LIMITED, '认证失败次数过多')
        return
      }
      res.setHeader('WWW-Authenticate', 'Bearer')
      sendError(res, 401, auth.code, auth.reason)
      return
    }

    if (origin !== undefined) this.#writeCorsHeaders(res, origin)

    try {
      await this.#route(req, res, url, auth.principalId)
    } catch (error) {
      const agentError = toAgentError(error, 'web.http')
      // 详细诊断进服务端日志，响应里只给稳定错误码与可读信息（§1.1）。
      this.#ctx.logger.error(
        `[web] ${req.method ?? 'GET'} ${url.pathname} 失败：${agentError.code} ${agentError.message}`,
      )
      if (!res.headersSent)
        sendError(res, statusForCode(agentError.code), agentError.code, agentError.message)
      else res.end()
    }
  }

  // ── 路由表 ──────────────────────────────────────────────────────

  async #route(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    principalId: PrincipalId,
  ): Promise<void> {
    const method = req.method ?? 'GET'
    const segments = url.pathname.split('/').filter((segment) => segment !== '')

    if (url.pathname === '/api/projects' && method === 'GET' && this.#ctx.projects)
      return sendJson(res, 200, { projects: await this.#ctx.projects.list() })
    if (url.pathname === '/api/directories' && method === 'GET' && this.#ctx.projects)
      return sendJson(
        res,
        200,
        await this.#ctx.projects.browse(url.searchParams.get('path') ?? undefined),
      )
    if (url.pathname === '/api/projects/open' && method === 'POST' && this.#ctx.projects) {
      const key = this.#requireIdempotencyKey(req, res)
      if (key === undefined) return
      const body = await this.#readJsonBody(req, res)
      if (body === undefined) return
      if (typeof body['path'] !== 'string' || body['path'].trim() === '')
        return sendError(res, 400, ErrorCode.VALIDATION_FAILED, '项目路径不能为空')
      return sendJson(res, 200, await this.#ctx.projects.open(body['path']))
    }

    const selected = headerValue(req.headers['x-deepcode-project'])
    if (
      selected !== undefined &&
      this.#ctx.projectId !== undefined &&
      selected !== this.#ctx.projectId
    )
      return sendError(res, 404, ErrorCode.SESSION_NOT_FOUND, '项目未打开')

    // /api/config
    if (method === 'GET' && url.pathname === '/api/config') {
      return sendJson(res, 200, toConfigDto(await this.#ctx.app.configStore.read()))
    }
    if (method === 'POST' && url.pathname === '/api/config') {
      const key = this.#requireIdempotencyKey(req, res)
      if (key === undefined) return
      const body = await this.#readJsonBody(req, res)
      if (body === undefined) return
      return this.#withIdempotency(
        res,
        { principalId, routeKey: 'config', idempotencyKey: key, payload: body },
        async () => {
          await applyConfigAction(this.#ctx.app, body)
          return { status: 200, body: toConfigDto(await this.#ctx.app.configStore.read()) }
        },
      )
    }

    // /api/pending
    if (method === 'GET' && url.pathname === '/api/pending') {
      const approvals = await this.#visibleApprovals(principalId)
      const inputs = await this.#visibleUserInputs(principalId)
      return sendJson(res, 200, {
        approvals: approvals.map(toPendingApprovalDto),
        userInputs: inputs.map(toPendingUserInputDto),
      })
    }

    // /api/ws-ticket
    if (method === 'POST' && url.pathname === '/api/ws-ticket') {
      return this.#handleWsTicket(req, res)
    }

    // /api/sessions
    if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'sessions') {
      if (method === 'GET') {
        const sessions = await this.#ctx.app.listSessions(principalId)
        const webSessionIds = new Set(
          sessions.filter((session) => session.title === 'Web 会话').map((session) => session.id),
        )
        const firstUserMessages = new Map<SessionId, { content: string; createdAt: string }>()
        if (webSessionIds.size > 0) {
          const document = await this.#ctx.app.chatStore.read()
          for (const message of document.messages) {
            if (
              !webSessionIds.has(message.conversation_id) ||
              message.role !== MessageRole.USER ||
              message.subtype !== MessageSubtype.NORMAL ||
              message.content.trim() === ''
            )
              continue
            const first = firstUserMessages.get(message.conversation_id)
            if (!first || message.created_at < first.createdAt)
              firstUserMessages.set(message.conversation_id, {
                content: message.content,
                createdAt: message.created_at,
              })
          }
        }
        return sendJson(res, 200, {
          sessions: sessions.map((session) =>
            toSessionDto(session, firstUserMessages.get(session.id)?.content),
          ),
        })
      }
      if (method === 'POST') return this.#handleCreateSession(req, res, principalId)
    }

    // /api/sessions/:id/turns
    if (
      segments.length === 4 &&
      segments[0] === 'api' &&
      segments[1] === 'sessions' &&
      segments[3] === 'turns'
    ) {
      const sessionId = segments[2] as SessionId
      if (method === 'POST') return this.#handleSubmitTurn(req, res, principalId, sessionId)
    }

    // /api/sessions/:id/messages
    if (
      segments.length === 4 &&
      segments[0] === 'api' &&
      segments[1] === 'sessions' &&
      segments[3] === 'messages'
    ) {
      const sessionId = segments[2] as SessionId
      if (method === 'GET') return this.#handleMessages(res, principalId, sessionId)
    }

    // /api/commands
    if (method === 'GET' && url.pathname === '/api/commands')
      return sendJson(res, 200, {
        commands: this.#ctx.commands.registry.list().map((definition) => ({
          name: definition.name,
          aliases: definition.aliases ?? [],
          description: definition.description,
          parameters: definition.parameters.positionals.map((item) => ({
            name: item.name,
            required: item.required,
            description: item.description,
          })),
        })),
      })
    if (method === 'POST' && url.pathname === '/api/commands')
      return this.#handleCommand(req, res, principalId)

    // /api/permissions/:id
    if (
      segments.length === 3 &&
      segments[0] === 'api' &&
      segments[1] === 'permissions' &&
      method === 'POST'
    ) {
      return this.#handlePermission(req, res, principalId, segments[2] ?? '')
    }

    // /api/user-inputs/:id
    if (
      segments.length === 3 &&
      segments[0] === 'api' &&
      segments[1] === 'user-inputs' &&
      method === 'POST'
    ) {
      return this.#handleUserInput(req, res, principalId, segments[2] ?? '')
    }

    // /api/turns/:id/cancel
    if (
      segments.length === 4 &&
      segments[0] === 'api' &&
      segments[1] === 'turns' &&
      segments[3] === 'cancel' &&
      method === 'POST'
    ) {
      return this.#handleCancel(req, res, principalId, segments[2] ?? '')
    }

    // /api/events —— SSE 是规格里的可选实现。这里**明确**回 501 而不是
    // 返回一个空流：空流会让客户端以为"连上了但没有事件"，永远等下去。
    if (url.pathname === '/api/events') {
      return sendError(
        res,
        501,
        ErrorCode.COMMAND_NOT_AVAILABLE,
        'SSE 未实现，请使用 WebSocket /api/stream',
      )
    }

    sendError(res, 404, ErrorCode.SESSION_NOT_FOUND, `未知接口：${method} ${url.pathname}`)
  }

  // ── 具体处理器 ──────────────────────────────────────────────────

  /**
   * `POST /api/ws-ticket`。
   *
   * ⚠️ 必须带 `Idempotency-Key`（与所有 POST 一致），但**刻意不写幂等记录**：
   * 记录会被写进 `chat.json`，而响应体里是一张凭据。把凭据落盘违背
   * "token 不落盘"的初衷——`chat.json` 是明文 JSON，任何能读工作区的人都能捡走。
   * 重试只会签发一张新 ticket，语义上完全等价。
   */
  #handleWsTicket(req: IncomingMessage, res: ServerResponse): void {
    const key = this.#requireIdempotencyKey(req, res)
    if (key === undefined) return

    const origin = headerValue(req.headers.origin) ?? this.#ctx.origins.sameOrigin[0] ?? ''
    const { ticket, expiresAtMs } = this.#ctx.auth.issueTicket(origin)
    sendJson(res, 201, { ticket, expiresAt: new Date(expiresAtMs).toISOString(), origin })
  }

  async #handleCreateSession(
    req: IncomingMessage,
    res: ServerResponse,
    principalId: PrincipalId,
  ): Promise<void> {
    const key = this.#requireIdempotencyKey(req, res)
    if (key === undefined) return

    const body = await this.#readJsonBody(req, res)
    if (body === undefined) return

    const title = typeof body['title'] === 'string' ? body['title'] : undefined
    return this.#withIdempotency(
      res,
      { principalId, routeKey: 'create-session', idempotencyKey: key, payload: { title } },
      async () => {
        const created = await this.#ctx.app.createSession(principalId, title)
        return { status: 201, body: { sessionId: created.id } }
      },
    )
  }

  async #handleMessages(
    res: ServerResponse,
    principalId: PrincipalId,
    sessionId: SessionId,
  ): Promise<void> {
    // 归属校验：不信任 URL 里的 session id（§1.1）。
    await this.#ctx.app.getSession(principalId, sessionId)
    const messages = await this.#ctx.app.chatStore.listMessages(sessionId)
    return sendJson(res, 200, { messages: messages.map(toMessageDto) })
  }

  /**
   * `POST /api/sessions/:id/turns`。
   *
   * ️ 这个处理器的顺序与其它写操作**不同**，原因是 turnId 在请求时不可知：
   * `{state:'running'}` 必须在 `submitTurn()` **之前**落盘，否则两个并发的
   * 同 key 请求会双双通过幂等检查，白跑两次模型调用。
   */
  async #handleSubmitTurn(
    req: IncomingMessage,
    res: ServerResponse,
    principalId: PrincipalId,
    sessionId: SessionId,
  ): Promise<void> {
    const key = this.#requireIdempotencyKey(req, res)
    if (key === undefined) return

    const body = await this.#readJsonBody(req, res)
    if (body === undefined) return

    const prompt = body['prompt']
    if (typeof prompt !== 'string' || prompt.trim() === '') {
      return sendError(res, 400, ErrorCode.VALIDATION_FAILED, 'prompt 必须是非空字符串')
    }
    const mode = body['mode']
    if (mode !== undefined && !Object.values(PermissionMode).includes(mode as PermissionMode))
      return sendError(res, 400, ErrorCode.VALIDATION_FAILED, '无效的权限模式')

    const override = this.#parseOverride(body['override'], prompt, principalId)
    if (override === 'invalid')
      return sendError(
        res,
        400,
        ErrorCode.VALIDATION_FAILED,
        'override 必须是 {providerId, modelId}',
      )

    // 归属校验必须在写幂等记录之前：不让无权限的请求在 chat.json 里留痕。
    await this.#ctx.app.getSession(principalId, sessionId)

    const idempotencyKey = this.#scopedKey(principalId, `turn:${sessionId}`, key)
    const requestHash = hashOf({ prompt, override: override ?? null, mode: mode ?? null })

    const prior = await this.#ctx.app.chatStore.getIdempotency(idempotencyKey)
    if (prior) {
      if (prior.requestHash !== requestHash)
        return sendError(
          res,
          409,
          ErrorCode.INVALID_STATE_TRANSITION,
          '同一个幂等键被用于了不同的请求内容',
        )
      const stored = prior.response as TurnIdempotencyResponse
      if (stored.state === 'running') {
        // 并发的同 key 请求：turn 已经有人在跑，告诉调用方"去看事件流"。
        res.statusCode = 202
        res.setHeader('Idempotent-Replay', 'true')
        return sendJson(res, 202, { sessionId, state: 'running' })
      }
      res.setHeader('Idempotent-Replay', 'true')
      return sendJson(res, 200, { sessionId, ...stored })
    }

    await this.#ctx.app.chatStore.putIdempotency({
      key: idempotencyKey,
      operation: 'web:turn',
      requestHash,
      response: { state: 'running' } satisfies TurnIdempotencyResponse,
      createdAt: this.#nowIso(),
    })

    try {
      const submitted = await this.#ctx.app.submitTurn({
        principalId,
        sessionId,
        prompt,
        ...(override === undefined ? {} : { override }),
        ...(mode === undefined ? {} : { mode: mode as PermissionMode }),
      })
      const payload = {
        state: 'done' as const,
        turnId: submitted.turnId,
        result: toTurnResultDto(submitted.result),
      }
      await this.#ctx.app.chatStore.putIdempotency({
        key: idempotencyKey,
        operation: 'web:turn',
        requestHash,
        response: payload,
        createdAt: this.#nowIso(),
      })
      return sendJson(res, 200, { requestId: key, sessionId, ...payload })
    } catch (error) {
      // ️ 失败时**删除**占位记录，而不是写成 `{state:'failed'}`。
      //
      // 写失败会让"SESSION_BUSY 之后再重试"永远回放同一个失败——用户看到的是
      // "刷新了页面还是提示会话忙"，而实际上会话早就空了。
      await this.#dropIdempotency(idempotencyKey)
      const agentError = toAgentError(error, 'web.turn')
      if (res.headersSent) {
        res.end()
        return
      }
      return sendError(res, statusForCode(agentError.code), agentError.code, agentError.message)
    }
  }

  async #handleCancel(
    req: IncomingMessage,
    res: ServerResponse,
    principalId: PrincipalId,
    turnId: string,
  ): Promise<void> {
    const key = this.#requireIdempotencyKey(req, res)
    if (key === undefined) return

    const body = await this.#readJsonBody(req, res)
    if (body === undefined) return

    // `cancelTurn()` 以 session 为键（abort controller 也是按 session 建的），
    // 所以要把 URL 里的 turnId 还原成 session。允许调用方直接给 sessionId
    // 以避免全表扫描。
    const sessionId =
      typeof body['sessionId'] === 'string'
        ? (body['sessionId'] as SessionId)
        : await this.#locateTurn(principalId, turnId)

    if (sessionId === undefined)
      return sendError(res, 404, ErrorCode.SESSION_NOT_FOUND, '未找到该 turn')

    await this.#ctx.app.getSession(principalId, sessionId)
    const cancelled = this.#ctx.app.cancelTurn(sessionId, 'user')
    return sendJson(res, 200, { turnId, sessionId, cancelled })
  }

  async #handlePermission(
    req: IncomingMessage,
    res: ServerResponse,
    principalId: PrincipalId,
    requestId: string,
  ): Promise<void> {
    const key = this.#requireIdempotencyKey(req, res)
    if (key === undefined) return

    const body = await this.#readJsonBody(req, res)
    if (body === undefined) return

    const decision = body['decision']
    if (decision !== 'allow' && decision !== 'deny')
      return sendError(res, 400, ErrorCode.VALIDATION_FAILED, "decision 必须是 'allow' 或 'deny'")

    // 归属校验：先看这个 requestId 是否挂在某个待审批项上，再校验那个会话。
    // 已结束的请求走 broker 自己的幂等回放路径（返回 duplicate），
    // 那条路径不需要这里再判一次权限——它只会回放"已经发生过的决议"。
    const pending = (await this.#visibleApprovals(principalId)).find(
      (view) => view.requestId === requestId,
    )
    if (pending) await this.#ctx.app.getSession(principalId, pending.sessionId as SessionId)

    // 授权范围由服务端依据待审批请求构造，客户端不能指定工具名或期限。
    const rawScope = body['grantScope']
    if (decision === 'deny' && rawScope !== undefined && rawScope !== null)
      return sendError(res, 400, ErrorCode.VALIDATION_FAILED, '拒绝操作不能附带授权范围')
    let grantScope: GrantScope | undefined
    if (rawScope === 'once' || rawScope === 'allow-once') {
      if (pending === undefined)
        return sendError(
          res,
          409,
          ErrorCode.INVALID_STATE_TRANSITION,
          '该审批请求已结束，无法建立一次性授权；请直接提交 allow/deny',
        )
      grantScope = { kind: 'allow-once', toolCallId: pending.toolCallId as ToolCallId }
    } else if (rawScope === 'tool') {
      if (pending === undefined)
        return sendError(res, 409, ErrorCode.INVALID_STATE_TRANSITION, '该审批请求已结束')
      grantScope = {
        kind: 'tool',
        toolName: pending.toolName,
        sessionId: pending.sessionId as SessionId,
        expiresAt: this.#ctx.app.grantExpiresAt(),
      }
    } else if (rawScope !== undefined && rawScope !== null) {
      return sendError(res, 400, ErrorCode.VALIDATION_FAILED, "grantScope 仅支持 'once' 或 'tool'")
    }

    const result = await this.#ctx.app.resolvePermission({
      requestId,
      decision,
      principalId,
      ...(grantScope === undefined ? {} : { grantScope }),
      ...(typeof body['reason'] === 'string' ? { reason: body['reason'] } : {}),
    })

    if (!result.ok) return sendError(res, statusForCode(result.code), result.code, result.message)
    return sendJson(res, 200, {
      ok: true,
      duplicate: result.duplicate,
      requestId,
      decision: result.resolution.decision,
      resolvedBy: result.resolution.resolvedBy,
    })
  }

  async #handleUserInput(
    req: IncomingMessage,
    res: ServerResponse,
    principalId: PrincipalId,
    requestId: string,
  ): Promise<void> {
    const key = this.#requireIdempotencyKey(req, res)
    if (key === undefined) return

    const body = await this.#readJsonBody(req, res)
    if (body === undefined) return

    const rawAnswers = body['answers']
    let answers: readonly (readonly string[])[] | null = null
    if (rawAnswers !== null && rawAnswers !== undefined) {
      if (!Array.isArray(rawAnswers))
        return sendError(res, 400, ErrorCode.VALIDATION_FAILED, 'answers 必须是数组或 null')
      answers = rawAnswers.map((entry) =>
        Array.isArray(entry) ? entry.map((item) => String(item)) : [String(entry)],
      )
    }

    const pending = (await this.#visibleUserInputs(principalId)).find(
      (view) => view.requestId === requestId,
    )
    if (pending) await this.#ctx.app.getSession(principalId, pending.sessionId as SessionId)

    const result = await this.#ctx.app.answerUserInput({ requestId, answers, principalId })
    if (!result.ok) return sendError(res, statusForCode(result.code), result.code, result.message)
    return sendJson(res, 200, { ok: true, duplicate: result.duplicate, requestId })
  }

  async #handleCommand(
    req: IncomingMessage,
    res: ServerResponse,
    principalId: PrincipalId,
  ): Promise<void> {
    const key = this.#requireIdempotencyKey(req, res)
    if (key === undefined) return

    const body = await this.#readJsonBody(req, res)
    if (body === undefined) return

    const bridge = this.#ctx.commands

    const raw = body['command']
    if (typeof raw !== 'string' || raw.trim() === '')
      return sendError(res, 400, ErrorCode.VALIDATION_FAILED, 'command 必须是非空字符串')

    const rawSessionId = body['sessionId']
    const sessionId = typeof rawSessionId === 'string' ? (rawSessionId as SessionId) : undefined
    // 命令可能带着 session 副作用（写 transcript），归属校验不能省。
    if (sessionId !== undefined) await this.#ctx.app.getSession(principalId, sessionId)

    const result: CommandResult = await bridge.registry.execute(
      {
        raw,
        principalId,
        ...(sessionId === undefined ? {} : { sessionId }),
        signal: AbortSignal.timeout(this.#ctx.policy.toolTimeoutMs),
        idempotencyKey: key,
        confirmInterrupt: body['confirmInterrupt'] === true,
      },
      bridge.host,
    )

    // `result.data` 是命令自定义的结构化数据（`/workwith` 的模型列表、
    // 配置面板等），形状不可穷举——那里最可能夹带 `CommandConfigView.raw`
    // 这样的整份配置文档。所以整体过一遍密钥脱敏再发出去。
    const errorCode = result.ok ? ErrorCode.INTERNAL_ERROR : commandErrorCode(result)
    return sendJson(res, result.ok ? 200 : statusForCode(errorCode), {
      requestId: key,
      sessionId: sessionId ?? null,
      ...(redactSecrets(result) as Record<string, unknown>),
      // 失败时**额外**补上统一的错误信封：命令自己的 `ok/code/text`
      // 是给命令面板用的，而客户端通用的错误处理只认 `error.code`。
      // 只给前者会让"命令失败"在通用路径上表现为一个没有错误码的成功响应。
      ...(result.ok ? {} : { error: { code: errorCode, message: result.text } }),
    })
  }

  // ── 幂等 ────────────────────────────────────────────────────────

  /** 所有写操作的幂等键。缺失 → 400 并返回 `undefined`。 */
  #requireIdempotencyKey(req: IncomingMessage, res: ServerResponse): string | undefined {
    const raw = headerValue(req.headers['idempotency-key'])
    if (raw === undefined || raw.trim() === '') {
      sendError(res, 400, ErrorCode.VALIDATION_FAILED, '缺少 Idempotency-Key 请求头')
      return undefined
    }
    return raw.trim()
  }

  /**
   * 幂等键的作用域。
   *
   * `Idempotency-Key` 是客户端自由选择的字符串，加上 principal 与路由前缀后
   * 才不会出现"两个用户恰好用了同一个键"互相回放对方结果的情况。
   */
  #scopedKey(principalId: PrincipalId, routeKey: string, key: string): string {
    return `web:${principalId}:${routeKey}:${key}`
  }

  async #withIdempotency(
    res: ServerResponse,
    input: {
      readonly principalId: PrincipalId
      readonly routeKey: string
      readonly idempotencyKey: string
      readonly payload: unknown
    },
    action: () => Promise<{ readonly status: number; readonly body: unknown }>,
  ): Promise<void> {
    const key = this.#scopedKey(input.principalId, input.routeKey, input.idempotencyKey)
    const requestHash = hashOf(input.payload)

    const prior: IdempotencyRecord | undefined = await this.#ctx.app.chatStore.getIdempotency(key)
    if (prior) {
      if (prior.requestHash !== requestHash) {
        sendError(
          res,
          409,
          ErrorCode.INVALID_STATE_TRANSITION,
          '同一个幂等键被用于了不同的请求内容',
        )
        return
      }
      res.setHeader('Idempotent-Replay', 'true')
      sendJson(res, 200, prior.response)
      return
    }

    const outcome = await action()
    await this.#ctx.app.chatStore.putIdempotency({
      key,
      operation: `web:${input.routeKey}`,
      requestHash,
      response: outcome.body,
      createdAt: this.#nowIso(),
    })
    sendJson(res, outcome.status, outcome.body)
  }

  /** 删除一条幂等记录。`ChatStore` 没有删除 API，用不可变更新完成。 */
  async #dropIdempotency(key: string): Promise<void> {
    await this.#ctx.app.chatStore.update((doc) => {
      const kept = doc.runtime.idempotency.filter((record) => record.key !== key)
      if (kept.length === doc.runtime.idempotency.length) return doc
      return {
        ...doc,
        runtime: {
          ...doc.runtime,
          idempotency: kept,
          revision: doc.runtime.revision + 1,
        },
      }
    })
  }

  // ── 工具 ────────────────────────────────────────────────────────

  async #readJsonBody(req: IncomingMessage, res: ServerResponse): Promise<JsonBody | undefined> {
    const body = await readBody(req, this.#ctx.policy.httpBodyLimitBytes)
    if (!body.ok) {
      // 超限时先让 413 发出去，再销毁 socket：反过来做的话响应到不了客户端。
      res.setHeader('Connection', 'close')
      sendError(res, statusForCode(body.code), body.code, body.reason)
      res.once('finish', () => {
        req.destroy()
      })
      return undefined
    }

    if (body.text.trim() === '') return {}
    try {
      const parsed: unknown = JSON.parse(body.text)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        sendError(res, 400, ErrorCode.VALIDATION_FAILED, '请求体必须是 JSON 对象')
        return undefined
      }
      return parsed as JsonBody
    } catch {
      sendError(res, 400, ErrorCode.VALIDATION_FAILED, '请求体不是合法 JSON')
      return undefined
    }
  }

  /** 该 principal 可见的待审批项（按会话过滤，不泄露别人的会话是否存在）。 */
  async #visibleApprovals(principalId: PrincipalId): Promise<readonly PendingApprovalView[]> {
    const accessible = await this.#accessibleSessions(principalId)
    return this.#ctx.app.listPendingApprovals().filter((view) => accessible.has(view.sessionId))
  }

  async #visibleUserInputs(principalId: PrincipalId): Promise<readonly PendingUserInputView[]> {
    const accessible = await this.#accessibleSessions(principalId)
    return this.#ctx.app.listPendingUserInputs().filter((view) => accessible.has(view.sessionId))
  }

  async #accessibleSessions(principalId: PrincipalId): Promise<Set<string>> {
    const sessions = await this.#ctx.app.listSessions(principalId)
    return new Set(sessions.map((session) => session.id as string))
  }

  /**
   * 从 turnId 反查 sessionId。
   *
   * 只能遍历调用方**有权访问**的会话去问"你当前的 turn 是哪个"——
   * turn ID 由 runtime 在 `beginTurn` 时生成，请求到达时它还不存在，
   * 因此没有 turnId → sessionId 的直接索引。
   *
   * 用 `currentTurnId()` 而不是读 `chat.json` 的 turn 表：后者会把**已结束**的
   * turn 也算进来，于是取消一个早就跑完的 turn 也可能匹配上、并转而去取消
   * 那个会话此刻真正在跑的另一个 turn。`currentTurnId()` 只看活跃 phase。
   */
  async #locateTurn(principalId: PrincipalId, turnId: string): Promise<SessionId | undefined> {
    const sessions = await this.#ctx.app.listSessions(principalId)
    for (const session of sessions) {
      const active = await this.#ctx.app.currentTurnId(session.id)
      if (active === turnId) return session.id
    }
    return undefined
  }

  #parseOverride(
    value: unknown,
    instruction: string,
    principalId: PrincipalId,
  ): ModelOverride | 'invalid' | undefined {
    if (value === undefined || value === null) return undefined
    if (typeof value !== 'object' || Array.isArray(value)) return 'invalid'
    const record = value as Record<string, unknown>
    const providerId = record['providerId']
    const modelId = record['modelId']
    if (typeof providerId !== 'string' || typeof modelId !== 'string') return 'invalid'
    if (providerId === '' || modelId === '') return 'invalid'

    return {
      overrideId: createModelOverrideId(),
      scope: 'next-turn',
      providerId,
      modelId,
      requestedBy: principalId,
      instruction,
      createdAt: this.#nowIso(),
    }
  }

  #writeCorsHeaders(res: ServerResponse, origin: string): void {
    // 回显具体来源而**不是** `*`：`*` 与凭据、与"仅同源"的默认策略都不相容。
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
  }

  #nowIso(): string {
    return new Date(this.#ctx.now()).toISOString()
  }
}

// ── 辅助函数 ──────────────────────────────────────────────────────

function headerValue(value: string | readonly string[] | undefined): string | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string') return value
  return value[0]
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body) ?? 'null'
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Content-Length', Buffer.byteLength(payload))
  res.end(payload)
}

function sendError(res: ServerResponse, status: number, code: ErrorCode, message: string): void {
  sendJson(res, status, { error: { code, message } })
}

/**
 * 请求体的规范化哈希。
 *
 * 用 `JSON.stringify` 即可：调用方传进来的都是**我们自己构造的**小对象
 * （字段顺序稳定），不是用户的原始字节。对原始 body 做哈希会把
 * `{"a":1,"b":2}` 与 `{"b":2,"a":1}` 判成两个请求，而它们的语义相同。
 */
function hashOf(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value) ?? '', 'utf8')
    .digest('hex')
}

/**
 * 失败的命令结果 → 稳定错误码。
 *
 * ️ 不能只看 `result.errorCode`：它是**可选字段**，而 `CommandDefinition.execute`
 * 有多条 `ok: false` 的返回路径没有填它（例如 `/workwith` 的模型引用解析失败）。
 * 直接 `?? INTERNAL_ERROR` 会把"参数写错了"报成 500——用户拿到一个既是服务器
 * 错误、又没有任何可操作信息的响应。
 *
 * 因此优先用命令层**一定**会填的 `CommandResultCode` 派生。
 */
function commandErrorCode(result: CommandResult): ErrorCode {
  if (result.errorCode !== undefined) return result.errorCode
  switch (result.code) {
    case 'invalid_arguments':
      return ErrorCode.INVALID_COMMAND_ARGUMENTS
    case 'permission_denied':
      return ErrorCode.PERMISSION_DENIED
    case 'session_busy':
      return ErrorCode.SESSION_BUSY
    case 'not_available':
      return ErrorCode.COMMAND_NOT_AVAILABLE
    default:
      return ErrorCode.INTERNAL_ERROR
  }
}
