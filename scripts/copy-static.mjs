/**
 * 把 Web 静态资源从 `src/` 复制到 `dist/`。
 *
 * ## 为什么需要它
 *
 * `tsc` 只处理 `.ts`，不会把 `index.html` / `app.js` / `styles.css` 带进 `dist/`。
 * 缺了这一步，`node dist/cli.js --web-ui` 会正常启动、`/api/health` 也正常，
 * 只有 `GET /` 会 404——一个在部署后才暴露、且症状与配置无关的故障。
 *
 * 静态目录的解析逻辑（`resolveStaticDir`）会在 `dist` 下找不到 `static/` 时
 * 回落到源码树，所以本地调试不受影响；但**发布产物必须自带资源**，
 * 不能依赖源码树还在。
 */

import { cp, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const from = join(root, 'src', 'clients', 'web', 'static')
const to = join(root, 'dist', 'clients', 'web', 'static')

await mkdir(dirname(to), { recursive: true })
await cp(from, to, { recursive: true })
process.stdout.write(`[copy-static] ${from} → ${to}\n`)
