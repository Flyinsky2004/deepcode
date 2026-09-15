/**
 * ModelRouter 的分支覆盖。
 *
 * 路由是"选错模型"的唯一防线：`parts/09` §9.4 要求路由顺序固定，
 * 且**任何失败都必须给出明确原因**（不能静默回退到全局档位）。
 * 因此这里的重点不是"能解析出模型"，而是**每一种拒绝都走对了分支、
 * 报对了错误码**——错误码不同，上层给的提示与恢复动作就不同。
 */
import { describe, expect, it } from 'vitest'

import { ModelRouter, canonicalModelRef, modelDisplayName } from '../../src/providers/router.js'
import { ErrorCode } from '../../src/core/errors.js'
import {
  ModelTier,
  type ModelOverride,
  type Provider,
  type TaskIntent,
} from '../../src/core/provider.js'
import type { ConfigDocument } from '../../src/storage/types.js'

/** `Provider` 没有 `enabled`（那是 `StoredProvider` 的），但配置文档里要带它。 */
const provider = (over: Record<string, unknown> = {}): Provider => ({
  id: 'p',
  name: 'Provider One',
  baseUrl: 'https://api.anthropic.com',
  apiKeyRef: { source: 'env', key: 'K' },
  createdAt: '',
  updatedAt: '',
  ...over,
})

const model = (over: Record<string, unknown> = {}) => ({
  id: 'm1',
  providerId: 'p',
  contextWindow: 100_000,
  maxOutputTokens: 4096,
  supportsThinking: true,
  supportsTools: true,
  supportsVision: false,
  supports1MContext: false,
  enabled: true,
  ...over,
})

const doc = (over: Partial<ConfigDocument> = {}): ConfigDocument => ({
  schema_version: 1,
  llm_channels: [],
  llm_models: [],
  app_settings: {},
  providers: [provider({ enabled: true }) as never],
  model_profiles: [model()],
  tier_assignments: [
    {
      tier: ModelTier.IMPLEMENTATION,
      modelRef: { providerId: 'p', modelId: 'm1' },
      enabled: true,
      fallbackModelRefs: [],
    },
  ],
  ...over,
})

const intent = (over: Partial<TaskIntent> = {}): TaskIntent => ({
  tier: ModelTier.IMPLEMENTATION,
  purpose: 'implement',
  requiresTools: true,
  requiresThinking: false,
  ...over,
})

const override = (providerId = 'p', modelId = 'm1'): ModelOverride => ({
  overrideId: 'ov_1',
  scope: 'next-turn',
  providerId,
  modelId,
  requestedBy: 'local',
  instruction: '用它',
  createdAt: '2026-09-15T00:00:00.000Z',
})

describe('ModelRouter：配置来源', () => {
  it('构造时可直接传文档，也可传返回文档的（异步）函数', async () => {
    // 两种形态都要支持：契约层测试用同步文档，AgentApplication 用回调
    // 每次读取最新配置（配置改了不该重启进程）。
    const direct = new ModelRouter(doc())
    const lazy = new ModelRouter(() => Promise.resolve(doc()))

    expect((await direct.resolve(intent())).model.id).toBe('m1')
    expect((await lazy.resolve(intent())).model.id).toBe('m1')
  })

  it('displayName 缺失时退回 provider.name/modelId，不显示 undefined', () => {
    const withName = modelDisplayName(provider(), model({ displayName: '小模型' }))
    const withoutName = modelDisplayName(provider(), model())

    expect(withName).toBe('小模型')
    expect(withoutName).toBe('Provider One/m1')
    expect(canonicalModelRef({ providerId: 'p', modelId: 'm1' })).toBe('p/m1')
  })
})

