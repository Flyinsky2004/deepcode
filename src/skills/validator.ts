import type { SkillManifest } from './models.js'

export class SkillValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SkillValidationError'
  }
}

const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/

/** 按旧 Skill validator 的顺序执行恰好五条校验。 */
export function validateManifest(manifest: SkillManifest, body: string): void {
  if (!manifest.name.trim()) throw new SkillValidationError('name is required')
  if (!SLUG_RE.test(manifest.name)) throw new SkillValidationError('name must be a lowercase slug')
  if (!manifest.description.trim()) throw new SkillValidationError('description is required')
  if ([...manifest.description].length > 1024)
    throw new SkillValidationError('description must be <= 1024 characters')
  if (!body.trim()) throw new SkillValidationError('body is required')
}

export const skillNamePattern = SLUG_RE
export const validate_manifest = validateManifest
