/**
 * 校验 `static/styles.css` 与 `styles/input.css` 一致。
 *
 * ## 为什么不是"编译后看 git 有没有差异"
 *
 * 那样做会**改动工作区**，于是"检查"这个动作本身产生了待提交的变更；
 * 在 `pnpm check` 里跑就意味着每次检查都留下一个脏文件。这里改成编译到临时
 * 目录再逐字节比对：只读、可重复、失败时能直接指出"你改了 input.css 但没重新编译"。
 *
 * ## 为什么这个检查必须存在
 *
 * 编译产物入库（CSP 的 `style-src 'self'` 不允许运行时生成样式），而入库的
 * 产物**不会自己更新**。少一次 `pnpm css:build` 的结果是：新加的类在页面上
 * 静默失效——没有报错、没有 404，只是那几个元素没样式。这类问题靠肉眼很难发现。
 */

import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const input = join(root, 'src', 'clients', 'web', 'styles', 'input.css')
const committed = join(root, 'src', 'clients', 'web', 'static', 'styles.css')

const tempDir = await mkdtemp(join(tmpdir(), 'deepcode-css-'))
const output = join(tempDir, 'styles.css')

try {
  await run('npx', ['@tailwindcss/cli', '-i', input, '-o', output, '--minify'], {
    cwd: root,
  })

  const [expected, actual] = await Promise.all([
    readFile(output, 'utf8'),
    readFile(committed, 'utf8').catch(() => ''),
  ])

  if (actual === '') {
    process.stderr.write(
      '[css:check] 缺少编译产物 src/clients/web/static/styles.css；请运行 `pnpm css:build`\n',
    )
    process.exitCode = 1
  } else if (expected !== actual) {
    process.stderr.write(
      '[css:check] static/styles.css 与 styles/input.css 不一致（改了 CSS 类但没重新编译？）\n' +
        '[css:check] 请运行 `pnpm css:build` 并把产物一并提交\n',
    )
    process.exitCode = 1
  } else {
    process.stdout.write('[css:check] 静态样式与源文件一致\n')
  }
} finally {
  await rm(tempDir, { recursive: true, force: true })
}