describe('ModelRouter：候选来源与去重', () => {
  it('tier 未分配且没有 override → MODEL_NOT_FOUND（而不是回退到别的档位）', async () => {
    const router = new ModelRouter(doc({ tier_assignments: [] }))
    await expect(router.resolve(intent())).rejects.toMatchObject({
      code: ErrorCode.MODEL_NOT_FOUND,
    })
  })

  it('tier 被禁用等同于未分配', async () => {
    const router = new ModelRouter(
      doc({
        tier_assignments: [
          {
            tier: ModelTier.IMPLEMENTATION,
            modelRef: { providerId: 'p', modelId: 'm1' },
            enabled: false,
            fallbackModelRefs: [],
          },
        ],
      }),
    )
    await expect(router.resolve(intent())).rejects.toMatchObject({
      code: ErrorCode.MODEL_NOT_FOUND,
    })
  })

  it('override 可绕过 tier 分配单独生效', async () => {
    // /workwith 的 override 必须在档位未分配时也能用，否则"指定模型"这个动作
    // 会对没配置档位的用户完全无效。
    const router = new ModelRouter(doc({ tier_assignments: [] }))
    const route = await router.resolve(intent(), override())
    expect(route.model.id).toBe('m1')
  })

  it('主模型与 fallback 指向同一个引用时只尝试一次', async () => {
    const router = new ModelRouter(
      doc({
        tier_assignments: [
          {
            tier: ModelTier.IMPLEMENTATION,
            modelRef: { providerId: 'p', modelId: 'm1' },
            enabled: true,
            // 重复项（含与主模型相同的项）不应产生重复候选
            fallbackModelRefs: [
              { providerId: 'p', modelId: 'm1' },
              { providerId: 'p', modelId: 'm1' },
            ],
          },
        ],
      }),
    )
    const route = await router.resolve(intent())
    expect(route.candidates).toEqual([{ providerId: 'p', modelId: 'm1' }])
  })

  it('候选按顺序尝试，前一个不可用时用 fallback', async () => {
    const router = new ModelRouter(
      doc({
        providers: [provider({ enabled: true }) as never],
        model_profiles: [model(), model({ id: 'm2' })],
        tier_assignments: [
          {
            tier: ModelTier.IMPLEMENTATION,
            modelRef: { providerId: 'p', modelId: 'm1' },
            enabled: true,
            fallbackModelRefs: [{ providerId: 'p', modelId: 'm2' }],
          },
        ],
      }),
    )
    // m1 被禁用 → 落到 m2
    const disabledFirst = new ModelRouter(
      doc({
        model_profiles: [model({ enabled: false }), model({ id: 'm2' })],
        tier_assignments: [
          {
            tier: ModelTier.IMPLEMENTATION,
            modelRef: { providerId: 'p', modelId: 'm1' },
            enabled: true,
            fallbackModelRefs: [{ providerId: 'p', modelId: 'm2' }],
          },
        ],
      }),
    )
    expect((await router.resolve(intent())).model.id).toBe('m1')
    expect((await disabledFirst.resolve(intent())).model.id).toBe('m2')
  })
})

