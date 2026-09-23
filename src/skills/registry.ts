import { createHash } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import type { SkillSource, LoadedSkill, InvalidSkill, SkillCatalogSnapshot } from './models.js'
import { parseSkillFile } from './parser.js'

class Snapshot implements SkillCatalogSnapshot {
  readonly loadedSkills: readonly LoadedSkill[]
  readonly invalidSkills: readonly InvalidSkill[]
  readonly checksum: string
  constructor(
    loadedSkills: readonly LoadedSkill[],
    invalidSkills: readonly InvalidSkill[],
    checksum: string,
  ) {
    this.loadedSkills = loadedSkills
    this.invalidSkills = invalidSkills
    this.checksum = checksum
  }
  byName(name: string): LoadedSkill | undefined {
    return this.loadedSkills.find((skill) => skill.manifest.name === name)
  }
}

function skillPaths(root: string): readonly string[] {
  if (!existsSync(root)) return []
  const result: string[] = []
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile() && entry.name === 'SKILL.md') result.push(path)
    }
  }
  visit(root)
  return result.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

/** 目录级全量扫描；refresh 不做 mtime 缓存，保证每个新 turn 观察到文件变化。 */
export class SkillRegistry {
  readonly projectRoot: string
  readonly userRoot: string
  readonly builtinRoot: string | undefined
  #snapshot: SkillCatalogSnapshot = new Snapshot(
    [],
    [],
    createHash('sha256').update('').digest('hex'),
  )

  constructor(
    projectRoot: string,
    userRoot: string = join(homedir(), '.deepcode'),
    builtinRoot?: string,
  ) {
    this.projectRoot = resolve(projectRoot)
    this.userRoot = resolve(userRoot)
    this.builtinRoot = builtinRoot === undefined ? undefined : resolve(builtinRoot)
  }

  get snapshot(): SkillCatalogSnapshot {
    return this.#snapshot
  }

  refresh(): SkillCatalogSnapshot {
    const candidates: readonly (readonly [SkillSource, string])[] = [
      ['project', join(this.projectRoot, 'skills')],
      ['user-local', join(this.userRoot, 'skills')],
      ...(this.builtinRoot === undefined ? [] : ([['builtin', this.builtinRoot]] as const)),
    ]
    const loadedByName = new Map<string, LoadedSkill>()
    const invalid: InvalidSkill[] = []
    const checksums: string[] = []
    for (const [source, root] of candidates) {
      for (const path of skillPaths(root)) {
        try {
          const skill = parseSkillFile(path, source)
          checksums.push(skill.checksum)
          if (!loadedByName.has(skill.manifest.name)) loadedByName.set(skill.manifest.name, skill)
        } catch (error) {
          invalid.push({ path, reason: error instanceof Error ? error.message : String(error) })
        }
      }
    }
    const loaded = [...loadedByName.values()].sort((a, b) =>
      a.manifest.name < b.manifest.name ? -1 : a.manifest.name > b.manifest.name ? 1 : 0,
    )
    const checksum = createHash('sha256').update(checksums.sort().join(''), 'utf8').digest('hex')
    this.#snapshot = new Snapshot(loaded, invalid, checksum)
    return this.#snapshot
  }

  get(name: string): LoadedSkill | undefined {
    return this.#snapshot.byName?.(name)
  }
}

/** 供测试和只读面板使用的扫描入口。 */
export function listSkillFiles(root: string): readonly string[] {
  return skillPaths(resolve(root))
}
