/**
 * `@` 文件引用的纯函数（`file_mentions.py` 的行为基线）。
 *
 * 旧项目 `tests/test_file_mentions.py` 的 4 个用例在这里一一对应，
 * 另加排序、忽略集合与插入分隔符的边界。
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  IGNORED_DIR_NAMES,
  findActiveMention,
  insertMention,
  isIgnoredPath,
  isAbsolutePath,
  workspacePathSuggestions,
} from '../../src/clients/tui/mentions.js'

function makeWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'deepcode-mentions-'))
  mkdirSync(join(root, 'src', 'core'), { recursive: true })
  mkdirSync(join(root, 'node_modules', 'left-pad'), { recursive: true })
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, 'app.ts'), 'SECRET-CONTENT\n')
  writeFileSync(join(root, 'src', 'core', 'ids.ts'), 'export {}\n')
  writeFileSync(join(root, 'README.md'), 'readme\n')
  writeFileSync(join(root, 'node_modules', 'left-pad', 'index.js'), 'module.exports={}\n')
  writeFileSync(join(root, '.git', 'config'), '[core]\n')
  return root
}

describe('findActiveMention', () => {
  it('光标前最后一个 @ 到光标之间就是 query', () => {
    expect(findActiveMention('fix @app', 8)).toEqual({ start: 4, end: 8, query: 'app' })
  })

  it('缺省光标位置是字符串末尾', () => {
    expect(findActiveMention('fix @app')).toEqual({ start: 4, end: 8, query: 'app' })
  })

  it('query 含空白即不是活跃提及（已完成的 token）', () => {
    // "fix @app now" 光标在末尾 → query = "app now" 含空白 → None
    expect(findActiveMention('fix @app now')).toBeUndefined()
  })

  it('光标之后的内容不算进 query', () => {
    // 光标在 "app" 之后、空格之前
    expect(findActiveMention('fix @app now', 8)).toEqual({ start: 4, end: 8, query: 'app' })
  })

  it('没有 @ 时返回 undefined', () => {
    expect(findActiveMention('no mention here')).toBeUndefined()
  })

  it('光标为 0 时返回 undefined（与 Python 的 rfind("@", 0, 0) 一致）', () => {
    expect(findActiveMention('@app', 0)).toBeUndefined()
  })

  it('光标越界被钳位', () => {
    expect(findActiveMention('@app', 999)).toEqual({ start: 0, end: 4, query: 'app' })
    expect(findActiveMention('@app', -5)).toBeUndefined()
  })

  it('空的 query 也是活跃提及（刚敲下 @）', () => {
    expect(findActiveMention('look @', 6)).toEqual({ start: 5, end: 6, query: '' })
  })
})

describe('workspacePathSuggestions', () => {
  it('按子串匹配（不是前缀）并返回相对路径', () => {
    const root = makeWorkspace()
    const paths = workspacePathSuggestions(root, 'ids').map((s) => s.path)
    expect(paths).toContain('src/core/ids.ts')
  })

  it('忽略集合内的目录被逐段剔除', () => {
    const root = makeWorkspace()
    const paths = workspacePathSuggestions(root, 'index').map((s) => s.path)
    expect(paths).toEqual([])
    const all = workspacePathSuggestions(root, '').map((s) => s.path)
    expect(all.some((path) => path.startsWith('node_modules'))).toBe(false)
    expect(all.some((path) => path.startsWith('.git'))).toBe(false)
  })

  it('匹配大小写不敏感', () => {
    const root = makeWorkspace()
    expect(workspacePathSuggestions(root, 'README').map((s) => s.path)).toContain('README.md')
    expect(workspacePathSuggestions(root, 'readme').map((s) => s.path)).toContain('README.md')
  })

  it('同 rank 下文件排在目录前，且完全同名 rank 最高', () => {
    const root = makeWorkspace()
    // 空 query → rank 0，文件（file_rank 0）排在目录（file_rank 1）之前
    const all = workspacePathSuggestions(root, '')
    const firstDirIndex = all.findIndex((s) => s.isDir)
    const lastFileIndex = all.map((s) => s.isDir).lastIndexOf(false)
    expect(firstDirIndex).toBeGreaterThan(lastFileIndex)
  })

  it('限制候选数量', () => {
    const root = makeWorkspace()
    expect(workspacePathSuggestions(root, '', 2).length).toBe(2)
  })

  it('路径不存在时返回空数组', () => {
    expect(workspacePathSuggestions('/no/such/workspace', 'x')).toEqual([])
  })

  it('不返回文件内容（只返回路径）', () => {
    const root = makeWorkspace()
    const serialized = JSON.stringify(workspacePathSuggestions(root, 'app'))
    expect(serialized).not.toContain('SECRET-CONTENT')
  })

  it('目录项的候选路径不带尾斜杠（插入的是 key）', () => {
    const root = makeWorkspace()
    const dir = workspacePathSuggestions(root, 'core').find((s) => s.isDir)
    expect(dir?.path).toBe('src/core')
  })
})

describe('isIgnoredPath', () => {
  it('逐路径段判定，不看前缀', () => {
    expect(isIgnoredPath('.venv/lib/app.py')).toBe(true)
    expect(isIgnoredPath('src/core/ids.ts')).toBe(false)
    expect(isIgnoredPath('')).toBe(false)
  })

  it('忽略集合含本项目的数据目录（.deepcode）', () => {
    expect(IGNORED_DIR_NAMES.has('.deepcode')).toBe(true)
    expect(IGNORED_DIR_NAMES.has('.flyinchat')).toBe(true)
  })
})

describe('insertMention', () => {
  const span = { start: 4, end: 8, query: 'app' }

  it('替换 @ 并补一个空格（后缀为空）', () => {
    expect(insertMention('fix @app', span, 'src/app.ts')).toEqual({
      value: 'fix src/app.ts ',
      cursor: 15,
    })
  })

  it('后缀首字符已是空白时不补空格', () => {
    expect(insertMention('fix @app now', span, 'src/app.ts').value).toBe('fix src/app.ts now')
  })

  it('@ 被替换掉，不会残留', () => {
    expect(insertMention('fix @app', span, 'x.ts').value.includes('@')).toBe(false)
  })

  it('光标落在插入内容之后', () => {
    const inserted = insertMention('fix @app', span, 'src/app.ts')
    expect(inserted.value.slice(0, inserted.cursor)).toBe('fix src/app.ts ')
  })
})

describe('isAbsolutePath', () => {
  it('区分绝对与相对路径', () => {
    expect(isAbsolutePath('/tmp/x')).toBe(true)
    expect(isAbsolutePath('src/x.ts')).toBe(false)
  })
})
