/**
 * Ink 视图层：真渲染 + 假 provider。
 *
 * 用 `ink-testing-library` 的 `render()` / `lastFrame()` / `stdin.write()`，
 * 断言的是**用户真正看到的帧**——布局、文案、按键后的变化。
 *
 * ⚠️ 测试文件必须是 `.test.ts`（`vitest.config.ts` 只认它），因此这里用
 * `React.createElement` 而不是 JSX；组件本身仍是 `.tsx`。
 *
 * ⚠️ 也**不能按 id 定位节点**：Ink 7 的 `Box`/`Text` 没有 `id` 属性
 * （见 `app.tsx` 的说明），所以断言一律基于可见文本——与旧测试不得不遍历
 * `#message-view` 子 widget 的 `._markdown` 是同一类妥协。
 */

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElement } from 'react'
import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'

import { AgentApplication } from '../../src/app/agent-application.js'
import { CommandHostAdapter } from '../../src/app/command-host.js'
import { createBuiltinCommandRegistry } from '../../src/commands/index.js'
import { ModelEventType, type Provider } from '../../src/core/provider.js'
import { ChatStore } from '../../src/storage/chat-store.js'
import { ConfigStore } from '../../src/storage/config-store.js'
import { resolveAppPaths } from '../../src/storage/paths.js'
import { ToolRegistry } from '../../src/tools/registry.js'
import { TuiApp } from '../../src/clients/tui/app.js'
import { TuiController } from '../../src/clients/tui/controller.js'

const PROVIDER: Provider = {
  id: 'p',
  name: 'DeepSeek',
  baseUrl: 'https://api.deepseek.com/anthropic',
  apiKeyRef: { source: 'env', key: 'TEST_KEY' },
  createdAt: '',
  updatedAt: '',
}

async function makeController(options: { readonly hanging?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'deepcode-ink-'))
  const paths = resolveAppPaths({ home: dir, cwd: dir })
  const configStore = new ConfigStore(paths)
  await configStore.save({
    schema_version: 1,
    llm_channels: [],
    llm_models: [],
    app_settings: {},
    providers: [{ ...PROVIDER, enabled: true }],
    model_profiles: [
      {
        id: 'm1',
        providerId: 'p',
        displayName: 'deepseek-v4-pro',
        contextWindow: 1_000_000,
        maxOutputTokens: 128_000,
        supportsThinking: true,
        supportsTools: true,
        supportsVision: false,
        supports1MContext: true,
        thinkingEnabled: true,
        reasoningEffort: 'high',
        inputCostPerMillion: 0.5,
        outputCostPerMillion: 1.5,
        enabled: true,
      },
    ],
    tier_assignments: [
      {
        tier: 'implementation',
        modelRef: { providerId: 'p', modelId: 'm1' },
        enabled: true,
        fallbackModelRefs: [],
      },
    ],
  })

  const factory = options.hanging
    ? () => ({
        stream: (_request: unknown, signal: AbortSignal) => ({
          usage: { inputTokens: 12, outputTokens: 3 },
          async *[Symbol.asyncIterator]() {
            yield { type: ModelEventType.TEXT, content: 'partial answer' } as never
            await new Promise((_resolve, reject) => {
              signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
            })
          },
        }),
        probe: () => Promise.resolve({ ok: true }),
      })
    : () => ({
        stream: () => ({
          usage: { inputTokens: 100, outputTokens: 20 },
          async *[Symbol.asyncIterator]() {
            await Promise.resolve()
            yield { type: ModelEventType.TEXT, content: '最终的' } as never
            yield { type: ModelEventType.TEXT, content: '回答' } as never
          },
        }),
        probe: () => Promise.resolve({ ok: true }),
      })

  // `@` 提及菜单需要一个真实文件才可能出候选（工作区就是临时目录）
  await writeFile(join(dir, 'package.json'), '{}\n')

  const app = await AgentApplication.create({
    paths,
    workspaceRoot: dir,
    configStore,
    chatStore: new ChatStore(paths),
    registry: new ToolRegistry(),
    providerFactory: factory,
  })
  // 三端共用的内置注册表
  const registry = createBuiltinCommandRegistry()
  const controller = new TuiController({
    app,
    registry,
    host: new CommandHostAdapter(app),
  })
  return { app, controller, dir }
}

