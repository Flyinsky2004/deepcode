import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

import type { AppPaths } from '../core/models.js'

export type { AppPaths } from '../core/models.js'

/** 以规范化的绝对路径标识项目，避免同名目录混用会话。 */
export function canonicalWorkspace(path: string): string {
  const absolute = resolve(path)
  try {
    return realpathSync.native(absolute)
  } catch {
    return absolute
  }
}

export function projectIdForPath(path: string): string {
  return createHash('sha256').update(canonicalWorkspace(path)).digest('hex').slice(0, 24)
}

/** 解析统一位于用户目录中的配置和项目运行数据路径。 */
export function resolveAppPaths(
  options: {
    readonly home?: string
    readonly cwd?: string
  } = {},
): AppPaths {
  const baseHome = resolve(options.home ?? homedir())
  const baseCwd = canonicalWorkspace(options.cwd ?? process.cwd())
  const globalDir = resolve(baseHome, '.deepcode')
  const projectDir = resolve(globalDir, 'projects', projectIdForPath(baseCwd))

  return {
    global_dir: globalDir,
    workspace_root: baseCwd,
    project_dir: projectDir,
    config_path: resolve(globalDir, 'config.json'),
    chat_path: resolve(projectDir, 'chat.json'),
  }
}
