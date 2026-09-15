import { AgentError, ErrorCode } from '../core/errors.js'
import {
  type ModelOverride,
  type ModelProfile,
  type ModelRef,
  type Provider,
  type TaskIntent,
} from '../core/provider.js'
import { type ConfigDocument } from '../storage/types.js'

export interface ResolvedModelRoute {
  readonly provider: Provider
  readonly model: ModelProfile
  readonly tier: TaskIntent['tier']
  readonly candidates: readonly ModelRef[]
  /**
   * `model` 在 `candidates` 中的下标。
   *
   * ⚠️ **必须用它，不能靠自增推。** `resolve()` 会跳过配置层就不可用的候选
   * （下面的 for/catch），所以返回的 `model` 未必是 `candidates[0]`。
   * 调用方若假定"我从下标 0 开始、每次 fallback 加一"，下标就会与实际运行的
   * 模型错位——表现为 fallback 时**重新请求刚失败的那个模型**。
   */
  readonly resolvedIndex: number
  /**
   * 该档位**自己**分配的模型，不受 override 影响；档位未启用或未配置时为
   * `undefined`。
   *
   * 存在的意义是让调用方能准确回答"没有 override 的话会用哪个模型"
   * ——`model_route_changed` 事件的 `from` 需要它。
   *
   * ⚠️ 不能从 `candidates` 反推：override 与档位模型相同时会被去重掉，
   * 于是 `candidates[1]` 变成回退链的第一个模型，"从哪来"就答错了。
   *
   * `undefined` 与"等于 `model`"是两种不同的情形，不能合并：
   * 前者是"本来就没有路由"（无档位时没有 override 会直接抛 `MODEL_NOT_FOUND`），
   * 后者是"路由没变"。用 `ref` 兜底会把前者伪装成后者。
   */
  readonly tierRef: ModelRef | undefined
}

export function canonicalModelRef(ref: ModelRef): string {
  return `${ref.providerId}/${ref.modelId}`
}

/** 两个引用是否指向同一个 provider 的同一个模型。 */
export function sameRef(a: ModelRef, b: ModelRef): boolean {
  return a.providerId === b.providerId && a.modelId === b.modelId
}

export function modelDisplayName(provider: Provider, model: ModelProfile): string {
  return model.displayName ?? `${provider.name}/${model.id}`
}

export class ModelRouter {
  readonly config: () => Promise<ConfigDocument> | ConfigDocument
  constructor(config: ConfigDocument | (() => Promise<ConfigDocument> | ConfigDocument)) {
    this.config = typeof config === 'function' ? config : () => config
  }

  async resolve(intent: TaskIntent, override?: ModelOverride): Promise<ResolvedModelRoute> {
    const cfg = await this.config()
    const assignment = cfg.tier_assignments.find((a) => a.tier === intent.tier && a.enabled)
    const refs: ModelRef[] = []
    if (override) refs.push({ providerId: override.providerId, modelId: override.modelId })
    if (assignment) refs.push(assignment.modelRef, ...assignment.fallbackModelRefs)
    if (refs.length === 0)
      throw new AgentError({
        code: ErrorCode.MODEL_NOT_FOUND,
        message: `no model assigned to tier ${intent.tier}`,
        source: 'router',
      })
    const candidates = refs.filter(
      (ref, index) =>
        refs.findIndex((r) => r.providerId === ref.providerId && r.modelId === ref.modelId) ===
        index,
    )
    const failures: string[] = []
    for (const ref of candidates) {
      try {
        return await this.resolveCandidate(intent, ref, candidates)
      } catch (error) {
        failures.push(
          error instanceof AgentError
            ? error.message
            : `${ref.providerId}/${ref.modelId}: unavailable`,
        )
      }
    }
    throw new AgentError({
      code: failures.some((v) => v.includes('unsupported') || v.includes('context'))
        ? ErrorCode.MODEL_CAPABILITY_UNAVAILABLE
        : ErrorCode.MODEL_NOT_FOUND,
      message: `no eligible model for tier ${intent.tier}`,
      source: 'router',
      context: { failures: failures.slice(0, 8) },
    })
  }

  async resolveCandidate(
    intent: TaskIntent,
    ref: ModelRef,
    candidates: readonly ModelRef[] = [ref],
  ): Promise<ResolvedModelRoute> {
    const cfg = await this.config()
    const provider = cfg.providers.find((p) => p.id === ref.providerId)
    const model = cfg.model_profiles.find(
      (m) => m.providerId === ref.providerId && m.id === ref.modelId,
    )
    if (!provider || !model || !provider.enabled || !model.enabled)
      throw new AgentError({
        code: ErrorCode.MODEL_NOT_FOUND,
        message: `${ref.providerId}/${ref.modelId}: disabled or missing`,
        source: 'router',
      })
    if (intent.requiresTools && !model.supportsTools)
      throw new AgentError({
        code: ErrorCode.MODEL_CAPABILITY_UNAVAILABLE,
        message: `${ref.modelId}: tools unsupported`,
        source: 'router',
      })
    if (intent.requiresThinking && !model.supportsThinking)
      throw new AgentError({
        code: ErrorCode.MODEL_CAPABILITY_UNAVAILABLE,
        message: `${ref.modelId}: thinking unsupported`,
        source: 'router',
      })
    if (
      intent.estimatedInputTokens !== undefined &&
      intent.estimatedInputTokens > model.contextWindow
    )
      throw new AgentError({
        code: ErrorCode.MODEL_CAPABILITY_UNAVAILABLE,
        message: `${ref.modelId}: context window too small`,
        source: 'router',
      })
    return {
      provider,
      model,
      tier: intent.tier,
      candidates,
      // 下标必须与 `candidates` 对齐；`ref` 不在其中时（调用方传了别的 ref）
      // 退回 0——那是"只有一个候选"的自环场景。
      resolvedIndex: Math.max(
        0,
        candidates.findIndex((c) => sameRef(c, ref)),
      ),
      // ⚠️ `&& a.enabled` 不能省：`resolve()` 构造 refs 时就是这么筛的。
      // 少了它，档位被禁用时 `tierRef` 会指向一个"没有 override 也不会被用"
      // 的模型（那时 `resolve()` 直接抛 MODEL_NOT_FOUND），事件叙述的
      // "从 A 换成 B" 就不成立了。
      tierRef: cfg.tier_assignments.find((a) => a.tier === intent.tier && a.enabled)?.modelRef,
    }
  }
}