/** 等到帧里出现某段文本。 */
async function waitForFrame(
  lastFrame: () => string | undefined,
  needle: string,
  timeoutMs = 8_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let frame = ''
  while (Date.now() < deadline) {
    frame = lastFrame() ?? ''
    if (frame.includes(needle)) return frame
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`等待超时：帧里始终没有「${needle}」\n--- 最后一帧 ---\n${frame}`)
}

/**
 * 通过真实按键提交一条消息，并等这一轮结束。
 *
 * 判据是"状态里已有会话 + 非流式 + 帧里出现了助手回答"——不能用
 * `waitForFrame('hi')`：那只说明用户消息渲染了，`turn_end` 可能还没到。
 */
async function submitAndSettle(
  controller: TuiController,
  text: string,
  lastFrame: () => string | undefined,
  timeoutMs = 8_000,
): Promise<void> {
  controller.setInput(text)
  controller.applyKey({ name: 'enter' })
  await waitForFrame(lastFrame, text)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!controller.getState().streaming && controller.getState().messages.length >= 2) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`等待超时：提交 ${text} 后这一轮没有结束\n${lastFrame() ?? ''}`)
}

/**
 * 等一个条件成立。
 *
 * 固定 `setTimeout` 延时在这里是错的：它假设"若干毫秒后副作用一定做完了"，
 * 而那个时长取决于负载（并行跑全仓时文件 I/O 会明显变慢）。不断言的东西
 * 可以不等；要断言的东西就必须等**它本身**。
 */
async function waitForTrue(
  predicate: () => boolean,
  label: string,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`等待超时：${label}`)
}

describe('布局与首屏', () => {
  it('渲染标题、logo、提示、输入框占位与状态栏', async () => {
    const { controller } = await makeController()
    const { lastFrame } = render(createElement(TuiApp, { controller }))

    // 等**状态栏有模型信息**的那一帧：`controller.start()` 是异步的，
    // 用它之前的帧断言会看不到 provider/model（首屏帧里还是"无模型"）。
    const frame = await waitForFrame(lastFrame, 'DeepSeek / deepseek-v4-pro')
    expect(frame).toContain('██████╗') // logo（ANSI Shadow 方块字）
    expect(frame).toContain('DeepCode')
    expect(frame).toContain('Start a project-local conversation from the prompt below.')
    expect(frame).toContain('Ask DeepCode anything, or type / for commands')
    expect(frame).toContain('Message')
    // 状态栏：模型档位 + provider/model + Think/Ctx/Out（Phase 7 验收项）
    expect(frame).toContain('NORMAL')
    expect(frame).toContain('DeepSeek / deepseek-v4-pro')
    expect(frame).toContain('Tier: implementation')
    expect(frame).toContain('Think: ON')
    expect(frame).toContain('Ctx: 1M')
    expect(frame).toContain('Out: 128K')
    expect(frame).toContain('No conversation')
    expect(frame).toContain('ctrl+c Quit')
  })

  it('输入字符实时呈现在输入框', async () => {
    const { controller } = await makeController()
    const { lastFrame, stdin } = render(createElement(TuiApp, { controller }))
    await waitForFrame(lastFrame, 'Message')

    stdin.write('h')
    stdin.write('i')
    const frame = await waitForFrame(lastFrame, '> hi')
    expect(frame).toContain('> hi')
  })

  it('shift+tab 循环模式并刷新状态栏标签', async () => {
    const { controller } = await makeController()
    const { lastFrame, stdin } = render(createElement(TuiApp, { controller }))
    await waitForFrame(lastFrame, 'NORMAL')

    stdin.write('\t') // Ink 把裸 tab 事件交给 useInput；shift 由终端上报
    // 直接驱动控制器，等价于 shift+tab（终端对 shift+tab 的上报因模拟器而异）
    controller.applyKey({ name: 'shift+tab' })
    await waitForFrame(lastFrame, 'AUTO EDIT')
  })
})

