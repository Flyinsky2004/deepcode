import {
  mkdir,
  readFile,
  rename,
  copyFile,
  readdir,
  stat,
  writeFile,
  open,
  unlink,
} from 'node:fs/promises'
import { dirname, basename, join, relative } from 'node:path'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { AgentError, ErrorCode } from '../core/errors.js'
import {
  type Tool,
  type ToolContext,
  type ToolResult,
  type ValidationResult,
  PermissionAction,
  type ToolDescriptor,
} from '../core/tool.js'
import { resolveWorkspacePath } from './path-sandbox.js'
import { createWebFetchTool, createWebSearchTool } from './web-tools.js'

export { createWebFetchTool, createWebSearchTool } from './web-tools.js'

const descriptor = (
  name: string,
  description: string,
  schema: Readonly<Record<string, unknown>>,
  risk_level: ToolDescriptor['risk_level'],
  capabilities: ToolDescriptor['capabilities'],
): ToolDescriptor => ({
  name,
  description,
  input_schema: schema,
  version: '1.0.0',
  risk_level,
  capabilities,
  source: { kind: 'native' },
})
function schemaTool(
  schema: z.ZodType,
  desc: ToolDescriptor,
  execute: Tool['execute'],
  safetyCheck?: Tool['safetyCheck'],
): Tool {
  return {
    descriptor: desc,
    validate(input: unknown): ValidationResult {
      const result = schema.safeParse(input)
      return result.success
        ? { ok: true, value: result.data as Readonly<Record<string, unknown>> }
        : {
            ok: false,
            errors: result.error.issues.map((i) => ({
              path: i.path.filter(
                (p): p is string | number => typeof p === 'string' || typeof p === 'number',
              ),
              message: i.message,
            })),
          }
    },
    ...(safetyCheck === undefined ? {} : { safetyCheck }),
    execute,
  }
}
const text = z.string()
const asText = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback
const readSnapshots = new Map<string, string>()

const fileReadSchema = z.object({
  path: text,
  offset: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).max(2000).optional(),
})
export function createFileReadTool(): Tool {
  return schemaTool(
    fileReadSchema,
    descriptor(
      'file_read',
      'Read UTF-8 text file with line range',
      {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path under workspace root' },
          offset: { type: 'integer', minimum: 1, default: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 2000, default: 200 },
        },
        required: ['path'],
      },
      'low',
      ['read'],
    ),
    async (ctx, input) => {
      const path = await resolveWorkspacePath(
        String(input['path']),
        ctx.workspaceRoot,
        ctx.allowedReadRoots,
        'read',
      )
      const offset = Math.max(1, Number(input['offset'] ?? 1))
      const limit = Math.min(2000, Math.max(1, Number(input['limit'] ?? 200)))
      try {
        const content = await readFile(path, 'utf8')
        const lines = content === '' ? [] : content.split(/\r?\n/)
        if (lines.at(-1) === '' && content.endsWith('\n')) lines.pop()
        const picked = lines.slice(offset - 1, offset - 1 + limit)
        readSnapshots.set(
          `${ctx.sessionId}:${path}`,
          createHash('sha256').update(content).digest('hex'),
        )
        return {
          ok: true,
          content: picked
            .map((line, i) => `${offset + i}|${line}`)
            .join('\n')
            .slice(0, 64_000),
          data: { path, offset, limit, returned_lines: picked.length, total_lines: lines.length },
          error_code: null,
          meta: {},
        }
      } catch (error) {
        return {
          ok: false,
          content: `file not found: ${path}`,
          error_code:
            (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'FILE_NOT_FOUND' : 'IO_ERROR',
          meta: {},
        }
      }
    },
    (input, ctx) =>
      ctx.turnState['deny_sensitive_reads'] === true && sensitive(asText(input['path']))
        ? { action: PermissionAction.DENY, reason: 'sensitive file read is denied' }
        : undefined,
  )
}

