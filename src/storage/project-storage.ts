import { constants } from 'node:fs'
import { copyFile, cp, mkdir, readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'

import type { AppPaths } from './paths.js'
import { readJsonObject, writeJsonAtomic } from './json-file.js'

export interface StoredProject {
  readonly id: string
  readonly path: string
  readonly name: string
  readonly lastOpenedAt: string
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/**
 * 首次打开项目时复制旧版 `<workspace>/.deepcode` 数据。旧文件始终保留，
 * 新目录已有 chat.json 时绝不覆盖，避免把已使用的新历史回退到旧快照。
 */
export async function prepareProjectStorage(paths: AppPaths): Promise<void> {
  await mkdir(paths.project_dir, { recursive: true })
  const legacy = join(paths.workspace_root, '.deepcode')
  if (!(await exists(paths.chat_path)) && (await exists(join(legacy, 'chat.json')))) {
    try {
      await copyFile(join(legacy, 'chat.json'), paths.chat_path, constants.COPYFILE_EXCL)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    if (await exists(join(legacy, 'events')))
      await cp(join(legacy, 'events'), join(paths.project_dir, 'events'), {
        recursive: true,
        force: false,
        errorOnExist: false,
      })
    if (await exists(join(legacy, 'observability.ndjson')))
      await copyFile(
        join(legacy, 'observability.ndjson'),
        join(paths.project_dir, 'observability.ndjson'),
        constants.COPYFILE_EXCL,
      ).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      })
  }

  const project: StoredProject = {
    id: basename(paths.project_dir),
    path: paths.workspace_root,
    name: basename(paths.workspace_root) || paths.workspace_root,
    lastOpenedAt: new Date().toISOString(),
  }
  await writeJsonAtomic(join(paths.project_dir, 'project.json'), { ...project })
}

/** 只列已由 DeepCode 打开过的项目；不遍历用户的文件系统。 */
export async function listStoredProjects(globalDir: string): Promise<readonly StoredProject[]> {
  let entries: string[]
  try {
    entries = await readdir(join(globalDir, 'projects'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const projects: StoredProject[] = []
  for (const id of entries) {
    try {
      const data = await readJsonObject(join(globalDir, 'projects', id, 'project.json'), () => ({}))
      if (
        data['id'] === id &&
        typeof data['path'] === 'string' &&
        typeof data['name'] === 'string' &&
        typeof data['lastOpenedAt'] === 'string'
      )
        projects.push({
          id,
          path: data['path'],
          name: data['name'],
          lastOpenedAt: data['lastOpenedAt'],
        })
    } catch {
      // 单个损坏的索引不能阻止其他项目出现。
    }
  }
  return projects.sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt))
}
