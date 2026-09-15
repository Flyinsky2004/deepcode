/**
 * `@` 文件引用的纯函数层（`file_mentions.py` 的逐行移植）。
 *
 * 与旧实现一样**不依赖任何 UI**：`find_active_mention` 与
 * `workspacePathSuggestions` 都可以脱离渲染单测（旧项目
 * `tests/test_file_mentions.py` 的 4 个测试就是这一层）。
 *
 * 三条必须保住的语义（`parts/05` §5.1）：
 * 1. `@` 到**光标**之间不能有空白，否则不算活跃提及；`end` 是光标而不是 token 结尾。
 * 2. 匹配是 **casefold 子串**（不是前缀），排序键是 `(rank, file_rank, path)`。
 * 3. 相对路径**始终用正斜杠**（`as_posix()`），跨平台一致。
 */

import { readdirSync, statSync, type Dirent } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

import type { MentionSpan } from './types.js'

/**
 * 忽略目录名（`file_mentions.py:5-16`）。
 *
 * 两处与旧集合不同，都是目录改名的连带结果：
 * - 加入 `.deepcode`：本项目的数据目录（ADR 0001 决策 7），旧项目对应的是
 *   `.flyinchat`。不忽略它会让 `@` 补全把 `chat.json`、`events/` 暴露成候选。
 * - 保留 `.flyinchat`：工作区里可能仍有旧项目留下的数据目录。
 *
 * 判定是**逐路径段**（不是前缀匹配），所以 `.venv/lib/app.py` 被丢弃。
 */
export const IGNORED_DIR_NAMES: ReadonlySet<string> = new Set([
  '.git',
  '.deepcode',
  '.flyinchat',
  '__pycache__',
  '.pytest_cache',
  '.venv',
  'node_modules',
  'dist',
  'build',
])

/** 默认候选上限（`workspace_path_suggestions(limit=12)`）。 */
export const MENTION_LIMIT = 12

/** 一条路径候选。 */
export interface WorkspacePathSuggestion {
  /** 相对路径，正斜杠分隔。 */
  readonly path: string
  readonly isDir: boolean
}

/** 判定相对路径中是否有任一段命中忽略集合。 */
export function isIgnoredPath(relativePath: string): boolean {
  if (relativePath.length === 0) return false
  return relativePath.split(/[/\\]/).some((segment) => IGNORED_DIR_NAMES.has(segment))
}

/**
 * 找出光标处的活跃 `@` 提及。
 *
 * 逐字对应 `find_active_mention`：光标钳位 → 向前找最后一个 `@` →
 * query 含空白即放弃。
 */
export function findActiveMention(value: string, cursorPosition?: number): MentionSpan | undefined {
  const rawCursor = cursorPosition ?? value.length
  const cursor = Math.max(0, Math.min(rawCursor, value.length))
  const start = value.lastIndexOf('@', cursor - 1)
  // `lastIndexOf('@', cursor - 1)` 在 cursor === 0 时会从 0 开始找，
  // 与 Python 的 `rfind("@", 0, cursor)` 不同——后者在 cursor=0 时返回 -1。
  if (cursor === 0 || start < 0) return undefined
  const query = value.slice(start + 1, cursor)
  if (/\s/.test(query)) return undefined
  return { start, end: cursor, query }
}

/** 排序键：`(rank, file_rank, path)`。rank 越小越靠前。 */
function sortKey(
  normalizedQuery: string,
  name: string,
  relativePath: string,
  isDir: boolean,
): readonly [number, number, string] {
  const foldedName = name.toLowerCase()
  const foldedPath = relativePath.toLowerCase()

  let rank: number
  if (normalizedQuery.length === 0 || foldedName === normalizedQuery) rank = 0
  else if (foldedName.startsWith(normalizedQuery)) rank = 1
  else if (foldedName.includes(normalizedQuery)) rank = 2
  else if (foldedPath.startsWith(normalizedQuery)) rank = 3
  else rank = 4

  // 同 rank 下**文件排在目录前**。
  return [rank, isDir ? 1 : 0, relativePath]
}

