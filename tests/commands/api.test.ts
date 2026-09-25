import { describe, expect, it } from 'vitest'

import {
  DEFAULT_PROVIDER_CONTEXT_WINDOW,
  DEFAULT_PROVIDER_MAX_OUTPUT_TOKENS,
  createApiCommand,
} from '../../src/commands/definitions/api.js'
import { CommandRegistry } from '../../src/commands/registry.js'
import { CommandResultCode } from '../../src/commands/types.js'
import { ErrorCode } from '../../src/core/errors.js'
import { LOCAL, PEER, RecordingHost, SESSION, makeConfig } from './fixture.js'

async function run(raw: string, host = new RecordingHost(), principalId = LOCAL) {
  const registry = new CommandRegistry()
  registry.register(createApiCommand())
  const result = await registry.execute(
    {
      raw,
      principalId,
      sessionId: SESSION,
      signal: new AbortController().signal,
      idempotencyKey: 'api-test',
    },
    host,
  )
  return { host, result }
}

describe('/api', () => {
  it('列出 provider、endpoint、模型和密钥就绪状态', async () => {
    const { result } = await run('/api')
    expect(result.ok).toBe(true)
    expect(result.code).toBe(CommandResultCode.PANEL)
    expect(result.text).toContain('DeepSeek')
    expect(result.text).toContain('v4-flash')
    expect(result.text).toContain('/api add')
    expect(result.data).toMatchObject({ kind: 'provider_panel' })
  })

  it('空配置给出安全添加用法', async () => {
    const host = new RecordingHost()
    host.config = makeConfig({ providers: [], models: [], tiers: [] })
    const { result } = await run('/api', host)
    expect(result.code).toBe(CommandResultCode.PANEL)
    expect(result.text).toContain('尚未配置 provider')
    expect(result.text).toContain('命令不接收 API key')
  })

  it('新增 provider 时只写非敏感信息和环境变量引用', async () => {
    const host = new RecordingHost()
    host.config = makeConfig({ providers: [], models: [], tiers: [] })
    const { result } = await run(
      '/api add Anthropic https://api.anthropic.com claude-a,claude-b',
      host,
    )

    expect(result.ok).toBe(true)
    expect(host.providerAdds).toEqual([
      {
        name: 'Anthropic',
        baseUrl: 'https://api.anthropic.com',
        modelIds: ['claude-a', 'claude-b'],
        contextWindow: DEFAULT_PROVIDER_CONTEXT_WINDOW,
        maxOutputTokens: DEFAULT_PROVIDER_MAX_OUTPUT_TOKENS,
      },
    ])
    expect(result.text).toContain("export DEEPCODE_ANTHROPIC_API_KEY='<API_KEY>'")
    expect(result.text).toContain('implementation')
    expect(JSON.stringify(result)).not.toContain('sk-')
  })

  it('允许显式设置上下文与最大输出，并保留已有 implementation 档位', async () => {
    const host = new RecordingHost()
    host.config = makeConfig({
      tiers: [{ tier: 'implementation', providerId: 'p', modelId: 'm' }] as never,
    })
    const { result } = await run(
      '/api add Local https://llm.example.test/anthropic model-x 200000 16000',
      host,
    )
    expect(host.providerAdds[0]).toMatchObject({ contextWindow: 200_000, maxOutputTokens: 16_000 })
    expect(result.text).toContain('未修改其模型')
  })

  it.each([
    ['/api add P not-a-url m', 'base-url'],
    ['/api add P https://user:pass@example.test m', 'base-url'],
    ['/api add P https://example.test/v1/messages m', 'base-url'],
    ['/api add P https://example.test m,m', '不能重复'],
    ['/api add P https://example.test m 100 101', '不能大于'],
  ])('拒绝非法配置：%s', async (raw, message) => {
    const { host, result } = await run(raw)
    expect(result.code).toBe(CommandResultCode.INVALID_ARGUMENTS)
    expect(result.errorCode).toBe(ErrorCode.INVALID_COMMAND_ARGUMENTS)
    expect(result.text).toContain(message)
    expect(host.providerAdds).toHaveLength(0)
  })

  it('额外参数在审计前被拒绝，避免把误填的 key 带入命令处理', async () => {
    const { host, result } = await run(
      '/api add P https://example.test m 128000 8192 sk-should-never-be-accepted',
    )
    expect(result.code).toBe(CommandResultCode.INVALID_ARGUMENTS)
    expect(result.text).toContain('参数过多')
    expect(host.providerAdds).toHaveLength(0)
    expect(host.published).toHaveLength(0)
  })

  it('缺参数时只显示用法，不产生半配置', async () => {
    const { host, result } = await run('/api add Anthropic')
    expect(result.code).toBe(CommandResultCode.INVALID_ARGUMENTS)
    expect(result.text).toContain('用法')
    expect(host.providerAdds).toHaveLength(0)
  })

  it('远端 principal 不能修改全局 provider 配置', async () => {
    const { host, result } = await run(
      '/api add P https://example.test m',
      new RecordingHost(),
      PEER,
    )
    expect(result.code).toBe(CommandResultCode.PERMISSION_DENIED)
    expect(host.providerAdds).toHaveLength(0)
  })
})
