import { describe, expect, it } from 'vitest'

import { approvalCommandPreview, approvalPresentation } from '../../src/tools/approval-preview.js'

describe('approvalCommandPreview', () => {
  it('保留可判断用途的命令与普通参数', () => {
    expect(approvalCommandPreview('npm run build -- --watch')).toBe('npm run build -- --watch')
  })

  it('隐藏命令中常见的凭据值', () => {
    const preview = approvalCommandPreview(
      'curl --token abc123 -H "Authorization: Bearer short-value" https://example.com?api_key=hidden',
    )
    expect(preview).toContain('curl --token [redacted]')
    expect(preview).toContain('Authorization: [redacted]')
    expect(preview).toContain('api_key=[redacted]')
    expect(preview).not.toContain('abc123')
    expect(preview).not.toContain('short-value')
    expect(preview).not.toContain('hidden')
  })
})

describe('approvalPresentation', () => {
  it('file_write 展示目标、写入方式和实际内容，仅隐藏凭据值', () => {
    const preview = approvalPresentation('file_write', {
      path: 'FLYINCHAT.md',
      overwrite: false,
      content: '# Notes\nhello world\nAPI_KEY=top-secret\nlast line',
    })

    expect(preview?.label).toBe('拟写入内容')
    expect(preview?.text).toContain('目标文件：FLYINCHAT.md')
    expect(preview?.text).toContain('仅在文件不存在时创建')
    expect(preview?.text).toContain('# Notes\nhello world')
    expect(preview?.text).toContain('API_KEY=[redacted]')
    expect(preview?.text).toContain('last line')
    expect(preview?.text).not.toContain('top-secret')
  })

  it('file_edit 展示替换前后文本与替换范围', () => {
    const preview = approvalPresentation('file_edit', {
      file_path: 'src/app.ts',
      old_string: 'const value = 1',
      new_string: 'const value = 2',
      replace_all: true,
    })

    expect(preview?.label).toBe('拟修改内容')
    expect(preview?.text).toContain('目标文件：src/app.ts')
    expect(preview?.text).toContain('所有匹配')
    expect(preview?.text).toContain('查找：\nconst value = 1')
    expect(preview?.text).toContain('替换为：\nconst value = 2')
  })

  it('bash 仍展示命令，其他工具展示脱敏后的实际参数', () => {
    expect(approvalPresentation('bash', { command: 'npm test' })?.text).toBe('npm test')
    const preview = approvalPresentation('mcp_unknown', {
      query: 'visible',
      content: 'hello',
      api_key: 'private',
    })
    expect(preview?.text).toContain('visible')
    expect(preview?.text).toContain('hello')
    expect(preview?.text).toContain('"api_key": "[redacted]"')
    expect(preview?.text).not.toContain('private')
  })

  it('多行文件中的 JSON 凭据仅隐藏值，其余内容继续展示', () => {
    const preview = approvalPresentation('file_write', {
      path: 'settings.json',
      content: '{\n  "api_key": "private-value",\n  "enabled": true\n}',
    })
    expect(preview?.text).toContain('"api_key": [redacted]')
    expect(preview?.text).toContain('"enabled": true')
    expect(preview?.text).not.toContain('private-value')
  })
})
