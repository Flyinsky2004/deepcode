/**
 * `path-sandbox` 的路径逃逸防护测试。
 *
 * 这个模块是**安全边界**：工具的 `path` 参数先经过它，才会落到 `fs` 调用上。
 * 因此这里刻意覆盖每一类逃逸手法：
 *
 * - 词法逃逸：`..`、绝对路径；
 * - 链接逃逸：指向工作区外的软链、软链目录；
 * - 尚不存在的路径（写操作的目标）：必须**向上找到最近的已存在祖先**再做 realpath
 *   校验，否则"新建文件"要么全被拒，要么绕过校验；
 * - 悬空软链：**拒绝**（无法证明它落在允许的根内，见文末专项用例）。
 *
 * 绝大多数断言固化的既有行为；**悬空软链**那组例外——它固化的是修正后的行为
 * （原先会放行并允许逃出工作区，属实现错误），回归时会立刻失败。
 */
import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { ErrorCode } from '../../src/core/errors.js'
import {
  normalizePath,
  normalize_path,
  pathAllowed,
  pathExists,
  resolveWorkspacePath,
} from '../../src/tools/path-sandbox.js'

async function makeDirs(): Promise<{ root: string; outside: string }> {
  const root = await mkdtemp(join(tmpdir(), 'deepcode-sandbox-root-'))
  const outside = await mkdtemp(join(tmpdir(), 'deepcode-sandbox-out-'))
  return { root, outside }
}

/** 断言抛出的是指定错误码的 AgentError，并返回它，便于进一步检查 context。 */
async function expectThrowsAsync(fn: () => Promise<unknown>): Promise<{
  code: string
  message: string
  context: unknown
}> {
  try {
    await fn()
  } catch (error) {
    const typed = error as { code?: string; message: string; context?: unknown }
    return { code: typed.code ?? '', message: typed.message, context: typed.context }
  }
  throw new Error('期望抛出错误，但调用成功返回了')
}

describe('resolveWorkspacePath：输入校验', () => {
  it('空路径直接判为校验失败（不给 fs 层解释空串的机会）', async () => {
    const { root } = await makeDirs()
    const thrown = await expectThrowsAsync(() => resolveWorkspacePath('', root, [root]))
    expect(thrown.code).toBe(ErrorCode.VALIDATION_FAILED)
    expect(thrown.message).toBe('invalid path')
  })

  it('含 NUL 字节的路径判为校验失败（避免截断攻击）', async () => {
    const { root } = await makeDirs()
    const thrown = await expectThrowsAsync(() => resolveWorkspacePath(`a\0b.txt`, root, [root]))
    expect(thrown.code).toBe(ErrorCode.VALIDATION_FAILED)
  })
})

describe('resolveWorkspacePath：工作区内的合法路径', () => {
  it('相对路径解析为工作区根下的绝对路径', async () => {
    const { root } = await makeDirs()
    await writeFile(join(root, 'a.txt'), 'x')
    const canonicalRoot = await realpath(root)
    expect(await resolveWorkspacePath('a.txt', root, [root])).toBe(join(canonicalRoot, 'a.txt'))
  })

  it('绝对路径只要落在工作区内就允许', async () => {
    const { root } = await makeDirs()
    await writeFile(join(root, 'a.txt'), 'x')
    const canonicalRoot = await realpath(root)
    expect(await resolveWorkspacePath(join(root, 'a.txt'), root, [root])).toBe(
      join(canonicalRoot, 'a.txt'),
    )
  })

  it('工作区内的空目录也能解析（已存在但不是普通文件）', async () => {
    const { root } = await makeDirs()
    await mkdir(join(root, 'dir'), { recursive: true })
    const canonicalRoot = await realpath(root)
    expect(await resolveWorkspacePath('dir', root, [root])).toBe(join(canonicalRoot, 'dir'))
  })

  it('尚不存在的叶子路径向上取最近的已存在祖先再补回后缀', async () => {
    const { root } = await makeDirs()
    const canonicalRoot = await realpath(root)
    // `new/nested.txt` 两级都不存在：nearestExisting 会一直上溯到 root
    expect(await resolveWorkspacePath('new/nested.txt', root, [root])).toBe(
      join(canonicalRoot, 'new', 'nested.txt'),
    )
  })

  it('`a/../b.txt` 这类未规范化输入按词法规范化后再判定', async () => {
    const { root } = await makeDirs()
    await writeFile(join(root, 'b.txt'), 'x')
    const canonicalRoot = await realpath(root)
    expect(await resolveWorkspacePath('a/../b.txt', root, [root])).toBe(
      join(canonicalRoot, 'b.txt'),
    )
  })

  it('allowedRoots 为空时退化为只允许工作区根', async () => {
    const { root } = await makeDirs()
    await writeFile(join(root, 'a.txt'), 'x')
    const canonicalRoot = await realpath(root)
    expect(await resolveWorkspacePath('a.txt', root, [])).toBe(join(canonicalRoot, 'a.txt'))
  })
})

