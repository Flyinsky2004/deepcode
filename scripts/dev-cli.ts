/**
 * `pnpm dev` 的开发包装。
 *
 * 参数解析和生命周期都在正式的 `src/cli.ts` 中，避免开发入口与构建产物的
 * `agent` 命令出现两套行为。`tsx` 只负责直接执行 TypeScript 源码。
 */

import { runCli } from '../src/cli.js'

try {
  process.exitCode = await runCli(process.argv.slice(2))
} catch (error) {
  process.stderr.write(`启动失败：${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
