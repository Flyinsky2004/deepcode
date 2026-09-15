/**
 * Web 层测试的共享装配。
 *
 * ## 为什么这些测试都用**真的** HTTP / WebSocket
 *
 * 这一层的绝大部分缺陷只在真实传输上才出现：请求体分块到达的顺序、
 * `Origin` 头的有无、升级握手的时序、socket 被销毁时响应还能不能发出去。
 * 用 `node:http` + 真 `fetch` + 真 `ws` 客户端的成本只是几十毫秒，
 * 换来的是"测试通过"真的等价于"浏览器能用"。
 *
 * 唯一被替换掉的是**模型 provider**——那是唯一需要网络与凭据的部分。
 */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AgentApplication } from '../../src/app/agent-application.js'
import { ChatStore } from '../../src/storage/chat-store.js'
import { ConfigStore } from '../../src/storage/config-store.js'
import { resolveAppPaths } from '../../src/storage/paths.js'
import { ToolRegistry } from '../../src/tools/registry.js'
import { ModelEventType, type Provider } from '../../src/core/provider.js'
import type { ConfigDocument } from '../../src/storage/types.js'
import type { SessionId } from '../../src/core/ids.js'
import type { AppPolicy } from '../../src/app/policy.js'
import { ListenScope, AuthMode } from '../../src/clients/web/listen-policy.js'
import { WebServer, type WebServerOptions } from '../../src/clients/web/server.js'
import { MemoryLogger } from '../../src/clients/web/logger.js'

const provider: Provider = {
  id: 'p',
  name: 'test',
  baseUrl: 'https://api.anthropic.com',
  apiKeyRef: { source: 'env', key: 'TEST_KEY' },
  createdAt: '',
  updatedAt: '',
}

/** 一份可用的最小配置。`mutate` 用来往里塞测试专属内容（例如假密钥）。 */
export function testConfig(mutate?: (doc: ConfigDocument) => ConfigDocument): ConfigDocument {
  const base: ConfigDocument = {
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
  }
  return mutate ? mutate(base) : base
}

/** 一次文本响应后结束的假 provider。 */
export function textProviderFactory(text: string) {
  return (() => ({
    stream: () => ({
      usage: { inputTokens: 5, outputTokens: 2 },
      async *[Symbol.asyncIterator]() {
        await Promise.resolve()
        yield { type: ModelEventType.TEXT, content: text } as never
      },
    }),
    probe: () => Promise.resolve({ ok: true }),
  })) as never
}

/**
 * 一直挂起、直到被 abort 才 reject 的假 provider。
 *
 * 关闭测试与取消测试都需要一个"不会自己结束"的 turn——否则测的是
 * "它恰好跑完了"，而不是"取消真的生效了"。
 */
export function hangingProviderFactory() {
  return (() => ({
    stream: (_req: unknown, signal: AbortSignal) => ({
      usage: { inputTokens: 0, outputTokens: 0 },
      [Symbol.asyncIterator]() {
        return {
          next: (): Promise<IteratorResult<never>> =>
            new Promise((_resolve, reject) => {
              const fail = (): void => {
                reject(new Error('aborted'))
              }
              if (signal.aborted) fail()
              else signal.addEventListener('abort', fail, { once: true })
            }),
          return: (): Promise<IteratorResult<never>> =>
            Promise.resolve({ done: true, value: undefined as never }),
        }
      },
    }),
    probe: () => Promise.resolve({ ok: true }),
  })) as never
}

export interface HarnessOptions {
  readonly text?: string
  /** 用挂起的 provider 替代文本 provider。 */
  readonly hang?: boolean
  readonly policy?: Partial<AppPolicy>
  /** 覆盖传给 `WebServer.start` 的参数。 */
  readonly server?: Partial<WebServerOptions>
  readonly mutateConfig?: (doc: ConfigDocument) => ConfigDocument
}

