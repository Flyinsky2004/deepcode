/**
 * TUI 入口：装配 → 渲染 → 优雅关闭。
 *
 * 对应旧实现的 `run()`（`app.py:2433-2435`）与 `__main__.py`。区别是装配顺序
 * 反了过来：旧实现是"App 在 `compose()` 里边构造引擎"（`compose()` 有 4 个
 * 副作用），本实现先把组合根建好再交给视图——这样视图失败时不会留下半个
 * 初始化过的应用，也符合 `parts/09` §1.2 "监听绑定必须排在成功装配之后"。
 */

import { render } from 'ink'

import { AgentApplication, describeStartupFailure } from '../../app/agent-application.js'
import { CommandHostAdapter } from '../../app/command-host.js'
import { createBuiltinCommandRegistry } from '../../commands/index.js'
import type { CommandRegistry } from '../../commands/registry.js'

import { TuiApp } from './app.js'
import { TuiController } from './controller.js'

/** 装配 TUI 所需的全部部件。 */
export interface TuiRuntime {
  readonly app: AgentApplication
  readonly registry: CommandRegistry
  readonly host: CommandHostAdapter
  readonly controller: TuiController
}

/**
 * 构造控制器（不起渲染器）。
 *
 * 拆出来是为了让测试能直接驱动控制器——绝大多数断言不需要终端。
 */
export async function createTuiRuntime(
  options: {
    readonly app?: AgentApplication
  } = {},
): Promise<TuiRuntime> {
  const app = options.app ?? (await AgentApplication.create())
  // 命令层的内置注册表：Web / TUI / CLI **三端共用同一份**
  // （各端各注册一份会立刻产生行为漂移）。
  const registry = createBuiltinCommandRegistry()
  const host = new CommandHostAdapter(app)
  const controller = new TuiController({ app, registry, host })
  return { app, registry, host, controller }
}

/**
 * 启动 TUI。
 *
 * 关闭路径：Ctrl+C / `/quit` → `controller.shutdown()`（取消在飞 turn →
 * 断订阅 → 冲刷事件日志 → `dispose()`）。旧实现把清理只放在 `action_quit`，
 * 异常退出时不会执行（§12.2 最后一项），这里用 `finally` 兜住。
 */
export async function runTui(options: { readonly app?: AgentApplication } = {}): Promise<void> {
  let runtime: TuiRuntime
  try {
    runtime = await createTuiRuntime(options)
  } catch (error) {
    const failure = describeStartupFailure(error)
    process.stderr.write(`启动失败：${failure.message}\n`)
    process.exitCode = 1
    return
  }

  const { controller } = runtime
  const instance = render(<TuiApp controller={controller} />)
  try {
    await instance.waitUntilExit()
  } finally {
    await controller.shutdown()
  }
}