describe('resolveWorkspacePath：路径逃逸防护', () => {
  it('`..` 上溯到工作区外被拒绝', async () => {
    const { root } = await makeDirs()
    const thrown = await expectThrowsAsync(() =>
      resolveWorkspacePath('../escape.txt', root, [root]),
    )
    expect(thrown.code).toBe(ErrorCode.PERMISSION_DENIED)
    expect(thrown.message).toBe('path outside allowed read roots')
    // context 带上原始输入，便于审计"谁试图逃逸"
    expect(thrown.context).toEqual({ path: '../escape.txt' })
  })

  it('多级 `..` 同样被拒绝', async () => {
    const { root } = await makeDirs()
    const thrown = await expectThrowsAsync(() =>
      resolveWorkspacePath('a/b/../../../escape.txt', root, [root]),
    )
    expect(thrown.code).toBe(ErrorCode.PERMISSION_DENIED)
  })

  it('绝对路径指向工作区外被拒绝', async () => {
    const { root, outside } = await makeDirs()
    const thrown = await expectThrowsAsync(() =>
      resolveWorkspacePath(join(outside, 'x.txt'), root, [root]),
    )
    expect(thrown.code).toBe(ErrorCode.PERMISSION_DENIED)
  })

  it('write 模式下错误信息标注 write（便于区分只读/写入越权）', async () => {
    const { root } = await makeDirs()
    const thrown = await expectThrowsAsync(() =>
      resolveWorkspacePath('../escape.txt', root, [root], 'write'),
    )
    expect(thrown.message).toBe('path outside allowed write roots')
  })

  it('指向工作区外的软链被 realpath 击穿后拒绝', async () => {
    const { root, outside } = await makeDirs()
    await writeFile(join(outside, 'secret.txt'), 'secret')
    await symlink(join(outside, 'secret.txt'), join(root, 'link.txt'))
    const thrown = await expectThrowsAsync(() => resolveWorkspacePath('link.txt', root, [root]))
    expect(thrown.code).toBe(ErrorCode.PERMISSION_DENIED)
  })

  it('软链目录下的文件同样逃不出去', async () => {
    const { root, outside } = await makeDirs()
    await mkdir(join(outside, 'sub'), { recursive: true })
    await writeFile(join(outside, 'sub', 'real.txt'), 'x')
    await symlink(join(outside, 'sub'), join(root, 'linkdir'))
    const thrown = await expectThrowsAsync(() =>
      resolveWorkspacePath('linkdir/real.txt', root, [root]),
    )
    expect(thrown.code).toBe(ErrorCode.PERMISSION_DENIED)
  })

  it('工作区内的软链指向工作区内时仍允许（不能因噎废食）', async () => {
    const { root } = await makeDirs()
    await writeFile(join(root, 'real.txt'), 'x')
    await symlink(join(root, 'real.txt'), join(root, 'alias.txt'))
    const canonicalRoot = await realpath(root)
    // 允许，但返回的是**软链解析后的真实路径**，后续校验与审计都基于它
    expect(await resolveWorkspacePath('alias.txt', root, [root])).toBe(
      join(canonicalRoot, 'real.txt'),
    )
  })
})

