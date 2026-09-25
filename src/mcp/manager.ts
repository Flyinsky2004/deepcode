import { AgentError, ErrorCode, toAgentError } from '../core/errors.js'
import type { ToolResult } from '../core/tool.js'
import { systemClock, type Clock } from '../core/time.js'
import type { ObservationSink } from '../core/observability.js'
import type { ToolRegistry } from '../tools/registry.js'
import { createMcpToolAdapter, publicMcpToolName } from './adapter.js'
import { createSdkMcpConnectionFactory } from './client.js'
import type { McpServerConfig } from './config.js'
import {
  McpConnectionStatus,
  type McpClientConnection,
  type McpConnectionFactory,
  type McpRemoteTool,
  type McpServerStatus,
} from './types.js'

interface ConnectionState {
  readonly config: McpServerConfig
  connection: McpClientConnection | undefined
  status: McpConnectionStatus
  tools: readonly McpRemoteTool[]
  failures: number
  circuitOpenUntil: number | null
  error: string | null
}

export interface McpManagerOptions {
  readonly configs: readonly McpServerConfig[]
  readonly registry: ToolRegistry
  readonly clock?: Clock
  readonly factoryFor?: (config: McpServerConfig) => McpConnectionFactory
  readonly observationSink?: ObservationSink
}

function contentText(content: readonly unknown[]): string {
  return content
    .map((block) => {
      if (typeof block === 'string') return block
      if (typeof block === 'object' && block !== null) {
        const value = block as Readonly<Record<string, unknown>>
        if (value['type'] === 'text' && typeof value['text'] === 'string') return value['text']
        return JSON.stringify(value)
      }
      return String(block)
    })
    .join('\n')
}

/** 独立管理每个 MCP server 的连接、工具映射、重连和熔断。 */
export class McpManager {
  readonly options: McpManagerOptions
  readonly clock: Clock
  readonly #states = new Map<string, ConnectionState>()
  /** public tool name -> 精确 server/original tool 映射。 */
  readonly #toolMap = new Map<
    string,
    { readonly serverId: string; readonly remote: McpRemoteTool }
  >()
  readonly #connecting = new Map<string, Promise<void>>()
  #catalogVersion = 0