const fileWriteSchema = z.object({
  path: text,
  content: text,
  create_dirs: z.boolean().optional(),
  overwrite: z.boolean().optional(),
  expected_hash: z
    .string()
    .regex(/^[a-f0-9]{64}$/i)
    .optional(),
})
export function createFileWriteTool(): Tool {
  return schemaTool(
    fileWriteSchema,
    descriptor(
      'file_write',
      'Write UTF-8 text file (overwrite by default)',
      {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path under workspace root' },
          content: { type: 'string', description: 'Full file content' },
          create_dirs: { type: 'boolean', default: true },
          overwrite: { type: 'boolean', default: true },
          expected_hash: {
            type: 'string',
            description: 'Optional SHA-256 of the current file for optimistic concurrency',
          },
        },
        required: ['path', 'content'],
      },
      'medium',
      ['write'],
    ),
    async (ctx, input) => {
      const path = await resolveWorkspacePath(
        String(input['path']),
        ctx.workspaceRoot,
        ctx.allowedWriteRoots,
        'write',
      )
      const content = String(input['content'])
      const existed = await exists(path)
      const beforeHash = existed
        ? createHash('sha256')
            .update(await readFile(path))
            .digest('hex')
        : null
      if (existed && input['overwrite'] === false)
        return {
          ok: false,
          content: `file exists and overwrite=false: ${path}`,
          error_code: 'FILE_EXISTS',
          meta: {},
        }
      if (input['expected_hash'] !== undefined && (await exists(path))) {
        const currentHash = createHash('sha256')
          .update(await readFile(path))
          .digest('hex')
        if (currentHash !== input['expected_hash'])
          return {
            ok: false,
            content: `file changed externally: ${path}`,
            error_code: 'STORAGE_EXTERNAL_MODIFICATION',
            meta: {},
          }
      }
      if (input['create_dirs'] !== false) await mkdir(dirname(path), { recursive: true })
      const backupPath = await atomicWrite(
        path,
        content,
        ctx.workspaceRoot,
        typeof input['expected_hash'] === 'string' ? input['expected_hash'] : undefined,
      )
      return {
        ok: true,
        content: `wrote file: ${path}`,
        data: {
          path,
          bytes_written: Buffer.byteLength(content),
          backup_path: backupPath,
          before_hash: beforeHash,
          after_hash: createHash('sha256').update(content).digest('hex'),
        },
        error_code: null,
        meta: {},
      }
    },
  )
}

const fileEditSchema = z.object({
  file_path: text,
  old_string: text.min(1),
  new_string: text,
  replace_all: z.boolean().optional(),
})
export function createFileEditTool(): Tool {
  return schemaTool(
    fileEditSchema,
    descriptor(
      'file_edit',
      'Edit a UTF-8 text file by replacing an exact string',
      {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'File path under workspace root' },
          old_string: { type: 'string', description: 'Exact text to replace' },
          new_string: { type: 'string', description: 'Replacement text' },
          replace_all: { type: 'boolean', default: false },
        },
        required: ['file_path', 'old_string', 'new_string'],
      },
      'medium',
      ['write'],
    ),
    async (ctx, input) => {
      const path = await resolveWorkspacePath(
        String(input['file_path']),
        ctx.workspaceRoot,
        ctx.allowedWriteRoots,
        'write',
      )
      const old = String(input['old_string'])
      const current = await readFile(path, 'utf8')
      const snapshotKey = `${ctx.sessionId}:${path}`
      const beforeHash = readSnapshots.get(snapshotKey)
      if (beforeHash === undefined)
        return {
          ok: false,
          content: `file must be read before editing: ${path}`,
          error_code: 'FILE_NOT_READ',
          meta: {},
        }
      const currentHash = createHash('sha256').update(current).digest('hex')
      if (currentHash !== beforeHash)
        return {
          ok: false,
          content: `file changed externally: ${path}`,
          error_code: 'STORAGE_EXTERNAL_MODIFICATION',
          meta: {},
        }
      const count = current.split(old).length - 1
      if (count === 0)
        return {
          ok: false,
          content: `string not found in file: ${path}`,
          error_code: 'STRING_NOT_FOUND',
          meta: {},
        }
      if (count > 1 && input['replace_all'] !== true)
        return {
          ok: false,
          content: `ambiguous match in file: ${path}`,
          error_code: 'AMBIGUOUS_MATCH',
          meta: {},
        }
      const replacement = String(input['new_string'])
      const next =
        input['replace_all'] === true
          ? current.split(old).join(replacement)
          : current.slice(0, current.indexOf(old)) +
            replacement +
            current.slice(current.indexOf(old) + old.length)
      const backupPath = await atomicWrite(path, next, ctx.workspaceRoot, currentHash)
      readSnapshots.set(snapshotKey, createHash('sha256').update(next).digest('hex'))
      return {
        ok: true,
        content: `edited file: ${path}`,
        data: {
          path,
          replacements: input['replace_all'] === true ? count : 1,
          backup_path: backupPath,
          before_hash: currentHash,
          after_hash: createHash('sha256').update(next).digest('hex'),
        },
        error_code: null,
        meta: {},
      }
    },
  )
}