describe('resolveWorkspacePath：allowedRoots 的处理', () => {
  it('允许根之外的第二个根：命中即可', async () => {
    const { root, outside } = await makeDirs()
    await mkdir(join(root, 'work'), { recursive: true })
    await writeFile(join(outside, 'shared.txt'), 'x')
    const canonicalOutside = await realpath(outside)
    expect(
      await resolveWorkspacePath(join(outside, 'shared.txt'), root, [join(root, 'work'), outside]),
    ).toBe(join(canonicalOutside, 'shared.txt'))
  })

  it('不存在的允许根退化为词法路径（realpath 失败走 catch 分支），但仍然参与判定', async () => {
    const { root } = await makeDirs()
    await writeFile(join(root, 'a.txt'), 'x')
    const ghost = join(root, 'ghost-root')
    const thrown = await expectThrowsAsync(() => resolveWorkspacePath('a.txt', root, [ghost]))
    expect(thrown.code).toBe(ErrorCode.PERMISSION_DENIED)
  })

  it('不存在的相对允许根走 catch 分支后按词法路径参与判定', async () => {
    const { root } = await makeDirs()
    await writeFile(join(root, 'a.txt'), 'x')
    const thrown = await expectThrowsAsync(() =>
      resolveWorkspacePath('a.txt', root, ['ghost-rel-root']),
    )
    expect(thrown.code).toBe(ErrorCode.PERMISSION_DENIED)
  })

  it('相对形式的允许根按工作区根拼接后再判定', async () => {
    const { root } = await makeDirs()
    await mkdir(join(root, 'sub'), { recursive: true })
    await writeFile(join(root, 'sub', 'a.txt'), 'x')
    const canonicalRoot = await realpath(root)
    expect(await resolveWorkspacePath('sub/a.txt', root, ['sub'])).toBe(
      join(canonicalRoot, 'sub', 'a.txt'),
    )
    // 相对根之外仍然拒绝
    const thrown = await expectThrowsAsync(() => resolveWorkspacePath('../a.txt', root, ['sub']))
    expect(thrown.code).toBe(ErrorCode.PERMISSION_DENIED)
  })
})

/**
 * 悬空软链：**拒绝**。
 *
 * `nearestExisting()` 里有两个语义不同的 `ENOENT`，早先被同一个 `catch` 吞成一种：
 * - `lstat` 的 `ENOENT` = "叶子还不存在" → 上溯父目录（写新文件的正常路径）；
 * - `realpath` 的 `ENOENT` = "这是**悬空**软链" → 必须拒绝。
 *
 * 两者混在一起时，悬空链被当成"缺失叶子"，路径回落到工作区内的词法位置并通过校验；
 * 而写入会**跟随链接**，在链接目标处创建文件——`write` 模式下目标在工作区外时即路径逃逸。
 * 这与函数注释（"悬空软链永远不是合法的目标"）直接矛盾，属实现错误。
 *
 * 现在的判定：realpath 失败即拒绝，不回退到词法路径（无法证明它落在允许的根内）。
 * 代价是**指向工作区内的悬空链也会被拒**——fail-closed。
 */
describe('resolveWorkspacePath：悬空软链必须被拒绝', () => {
  it('指向工作区外的悬空软链被拒绝（原先会放行并逃出工作区）', async () => {
    const { root, outside } = await makeDirs()
    await symlink(join(outside, 'will-be-created.txt'), join(root, 'dangling.txt'))
    const thrown = await expectThrowsAsync(() =>
      resolveWorkspacePath('dangling.txt', root, [root], 'write'),
    )
    expect(thrown.code).toBe(ErrorCode.PERMISSION_DENIED)
    expect(thrown.message).toBe('dangling symlink is not a valid path target')
  })

  it('指向工作区内的悬空软链同样被拒绝（fail-closed）', async () => {
    // 链接目标在工作区内、跟过去并不会逃逸。但 realpath 解析不出它，
    // 我们无法**证明**它落在允许的根内，因此一律拒绝而不是猜。
    const { root } = await makeDirs()
    await symlink(join(root, 'not-yet.txt'), join(root, 'dangling-inside.txt'))
    const thrown = await expectThrowsAsync(() =>
      resolveWorkspacePath('dangling-inside.txt', root, [root], 'write'),
    )
    expect(thrown.code).toBe(ErrorCode.PERMISSION_DENIED)
  })

  it('悬空软链作为中间路径分量时也被拒绝', async () => {
    const { root, outside } = await makeDirs()
    await symlink(join(outside, 'not-yet'), join(root, 'dangling-dir'))
    const thrown = await expectThrowsAsync(() =>
      resolveWorkspacePath('dangling-dir/file.txt', root, [root], 'write'),
    )
    expect(thrown.code).toBe(ErrorCode.PERMISSION_DENIED)
  })

  it('读模式同样拒绝（悬空链上的读取必然失败，不该被当成"文件不存在"放行）', async () => {
    const { root, outside } = await makeDirs()
    await symlink(join(outside, 'ghost.txt'), join(root, 'dangling.txt'))
    const thrown = await expectThrowsAsync(() =>
      resolveWorkspacePath('dangling.txt', root, [root], 'read'),
    )
    expect(thrown.code).toBe(ErrorCode.PERMISSION_DENIED)
  })
})

