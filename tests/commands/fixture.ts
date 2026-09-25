/**
 * 命令层测试的共用夹具。
 *
 * 抽出来的理由很实际：`/workwith`、`/model use`、`/thinking` 等五条命令都要
 * 一份"provider / 模型 / 档位"的配置视图，而模型的能力位（`supportsThinking`、
 * `supports1MContext`）正是这些用例要分别打中的开关。三份各自维护的夹具会在
 * 加一种能力位时只改到其中两份。
 *
 * ⚠️ 这不是测试文件（文件名不含 `.test.`），vitest 的 `include` 不会收集它。
 */

import {
  CommandResultCode,
  type CommandConfigView,
  type CommandHost,
  type ProviderConfigurationInput,
  type ProviderConfigurationResult,
} from '../../src/commands/types.js'
import type { PrincipalId, SessionId, TurnId } from '../../src/core/ids.js'

export const LOCAL = 'local' as PrincipalId
export const SESSION = 's1' as SessionId
export const PEER = 'peer' as PrincipalId

/**
 * 一份"什么都有"的配置视图。
 *
 * 覆盖的分支是刻意铺开的：正常 provider、禁用的 provider、没有凭据的 provider、
 * 名字带空格的 provider，以及支持/不支持工具、思考、1M 的各类模型。
 */
export const makeConfig = (over: Partial<CommandConfigView> = {}): CommandConfigView => ({
  providers: [
    { id: 'p_deepseek', name: 'DeepSeek', enabled: true, hasSecret: true },
    { id: 'p_openai', name: 'OpenAI', enabled: true, hasSecret: true },
    { id: 'p_off', name: 'Disabled', enabled: false, hasSecret: true },
    { id: 'p_nokey', name: 'NoKey', enabled: true, hasSecret: false },
    { id: 'p_spaced', name: 'My Provider', enabled: true, hasSecret: true },
  ],
  models: [
    {
      id: 'v4-flash',
      providerId: 'p_deepseek',
      displayName: 'v4-flash',
      enabled: true,
      supportsTools: true,
      supportsThinking: false,
      supports1MContext: false,
      contextWindow: 128_000,
      maxOutputTokens: 8_000,
    },
    {
      id: 'gpt-6-astra',
      providerId: 'p_openai',
      displayName: 'gpt-6-astra',
      enabled: true,
      supportsTools: true,
      supportsThinking: true,
      supports1MContext: true,
      contextWindow: 1_000_000,
      maxOutputTokens: 32_000,
    },
    {
      id: 'chat-only',
      providerId: 'p_deepseek',
      displayName: 'chat-only',
      enabled: true,
      supportsTools: false,
      supportsThinking: false,
      supports1MContext: false,
      contextWindow: 32_000,
      maxOutputTokens: 4_000,
    },
    {
      id: 'off-model',
      providerId: 'p_deepseek',
      displayName: 'off-model',
      enabled: false,
      supportsTools: true,
      supportsThinking: false,
      supports1MContext: false,
      contextWindow: 32_000,
      maxOutputTokens: 4_000,
    },
    {
      // 给 p_nokey 配一个模型，否则解析阶段就会 MODEL_NOT_FOUND，
      // 根本走不到凭据检查那一步
      id: 'nokey-model',
      providerId: 'p_nokey',
      displayName: 'nokey-model',
      enabled: true,
      supportsTools: true,
      supportsThinking: false,
      supports1MContext: false,
      contextWindow: 32_000,
      maxOutputTokens: 4_000,
    },
    {
      id: 'm',
      providerId: 'p_spaced',
      displayName: 'm',
      enabled: true,
      supportsTools: true,
      supportsThinking: false,
      supports1MContext: false,
      contextWindow: 32_000,
      maxOutputTokens: 4_000,
    },
  ],
  tiers: [],
  settings: {},
  raw: {},
  ...over,
})

/** 主模型分配：`p_openai/gpt-6-astra`（支持工具、思考、1M）。 */
export const primaryTier = {
  tier: 'implementation' as const,
  providerId: 'p_openai',
  modelId: 'gpt-6-astra',
  enabled: true,
}

/**
 * 记录副作用的假 host。
 *
 * 每次写操作都记录成数组而不是只存最后一个值：这些命令的**幂等与顺序**是
 * 语义的一部分（`/effort` 必须把 thinking 与 effort 合成一次写，旧实现在这里
 * 分成两次写、第二次还失败）。只留终值会让"写了几次"无从断言。
 */
export class RecordingHost implements CommandHost {
  readonly localPrincipalId = LOCAL
  readonly published: { type: string; data: unknown }[] = []
  readonly preferenceWrites: {
    tier: string
    patch: { thinkingEnabled?: boolean; reasoningEffort?: string }
  }[] = []
  readonly tierAssignments: { tier: string; providerId: string; modelId: string }[] = []
  readonly contextWindowWrites: { tier: string; contextWindow: number }[] = []
  readonly providerAdds: ProviderConfigurationInput[] = []
  readonly idempotency = new Map<string, { requestHash: string; response: unknown }>()
  busy = false
  config: CommandConfigView = makeConfig()

