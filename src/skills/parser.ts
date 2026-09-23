import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import type { SkillManifest, LoadedSkill, SkillSource } from './models.js'
import { validateManifest } from './validator.js'

export class SkillParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SkillParseError'
  }
}

const SECTION_NAMES: Readonly<Record<string, string>> = {
  overview: 'overview',
  'when to use': 'when_to_use',
  workflow: 'workflow',
  pitfalls: 'pitfalls',
  'verification checklist': 'verification_checklist',
}

export function parseSkillFile(path: string, source: SkillSource = 'project'): LoadedSkill {
  const filePath = resolve(path)
  const text = readFileSync(filePath, 'utf8')
  return parseSkillText(text, { path: filePath, source })
}

export function parseSkillText(
  text: string,
  options: { readonly path?: string; readonly source?: SkillSource } = {},
): LoadedSkill {
  const [frontmatter, body] = splitFrontmatter(text)
  const raw = parseFrontmatter(frontmatter)
  const manifest = manifestFromRaw(raw, options.source ?? 'project')
  validateManifest(manifest, body)
  return {
    manifest,
    path: options.path ?? '<memory>',
    body,
    sections: extractSections(body),
    checksum: createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex'),
  }
}

export function splitFrontmatter(text: string): readonly [string, string] {
  if (!text.startsWith('---\n')) throw new SkillParseError('SKILL.md must start with frontmatter')
  const end = text.indexOf('\n---', 4)
  if (end === -1) throw new SkillParseError('frontmatter must be closed')
  return [text.slice(4, end).replace(/^\n+|\n+$/g, ''), text.slice(end + 4).trim()]
}

function parseFrontmatter(text: string): Readonly<Record<string, unknown>> {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/u, ''))
    .filter((line) => line.trim() !== '' && !line.trimStart().startsWith('#'))
  const result: Record<string, unknown> = {}
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (line.startsWith(' ')) {
      i += 1
      continue
    }
    const [key, value] = parseKeyValue(line)
    if (value !== undefined) {
      result[key] = parseScalar(value)
      i += 1
      continue
    }
    const nested: string[] = []
    i += 1
    while (i < lines.length && lines[i]!.startsWith(' ')) nested.push(lines[i++]!)
    result[key] = parseNested(nested)
  }
  return result
}

function parseKeyValue(line: string): readonly [string, string | undefined] {
  const colon = line.indexOf(':')
  if (colon === -1) throw new SkillParseError(`invalid frontmatter line: ${line}`)
  const key = line.slice(0, colon).trim()
  if (!key) throw new SkillParseError('empty frontmatter key')
  const value = line.slice(colon + 1).trim()
  return [key, value === '' ? undefined : value]
}

function parseNested(lines: readonly string[]): unknown {
  const normalized = lines.map((line) => line.trim())
  if (normalized[0]?.startsWith('-')) return parseListBlock(normalized)
  const result: Record<string, unknown> = {}
  for (const line of normalized) {
    if (!line) continue
    const [key, value] = parseKeyValue(line)
    result[key] = parseScalar(value ?? '')
  }
  return result
}

function parseListBlock(lines: readonly string[]): unknown[] {
  const items: unknown[] = []
  let current: Record<string, unknown> | undefined
  for (const line of lines) {
    if (line.startsWith('- ')) {
      const value = line.slice(2).trim()
      if (value.includes(':')) {
        const [key, raw] = parseKeyValue(value)
        current = { [key]: parseScalar(raw ?? '') }
        items.push(current)
      } else {
        current = undefined
        items.push(parseScalar(value))
      }
    } else if (current !== undefined && line.includes(':')) {
      const [key, raw] = parseKeyValue(line)
      current[key] = parseScalar(raw ?? '')
    }
  }
  return items
}

function parseScalar(value: string): unknown {
  const trimmed = value.trim()
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1).trim()
    if (!inner) return []
    return inner
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .map(stripQuotes)
  }
  if (/^-?\d+$/u.test(trimmed)) return Number.parseInt(trimmed, 10)
  if (trimmed.toLowerCase() === 'true' || trimmed.toLowerCase() === 'false')
    return trimmed.toLowerCase() === 'true'
  return stripQuotes(trimmed)
}

function stripQuotes(value: string): string {
  return value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
    ? value.slice(1, -1)
    : value
}

function asTuple(value: unknown): readonly string[] {
  if (value === undefined || value === null) return []
  if (typeof value === 'string') return value ? [value] : []
  if (Array.isArray(value)) return value.map(String).filter(Boolean)
  return []
}

function asConstraints(value: unknown): readonly Readonly<Record<string, unknown>>[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Readonly<Record<string, unknown>> =>
          typeof item === 'object' && item !== null && !Array.isArray(item),
      )
    : []
}

function manifestFromRaw(
  raw: Readonly<Record<string, unknown>>,
  source: SkillSource,
): SkillManifest {
  const metadata =
    typeof raw['metadata'] === 'object' &&
    raw['metadata'] !== null &&
    !Array.isArray(raw['metadata'])
      ? (raw['metadata'] as Readonly<Record<string, unknown>>)
      : {}
  const name = scalarString(raw['name'] ?? '')
  const version = scalarString(raw['version'] ?? '0.1.0')
  const rawPriority = raw['priority'] || 0
  const preferredTags = truthyYamlValue(raw['tags']) ? raw['tags'] : metadata['tags']
  const preferredRelated = truthyYamlValue(raw['related_skills'])
    ? raw['related_skills']
    : metadata['related_skills']
  const priority =
    typeof rawPriority === 'number'
      ? rawPriority
      : /^-?\d+$/u.test(scalarString(rawPriority))
        ? Number.parseInt(scalarString(rawPriority), 10)
        : (() => {
            throw new TypeError(`invalid priority: ${scalarString(rawPriority)}`)
          })()
  return {
    name,
    description: scalarString(raw['description'] ?? ''),
    version,
    category: scalarString(raw['category'] ?? 'general'),
    tags: asTuple(preferredTags),
    triggers: asTuple(raw['triggers']),
    constraints: asConstraints(raw['constraints']),
    relatedSkills: asTuple(preferredRelated),
    priority,
    source,
    ref: `${name}@${version}`,
  }
}

function scalarString(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint')
    return String(value)
  return ''
}

function truthyYamlValue(value: unknown): boolean {
  if (value === undefined || value === null || value === false || value === 0 || value === '')
    return false
  return !(Array.isArray(value) && value.length === 0)
}

export function extractSections(body: string): Readonly<Record<string, string>> {
  const sections: Record<string, string[]> = {}
  let current: string | undefined
  for (const line of body.split(/\r?\n/)) {
    const match = /^#{1,3}\s+(.+?)\s*$/u.exec(line)
    if (match) {
      current = SECTION_NAMES[match[1]!.trim().toLowerCase()]
      if (current !== undefined) sections[current] ??= []
      continue
    }
    if (current !== undefined) sections[current]!.push(line)
  }
  return Object.fromEntries(
    Object.entries(sections).map(([name, lines]) => [name, lines.join('\n').trim()]),
  )
}

export const parse_skill_file = parseSkillFile
export const parse_skill_text = parseSkillText
export const extract_sections = extractSections
