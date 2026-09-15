/**
 * `ConfigStore` 的归一化与校验行为单测。
 *
 * `config.json` 是**用户设置的唯一持久化位置**，而 `normalize*` 系列函数是
 * **白名单式**的：没被列出来的字段读回时会被静默丢掉。也就是说这里少列一个
 * 字段，用户设置就会在下次启动时消失——所以"每个字段都要能往返"这件事必须
 * 被测试钉住，而不是靠读代码确认。
 *
 * 另一半重点是 `validateProvider()`：`baseUrl` 是用户输入且会拼进线上请求，
 * 它拒绝 URL 里的用户名/密码/查询串/片段，也拒绝把 `/v1/messages` 当根地址
 * （那会拼出 `/v1/messages/v1/messages`）。这些分支必须逐条覆盖。
 *
 * 所有测试只固化既有行为，不修改实现。
 */
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { ErrorCode } from '../../src/core/errors.js'
import { ModelTier, type ModelProfile, type Provider } from '../../src/core/provider.js'
import { ConfigStore } from '../../src/storage/config-store.js'
import { resolveAppPaths } from '../../src/storage/paths.js'
import type { TierAssignment } from '../../src/storage/types.js'

async function makeStore(): Promise<{ store: ConfigStore; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'deepcode-configstore-'))
  const paths = resolveAppPaths({ home: dir, cwd: dir })
  await mkdir(paths.global_dir, { recursive: true })
  return { store: new ConfigStore(paths), path: paths.config_path }
}

async function readRaw(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
}