describe('提交与流式', () => {
  it('提交后消息区出现用户消息与助手回答', async () => {
    const { controller } = await makeController()
    const { lastFrame, stdin } = render(createElement(TuiApp, { controller }))
    await waitForFrame(lastFrame, 'Message')

    stdin.write('打个招呼')
    stdin.write('\r') // Enter
    await waitForFrame(lastFrame, '打个招呼')
    const frame = await waitForFrame(lastFrame, '最终的')
    expect(frame).toContain('回答')
    // 状态栏出现消息条数与用量记账
    expect(frame).toContain('msgs')
    expect(frame).toContain('↑100 ↓20')
    // 成本：100 * 0.5/1e6 + 20 * 1.5/1e6 ≈ 0.0001
    expect(frame).toContain('$0.0001')
    // 首页让位给消息区
    expect(frame).not.toContain('Start a project-local conversation')
  })

  it('流式中状态栏显示 spinner，Esc 取消后回到正常态', async () => {
    const { controller } = await makeController({ hanging: true })
    const { lastFrame, stdin } = render(createElement(TuiApp, { controller }))
    await waitForFrame(lastFrame, 'Message')

    stdin.write('长任务')
    stdin.write('\r')
    await waitForFrame(lastFrame, 'partial answer')
    const streaming = await waitForFrame(lastFrame, 'Working...')
    expect(streaming).toContain('NORMAL  Working')

    stdin.write('') // Esc
    // 取消后回到非流式：turn_end 到达后状态栏不再有 Working
    // （取消的那一轮 token 为 0，因此状态栏只会显示消息条数）
    const cancelled = await waitForFrame(lastFrame, '1 msgs')
    expect(cancelled).not.toContain('Working...')
  })
})

describe('权限往返（渲染层闭环）', () => {
  async function setupPermission() {
    const { app, controller } = await makeController()
    const { lastFrame, stdin } = render(createElement(TuiApp, { controller }))
    await waitForFrame(lastFrame, 'Message')

    // 等这一轮**真正结束**再发审批请求：`turn_end` 会收起权限对话框
    // （见 events.ts），请求若晚于它到达，断言就看到"刚出现就被收掉"的中间态。
    await submitAndSettle(controller, 'hi', lastFrame)

    const sessionId = controller.getState().sessionId!
    const abort = new AbortController()
    const pending = app.broker!.request(
      {
        request_id: 'req-ui',
        session_id: sessionId,
        turn_id: 'turn-1',
        tool_call_id: 'call-1',
        tool_name: 'file_write',
        args_preview: '{"path":"a.ts"}',
        risk_level: 'critical',
        reason: 'tool requires approval',
        status: 'PENDING_USER_APPROVAL',
        created_at: '2026-09-15T00:00:00.000Z',
        expires_at: Date.now() + 60_000,
        resolved_at: null,
        resolved_by: '',
        resolution: '',
      } as never,
      abort.signal,
    )
    return { app, controller, lastFrame, stdin, pending }
  }

  it('弹窗渲染权限说明、动作项与输入框提示', async () => {
    const { lastFrame, stdin } = await setupPermission()
    const frame = await waitForFrame(lastFrame, 'Permission Required')

    // PERM_TITLE 的五个字段
    expect(frame).toContain('**Tool:** file_write')
    // 4 档风险徽标（ADR 0002 §七）：critical 也能渲染
    expect(frame).toContain('**Risk:** CRITICAL')
    expect(frame).toContain('**Args:** `{"path":"a.ts"}`')
    expect(frame).toContain('**Reason:** tool requires approval')
    // 动作菜单（渲染进 #command-menu）
    expect(frame).toContain('Action required')
    expect(frame).toContain('Approve - allow this tool to execute')
    expect(frame).toContain('Always Allow - auto-approve this command type')
    expect(frame).toContain('Deny - block this tool call')
    expect(frame).toContain('y=approve  a=always allow  n=deny')
    // 输入框切到审批文案
    expect(frame).toContain('Permission required')
    expect(frame).toContain('Press Enter to approve, n to deny')
    void stdin
  })

  it('按 y 批准（弹窗 → 摘要命令已被正文包含）', async () => {
    const { lastFrame, stdin, pending } = await setupPermission()
    await waitForFrame(lastFrame, 'Permission Required')

    stdin.write('y')
    const resolution = await pending
    expect(resolution.decision).toBe('allow')
    expect(resolution.resolvedBy).toBe('user')
    // 决议后弹窗收起
    await waitForFrame(lastFrame, 'Message')
    const frame = lastFrame() ?? ''
    expect(frame).not.toContain('Action required')
  })

  it('按 n 拒绝', async () => {
    const { lastFrame, stdin, pending } = await setupPermission()
    await waitForFrame(lastFrame, 'Permission Required')
    stdin.write('n')
    expect((await pending).decision).toBe('deny')
  })

  it('双击 Esc 拒绝（单次不拒绝）', async () => {
    const { controller, lastFrame, pending } = await setupPermission()
    await waitForFrame(lastFrame, 'Permission Required')

    // 单次 Esc 不拒绝（按键处理是同步的，不需要等）
    controller.applyKey({ name: 'escape' })
    expect(controller.getState().permissionQueue).toHaveLength(1)
    // 第二次（<500ms）才拒绝。
    // 直接驱动控制器而不是 stdin.write：Ink 对孤立 ESC 有转义序列消歧延时，
    // 两次写入的时序不稳；ESC -> KeyInput 的映射由 toKeyInput 单独保证。
    controller.applyKey({ name: 'escape' })
    expect((await pending).decision).toBe('deny')
  })

  it('问卷渲染题目、选项与按键提示', async () => {
    const { app, controller } = await makeController()
    const { lastFrame, stdin } = render(createElement(TuiApp, { controller }))
    await waitForFrame(lastFrame, 'Message')
    // 等这一轮**真正结束**再发审批请求：`turn_end` 会收起权限对话框
    // （见 events.ts），请求若晚于它到达，断言就看到"刚出现就被收掉"的中间态。
    await submitAndSettle(controller, 'hi', lastFrame)

    const sessionId = controller.getState().sessionId!
    const abort = new AbortController()
    const pending = app.userInputBroker!.request(
      {
        request_id: 'q-ui',
        session_id: sessionId,
        turn_id: 'turn-1',
        tool_call_id: 'call-1',
        tool_name: 'ask_user_question',
        questions: [
          {
            question: '选哪个？',
            header: 'Choice',
            options: [
              { label: 'alpha', description: 'first' },
              { label: 'beta', description: 'second' },
            ],
          },
        ],
        created_at: '2026-09-15T00:00:00.000Z',
        expires_at: Date.now() + 60_000,
      } as never,
      abort.signal,
    )

    const frame = await waitForFrame(lastFrame, '[Choice] 选哪个？')
    expect(frame).toContain('(1/1)')
    expect(frame).toContain('(*) alpha — first') // 默认选中第一项
    expect(frame).toContain('( ) beta — second')
    expect(frame).toContain('↑↓=navigate  Enter=select  ←=prev')

    controller.applyKey({ name: 'down' })
    await waitForFrame(lastFrame, '(*) beta — second')

    stdin.write('\r')
    expect((await pending).answers).toEqual([['beta']])
  })
})

