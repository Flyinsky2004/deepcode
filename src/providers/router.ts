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
}

export function canonicalModelRef(ref: ModelRef): string {
  return `${ref.providerId}/${ref.modelId}`
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
    return { provider, model, tier: intent.tier, candidates }
  }
}