const bashSchema = z.object({ command: text, timeout: z.number().int().optional() })
export function createBashTool(): Tool {
  return schemaTool(
    bashSchema,
    descriptor(
      'bash',
      'Execute a shell command in the workspace directory. Use for running scripts, building, testing, or inspecting the filesystem.',
      {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'Shell command to execute in the workspace directory.',
          },
          timeout: {
            type: 'integer',
            default: 30,
            maximum: 120,
            description: 'Timeout in seconds (max 120).',
          },
        },
        required: ['command'],
      },
      'high',
      ['shell'],
    ),
    async (ctx, input) =>
      runShell(String(input['command']), Math.min(120, Number(input['timeout'] ?? 30)), ctx),
    (input) => shellSafety(asText(input['command'])),
  )
}

const globSchema = z.object({ pattern: text, path: text.optional() })
export function createGlobTool(): Tool {
  return schemaTool(
    globSchema,
    descriptor(
      'glob',
      'Find files matching a glob pattern under a directory',
      {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: "Glob pattern, e.g. '**/*.py' or 'src/**/*_test.py'",
          },
          path: {
            type: 'string',
            default: '.',
            description: 'Base directory for the search, relative to workspace root',
          },
        },
        required: ['pattern'],
      },
      'low',
      ['read'],
    ),
    async (ctx, input) => {
      const base = await resolveWorkspacePath(
        asText(input['path'], '.'),
        ctx.workspaceRoot,
        ctx.allowedReadRoots,
        'read',
      )
      if (!(await exists(base)))
        return {
          ok: false,
          content: `directory not found: ${base}`,
          error_code: 'FILE_NOT_FOUND',
          meta: {},
        }
      const baseInfo = await stat(base)
      const searchBase = baseInfo.isDirectory() ? base : dirname(base)
      const files = await walk(searchBase)
      const pattern = asText(input['pattern'])
      const matched: string[] = []
      for (const f of files) {
        if (!globMatch(relative(ctx.workspaceRoot, f), pattern)) continue
        try {
          const safe = await resolveWorkspacePath(
            relative(ctx.workspaceRoot, f),
            ctx.workspaceRoot,
            ctx.allowedReadRoots,
            'read',
          )
          matched.push(safe)
        } catch {
          /* skip symlink escapes */
        }
        if (matched.length >= 500) break
      }
      matched.sort()
      return {
        ok: true,
        content: matched.length
          ? matched.join('\n')
          : `No files match pattern '${pattern}' in ${relative(ctx.workspaceRoot, base) || '.'}`,
        data: { matches: matched.length, pattern },
        error_code: null,
        meta: {},
      }
    },
  )
}

const grepSchema = z.object({
  pattern: text,
  path: text.optional(),
  include: text.optional(),
  ignore_case: z.boolean().optional(),
  max_results: z.number().int().min(1).max(500).optional(),
})
export function createGrepTool(): Tool {
  return schemaTool(
    grepSchema,
    descriptor(
      'grep',
      'Search file contents for a regex pattern using ripgrep with Python fallback',
      {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex pattern to search for' },
          path: {
            type: 'string',
            default: '.',
            description: 'Search directory, relative to workspace root',
          },
          include: { type: 'string' },
          ignore_case: { type: 'boolean', default: false },
          max_results: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
        },
        required: ['pattern'],
      },
      'low',
      ['read'],
    ),
    async (ctx, input) => {
      const base = await resolveWorkspacePath(
        asText(input['path'], '.'),
        ctx.workspaceRoot,
        ctx.allowedReadRoots,
        'read',
      )
      const regex = new RegExp(asText(input['pattern']), input['ignore_case'] === true ? 'i' : '')
      const limit = Number(input['max_results'] ?? 100)
      const lines: string[] = []
      for (const file of await walk(base)) {
        let safeFile: string
        try {
          safeFile = await resolveWorkspacePath(
            relative(ctx.workspaceRoot, file),
            ctx.workspaceRoot,
            ctx.allowedReadRoots,
            'read',
          )
        } catch {
          continue
        }
        if (input['include'] !== undefined && !globMatch(basename(file), asText(input['include'])))
          continue
        try {
          const fileContent = await readFile(safeFile, 'utf8')
          fileContent.split(/\r?\n/).forEach((line, i) => {
            if (lines.length < limit && regex.test(line))
              lines.push(`${relative(ctx.workspaceRoot, file)}:${i + 1}:${line}`)
          })
        } catch {
          continue
        }
      }
      return {
        ok: true,
        content: lines.join('\n'),
        data: { matches: lines.length, files: new Set(lines.map((l) => l.split(':')[0])).size },
        error_code: null,
        meta: {},
      }
    },
  )
}

