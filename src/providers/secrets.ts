import { statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'

import type { SecretRef } from '../core/provider.js'

export interface SecretResolver {
  resolve(ref: SecretRef): Promise<string | undefined>
}

/** 模型与观测 exporter 共用的凭据读取方式；keychain 尚未实现。 */
export const defaultSecretResolver: SecretResolver = {
  async resolve(ref) {
    if (ref.source === 'env') return process.env[ref.key]
    if (ref.source === 'file') return (await readFile(ref.key, 'utf8')).trim()
    if (ref.source === 'value') return ref.key
    return undefined
  },
}

/** 只返回可用性，不向命令或 UI 返回凭据内容。 */
export function secretAvailable(ref: SecretRef | undefined): boolean {
  if (!ref) return false
  if (ref.source === 'value') return ref.key.trim().length > 0
  if (ref.source === 'env') return (process.env[ref.key]?.trim().length ?? 0) > 0
  if (ref.source === 'file') {
    try {
      return statSync(ref.key).size > 0
    } catch {
      return false
    }
  }
  return false
}