describe('ModelRouter：候选拒绝的原因与错误码', () => {
  it('provider 不存在', async () => {
    const router = new ModelRouter(doc({ providers: [] }))
    await expect(
      router.resolveCandidate(intent(), { providerId: 'p', modelId: 'm1' }),
    ).rejects.toMatchObject({
      code: ErrorCode.MODEL_NOT_FOUND,
      message: expect.stringContaining('disabled or missing'),
    })
  })

  it('模型不存在', async () => {
    const router = new ModelRouter(doc({ model_profiles: [] }))
    await expect(
      router.resolveCandidate(intent(), { providerId: 'p', modelId: 'm1' }),
    ).rejects.toMatchObject({ code: ErrorCode.MODEL_NOT_FOUND })
  })

  it('provider 被禁用', async () => {
    const router = new ModelRouter(doc({ providers: [provider({ enabled: false }) as never] }))
    await expect(
      router.resolveCandidate(intent(), { providerId: 'p', modelId: 'm1' }),
    ).rejects.toMatchObject({ code: ErrorCode.MODEL_NOT_FOUND })
  })

  it('模型被禁用', async () => {
    const router = new ModelRouter(doc({ model_profiles: [model({ enabled: false })] }))
    await expect(
      router.resolveCandidate(intent(), { providerId: 'p', modelId: 'm1' }),
    ).rejects.toMatchObject({ code: ErrorCode.MODEL_NOT_FOUND })
  })

  it('需要工具但模型不支持 → MODEL_CAPABILITY_UNAVAILABLE', async () => {
    const router = new ModelRouter(doc({ model_profiles: [model({ supportsTools: false })] }))
    await expect(router.resolve(intent({ requiresTools: true }))).rejects.toMatchObject({
      code: ErrorCode.MODEL_CAPABILITY_UNAVAILABLE,
    })
  })

  it('不需要工具时工具能力不参与判定', async () => {
    const router = new ModelRouter(doc({ model_profiles: [model({ supportsTools: false })] }))
    const route = await router.resolve(intent({ requiresTools: false }))
    expect(route.model.supportsTools).toBe(false)
  })

  it('需要思考但模型不支持 → MODEL_CAPABILITY_UNAVAILABLE', async () => {
    const router = new ModelRouter(doc({ model_profiles: [model({ supportsThinking: false })] }))
    await expect(router.resolve(intent({ requiresThinking: true }))).rejects.toMatchObject({
      code: ErrorCode.MODEL_CAPABILITY_UNAVAILABLE,
    })
  })

  it('预估输入超过上下文窗口 → MODEL_CAPABILITY_UNAVAILABLE（不是 NOT_FOUND）', async () => {
    // 区分这两种错误码有实际意义：能力不足时用户可以换个模型，
    // 而"找不到"意味着配置本身有问题。
    const router = new ModelRouter(doc())
    await expect(router.resolve(intent({ estimatedInputTokens: 100_001 }))).rejects.toMatchObject({
      code: ErrorCode.MODEL_CAPABILITY_UNAVAILABLE,
    })
  })

  it('预估输入刚好等于窗口时仍然可用', async () => {
    const router = new ModelRouter(doc())
    const route = await router.resolve(intent({ estimatedInputTokens: 100_000 }))
    expect(route.model.contextWindow).toBe(100_000)
  })

  it('未给预估输入时不做窗口判定', async () => {
    const router = new ModelRouter(doc({ model_profiles: [model({ contextWindow: 1 })] }))
    const route = await router.resolve(intent())
    expect(route.model.contextWindow).toBe(1)
  })
})

describe('ModelRouter：全部候选失败时的汇总', () => {
  it('失败原因里不含能力关键词 → MODEL_NOT_FOUND，且带上有界的原因列表', async () => {
    const router = new ModelRouter(doc({ providers: [], model_profiles: [] }))
    await expect(router.resolve(intent())).rejects.toMatchObject({
      code: ErrorCode.MODEL_NOT_FOUND,
      message: expect.stringContaining('no eligible model'),
    })
  })

  it('失败原因含 unsupported → MODEL_CAPABILITY_UNAVAILABLE', async () => {
    const router = new ModelRouter(doc({ model_profiles: [model({ supportsTools: false })] }))
    await expect(router.resolve(intent({ requiresTools: true }))).rejects.toMatchObject({
      code: ErrorCode.MODEL_CAPABILITY_UNAVAILABLE,
    })
  })

  it('候选抛出的非 AgentError 被折成一行可用信息，不冒泡原始异常', async () => {
    // 真实场景：provider 探测或插件式解析抛了原生 Error。
    // 路由必须把它变成"这个候选不可用"，而不是让 resolve 整体炸掉。
    class Exploding extends ModelRouter {
      override resolveCandidate(): Promise<never> {
        throw new Error('boom')
      }
    }
    const router = new Exploding(doc())
    await expect(router.resolve(intent())).rejects.toMatchObject({
      code: ErrorCode.MODEL_NOT_FOUND,
      message: expect.stringContaining('no eligible model'),
    })
    // 原始异常的信息不该泄露到 message 里（它可能带路径或密钥形态的文本）
    await expect(router.resolve(intent())).rejects.not.toThrow(/boom/)
  })
})