describe('normalizePath / pathAllowed：词法变体', () => {
  it('normalizePath 拼接相对路径，保留绝对路径', () => {
    const root = resolve('/tmp/ws')
    expect(normalizePath('a/b.txt', root)).toBe(resolve(root, 'a/b.txt'))
    expect(normalizePath(resolve('/tmp/other/x.txt'), root)).toBe(resolve('/tmp/other/x.txt'))
    // snake_case 别名与 camelCase 同源
    expect(normalize_path).toBe(normalizePath)
  })

  it('normalizePath 不做 realpath，因此是纯词法操作（符号链接不会被解析）', () => {
    const root = resolve('/tmp/ws')
    expect(normalizePath('link/../a.txt', root)).toBe(resolve(root, 'a.txt'))
  })

  it('pathAllowed：命中根自身与其子路径为真，越界与空根表为假', () => {
    const root = resolve('/tmp/ws')
    expect(pathAllowed(root, [root])).toBe(true)
    expect(pathAllowed(resolve(root, 'sub/a.txt'), [root])).toBe(true)
    expect(pathAllowed(resolve('/tmp/other'), [root])).toBe(false)
    expect(pathAllowed(resolve(root, 'a.txt'), [])).toBe(false)
  })

  it('pathAllowed 是词法判定：`..` 只按字符串比较，不做 realpath', () => {
    const root = resolve('/tmp/ws')
    // 前缀相同但不在根下（`/tmp/ws-other`）必须判为越界，不能被 startsWith 骗过
    expect(pathAllowed(resolve('/tmp/ws-other/a.txt'), [root])).toBe(false)
  })

  /**
   * ⚠️ 可疑行为：`pathAllowed` 用 `rel.startsWith('..')` 判越界，会误伤**名字以 `..` 开头**
   * 的工作区内路径（`..foo`、`..bar/baz`）。同一个仓库里的 `resolveWorkspacePath`
   * 判的是 `rel === '..' || rel.startsWith('../')`，两者对同一输入的结论不一致。
   *
   * 后果是"拒绝"而不是"放行"，属于 fail-closed，不影响安全性；此处固化现状待裁决。
   */
  it('名字以 `..` 开头的合法路径被 pathAllowed 误判为越界（可疑，保留现状）', () => {
    const root = resolve('/tmp/ws')
    expect(pathAllowed(resolve(root, '..foo'), [root])).toBe(false)
    expect(pathAllowed(resolve(root, '..foo/bar.txt'), [root])).toBe(false)
    // 对照：真正的越界写法
    expect(pathAllowed(resolve(root, '../outside.txt'), [root])).toBe(false)
  })

  it('resolveWorkspacePath 对 `..foo` 的判定与 pathAllowed 不同（前者按段判定，是正确的一方）', async () => {
    const { root } = await makeDirs()
    await writeFile(join(root, '..foo'), 'x')
    const canonicalRoot = await realpath(root)
    expect(await resolveWorkspacePath('..foo', root, [root])).toBe(join(canonicalRoot, '..foo'))
  })
})

describe('pathExists', () => {
  it('存在返回 true，不存在返回 false（不抛错）', async () => {
    const { root } = await makeDirs()
    await writeFile(join(root, 'a.txt'), 'x')
    expect(await pathExists(join(root, 'a.txt'))).toBe(true)
    expect(await pathExists(join(root, 'missing.txt'))).toBe(false)
  })
})
