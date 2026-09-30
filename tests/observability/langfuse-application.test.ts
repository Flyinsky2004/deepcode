import { createServer, type IncomingHttpHeaders } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AgentApplication, type AgentApplicationOptions } from '../../src/app/agent-application.js'
import { CommandHostAdapter } from '../../src/app/command-host.js'
import { ModelEventType, type ModelProvider } from '../../src/core/provider.js'
import { InMemoryObservationSink } from '../../src/core/observability.js'
import type { StoredLangfuse } from '../../src/storage/types.js'
import { ConfigStore } from '../../src/storage/config-store.js'
import { resolveAppPaths } from '../../src/storage/paths.js'
import { ToolRegistry } from '../../src/tools/registry.js'

const dirs: string[] = []
const apps: AgentApplication[] = []
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.shutdown()))
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  vi.unstubAllEnvs()
})

async function application(
  options: Partial<AgentApplicationOptions> = {},
  storedLangfuse?: StoredLangfuse,
) {
  const dir = await mkdtemp(join(tmpdir(), 'deepcode-langfuse-'))
  dirs.push(dir)
  const paths = resolveAppPaths({ home: dir, cwd: dir })
  const configStore = new ConfigStore(paths)
  await configStore.initialize()
  await configStore.update((config) => ({
    ...config,
    ...(storedLangfuse === undefined ? {} : { langfuse: storedLangfuse }),
    providers: [
      {
        id: 'p',
        name: 'test',
        baseUrl: 'https://example.invalid',
        apiKeyRef: { source: 'env', key: 'TEST_KEY' },
        createdAt: '',
        updatedAt: '',
        enabled: true,
      },
    ],
    model_profiles: [
      {
        id: 'm',
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
        modelRef: { providerId: 'p', modelId: 'm' },
        fallbackModelRefs: [],
        enabled: true,
      },
    ],
  }))
  const provider: ModelProvider = {
    stream: () => ({
      usage: { inputTokens: 5, outputTokens: 2 },
      async *[Symbol.asyncIterator]() {
        await Promise.resolve()
        yield { type: ModelEventType.TEXT, content: '完成' }
      },
    }),
    probe: () => Promise.resolve({ ok: true }),
  }
  const app = await AgentApplication.create({
    paths,
    configStore,
    workspaceRoot: dir,
    registry: new ToolRegistry(),
    providerFactory: () => provider,
    ...options,
  })
  apps.push(app)
  return app
}

