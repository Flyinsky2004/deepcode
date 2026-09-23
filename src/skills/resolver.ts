import type { LoadedSkill, SkillCatalogSnapshot, SkillDecision, RejectedSkill } from './models.js'

// BUG-COMPAT: 旧 resolver 只识别小写 ASCII；大写字母会切断词，纯中文请求
// 不产生 token。Phase 8 保留此匹配集，避免迁移后已配置 skill 的命中发生漂移。
const TOKEN_RE = /[a-z0-9_\-/]+/gu

export function tokens(value: string | readonly string[]): readonly string[] {
  if (typeof value !== 'string') return value.map((item) => String(item).toLowerCase())
  return [...value.matchAll(TOKEN_RE)].map((match) => match[0].toLowerCase())
}

function matchCount(queryTokens: ReadonlySet<string>, candidates: readonly string[]): number {
  return candidates.reduce(
    (count, token) => count + (queryTokens.has(token.toLowerCase()) ? 1 : 0),
    0,
  )
}

export function scoreSkill(query: string, skill: LoadedSkill): number {
  const queryTokens = new Set(tokens(query))
  if (queryTokens.size === 0) return 0
  const manifest = skill.manifest
  let score = 0
  score += matchCount(queryTokens, tokens(manifest.name)) * 4
  score += matchCount(queryTokens, tokens(manifest.description)) * 3
  score += matchCount(queryTokens, tokens(manifest.tags)) * 4
  score += matchCount(queryTokens, tokens(manifest.triggers)) * 5
  score += matchCount(queryTokens, tokens(skill.sections['when_to_use'] ?? '')) * 2
  score += matchCount(queryTokens, tokens(skill.sections['workflow'] ?? ''))
  return score + manifest.priority
}

export class SkillResolver {
  resolve(
    query: string,
    catalog: SkillCatalogSnapshot,
    topKOrOptions: number | { readonly topK?: number; readonly top_k?: number } = 3,
  ): SkillDecision {
    const topK =
      typeof topKOrOptions === 'number'
        ? topKOrOptions
        : (topKOrOptions.topK ?? topKOrOptions.top_k ?? 3)
    const scored = catalog.loadedSkills
      .map((skill) => ({ skill, score: scoreSkill(query, skill) }))
      .sort((a, b) => {
        const scoreOrder = b.score - a.score
        if (scoreOrder !== 0) return scoreOrder
        const priorityOrder = b.skill.manifest.priority - a.skill.manifest.priority
        if (priorityOrder !== 0) return priorityOrder
        return a.skill.manifest.name < b.skill.manifest.name
          ? -1
          : a.skill.manifest.name > b.skill.manifest.name
            ? 1
            : 0
      })
    const selected = scored
      .filter((item) => item.score > 0)
      .slice(0, topK)
      .map((item) => item.skill)
    const selectedSet = new Set(selected)
    const rejected: RejectedSkill[] = scored
      .filter((item) => !selectedSet.has(item.skill))
      .map((item) => ({
        name: item.skill.manifest.name,
        score: item.score,
        reason: item.score > 0 ? 'lower ranked candidate' : 'no trigger matched',
      }))
    if (selected.length === 0)
      return {
        selected,
        rejected,
        confidence: 0,
        reason: 'no skill matched the request',
        appliedRefs: [],
      }
    const bestScore = scored[0]?.score ?? 0
    return {
      selected,
      rejected,
      confidence: Math.min(1, bestScore / 12),
      reason: 'selected by deterministic keyword, tag, and workflow matching',
      appliedRefs: selected.map((skill) => skill.manifest.ref),
    }
  }
}

export function resolveSkills(
  query: string,
  catalog: SkillCatalogSnapshot,
  topK: number | { readonly topK?: number; readonly top_k?: number } = 3,
): SkillDecision {
  return new SkillResolver().resolve(query, catalog, topK)
}

export const score_skill = scoreSkill
export const resolve_skills = resolveSkills
