import { homedir } from 'node:os'
import { resolve } from 'node:path'

import type { AppPaths } from '../core/models.js'

export type { AppPaths } from '../core/models.js'

/**
 * 解析 deepcode 的全局与工作区路径。
 *
 * 不向上查找 git 根，也不创建目录；调用方可注入 home/cwd 做隔离测试。
 */
export function resolveAppPaths(
  options: {
    readonly home?: string
    readonly cwd?: string
  } = {},
): AppPaths {
  const baseHome = resolve(options.home ?? homedir())
  const baseCwd = resolve(options.cwd ?? process.cwd())
  const globalDir = resolve(baseHome, '.deepcode')
  const projectDir = resolve(baseCwd, '.deepcode')

  return {
    global_dir: globalDir,
    project_dir: projectDir,
    config_path: resolve(globalDir, 'config.json'),
    chat_path: resolve(projectDir, 'chat.json'),
  }
}
