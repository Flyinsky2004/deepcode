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

async function nearestExisting(path: string): Promise<string> {
  let current = path
  while (true) {
    try {
      const info = await lstat(current)
      // A dangling symlink is never a valid write target and must not be
      // treated as a missing leaf beneath an allowed directory.
      if (info.isSymbolicLink()) await realpath(current)
      return current
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
      const parent = dirname(current)
      if (parent === current) throw error
      current = parent
    }
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
