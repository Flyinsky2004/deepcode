/**
 * 原子 JSON 读写与跨进程文件锁单测。
 *
 * 这一层是**所有持久化的地基**：`chat.json` / `config.json` / 事件日志都走它。
 * 它要保证的两件事都不能靠"代码看起来对"来确认：
 *
 * - **读**：不存在、空白、非法 JSON、根节点不是 object —— 四种情况的处理各不相同
 *   （前两种回落默认值，后两种报错），混淆任意两种都会让损坏的数据被当成空数据。
 * - **写**：临时文件 + rename。任一步失败都必须清掉临时文件并且**不留下半段 JSON**。
 *
 * 所有测试只固化既有行为，不修改实现。
 */
import { mkdir, mkdtemp, readdir, readFile, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { ErrorCode } from '../../src/core/errors.js'
import {
  isRecord,
  readJsonObject,
  updateJsonAtomic,
  withFileMutex,
  writeJsonAtomic,
} from '../../src/storage/json-file.js'

async function makeDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'deepcode-jsonfile-'))
}

describe('readJsonObject', () => {
  it('文件不存在时回落工厂默认值', async () => {
    const dir = await makeDir()
    await expect(readJsonObject(join(dir, 'missing.json'), () => ({ d: 1 }))).resolves.toEqual({
      d: 1,
    })
  })

  it('空白文件回落工厂默认值（不报错）', async () => {
    const dir = await makeDir()
    const path = join(dir, 'blank.json')
    await writeFile(path, '  \n\t ', 'utf8')
    await expect(readJsonObject(path, () => ({ d: 1 }))).resolves.toEqual({ d: 1 })
  })

  it('非法 JSON 报 STORAGE_READ_FAILED 并保留 cause', async () => {
    const dir = await makeDir()
    const path = join(dir, 'broken.json')
    await writeFile(path, '{ not json', 'utf8')
    await expect(readJsonObject(path, () => ({}))).rejects.toMatchObject({
      code: ErrorCode.STORAGE_READ_FAILED,
    })
  })

  it('根节点不是 object 时报 VALIDATION_FAILED', async () => {
    const dir = await makeDir()
    for (const [name, content] of [
      ['array.json', '[1,2]'],
      ['number.json', '42'],
      ['null.json', 'null'],
    ] as const) {
      const path = join(dir, name)
      await writeFile(path, content, 'utf8')
      await expect(
        readJsonObject(path, () => ({})),
        name,
      ).rejects.toMatchObject({
        code: ErrorCode.VALIDATION_FAILED,
      })
    }
  })

  it('读取失败（非 ENOENT）报 STORAGE_READ_FAILED', async () => {
    const dir = await makeDir()
    // 用目录冒充文件：readFile 会抛 EISDIR，不能像 ENOENT 那样被当作"没有数据"。
    const path = join(dir, 'a-directory')
    await mkdir(path)
    await expect(readJsonObject(path, () => ({}))).rejects.toMatchObject({
      code: ErrorCode.STORAGE_READ_FAILED,
    })
  })
})

describe('writeJsonAtomic', () => {
  it('按两空格缩进写盘并留下结尾换行', async () => {
    const dir = await makeDir()
    const path = join(dir, 'nested', 'out.json')
    await writeJsonAtomic(path, { a: 1, b: { c: 2 } })
    expect(await readFile(path, 'utf8')).toBe('{\n  "a": 1,\n  "b": {\n    "c": 2\n  }\n}\n')
  })

  it('写入失败时报 STORAGE_WRITE_FAILED，且不留下临时文件', async () => {
    const dir = await makeDir()
    // 目标路径是一个目录 → rename 必然失败，走失败分支。
    const path = join(dir, 'target')
    await mkdir(path)
    await expect(writeJsonAtomic(path, { a: 1 })).rejects.toMatchObject({
      code: ErrorCode.STORAGE_WRITE_FAILED,
    })
    // 临时文件必须被清掉：残留的 .tmp 会被误认成 store 数据。
    const leftovers = (await readdir(dir)).filter((name) => name.endsWith('.tmp'))
    expect(leftovers).toEqual([])
  })

  it('临时文件都没能建起来时同样报错（清理分支的 ENOENT 容错）', async () => {
    const dir = await makeDir()
    const locked = join(dir, 'locked')
    await mkdir(locked, { mode: 0o500 })
    await expect(writeJsonAtomic(join(locked, 'x.json'), { a: 1 })).rejects.toMatchObject({
      code: ErrorCode.STORAGE_WRITE_FAILED,
    })
  })
})

describe('withFileMutex', () => {
  it('串行化同一路径上的并发读改写，防止丢失更新', async () => {
    const dir = await makeDir()
    const path = join(dir, 'counter.json')
    await writeJsonAtomic(path, { n: 0 })

    // 不加锁时这两个"读-改-写"会互相覆盖；加锁后必须都生效。
    await Promise.all([
      updateJsonAtomic(
        path,
        () => ({ n: 0 }),
        (raw) => ({ n: Number(raw['n']) + 1 }),
      ),
      updateJsonAtomic(
        path,
        () => ({ n: 0 }),
        (raw) => ({ n: Number(raw['n']) + 1 }),
      ),
    ])
    await expect(readJsonObject(path, () => ({ n: -1 }))).resolves.toMatchObject({ n: 2 })
  })

  it('自动创建父目录', async () => {
    const dir = await makeDir()
    const path = join(dir, 'a', 'b', 'c.json')
    await withFileMutex(path, () => Promise.resolve(undefined))
    await expect(stat(join(dir, 'a', 'b'))).resolves.toBeDefined()
  })

  it('清掉超过 120 秒的陈旧锁后继续执行', async () => {
    const dir = await makeDir()
    const path = join(dir, 'stale.json')
    const lockPath = `${path}.lock`
    await writeFile(lockPath, '99999 0\n', 'utf8')
    // 把锁文件的 mtime 推到 10 分钟前 → 判定为崩溃进程留下的陈旧锁。
    const old = new Date(Date.now() - 600_000)
    await utimes(lockPath, old, old)

    await expect(withFileMutex(path, () => Promise.resolve('ok'))).resolves.toBe('ok')
    // 正常退出时锁必须被释放。
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('锁文件无法创建时把底层错误原样抛出', async () => {
    const dir = await makeDir()
    const path = join(dir, 'readonly', 'x.json')
    await mkdir(join(dir, 'readonly'), { mode: 0o500 })
    // 只读目录下 open(..., 'wx') 报 EACCES，不是 EEXIST → 不该被当成锁竞争重试。
    await expect(withFileMutex(path, () => Promise.resolve('ok'))).rejects.toMatchObject({
      code: 'EACCES',
    })
  })

  it('临界区抛错时锁仍然被释放，后续调用不受影响', async () => {
    const dir = await makeDir()
    const path = join(dir, 'boom.json')
    await expect(withFileMutex(path, () => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom',
    )
    await expect(withFileMutex(path, () => Promise.resolve('ok'))).resolves.toBe('ok')
  })
})

describe('isRecord', () => {
  it('只接受非 null、非数组的 object', () => {
    expect(isRecord({})).toBe(true)
    expect(isRecord([])).toBe(false)
    expect(isRecord(null)).toBe(false)
    expect(isRecord('x')).toBe(false)
    expect(isRecord(1)).toBe(false)
  })
})
