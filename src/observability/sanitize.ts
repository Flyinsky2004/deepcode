import { createHash } from 'node:crypto'
import { basename } from 'node:path'

export const REDACTED = '[redacted]'
export const DEFAULT_PREVIEW_CHARS = 8_000
export const TEST_OUTPUT_PREVIEW_CHARS = 20_000
export const GIT_DIFF_PREVIEW_CHARS = 12_000

const SENSITIVE_KEY_PARTS = [
  'password',
  'passwd',
  'secret',
  'token',
  'api_key',
  'apikey',
  'credential',
  'authorization',
  'cookie',
  'private_key',
  'privatekey',
  'access_key',
  'accesskey',
  'refresh_token',
  'client_secret',
] as const

/** 计量字段不是凭据。旧实现把它们误涂掉，本实现按 REWRITE_SPEC E-OBS-1 修正。 */
const SAFE_TOKEN_KEYS = new Set([
  'input_tokens',
  'output_tokens',
  'total_tokens',
  'max_tokens',
  'context_tokens_before',
  'context_tokens_after',
  'cumulative_input_tokens',
])

const SENSITIVE_PATHS = [
  /^\.env(?:\..*)?$/iu,
  /.*\.pem$/iu,
  /.*\.key$/iu,
  /^id_(?:rsa|ed25519|ecdsa)$/iu,
  /^credentials\.json$/iu,
  /^secrets?\.(?:ya?ml|json)$/iu,
] as const

const SECRET_VALUE_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{8,}/gu,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/gu,
  /\bAKIA[0-9A-Z]{16}\b/gu,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/gu,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/gu,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/giu,
] as const

const PATH_KEYS = new Set(['path', 'file_path', 'secret_file', 'key_file'])

export function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replaceAll('-', '_')
  if (SAFE_TOKEN_KEYS.has(normalized)) return false
  return SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part))
}

export function isSensitivePath(path: string): boolean {
  const name = basename(path)
  return SENSITIVE_PATHS.some((pattern) => pattern.test(name))
}

export function redactValueShapes(text: string): string {
  let value = text
  for (const pattern of SECRET_VALUE_PATTERNS) value = value.replace(pattern, REDACTED)
  return looksLikeEnvContent(value) ? REDACTED : value
}

/**
 * 递归脱敏任意 JSON 形态。所有写入本地观测日志的数据都必须经过这里。
 * 深度上限既防循环引用，也防恶意 MCP 返回构造超深对象。
 */
export function sanitizeValue(value: unknown, parentKey = '', depth = 0): unknown {
  if (depth > 16) return REDACTED
  if (parentKey && isSensitiveKey(parentKey)) return REDACTED
  if (typeof value === 'string') {
    if (PATH_KEYS.has(parentKey.toLowerCase()) && isSensitivePath(value)) return REDACTED
    return redactValueShapes(value)
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, '', depth + 1))
  if (value !== null && typeof value === 'object') {
    const record = value as Readonly<Record<string, unknown>>
    const inlineSecret = record['source'] === 'value' && typeof record['key'] === 'string'
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(record))
      result[key] = inlineSecret && key === 'key' ? REDACTED : sanitizeValue(item, key, depth + 1)
    return result
  }
  return value
}

export function sanitizeRecord(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const sanitized = sanitizeValue(value)
  return sanitized !== null && typeof sanitized === 'object' && !Array.isArray(sanitized)
    ? (sanitized as Readonly<Record<string, unknown>>)
    : {}
}

export interface TextPreview {
  readonly preview: string
  readonly hash: string
  readonly truncated: boolean
  readonly originalLength: number
  readonly redacted: boolean
}

export function previewText(
  text: string,
  options: { readonly maxChars?: number; readonly redacted?: boolean } = {},
): TextPreview {
  const maxChars = options.maxChars ?? DEFAULT_PREVIEW_CHARS
  const hash = createHash('sha256').update(text, 'utf8').digest('hex')
  if (options.redacted === true)
    return {
      preview: REDACTED,
      hash,
      truncated: false,
      originalLength: text.length,
      redacted: true,
    }
  const truncated = text.length > maxChars
  return {
    preview: truncated
      ? `${text.slice(0, maxChars)}\n... [truncated ${text.length - maxChars} chars]`
      : text,
    hash,
    truncated,
    originalLength: text.length,
    redacted: false,
  }
}

export function previewToolResult(
  toolName: string,
  args: Readonly<Record<string, unknown>>,
  content: string,
): TextPreview & { readonly path?: string } {
  const path =
    typeof args['path'] === 'string'
      ? args['path']
      : typeof args['file_path'] === 'string'
        ? args['file_path']
        : undefined
  if (path !== undefined && isSensitivePath(path))
    return {
      ...previewText(content, { redacted: true }),
      preview: '[redacted sensitive file content]',
      path: REDACTED,
    }
  let maxChars = DEFAULT_PREVIEW_CHARS
  if (toolName === 'bash') {
    const command = typeof args['command'] === 'string' ? args['command'].toLowerCase() : ''
    if (command.includes('pytest') || command.includes('test')) maxChars = TEST_OUTPUT_PREVIEW_CHARS
    else if (command.startsWith('git diff')) maxChars = GIT_DIFF_PREVIEW_CHARS
  }
  return previewText(redactValueShapes(content), { maxChars })
}

function looksLikeEnvContent(value: string): boolean {
  if (value.length > 20_000) return false
  const lines = value
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
  if (lines.length < 2) return false
  let assignments = 0
  for (const line of lines.slice(0, 20)) {
    const separator = line.indexOf('=')
    if (separator < 1) continue
    const key = line.slice(0, separator).trim()
    if (/^[A-Za-z0-9_-]+$/u.test(key)) assignments += 1
  }
  return (
    assignments >= 2 &&
    lines.some((line) => {
      const separator = line.indexOf('=')
      return separator > 0 && isSensitiveKey(line.slice(0, separator).trim())
    })
  )
}
