/**
 * 取消的竞态窗口回归测试。
 *
 * `submitTurn` 是 async：调用它会同步执行到第一个 `await` 为止。在这之前
 * 必须已经登记好 abort controller，否则存在一个窗口——`isBusy()` 已为真，
 * 但 `cancelTurn()` 找不到 controller，于是**静默返回 false**：用户点了取消、
 * 界面显示正在取消、实际什么也没发生。
 *
 * 这类缺陷只在"提交后立刻取消"时出现，人工点按几乎撞不上，但三端
 * （TUI / Web / CLI）走的是同一条路径，所以必须有测试钉住。
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { AgentApplication } from '../../src/app/agent-application.js'
import { ChatStore } from '../../src/storage/chat-store.js'
import { ConfigStore } from '../../src/storage/config-store.js'
import { resolveAppPaths } from '../../src/storage/paths.js'
import { ToolRegistry } from '../../src/tools/registry.js'
import { type Provider } from '../../src/core/provider.js'
import type { ConfigDocument } from '../../src/storage/types.js'
import type { TurnStreamEvent } from '../../src/core/turn.js'

const provider: Provider = {
  id: 'p',
  name: 'test',
  baseUrl: 'https://api.anthropic.com',
  apiKeyRef: { source: 'env', key: 'TEST_KEY' },
  createdAt: '',
  updatedAt: '',
}

const configDoc = (): ConfigDocument => ({
  schema_version: 1,
  llm_channels: [],
  llm_models: [],
  app_settings: {},
  providers: [{ ...provider, enabled: true }],
  model_profiles: [
    {
      id: 'm1',
      providerId: 'p',
      contextWindow: 100_000,
      maxOutputTokens: 4096,
      supportsThinking: false,
      supportsTools: true,
      supportsVision: false,
      supports1MContext: false,
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

/** 永不产出、只在被取消时结束。 */
const hangingFactory = () =>
  ({
    stream: (_req: unknown, signal: AbortSignal) => ({
      usage: { inputTokens: 0, outputTokens: 0 },
      [Symbol.asyncIterator]() {
        return {
          next: (): Promise<IteratorResult<never>> =>
            new Promise((_r, reject) => {
              if (signal.aborted) reject(new Error('aborted'))
              signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
            }),
        }
      },
    }),
    probe: () => Promise.resolve({ ok: true }),
  }) as never

async function build() {
  const dir = await mkdtemp(join(tmpdir(), 'deepcode-cancel-race-'))
  const paths = resolveAppPaths({ home: dir, cwd: dir })
  const configStore = new ConfigStore(paths)
  await configStore.save(configDoc())
  const app = await AgentApplication.create({
    paths,
    workspaceRoot: dir,
    configStore,
    chatStore: new ChatStore(paths),
    registry: new ToolRegistry(),
    providerFactory: hangingFactory,
  })
  return { app }
}

describe('cancelTurn：提交后立刻取消', () => {
  it('不 await 提交就取消，仍然生效', async () => {
    const { app } = await build()
    const session = await app.createSession(app.localPrincipalId)

    // ⚠️ 关键：不 await。`submitTurn` 同步执行到第一个 await 为止，
    // 此刻 `isBusy()` 已为真——这正是曾经的竞态窗口。
    const pending = app.submitTurn({
      principalId: app.localPrincipalId,
      sessionId: session.id,
      prompt: '会挂住',
    })

    expect(app.isBusy(session.id)).toBe(true)
    // 修复前这里是 false：controller 要到 `await getSession()` 之后才登记
    expect(app.cancelTurn(session.id)).toBe(true)

    const settled = await app.awaitTurn(session.id)
    expect(settled?.status).toBe('cancelled')
    await pending
  })

  it('取消确实落地：事件流里能看到 turn_end.cancelled', async () => {
    const { app } = await build()
    const session = await app.createSession(app.localPrincipalId)

    const pending = app.submitTurn({
      principalId: app.localPrincipalId,
      sessionId: session.id,
      prompt: '会挂住',
    })
    app.cancelTurn(session.id)
    await pending
    await app.flush()

    const events = (await app.eventLog.list(session.id)) as unknown as TurnStreamEvent[]
    const end = events.find((e) => e.type === 'turn_end')
    expect(end?.data.cancelled).toBe(true)
  })

  it('对没有在飞 turn 的会话取消返回 false（不误报成功）', async () => {
    const { app } = await build()
    const session = await app.createSession(app.localPrincipalId)
    expect(app.cancelTurn(session.id)).toBe(false)
  })

  it('取消后 turn 结束，会话可以再次提交', async () => {
    const { app } = await build()
    const session = await app.createSession(app.localPrincipalId)

    const pending = app.submitTurn({
      principalId: app.localPrincipalId,
      sessionId: session.id,
      prompt: '第一次',
    })
    app.cancelTurn(session.id)
    await pending

    // 取消后 busy 必须释放，否则用户"取消完就没法再干活"
    expect(app.isBusy(session.id)).toBe(false)
  })
})
