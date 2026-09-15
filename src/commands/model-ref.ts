/**
 * `provider/model` 引用的解析。
 *
 * 难点在于 **`/` 在两边都可能出现**：provider 展示名允许含空格和短横线，
 * 而 model id 本身常带 `/`（如 `anthropic/claude-sonnet-5` 形态的供应商前缀）。
 * 因此不能简单地按第一个 `/` 切开。
 *
 * `parts/09` §6.1 第 4 条的要求是：**不能随机选择**。存在多个相同展示名称时
 * 「必须提示用户使用唯一 canonical 引用」。这里的做法是把两种切分都试一遍，
 * 只有唯一命中才接受。
 */

import type { CommandConfigView } from './types.js'

export type ModelRefResolution =
  | {
      readonly ok: true
      readonly providerId: string
      readonly modelId: string
      readonly providerName: string
    }
  | { readonly ok: false; readonly reason: ModelRefFailure; readonly message: string }

export const ModelRefFailure = {
  MALFORMED: 'malformed',
  NOT_FOUND: 'not_found',
  AMBIGUOUS: 'ambiguous',
  DISABLED: 'disabled',
  NO_SECRET: 'no_secret',
  CAPABILITY: 'capability',
} as const

export type ModelRefFailure = (typeof ModelRefFailure)[keyof typeof ModelRefFailure]

/** 在配置里按 id 或展示名找一个 provider（大小写不敏感，展示名允许含空格）。 */
const findProvider = (config: CommandConfigView, token: string) => {
  const needle = token.trim().toLowerCase()
  return config.providers.filter(
    (p) => p.id.toLowerCase() === needle || p.name.toLowerCase() === needle,
  )
}

const findModel = (config: CommandConfigView, providerId: string, token: string) => {
  const needle = token.trim().toLowerCase()
  return config.models.filter(
    (m) =>
      m.providerId === providerId &&
      (m.id.toLowerCase() === needle || m.displayName.toLowerCase() === needle),
  )
}

/**
 * 解析 `<provider>/<model>`。
 *
 * 两种切分都尝试：第一个 `/` 与最后一个 `/`。只有恰好一种切分命中才接受；
 * 两种都命中说明引用有歧义，必须让用户改用 canonical 形式。
 */
export function resolveModelRef(ref: string, config: CommandConfigView): ModelRefResolution {
  const trimmed = ref.trim()
  const firstSlash = trimmed.indexOf('/')
  if (firstSlash <= 0 || firstSlash === trimmed.length - 1)
    return {
      ok: false,
      reason: ModelRefFailure.MALFORMED,
      message: `模型引用必须是 provider/model 形式，收到：${ref}`,
    }

  // 候选切分点：第一个 `/` 与最后一个 `/`（相同时只有一个）
  const cuts = [...new Set([firstSlash, trimmed.lastIndexOf('/')])].filter(
    (i) => i > 0 && i < trimmed.length - 1,
  )

  const matches: { providerId: string; modelId: string; providerName: string }[] = []
  for (const cut of cuts) {
    const providerToken = trimmed.slice(0, cut)
    const modelToken = trimmed.slice(cut + 1)
    for (const provider of findProvider(config, providerToken)) {
      for (const model of findModel(config, provider.id, modelToken)) {
        const candidate = {
          providerId: provider.id,
          modelId: model.id,
          providerName: provider.name,
        }
        if (
          !matches.some(
            (m) => m.providerId === candidate.providerId && m.modelId === candidate.modelId,
          )
        )
          matches.push(candidate)
      }
    }
  }

  const only = matches[0]
  if (matches.length === 0)
    return {
      ok: false,
      reason: ModelRefFailure.NOT_FOUND,
      message: `找不到模型 ${ref}。请用 canonical 形式 providerId/modelId，例如 provider_xxx/model_yyy`,
    }
  if (matches.length > 1 && only !== undefined)
    return {
      ok: false,
      reason: ModelRefFailure.AMBIGUOUS,
      message:
        `模型引用 ${ref} 有歧义，可能指：` +
        matches.map((m) => `${m.providerId}/${m.modelId}`).join('、') +
        '。请使用 canonical 形式。',
    }

  return { ok: true, ...only! }
}

/**
 * 执行前的能力校验（`parts/09` §6.1「执行前必须检查」）。
 *
 * 检查顺序固定：provider 存在 → provider 启用 → 模型启用 → secret 可用 →
 * 任务所需能力。**任一失败都返回明确原因，绝不静默回退到全局档位**。
 */
export function checkCapability(
  ref: { providerId: string; modelId: string; providerName: string },
  config: CommandConfigView,
  options: { readonly requiresTools: boolean },
): ModelRefResolution {
  const provider = config.providers.find((p) => p.id === ref.providerId)
  if (!provider)
    return {
      ok: false,
      reason: ModelRefFailure.NOT_FOUND,
      message: `provider 不存在：${ref.providerId}`,
    }
  if (!provider.enabled)
    return {
      ok: false,
      reason: ModelRefFailure.DISABLED,
      message: `provider 已禁用：${ref.providerName}`,
    }
  if (!provider.hasSecret)
    // 只检查存在性，不读取明文（parts/09 §9.1：API key 不得出现在日志/事件/前端）
    return {
      ok: false,
      reason: ModelRefFailure.NO_SECRET,
      message: `provider ${ref.providerName} 的凭据不可用，请先在配置中设置`,
    }

  const model = config.models.find((m) => m.providerId === ref.providerId && m.id === ref.modelId)
  if (!model)
    return {
      ok: false,
      reason: ModelRefFailure.NOT_FOUND,
      message: `模型不存在：${ref.modelId}`,
    }
  if (!model.enabled)
    return {
      ok: false,
      reason: ModelRefFailure.DISABLED,
      message: `模型已禁用：${ref.modelId}`,
    }
  if (options.requiresTools && !model.supportsTools)
    return {
      ok: false,
      reason: ModelRefFailure.CAPABILITY,
      message: `模型 ${ref.modelId} 不支持工具调用，无法用于需要工具的编程任务`,
    }

  return { ok: true, ...ref }
}
