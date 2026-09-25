import { randomUUID } from 'node:crypto'

import { AgentError, ErrorCode } from '../core/errors.js'
import { ModelTier, type ModelProfile, type Provider, type SecretRef } from '../core/provider.js'
import { type AppPaths } from './paths.js'
import { type ConfigDocument, type StoredProvider, type TierAssignment } from './types.js'
import { isRecord, readJsonObject, updateJsonAtomic } from './json-file.js'

const VERSION = 1

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asBool(value: unknown, fallback = true): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function asNum(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function normalizeSecret(value: unknown): SecretRef {
  if (
    isRecord(value) &&
    (value['source'] === 'env' ||
      value['source'] === 'keychain' ||
      value['source'] === 'file' ||
      value['source'] === 'value')
  ) {
    return { source: value['source'], key: asString(value['key']) }
  }
  return { source: 'env', key: asString(value) }
}

function normalizeProvider(value: unknown): StoredProvider | undefined {
  if (!isRecord(value)) return undefined
  const secret = value['apiKeyRef'] ?? value['api_key_ref']
  if (
    !isRecord(secret) ||
    !['env', 'file', 'keychain', 'value'].includes(String(secret['source'])) ||
    typeof secret['key'] !== 'string' ||
    !secret['key'].trim()
  )
    return undefined
  const id = asString(value['id'], randomUUID())
  const name = asString(value['name'], id)
  const baseUrl = asString(
    value['baseUrl'] ?? value['base_url'],
    'https://api.anthropic.com',
  ).replace(/\/+$/, '')
  return {
    id,
    name,
    baseUrl,
    apiKeyRef: normalizeSecret(secret),
    createdAt: asString(value['createdAt'] ?? value['created_at'], new Date().toISOString()),
    updatedAt: asString(value['updatedAt'] ?? value['updated_at'], new Date().toISOString()),
    enabled: asBool(value['enabled'], true),
  }
}

function normalizeProfile(value: unknown): ModelProfile | undefined {
  if (!isRecord(value)) return undefined
  const providerId = asString(value['providerId'] ?? value['provider_id'])
  const id = asString(value['id'] ?? value['modelId'] ?? value['model_id'])
  if (!providerId || !id) return undefined
  return {
    id,
    providerId,
    ...(value['displayName'] === undefined && value['display_name'] === undefined
      ? {}
      : { displayName: asString(value['displayName'] ?? value['display_name']) }),
    contextWindow: asNum(value['contextWindow'] ?? value['context_window'], 125_000),
    maxOutputTokens: asNum(value['maxOutputTokens'] ?? value['max_output_tokens'], 128_000),
    supportsThinking: asBool(value['supportsThinking'] ?? value['supports_thinking'], false),
    supportsTools: asBool(value['supportsTools'] ?? value['supports_tools'], true),
    supportsVision: asBool(value['supportsVision'] ?? value['supports_vision'], false),
    supports1MContext: asBool(value['supports1MContext'] ?? value['supports_1m_context'], false),
    ...(value['inputCostPerMillion'] === undefined
      ? {}
      : { inputCostPerMillion: asNum(value['inputCostPerMillion'], 0) }),
    ...(value['outputCostPerMillion'] === undefined
      ? {}
      : { outputCostPerMillion: asNum(value['outputCostPerMillion'], 0) }),
    enabled: asBool(value['enabled'], true),
    // 运行偏好：与能力声明分开存（见 core/provider.ts 的 ModelProfile）。
    // ⚠️ 本函数是**白名单式**的——这里不列出来的字段在读回时会被静默丢掉，
    // 所以新增持久化字段必须同步加到这里，否则用户设置会在下次启动时消失。
    ...(value['thinkingEnabled'] === undefined && value['thinking_enabled'] === undefined
      ? {}
      : { thinkingEnabled: asBool(value['thinkingEnabled'] ?? value['thinking_enabled'], false) }),
    ...(value['reasoningEffort'] === undefined && value['reasoning_effort'] === undefined
      ? {}
      : {
          reasoningEffort: asString(value['reasoningEffort'] ?? value['reasoning_effort']),
        }),
  }
}

function normalizeTier(value: unknown): TierAssignment | undefined {
  if (!isRecord(value)) return undefined
  const tier = asString(value['tier']) as TierAssignment['tier']
  if (!Object.values(ModelTier).includes(tier)) return undefined
  const refValue: unknown = value['modelRef'] ?? value['model_ref']
  const ref = isRecord(refValue) ? refValue : {}
  const providerId = asString(ref['providerId'] ?? ref['provider_id'])
  const modelId = asString(ref['modelId'] ?? ref['model_id'])
  if (!providerId || !modelId) return undefined
  const fallbackValue: unknown = value['fallbackModelRefs'] ?? value['fallback_model_refs']
  const fallback: readonly unknown[] = Array.isArray(fallbackValue) ? fallbackValue : []
  return {
    tier,
    modelRef: { providerId, modelId },
    enabled: asBool(value['enabled'], true),
    fallbackModelRefs: fallback.flatMap((item: unknown) => {
      if (!isRecord(item)) return []
      const p = asString(item['providerId'] ?? item['provider_id'])
      const m = asString(item['modelId'] ?? item['model_id'])
      return p && m ? [{ providerId: p, modelId: m }] : []
    }),
    ...(value['maxCostPerTurn'] === undefined && value['max_cost_per_turn'] === undefined
      ? {}
      : { maxCostPerTurn: asNum(value['maxCostPerTurn'] ?? value['max_cost_per_turn'], 0) }),
  }
}

function normalize(raw: Readonly<Record<string, unknown>>): ConfigDocument {
  const version = typeof raw['schema_version'] === 'number' ? raw['schema_version'] : VERSION
  if (version > VERSION) {
    throw new AgentError({
      code: ErrorCode.STORAGE_SCHEMA_UNSUPPORTED,
      message: `config schema_version ${version} is too new`,
      source: 'config',
    })
  }
  if (raw['mcp_servers'] !== undefined && !Array.isArray(raw['mcp_servers']))
    throw new AgentError({
      code: ErrorCode.MCP_CONFIG_INVALID,
      message: 'mcp_servers must be an array',
      source: 'config',
    })
  // Legacy channels contain plaintext `api_key`; do not guess an environment
  // variable name or silently migrate secrets. They remain preserved under the
  // legacy field and must be explicitly re-entered as a SecretRef.
  const providers = (Array.isArray(raw['providers']) ? raw['providers'] : [])
    .map(normalizeProvider)
    .filter((p): p is StoredProvider => p !== undefined)
  const profiles = (Array.isArray(raw['model_profiles']) ? raw['model_profiles'] : [])
    .map(normalizeProfile)
    .filter((p): p is ModelProfile => p !== undefined)
  const tiers = (Array.isArray(raw['tier_assignments']) ? raw['tier_assignments'] : [])
    .map(normalizeTier)
    .filter((p): p is TierAssignment => p !== undefined)
  const appSettings = isRecord(raw['app_settings'])
    ? Object.fromEntries(
        Object.entries(raw['app_settings']).map(([k, v]) => [
          k,
          typeof v === 'string' ? v : String(v),
        ]),
      )
    : {}
  return {
    ...raw,
    schema_version: VERSION,
    llm_channels: Array.isArray(raw['llm_channels']) ? raw['llm_channels'].filter(isRecord) : [],
    llm_models: Array.isArray(raw['llm_models']) ? raw['llm_models'].filter(isRecord) : [],
    app_settings: appSettings,
    ...(Array.isArray(raw['mcp_servers']) ? { mcp_servers: raw['mcp_servers'] } : {}),
    providers,
    model_profiles: profiles,
    tier_assignments: tiers,
  }
}

export class ConfigStore {
  readonly path: string
  constructor(paths: AppPaths | string) {
    this.path = typeof paths === 'string' ? paths : paths.config_path
  }

  async read(): Promise<ConfigDocument> {
    return normalize(await readJsonObject(this.path, () => ({ schema_version: VERSION })))
  }

  load(): Promise<ConfigDocument> {
    return this.read()
  }

  async save(document: ConfigDocument): Promise<ConfigDocument> {
    const normalized = normalize(document)
    await updateJsonAtomic(
      this.path,
      () => normalized as unknown as Readonly<Record<string, unknown>>,
      () => normalized as unknown as Readonly<Record<string, unknown>>,
    )
    return normalized
  }

  async initialize(): Promise<ConfigDocument> {
    return this.update((doc) => doc)
  }

  async upsertProvider(provider: Provider | StoredProvider): Promise<ConfigDocument> {
    const value: StoredProvider = {
      ...provider,
      enabled: 'enabled' in provider ? provider.enabled : true,
    }
    this.validateProvider(value)
    return this.update((doc) => ({
      ...doc,
      providers: [...doc.providers.filter((p) => p.id !== value.id), value],
    }))
  }

  async upsertModelProfile(profile: ModelProfile): Promise<ConfigDocument> {
    this.validateModelProfile(profile)
    const provider = await this.read().then((d) =>
      d.providers.find((p) => p.id === profile.providerId),
    )
    if (!provider)
      throw new AgentError({
        code: ErrorCode.MODEL_NOT_FOUND,
        message: `provider not found: ${profile.providerId}`,
        source: 'config',
      })
    return this.update((doc) => ({
      ...doc,
      model_profiles: [
        ...doc.model_profiles.filter(
          (p) => !(p.id === profile.id && p.providerId === profile.providerId),
        ),
        profile,
      ],
    }))
  }

  async setTierAssignment(assignment: TierAssignment): Promise<ConfigDocument> {
    if (!Object.values(ModelTier).includes(assignment.tier))
      throw new AgentError({
        code: ErrorCode.VALIDATION_FAILED,
        message: 'invalid tier assignment',
        source: 'config',
      })
    return this.update((doc) => ({
      ...doc,
      tier_assignments: [
        ...doc.tier_assignments.filter((a) => a.tier !== assignment.tier),
        assignment,
      ],
    }))
  }

  /**
   * 原子新增一个 provider、它的模型，以及可选的初始档位。
   *
   * `/api add` 不能依次调用三个 upsert：第三步失败会留下只有 provider、没有
   * 模型的半配置。这里把校验和写入收进同一个原子更新。
   */
  async addProviderBundle(
    provider: StoredProvider,
    profiles: readonly ModelProfile[],
    initialAssignment?: TierAssignment,
  ): Promise<{ readonly document: ConfigDocument; readonly assignmentAdded: boolean }> {
    this.validateProvider(provider)
    if (!provider.name.trim())
      throw new AgentError({
        code: ErrorCode.VALIDATION_FAILED,
        message: 'provider name is required',
        source: 'config',
      })
    if (profiles.length === 0)
      throw new AgentError({
        code: ErrorCode.VALIDATION_FAILED,
        message: 'provider requires at least one model profile',
        source: 'config',
      })
    for (const profile of profiles) {
      this.validateModelProfile(profile)
      if (profile.providerId !== provider.id)
        throw new AgentError({
          code: ErrorCode.VALIDATION_FAILED,
          message: 'model profile belongs to a different provider',
          source: 'config',
        })
    }
    if (new Set(profiles.map((profile) => profile.id)).size !== profiles.length)
      throw new AgentError({
        code: ErrorCode.VALIDATION_FAILED,
        message: 'duplicate model id in provider bundle',
        source: 'config',
      })
    if (
      initialAssignment !== undefined &&
      !Object.values(ModelTier).includes(initialAssignment.tier)
    )
      throw new AgentError({
        code: ErrorCode.VALIDATION_FAILED,
        message: 'invalid tier assignment',
        source: 'config',
      })
    if (
      initialAssignment !== undefined &&
      (initialAssignment.modelRef.providerId !== provider.id ||
        !profiles.some((profile) => profile.id === initialAssignment.modelRef.modelId))
    )
      throw new AgentError({
        code: ErrorCode.VALIDATION_FAILED,
        message: 'initial tier assignment must reference a model in the provider bundle',
        source: 'config',
      })

    let assignmentAdded = false
    const document = await this.update((doc) => {
      if (
        doc.providers.some(
          (item) =>
            item.id === provider.id ||
            item.name.trim().toLowerCase() === provider.name.trim().toLowerCase(),
        )
      )
        throw new AgentError({
          code: ErrorCode.VALIDATION_FAILED,
          message: `provider already exists: ${provider.name}`,
          source: 'config',
        })

      const canAssign =
        initialAssignment !== undefined &&
        !doc.tier_assignments.some((item) => item.tier === initialAssignment.tier)
      assignmentAdded = canAssign
      return {
        ...doc,
        providers: [...doc.providers, provider],
        model_profiles: [...doc.model_profiles, ...profiles],
        tier_assignments: canAssign
          ? [...doc.tier_assignments, initialAssignment]
          : doc.tier_assignments,
      }
    })
    return { document, assignmentAdded }
  }

  async update(mutator: (doc: ConfigDocument) => ConfigDocument): Promise<ConfigDocument> {
    const next = await updateJsonAtomic(
      this.path,
      () => ({ schema_version: VERSION }),
      (raw) => mutator(normalize(raw)) as unknown as Readonly<Record<string, unknown>>,
    )
    return normalize(next)
  }

  private validateProvider(provider: StoredProvider): void {
    // ⚠️ 解析失败必须**本身就是**一个校验错误。
    //
    // 早先这里 `catch { parsed = new URL('http://invalid') }`：兜底值恰好是个合法
    // 的 http URL，于是后面所有检查（协议、用户名、查询串、`/v1/messages` 路径）
    // **看起来都跑过了**，实际全部落空，`baseUrl: 'not a url'` 被原样写进配置。
    // 新增的校验等于白写，错误被推迟到发请求时（fetch 抛 TypeError）。
    let parsed: URL
    try {
      parsed = new URL(provider.baseUrl)
    } catch (cause) {
      throw new AgentError(
        {
          code: ErrorCode.VALIDATION_FAILED,
          message: 'provider baseUrl must be a valid absolute http(s) URL',
          source: 'config',
        },
        { cause },
      )
    }
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    )
      throw new AgentError({
        code: ErrorCode.VALIDATION_FAILED,
        message: 'provider baseUrl must be http(s)',
        source: 'config',
      })
    if (/\/v1\/messages\/?$/i.test(parsed.pathname))
      throw new AgentError({
        code: ErrorCode.VALIDATION_FAILED,
        message: 'provider baseUrl must be API root, not /v1/messages',
        source: 'config',
      })
    if (!provider.apiKeyRef.key.trim())
      throw new AgentError({
        code: ErrorCode.VALIDATION_FAILED,
        message: 'provider apiKeyRef is required',
        source: 'config',
      })
  }

  private validateModelProfile(profile: ModelProfile): void {
    if (
      !profile.id.trim() ||
      !profile.providerId.trim() ||
      !Number.isSafeInteger(profile.contextWindow) ||
      profile.contextWindow <= 0 ||
      !Number.isSafeInteger(profile.maxOutputTokens) ||
      profile.maxOutputTokens <= 0 ||
      profile.maxOutputTokens > profile.contextWindow
    )
      throw new AgentError({
        code: ErrorCode.VALIDATION_FAILED,
        message: 'invalid model profile',
        source: 'config',
      })
  }
}