const askSchema = z.object({
  questions: z
    .array(
      z.object({
        question: text,
        header: text,
        options: z.array(z.object({ label: text, description: text })),
        multiSelect: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(4),
})
export function createAskUserQuestionTool(): Tool {
  return schemaTool(
    askSchema,
    descriptor(
      'ask_user_question',
      'Ask the user structured questions to clarify requirements, resolve ambiguity, or make decisions. Use when you need the user to choose between options or confirm a direction.',
      {
        type: 'object',
        properties: {
          questions: {
            type: 'array',
            minItems: 1,
            maxItems: 4,
            items: {
              type: 'object',
              properties: {
                question: { type: 'string' },
                header: { type: 'string' },
                options: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      label: { type: 'string' },
                      description: { type: 'string' },
                    },
                    required: ['label', 'description'],
                  },
                },
                multiSelect: { type: 'boolean' },
              },
              required: ['question', 'header', 'options'],
            },
          },
        },
        required: ['questions'],
      },
      'low',
      ['interactive'],
    ),
    (_ctx, input) =>
      Promise.resolve({
        ok: true,
        content: '',
        error_code: 'USER_INPUT_REQUIRED',
        meta: { questions: input['questions'] },
      }),
  )
}

const todoSchema = z.object({
  todos: z.array(
    z.object({ content: text, status: z.enum(['pending', 'in_progress', 'completed']) }),
  ),
})
export function createTodoWriteTool(): Tool {
  return schemaTool(
    todoSchema,
    descriptor(
      'todo_write',
      'Create and track a structured task list for the current coding session',
      { type: 'object', properties: { todos: { type: 'array' } }, required: ['todos'] },
      'low',
      ['interactive'],
    ),
    (_ctx, input) =>
      Promise.resolve({
        ok: true,
        content: 'Todo list updated.',
        data: { todos: input['todos'] },
        error_code: null,
        meta: {},
      }),
  )
}

