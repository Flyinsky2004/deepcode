import { open, mkdir, readFile, rename, unlink, stat } from 'node:fs/promises'
import { dirname, basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

import { AgentError, ErrorCode } from '../core/errors.js'

const queues = new Map<string, Promise<void>>()

/** 同一进程内把一份 JSON store 的完整读改写串行化，防止丢失更新。 */
export async function withFileMutex<T>(path: string, action: () => Promise<T>): Promise<T> {
  const previous = queues.get(path) ?? Promise.resolve()
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate
  })
  const queued = previous.then(() => gate)
  queues.set(path, queued)

  await previous
  const lockPath = `${path}.lock`
  let lockHandle: Awaited<ReturnType<typeof open>> | undefined
  const deadline = Date.now() + 30_000
  try {
    await mkdir(dirname(path), { recursive: true })
    while (!lockHandle) {
      try {
        lockHandle = await open(lockPath, 'wx', 0o600)
        await lockHandle.writeFile(`${process.pid} ${Date.now()}\n`)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        if (Date.now() >= deadline)
          throw new AgentError({
            code: ErrorCode.STORAGE_WRITE_FAILED,
            message: `存储文件被其他进程锁定: ${path}`,
            source: 'storage',
          })
        try {
          const info = await stat(lockPath)
          if (Date.now() - info.mtimeMs > 120_000) await unlink(lockPath)
        } catch {
          /* lock disappeared; retry */
        }
        await delay(25)
      }
    }
    return await action()
  } finally {
    try {
      await lockHandle?.close()
    } finally {
      if (lockHandle) {
        try {
          await unlink(lockPath)
        } catch {
          /* already released */
        }
      }
    }
    release?.()
    if (queues.get(path) === queued) queues.delete(path)
  }
}

/** 宽容读取 JSON object；不存在和空白文件回落到工厂默认值。 */
export async function readJsonObject(
  path: string,
  defaultFactory: () => Readonly<Record<string, unknown>>,
): Promise<Readonly<Record<string, unknown>>> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return defaultFactory()
    throw new AgentError(
      {
        code: ErrorCode.STORAGE_READ_FAILED,
        message: `无法读取存储文件: ${path}`,
        source: 'storage',
      },
      { cause: error },
    )
  }

  if (text.trim() === '') return defaultFactory()

  try {
    const parsed: unknown = JSON.parse(text)
    if (!isRecord(parsed)) {
      throw new AgentError({
        code: ErrorCode.VALIDATION_FAILED,
        message: `存储文件根节点必须是 object: ${path}`,
        source: 'storage',
      })
    }
    return parsed
  } catch (error) {
    if (AgentError.is(error)) throw error
    throw new AgentError(
      {
        code: ErrorCode.STORAGE_READ_FAILED,
        message: `存储文件不是合法 JSON: ${path}`,
        source: 'storage',
      },
      { cause: error },
    )
  }
}

/**
 * 原子写入：同目录临时文件 → fsync(temp) → rename → fsync(directory)。
 * 任一步失败都会尽力清理临时文件，目标文件不会留下半段 JSON。
 */
export async function writeJsonAtomic(
  path: string,
  value: Readonly<Record<string, unknown>>,
): Promise<void> {
  const parent = dirname(path)
  const temporary = join(parent, `.${basename(path)}.${randomUUID().replaceAll('-', '')}.tmp`)
  await mkdir(parent, { recursive: true })

  try {
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }

    await rename(temporary, path)
    const directory = await open(parent, 'r')
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  } catch (error) {
    try {
      await unlink(temporary)
    } catch (cleanupError) {
      if (!isNodeError(cleanupError) || cleanupError.code !== 'ENOENT') {
        // 清理失败不覆盖原始写入错误；临时文件不会被当作正式 store 读取。
      }
    }
    throw new AgentError(
      {
        code: ErrorCode.STORAGE_WRITE_FAILED,
        message: `无法原子写入存储文件: ${path}`,
        source: 'storage',
      },
      { cause: error },
    )
  }
}

/** 在互斥临界区内完成完整读改写。 */
export async function updateJsonAtomic<T extends Readonly<Record<string, unknown>>>(
  path: string,
  defaultFactory: () => T,
  update: (current: Readonly<Record<string, unknown>>) => T,
): Promise<T> {
  return withFileMutex(path, async () => {
    const current = await readJsonObject(path, defaultFactory)
    const next = update(current)
    await writeJsonAtomic(path, next)
    return next
  })
}

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value
}
