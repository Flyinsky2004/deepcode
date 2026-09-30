import { randomUUID } from 'node:crypto'

import { loadAppPolicy, POLICY_SETTING_KEYS } from '../../app/policy.js'
import type { AgentApplication } from '../../app/agent-application.js'
import { AgentError, ErrorCode } from '../../core/errors.js'
import { ModelTier } from '../../core/provider.js'
import type { ModelProfile, SecretRef } from '../../core/provider.js'
import type { StoredProvider, TierAssignment } from '../../storage/types.js'
import { parseMcpServerConfigs } from '../../mcp/config.js'
import { isRecord } from '../../storage/json-file.js'

function invalid(message: string): never {
  throw new AgentError({ code: ErrorCode.VALIDATION_FAILED, message, source: 'web.config' })
}

function string(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') invalid(`${name} 不能为空`)
  return value.trim()
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
    invalid(`${name} 必须是正整数`)
  return value
}

function credentialRef(
  body: Readonly<Record<string, unknown>>,
  name: string,
  current: SecretRef | undefined,
): SecretRef {
  const key = body[`${name}Key`]
  if (
    (key === undefined || (typeof key === 'string' && key.trim() === '')) &&
    current !== undefined
  )
    return current
  const source = body[`${name}Source`]
  if (source !== 'env' && source !== 'file' && source !== 'keychain')
    invalid('凭据来源只能是 env、file 或 keychain')
  return { source, key: string(key, '凭据引用') }
}

