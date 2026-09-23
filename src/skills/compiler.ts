import { randomUUID } from 'node:crypto'

import type { PermissionAction, SkillGuardRef } from '../core/tool.js'
import type { CompiledSkill, RuntimeGuard, SkillDecision } from './models.js'
import { SKILL_PHASE_MODEL } from './models.js'

export class SkillCompiler {
  compile(decision: SkillDecision): CompiledSkill {
    const runtimeGuards = Object.freeze(
      decision.selected.flatMap((skill) =>
        compileConstraints(skill.manifest.name, skill.manifest.constraints),
      ),
    )
    const runtimeState = {
      appliedSkills: decision.appliedRefs,
      activePhase: SKILL_PHASE_MODEL[0],
      guardsApplied: runtimeGuards,
      decisionReason: decision.reason,
    } as const
    return {
      planningInjection: planningInjection(decision),
      runtimeGuards,
      phaseModel: SKILL_PHASE_MODEL,
      runtimeState,
    }
  }
}

export function compileSkill(decision: SkillDecision): CompiledSkill {
  return new SkillCompiler().compile(decision)
}

export function compileConstraints(
  skillName: string,
  constraints: readonly Readonly<Record<string, unknown>>[],
): readonly RuntimeGuard[] {
  return constraints.flatMap((constraint): RuntimeGuard[] => {
    const typeValue = constraint['type'] || constraint['guard']
    const guardType = scalarString(typeValue).trim()
    if (!guardType) return []
    const action: PermissionAction = guardType === 'ask_tool' ? 'ask' : 'deny'
    const reasonValue = constraint['reason']
    const reason = reasonValue ? scalarString(reasonValue) : `skill guard from ${skillName}`
    const parameters = Object.fromEntries(
      Object.entries(constraint).filter(
        ([key]) => key !== 'type' && key !== 'guard' && key !== 'reason',
      ),
    )
    return [
      {
        guardId: `sg_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
        skillName,
        guardType,
        action,
        reason,
        parameters,
      },
    ]
  })
}

function scalarString(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint')
    return String(value)
  return ''
}

export function planningInjection(decision: SkillDecision): string {
  if (decision.selected.length === 0) return ''
  const lines = [
    'Active Skills:',
    `- Selection reason: ${decision.reason}`,
    `- Phase model: ${SKILL_PHASE_MODEL.join(' -> ')}`,
  ]
  for (const skill of decision.selected) {
    const manifest = skill.manifest
    lines.push(`- ${manifest.ref}: ${manifest.description}`)
    const workflow = skill.sections['workflow']
    const verification = skill.sections['verification_checklist']
    if (workflow) lines.push(`  Workflow: ${singleLine(workflow)}`)
    if (verification) lines.push(`  Verification: ${singleLine(verification)}`)
  }
  lines.push(
    'Follow the active skill workflow and satisfy its verification checklist before finalizing.',
  )
  return lines.join('\n')
}

export function singleLine(text: string): string {
  return text
    .split(/\r?\n/)
    .map((part) => part.trim())
    .filter(Boolean)
    .join(' ')
}

/** 把一个 decision 编译出的 guard 保持成 PermissionEngine 可消费的形状。 */
export function asSkillGuardRefs(guards: readonly RuntimeGuard[]): readonly SkillGuardRef[] {
  return guards
}

export const compile_constraints = compileConstraints
export const planning_injection = planningInjection