describe('命令与面板', () => {
  it('/language zh 切换后整屏重绘为中文（T-6）', async () => {
    const { controller } = await makeController()
    const { lastFrame, stdin } = render(createElement(TuiApp, { controller }))
    await waitForFrame(lastFrame, 'Message')

    stdin.write('/language zh')
    stdin.write('\r')
    const frame = await waitForFrame(lastFrame, '界面语言已切换为 zh')
    // 输入框 label/placeholder 也变成中文（旧实现不会重绘这一点）
    expect(frame).toContain('消息')
    expect(frame).toContain('向 DeepCode 提问，或输入 / 查看命令')
  })

  it('诚实降级：/mcp 显示原因而不是"未知命令"', async () => {
    const { controller } = await makeController()
    const { lastFrame, stdin } = render(createElement(TuiApp, { controller }))
    await waitForFrame(lastFrame, 'Message')

    stdin.write('/mcp')
    stdin.write('\r')
    const frame = await waitForFrame(lastFrame, '## /mcp')
    expect(frame).toContain('MCP')
    expect(frame).toContain('尚未实现')
    expect(frame).not.toContain('Unknown command')
  })

  it('未知命令渲染"未知命令"面板', async () => {
    const { controller } = await makeController()
    const { lastFrame, stdin } = render(createElement(TuiApp, { controller }))
    await waitForFrame(lastFrame, 'Message')

    stdin.write('/nope')
    stdin.write('\r')
    const frame = await waitForFrame(lastFrame, 'Unknown command')
    // 正文是命令层的原文（UI 不重写命令层的文案）
    expect(frame).toContain('未知命令：/nope')
  })

  it('命令菜单随输入弹出（/ 前缀）', async () => {
    const { controller } = await makeController()
    const { lastFrame, stdin } = render(createElement(TuiApp, { controller }))
    await waitForFrame(lastFrame, 'Message')

    stdin.write('/work')
    const frame = await waitForFrame(lastFrame, 'Commands')
    expect(frame).toContain('> 1. /workwith')
    expect(frame).toContain('为下一项任务指定 provider/model')
    expect(frame).toContain('Use ↑/↓ to select, Tab to autocomplete, Enter to open.')
  })

  it('命令菜单列出命令层的全部命令（含诚实降级的那些）', async () => {
    const { controller } = await makeController()
    const { lastFrame, stdin } = render(createElement(TuiApp, { controller }))
    await waitForFrame(lastFrame, 'Message')

    stdin.write('/')
    const frame = await waitForFrame(lastFrame, 'Commands')
    for (const name of ['/workwith', '/sessions', '/clear', '/language', '/mcp', '/skills'])
      expect(frame).toContain(name)
  })

  it('无匹配的命令给出提示', async () => {
    const { controller } = await makeController()
    const { lastFrame, stdin } = render(createElement(TuiApp, { controller }))
    await waitForFrame(lastFrame, 'Message')

    stdin.write('/zz')
    await waitForFrame(lastFrame, 'No matching commands')
  })

  it('@ 提及菜单列出工作区路径', async () => {
    const { controller } = await makeController()
    const { lastFrame, stdin } = render(createElement(TuiApp, { controller }))
    await waitForFrame(lastFrame, 'Message')

    stdin.write('@package')
    const frame = await waitForFrame(lastFrame, 'Workspace paths')
    expect(frame).toContain('package.json')
    expect(frame).toContain('file')
  })
})

