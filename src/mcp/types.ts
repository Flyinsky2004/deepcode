export interface McpRemoteTool {
  readonly name: string
  readonly title?: string
  readonly description?: string
  readonly inputSchema: Readonly<Record<string, unknown>>
  readonly annotations?: {
    readonly readOnlyHint?: boolean
    readonly destructiveHint?: boolean
  }
}

export interface McpCallResult {
  readonly content: readonly unknown[]
  readonly structuredContent?: unknown
  readonly isError?: boolean
}

export interface McpClientConnection {
  readonly capabilities: Readonly<Record<string, unknown>>
  listTools(signal?: AbortSignal): Promise<readonly McpRemoteTool[]>
  callTool(
    name: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<McpCallResult>
  close(): Promise<void>
}

export type McpConnectionFactory = (
  onToolsChanged: (tools: readonly McpRemoteTool[]) => void,
) => Promise<McpClientConnection>

export const McpConnectionStatus = {
  DISABLED: 'disabled',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  DEGRADED: 'degraded',
  DISCONNECTED: 'disconnected',
  CIRCUIT_OPEN: 'circuit_open',
} as const
export type McpConnectionStatus = (typeof McpConnectionStatus)[keyof typeof McpConnectionStatus]

export interface McpServerStatus {
  readonly name: string
  readonly status: McpConnectionStatus
  readonly transport: string
  readonly toolCount: number
  readonly failures: number
  readonly circuitOpenUntil: number | null
  readonly error: string | null
}
