import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createFakeClock } from '../../src/core/time.js'
import { LocalObservationLog } from '../../src/observability/local-log.js'
import {
  REDACTED,
  isSensitiveKey,
  isSensitivePath,
  previewText,
  previewToolResult,
  sanitizeValue,
} from '../../src/observability/sanitize.js'

const SECRET = 'sk-ant-abcdefghijklmnopqrstuvwxyz'

describe('Phase 11：观测数据脱敏', () => {
  it('source=value 的明文即使没有已知密钥前缀也会脱敏', () => {
    const inline = 'direct-config-secret-without-known-prefix'
    const value = sanitizeValue({ provider: { source: 'value', key: inline } })
    expect(JSON.stringify(value)).not.toContain(inline)
    expect(value).toMatchObject({ provider: { source: 'value', key: REDACTED } })
  })

  it('敏感键和值形态被涂掉，token 计量字段保留', () => {
    const value = sanitizeValue({
      api_key: SECRET,
      nested: { Authorization: `Bearer ${SECRET}` },
      input_tokens: 123,
      output_tokens: 45,
      message: `key=${SECRET}`,
    })
    expect(JSON.stringify(value)).not.toContain(SECRET)
    expect(value).toMatchObject({
      api_key: REDACTED,
      nested: { Authorization: REDACTED },
      input_tokens: 123,
      output_tokens: 45,
    })
  })

  it('环境变量内容与 secret 文件路径不会进入观测记录', () => {
    expect(sanitizeValue('ANTHROPIC_API_KEY=one\nLANGFUSE_SECRET_KEY=two\nOTHER=three')).toBe(
      REDACTED,
    )
    expect(sanitizeValue({ path: '/workspace/.env.local' })).toEqual({ path: REDACTED })
    expect(isSensitivePath('/workspace/id_ed25519')).toBe(true)
    expect(isSensitivePath('/workspace/src/index.ts')).toBe(false)
    expect(isSensitiveKey('max_tokens')).toBe(false)
    expect(isSensitiveKey('access_token')).toBe(true)
  })

  it('预览固定截断并隐藏敏感文件内容', () => {
    const preview = previewText('x'.repeat(8_010))
    expect(preview.truncated).toBe(true)
    expect(preview.preview).toContain('truncated 10 chars')
    expect(preview.hash).toMatch(/^[a-f0-9]{64}$/u)

    const file = previewToolResult('file_read', { path: '.env' }, `API_KEY=${SECRET}`)
    expect(file.redacted).toBe(true)
    expect(file.preview).toBe('[redacted sensitive file content]')
    expect(file.path).toBe(REDACTED)
  })

  it('本地 NDJSON 只落脱敏值且权限为 0600', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deepcode-observation-'))
    const path = join(dir, 'nested', 'observability.ndjson')
    const log = new LocalObservationLog(path, createFakeClock(Date.UTC(2026, 0, 1)))
    await log.record({
      type: 'tool.execution.started',
      data: {
        input: { apiKey: SECRET, path: '/repo/.env', command: `curl -H 'Bearer ${SECRET}'` },
        input_tokens: 7,
      },
    })

    const raw = await readFile(path, 'utf8')
    expect(raw).not.toContain(SECRET)
    expect(raw).not.toContain('/repo/.env')
    expect(raw).toContain('"input_tokens":7')
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await log.list({ type: 'tool.execution.started' })).toHaveLength(1)
  })
})
