import { describe, expect, it } from 'vitest'

import { approvalCommandPreview } from '../../src/tools/approval-preview.js'

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
