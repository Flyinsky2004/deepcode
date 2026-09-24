import {
  PermissionAction,
  RiskLevel,
  ToolCapability,
  type Tool,
  type ValidationIssue,
  type ValidationResult,
} from '../core/tool.js'
import type { McpManager } from './manager.js'
import type { McpRemoteTool } from './types.js'

function validateValue(
  value: unknown,
  schema: Readonly<Record<string, unknown>>,
  path: readonly (string | number)[],
): readonly ValidationIssue[] {
  const errors: ValidationIssue[] = []
  const type = schema['type']
  if (type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      return [{ path, message: 'must be an object' }]
    const input = value as Readonly<Record<string, unknown>>
    const required = Array.isArray(schema['required']) ? schema['required'].map(String) : []
    for (const key of required)
      if (!(key in input)) errors.push({ path: [...path, key], message: 'is required' })
    const properties =
      typeof schema['properties'] === 'object' && schema['properties'] !== null
        ? (schema['properties'] as Readonly<Record<string, unknown>>)
        : {}
    for (const [key, child] of Object.entries(properties))
      if (key in input && typeof child === 'object' && child !== null)
        errors.push(
          ...validateValue(input[key], child as Readonly<Record<string, unknown>>, [...path, key]),
        )
  } else if (type === 'array' && !Array.isArray(value))
    errors.push({ path, message: 'must be an array' })
  else if (type === 'string' && typeof value !== 'string')
    errors.push({ path, message: 'must be a string' })
  else if (type === 'number' && typeof value !== 'number')
    errors.push({ path, message: 'must be a number' })
  else if (type === 'integer' && (!Number.isInteger(value) || typeof value !== 'number'))
    errors.push({ path, message: 'must be an integer' })
  else if (type === 'boolean' && typeof value !== 'boolean')
    errors.push({ path, message: 'must be a boolean' })
  if (Array.isArray(schema['enum']) && !schema['enum'].some((item) => Object.is(item, value)))
    errors.push({ path, message: 'must be one of the enumerated values' })
  return errors
}

export function publicMcpToolName(server: string, tool: string): string {
  const clean = (value: string): string => value.replace(/[^a-zA-Z0-9_]/gu, '_')
  return `mcp_${clean(server)}_${clean(tool)}`
}

export function createMcpToolAdapter(
  manager: McpManager,
  serverId: string,
  remote: McpRemoteTool,
): Tool {
  const name = publicMcpToolName(serverId, remote.name)
  return {
    descriptor: {
      name,
      description: remote.description ?? remote.title ?? `MCP tool ${remote.name} from ${serverId}`,
      input_schema: remote.inputSchema,
      version: 'mcp-1',
      risk_level: remote.annotations?.destructiveHint === true ? RiskLevel.HIGH : RiskLevel.MEDIUM,
      capabilities: [ToolCapability.DATA_ACCESS, ToolCapability.NETWORK],
      source: { kind: 'mcp', serverId },
    },
    validate(input: unknown): ValidationResult {
      if (typeof input !== 'object' || input === null || Array.isArray(input))
        return { ok: false, errors: [{ path: [], message: 'must be an object' }] }
      const errors = validateValue(input, remote.inputSchema, [])
      return errors.length > 0
        ? { ok: false, errors }
        : { ok: true, value: input as Readonly<Record<string, unknown>> }
    },
    safetyCheck: () => ({
      action: PermissionAction.ASK,
      reason: `MCP tool ${serverId}/${remote.name} accesses an external server`,
    }),
    execute: (ctx, input) => manager.invoke(name, input, ctx.signal),
  }
}
