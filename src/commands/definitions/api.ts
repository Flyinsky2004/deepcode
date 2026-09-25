/**
 * `/api` —— 安全地查看或新增 Anthropic-compatible provider。
 *
 * 这条命令刻意不提供任何 API key 参数。新增 provider 时只生成一个环境变量
 * SecretRef；用户在进程环境中设置真正的密钥。这样明文不会经过 TUI 输入历史、
 * Web `POST /api/commands`、审计事件或 transcript。
 */

import { z } from 'zod'

import { ErrorCode } from '../../core/errors.js'
import {
  CommandResultCode,
  type CommandConfigView,
  type CommandDefinition,
  type CommandResult,
} from '../types.js'

export const DEFAULT_PROVIDER_CONTEXT_WINDOW = 128_000
export const DEFAULT_PROVIDER_MAX_OUTPUT_TOKENS = 8_192

const positiveInteger = z.string().regex(/^\d+$/, '必须是正整数')

const usage =
  '用法：/api add <名称> <base-url> <模型ID[,模型ID...]> [context-window] [max-output-tokens]\n' +
  '示例：/api add Anthropic https://api.anthropic.com your-model-id\n' +
  '命令不接收 API key；成功后请按提示设置环境变量。'

function invalid(text: string): CommandResult {
  return {
    ok: false,
    code: CommandResultCode.INVALID_ARGUMENTS,
    errorCode: ErrorCode.INVALID_COMMAND_ARGUMENTS,
    text,
  }
}

function parsePositiveInteger(value: unknown, fallback: number): number | undefined {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

function validBaseUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.search === '' &&
      parsed.hash === '' &&
      !/\/v1\/messages\/?$/i.test(parsed.pathname)
    )
  } catch {
    return false
  }
}

export function createApiCommand(): CommandDefinition {
  return {
    name: 'api',
    description: '管理 provider（不接收明文密钥）',
    parameters: {
      positionals: [
        { name: 'action', required: false, description: 'add', schema: z.literal('add') },
        { name: 'name', required: false, description: 'provider 名称', schema: z.string().min(1) },
        {
          name: 'baseUrl',
          required: false,
          description: 'Anthropic-compatible API 根地址',
          schema: z.string().min(1),
        },
        {
          name: 'models',
          required: false,
          description: '逗号分隔的模型 ID',
          schema: z.string().min(1),
        },
        {
          name: 'contextWindow',
          required: false,
          description: '上下文窗口',
          schema: positiveInteger,
        },
        {
          name: 'maxOutputTokens',
          required: false,
          description: '最大输出 token',
          schema: positiveInteger,
        },
      ],
      // 密钥永远不是合法的额外参数；在审计之前拒绝。
      rejectExtraPositionals: true,
    },
    interrupt: 'never',
    permission: { kind: 'local-principal' },
    auditEvent: 'command_received',
    idempotency: { kind: 'keyed', ttlMs: 60_000 },
    persistResult: false,
    execute: async (ctx): Promise<CommandResult> => {
      if (ctx.args['action'] !== 'add') return describeProviders(await ctx.host.readConfig())

      const name = typeof ctx.args['name'] === 'string' ? ctx.args['name'].trim() : ''
      const baseUrl = typeof ctx.args['baseUrl'] === 'string' ? ctx.args['baseUrl'].trim() : ''
      const rawModels = typeof ctx.args['models'] === 'string' ? ctx.args['models'] : ''
      if (!name || !baseUrl || !rawModels) return invalid(usage)
      if (!validBaseUrl(baseUrl))
        return invalid('base-url 必须是 http(s) API 根地址，不能包含凭据、查询参数或 /v1/messages')

      const modelIds = rawModels
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean)
      if (modelIds.length === 0) return invalid('至少需要一个模型 ID。\n' + usage)
      if (new Set(modelIds).size !== modelIds.length) return invalid('模型 ID 不能重复')

      const contextWindow = parsePositiveInteger(
        ctx.args['contextWindow'],
        DEFAULT_PROVIDER_CONTEXT_WINDOW,
      )
      const maxOutputTokens = parsePositiveInteger(
        ctx.args['maxOutputTokens'],
        DEFAULT_PROVIDER_MAX_OUTPUT_TOKENS,
      )
      if (contextWindow === undefined || maxOutputTokens === undefined)
        return invalid('context-window 和 max-output-tokens 必须是正整数')
      if (maxOutputTokens > contextWindow)
        return invalid('max-output-tokens 不能大于 context-window')

      if (ctx.host.addProviderConfiguration === undefined)
        return {
          ok: false,
          code: CommandResultCode.NOT_AVAILABLE,
          errorCode: ErrorCode.COMMAND_NOT_AVAILABLE,
          text: '当前客户端未提供 provider 配置写入能力。',
        }
      const added = await ctx.host.addProviderConfiguration({
        name,
        baseUrl,
        modelIds,
        contextWindow,
        maxOutputTokens,
      })
      const after = await ctx.host.readConfig()
      const provider = after.providers.find((item) => item.id === added.providerId)
      if (provider === undefined)
        return {
          ok: false,
          code: CommandResultCode.FAILED,
          errorCode: ErrorCode.INVALID_STATE_TRANSITION,
          text: 'provider 写入后回读失败，配置可能被并发修改',
        }

      return {
        ok: true,
        code: CommandResultCode.OK,
        text:
          `已添加 provider ${provider.name}（${added.modelIds.join('、')}）。\n` +
          `未写入明文密钥。请在启动 deepcode 前设置环境变量：\n` +
          `export ${added.envName}='<API_KEY>'` +
          (added.assignedImplementation
            ? '\n已将 implementation 档位指向第一个模型。'
            : '\n已有 implementation 档位，未修改其模型。'),
        data: {
          kind: 'provider_added',
          providerId: added.providerId,
          name: provider.name,
          baseUrl: provider.baseUrl,
          modelIds: added.modelIds,
          secretSource: 'env',
          envName: added.envName,
          assignedImplementation: added.assignedImplementation,
        },
      }
    },
  }
}

function describeProviders(config: CommandConfigView): CommandResult {
  if (config.providers.length === 0)
    return {
      ok: true,
      code: CommandResultCode.PANEL,
      text: `尚未配置 provider。\n${usage}`,
      data: { kind: 'provider_panel', providers: [], models: [] },
    }

  const lines = config.providers.map((provider) => {
    const models = config.models
      .filter((model) => model.providerId === provider.id)
      .map((model) => model.id)
    return (
      `- ${provider.name} · ${provider.baseUrl ?? '未记录 endpoint'} · ` +
      `${provider.hasSecret ? '密钥就绪' : '等待环境变量'}\n` +
      `  models: ${models.length > 0 ? models.join(', ') : '无'}`
    )
  })
  return {
    ok: true,
    code: CommandResultCode.PANEL,
    text: `Provider 配置：\n${lines.join('\n')}\n\n${usage}`,
    data: {
      kind: 'provider_panel',
      providers: config.providers.map((provider) => ({
        id: provider.id,
        name: provider.name,
        baseUrl: provider.baseUrl ?? null,
        enabled: provider.enabled,
        hasSecret: provider.hasSecret,
      })),
      models: config.models,
    },
  }
}
