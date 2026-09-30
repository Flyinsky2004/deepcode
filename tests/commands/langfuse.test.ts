import { describe, expect, it, vi } from 'vitest'
import { createBuiltinCommandRegistry } from '../../src/commands/definitions/index.js'
import { CommandResultCode, type CommandHost } from '../../src/commands/types.js'
import { LOCAL, PEER, RecordingHost, SESSION } from './fixture.js'

function run(host: CommandHost, raw = '/langfuse', principalId = LOCAL) {
  return createBuiltinCommandRegistry().execute(
    { raw, principalId, sessionId: SESSION, signal: new AbortController().signal },
    host,
  )
}

describe('/langfuse', () => {
  it('区分当前上报状态与已保存配置，展示凭据就绪情况', async () => {
    const host: CommandHost = Object.assign(new RecordingHost(), {
      getLangfuseStatus: () =>
        Promise.resolve({
          enabled: false,
          reason: '尚未配置 Langfuse',
          configuration: {
            enabled: true,
            baseUrl: 'http://localhost:3000',
            hasPublicKey: true,
            hasSecretKey: false,
          },
        }),
    })
    const result = await run(host)
    expect(result).toMatchObject({
      ok: true,
      code: CommandResultCode.PANEL,
      data: { enabled: false, configuration: { enabled: true } },
    })
    expect(result.text).toContain('http://localhost:3000')
    expect(result.text).toContain('等待凭据')
    expect(result.text).toContain('/langfuse configure')
  })

  it('缺少 host 能力时明确降级', async () => {
    expect(await run(new RecordingHost())).toMatchObject({
      ok: false,
      code: CommandResultCode.NOT_AVAILABLE,
    })
  })

  it('configure 默认生成环境变量引用，允许指定已有引用', async () => {
    const configure = vi.fn(() => Promise.resolve())
    const host: CommandHost = Object.assign(new RecordingHost(), { configureLangfuse: configure })
    expect(await run(host, '/langfuse configure http://localhost:3000')).toMatchObject({
      ok: true,
      data: { secretSource: 'env' },
    })
    expect(configure).toHaveBeenLastCalledWith({
      baseUrl: 'http://localhost:3000',
      publicKeyEnv: 'DEEPCODE_LANGFUSE_PUBLIC_KEY',
      secretKeyEnv: 'DEEPCODE_LANGFUSE_SECRET_KEY',
    })
    const result = await run(host, '/langfuse configure http://localhost:3000 MY_PUBLIC MY_SECRET')
    expect(result.text).toContain('重启后生效')
    expect(configure).toHaveBeenLastCalledWith({
      baseUrl: 'http://localhost:3000',
      publicKeyEnv: 'MY_PUBLIC',
      secretKeyEnv: 'MY_SECRET',
    })
  })

  it('on/off 只更新启用状态', async () => {
    const toggle = vi.fn(() => Promise.resolve())
    const host: CommandHost = Object.assign(new RecordingHost(), { setLangfuseEnabled: toggle })
    expect((await run(host, '/langfuse off')).ok).toBe(true)
    expect(toggle).toHaveBeenLastCalledWith(false)
    expect((await run(host, '/langfuse on')).ok).toBe(true)
    expect(toggle).toHaveBeenLastCalledWith(true)
  })

  it.each([
    '/langfuse configure',
    '/langfuse configure file:///tmp/f',
    '/langfuse configure https://user:pass@example.com',
    '/langfuse configure https://example.com/api/public/otel/v1/traces',
    '/langfuse configure https://example.com pk-lf-raw sk-lf-raw',
    '/langfuse configure https://example.com PUBLIC SECRET extra',
    '/langfuse off extra',
  ])('拒绝非法输入且不修改配置：%s', async (raw) => {
    const configure = vi.fn(() => Promise.resolve())
    const host: CommandHost = Object.assign(new RecordingHost(), { configureLangfuse: configure })
    expect((await run(host, raw)).ok).toBe(false)
    expect(configure).not.toHaveBeenCalled()
  })

  it('只有本地 principal 可以写配置', async () => {
    const configure = vi.fn(() => Promise.resolve())
    const host: CommandHost = Object.assign(new RecordingHost(), { configureLangfuse: configure })
    expect((await run(host, '/langfuse configure https://example.com', PEER)).ok).toBe(false)
    expect(configure).not.toHaveBeenCalled()
  })
})
