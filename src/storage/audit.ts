import { createHash } from 'node:crypto'

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(',')}}`
}
export function inputHash(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex')
}
export function redact(value: unknown, key = ''): unknown {
  if (/key|token|secret|password|authorization|content|command/i.test(key)) return '[redacted]'
  if (Array.isArray(value)) return value.map((item) => redact(item))
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [name, redact(item, name)]),
    )
  return value
}
export function argsPreview(input: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(redact(input)).slice(0, 1000)
}
