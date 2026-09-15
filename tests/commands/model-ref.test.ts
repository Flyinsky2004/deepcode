/**
 * `provider/model` 引用解析与执行前能力校验。
 *
 * `parts/09` §6.1 第 4 条要求「存在多个相同展示名称时**不能随机选择**，
 * 必须提示用户使用唯一 canonical 引用」。所以这里重点覆盖两类分支：
 * **歧义必须报歧义**、**每一种不可用都要给出明确原因**（绝不静默回退）。
 */
import { describe, expect, it } from 'vitest'

import { ModelRefFailure, checkCapability, resolveModelRef } from '../../src/commands/model-ref.js'
import type { CommandConfigView } from '../../src/commands/types.js'

type ProviderView = CommandConfigView['providers'][number]
type ModelView = CommandConfigView['models'][number]

const provider = (over: Partial<ProviderView> = {}): ProviderView => ({
  id: 'p',
  name: 'Provider One',
  enabled: true,
  hasSecret: true,
  ...over,
})

const model = (over: Partial<ModelView> = {}): ModelView => ({
  id: 'm1',
  providerId: 'p',
  displayName: 'm1',
  enabled: true,
  supportsTools: true,
  supportsThinking: true,
  supports1MContext: false,
  contextWindow: 100_000,
  maxOutputTokens: 4096,
  ...over,
})

const view = (over: Partial<CommandConfigView> = {}): CommandConfigView => ({
  providers: [provider()],
  models: [model()],
  tiers: [],
  settings: {},
  raw: {},
  ...over,
})

describe('resolveModelRef：形态与命中', () => {
  it('没有斜杠、以斜杠开头、以斜杠结尾都是 malformed', () => {
    const config = view()
    for (const ref of ['m1', '/m1', 'p/']) {
      const result = resolveModelRef(ref, config)
      expect(result.ok, ref).toBe(false)
      expect(result.ok === false && result.reason).toBe(ModelRefFailure.MALFORMED)
    }
  })

  it('按 provider id + model id 命中', () => {
    const result = resolveModelRef('p/m1', view())
    expect(result).toMatchObject({
      ok: true,
      providerId: 'p',
      modelId: 'm1',
      providerName: 'Provider One',
    })
  })

  it('大小写不敏感，展示名里的空格会被 trim', () => {
    const config = view({
      providers: [provider({ id: 'p', name: 'Provider One' })],
      models: [model({ id: 'm1', displayName: 'Sonnet Five' })],
    })
    expect(resolveModelRef('  PROVIDER ONE / SONNET FIVE  ', config)).toMatchObject({
      ok: true,
      providerId: 'p',
      modelId: 'm1',
    })
  })

  it('找不到时提示 canonical 形式，而不是只说"失败"', () => {
    const result = resolveModelRef('p/nope', view())
    expect(result.ok === false && result.reason).toBe(ModelRefFailure.NOT_FOUND)
    expect(result.ok === false && result.message).toMatch(/canonical/)
  })
})

describe('resolveModelRef：两种切分与歧义', () => {
  it('model id 自带 `/` 时靠"最后一个斜杠"也能切对', () => {
    // 供应商前缀形态的 model id（如 anthropic/claude-sonnet-5）必须能解析
    const config = view({
      providers: [provider({ id: 'p' })],
      models: [model({ id: 'anthropic/claude-sonnet-5' })],
    })
    expect(resolveModelRef('p/anthropic/claude-sonnet-5', config)).toMatchObject({
      ok: true,
      providerId: 'p',
      modelId: 'anthropic/claude-sonnet-5',
    })
  })

  it('两种切分各自命中不同模型 → AMBIGUOUS，且列出候选', () => {
    // `parts/09` §6.1 第 4 条：歧义时**不能随机选一个**，必须要求 canonical 形式
    const config = view({
      providers: [provider({ id: 'a', name: 'A' }), provider({ id: 'a/b', name: 'AB' })],
      models: [
        model({ id: 'b/c', providerId: 'a', displayName: 'b/c' }),
        model({ id: 'c', providerId: 'a/b', displayName: 'c' }),
      ],
    })
    const result = resolveModelRef('a/b/c', config)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toBe(ModelRefFailure.AMBIGUOUS)
    expect(result.ok === false && result.message).toContain('a/b/c')
    expect(result.ok === false && result.message).toMatch(/canonical/)
  })

  it('两种切分指向**同一个**模型时不算歧义（去重生效）', () => {
    // 展示名恰好等于含斜杠的 token 时，两次切分会得到同一个 (providerId, modelId)；
    // 这时若不做去重就会误报歧义，用户明明用的是唯一引用却被要求改写法。
    const config = view({
      providers: [provider({ id: 'a', name: 'a/b' })],
      models: [{ ...model({ id: 'c', providerId: 'a' }), displayName: 'b/c' }],
    })
    expect(resolveModelRef('a/b/c', config)).toMatchObject({
      ok: true,
      providerId: 'a',
      modelId: 'c',
    })
  })
})

describe('checkCapability：执行前的逐项校验', () => {
  const ok = { providerId: 'p', modelId: 'm1', providerName: 'Provider One' }

  it('通过时原样回传引用', () => {
    expect(checkCapability(ok, view(), { requiresTools: true })).toEqual({ ok: true, ...ok })
  })

  it('provider 不存在', () => {
    const result = checkCapability(ok, view({ providers: [] }), { requiresTools: false })
    expect(result.ok === false && result.reason).toBe(ModelRefFailure.NOT_FOUND)
  })

  it('provider 被禁用', () => {
    const result = checkCapability(ok, view({ providers: [provider({ enabled: false })] }), {
      requiresTools: false,
    })
    expect(result.ok === false && result.reason).toBe(ModelRefFailure.DISABLED)
  })

  it('凭据不可用 → NO_SECRET，且**不读取明文**', () => {
    const result = checkCapability(ok, view({ providers: [provider({ hasSecret: false })] }), {
      requiresTools: false,
    })
    expect(result.ok === false && result.reason).toBe(ModelRefFailure.NO_SECRET)
  })

  it('模型不存在', () => {
    const result = checkCapability(ok, view({ models: [] }), { requiresTools: false })
    expect(result.ok === false && result.reason).toBe(ModelRefFailure.NOT_FOUND)
  })

  it('模型被禁用', () => {
    const result = checkCapability(ok, view({ models: [model({ enabled: false })] }), {
      requiresTools: false,
    })
    expect(result.ok === false && result.reason).toBe(ModelRefFailure.DISABLED)
  })

  it('需要工具但模型不支持 → CAPABILITY', () => {
    const result = checkCapability(ok, view({ models: [model({ supportsTools: false })] }), {
      requiresTools: true,
    })
    expect(result.ok === false && result.reason).toBe(ModelRefFailure.CAPABILITY)
  })

  it('不需要工具时模型不支持工具也放行（/api 这类只读命令）', () => {
    const result = checkCapability(ok, view({ models: [model({ supportsTools: false })] }), {
      requiresTools: false,
    })
    expect(result.ok).toBe(true)
  })

  it('provider 启用但模型属于别的 provider 时视为模型不存在', () => {
    // 越权借用别的 provider 的模型 id 必须被挡下，而不是"看起来能跑"
    const result = checkCapability(ok, view({ models: [model({ providerId: 'other' })] }), {
      requiresTools: false,
    })
    expect(result.ok === false && result.reason).toBe(ModelRefFailure.NOT_FOUND)
  })
})