function compareKeys(
  a: readonly [number, number, string],
  b: readonly [number, number, string],
): number {
  if (a[0] !== b[0]) return a[0] - b[0]
  if (a[1] !== b[1]) return a[1] - b[1]
  return a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0
}

/**
 * 工作区路径补全候选。
 *
 * ️ **一处与旧实现的有意不同**：旧实现 `rglob("*")` 会**走进**忽略目录再逐个
 * 丢弃（`node_modules` 下的每个文件都会被枚举一遍）。这里在遇到忽略目录时
 * **不再下钻**——候选集完全相同（那些路径本来就会被 `isIgnoredPath` 剔除），
 * 但省掉了整棵 `node_modules` 的遍历。这是纯性能差异，不改变任何可见结果。
 *
 * （遍历失败一律吞掉：路径不存在、权限不足都只意味着"没有候选"。）
 */
export function workspacePathSuggestions(
  workspaceRoot: string,
  query: string,
  limit: number = MENTION_LIMIT,
): readonly WorkspacePathSuggestion[] {
  const root = resolve(workspaceRoot)
  try {
    if (!statSync(root).isDirectory()) return []
  } catch {
    return []
  }

  const normalizedQuery = query.toLowerCase()
  const matches: Array<{
    suggestion: WorkspacePathSuggestion
    key: readonly [number, number, string]
  }> = []

  const walk = (absoluteDir: string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(absoluteDir, { withFileTypes: true })
    } catch {
      // 读不了的目录直接跳过——权限不足与"没有候选"对用户是同一件事。
      return
    }
    for (const entry of entries) {
      const absolute = `${absoluteDir}${sep}${entry.name}`
      let isDir = entry.isDirectory()
      if (!isDir && !entry.isFile()) {
        // 符号链接等：用 stat 兜底，与旧实现的 `is_file() or is_dir()` 对应。
        try {
          isDir = statSync(absolute).isDirectory()
        } catch {
          continue
        }
      }
      const relativePath = relative(root, absolute).split(sep).join('/')
      if (isIgnoredPath(relativePath)) continue
      if (
        normalizedQuery.length === 0 ||
        entry.name.toLowerCase().includes(normalizedQuery) ||
        relativePath.toLowerCase().includes(normalizedQuery)
      ) {
        matches.push({
          suggestion: { path: relativePath, isDir },
          key: sortKey(normalizedQuery, entry.name, relativePath, isDir),
        })
      }
      if (isDir) walk(absolute)
    }
  }

  walk(root)

  return matches
    .slice()
    .sort((a, b) => compareKeys(a.key, b.key))
    .slice(0, limit)
    .map((m) => m.suggestion)
}

/**
 * 插入选中的路径（`_insert_selected_file_mention`，`app.py:1209-1230`）。
 *
 * 两条关键语义：
 * - **`@` 被替换掉**（`span.start` 指向 `@`），不是保留 `@` 再追加路径；
 * - 分隔符取决于**后缀首字符是否已是空白**：是则 `""`，否则 `" "`。
 *
 * 只插入相对路径字符串，**不读文件内容**——真正的读取由模型随后调用
 * `file_read` 完成。
 */
export function insertMention(
  value: string,
  span: MentionSpan,
  selectedPath: string,
): { readonly value: string; readonly cursor: number } {
  const suffix = value.slice(span.end)
  const separator = suffix.slice(0, 1) !== '' && /\s/.test(suffix.slice(0, 1)) ? '' : ' '
  const replacement = `${selectedPath}${separator}`
  return {
    value: `${value.slice(0, span.start)}${replacement}${suffix}`,
    cursor: span.start + replacement.length,
  }
}

/** 供测试断言用：路径是否绝对（旧实现没有这个概念，仅用于防御）。 */
export function isAbsolutePath(path: string): boolean {
  return isAbsolute(path)
}
