import { writeFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { ErrorCode } from '../../src/core/errors.js'
import { InMemoryObservationSink } from '../../src/core/observability.js'
import { McpManager, parseMcpServerConfigs } from '../../src/mcp/index.js'
import type {
  McpClientConnection,
  McpConnectionFactory,
  McpRemoteTool,
} from '../../src/mcp/types.js'
import { ConfigStore } from '../../src/storage/config-store.js'
import { ToolRegistry } from '../../src/tools/registry.js'

const remote: McpRemoteTool = {
  name: 'search-items',
  description: 'Search items',
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
  },
  annotations: { readOnlyHint: true },
}

describe('Phase 10：MCP', () => {
  it('严格校验配置并拒绝重名 server', () => {
    expect(() =>
      parseMcpServerConfigs([
        { name: 'same', transport: 'stdio', command: 'one' },
        { name: 'same', transport: 'stdio', command: 'two' },
      ]),
    ).toThrowError(expect.objectContaining({ code: ErrorCode.MCP_CONFIG_INVALID }))
    expect(
      parseMcpServerConfigs([
        { name: 'local', transport: 'stdio', command: 'server', args: ['--stdio'] },
      ]),
    ).toMatchObject([{ name: 'local', transport: 'stdio', command: 'server' }])
  })

  it('配置持久化层不会吞掉非法 mcp_servers 类型', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deepcode-mcp-config-'))
    const path = join(root, 'config.json')
    await writeFile(path, JSON.stringify({ schema_version: 1, mcp_servers: { invalid: true } }))
    await expect(new ConfigStore(path).read()).rejects.toMatchObject({
      code: ErrorCode.MCP_CONFIG_INVALID,
    })
  })

  it('建立显式工具映射、响应动态目录更新并保留 server 来源', async () => {
    let changed: ((tools: readonly McpRemoteTool[]) => void) | undefined
    const connection: McpClientConnection = {
      capabilities: { tools: { listChanged: true } },
      listTools: () => Promise.resolve([remote]),
      callTool: (_name, args) =>
        Promise.resolve({ content: [{ type: 'text', text: `found:${String(args['query'])}` }] }),
      close: () => Promise.resolve(),
    }
    const factory: McpConnectionFactory = (handler) => {
      changed = handler
      return Promise.resolve(connection)
    }
    const registry = new ToolRegistry()
    const [config] = parseMcpServerConfigs([
      { name: 'inventory', transport: 'stdio', command: 'fake' },
    ])
    const observations = new InMemoryObservationSink()
    const manager = new McpManager({
      configs: [config!],
      registry,
      factoryFor: () => factory,
      observationSink: observations,
    })
    await manager.initialize()

    const tool = registry.require('mcp_inventory_search_items')
    expect(tool.descriptor.source).toEqual({ kind: 'mcp', serverId: 'inventory' })
    expect(tool.validate({ query: 'book' })).toMatchObject({ ok: true })
    expect(tool.validate({})).toMatchObject({ ok: false })
    await expect(
      manager.invoke('mcp_inventory_search_items', { query: 'book' }, new AbortController().signal),
    ).resolves.toMatchObject({ ok: true, content: 'found:book' })

    changed?.([
      {
        ...remote,
        name: 'get-item',
      },
    ])
    expect(registry.get('mcp_inventory_search_items')).toBeUndefined()
    expect(registry.get('mcp_inventory_get_item')).toBeDefined()
    expect(manager.catalogVersion).toBe(2)
    await manager.shutdown()
    expect(observations.records.map((record) => record.type)).toEqual(
      expect.arrayContaining([
        'mcp.connecting',
        'mcp.catalog.changed',
        'mcp.connected',
        'mcp.tool.started',
        'mcp.tool.completed',
        'mcp.disconnected',
      ]),
    )
  })

  it('非只读远端调用断线时标记 UNKNOWN，并按阈值打开熔断器', async () => {
    const mutating: McpRemoteTool = {
      ...remote,
      name: 'delete-item',
      annotations: { readOnlyHint: false, destructiveHint: true },
    }
    const factory: McpConnectionFactory = () =>
      Promise.resolve({
        capabilities: { tools: {} },
        listTools: () => Promise.resolve([mutating]),
        callTool: () => Promise.reject(new Error('connection lost')),
        close: () => Promise.resolve(),
      })
    const registry = new ToolRegistry()
    const [config] = parseMcpServerConfigs([
      {
        name: 'danger',
        transport: 'stdio',
        command: 'fake',
        circuit_failure_threshold: 1,
      },
    ])
    const manager = new McpManager({
      configs: [config!],
      registry,
      factoryFor: () => factory,
    })
    await manager.initialize()
    const first = await manager.invoke(
      'mcp_danger_delete_item',
      { query: 'x' },
      new AbortController().signal,
    )
    expect(first).toMatchObject({ ok: false, error_code: ErrorCode.TOOL_EXECUTION_UNKNOWN })
    const second = await manager.invoke(
      'mcp_danger_delete_item',
      { query: 'x' },
      new AbortController().signal,
    )
    expect(second).toMatchObject({ ok: false, error_code: ErrorCode.MCP_CIRCUIT_OPEN })
    expect(manager.statuses()[0]).toMatchObject({ status: 'circuit_open', failures: 1 })
  })
})