/** 结构化配置操作；任何响应都只返回脱敏后的 ConfigDto。 */
export async function applyConfigAction(
  app: AgentApplication,
  body: Readonly<Record<string, unknown>>,
): Promise<void> {
  switch (body['action']) {
    case 'langfuse_set': {
      if (typeof body['enabled'] !== 'boolean') invalid('enabled 必须是布尔值')
      const current = (await app.configStore.read()).langfuse
      const environment =
        typeof body['environment'] === 'string' ? body['environment'].trim() : current?.environment
      const release =
        typeof body['release'] === 'string' ? body['release'].trim() : current?.release
      await app.configStore.setLangfuse({
        enabled: body['enabled'],
        baseUrl: string(body['baseUrl'], 'Langfuse 根地址'),
        publicKeyRef: credentialRef(body, 'publicKey', current?.publicKeyRef),
        secretKeyRef: credentialRef(body, 'secretKey', current?.secretKeyRef),
        ...(environment ? { environment } : {}),
        ...(release ? { release } : {}),
      })
      return
    }
    case 'language': {
      const language = body['language']
      if (language !== 'zh' && language !== 'en') invalid('language 必须是 zh 或 en')
      await app.configStore.update((doc) => ({
        ...doc,
        app_settings: { ...doc.app_settings, language },
      }))
      return
    }
    case 'provider_add': {
      const name = string(body['name'], '供应商名称')
      const baseUrl = string(body['baseUrl'], 'API 根地址')
      const source = body['apiKeySource']
      if (source !== 'env' && source !== 'file' && source !== 'keychain')
        invalid('凭据来源只能是 env、file 或 keychain')
      const key = string(body['apiKeyKey'], '凭据引用')
      const modelId = string(body['modelId'], '模型 ID')
      const contextWindow = positiveInteger(body['contextWindow'], '上下文窗口')
      const maxOutputTokens = positiveInteger(body['maxOutputTokens'], '最大输出 token')
      if (maxOutputTokens > contextWindow) invalid('最大输出 token 不能超过上下文窗口')
      const now = new Date().toISOString()
      const id = randomUUID()
      const provider: StoredProvider = {
        id,
        name,
        baseUrl,
        apiKeyRef: { source, key },
        createdAt: now,
        updatedAt: now,
        enabled: true,
      }
      const profile: ModelProfile = {
        id: modelId,
        providerId: id,
        contextWindow,
        maxOutputTokens,
        supportsThinking: body['supportsThinking'] === true,
        supportsTools: body['supportsTools'] !== false,
        supportsVision: body['supportsVision'] === true,
        supports1MContext: body['supports1MContext'] === true,
        enabled: true,
      }
      const current = await app.configStore.read()
      const initial: TierAssignment | undefined = current.tier_assignments.some(
        (item) => item.tier === ModelTier.IMPLEMENTATION,
      )
        ? undefined
        : {
            tier: ModelTier.IMPLEMENTATION,
            modelRef: { providerId: id, modelId },
            enabled: true,
            fallbackModelRefs: [],
          }
      await app.configStore.addProviderBundle(provider, [profile], initial)
      return
    }
    case 'tier_set': {
      const tier = body['tier']
      if (typeof tier !== 'string' || !Object.values(ModelTier).includes(tier as ModelTier))
        invalid('未知模型档位')
      const providerId = string(body['providerId'], '供应商')
      const modelId = string(body['modelId'], '模型')
      const doc = await app.configStore.read()
      if (
        !doc.providers.some((item) => item.id === providerId && item.enabled) ||
        !doc.model_profiles.some(
          (item) => item.providerId === providerId && item.id === modelId && item.enabled,
        )
      )
        invalid('请选择已启用的供应商和模型')
      await app.configStore.setTierAssignment({
        tier: tier as ModelTier,
        modelRef: { providerId, modelId },
        enabled: true,
        fallbackModelRefs:
          doc.tier_assignments.find((item) => item.tier === tier)?.fallbackModelRefs ?? [],
      })
      return
    }
    case 'provider_toggle': {
      const id = string(body['id'], '供应商 ID')
      if (typeof body['enabled'] !== 'boolean') invalid('enabled 必须是布尔值')
      await app.configStore.update((current) => {
        if (!current.providers.some((item) => item.id === id)) invalid('供应商不存在')
        return {
          ...current,
          providers: current.providers.map((item) =>
            item.id === id ? { ...item, enabled: body['enabled'] as boolean } : item,
          ),
        }
      })
      return
    }
    case 'model_add': {
      const providerId = string(body['providerId'], '供应商')
      const modelId = string(body['modelId'], '模型 ID')
      const contextWindow = positiveInteger(body['contextWindow'], '上下文窗口')
      const maxOutputTokens = positiveInteger(body['maxOutputTokens'], '最大输出 token')
      const current = await app.configStore.read()
      if (
        current.model_profiles.some((item) => item.providerId === providerId && item.id === modelId)
      )
        invalid('该模型已存在')
      await app.configStore.upsertModelProfile({
        id: modelId,
        providerId,
        contextWindow,
        maxOutputTokens,
        supportsThinking: body['supportsThinking'] === true,
        supportsTools: body['supportsTools'] !== false,
        supportsVision: body['supportsVision'] === true,
        supports1MContext: body['supports1MContext'] === true,
        enabled: true,
      })
      return
    }
    case 'mcp_add': {
      const name = string(body['name'], 'MCP 名称')
      const transport = body['transport']
      const target = string(body['target'], 'MCP 地址或命令')
      const args = body['args']
      if (transport !== 'stdio' && transport !== 'streamable-http' && transport !== 'sse')
        invalid('未知 MCP 传输类型')
      if (
        args !== undefined &&
        (!Array.isArray(args) || args.some((item) => typeof item !== 'string'))
      )
        invalid('MCP 参数必须是字符串数组')
      const entry =
        transport === 'stdio'
          ? { name, transport, command: target, args: args ?? [], env: {}, enabled: true }
          : { name, transport, url: target, headers: {}, enabled: true }
      await app.configStore.update((current) => {
        const next = { ...current, mcp_servers: [...(current.mcp_servers ?? []), entry] }
        parseMcpServerConfigs(next.mcp_servers)
        return next
      })
      return
    }
    case 'mcp_toggle': {
      const name = string(body['name'], 'MCP 名称')
      if (typeof body['enabled'] !== 'boolean') invalid('enabled 必须是布尔值')
      await app.configStore.update((current) => {
        if (!current.mcp_servers?.some((item) => isRecord(item) && item['name'] === name))
          invalid('MCP 服务不存在')
        const next = {
          ...current,
          mcp_servers: current.mcp_servers.map((item) =>
            isRecord(item) && item['name'] === name
              ? { ...item, enabled: body['enabled'] as boolean }
              : item,
          ),
        }
        parseMcpServerConfigs(next.mcp_servers)
        return next
      })
      return
    }
    case 'policy_set': {
      const key = string(body['key'], '设置项')
      if (!POLICY_SETTING_KEYS.includes(key)) invalid(`未知的策略设置项：${key}`)
      const value = string(body['value'], '设置值')
      await app.configStore.update((current) => {
        const next = {
          ...current,
          app_settings: { ...current.app_settings, [`policy.${key}`]: value },
        }
        loadAppPolicy(next)
        return next
      })
      return
    }
    default:
      invalid('未知配置操作')
  }
}