describe('退出', () => {
  it('Ctrl+C 触发 onExit', async () => {
    const { controller } = await makeController()
    let exited = false
    const { lastFrame, stdin } = render(
      createElement(TuiApp, {
        controller,
        onExit: () => {
          exited = true
        },
      }),
    )
    await waitForFrame(lastFrame, 'Message')

    // ⚠️ 关于这里为什么要"重投 + 有界等待"，实测结论如下（探针法，共 140 次投递）：
    //
    // - **投递本身是可靠的**：在 `render()` 之后**不等任何帧**立刻写入，
    //   Ctrl+C 40/40 被处理、普通字符 20/20 进入输入框；等到第一帧再写、
    //   或多让一轮事件循环再写，同样 40/40。也就是说"Ink 的 `useInput` 订阅
    //   尚未挂载、按键被丢弃"这个解释**在本环境不成立**（`useInput` 确实在
    //   `useEffect` 里挂监听，见 `ink/build/hooks/use-input.js`，但挂载早于
    //   任何可观察到的写入时机）。
    // - 这条用例此前的真实失败原因是**固定 60ms 延时太短**：全仓并行时按键
    //   的解析与 `onExit` 落地会超过它，于是表现为"单跑绿、全仓红"。
    //
    // 因此重投是**廉价保险**（Ctrl+C 的处理是幂等的：置标志 + `exit()`），
    // 真正提供保证的是下面的 `waitForTrue`——若 `onExit` 真坏了它仍会失败。
    for (let attempt = 0; attempt < 20 && !exited; attempt++) {
      stdin.write('\u0003')
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    // 等它真的生效，而不是假设"若干毫秒之内一定到"。
    await waitForTrue(() => exited, 'Ctrl+C 未触发 onExit')
    expect(exited).toBe(true)
  })

  it('卸载时执行优雅关闭（应用被释放）', async () => {
    const { app, controller } = await makeController()
    const { lastFrame, unmount } = render(createElement(TuiApp, { controller }))
    await waitForFrame(lastFrame, 'Message')

    unmount()
    // 关闭是异步的（取消在飞 turn → flush() → dispose()）：等 `disposed` 本身。
    await waitForTrue(() => app.disposed, '卸载后应用未被释放')
    expect(app.disposed).toBe(true)
  })
})
