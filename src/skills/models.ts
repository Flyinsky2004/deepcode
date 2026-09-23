import type { SkillGuardRef } from '../core/tool.js'

/** Skill 文件的来源层级。顺序由 `SkillRegistry` 固定为 project > user > builtin。 */
export type SkillSource = 'project' | 'user-local' | 'builtin'

export interface SkillManifest {
  readonly name: string
  readonly description: string
  readonly version: string
  readonly category: string
  readonly tags: readonly string[]
  readonly triggers: readonly string[]
  readonly constraints: readonly Readonly<Record<string, unknown>>[]
  readonly relatedSkills: readonly string[]
  readonly priority: number
  readonly source: SkillSource
  readonly ref: string
}

export interface LoadedSkill {
  readonly manifest: SkillManifest
  readonly path: string
  readonly body: string
  readonly sections: Readonly<Record<string, string>>
  /** SKILL.md 原始 UTF-8 字节的 SHA-256。 */
  readonly checksum: string
}

export interface InvalidSkill {
  readonly path: string
  readonly reason: string
}

export interface SkillCatalogSnapshot {
  readonly loadedSkills: readonly LoadedSkill[]
  readonly invalidSkills: readonly InvalidSkill[]
  readonly checksum: string
  readonly byName?: (name: string) => LoadedSkill | undefined
}

export interface RejectedSkill {
  readonly name: string
  readonly reason: 'lower ranked candidate' | 'no trigger matched'
  readonly score: number
}

export interface SkillDecision {
  readonly selected: readonly LoadedSkill[]
  readonly rejected: readonly RejectedSkill[]
  readonly confidence: number
  readonly reason: string
  readonly appliedRefs: readonly string[]
}

/** 与 PermissionEngine 共享的不可变 runtime guard。 */
export type RuntimeGuard = SkillGuardRef

export interface SkillRuntimeState {
  readonly appliedSkills: readonly string[]
  readonly activePhase: string
  readonly guardsApplied: readonly RuntimeGuard[]
  readonly decisionReason: string
}

export interface CompiledSkill {
  readonly planningInjection: string
  readonly runtimeGuards: readonly RuntimeGuard[]
  readonly phaseModel: readonly string[]
  readonly runtimeState: SkillRuntimeState
}

/** 固定在 turn 起点、随后随恢复/压缩继续使用的 skill 快照。 */
export interface SkillTurnSnapshot {
  readonly catalogChecksum: string
  readonly appliedSkills: readonly string[]
  readonly activePhase: string
  readonly planningInjection: string
  readonly runtimeGuards: readonly RuntimeGuard[]
  readonly decisionReason: string
}

export const SKILL_PHASE_MODEL = ['discover', 'validate', 'apply', 'verify'] as const
