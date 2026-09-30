import { z } from 'zod'

import { ErrorCode } from '../../core/errors.js'
import { CommandResultCode, type CommandDefinition, type CommandResult } from '../types.js'

export const DEFAULT_LANGFUSE_PUBLIC_KEY_ENV = 'DEEPCODE_LANGFUSE_PUBLIC_KEY'
export const DEFAULT_LANGFUSE_SECRET_KEY_ENV = 'DEEPCODE_LANGFUSE_SECRET_KEY'
const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u, '请填写环境变量名，不能填写密钥内容')
const usage =
  '用法：/langfuse configure <base-url> [public-key-env] [secret-key-env]，或 /langfuse on|off。'

/** 与 /api 相同：写入配置与 SecretRef，不接收明文凭据。 */
export function createLangfuseCommand(): CommandDefinition {
  return {
    name: 'langfuse',
    description: '配置 Langfuse 或查看上报状态（不接收明文密钥）',
    parameters: {
      positionals: [
        {
          name: 'action',
          required: false,
          description: 'configure、on 或 off',
          schema: z.enum(['configure', 'on', 'off']),
        },
        {
          name: 'baseUrl',
          required: false,
          description: 'Langfuse 根地址',
          schema: z.string().min(1),
        },
        {
          name: 'publicKeyEnv',
          required: false,
          description: 'Public key 环境变量名',
          schema: envName,
        },
        {
          name: 'secretKeyEnv',
          required: false,
          description: 'Secret key 环境变量名',
          schema: envName,
        },
      ],
      rejectExtraPositionals: true,
    },
    interrupt: 'never',
    permission: { kind: 'local-principal' },
    auditEvent: 'command_received',
    idempotency: { kind: 'keyed', ttlMs: 60_000 },
    persistResult: false,
    execute: async (ctx): Promise<CommandResult> => {
      const action = ctx.args['action']
      if (action === 'configure') {
        const baseUrl = ctx.args['baseUrl']
        if (typeof baseUrl !== 'string')
          return {
            ok: false,
            code: CommandResultCode.INVALID_ARGUMENTS,
            errorCode: ErrorCode.INVALID_COMMAND_ARGUMENTS,
            text: usage,
          }
        try {
          const url = new URL(baseUrl)
          if (
            !['http:', 'https:'].includes(url.protocol) ||
            url.username ||
            url.password ||
            url.search ||
            url.hash ||
            /\/api\/public\/otel(?:\/v1\/traces)?\/?$/u.test(url.pathname)
          )
            throw new Error('invalid URL')
        } catch {
          return {
            ok: false,
            code: CommandResultCode.INVALID_ARGUMENTS,
            errorCode: ErrorCode.INVALID_COMMAND_ARGUMENTS,
            text: 'Langfuse base-url 必须是 http(s) 根地址，不能包含凭据或 OTLP endpoint。',
          }
        }
        if (ctx.host.configureLangfuse === undefined) return unavailable()
        const publicKeyEnv =
          typeof ctx.args['publicKeyEnv'] === 'string'
            ? ctx.args['publicKeyEnv']
            : DEFAULT_LANGFUSE_PUBLIC_KEY_ENV
        const secretKeyEnv =
          typeof ctx.args['secretKeyEnv'] === 'string'
            ? ctx.args['secretKeyEnv']
            : DEFAULT_LANGFUSE_SECRET_KEY_ENV
        await ctx.host.configureLangfuse({ baseUrl, publicKeyEnv, secretKeyEnv })
        return {
          ok: true,
          code: CommandResultCode.OK,
          text:
            'Langfuse 配置已保存到 ~/.deepcode/config.json。\n' +
            `凭据引用：${publicKeyEnv}、${secretKeyEnv}。请设置对应环境变量，重启后生效。`,
          data: { kind: 'langfuse_configured', secretSource: 'env', publicKeyEnv, secretKeyEnv },
        }
      }
      if (action === 'on' || action === 'off') {
        if (ctx.args['baseUrl'] !== undefined)
          return {
            ok: false,
            code: CommandResultCode.INVALID_ARGUMENTS,
            errorCode: ErrorCode.INVALID_COMMAND_ARGUMENTS,
            text: usage,
          }
        if (ctx.host.setLangfuseEnabled === undefined) return unavailable()
        await ctx.host.setLangfuseEnabled(action === 'on')
        return {
          ok: true,
          code: CommandResultCode.OK,
          text: `Langfuse 已${action === 'on' ? '启用' : '停用'}，重启后生效。`,
          data: { kind: 'langfuse_toggle', enabled: action === 'on' },
        }
      }
      const status = await ctx.host.getLangfuseStatus?.()
      if (status === undefined) return unavailable()
      const configuration = status.configuration
      return {
        ok: true,
        code: CommandResultCode.PANEL,
        text:
          `当前上报：${status.reason}` +
          (configuration === undefined
            ? ''
            : `\n已保存配置：${configuration.baseUrl} · ${configuration.enabled ? '启用' : '停用'}\n凭据：${configuration.hasPublicKey && configuration.hasSecretKey ? '就绪' : '等待凭据'}（配置更改在重启后生效）`) +
          `\n${usage}\n也可在 Web 设置页配置地址和凭据引用。`,
        data: status,
      }
    },
  }
}

function unavailable(): CommandResult {
  return {
    ok: false,
    code: CommandResultCode.NOT_AVAILABLE,
    errorCode: ErrorCode.COMMAND_NOT_AVAILABLE,
    text: '当前客户端未提供 Langfuse 配置能力。',
  }
}
