/**
 * 本地开发的命令行入口。
 *
 * ## 为什么这个文件在 `scripts/` 而不在 `src/`
 *
 * 正式的 `src/cli.ts`（`parts/09` §1.1 的 `agent [options] --web-ui`，
 * 含 `--listen` / `--auth` / `--cors` 全套参数）尚未实现——这里只提供
 * **跑得起来的最小入口**，用于手工功能测试与断点调试。理由：
 *
 * 1. `src/**` 属于构建产物（`tsconfig.build.json` 的 `rootDir` 是 `src`），
 *    放进去就意味着它要一起进 `dist/`、被覆盖率统计、并受"每个模块必须有
 *    同名测试"的约束——它还不配，它只是调试脚手架。
 * 2. 真正的 CLI 需要参数解析、`--listen` 策略前置校验、退出码约定等，
 *    是独立的工作项（`progess.md` Phase 7 的 Web UI 验收项）。等它落地时
 *    这个文件应当被删掉，而不是演化成第二个入口。
 *
 * ## 用法
 *
 * ```bash
 * pnpm dev                 # TUI
 * pnpm dev --web-ui        # Web UI，默认 127.0.0.1:3210 + 自动生成 token
 * pnpm dev --web-ui --port 8080
 * ```
 *
 * 需要 `tsx` 而不是 `node --experimental-strip-types`：TUI 视图层是 `.tsx`，
 * Node 内置的类型剥离只处理 `.ts`，遇到 `.tsx` 会以
 * `Unknown file extension ".tsx"` 直接失败。
 */

import { AgentApplication, describeStartupFailure } from '../src/app/agent-application.js'
import { runTui } from '../src/clients/tui/run.js'
import { isStartupFailure, startWebServer } from '../src/clients/web/server.js'
import { AgentError, ErrorCode } from '../src/core/errors.js'
import {
  AUTH_MODES,
  LISTEN_SCOPES,
  type AuthMode,
  type ListenScope,
} from '../src/clients/web/listen-policy.js'

/** 启动失败。 */
const EXIT_FAILURE = 1
/** 参数用法错误（与启动失败区分，便于脚本分辨"我写错了"和"环境有问题"）。 */
const EXIT_USAGE = 2

const USAGE =
  `用法：pnpm dev [--web-ui] [--port <0-65535>] [--auth <${AUTH_MODES.join('|')}>]` +
  ` [--listen <${LISTEN_SCOPES.join('|')}>]\n`

/**
 * 参数错误抛 `INVALID_COMMAND_ARGUMENTS` 而不是裸 `Error`。
 *
 * 裸 `Error` 会被 `describeStartupFailure` 兜底成 `INTERNAL_ERROR`，于是一个
 * 打错的 `--port` 看起来像内核崩了。错误码表里本来就有这一类。
 */
function invalidArgument(message: string): AgentError {
  return new AgentError({ code: ErrorCode.INVALID_COMMAND_ARGUMENTS, message, source: 'dev-cli' })
}

function parseWebOptions(args: readonly string[]): {
  port?: number
  auth?: AuthMode
  listen?: ListenScope
} {
  const options: { port?: number; auth?: AuthMode; listen?: ListenScope } = {}

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]
    const value = args[index + 1]

    // 缺值（`--port` 后面没东西）与取值非法分开报：前者是少写了，后者是写错了。
    if (flag === '--port') {
      if (value === undefined) throw invalidArgument('--port 缺少取值')
      const port = Number.parseInt(value, 10)
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw invalidArgument(`--port 需要 0-65535 的整数，收到：${value}`)
      }
      options.port = port
      index += 1
    } else if (flag === '--auth') {
      // 合法取值取自 `listen-policy` 的权威常量，不在这里另抄一份。
      // 注意它含 `password`——该模式目前未实现，由 server 启动时以
      // "尚未实现"的明确原因拒绝，而不是在这里静默收窄成 token。
      if (value === undefined) throw invalidArgument('--auth 缺少取值')
      if (!AUTH_MODES.includes(value as AuthMode)) {
        throw invalidArgument(`--auth 需要 ${AUTH_MODES.join('|')}，收到：${value}`)
      }
      options.auth = value as AuthMode
      index += 1
    } else if (flag === '--listen') {
      if (value === undefined) throw invalidArgument('--listen 缺少取值')
      if (!LISTEN_SCOPES.includes(value as ListenScope)) {
        throw invalidArgument(`--listen 需要 ${LISTEN_SCOPES.join('|')}，收到：${value}`)
      }
      options.listen = value as ListenScope
      index += 1
    }
  }

  return options
}

async function runWebUi(args: readonly string[]): Promise<number> {
  let parsed: ReturnType<typeof parseWebOptions>
  try {
    parsed = parseWebOptions(args)
  } catch (error) {
    // 参数错误是**用法问题**，不是启动问题：退出码用 2（与 `EXIT_FAILURE`
    // 的 1 区分开），并附上用法——用户此刻需要的正是"这个参数该怎么写"。
    process.stderr.write(`参数错误：${describeStartupFailure(error).message}\n${USAGE}`)
    return EXIT_USAGE
  }
  const { port, auth, listen } = parsed

  const result = await startWebServer({
    app: await AgentApplication.create(),
    ...(port === undefined ? {} : { port, portExplicit: true }),
    ...(auth === undefined ? {} : { auth }),
    ...(listen === undefined ? {} : { listen }),
  })

  if (isStartupFailure(result)) {
    // 地址不符合 `--listen` 策略、端口被占用、`public` + `--auth none`
    // 都会走到这里。规范要求**直接退出并给出原因**，不降级到更宽松的地址。
    process.stderr.write(`启动失败 [${result.code}]：${result.reason}\n`)
    return EXIT_FAILURE
  }

  // 访问地址与 token 由 server 自己打印（`formatAccessNotice`），此处不重复。
  const server = result.server
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      void server
        .close()
        .then((report) => {
          process.stderr.write(
            `[dev-cli] 已关闭：取消 ${String(report.cancelledTurns)} 个 turn，` +
              `拒绝 ${String(report.refusedRequests)} 个请求，耗时 ${String(report.durationMs)}ms\n`,
          )
          if (report.turnsTimedOut || report.flushTimedOut) {
            process.stderr.write('[dev-cli] ⚠️ 宽限期内未能结束全部 turn 或落盘\n')
          }
        })
        .catch((error: unknown) => {
          process.stderr.write(`[dev-cli] 关闭时出错：${String(error)}\n`)
        })
        .finally(() => {
          resolve()
        })
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })

  return 0
}

async function main(): Promise<number> {
  const args = process.argv.slice(2)

  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(USAGE)
    return 0
  }

  if (args.includes('--web-ui')) return runWebUi(args)

  if (process.stdout.isTTY !== true) {
    process.stderr.write('TUI 需要一个交互式终端；请在集成终端里启动，或改用 --web-ui。\n')
    return EXIT_FAILURE
  }

  await runTui()
  return 0
}

try {
  process.exitCode = await main()
} catch (error) {
  // 组合根装配失败的**已知**成因（配置损坏、密钥缺失、目录不可写……）会走到这里。
  // 打印 `AgentError` 的 message 与 code，而不是把整个堆栈倒给用户。
  const failure = describeStartupFailure(error)
  process.stderr.write(`启动失败 [${failure.code}]：${failure.message}\n`)
  process.exitCode = EXIT_FAILURE
}
