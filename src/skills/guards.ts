import { lstatSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

import type { ToolContext, SkillGuardRef } from '../core/tool.js'

export interface GuardOutcome {
  readonly allowed: boolean
  readonly reason: string
  readonly askUser: boolean
  readonly guard?: SkillGuardRef
}

function values(
  parameters: Readonly<Record<string, unknown>>,
  ...keys: readonly string[]
): readonly string[] {
  for (const key of keys) {
    const value = parameters[key]
    if (typeof value === 'string') return [value]
    if (Array.isArray(value)) return value.map(String)
  }
  return []
}

function resolvePath(value: string, workspaceRoot: string): string {
  const target = resolve(isAbsolute(value) ? value : workspaceRoot, value)
  let existing = target
  while (true) {
    try {
      lstatSync(existing)
      break
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
      const parent = dirname(existing)
      if (parent === existing) throw error
      existing = parent
    }
  }
  // realpathSync 拒绝悬空软链；缺失的叶子沿真实父目录继续解析。
  return resolve(realpathSync(existing), relative(existing, target))
}

function patternMatches(pattern: string, text: string): boolean {
  try {
    return new RegExp(pattern).test(text)
  } catch {
    return text.includes(pattern)
  }
}

function matchesToolName(guard: SkillGuardRef, toolName: string): boolean {
  // 兼容 Phase 1–5 的 `toolName` 与无参数通配 guard；SKILL.md 使用 tool/tools。
  const names = values(guard.parameters, 'tool', 'tools', 'toolName')
  return names.length === 0 || names.includes(toolName)
}

function matches(
  guard: SkillGuardRef,
  toolName: string,
  input: Readonly<Record<string, unknown>>,
  context: ToolContext,
): boolean {
  switch (guard.guardType) {
    case 'deny_tool':
    case 'ask_tool': {
      return matchesToolName(guard, toolName)
    }
    case 'deny_command_pattern': {
      if (toolName !== 'bash') return false
      const command = typeof input['command'] === 'string' ? input['command'] : ''
      return values(guard.parameters, 'pattern', 'patterns', 'commands').some((pattern) =>
        patternMatches(pattern, command),
      )
    }
    case 'require_read_before_write': {
      if (toolName !== 'file_write' && toolName !== 'file_edit') return false
      const value = input['file_path'] ?? input['path']
      if (!value) return false
      try {
        const path = resolvePath(typeof value === 'string' ? value : '', context.workspaceRoot)
        const directlyTracked = (
          context as ToolContext & {
            readonly recently_read_files?: Readonly<Record<string, number>>
          }
        ).recently_read_files
        const recentlyRead = directlyTracked ?? context.turnState['recently_read_files']
        return !(recentlyRead && typeof recentlyRead === 'object' && path in recentlyRead)
      } catch {
        return true
      }
    }
    case 'path_scope': {
      const value = input['file_path'] ?? input['path']
      if (!value) return false
      const scopes = values(guard.parameters, 'path', 'paths', 'roots')
      if (scopes.length === 0) return false
      try {
        const path = resolvePath(typeof value === 'string' ? value : '', context.workspaceRoot)
        return !scopes.some((scope) => {
          const root = resolvePath(scope, context.workspaceRoot)
          const rel = relative(root, path)
          return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
        })
      } catch {
        return true
      }
    }
    default:
      return false
  }
}

/** 模型请求前隐藏被无条件 deny_tool 守护禁用的工具。参数型守护仍由执行器检查。 */
export function shouldAdvertiseTool(guards: readonly SkillGuardRef[], toolName: string): boolean {
  for (const guard of guards) {
    if (guard.guardType !== 'deny_tool' && guard.guardType !== 'ask_tool') continue
    if (!matchesToolName(guard, toolName)) continue
    return guard.action !== 'deny'
  }
  return true
}

export function evaluateSkillGuards(
  guards: readonly SkillGuardRef[],
  toolName: string,
  input: Readonly<Record<string, unknown>>,
  context: ToolContext,
): GuardOutcome {
  for (const guard of guards) {
    if (!matches(guard, toolName, input, context)) continue
    return {
      allowed: false,
      reason: guard.reason,
      askUser: guard.action === 'ask',
      guard,
    }
  }
  return { allowed: true, reason: '', askUser: false }
}

/** 旧协议刻意要求 runtime_guards 是 tuple；数组会被静默忽略。 */
export function guardsFromTurnState(
  turnState: Readonly<Record<string, unknown>>,
): readonly SkillGuardRef[] {
  const raw = turnState['runtime_guards'] ?? turnState['runtimeGuards']
  if (!isTuple(raw)) return []
  return raw.filter(isGuard)
}

function isTuple(value: unknown): value is readonly unknown[] {
  // JS 没有 tuple runtime tag。compiler 用 frozen array 作为 tuple 的运行时
  // 标记；普通 JSON 数组刻意被忽略，保持旧实现的 fail-closed 语义。
  return Array.isArray(value) && Object.isFrozen(value)
}

function isGuard(value: unknown): value is SkillGuardRef {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return (
    typeof item['guardId'] === 'string' &&
    typeof item['skillName'] === 'string' &&
    typeof item['guardType'] === 'string' &&
    (item['action'] === 'allow' || item['action'] === 'ask' || item['action'] === 'deny') &&
    typeof item['reason'] === 'string' &&
    typeof item['parameters'] === 'object' &&
    item['parameters'] !== null
  )
}

export const guards_from_turn_state = guardsFromTurnState
export const evaluate_skill_guards = evaluateSkillGuards
