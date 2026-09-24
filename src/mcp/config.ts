import { AgentError, ErrorCode } from '../core/errors.js'

export const McpTransport = {
  STDIO: 'stdio',
  STREAMABLE_HTTP: 'streamable-http',
  SSE: 'sse',
} as const
export type McpTransport = (typeof McpTransport)[keyof typeof McpTransport]

interface McpServerBase {
  readonly name: string
  readonly enabled: boolean
  readonly timeoutMs: number
  readonly reconnectAttempts: number
  readonly circuitFailureThreshold: number
  readonly circuitCooldownMs: number
}

export interface McpStdioServerConfig extends McpServerBase {
  readonly transport: typeof McpTransport.STDIO
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly cwd?: string
}

export interface McpHttpServerConfig extends McpServerBase {
  readonly transport: typeof McpTransport.STREAMABLE_HTTP | typeof McpTransport.SSE
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined

function positive(value: unknown, fallback: number, key: string): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    throw invalid(`${key} must be a positive number`)
  return value
}

function nonNegative(value: unknown, fallback: number, key: string): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw invalid(`${key} must be a non-negative number`)
  return value
}

function strings(value: unknown, key: string): readonly string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw invalid(`${key} must be an array of strings`)
  const items: readonly unknown[] = value
  if (items.some((item) => typeof item !== 'string'))
    throw invalid(`${key} must be an array of strings`)
  return items.map((item) => (typeof item === 'string' ? item : ''))
}

function stringMap(value: unknown, key: string): Readonly<Record<string, string>> {
  if (value === undefined) return {}
  const raw = record(value)
  if (!raw || Object.values(raw).some((item) => typeof item !== 'string'))
    throw invalid(`${key} must be an object of string values`)
  return raw as Readonly<Record<string, string>>
}

function invalid(message: string, context: Readonly<Record<string, unknown>> = {}): AgentError {
  return new AgentError({
    code: ErrorCode.MCP_CONFIG_INVALID,
    message,
    source: 'mcp.config',
    context,
  })
}

/** 严格解析配置；同名 server 在连接前直接失败，避免工具映射悄悄覆盖。 */
export function parseMcpServerConfigs(value: unknown): readonly McpServerConfig[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw invalid('mcp_servers must be an array')
  const result: McpServerConfig[] = []
  const seen = new Set<string>()
  for (const [index, item] of value.entries()) {
    const raw = record(item)
    if (!raw) throw invalid(`mcp_servers[${index}] must be an object`)
    const name = typeof raw['name'] === 'string' ? raw['name'].trim() : ''
    if (!name || !/^[a-zA-Z0-9._-]+$/u.test(name))
      throw invalid(`mcp_servers[${index}].name is invalid`)
    if (seen.has(name)) throw invalid(`duplicate MCP server name: ${name}`)
    seen.add(name)
    const rawTransport = raw['transport'] ?? McpTransport.STDIO
    const transport =
      rawTransport === 'streamable_http'
        ? McpTransport.STREAMABLE_HTTP
        : (rawTransport as McpTransport)
    if (!Object.values(McpTransport).includes(transport))
      throw invalid(`unsupported MCP transport for ${name}: ${String(transport)}`)
    const common = {
      name,
      enabled: raw['enabled'] !== false,
      timeoutMs: positive(
        raw['timeout_ms'] ??
          raw['timeoutMs'] ??
          (typeof raw['timeout_seconds'] === 'number' ? raw['timeout_seconds'] * 1_000 : undefined),
        30_000,
        `${name}.timeout_ms`,
      ),
      reconnectAttempts: nonNegative(
        raw['reconnect_attempts'] ?? raw['reconnectAttempts'],
        2,
        `${name}.reconnect_attempts`,
      ),
      circuitFailureThreshold: positive(
        raw['circuit_failure_threshold'] ?? raw['circuitFailureThreshold'],
        3,
        `${name}.circuit_failure_threshold`,
      ),
      circuitCooldownMs: positive(
        raw['circuit_cooldown_ms'] ?? raw['circuitCooldownMs'],
        30_000,
        `${name}.circuit_cooldown_ms`,
      ),
    }
    if (transport === McpTransport.STDIO) {
      const command = typeof raw['command'] === 'string' ? raw['command'].trim() : ''
      if (!command) throw invalid(`stdio MCP server ${name} requires command`)
      result.push({
        ...common,
        transport,
        command,
        args: strings(raw['args'], `${name}.args`),
        env: stringMap(raw['env'], `${name}.env`),
        ...(typeof raw['cwd'] === 'string' && raw['cwd'].trim() ? { cwd: raw['cwd'].trim() } : {}),
      })
      continue
    }
    const url = typeof raw['url'] === 'string' ? raw['url'].trim() : ''
    try {
      const parsed = new URL(url)
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('invalid protocol')
    } catch {
      throw invalid(`${transport} MCP server ${name} requires a valid HTTP(S) url`)
    }
    result.push({
      ...common,
      transport,
      url,
      headers: stringMap(raw['headers'], `${name}.headers`),
    })
  }
  return result
}
