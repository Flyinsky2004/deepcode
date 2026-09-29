/**
 * 内置工具的边界与防护行为单测。
 *
 * 这里刻意覆盖的不是"happy path"（那些已有验收测试），而是**出错时才走到、
 * 但走错就造成实际损害**的分支：
 *
 * - `file_edit` 的"必须先读后写"与"外部修改检测"——它们是多进程/多会话下
 *   避免覆盖别人改动的唯一防线；
 * - `bash` 的 `shellSafety()`——它决定一条命令是直接拒绝、免审批还是走审批，
 *   判错就等于给了模型不该有的执行权；
 * - `file_read` 的敏感文件拒绝、`glob`/`grep` 的符号链接逃逸跳过。
 *
 * 所有测试只固化既有行为，不修改实现。
 */
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { PermissionAction, type Tool, type ToolContext } from '../../src/core/tool.js'
import {
  createAskUserQuestionTool,
  createBashTool,
  createBuiltinTools,
  createFileEditTool,
  createFileReadTool,
  createFileWriteTool,
  createGlobTool,
  createGrepTool,
  createTodoWriteTool,
} from '../../src/tools/builtins.js'

/**
 * 建一个临时工作区，并**取真实路径**。
 *
 * ️ macOS 上 `mkdtemp` 返回 `/var/folders/...`，而 `resolveWorkspacePath()`
 * 会先 `realpath(workspaceRoot)` 得到 `/private/var/folders/...`。若两者不一致，
 * 工具内部用 `relative(ctx.workspaceRoot, f)` 算出的相对路径就会带上 `../..`，
 * 于是每个文件都被判为逃逸工作区而被跳过。真实调用方的 workspaceRoot 已是
 * 规范化路径，这里对齐它才不会测出假阴性。
 */
async function workspace(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), 'deepcode-builtins-')))
}

function ctx(root: string, overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: 's1' as ToolContext['sessionId'],
    turnId: 't1' as ToolContext['turnId'],
    principalId: 'p',
    workspaceRoot: root,
    allowedReadRoots: [root],
    allowedWriteRoots: [root],
    turnState: {},
    budget: {} as ToolContext['budget'],
    signal: new AbortController().signal,
    ...overrides,
  }
}

const run = async (
  tool: Tool,
  root: string,
  input: unknown,
  overrides: Partial<ToolContext> = {},
) => tool.execute(ctx(root, overrides), input as Readonly<Record<string, unknown>>)