  constructor(options: McpManagerOptions) {
    this.options = options
    this.clock = options.clock ?? systemClock
    for (const config of options.configs)
      this.#states.set(config.name, {
        config,
        connection: undefined,
        status: config.enabled ? McpConnectionStatus.DISCONNECTED : McpConnectionStatus.DISABLED,
        tools: [],
        failures: 0,
        circuitOpenUntil: null,
        error: null,
      })
  }

  get catalogVersion(): number {
    return this.#catalogVersion
  }

  /** 各 server 并行连接；单个失败只降级该 server，不阻断应用启动。 */
  async initialize(): Promise<readonly McpServerStatus[]> {
    await Promise.allSettled(
      [...this.#states.values()]
        .filter((state) => state.config.enabled)
        .map((state) => this.#connect(state)),
    )
    return this.statuses()
  }

  statuses(): readonly McpServerStatus[] {
    return [...this.#states.values()]
      .map((state) => ({
        name: state.config.name,
        status: state.status,
        transport: state.config.transport,
        toolCount: state.tools.length,
        failures: state.failures,
        circuitOpenUntil: state.circuitOpenUntil,
        error: state.error,
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  async reconnect(serverId: string): Promise<McpServerStatus> {
    const state = this.#states.get(serverId)
    if (!state)
      throw new AgentError({
        code: ErrorCode.MCP_CONFIG_INVALID,
        message: `unknown MCP server: ${serverId}`,
        source: 'mcp.manager',
      })
    state.circuitOpenUntil = null
    state.failures = 0
    await this.#observe('mcp.reconnect.requested', {
      server_id: state.config.name,
      transport: state.config.transport,
    })
    await this.#connect(state, true)
    return this.statuses().find((status) => status.name === serverId)!
  }

  async invoke(
    publicName: string,
    input: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const mapping = this.#toolMap.get(publicName)
    if (!mapping)
      return {
        ok: false,
        content: `MCP tool mapping not found: ${publicName}`,
        error_code: ErrorCode.TOOL_NOT_FOUND,
        meta: {},
      }
    const state = this.#states.get(mapping.serverId)!
    const startedAt = this.clock.nowMs()
    await this.#observe('mcp.tool.started', {
      server_id: mapping.serverId,
      tool_name: mapping.remote.name,
      input,
    })
    if (state.circuitOpenUntil !== null && state.circuitOpenUntil > this.clock.nowMs()) {
      state.status = McpConnectionStatus.CIRCUIT_OPEN
      return {
        ok: false,
        content: `MCP circuit is open for server ${mapping.serverId}`,
        error_code: ErrorCode.MCP_CIRCUIT_OPEN,
        meta: { server_id: mapping.serverId, retry_at: state.circuitOpenUntil },
      }
    }
    if (!state.connection) {
      try {
        await this.#connect(state)
      } catch {
        return {
          ok: false,
          content: state.error ?? `MCP server unavailable: ${mapping.serverId}`,
          error_code: ErrorCode.MCP_CONNECTION_FAILED,
          meta: { server_id: mapping.serverId },
        }
      }
    }
    try {
      const result = await state.connection!.callTool(mapping.remote.name, input, signal)
      state.failures = 0
      state.error = null
      state.status = McpConnectionStatus.CONNECTED
      const adapted: ToolResult = {
        ok: result.isError !== true,
        content: contentText(result.content),
        ...(typeof result.structuredContent === 'object' &&
        result.structuredContent !== null &&
        !Array.isArray(result.structuredContent)
          ? { data: result.structuredContent as Readonly<Record<string, unknown>> }
          : {}),
        error_code: result.isError === true ? ErrorCode.TOOL_RUNTIME_ERROR : null,
        meta: { server_id: mapping.serverId, remote_tool: mapping.remote.name },
      }
      await this.#observe(
        'mcp.tool.completed',
        {
          server_id: mapping.serverId,
          tool_name: mapping.remote.name,
          ok: adapted.ok,
          error_code: adapted.error_code ?? '',
        },
        this.clock.nowMs() - startedAt,
      )
      return adapted
    } catch (error) {
      const e = toAgentError(error, `mcp:${mapping.serverId}`)
      const failedConnection = state.connection
      this.#recordFailure(state, e.message)
      void failedConnection?.close().catch(() => undefined)
      // 调用已发出且不是只读时，不能自动重放；明确报告副作用未知。
      const unknown = mapping.remote.annotations?.readOnlyHint !== true
      if (!unknown) void this.#connect(state, true).catch(() => undefined)
      const adapted: ToolResult = {
        ok: false,
        content: unknown
          ? `MCP tool execution may have completed; status is unknown: ${e.message}`
          : `MCP tool call failed: ${e.message}`,
        error_code: unknown
          ? ErrorCode.TOOL_EXECUTION_UNKNOWN
          : signal.aborted
            ? ErrorCode.MCP_TIMEOUT
            : ErrorCode.MCP_CONNECTION_FAILED,
        meta: { server_id: mapping.serverId, remote_tool: mapping.remote.name },
      }
      await this.#observe(
        'mcp.tool.completed',
        {
          server_id: mapping.serverId,
          tool_name: mapping.remote.name,
          ok: false,
          error_code: adapted.error_code ?? '',
        },
        this.clock.nowMs() - startedAt,
      )
      return adapted
    }
  }

  async shutdown(): Promise<void> {
    const connections = [...this.#states.values()].flatMap((state) =>
      state.connection === undefined ? [] : [state.connection],
    )
    await Promise.allSettled(connections.map((connection) => connection.close()))
    for (const state of this.#states.values()) {
      state.connection = undefined
      if (state.config.enabled) state.status = McpConnectionStatus.DISCONNECTED
      if (state.config.enabled)
        await this.#observe('mcp.disconnected', {
          server_id: state.config.name,
          transport: state.config.transport,
        })
    }
  }

  async #connect(state: ConnectionState, force = false): Promise<void> {
    const existing = this.#connecting.get(state.config.name)
    if (existing) return existing
    const pending = this.#connectOnce(state, force).finally(() => {
      this.#connecting.delete(state.config.name)
    })
    this.#connecting.set(state.config.name, pending)
    return pending
  }

  async #connectOnce(state: ConnectionState, force = false): Promise<void> {
    if (!state.config.enabled) return
    if (!force && state.connection && state.status === McpConnectionStatus.CONNECTED) return
    if (state.circuitOpenUntil !== null && state.circuitOpenUntil > this.clock.nowMs())
      throw new AgentError({
        code: ErrorCode.MCP_CIRCUIT_OPEN,
        message: `MCP circuit is open: ${state.config.name}`,
        source: 'mcp.manager',
      })
    state.status = McpConnectionStatus.CONNECTING
    const startedAt = this.clock.nowMs()
    await this.#observe('mcp.connecting', {
      server_id: state.config.name,
      transport: state.config.transport,
      reconnect: force,
    })
    if (state.connection) await state.connection.close().catch(() => undefined)
    state.connection = undefined
    let lastError: unknown
    for (let attempt = 0; attempt <= state.config.reconnectAttempts; attempt += 1) {
      let connection: McpClientConnection | undefined
      try {
        const factory =
          this.options.factoryFor?.(state.config) ?? createSdkMcpConnectionFactory(state.config)
        connection = await factory((tools) => {
          try {
            this.#installTools(state, tools)
          } catch (error) {
            state.status = McpConnectionStatus.DEGRADED
            state.error = error instanceof Error ? error.message : String(error)
          }
        })
        const capabilities = connection.capabilities
        if (!('tools' in capabilities)) {
          await connection.close()
          throw new AgentError({
            code: ErrorCode.MCP_CONNECTION_FAILED,
            message: `MCP server ${state.config.name} does not advertise tools capability`,
            source: 'mcp.manager',
          })
        }
        const tools = await connection.listTools()
        this.#installTools(state, tools)
        state.connection = connection
        state.status = McpConnectionStatus.CONNECTED
        state.failures = 0
        state.circuitOpenUntil = null
        state.error = null
        await this.#observe(
          'mcp.connected',
          {
            server_id: state.config.name,
            transport: state.config.transport,
            tool_count: state.tools.length,
            catalog_version: this.#catalogVersion,
            attempt: attempt + 1,
          },
          this.clock.nowMs() - startedAt,
        )
        return
      } catch (error) {
        await connection?.close().catch(() => undefined)
        lastError = error
        const attemptError = toAgentError(error, `mcp:${state.config.name}`)
        await this.#observe('mcp.connect.failed', {
          server_id: state.config.name,
          transport: state.config.transport,
          attempt: attempt + 1,
          error_code: attemptError.code,
          message: attemptError.message,
        })
      }
    }
    const e = toAgentError(lastError, `mcp:${state.config.name}`)
    this.#recordFailure(state, e.message)
    state.status = McpConnectionStatus.DEGRADED
    await this.#observe(
      state.circuitOpenUntil === null ? 'mcp.degraded' : 'mcp.circuit.opened',
      {
        server_id: state.config.name,
        transport: state.config.transport,
        failures: state.failures,
        error_code: e.code,
        message: e.message,
        circuit_open_until: state.circuitOpenUntil ?? 0,
      },
      this.clock.nowMs() - startedAt,
    )
    throw new AgentError({
      code: ErrorCode.MCP_CONNECTION_FAILED,
      message: e.message,
      source: 'mcp.manager',
      context: { server: state.config.name },
    })
  }

  #installTools(state: ConnectionState, tools: readonly McpRemoteTool[]): void {
    const proposed = tools.map((remote) => ({
      name: publicMcpToolName(state.config.name, remote.name),
      remote,
    }))
    const duplicate = proposed.find(
      (item, index) => proposed.findIndex((candidate) => candidate.name === item.name) !== index,
    )
    if (duplicate)
      throw new AgentError({
        code: ErrorCode.MCP_CONFIG_INVALID,
        message: `MCP tool name collision on ${duplicate.name}`,
        source: 'mcp.manager',
      })
    for (const item of proposed) {
      const mapped = this.#toolMap.get(item.name)
      const existing = this.options.registry.get(item.name)
      if (existing && mapped?.serverId !== state.config.name)
        throw new AgentError({
          code: ErrorCode.MCP_CONFIG_INVALID,
          message: `MCP public tool conflicts with existing tool: ${item.name}`,
          source: 'mcp.manager',
        })
    }
    for (const [name, mapping] of [...this.#toolMap.entries()]) {
      if (mapping.serverId !== state.config.name) continue
      this.options.registry.unregister(name)
      this.#toolMap.delete(name)
    }
    for (const item of proposed) {
      this.#toolMap.set(item.name, { serverId: state.config.name, remote: item.remote })
      this.options.registry.register(createMcpToolAdapter(this, state.config.name, item.remote))
    }
    state.tools = [...tools]
    this.#catalogVersion += 1
    void this.#observe('mcp.catalog.changed', {
      server_id: state.config.name,
      tool_count: state.tools.length,
      catalog_version: this.#catalogVersion,
    })
  }

  #recordFailure(state: ConnectionState, message: string): void {
    state.failures += 1
    state.error = message
    state.connection = undefined
    if (state.failures >= state.config.circuitFailureThreshold) {
      state.status = McpConnectionStatus.CIRCUIT_OPEN
      state.circuitOpenUntil = this.clock.nowMs() + state.config.circuitCooldownMs
    } else state.status = McpConnectionStatus.DEGRADED
  }

  #observe(
    type: string,
    data: Readonly<Record<string, unknown>>,
    elapsedMs?: number,
  ): Promise<void> {
    void this.options.observationSink
      ?.record({ type, data, ...(elapsedMs === undefined ? {} : { elapsedMs }) })
      .catch(() => undefined)
    return Promise.resolve()
  }
}
