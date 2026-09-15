/**
 * `resolveAppPaths` 的路径解析测试。
 *
 * 这个函数定义了**数据目录契约**：全局目录在 `~/.deepcode`，工作区目录在
 * `<cwd>/.deepcode`（与旧项目的 `~/.flyinchat/` 不同——目录名是新的，文件内部
 * 结构才要求逐字兼容）。所以这里既断言拼接结果，也断言两条容易出错的边界：
 *
 * 1. `home` / `cwd` 缺省时必须回落到真实 `homedir()` 与 `process.cwd()`；
 * 2. 相对路径形式的注入参数必须被 `resolve` 成绝对路径（否则会写出到进程 cwd）。
 */
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { resolveAppPaths } from '../../src/storage/paths.js'

describe('resolveAppPaths', () => {
  it('按注入的 home/cwd 拼出四个路径', () => {
    const paths = resolveAppPaths({ home: '/home/u', cwd: '/work/proj' })

    expect(paths).toEqual({
      global_dir: resolve('/home/u/.deepcode'),
      project_dir: resolve('/work/proj/.deepcode'),
      config_path: resolve('/home/u/.deepcode/config.json'),
      chat_path: resolve('/work/proj/.deepcode/chat.json'),
    })
  })

  it('配置文件在全局目录、聊天记录在工作区目录（两者不混）', () => {
    const paths = resolveAppPaths({ home: '/home/u', cwd: '/work/proj' })
    expect(paths.config_path.startsWith(paths.global_dir)).toBe(true)
    expect(paths.chat_path.startsWith(paths.project_dir)).toBe(true)
    expect(paths.config_path.startsWith(paths.project_dir)).toBe(false)
  })

  it('目录名固定为 .deepcode（数据目录契约）', () => {
    const paths = resolveAppPaths({ home: '/home/u', cwd: '/work/proj' })
    expect(paths.global_dir.endsWith('/.deepcode')).toBe(true)
    expect(paths.project_dir.endsWith('/.deepcode')).toBe(true)
  })

  it('不传参数时回落到真实 homedir 与 process.cwd', () => {
    const paths = resolveAppPaths()
    expect(paths.global_dir).toBe(resolve(homedir(), '.deepcode'))
    expect(paths.project_dir).toBe(resolve(process.cwd(), '.deepcode'))
  })

  it('只传 home 时 cwd 仍回落到 process.cwd', () => {
    const paths = resolveAppPaths({ home: '/home/u' })
    expect(paths.global_dir).toBe(resolve('/home/u/.deepcode'))
    expect(paths.project_dir).toBe(resolve(process.cwd(), '.deepcode'))
  })

  it('只传 cwd 时 home 仍回落到 homedir', () => {
    const paths = resolveAppPaths({ cwd: '/work/proj' })
    expect(paths.global_dir).toBe(resolve(homedir(), '.deepcode'))
    expect(paths.project_dir).toBe(resolve('/work/proj/.deepcode'))
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
    expect(paths.project_dir).toBe('/work/proj/.deepcode')
  })

  it('`..` 在参数里被规范化（不会逃出预期目录）', () => {
    const paths = resolveAppPaths({ home: '/home/u/sub/..', cwd: '/work/x/../proj' })
    expect(paths.global_dir).toBe('/home/u/.deepcode')
    expect(paths.project_dir).toBe('/work/proj/.deepcode')
  })

  it('纯函数：同一输入两次调用结果相等，且不依赖顺序', () => {
    expect(resolveAppPaths({ home: '/a', cwd: '/b' })).toEqual(
      resolveAppPaths({ home: '/a', cwd: '/b' }),
    )
  })
})