export interface WebHarness {
  readonly app: AgentApplication
  readonly server: WebServer
  readonly baseUrl: string
  readonly token: string
  readonly logger: MemoryLogger
  readonly dir: string
  /** 建一个会话并返回它的 id。 */
  newSession(): Promise<SessionId>
  /** 带鉴权与 Origin 的请求。默认 `Origin` 取同源地址。 */
  fetch(path: string, init?: RequestInit & { readonly omitOrigin?: boolean }): Promise<Response>
  close(): Promise<void>
}

/**
 * 起一个真实的 Web 服务器。
 *
 * 绑 `127.0.0.1` + 端口 0 而不是默认的 `local`（会同时绑 IPv4 与 IPv6）：
 * 测试只关心一条路径，双绑定只会让每个用例多一个 socket 与一个失败面。
 */
export async function startHarness(options: HarnessOptions = {}): Promise<WebHarness> {
  const dir = await mkdtemp(join(tmpdir(), 'deepcode-web-'))
  const paths = resolveAppPaths({ home: dir, cwd: dir })
  const configStore = new ConfigStore(paths)
  await configStore.save(testConfig(options.mutateConfig))
  const chatStore = new ChatStore(paths)

  const app = await AgentApplication.create({
    paths,
    workspaceRoot: dir,
    configStore,
    chatStore,
    registry: new ToolRegistry(),
    providerFactory:
      options.hang === true ? hangingProviderFactory() : textProviderFactory(options.text ?? '好'),
    ...(options.policy === undefined ? {} : { policy: options.policy }),
  })

  const logger = new MemoryLogger()
  const token = 'test-token-0123456789'
  const started = await WebServer.start({
    app,
    listen: ListenScope.LOCAL,
    host: '127.0.0.1',
    port: 0,
    portExplicit: true,
    auth: AuthMode.TOKEN,
    token,
    logger,
    disposeApplication: false,
    version: 'test',
    ...options.server,
  })
  if (!started.ok) throw new Error(`Web 服务器启动失败：${started.reason}`)

  const server = started.server
  const baseUrl = server.urls[0] ?? `http://127.0.0.1:${String(server.port)}`

  return {
    app,
    server,
    baseUrl,
    token: server.token ?? token,
    logger,
    dir,
    async newSession() {
      const created = await app.createSession(app.localPrincipalId)
      return created.id
    },
    async fetch(path, init = {}) {
      const { omitOrigin, ...rest } = init
      const headers = new Headers(rest.headers)
      if (!headers.has('Authorization'))
        headers.set('Authorization', `Bearer ${server.token ?? token}`)
      if (omitOrigin !== true && !headers.has('Origin')) headers.set('Origin', baseUrl)
      return fetch(`${baseUrl}${path}`, { ...rest, headers })
    },
    async close() {
      await server.close()
      app.dispose()
    },
  }
}

/** 发一个 JSON 写请求。默认带上幂等键——缺了它服务端会直接 400。 */
export function postJson(
  harness: WebHarness,
  path: string,
  body: unknown,
  options: { readonly idempotencyKey?: string; readonly origin?: string | null } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Idempotency-Key': options.idempotencyKey ?? crypto.randomUUID(),
  }
  if (options.origin === null) {
    // 显式省略 Origin：`fetch` 不会自己加，这正是"写操作必须带 Origin"要测的路径。
    return fetch(`${harness.baseUrl}${path}`, {
      method: 'POST',
      headers: { ...headers, Authorization: `Bearer ${harness.token}` },
      body: JSON.stringify(body),
    })
  }
  if (options.origin !== undefined) headers['Origin'] = options.origin
  else headers['Origin'] = harness.baseUrl
  return fetch(`${harness.baseUrl}${path}`, {
    method: 'POST',
    headers: { ...headers, Authorization: `Bearer ${harness.token}` },
    body: JSON.stringify(body),
  })
}

/** 解析响应体 JSON。 */
export async function readJson<T = Record<string, unknown>>(response: Response): Promise<T> {
  return (await response.json()) as T
}
