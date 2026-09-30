#!/usr/bin/env node

/**
 * DeepCode 的正式命令行入口。
 *
 * `scripts/dev-cli.ts` 仍然保留为 `pnpm dev` 的开发包装，但真正的构建产物也
 * 必须能直接启动 `agent [options] --web-ui`。参数解析放在 `src/` 而不是脚本里，
 * 这样发布后的 `dist/cli.js`、开发入口和测试使用的是同一份契约。
 */

import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

import { AgentApplication, describeStartupFailure } from './app/agent-application.js'
import { runTui } from './clients/tui/run.js'
import { isStartupFailure, startWebServer } from './clients/web/server.js'
import {
  AUTH_MODES,
  LISTEN_SCOPES,
  type AuthMode,
  type ListenScope,
} from './clients/web/listen-policy.js'
import { AgentError, ErrorCode } from './core/errors.js'

const EXIT_OK = 0
const EXIT_FAILURE = 1
const EXIT_USAGE = 2

export const CLI_USAGE =
  `用法：agent [--web-ui] [--port <0-65535>] [--listen <${LISTEN_SCOPES.join('|')}>]` +
  ` [--host <address>] [--auth <${AUTH_MODES.join('|')}>]` +
  ' [--token <value>] [--cors <origin[,origin...]>]\n'

/** 已解析的命令行参数。 */
export interface ParsedCliArgs {
  readonly webUi: boolean
  readonly port?: number
  readonly portExplicit: boolean
  readonly listen?: ListenScope
  readonly host?: string
  readonly auth?: AuthMode
  readonly token?: string
  readonly cors?: string
}

function invalidArgument(message: string): AgentError {
  return new AgentError({ code: ErrorCode.INVALID_COMMAND_ARGUMENTS, message, source: 'cli' })
}

/**
 * 解析一个带值的选项。
 *
 * 同时支持 `--flag value` 与 `--flag=value`，但拒绝空值和把下一个选项误当成值。
 * 这让 shell 脚本可以稳定地区分「少写一个参数」和「参数值不合法」。
 */
function optionValue(
  args: readonly string[],
  index: number,
  flag: string,
  inline: string | undefined,
): { readonly value: string; readonly nextIndex: number } {
  const value = inline ?? args[index + 1]
  if (value === undefined || value === '' || (inline === undefined && value.startsWith('--')))
    throw invalidArgument(`${flag} 缺少取值`)
  return { value, nextIndex: inline === undefined ? index + 1 : index }
}

function parsePort(value: string): number {
  if (!/^\d+$/.test(value)) throw invalidArgument(`--port 需要 0-65535 的整数，收到：${value}`)
  const port = Number(value)
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535)
    throw invalidArgument(`--port 需要 0-65535 的整数，收到：${value}`)
  return port
}

/** 解析入口参数；不做任何 IO。 */
export function parseCliArgs(args: readonly string[]): ParsedCliArgs | { readonly help: true } {
  let webUi = false
  let help = false
  let port: number | undefined
  let portExplicit = false
  let listen: ListenScope | undefined
  let host: string | undefined
  let auth: AuthMode | undefined
  let token: string | undefined
  let cors: string | undefined
  const seen = new Set<string>()

  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index]
    if (raw === undefined || raw === '') continue
    if (raw === '--help' || raw === '-h') {
      help = true
      continue
    }
    if (raw === '--web-ui') {
      webUi = true
      continue
    }
    if (!raw.startsWith('--')) throw invalidArgument(`未知参数：${raw}`)

    const equals = raw.indexOf('=')
    const flag = equals === -1 ? raw : raw.slice(0, equals)
    const inline = equals === -1 ? undefined : raw.slice(equals + 1)
    if (seen.has(flag)) throw invalidArgument(`${flag} 只能指定一次`)
    seen.add(flag)

    switch (flag) {
      case '--port': {
        const parsed = optionValue(args, index, flag, inline)
        port = parsePort(parsed.value)
        portExplicit = true
        index = parsed.nextIndex
        break
      }
      case '--listen': {
        const parsed = optionValue(args, index, flag, inline)
        if (!LISTEN_SCOPES.includes(parsed.value as ListenScope))
          throw invalidArgument(`--listen 需要 ${LISTEN_SCOPES.join('|')}，收到：${parsed.value}`)
        listen = parsed.value as ListenScope
        index = parsed.nextIndex
        break
      }
      case '--host': {
        const parsed = optionValue(args, index, flag, inline)
        host = parsed.value
        index = parsed.nextIndex
        break
      }
      case '--auth': {
        const parsed = optionValue(args, index, flag, inline)
        if (!AUTH_MODES.includes(parsed.value as AuthMode))
          throw invalidArgument(`--auth 需要 ${AUTH_MODES.join('|')}，收到：${parsed.value}`)
        auth = parsed.value as AuthMode
        index = parsed.nextIndex
        break
      }
      case '--token': {
        const parsed = optionValue(args, index, flag, inline)
        token = parsed.value
        index = parsed.nextIndex
        break
      }
      case '--cors': {
        const parsed = optionValue(args, index, flag, inline)
        cors = parsed.value
        index = parsed.nextIndex
        break
      }
      default:
        throw invalidArgument(`未知参数：${flag}`)
    }
  }

  if (help) return { help: true }
  if (
    !webUi &&
    (portExplicit ||
      listen !== undefined ||
      host !== undefined ||
      auth !== undefined ||
      token !== undefined ||
      cors !== undefined)
  )
    throw invalidArgument('Web UI 参数必须与 --web-ui 一起使用')

  return {
    webUi,
    ...(port === undefined ? {} : { port }),
    portExplicit,
    ...(listen === undefined ? {} : { listen }),
    ...(host === undefined ? {} : { host }),
    ...(auth === undefined ? {} : { auth }),
    ...(token === undefined ? {} : { token }),
    ...(cors === undefined ? {} : { cors }),
  }
}