export function createBuiltinTools(): readonly Tool[] {
  return [
    createFileReadTool(),
    createFileWriteTool(),
    createFileEditTool(),
    createBashTool(),
    createGlobTool(),
    createGrepTool(),
    createWebFetchTool(),
    createWebSearchTool(),
    createAskUserQuestionTool(),
    createTodoWriteTool(),
  ]
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
async function atomicWrite(
  path: string,
  content: string,
  workspaceRoot: string,
  expectedExistingHash?: string,
): Promise<string | null> {
  let backupPath: string | null = null
  if (await exists(path)) {
    const backup = join(
      workspaceRoot,
      '.deepcode',
      'backups',
      `${basename(path)}.${Date.now()}-${randomUUID()}.bak`,
    )
    await mkdir(dirname(backup), { recursive: true })
    await copyFile(path, backup)
    backupPath = backup
  }
  const temp = `${path}.tmp-${randomUUID()}`
  try {
    await writeFile(temp, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    const handle = await open(temp, 'r+')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
    if (expectedExistingHash !== undefined) {
      const latest = createHash('sha256')
        .update(await readFile(path))
        .digest('hex')
      if (latest !== expectedExistingHash)
        throw new AgentError({
          code: ErrorCode.STORAGE_EXTERNAL_MODIFICATION,
          message: 'file changed externally before atomic replace',
          source: 'file',
        })
    }
    await rename(temp, path)
    const actual = createHash('sha256')
      .update(await readFile(path))
      .digest('hex')
    const expected = createHash('sha256').update(content).digest('hex')
    if (actual !== expected) {
      if (backupPath) await copyFile(backupPath, path)
      else await unlink(path)
      throw new Error('atomic write verification failed; rollback completed')
    }
    const directory = await open(dirname(path), 'r')
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
    return backupPath
  } catch (error) {
    try {
      await unlink(temp)
    } catch {
      /* best effort cleanup */
    }
    throw error
  }
}
async function walk(root: string): Promise<string[]> {
  const info = await stat(root)
  if (info.isFile()) return [root]
  const out: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue
    const path = join(root, entry.name)
    if (entry.isDirectory()) out.push(...(await walk(path)))
    else out.push(path)
  }
  return out
}
/**
 * 把 glob 模式翻译成正则并匹配。
 *
 * 语义与旧项目使用的 Python `Path.glob()` 对齐（`parts/04` §5.5）：
 * - `*` 匹配除 `/` 外的任意长度片段（不跨目录）；
 * - `?` 匹配单个非 `/` 字符；
 * - `**` 递归，可匹配零层或多层。`**` 后跟 `/` 时整体作为**可选**前缀，
 *   因此 `**\/*.py` 既能匹配根下的 `a.py`，也能匹配 `src/deep/a.py`；
 * - 其余字符按字面量处理（正则元字符转义）。
 *
 * ⚠️ 必须**单次遍历**生成正则。先前的实现是对模式串连着做四次 `replaceAll`，
 * 后一步会重写前一步刚插入的片段（`*` → `[^/]*` 会把 `**` 生成的 `.*` 改掉，
 * `?` → `[^/]` 又会改掉 `(?:...)?` 里的 `?`），结果任何含 `**` 的模式都恒不匹配
 * ——而 `glob` 工具自己的 description 举的例子正是 `**\/*.py`。
 */
function globMatch(path: string, pattern: string): boolean {
  let regex = ''
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]!
    if (char === '*') {
      if (pattern[index + 1] !== '*') {
        regex += '[^/]*'
        continue
      }
      if (pattern[index + 2] === '/') {
        // `**/`：零层或多层目录前缀。
        regex += '(?:.*/)?'
        index += 2
      } else {
        // 行尾的裸 `**`：任意深度。
        regex += '.*'
        index += 1
      }
      continue
    }
    if (char === '?') {
      regex += '[^/]'
      continue
    }
    regex += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${regex}$`).test(path)
}
function sensitive(path: string): boolean {
  const name = basename(path).toLowerCase()
  return (
    name === '.env' ||
    name.startsWith('.env.') ||
    ['.pem', '.key', '.p12', '.pfx'].some((s) => name.endsWith(s)) ||
    path
      .split('/')
      .some((p) => ['.ssh', 'credentials', 'tokens', 'secrets'].includes(p.toLowerCase()))
  )
}
async function runShell(
  command: string,
  timeoutSeconds: number,
  ctx: ToolContext,
): Promise<ToolResult> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: ctx.workspaceRoot,
      shell: true,
      detached: true,
      env: {
        PATH: process.env['PATH'],
        HOME: process.env['HOME'],
        NODE_PATH: process.env['NODE_PATH'],
      },
    })
    let stdout = ''
    let stderr = ''
    const outputLimit = 64_000
    const timer = setTimeout(
      () => {
        child.kill('SIGTERM')
        resolve({
          ok: false,
          content: `command timed out after ${timeoutSeconds}s`,
          data: { exit_code: null },
          error_code: 'TIMEOUT',
          meta: {},
        })
      },
      Math.max(0, timeoutSeconds) * 1000,
    )
    timer.unref?.()
    child.stdout.on('data', (d: Buffer) => {
      if (stdout.length < outputLimit) stdout += d.toString().slice(0, outputLimit - stdout.length)
    })
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < outputLimit) stderr += d.toString().slice(0, outputLimit - stderr.length)
    })
    const stop = () => {
      try {
        process.kill(-child.pid!, 'SIGTERM')
      } catch {
        child.kill('SIGTERM')
      }
    }
    if (ctx.signal.aborted) stop()
    else ctx.signal.addEventListener('abort', stop, { once: true })
    child.on('close', (code) => {
      clearTimeout(timer)
      const output =
        `${stdout}${stderr ? `\n[stderr]\n${stderr}` : ''}`.trim() || `(exit code: ${code ?? 1})`
      const clipped =
        output.length > 8000 ? `${output.slice(0, 8000)}\n... [output truncated]` : output
      resolve({
        ok: code === 0,
        content: clipped,
        data: { exit_code: code },
        error_code: code === 0 ? null : 'NONZERO_EXIT',
        meta: {},
      })
    })
  })
}

function shellSafety(command: string): { action: PermissionAction; reason: string } | undefined {
  const trimmed = command.trim()
  if (!trimmed || /[;&|><`$(){}]/.test(trimmed))
    return {
      action: PermissionAction.DENY,
      reason: 'shell operators and expansions are not allowed',
    }
  const first = trimmed.split(/\s+/)[0]?.toLowerCase() ?? ''
  if (['rm', 'sudo', 'mkfs', 'shutdown', 'reboot', 'dd', 'chmod', 'chown'].includes(first))
    return { action: PermissionAction.DENY, reason: 'command is blocked by shell safety policy' }
  const readonly = ['pwd', 'ls', 'find', 'rg', 'grep', 'sed', 'head', 'tail', 'cat', 'git']
  if (
    readonly.includes(first) &&
    !(first === 'git' && /\b(push|commit|reset|checkout|clean)\b/i.test(trimmed))
  )
    return { action: PermissionAction.ALLOW, reason: 'read-only shell command' }
  return { action: PermissionAction.ASK, reason: 'command requires approval' }
}
