import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'

import { ChatStore } from '../../src/storage/chat-store.js'
import { canonicalWorkspace, resolveAppPaths } from '../../src/storage/paths.js'
import { MessageRole, MessageSubtype } from '../../src/core/models.js'
import { startHarness, readJson, type WebHarness } from './harness.js'

const open: WebHarness[] = []

async function harness(): Promise<WebHarness> {
  const item = await startHarness()
  open.push(item)
  return item
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((item) => item.close()))
})

function post(h: WebHarness, path: string, body: unknown, projectId?: string): Promise<Response> {
  return h.fetch(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': crypto.randomUUID(),
      ...(projectId ? { 'X-Deepcode-Project': projectId } : {}),
    },
    body: JSON.stringify(body),
  })
}

describe('Web 项目与配置', () => {
  it('打开项目后读取同一份 TUI 历史，并隔离不同项目', async () => {
    const h = await harness()
    const initial = await h.newSession()
    const workspace = join(h.dir, 'another-project')
    await mkdir(workspace)
    const paths = resolveAppPaths({ home: h.dir, cwd: workspace })
    const store = new ChatStore(paths)
    const session = await store.createConversation('TUI 对话')
    await store.addMessage({
      conversation_id: session.id,
      role: MessageRole.USER,
      content: '来自 TUI',
      turn_id: '',
      subtype: MessageSubtype.NORMAL,
      tool_call_id: null,
      meta: '{}',
      agent_type: '',
    })

    const opened = await readJson<{ id: string; path: string }>(
      await post(h, '/api/projects/open', { path: workspace }),
    )
    expect(opened.path).toBe(canonicalWorkspace(workspace))
    const headers = { 'X-Deepcode-Project': opened.id }
    const sessions = await readJson<{ sessions: { id: string; title: string }[] }>(
      await h.fetch('/api/sessions', { headers }),
    )
    expect(sessions.sessions.map((item) => item.title)).toContain('TUI 对话')
    expect(sessions.sessions.map((item) => item.id)).not.toContain(initial)
    const messages = await readJson<{ messages: { content: string }[] }>(
      await h.fetch(`/api/sessions/${session.id}/messages`, { headers }),
    )
    expect(messages.messages.map((item) => item.content)).toContain('来自 TUI')
    const defaultSessions = await readJson<{ sessions: { id: string }[] }>(
      await h.fetch('/api/sessions'),
    )
    expect(defaultSessions.sessions.map((item) => item.id)).toContain(initial)
    expect(defaultSessions.sessions.map((item) => item.id)).not.toContain(session.id)
  })

  it('列出命令供输入框提示，配置操作返回脱敏视图', async () => {
    const h = await harness()
    const catalog = await readJson<{ commands: { name: string; description: string }[] }>(
      await h.fetch('/api/commands'),
    )
    expect(catalog.commands.find((item) => item.name === 'clear')?.description).toBeTruthy()

    const added = await post(h, '/api/config', {
      action: 'provider_add',
      name: 'another',
      baseUrl: 'https://example.com',
      apiKeySource: 'env',
      apiKeyKey: 'SECRET_VARIABLE_FOR_TEST',
      modelId: 'model-1',
      contextWindow: 100000,
      maxOutputTokens: 4000,
      supportsTools: true,
    })
    expect(added.status).toBe(200)
    const config = await readJson<{ providers: { id: string; name: string }[] }>(added)
    expect(config.providers.some((item) => item.name === 'another')).toBe(true)
    expect(JSON.stringify(config)).not.toContain('SECRET_VARIABLE_FOR_TEST')
    const providerId = config.providers.find((item) => item.name === 'another')?.id
    expect(providerId).toBeTruthy()

    const model = await post(h, '/api/config', {
      action: 'model_add',
      providerId,
      modelId: 'model-2',
      contextWindow: 100000,
      maxOutputTokens: 4000,
      supportsTools: true,
    })
    expect(model.status).toBe(200)
    expect(
      (await readJson<{ models: { id: string }[] }>(model)).models.map((item) => item.id),
    ).toContain('model-2')

    const tier = await post(h, '/api/config', {
      action: 'tier_set',
      tier: 'planning',
      providerId,
      modelId: 'model-2',
    })
    expect(tier.status).toBe(200)
    expect(
      (await readJson<{ tiers: { tier: string; modelId: string }[] }>(tier)).tiers,
    ).toContainEqual(expect.objectContaining({ tier: 'planning', modelId: 'model-2' }))

    const mcp = await post(h, '/api/config', {
      action: 'mcp_add',
      name: 'sample',
      transport: 'stdio',
      target: 'echo',
      args: ['hello'],
    })
    expect(mcp.status).toBe(200)
    const mcpConfig = await readJson<{ mcpServers: { name: string }[] }>(mcp)
    expect(mcpConfig.mcpServers.map((item) => item.name)).toContain('sample')
    expect(JSON.stringify(mcpConfig)).not.toContain('SECRET_VARIABLE_FOR_TEST')

    const language = await post(h, '/api/config', { action: 'language', language: 'en' })
    expect(language.status).toBe(200)
    expect((await readJson<{ language: string }>(language)).language).toBe('en')

    const invalidPath = await post(h, '/api/projects/open', { path: '/path/that/does/not/exist' })
    expect(invalidPath.status).toBe(400)
  })

  it('Langfuse 与供应商共用配置入口，保存、停用和读回不会暴露凭据引用', async () => {
    const h = await harness()
    const added = await post(h, '/api/config', {
      action: 'langfuse_set',
      enabled: true,
      baseUrl: 'http://localhost:3000/',
      publicKeySource: 'env',
      publicKeyKey: 'LANGFUSE_PRIVATE_REFERENCE_FOR_TEST',
      secretKeySource: 'file',
      secretKeyKey: '/private/secret/langfuse-test.txt',
      environment: 'test',
      release: 'v2',
    })
    expect(added.status).toBe(200)
    const view = await readJson<{ langfuse: { enabled: boolean; baseUrl: string } }>(added)
    expect(view.langfuse).toMatchObject({
      enabled: true,
      baseUrl: 'http://localhost:3000',
      environment: 'test',
      release: 'v2',
    })
    expect(JSON.stringify(view)).not.toContain('LANGFUSE_PRIVATE_REFERENCE_FOR_TEST')
    expect(JSON.stringify(view)).not.toContain('/private/secret/langfuse-test.txt')
    expect((await h.app.configStore.read()).langfuse).toMatchObject({
      secretKeyRef: { source: 'file', key: '/private/secret/langfuse-test.txt' },
    })
    const changed = await post(h, '/api/config', {
      action: 'langfuse_set',
      enabled: false,
      baseUrl: 'http://localhost:3000',
      publicKeySource: 'env',
      publicKeyKey: '',
      secretKeySource: 'env',
      secretKeyKey: '',
    })
    expect(changed.status).toBe(200)
    expect((await h.app.configStore.read()).langfuse).toMatchObject({
      enabled: false,
      secretKeyRef: { source: 'file', key: '/private/secret/langfuse-test.txt' },
    })
    const get = await readJson<{ langfuse: { enabled: boolean } }>(await h.fetch('/api/config'))
    expect(get.langfuse.enabled).toBe(false)
    expect(JSON.stringify(get)).not.toContain('LANGFUSE_PRIVATE_REFERENCE_FOR_TEST')
  })

  it('Langfuse Web 配置拒绝明文凭据、无效地址和缺失引用，旧配置保持完整', async () => {
    const h = await harness()
    const existing = {
      enabled: false,
      baseUrl: 'https://example.com',
      publicKeyRef: { source: 'value' as const, key: 'pk-lf-private-public' },
      secretKeyRef: { source: 'value' as const, key: 'sk-lf-private-secret' },
    }
    await h.app.configStore.setLangfuse(existing)
    const dto = await readJson(await h.fetch('/api/config'))
    expect(JSON.stringify(dto)).not.toContain('sk-lf-private-secret')
    for (const invalid of [
      { publicKeySource: 'value', publicKeyKey: 'raw-key' },
      { baseUrl: 'https://user:password@example.com' },
      { enabled: 'true' },
    ]) {
      const response = await post(h, '/api/config', {
        action: 'langfuse_set',
        enabled: true,
        baseUrl: 'https://example.com',
        publicKeySource: 'env',
        publicKeyKey: 'PUBLIC',
        secretKeySource: 'env',
        secretKeyKey: 'SECRET',
        ...invalid,
      })
      expect(response.status).toBe(400)
      expect((await h.app.configStore.read()).langfuse).toEqual(existing)
    }
  })

  it('WebSocket 按所选项目订阅会话', async () => {
    const h = await harness()
    const workspace = join(h.dir, 'socket-project')
    await mkdir(workspace)
    const opened = await readJson<{ id: string }>(
      await post(h, '/api/projects/open', { path: workspace }),
    )
    const created = await readJson<{ sessionId: string }>(
      await post(h, '/api/sessions', { title: 'Web 对话' }, opened.id),
    )
    const ticket = await readJson<{ ticket: string }>(
      await post(h, '/api/ws-ticket', {}, opened.id),
    )
    const url = `ws://127.0.0.1:${String(h.server.port)}/api/stream?ticket=${encodeURIComponent(ticket.ticket)}&project=${opened.id}`
    const socket = new WebSocket(url, { headers: { Origin: h.baseUrl } })
    const frames: { type: string; sessionId?: string }[] = []
    socket.on('message', (data: Buffer) => frames.push(JSON.parse(data.toString('utf8'))))
    try {
      await once(socket, 'open')
      socket.send(JSON.stringify({ type: 'subscribe', sessionId: created.sessionId }))
      const deadline = Date.now() + 2000
      while (!frames.some((frame) => frame.type === 'subscribed') && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 5))
      expect(frames).toContainEqual(
        expect.objectContaining({
          type: 'subscribed',
          sessionId: created.sessionId,
        }),
      )
    } finally {
      socket.close()
    }
  })
})