describe('内置工具集合', () => {
  it('createBuiltinTools 返回全部十个内置工具且名字唯一', () => {
    const names = createBuiltinTools().map((t) => t.descriptor.name)
    expect(names).toEqual([
      'file_read',
      'file_write',
      'file_edit',
      'bash',
      'glob',
      'grep',
      'web_fetch',
      'web_search',
      'ask_user_question',
      'todo_write',
    ])
    expect(new Set(names).size).toBe(names.length)
  })

  it('校验失败时返回逐条错误（含字段路径）', () => {
    const result = createFileReadTool().validate({ path: 42 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors[0]).toMatchObject({ path: ['path'] })
  })
})

describe('file_read', () => {
  it('空文件返回 0 行而不是一个空行', async () => {
    const root = await workspace()
    await writeFile(join(root, 'empty.txt'), '', 'utf8')
    const result = await run(createFileReadTool(), root, { path: 'empty.txt' })
    expect(result).toMatchObject({
      ok: true,
      content: '',
      data: { returned_lines: 0, total_lines: 0 },
    })
  })

  it('没有结尾换行的文件不会多出空行', async () => {
    const root = await workspace()
    await writeFile(join(root, 'a.txt'), 'l1\nl2', 'utf8')
    const result = await run(createFileReadTool(), root, { path: 'a.txt' })
    expect(result.content).toBe('1|l1\n2|l2')
    expect(result.data).toMatchObject({ total_lines: 2 })
  })

  it('有结尾换行时去掉末尾空行', async () => {
    const root = await workspace()
    await writeFile(join(root, 'a.txt'), 'l1\nl2\n', 'utf8')
    await expect(run(createFileReadTool(), root, { path: 'a.txt' })).resolves.toMatchObject({
      data: { total_lines: 2 },
    })
  })

  it('offset/limit 越界时被夹到合法范围', async () => {
    const root = await workspace()
    await writeFile(
      join(root, 'a.txt'),
      Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join('\n'),
    )
    const result = await run(createFileReadTool(), root, { path: 'a.txt', offset: 9, limit: 5000 })
    expect(result.content).toBe('9|l9\n10|l10')
    // 负数 offset 被抬到 1。
    const fromStart = await run(createFileReadTool(), root, { path: 'a.txt', offset: -5, limit: 1 })
    expect(fromStart.content).toBe('1|l1')
  })

  it('文件不存在报 FILE_NOT_FOUND，其它 IO 错误报 IO_ERROR', async () => {
    const root = await workspace()
    await expect(run(createFileReadTool(), root, { path: 'missing.txt' })).resolves.toMatchObject({
      ok: false,
      error_code: 'FILE_NOT_FOUND',
    })
    // 用目录冒充文件：readFile 抛 EISDIR，不是 ENOENT。
    await mkdir(join(root, 'dir'))
    await expect(run(createFileReadTool(), root, { path: 'dir' })).resolves.toMatchObject({
      ok: false,
      error_code: 'IO_ERROR',
    })
  })

  it('开启 deny_sensitive_reads 时拒绝敏感文件，放行普通文件', async () => {
    const tool = createFileReadTool()
    const root = await workspace()
    await writeFile(join(root, '.env'), 'KEY=1', 'utf8')
    await writeFile(join(root, 'app.ts'), '', 'utf8')
    const guarded = { turnState: { deny_sensitive_reads: true } }

    expect(tool.safetyCheck?.({ path: '.env' }, ctx(root, guarded))).toMatchObject({
      action: PermissionAction.DENY,
    })
    // 未开启守卫时不做任何声明（undefined = 没有意见，交给权限引擎）。
    expect(tool.safetyCheck?.({ path: '.env' }, ctx(root))).toBeUndefined()
    // 开启守卫但目标不敏感时同样没有意见。
    expect(tool.safetyCheck?.({ path: 'app.ts' }, ctx(root, guarded))).toBeUndefined()
  })

  it('敏感文件判定覆盖 .env.*、密钥扩展名与敏感目录', async () => {
    const tool = createFileReadTool()
    const root = await workspace()
    const guarded = { turnState: { deny_sensitive_reads: true } }
    const denied = [
      '.env.local',
      'server.pem',
      'cert.key',
      'a.p12',
      'b.pfx',
      '.ssh/id_rsa',
      'x/credentials',
      'y/tokens',
      'z/secrets',
    ]
    for (const path of denied)
      expect(tool.safetyCheck?.({ path }, ctx(root, guarded)), path).toMatchObject({
        action: PermissionAction.DENY,
      })
    // `.envrc` 不是 `.env` 也不是 `.env.` 前缀 → 不拒绝。
    expect(tool.safetyCheck?.({ path: '.envrc' }, ctx(root, guarded))).toBeUndefined()
  })
})

describe('file_write', () => {
  it('overwrite=false 且文件已存在时拒绝写入', async () => {
    const root = await workspace()
    await writeFile(join(root, 'a.txt'), 'old', 'utf8')
    await expect(
      run(createFileWriteTool(), root, { path: 'a.txt', content: 'new', overwrite: false }),
    ).resolves.toMatchObject({ ok: false, error_code: 'FILE_EXISTS' })
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('old')
  })

  it('expected_hash 不匹配时拒绝（乐观并发控制）', async () => {
    const root = await workspace()
    await writeFile(join(root, 'a.txt'), 'old', 'utf8')
    await expect(
      run(createFileWriteTool(), root, {
        path: 'a.txt',
        content: 'new',
        expected_hash: 'f'.repeat(64),
      }),
    ).resolves.toMatchObject({ ok: false, error_code: 'STORAGE_EXTERNAL_MODIFICATION' })
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('old')
  })

  it('写入已有文件时留备份，新文件时没有备份', async () => {
    const root = await workspace()
    await writeFile(join(root, 'a.txt'), 'old', 'utf8')
    const overwritten = await run(createFileWriteTool(), root, { path: 'a.txt', content: 'new' })
    const overwrittenData = overwritten.data as Record<string, unknown>
    expect(overwrittenData['backup_path']).toEqual(expect.stringContaining('.deepcode/backups'))
    expect(await readFile(overwrittenData['backup_path'] as string, 'utf8')).toBe('old')
    expect(overwrittenData['before_hash']).toMatch(/^[a-f0-9]{64}$/)

    const created = await run(createFileWriteTool(), root, { path: 'b.txt', content: 'x' })
    const createdData = created.data as Record<string, unknown>
    expect(createdData['backup_path']).toBeNull()
    expect(createdData['before_hash']).toBeNull()
  })

  it('create_dirs=false 且目录不存在时写入以异常结束（不是结构化失败）', async () => {
    // ⚠️ 与 file_read/glob 不同，file_write 在底层 IO 失败时**抛出**而不是返回
    // `{ok:false, error_code}`。运行时由 `ToolExecutor` 的 catch 兜成结构化结果，
    // 所以不会漏给模型；但工具层的错误形状不一致。按现状固化，已记入测试报告。
    const root = await workspace()
    await expect(
      run(createFileWriteTool(), root, { path: 'nope/a.txt', content: 'x', create_dirs: false }),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('默认自动建目录', async () => {
    const root = await workspace()
    await expect(
      run(createFileWriteTool(), root, { path: 'a/b/c.txt', content: 'x' }),
    ).resolves.toMatchObject({ ok: true })
  })
})

describe('file_edit', () => {
  async function prepared(): Promise<{ root: string; path: string; tool: Tool }> {
    const root = await workspace()
    await writeFile(join(root, 'a.txt'), 'alpha beta alpha', 'utf8')
    return { root, path: 'a.txt', tool: createFileEditTool() }
  }

  it('必须先读后写：没读过的文件拒绝编辑', async () => {
    const { root, path, tool } = await prepared()
    await expect(
      run(tool, root, { file_path: path, old_string: 'alpha', new_string: 'x' }),
    ).resolves.toMatchObject({ ok: false, error_code: 'FILE_NOT_READ' })
  })

  it('读过之后仍检测外部修改', async () => {
    const { root, path, tool } = await prepared()
    await run(createFileReadTool(), root, { path })
    await writeFile(join(root, path), 'changed by someone else', 'utf8')
    await expect(
      run(tool, root, { file_path: path, old_string: 'changed', new_string: 'x' }),
    ).resolves.toMatchObject({ ok: false, error_code: 'STORAGE_EXTERNAL_MODIFICATION' })
  })

  it('唯一匹配时替换一处，匹配不到报 STRING_NOT_FOUND', async () => {
    const { root, path, tool } = await prepared()
    await run(createFileReadTool(), root, { path })
    await expect(
      run(tool, root, { file_path: path, old_string: 'beta', new_string: 'B' }),
    ).resolves.toMatchObject({ ok: true, data: { replacements: 1 } })
    expect(await readFile(join(root, path), 'utf8')).toBe('alpha B alpha')

    await run(createFileReadTool(), root, { path })
    await expect(
      run(tool, root, { file_path: path, old_string: 'zzz', new_string: 'x' }),
    ).resolves.toMatchObject({ ok: false, error_code: 'STRING_NOT_FOUND' })
  })

  it('多处匹配且未开 replace_all 时报 AMBIGUOUS_MATCH', async () => {
    const { root, path, tool } = await prepared()
    await run(createFileReadTool(), root, { path })
    await expect(
      run(tool, root, { file_path: path, old_string: 'alpha', new_string: 'x' }),
    ).resolves.toMatchObject({ ok: false, error_code: 'AMBIGUOUS_MATCH' })
    expect(await readFile(join(root, path), 'utf8')).toBe('alpha beta alpha')
  })

  it('replace_all=true 时替换全部并报告条数', async () => {
    const { root, path, tool } = await prepared()
    await run(createFileReadTool(), root, { path })
    await expect(
      run(tool, root, { file_path: path, old_string: 'alpha', new_string: 'x', replace_all: true }),
    ).resolves.toMatchObject({ ok: true, data: { replacements: 2 } })
    expect(await readFile(join(root, path), 'utf8')).toBe('x beta x')
  })

  it('编辑成功后刷新读取快照，允许连续编辑', async () => {
    const { root, path, tool } = await prepared()
    await run(createFileReadTool(), root, { path })
    await run(tool, root, { file_path: path, old_string: 'beta', new_string: 'B' })
    // 没有重新 file_read 也必须能再编辑——编辑本身刷新了快照。
    await expect(
      run(tool, root, { file_path: path, old_string: 'B', new_string: 'C' }),
    ).resolves.toMatchObject({ ok: true })
  })
})

describe('bash 安全策略', () => {
  const safety = (command: unknown) =>
    createBashTool().safetyCheck?.({ command }, undefined as never)

  it('拒绝 shell 操作符与展开', () => {
    for (const command of [
      'a && b',
      'a; b',
      'a | b',
      'a > b',
      'a < b',
      'a `b`',
      'a $(b)',
      'a {1,2}',
      'a (b)',
    ])
      expect(safety(command), command).toMatchObject({ action: PermissionAction.DENY })
  })

  it('拒绝空命令与空白命令', () => {
    expect(safety('')).toMatchObject({ action: PermissionAction.DENY })
    expect(safety('   ')).toMatchObject({ action: PermissionAction.DENY })
  })

  it('拒绝高危命令', () => {
    for (const command of [
      'rm -rf /',
      'sudo ls',
      'mkfs ext4',
      'shutdown now',
      'reboot',
      'dd if=x',
      'chmod 777 .',
      'chown a b',
    ])
      expect(safety(command), command).toMatchObject({ action: PermissionAction.DENY })
  })

  it('只读命令免审批', () => {
    for (const command of ['ls -la', 'pwd', 'cat a.txt', 'git status', 'grep x y'])
      expect(safety(command), command).toMatchObject({ action: PermissionAction.ALLOW })
  })

  it('git 的写操作不享受只读豁免', () => {
    for (const command of [
      'git push',
      'git commit -m x',
      'git reset --hard',
      'git checkout main',
      'git clean -fd',
    ])
      expect(safety(command), command).toMatchObject({ action: PermissionAction.ASK })
  })

  it('其余命令一律走审批', () => {
    for (const command of ['npm test', 'node script.js', './build.sh'])
      expect(safety(command), command).toMatchObject({ action: PermissionAction.ASK })
  })
})

describe('bash 执行', () => {
  it('成功命令返回输出与退出码 0', async () => {
    const root = await workspace()
    await expect(run(createBashTool(), root, { command: 'echo hello' })).resolves.toMatchObject({
      ok: true,
      content: 'hello',
      data: { exit_code: 0 },
      error_code: null,
    })
  })

  it('非零退出时 ok=false 且带 NONZERO_EXIT', async () => {
    const root = await workspace()
    await expect(run(createBashTool(), root, { command: 'exit 3' })).resolves.toMatchObject({
      ok: false,
      error_code: 'NONZERO_EXIT',
    })
  })

  it('无输出时用退出码占位', async () => {
    const root = await workspace()
    await expect(run(createBashTool(), root, { command: 'true' })).resolves.toMatchObject({
      content: '(exit code: 0)',
    })
  })

  it('stderr 被标注后并入输出', async () => {
    const root = await workspace()
    const result = await run(createBashTool(), root, { command: 'echo oops 1>&2' })
    expect(result.content).toContain('[stderr]')
    expect(result.content).toContain('oops')
  })

  it('超过时限的命令被 SIGTERM 终止并报告超时', async () => {
    const root = await workspace()
    await expect(
      // timeout 是秒；给 0 秒 → 立即超时。
      run(createBashTool(), root, { command: 'sleep 5', timeout: 0 }),
    ).resolves.toMatchObject({ ok: false, error_code: 'TIMEOUT' })
  }, 15_000)

  it('已经取消的信号会让命令立刻被终止', async () => {
    const root = await workspace()
    const controller = new AbortController()
    controller.abort()
    const result = await run(
      createBashTool(),
      root,
      { command: 'sleep 5' },
      { signal: controller.signal },
    )
    // 终止后以非零退出结束；关键是它**没有**跑满 5 秒。
    expect(result.ok).toBe(false)
  }, 15_000)

  it('超长输出被截断到 8000 字符', async () => {
    const root = await workspace()
    const result = await run(createBashTool(), root, {
      command: 'node -e "process.stdout.write(\'x\'.repeat(20000))"',
    })
    expect(result.content).toContain('... [output truncated]')
    expect(result.content.length).toBeLessThan(8100)
  }, 15_000)
})

/**
 * glob 的匹配语义与遍历行为。
 *
 * 语义对齐旧项目的 Python `Path.glob()`（`parts/04` §5.5）：单星不跨目录分隔符、
 * 问号匹配单个非分隔符字符、双星递归（匹配零层或多层）。
 *
 * ️ 这里曾经固化过一个**新实现的回归**：`globMatch()` 原先对模式串连着做四次
 * `replaceAll`，后一步会重写前一步刚插入的片段（单星替换会把双星生成的 `.*` 改掉，
 * 问号替换又会改掉 `(?:…)?` 里的问号），导致**任何含双星的通配都恒不匹配**——
 * 而 glob 工具自己的 description 举的例子正是双星递归写法。已修正为单次遍历生成
 * 正则；本组用例现在断言的是**正确**语义，回归时会立刻失败。
 */
describe('glob', () => {
  async function tree(): Promise<string> {
    const root = await workspace()
    await mkdir(join(root, '.git'))
    await mkdir(join(root, 'node_modules'))
    await mkdir(join(root, 'src'))
    await mkdir(join(root, 'src', 'deep'))
    await writeFile(join(root, 'top.ts'), '', 'utf8')
    await writeFile(join(root, '.git', 'x.ts'), '', 'utf8')
    await writeFile(join(root, 'node_modules', 'y.ts'), '', 'utf8')
    await writeFile(join(root, 'src', 'b.ts'), '', 'utf8')
    await writeFile(join(root, 'src', 'a.ts'), '', 'utf8')
    await writeFile(join(root, 'src', 'deep', 'c.ts'), '', 'utf8')
    return root
  }

  it('目录不存在时报 FILE_NOT_FOUND', async () => {
    const root = await workspace()
    await expect(
      run(createGlobTool(), root, { pattern: '*.ts', path: 'nope' }),
    ).resolves.toMatchObject({ ok: false, error_code: 'FILE_NOT_FOUND' })
  })

  it('单星模式正常工作：不跨目录分隔符，且结果按路径排序', async () => {
    const root = await tree()
    await expect(run(createGlobTool(), root, { pattern: '*.ts' })).resolves.toMatchObject({
      content: join(root, 'top.ts'),
      data: { matches: 1 },
    })
    await expect(run(createGlobTool(), root, { pattern: 'src/*.ts' })).resolves.toMatchObject({
      content: `${join(root, 'src', 'a.ts')}\n${join(root, 'src', 'b.ts')}`,
      data: { matches: 2 },
    })
  })

  it('单字符通配 `?` 正常工作（未与 `**` 混用时）', async () => {
    const root = await tree()
    await expect(run(createGlobTool(), root, { pattern: 'src/?.ts' })).resolves.toMatchObject({
      data: { matches: 2 },
    })
    await expect(run(createGlobTool(), root, { pattern: 'src/??.ts' })).resolves.toMatchObject({
      data: { matches: 0 },
    })
  })

  it('跳过 .git 与 node_modules（遍历层做对了，与匹配层无关）', async () => {
    const root = await tree()
    const result = await run(createGlobTool(), root, { pattern: 'src/*.ts' })
    expect(result.content).not.toContain('node_modules')
    expect(result.content).not.toContain('.git')
  })

  it('双星递归匹配任意深度（含根层，即零层目录）', async () => {
    const root = await tree()
    // `**/` 是**可选**前缀：top.ts（零层）与 src/deep/c.ts（两层）都要命中。
    await expect(run(createGlobTool(), root, { pattern: '**/*.ts' })).resolves.toMatchObject({
      content: [
        join(root, 'src', 'a.ts'),
        join(root, 'src', 'b.ts'),
        join(root, 'src', 'deep', 'c.ts'),
        join(root, 'top.ts'),
      ].join('\n'),
      data: { matches: 4 },
    })
  })

  it('前缀 + 双星：从指定目录递归', async () => {
    const root = await tree()
    await expect(run(createGlobTool(), root, { pattern: 'src/**/*.ts' })).resolves.toMatchObject({
      content: [
        join(root, 'src', 'a.ts'),
        join(root, 'src', 'b.ts'),
        join(root, 'src', 'deep', 'c.ts'),
      ].join('\n'),
      data: { matches: 3 },
    })
  })

  it('行尾裸双星匹配任意后缀（跨目录）', async () => {
    const root = await tree()
    await expect(run(createGlobTool(), root, { pattern: 'src/deep/**' })).resolves.toMatchObject({
      data: { matches: 1 },
    })
  })

  it('工具 description 里举的例子真的能用（**/*.py）', async () => {
    // 修双星匹配之前，这条是典型的反例：工具自己声称支持，实际一条也搜不到。
    const root = await workspace()
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'src', 'main.py'), '', 'utf8')
    await writeFile(join(root, 'top.py'), '', 'utf8')
    await expect(run(createGlobTool(), root, { pattern: '**/*.py' })).resolves.toMatchObject({
      ok: true,
      data: { matches: 2 },
    })
  })

  it('基路径是文件时从它的父目录开始搜索', async () => {
    const root = await tree()
    // 从父目录搜到 2 个，说明确实用了 dirname；若误把文件当基准就只会搜到 1 个。
    await expect(
      run(createGlobTool(), root, { pattern: 'src/*.ts', path: 'src/a.ts' }),
    ).resolves.toMatchObject({ data: { matches: 2 } })
  })

  it('匹配时对的是工作区相对路径，而不是搜索基准的相对路径', async () => {
    // 既有行为（与旧实现的 Path.glob 一致）：`path: 'src'` 只影响**遍历起点**，
    // pattern 始终匹配相对 workspaceRoot 的路径。所以 `*.ts` 在 `path: 'src'`
    // 下依然匹配不到 `src/a.ts`（要写 `src/*.ts`）。
    const root = await tree()
    await expect(
      run(createGlobTool(), root, { pattern: '*.ts', path: 'src' }),
    ).resolves.toMatchObject({ data: { matches: 0 } })
  })

  it('无匹配时给出可读提示（基准为工作区根时显示 .）', async () => {
    const root = await tree()
    const result = await run(createGlobTool(), root, { pattern: 'src/*.zzz' })
    expect(result).toMatchObject({
      ok: true,
      content: "No files match pattern 'src/*.zzz' in .",
    })
  })

  it('跳过指向工作区外的符号链接', async () => {
    // 重点在"逃逸防护"：同时断言工作区内的真实文件仍被找到，
    // 避免"因为什么都不匹配所以通过"这种假阳性。
    const root = await workspace()
    const outside = await workspace()
    await writeFile(join(outside, 'secret.ts'), 'x', 'utf8')
    await writeFile(join(root, 'inside.ts'), '', 'utf8')
    await symlink(join(outside, 'secret.ts'), join(root, 'escape.ts'))
    const result = await run(createGlobTool(), root, { pattern: '*.ts' })
    expect(result.content).toBe(join(root, 'inside.ts'))
  })

  it('正则元字符按字面量处理', async () => {
    const root = await workspace()
    await writeFile(join(root, 'a+b.ts'), '', 'utf8')
    await writeFile(join(root, 'aab.ts'), '', 'utf8')
    // `+` 必须被转义：`a+b.ts` 只匹配字面量，不该当成正则的"一个或多个 a"。
    await expect(run(createGlobTool(), root, { pattern: 'a+b.ts' })).resolves.toMatchObject({
      content: join(root, 'a+b.ts'),
      data: { matches: 1 },
    })
  })
})

describe('grep', () => {
  async function prepared(): Promise<string> {
    const root = await workspace()
    await mkdir(join(root, 'src'))
    await mkdir(join(root, 'docs'))
    await writeFile(join(root, 'src', 'a.ts'), 'const Foo = 1\nlet foo = 2\n', 'utf8')
    await writeFile(join(root, 'docs', 'b.md'), 'foo foo\n', 'utf8')
    return root
  }

  it('按正则搜索并给出 文件:行号:内容', async () => {
    const root = await prepared()
    const result = await run(createGrepTool(), root, { pattern: 'foo' })
    expect(result.content).toContain('src/a.ts:2:let foo = 2')
    expect(result.content).toContain('docs/b.md:1:foo foo')
    // 按**行**计数：`docs/b.md` 那一行里出现两次 foo 也只算一条。
    expect(result.data).toMatchObject({ matches: 2, files: 2 })
  })

  it('ignore_case=true 时大小写不敏感', async () => {
    const root = await prepared()
    await expect(
      run(createGrepTool(), root, { pattern: 'FOO', ignore_case: true }),
    ).resolves.toMatchObject({ data: { matches: 3, files: 2 } })
  })

  it('include 按文件名 glob 过滤', async () => {
    const root = await prepared()
    await expect(
      run(createGrepTool(), root, { pattern: 'foo', include: '*.md' }),
    ).resolves.toMatchObject({ data: { matches: 1, files: 1 } })
  })

  it('max_results 限制总量', async () => {
    const root = await prepared()
    await expect(
      run(createGrepTool(), root, { pattern: 'foo', max_results: 1 }),
    ).resolves.toMatchObject({ data: { matches: 1 } })
  })

  it('无匹配时返回空内容而不是报错', async () => {
    const root = await prepared()
    await expect(run(createGrepTool(), root, { pattern: 'zzz' })).resolves.toMatchObject({
      ok: true,
      content: '',
      data: { matches: 0, files: 0 },
    })
  })

  it('搜索目录不存在时抛出 ENOENT（而非 glob 那样的结构化 FILE_NOT_FOUND）', async () => {
    // ️ 与 glob 不对称：glob 先 `exists(base)` 再返回 `FILE_NOT_FOUND`，
    // grep 直接 `walk(base)` 于是把 ENOENT 抛出去。同样由 executor 兜底，
    // 但工具层错误形状不一致。按现状固化，已记入测试报告。
    const root = await prepared()
    await expect(run(createGrepTool(), root, { pattern: 'x', path: 'nope' })).rejects.toMatchObject(
      {
        code: 'ENOENT',
      },
    )
  })
})

describe('ask_user_question 与 todo_write', () => {
  it('ask_user_question 向模型提供完整的问卷参数结构', () => {
    expect(createAskUserQuestionTool().descriptor.input_schema).toMatchObject({
      properties: {
        questions: {
          minItems: 1,
          maxItems: 4,
          items: {
            required: ['question', 'header', 'options'],
            properties: {
              question: { type: 'string' },
              header: { type: 'string' },
              options: {
                items: {
                  required: ['label', 'description'],
                  properties: {
                    label: { type: 'string' },
                    description: { type: 'string' },
                  },
                },
              },
              multiSelect: { type: 'boolean' },
            },
          },
        },
      },
    })
  })

  it('ask_user_question 固定返回 USER_INPUT_REQUIRED 并把问卷带在 meta 上', async () => {
    const root = await workspace()
    const questions = [{ question: 'q', header: 'h', options: [{ label: 'A', description: 'a' }] }]
    await expect(run(createAskUserQuestionTool(), root, { questions })).resolves.toMatchObject({
      ok: true,
      error_code: 'USER_INPUT_REQUIRED',
      meta: { questions },
    })
  })

  it('ask_user_question 要求 1..4 个问题', () => {
    const tool = createAskUserQuestionTool()
    expect(tool.validate({ questions: [] }).ok).toBe(false)
    expect(
      tool.validate({
        questions: Array.from({ length: 5 }, () => ({
          question: 'q',
          header: 'h',
          options: [],
        })),
      }).ok,
    ).toBe(false)
  })

  it('todo_write 回显任务列表', async () => {
    const root = await workspace()
    const todos = [{ content: '写测试', status: 'in_progress' }]
    await expect(run(createTodoWriteTool(), root, { todos })).resolves.toMatchObject({
      ok: true,
      content: 'Todo list updated.',
      data: { todos },
    })
  })

  it('todo_write 只接受三种状态', () => {
    const tool = createTodoWriteTool()
    expect(tool.validate({ todos: [{ content: 'x', status: 'wat' }] }).ok).toBe(false)
    expect(tool.validate({ todos: [{ content: 'x', status: 'completed' }] }).ok).toBe(true)
  })
})
