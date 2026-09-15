import { lstat, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, dirname } from 'node:path'
import { AgentError, ErrorCode } from '../core/errors.js'

export async function resolveWorkspacePath(
  input: string,
  workspaceRoot: string,
  allowedRoots: readonly string[],
  mode: 'read' | 'write' = 'read',
): Promise<string> {
  if (!input || input.includes('\0'))
    throw new AgentError({
      code: ErrorCode.VALIDATION_FAILED,
      message: 'invalid path',
      source: 'path',
    })
  const root = await realpath(workspaceRoot)
  const candidate = resolve(isAbsolute(input) ? input : join(root, input))
  const existingTarget = await nearestExisting(candidate)
  const canonicalExisting = await realpath(existingTarget)
  const suffix = relative(existingTarget, candidate)
  const canonical = suffix ? resolve(canonicalExisting, suffix) : canonicalExisting
  const roots = await Promise.all(
    (allowedRoots.length > 0 ? allowedRoots : [root]).map(async (r) => {
      try {
        return await realpath(resolve(isAbsolute(r) ? r : join(root, r)))
      } catch {
        return resolve(isAbsolute(r) ? r : join(root, r))
      }
    }),
  )
  if (
    !roots.some(
      (allowed) =>
        canonical === allowed ||
        (relative(allowed, canonical) !== '..' &&
          !relative(allowed, canonical).startsWith(`..${'/'}`) &&
          !isAbsolute(relative(allowed, canonical))),
    )
  )
    throw new AgentError({
      code: ErrorCode.PERMISSION_DENIED,
      message: `path outside allowed ${mode} roots`,
      source: 'path',
      context: { path: input },
    })
  return canonical
}

/** Synchronous lexical variant used by policy previews; execution uses the
 * async realpath-checked resolver above. */
export function normalizePath(input: string, workspaceRoot: string): string {
  return resolve(isAbsolute(input) ? input : join(resolve(workspaceRoot), input))
}

export function pathAllowed(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => {
    const rel = relative(resolve(root), resolve(path))
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  })
}

export const normalize_path = normalizePath

/**
 * 向上找到第一个真实存在的路径分量，并把它规范化。
 *
 * ⚠️ 两个 `ENOENT` 的语义**必须分开**：
 * - `lstat` 的 `ENOENT` 表示"这个叶子还不存在" → 上溯父目录，是正常的
 *   "写一个新文件"的场景；
 * - `realpath` 的 `ENOENT` 表示"这是一个**悬空**软链"→ 必须**拒绝**。
 *
 * 早先两者写在同一个 `try` 里，悬空软链抛出的 `ENOENT` 被当成"叶子不存在"，
 * 于是路径回落到工作区内的词法位置并通过校验——而写入会**跟随链接**，
 * 在链接目标处（可能是工作区外）创建文件。属于路径逃逸。
 * 这与本函数的注释（"悬空软链永远不是合法的目标"）直接矛盾，是实现错误。
 *
 * 判定为悬空后不接受它，而不是回退到词法路径：无法证明它落在允许的根内。
 * 代价是**指向工作区内的悬空软链也会被拒**——fail-closed，可接受。
 */
async function nearestExisting(path: string): Promise<string> {
  let current = path
  while (true) {
    let info: Awaited<ReturnType<typeof lstat>>
    try {
      info = await lstat(current)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
      const parent = dirname(current)
      if (parent === current) throw error
      current = parent
      continue
    }
    if (info.isSymbolicLink()) {
      // 能 realpath 成功 = 不是悬空链。**返回值仍是链接自身路径**（`current`），
      // 由调用方随后 realpath 得到目标——保持与既有行为一致，
      // 否则非悬空链的 `suffix` 计算会被打乱。
      try {
        await realpath(current)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
          throw new AgentError({
            code: ErrorCode.PERMISSION_DENIED,
            message: 'dangling symlink is not a valid path target',
            source: 'path',
            context: { path },
          })
        throw error
      }
    }
    return current
  }
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