  listSessions() {
    return Promise.resolve([])
  }
  createSession() {
    return Promise.resolve({ id: 's_new' as SessionId })
  }
  sessionExists() {
    return Promise.resolve(true)
  }
  isBusy(): boolean {
    return this.busy
  }
  cancelTurn(): boolean {
    this.busy = false
    return true
  }
  awaitTurn(): Promise<void> {
    return Promise.resolve()
  }
  submitTurn() {
    return Promise.resolve({ turnId: 'turn_new' as TurnId })
  }
  readConfig() {
    return Promise.resolve(this.config)
  }
  updateConfig(): Promise<void> {
    return Promise.resolve()
  }
  updateModelPreferences(
    tier: string,
    patch: { thinkingEnabled?: boolean; reasoningEffort?: string },
  ): Promise<void> {
    this.preferenceWrites.push({ tier, patch })
    // 与 `assignTierModel` 同理：假 host 也必须**真的改快照**。
    // 只记录调用会让"命令写进去了没有"这类断言失去落点——
    // 端到端用例（acceptance/phase6）能验到，命令层用例就验不到。
    this.config = { ...this.config, models: this.#patchActiveModel(tier, patch) }
    return Promise.resolve()
  }
  assignTierModel(tier: string, providerId: string, modelId: string): Promise<void> {
    this.tierAssignments.push({ tier, providerId, modelId })
    // 写后回读要能反映落盘结果——`/model use` 会 readConfig 一次来展示
    // "磁盘上真的写成了什么"。假 host 若不更新快照，那条断言就测不到东西。
    this.config = {
      ...this.config,
      tiers: [
        ...this.config.tiers.filter((t) => t.tier !== tier),
        { tier: tier as never, providerId, modelId, enabled: true },
      ],
    }
    return Promise.resolve()
  }
  setModelContextWindow(tier: string, contextWindow: number): Promise<void> {
    this.contextWindowWrites.push({ tier, contextWindow })
    this.config = { ...this.config, models: this.#patchActiveModel(tier, { contextWindow }) }
    return Promise.resolve()
  }
  addProviderConfiguration(
    input: ProviderConfigurationInput,
  ): Promise<ProviderConfigurationResult> {
    this.providerAdds.push(input)
    const providerId = `provider_${input.name.toLowerCase().replace(/\W+/g, '_')}`
    const envName = `DEEPCODE_${input.name.replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase()}_API_KEY`
    const assignedImplementation = !this.config.tiers.some((tier) => tier.tier === 'implementation')
    this.config = {
      ...this.config,
      providers: [
        ...this.config.providers,
        {
          id: providerId,
          name: input.name,
          baseUrl: input.baseUrl,
          enabled: true,
          hasSecret: false,
        },
      ],
      models: [
        ...this.config.models,
        ...input.modelIds.map((id) => ({
          id,
          providerId,
          displayName: id,
          enabled: true,
          supportsTools: true,
          supportsThinking: false,
          supports1MContext: false,
          contextWindow: input.contextWindow,
          maxOutputTokens: input.maxOutputTokens,
        })),
      ],
      tiers: assignedImplementation
        ? [
            ...this.config.tiers,
            {
              tier: 'implementation',
              providerId,
              modelId: input.modelIds[0] ?? '',
              enabled: true,
            },
          ]
        : this.config.tiers,
    }
    return Promise.resolve({
      providerId,
      envName,
      modelIds: input.modelIds,
      assignedImplementation,
    })
  }
  /** 按档位找到它指向的模型条目并打补丁——与 `AgentApplication` 的真实行为同形。 */
  #patchActiveModel(
    tier: string,
    patch: Partial<{
      thinkingEnabled: boolean
      reasoningEffort: string
      contextWindow: number
    }>,
  ): CommandConfigView['models'] {
    const assignment = this.config.tiers.find((t) => t.tier === tier)
    if (assignment === undefined) return this.config.models
    return this.config.models.map((m) =>
      m.providerId === assignment.providerId && m.id === assignment.modelId
        ? { ...m, ...patch }
        : m,
    )
  }
  publish(input: { type: string; data: unknown }): Promise<void> {
    this.published.push({ type: input.type, data: input.data })
    return Promise.resolve()
  }
  getIdempotency(key: string) {
    return Promise.resolve(this.idempotency.get(key))
  }
  putIdempotency(r: { key: string; requestHash: string; response: unknown }): Promise<void> {
    this.idempotency.set(r.key, { requestHash: r.requestHash, response: r.response })
    return Promise.resolve()
  }
  recordCommandResult() {
    return Promise.resolve('msg_1')
  }
  compact() {
    return Promise.resolve({ ok: true, code: CommandResultCode.OK, text: '' })
  }
  now(): string {
    return '2026-09-15T00:00:00.000Z'
  }
}
