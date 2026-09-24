import {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  type Transport,
} from '@modelcontextprotocol/client'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio'

import type { McpServerConfig } from './config.js'
import { McpTransport } from './config.js'
import type {
  McpCallResult,
  McpClientConnection,
  McpConnectionFactory,
  McpRemoteTool,
} from './types.js'

function transportFor(config: McpServerConfig): Transport {
  if (config.transport === McpTransport.STDIO)
    return new StdioClientTransport({
      command: config.command,
      args: [...config.args],
      ...(Object.keys(config.env).length === 0
        ? {}
        : { env: { ...getDefaultEnvironment(), ...config.env } }),
      ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
      stderr: 'pipe',
    })
  const requestInit =
    Object.keys(config.headers).length === 0 ? undefined : { headers: { ...config.headers } }
  return config.transport === McpTransport.SSE
    ? new SSEClientTransport(new URL(config.url), requestInit === undefined ? {} : { requestInit })
    : new StreamableHTTPClientTransport(
        new URL(config.url),
        requestInit === undefined ? {} : { requestInit },
      )
}

/** 官方 SDK 的薄适配层，便于 manager 测试时替换连接。 */
export function createSdkMcpConnectionFactory(config: McpServerConfig): McpConnectionFactory {
  return async (onToolsChanged) => {
    const client = new Client(
      { name: 'deepcode', version: '0.0.0' },
      {
        listChanged: {
          tools: {
            autoRefresh: true,
            onChanged: (error, tools) => {
              if (!error && tools) onToolsChanged(tools as readonly McpRemoteTool[])
            },
          },
        },
      },
    )
    try {
      await client.connect(transportFor(config), { timeout: config.timeoutMs })
    } catch (error) {
      await client.close().catch(() => undefined)
      throw error
    }
    const capabilities = client.getServerCapabilities() ?? {}
    const connection: McpClientConnection = {
      capabilities,
      async listTools(signal) {
        const result = await client.listTools(undefined, {
          timeout: config.timeoutMs,
          cacheMode: 'refresh',
          ...(signal === undefined ? {} : { signal }),
        })
        return result.tools as readonly McpRemoteTool[]
      },
      async callTool(name, args, signal): Promise<McpCallResult> {
        const result = await client.callTool(
          { name, arguments: args },
          {
            timeout: config.timeoutMs,
            ...(signal === undefined ? {} : { signal }),
          },
        )
        return result as McpCallResult
      },
      close: () => client.close(),
    }
    return connection
  }
}