describe('Langfuse 应用装配', () => {
  it.each([200, 401])(
    '真实 SDK 发往自定义地址（HTTP %s），保留本地日志且不影响 turn',
    async (statusCode) => {
      const requests: { url: string | undefined; headers: IncomingHttpHeaders; body: Buffer }[] = []
      const server = createServer((request, response) => {
        const chunks: Buffer[] = []
        request.on('data', (chunk: Buffer) => chunks.push(chunk))
        request.on('end', () => {
          requests.push({ url: request.url, headers: request.headers, body: Buffer.concat(chunks) })
          response.writeHead(statusCode, { 'content-type': 'application/x-protobuf' })
          response.end()
        })
      })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('missing server address')
      const publicKey = 'pk-lf-fixture'
      const secretKey = 'sk-lf-fixture-secret'
      let app: AgentApplication | undefined
      try {
        app = await application(
          {},
          {
            enabled: true,
            baseUrl: `http://127.0.0.1:${address.port}`,
            publicKeyRef: { source: 'value', key: publicKey },
            secretKeyRef: { source: 'value', key: secretKey },
          },
        )
        const session = await app.createSession(app.localPrincipalId)
        const turn = await app.submitTurn({
          principalId: app.localPrincipalId,
          sessionId: session.id,
          prompt: '敏感对话不会上传：test-private-prompt',
        })
        await app.flush()
        const records = await app.observationLog!.list({
          sessionId: session.id,
          turnId: turn.turnId,
        })
        expect(turn.result.status).toBe('completed')
        expect(records.map((record) => record.type)).toContain('model.call.completed')
        expect(requests).toHaveLength(1)
        expect(requests[0]!.url).toBe('/api/public/otel/v1/traces')
        expect(requests[0]!.headers['authorization']).toBe(
          `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString('base64')}`,
        )
        expect(requests[0]!.body.length).toBeGreaterThan(0)
        expect(requests[0]!.body.toString()).not.toContain('test-private-prompt')
        const status = await new CommandHostAdapter(app).getLangfuseStatus()
        expect(status.enabled).toBe(true)
        expect(JSON.stringify({ records, status })).not.toContain(secretKey)
        await app.shutdown()
        expect(app.disposed).toBe(true)
      } finally {
        await app?.shutdown()
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        )
      }
    },
  )

  it('显式关闭优先于环境凭据；配置错误不阻止应用启动', async () => {
    vi.stubEnv('LANGFUSE_PUBLIC_KEY', 'pk-lf-fixture')
    vi.stubEnv('LANGFUSE_SECRET_KEY', 'sk-lf-fixture-secret')
    const disabled = await application({ langfuse: false })
    expect(disabled.langfuseStatus.enabled).toBe(false)
    expect(disabled.observationSink).toBe(disabled.observationLog)
    const invalid = await application({
      langfuse: { publicKey: 'pk', secretKey: 'sk', baseUrl: 'not-a-url' },
    })
    expect(invalid.langfuseStatus).toEqual({
      enabled: false,
      reason: 'Langfuse 配置或凭据不可用，继续使用本地日志',
    })
  })

  it('没有保存配置时，环境凭据不会自动启用上报', async () => {
    vi.stubEnv('LANGFUSE_PUBLIC_KEY', 'pk-lf-fixture')
    vi.stubEnv('LANGFUSE_SECRET_KEY', 'sk-lf-fixture-secret')
    const app = await application()
    expect(app.langfuseStatus).toEqual({ enabled: false, reason: '尚未配置 Langfuse' })
  })

  it('文件凭据和环境引用共用模型解析方式；状态响应不包含引用或密钥', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deepcode-langfuse-credentials-'))
    dirs.push(dir)
    const secretPath = join(dir, 'secret.txt')
    await writeFile(secretPath, 'sk-lf-file-secret\n')
    vi.stubEnv('DEEPCODE_LANGFUSE_TEST_PUBLIC', 'pk-lf-test-public')
    const stored: StoredLangfuse = {
      enabled: true,
      baseUrl: 'http://127.0.0.1:3000',
      publicKeyRef: { source: 'env', key: 'DEEPCODE_LANGFUSE_TEST_PUBLIC' },
      secretKeyRef: { source: 'file', key: secretPath },
    }
    const app = await application({}, stored)
    expect(app.langfuseStatus.enabled).toBe(true)
    const status = await new CommandHostAdapter(app).getLangfuseStatus()
    expect(status.configuration).toMatchObject({
      enabled: true,
      hasPublicKey: true,
      hasSecretKey: true,
    })
    expect(JSON.stringify(status)).not.toContain(secretPath)
    expect(JSON.stringify(status)).not.toContain('sk-lf-file-secret')
    expect(JSON.stringify(status)).not.toContain('DEEPCODE_LANGFUSE_TEST_PUBLIC')
    const disabled = await application({}, { ...stored, enabled: false })
    expect(disabled.langfuseStatus.enabled).toBe(false)
    const missing = await application(
      {},
      { ...stored, secretKeyRef: { source: 'file', key: join(dir, 'missing') } },
    )
    expect(missing.langfuseStatus.enabled).toBe(false)
    const sink = Object.assign(new InMemoryObservationSink(), {
      flush: vi.fn(() => Promise.resolve()),
    })
    const custom = await application({ observationSink: sink }, stored)
    expect(custom.observationSink).toBe(sink)
    expect(custom.langfuseStatus.enabled).toBe(false)
    await custom.shutdown()
    expect(sink.flush).toHaveBeenCalledOnce()
  })
})
