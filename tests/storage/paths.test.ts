/**
 * `resolveAppPaths` 的路径解析测试。
 *
 * 全部运行数据统一位于 `~/.deepcode`，按工作区绝对路径的哈希隔离。
 * 所以这里既断言拼接结果，也断言两条容易出错的边界：
 *
 * 1. `home` / `cwd` 缺省时必须回落到真实 `homedir()` 与 `process.cwd()`；
 * 2. 相对路径形式的注入参数必须被 `resolve` 成绝对路径（否则会写出到进程 cwd）。
 */
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { projectIdForPath, resolveAppPaths } from '../../src/storage/paths.js'

const projectDir = (home: string, cwd: string): string =>
  resolve(home, '.deepcode', 'projects', projectIdForPath(cwd))

describe('resolveAppPaths', () => {
  it('按注入的 home/cwd 拼出统一目录下的项目路径', () => {
    const paths = resolveAppPaths({ home: '/home/u', cwd: '/work/proj' })

    expect(paths).toEqual({
      global_dir: resolve('/home/u/.deepcode'),
      workspace_root: resolve('/work/proj'),
      project_dir: projectDir('/home/u', '/work/proj'),
      config_path: resolve('/home/u/.deepcode/config.json'),
      chat_path: resolve(projectDir('/home/u', '/work/proj'), 'chat.json'),
    })
  })

  it('配置和聊天记录都在全局目录，但项目数据彼此隔离', () => {
    const paths = resolveAppPaths({ home: '/home/u', cwd: '/work/proj' })
    expect(paths.config_path.startsWith(paths.global_dir)).toBe(true)
    expect(paths.chat_path.startsWith(paths.project_dir)).toBe(true)
    expect(paths.config_path.startsWith(paths.project_dir)).toBe(false)
    expect(paths.project_dir.startsWith(paths.global_dir)).toBe(true)
  })

  it('全局目录名固定为 .deepcode，项目在 projects 子目录', () => {
    const paths = resolveAppPaths({ home: '/home/u', cwd: '/work/proj' })
    expect(paths.global_dir.endsWith('/.deepcode')).toBe(true)
    expect(paths.project_dir.startsWith('/home/u/.deepcode/projects/')).toBe(true)
  })

  it('不传参数时回落到真实 homedir 与 process.cwd', () => {
    const paths = resolveAppPaths()
    expect(paths.global_dir).toBe(resolve(homedir(), '.deepcode'))
    expect(paths.project_dir).toBe(projectDir(homedir(), process.cwd()))
  })

  it('只传 home 时 cwd 仍回落到 process.cwd', () => {
    const paths = resolveAppPaths({ home: '/home/u' })
    expect(paths.global_dir).toBe(resolve('/home/u/.deepcode'))
    expect(paths.project_dir).toBe(projectDir('/home/u', process.cwd()))
  })

  it('只传 cwd 时 home 仍回落到 homedir', () => {
    const paths = resolveAppPaths({ cwd: '/work/proj' })
    expect(paths.global_dir).toBe(resolve(homedir(), '.deepcode'))
    expect(paths.project_dir).toBe(projectDir(homedir(), '/work/proj'))
  })

  it('相对路径参数被规范化为绝对路径（不依赖进程 cwd）', () => {
    const paths = resolveAppPaths({ home: 'rel-home', cwd: 'rel-cwd' })
    expect(paths.global_dir).toBe(resolve('rel-home', '.deepcode'))
    expect(paths.global_dir.startsWith('/')).toBe(true)
    expect(paths.project_dir.startsWith('/')).toBe(true)
  })

  it('带尾随斜杠的输入不产生重复分隔符', () => {
    const paths = resolveAppPaths({ home: '/home/u/', cwd: '/work/proj/' })
    expect(paths.global_dir).toBe('/home/u/.deepcode')
    expect(paths.project_dir).toBe(projectDir('/home/u', '/work/proj'))
  })

  it('`..` 在参数里被规范化（不会逃出预期目录）', () => {
    const paths = resolveAppPaths({ home: '/home/u/sub/..', cwd: '/work/x/../proj' })
    expect(paths.global_dir).toBe('/home/u/.deepcode')
    expect(paths.project_dir).toBe(projectDir('/home/u', '/work/proj'))
  })

  it('纯函数：同一输入两次调用结果相等，且不依赖顺序', () => {
    expect(resolveAppPaths({ home: '/a', cwd: '/b' })).toEqual(
      resolveAppPaths({ home: '/a', cwd: '/b' }),
    )
  })
})