const provider: Provider = {
  id: 'p1',
  name: 'P1',
  baseUrl: 'https://api.anthropic.com',
  apiKeyRef: { source: 'env', key: 'KEY' },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

const profile: ModelProfile = {
  id: 'm1',
  providerId: 'p1',
  contextWindow: 100_000,
  maxOutputTokens: 4096,
  supportsThinking: false,
  supportsTools: true,
  supportsVision: false,
  supports1MContext: false,
  enabled: true,
}

describe('ConfigStore provider 归一化', () => {
  it('缺少配置文件时读出空文档', async () => {
    const { store } = await makeStore()
    await expect(store.load()).resolves.toMatchObject({
      schema_version: 1,
      providers: [],
      model_profiles: [],
      tier_assignments: [],
      app_settings: {},
    })
  })

  it('拒绝过新的 schema_version', async () => {
    const { store, path } = await makeStore()
    await writeFile(path, JSON.stringify({ schema_version: 2 }), 'utf8')
    await expect(store.read()).rejects.toMatchObject({
      code: ErrorCode.STORAGE_SCHEMA_UNSUPPORTED,
    })
  })

  it('非数字 schema_version 视为当前版本', async () => {
    const { store, path } = await makeStore()
    await writeFile(path, JSON.stringify({ schema_version: 'x' }), 'utf8')
    await expect(store.read()).resolves.toMatchObject({ schema_version: 1 })
  })

  it('apiKeyRef 支持 snake_case，并补全缺省字段', async () => {
    const { store, path } = await makeStore()
    await writeFile(
      path,
      JSON.stringify({
        schema_version: 1,
        providers: [
          {
            id: 'a',
            name: 'A',
            base_url: 'https://example.com///',
            api_key_ref: { source: 'file', key: '/tmp/k' },
          },
        ],
      }),
      'utf8',
    )
    const doc = await store.read()
    expect(doc.providers[0]).toMatchObject({
      id: 'a',
      baseUrl: 'https://example.com', // 末尾斜杠被去掉
      apiKeyRef: { source: 'file', key: '/tmp/k' },
      enabled: true,
    })
    // createdAt / updatedAt / name 缺省时有兜底值，不会留空。
    expect(doc.providers[0]!.createdAt).not.toBe('')
    expect(doc.providers[0]!.updatedAt).not.toBe('')
  })

  it('id 与 name 缺省时用随机 UUID 兜底', async () => {
    const { store, path } = await makeStore()
    await writeFile(
      path,
      JSON.stringify({
        schema_version: 1,
        providers: [{ apiKeyRef: { source: 'env', key: 'K' } }],
      }),
      'utf8',
    )
    const doc = await store.read()
    expect(doc.providers[0]!.id).toMatch(/^[0-9a-f-]{36}$/)
    // name 缺省时直接沿用生成的 id。
    expect(doc.providers[0]!.name).toBe(doc.providers[0]!.id)
  })

  it('baseUrl 缺省时回落到官方地址', async () => {
    const { store, path } = await makeStore()
    await writeFile(
      path,
      JSON.stringify({
        schema_version: 1,
        providers: [{ apiKeyRef: { source: 'env', key: 'K' } }],
      }),
      'utf8',
    )
    await expect(store.read()).resolves.toMatchObject({
      providers: [{ baseUrl: 'https://api.anthropic.com' }],
    })
  })

  it('丢弃密钥引用非法的 provider 条目', async () => {
    const { store, path } = await makeStore()
    await writeFile(
      path,
      JSON.stringify({
        schema_version: 1,
        providers: [
          'not a record',
          {},
          { apiKeyRef: 'plain-string' },
          { apiKeyRef: { source: 'vault', key: 'k' } },
          { apiKeyRef: { source: 'env', key: 42 } },
          { apiKeyRef: { source: 'env', key: '   ' } },
          { apiKeyRef: { source: 'env', key: 'ok' } },
        ],
      }),
      'utf8',
    )
    const doc = await store.read()
    expect(doc.providers).toHaveLength(1)
    expect(doc.providers[0]!.apiKeyRef).toEqual({ source: 'env', key: 'ok' })
  })
})

describe('ConfigStore 模型与档位归一化', () => {
  it('模型档案支持 snake_case 与 camelCase，并丢弃缺 provider/model 的条目', async () => {
    const { store, path } = await makeStore()
    await writeFile(
      path,
      JSON.stringify({
        schema_version: 1,
        model_profiles: [
          'not a record',
          { id: 'no-provider' },
          { provider_id: 'p1' },
          {
            provider_id: 'p1',
            model_id: 'm1',
            display_name: '展示名',
            context_window: 200_000,
            max_output_tokens: 8192,
            supports_thinking: true,
            supports_tools: false,
            supports_vision: true,
            supports_1m_context: true,
          },
          {
            providerId: 'p1',
            modelId: 'm2',
            displayName: 'camel',
            inputCostPerMillion: 3,
            outputCostPerMillion: 15,
            thinkingEnabled: true,
            reasoningEffort: 'high',
          },
        ],
      }),
      'utf8',
    )
    const doc = await store.read()
    expect(doc.model_profiles).toHaveLength(2)
    expect(doc.model_profiles[0]).toMatchObject({
      id: 'm1',
      providerId: 'p1',
      displayName: '展示名',
      contextWindow: 200_000,
      maxOutputTokens: 8192,
      supportsThinking: true,
      supportsTools: false,
      supportsVision: true,
      supports1MContext: true,
      enabled: true,
    })
    // ⚠️ 这几个是可选的运行偏好：白名单里漏掉就会在下次启动时静默丢失。
    expect(doc.model_profiles[1]).toMatchObject({
      displayName: 'camel',
      inputCostPerMillion: 3,
      outputCostPerMillion: 15,
      thinkingEnabled: true,
      reasoningEffort: 'high',
    })
  })

  it('可选字段未提供时不写入（保持 undefined 而不是塞默认值）', async () => {
    const { store, path } = await makeStore()
    await writeFile(
      path,
      JSON.stringify({ schema_version: 1, model_profiles: [{ id: 'm', providerId: 'p' }] }),
      'utf8',
    )
    const [stored] = (await store.read()).model_profiles
    expect(stored).toMatchObject({
      contextWindow: 125_000,
      maxOutputTokens: 128_000,
      supportsThinking: false,
      supportsTools: true,
      enabled: true,
    })
    expect(stored).not.toHaveProperty('displayName')
    expect(stored).not.toHaveProperty('inputCostPerMillion')
    expect(stored).not.toHaveProperty('thinkingEnabled')
    expect(stored).not.toHaveProperty('reasoningEffort')
  })

  it('档位分配过滤非法条目与非 object 的 fallback 项', async () => {
    const { store, path } = await makeStore()
    await writeFile(
      path,
      JSON.stringify({
        schema_version: 1,
        tier_assignments: [
          'not a record',
          { tier: 'unknown', modelRef: { providerId: 'p', modelId: 'm' } },
          { tier: 'implementation' },
          {
            tier: 'implementation',
            modelRef: { provider_id: 'p1', model_id: 'm1' },
            max_cost_per_turn: 2,
            fallback_model_refs: [
              'nope',
              { providerId: 'p2' },
              { provider_id: 'p3', model_id: 'm3' },
            ],
          },
          {
            tier: 'reasoning',
            // modelRef 不是 object → 视为 {}，随后因缺 id 被丢弃。
            model_ref: 'oops',
            fallback_model_refs: 'oops',
          },
        ],
      }),
      'utf8',
    )
    const doc = await store.read()
    expect(doc.tier_assignments).toHaveLength(1)
    expect(doc.tier_assignments[0]).toMatchObject({
      tier: ModelTier.IMPLEMENTATION,
      modelRef: { providerId: 'p1', modelId: 'm1' },
      enabled: true,
      maxCostPerTurn: 2,
      fallbackModelRefs: [{ providerId: 'p3', modelId: 'm3' }],
    })
  })

  it('非法的数组/对象字段回落到空值，mcp_servers 存在才保留', async () => {
    const { store, path } = await makeStore()
    await writeFile(
      path,
      JSON.stringify({
        schema_version: 1,
        providers: 'nope',
        model_profiles: 'nope',
        tier_assignments: 'nope',
        app_settings: 'nope',
        llm_channels: [{ ok: true }, 42],
        llm_models: [42],
      }),
      'utf8',
    )
    const bare = await store.read()
    expect(bare).toMatchObject({
      providers: [],
      model_profiles: [],
      tier_assignments: [],
      app_settings: {},
      // `filter(isRecord)` 会把 'ok' 这类非 object 项去掉，只留真正的 object。
      llm_channels: [{ ok: true }],
      llm_models: [],
    })
    // 旧文件没有 mcp_servers → 读回时也不凭空造出这个字段。
    expect(bare).not.toHaveProperty('mcp_servers')

    await writeFile(
      path,
      JSON.stringify({ schema_version: 1, mcp_servers: [{ name: 'x' }] }),
      'utf8',
    )
    await expect(store.read()).resolves.toMatchObject({ mcp_servers: [{ name: 'x' }] })
  })

  it('app_settings 的非字符串值被字符串化', async () => {
    const { store, path } = await makeStore()
    await writeFile(
      path,
      JSON.stringify({ schema_version: 1, app_settings: { a: 'x', b: 1, c: true } }),
      'utf8',
    )
    await expect(store.read()).resolves.toMatchObject({
      app_settings: { a: 'x', b: '1', c: 'true' },
    })
  })
})

describe('ConfigStore 写入与校验', () => {
  it('save 落盘规范化后的文档，load 能读回', async () => {
    const { store, path } = await makeStore()
    const saved = await store.save({
      schema_version: 1,
      llm_channels: [],
      llm_models: [],
      app_settings: {},
      providers: [{ ...provider, enabled: true }],
      model_profiles: [profile],
      tier_assignments: [],
    })
    expect(saved.providers).toHaveLength(1)
    expect(await readRaw(path)).toMatchObject({ schema_version: 1 })
    await expect(store.load()).resolves.toMatchObject({ providers: [{ id: 'p1' }] })
  })

  it('upsertProvider 按 id 覆盖而不是追加', async () => {
    const { store } = await makeStore()
    await store.upsertProvider(provider)
    await store.upsertProvider({ ...provider, name: 'renamed' })
    await expect(store.read()).resolves.toMatchObject({
      providers: [{ id: 'p1', name: 'renamed' }],
    })
  })

  it('upsertProvider 对缺少 enabled 字段的输入补 true，并保留显式的 false', async () => {
    const { store } = await makeStore()
    const { createdAt, updatedAt, ...withoutEnabled } = provider
    void createdAt
    void updatedAt
    await store.upsertProvider(withoutEnabled as Provider)
    await store.upsertProvider({ ...provider, id: 'p2', enabled: false })
    await expect(store.read()).resolves.toMatchObject({
      providers: [
        { id: 'p1', enabled: true },
        { id: 'p2', enabled: false },
      ],
    })
  })

  it('upsertModelProfile 逐条校验必填项', async () => {
    const { store } = await makeStore()
    await store.upsertProvider(provider)
    const bad: readonly [string, Partial<ModelProfile>][] = [
      ['空 id', { id: '  ' }],
      ['空 providerId', { providerId: ' ' }],
      ['contextWindow 非整数', { contextWindow: 1.5 }],
      ['contextWindow 非正', { contextWindow: 0 }],
      ['maxOutputTokens 非整数', { maxOutputTokens: 1.5 }],
      ['maxOutputTokens 非正', { maxOutputTokens: 0 }],
      ['maxOutputTokens 超过 contextWindow', { maxOutputTokens: 200_000 }],
    ]
    for (const [label, patch] of bad) {
      await expect(store.upsertModelProfile({ ...profile, ...patch }), label).rejects.toMatchObject(
        { code: ErrorCode.VALIDATION_FAILED },
      )
    }
  })

  it('upsertModelProfile 拒绝未注册的 provider', async () => {
    const { store } = await makeStore()
    await expect(
      store.upsertModelProfile({ ...profile, providerId: 'ghost' }),
    ).rejects.toMatchObject({ code: ErrorCode.MODEL_NOT_FOUND })
  })

  it('upsertModelProfile 按 (id, providerId) 覆盖，同名不同供应商各留一份', async () => {
    const { store } = await makeStore()
    await store.upsertProvider(provider)
    await store.upsertProvider({ ...provider, id: 'p2', name: 'P2' })
    await store.upsertModelProfile(profile)
    await store.upsertModelProfile({ ...profile, contextWindow: 200_000 })
    await store.upsertModelProfile({ ...profile, providerId: 'p2' })
    const doc = await store.read()
    expect(doc.model_profiles).toHaveLength(2)
    expect(doc.model_profiles.find((p) => p.providerId === 'p1')).toMatchObject({
      contextWindow: 200_000,
    })
  })

  it('setTierAssignment 按 tier 覆盖，并拒绝未知档位', async () => {
    const { store } = await makeStore()
    const assignment: TierAssignment = {
      tier: ModelTier.IMPLEMENTATION,
      modelRef: { providerId: 'p1', modelId: 'm1' },
      enabled: true,
      fallbackModelRefs: [],
    }
    await store.setTierAssignment(assignment)
    await store.setTierAssignment({ ...assignment, enabled: false })
    await expect(store.read()).resolves.toMatchObject({
      tier_assignments: [{ tier: ModelTier.IMPLEMENTATION, enabled: false }],
    })
    await expect(
      store.setTierAssignment({ ...assignment, tier: 'nope' as TierAssignment['tier'] }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_FAILED })
  })

  it('initialize 落盘一份空配置', async () => {
    const { store, path } = await makeStore()
    await expect(store.initialize()).resolves.toMatchObject({ schema_version: 1 })
    expect(await readRaw(path)).toMatchObject({ schema_version: 1, providers: [] })
  })
})

describe('ConfigStore baseUrl 校验', () => {
  const httpOnly = 'provider baseUrl must be http(s)'
  const apiRoot = 'provider baseUrl must be API root, not /v1/messages'
  const cases: readonly [string, string, string][] = [
    ['非 http(s) 协议', 'ftp://example.com', httpOnly],
    ['带用户名', 'https://user@example.com', httpOnly],
    ['带密码', 'https://user:pw@example.com', httpOnly],
    ['带查询串', 'https://example.com/?x=1', httpOnly],
    ['带片段', 'https://example.com/#x', httpOnly],
    ['误填 messages 端点', 'https://example.com/v1/messages', apiRoot],
    ['误填 messages 端点（带尾斜杠）', 'https://example.com/v1/messages/', apiRoot],
  ]

  for (const [label, baseUrl, message] of cases) {
    it(`拒绝${label}`, async () => {
      const { store } = await makeStore()
      await expect(store.upsertProvider({ ...provider, baseUrl })).rejects.toMatchObject({
        code: ErrorCode.VALIDATION_FAILED,
        message,
      })
    })
  }

  it('无法解析的 URL 被拒绝（原先的兜底让校验全部落空）', async () => {
    // 这里原本固化的是一个缺口（已修）：
    //
    // `validateProvider()` 在 `new URL()` 抛错时把 `parsed` 兜底成
    // `new URL('http://invalid')`，于是后面的协议/用户名/查询串检查**全部落空**，
    // 原始字符串被原样写入配置，错误被推迟到真正发请求时（拼出非法 URL →
    // fetch 抛 TypeError → PROVIDER_CONNECTION_FAILED）。
    //
    // 兜底值最坏的地方不是"放过了一个坏值"，而是它让后续检查**看起来跑过了**。
    // 旧项目对 `base_url` 完全不校验（只做 rstrip），所以这不是回归——它是本实现
    // 新增校验里的缺口：加了检查，却没让它生效。
    const { store } = await makeStore()
    await expect(store.upsertProvider({ ...provider, baseUrl: 'not a url' })).rejects.toMatchObject(
      { code: ErrorCode.VALIDATION_FAILED },
    )
  })

  it('http 协议（非 https）是允许的——本地兼容端点常见', async () => {
    const { store } = await makeStore()
    await expect(
      store.upsertProvider({ ...provider, baseUrl: 'http://localhost:8080' }),
    ).resolves.toMatchObject({ providers: [{ baseUrl: 'http://localhost:8080' }] })
  })

  it('拒绝空白密钥引用', async () => {
    const { store } = await makeStore()
    await expect(
      store.upsertProvider({ ...provider, apiKeyRef: { source: 'env', key: '  ' } }),
    ).rejects.toMatchObject({
      code: ErrorCode.VALIDATION_FAILED,
      message: 'provider apiKeyRef is required',
    })
  })
})