/** 启动 Web UI 并等待 SIGINT/SIGTERM。 */
async function runWebUi(options: ParsedCliArgs): Promise<number> {
  const app = await AgentApplication.create()
  let started: Awaited<ReturnType<typeof startWebServer>>
  try {
    started = await startWebServer({
      app,
      ...(options.port === undefined ? {} : { port: options.port }),
      portExplicit: options.portExplicit,
      ...(options.listen === undefined ? {} : { listen: options.listen }),
      ...(options.host === undefined ? {} : { host: options.host }),
      ...(options.auth === undefined ? {} : { auth: options.auth }),
      ...(options.token === undefined ? {} : { token: options.token }),
      ...(options.cors === undefined ? {} : { cors: options.cors }),
    })
  } catch (error) {
    await app.shutdown()
    throw error
  }

  if (isStartupFailure(started)) {
    await app.shutdown()
    process.stderr.write(`启动失败 [${started.code}]：${started.reason}\n`)
    return EXIT_FAILURE
  }

  const server = started.server
  await new Promise<void>((resolveWait) => {
    let stopped = false
    const stop = (): void => {
      if (stopped) return
      stopped = true
      void server
        .close()
        .then((report) => {
          process.stderr.write(
            `[cli] 已关闭：取消 ${String(report.cancelledTurns)} 个 turn，` +
              `拒绝 ${String(report.refusedRequests)} 个请求，耗时 ${String(report.durationMs)}ms\n`,
          )
        })
        .catch((error: unknown) => {
          process.stderr.write(`[cli] 关闭时出错：${String(error)}\n`)
        })
        .finally(resolveWait)
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
  return EXIT_OK
}

/** 运行一次 CLI；导出该函数便于宿主和测试复用同一入口。 */
export async function runCli(args: readonly string[]): Promise<number> {
  let parsed: ParsedCliArgs | { readonly help: true }
  try {
    parsed = parseCliArgs(args)
  } catch (error) {
    const failure = describeStartupFailure(error)
    process.stderr.write(`参数错误：${failure.message}\n${CLI_USAGE}`)
    return EXIT_USAGE
  }
  if ('help' in parsed) {
    process.stdout.write(CLI_USAGE)
    return EXIT_OK
  }
  if (parsed.webUi) {
    try {
      return await runWebUi(parsed)
    } catch (error) {
      const failure = describeStartupFailure(error)
      process.stderr.write(`启动失败 [${failure.code}]：${failure.message}\n`)
      return EXIT_FAILURE
    }
  }

  if (process.stdout.isTTY !== true) {
    process.stderr.write('TUI 需要一个交互式终端；请在集成终端里启动，或改用 --web-ui。\n')
    return EXIT_FAILURE
  }
  await runTui()
  return EXIT_OK
}

function isMainModule(): boolean {
  const entry = process.argv[1]
  return entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href
}

if (isMainModule()) process.exitCode = await runCli(process.argv.slice(2))
