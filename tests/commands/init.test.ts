/**
 * `/init` 的转录与行为测试。
 *
 * 分三层：
 *
 * 1. **转录**：断言文本的关键片段与长度特征，确保"逐字转录"这件事没有在
 *    后续重构里被悄悄改写。**不把全文再抄一遍**——那样测试自身就成了第二份
 *    副本，改提示词时两处都要改，反而更容易漂移；全文与旧源码的一致性由
 *    `prompts.ts` 顶部的来源表和一次性核对承担。
 * 2. **命令行为**（纯假 `CommandHost`）：无模型不提交、建会话标题固定
 *    `"/init"`、提交一次、返回 `switch_session`、幂等键去重。
 * 3. **真应用**（`AgentApplication` + `CommandHostAdapter`）：断言**只产生一条
 *    用户消息**。这一条必须用真应用——"有没有重复落盘"取决于 runtime 的
 *    `beginTurn` 与命令层是否各写一次，假 host 无论如何都测不出来。
 */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { AgentApplication } from '../../src/app/agent-application.js'
import { CommandHostAdapter } from '../../src/app/command-host.js'
import { createInitCommand } from '../../src/commands/definitions/init.js'
import { INIT_PANEL, INIT_PROMPT, INIT_SESSION_TITLE } from '../../src/commands/prompts.js'
import { CommandRegistry } from '../../src/commands/registry.js'
import {
  CommandResultCode,
  type CommandConfigView,
  type CommandHost,
} from '../../src/commands/types.js'
import { ErrorCode } from '../../src/core/errors.js'
import type { PrincipalId, SessionId, TurnId } from '../../src/core/ids.js'
import { MessageSubtype, type Message } from '../../src/core/models.js'
import { ModelTier } from '../../src/core/provider.js'
import type { ModelEventType } from '../../src/core/provider.js'
import { ChatStore } from '../../src/storage/chat-store.js'
import { ConfigStore } from '../../src/storage/config-store.js'
import { resolveAppPaths } from '../../src/storage/paths.js'
import type { ConfigDocument } from '../../src/storage/types.js'

const LOCAL = 'local' as PrincipalId
const SESSION = 's1' as SessionId

/** 带主模型的配置（`implementation` 档位绑定到一个启用中的 provider/model）。 */
const config = (over: Partial<CommandConfigView> = {}): CommandConfigView => ({
  providers: [{ id: 'p', name: 'P', enabled: true, hasSecret: true }],
  models: [
    {
      id: 'm1',
      providerId: 'p',
      displayName: 'm1',
      enabled: true,
      supportsTools: true,
      supportsThinking: false,
      supports1MContext: false,
      contextWindow: 100_000,
      maxOutputTokens: 4096,
    },
  ],
  tiers: [{ tier: ModelTier.IMPLEMENTATION, providerId: 'p', modelId: 'm1', enabled: true }],
  settings: {},
  raw: {},
  ...over,
})

/** 记录副作用的假 host。 */
class FakeHost implements CommandHost {
  readonly localPrincipalId = LOCAL
  readonly created: (string | undefined)[] = []
  readonly submitted: { sessionId: SessionId; prompt: string }[] = []
  readonly idempotency = new Map<string, { requestHash: string; response: unknown }>()
  config = config()
  createdCount = 0

  listSessions() {
    return Promise.resolve([])
  }
  createSession(_principalId: PrincipalId, title?: string) {
    this.created.push(title)
    this.createdCount += 1
    return Promise.resolve({ id: `s_new_${this.createdCount}` as SessionId })
  }
  sessionExists() {
    return Promise.resolve(true)
  }
  isBusy(): boolean {
    return false
  }
  cancelTurn(): boolean {
    return true
  }
  awaitTurn(): Promise<void> {
    return Promise.resolve()
  }
  submitTurn(input: { sessionId: SessionId; prompt: string }) {
    this.submitted.push({ sessionId: input.sessionId, prompt: input.prompt })
    return Promise.resolve({ turnId: 'turn_1' as TurnId })
  }
  readConfig() {
    return Promise.resolve(this.config)
  }
  updateConfig(): Promise<void> {
    return Promise.resolve()
  }
  updateModelPreferences(): Promise<void> {
    return Promise.resolve()
  }
  // `/init` 不写档位模型、也不改上下文窗口。
  assignTierModel(): Promise<void> {
    throw new Error('init.test.ts 的用例不应写档位模型')
  }
  setModelContextWindow(): Promise<void> {
    throw new Error('init.test.ts 的用例不应改上下文窗口')
  }
  publish(): Promise<void> {
    return Promise.resolve()
  }
  getIdempotency(key: string) {
    return Promise.resolve(this.idempotency.get(key))
  }
  putIdempotency(r: { key: string; requestHash: string; response: unknown }): Promise<void> {
    this.idempotency.set(r.key, { requestHash: r.requestHash, response: r.response })
    return Promise.resolve()
  }
  recordCommandResult() {
    return Promise.resolve('msg_1')
  }
  compact() {
    return Promise.resolve({ ok: true, code: CommandResultCode.OK, text: '' })
  }
  now(): string {
    return '2026-09-15T00:00:00.000Z'
  }
}

const run = async (
  host = new FakeHost(),
  /** `sessionId: null` 表示"当前没有会话"（省略则用默认的既有会话）。 */
  extra: { sessionId?: SessionId | null; idempotencyKey?: string } = {},
) => {
  const sessionId = 'sessionId' in extra ? extra.sessionId : SESSION
  const registry = new CommandRegistry()
  registry.register(createInitCommand())
  const result = await registry.execute(
    {
      raw: '/init',
      principalId: LOCAL,
      ...(sessionId === null || sessionId === undefined ? {} : { sessionId }),
      signal: new AbortController().signal,
      ...(extra.idempotencyKey === undefined ? {} : { idempotencyKey: extra.idempotencyKey }),
    },
    host,
  )
  return { host, result }
}

describe('/init：转录文本', () => {
  it('zh 提示词非空且关键片段逐字保留', () => {
    const zh = INIT_PROMPT.zh
    expect(zh.length).toBe(392)
    // 首句与末尾句：拼接顺序错位、被截断都会在这里露出来
    expect(zh.startsWith('你正在执行项目初始化任务。')).toBe(true)
    expect(zh.endsWith('避免无关重写。')).toBe(true)
    expect(zh).toContain('作为后续 AI 协作的项目约束文档。\n\n')
    // 六条要求编号齐全
    for (const n of ['1.', '2.', '3.', '4.', '5.', '6.']) expect(zh).toContain(`\n${n} `)
    // 目标文件名写死在提示词里，改名字会破坏与旧项目产出的可比性
    expect(zh).toContain('FLYINCHAT.md')
  })

  it('zh 面板文案逐字保留', () => {
    expect(INIT_PANEL.zh).toEqual({
      title: '项目初始化',
      body: '正在探索项目结构并生成 FLYINCHAT.md...',
      noModel: '未配置主模型。请先使用 /api 添加模型，再使用 /model 选择。',
    })
  })

  it('en 提示词保留着未翻译的中文 TODO 标记（原文如此）', () => {
    // i18n/en.py:234 里就是中文，照抄不改
    expect(INIT_PROMPT.en).toContain('"TODO:待确认"')
    expect(INIT_PROMPT.en.length).toBe(1034)
  })

  it('两种语言不是同一份文本', () => {
    expect(INIT_PROMPT.en).not.toBe(INIT_PROMPT.zh)
    expect(INIT_PANEL.en.title).toBe('Project Initialization')
  })
})

describe('/init：命令行为', () => {
  it('未配置主模型：返回 MODEL_NOT_FOUND，且不建会话、不提交', async () => {
    const host = new FakeHost()
    host.config = config({ tiers: [] })
    const { result } = await run(host)

    expect(result.ok).toBe(false)
    expect(result.code).toBe(CommandResultCode.PANEL)
    expect(result.errorCode).toBe(ErrorCode.MODEL_NOT_FOUND)
    expect(result.text).toBe(INIT_PANEL.zh.noModel)
    // 旧实现此时直接 return —— 会话和 turn 都不该出现
    expect(host.created).toEqual([])
    expect(host.submitted).toEqual([])
  })

  it('档位绑定的模型被禁用时同样视为"无主模型"', async () => {
    const host = new FakeHost()
    host.config = config({
      models: [
        {
          id: 'm1',
          providerId: 'p',
          displayName: 'm1',
          enabled: false,
          supportsTools: true,
          supportsThinking: false,
          supports1MContext: false,
          contextWindow: 100_000,
          maxOutputTokens: 4096,
        },
      ],
    })
    const { result } = await run(host)
    expect(result.errorCode).toBe(ErrorCode.MODEL_NOT_FOUND)
    expect(host.submitted).toEqual([])
  })

  it('非 implementation 档位不算主模型', async () => {
    const host = new FakeHost()
    host.config = config({
      tiers: [{ tier: ModelTier.FAST, providerId: 'p', modelId: 'm1', enabled: true }],
    })
    const { result } = await run(host)
    expect(result.errorCode).toBe(ErrorCode.MODEL_NOT_FOUND)
  })

  it('无会话时新建，标题固定 "/init"', async () => {
    const host = new FakeHost()
    const { result } = await run(host, { sessionId: null })

    expect(host.created).toEqual([INIT_SESSION_TITLE])
    expect(result.data).toMatchObject({ kind: 'switch_session', sessionId: 's_new_1' })
    expect(host.submitted).toHaveLength(1)
    expect(host.submitted[0]?.sessionId).toBe('s_new_1')
  })

  it('已有会话时复用，不新建', async () => {
    const host = new FakeHost()
    const { result } = await run(host, { sessionId: SESSION })

    expect(host.created).toEqual([])
    expect(host.submitted).toEqual([{ sessionId: SESSION, prompt: INIT_PROMPT.zh }])
    expect(result.data).toMatchObject({ kind: 'switch_session', sessionId: SESSION })
  })

  it('提交的 prompt 与转录文本逐字相等', async () => {
    const host = new FakeHost()
    await run(host)
    expect(host.submitted[0]?.prompt).toBe(INIT_PROMPT.zh)
  })

  it('语言为 en 时提交 en 文本', async () => {
    const host = new FakeHost()
    host.config = config({ settings: { language: 'en' } })
    const { result } = await run(host)

    expect(host.submitted[0]?.prompt).toBe(INIT_PROMPT.en)
    expect(result.text).toBe(INIT_PANEL.en.body)
  })

  it('返回 switch_session（与 /clear 同一约定）并带上面板标题与正文', async () => {
    const { result } = await run(new FakeHost())
    expect(result.ok).toBe(true)
    expect(result.code).toBe(CommandResultCode.PANEL)
    expect(result.data).toMatchObject({
      kind: 'switch_session',
      title: INIT_PANEL.zh.title,
      body: INIT_PANEL.zh.body,
    })
  })

  it('幂等：同一 Idempotency-Key 不产生第二个会话，也不重复提交', async () => {
    const host = new FakeHost()
    const first = await run(host, { sessionId: null, idempotencyKey: 'k1' })
    const second = await run(host, { sessionId: null, idempotencyKey: 'k1' })

    expect(host.created).toHaveLength(1)
    expect(host.submitted).toHaveLength(1)
    // 回放的是首次结果，而不是重新执行一遍
    expect(second.result).toEqual(first.result)
  })

  it('提交失败时返回 FAILED 并透出错误码', async () => {
    const host = new FakeHost()
    host.submitTurn = () => Promise.reject(new Error('boom'))
    const { result } = await run(host)

    expect(result.ok).toBe(false)
    expect(result.code).toBe(CommandResultCode.FAILED)
    expect(result.text).toContain('boom')
  })
})

// ── 真应用：唯一能证明"用户消息只落盘一次"的一层 ──────────────────

const providerDoc = {
  id: 'p',
  name: 'test',
  baseUrl: 'https://api.anthropic.com',
  apiKeyRef: { source: 'env' as const, key: 'DEEPCODE_INIT_TEST_KEY' },
  createdAt: '',
  updatedAt: '',
}

const configDoc = (): ConfigDocument => ({
  schema_version: 1,
  llm_channels: [],
  llm_models: [],
  app_settings: {},
  providers: [{ ...providerDoc, enabled: true }],
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

/** 纯文本响应，不调用任何工具——`/init` 只提交一条 prompt，不需要审批往返。 */
const textFactory = () => ({
  stream: () => ({
    usage: { inputTokens: 1, outputTokens: 1 },
    async *[Symbol.asyncIterator]() {
      await Promise.resolve()
      yield { type: 'text' as ModelEventType, content: '完成' } as never
    },
  }),
  probe: () => Promise.resolve({ ok: true }),
})

async function buildApp() {
  const dir = await mkdtemp(join(tmpdir(), 'deepcode-init-'))
  const paths = resolveAppPaths({ home: dir, cwd: dir })
  const configStore = new ConfigStore(paths)
  await configStore.save(configDoc())
  const chatStore = new ChatStore(paths)
  const app = await AgentApplication.create({
    paths,
    workspaceRoot: dir,
    configStore,
    chatStore,
    providerFactory: textFactory,
  })
  return { app, chatStore }
}

describe('/init：真应用（落盘次数）', () => {
  it('无当前会话时：新会话标题为 /init，且只产生一条用户消息', async () => {
    const { app, chatStore } = await buildApp()
    const registry = new CommandRegistry()
    registry.register(createInitCommand())

    const result = await registry.execute(
      {
        raw: '/init',
        principalId: app.localPrincipalId,
        signal: new AbortController().signal,
      },
      new CommandHostAdapter(app),
    )
    await app.flush()

    const sessionId = (result.data as { sessionId: SessionId }).sessionId
    const conversation = await chatStore.getConversation(sessionId)
    expect(conversation.title).toBe(INIT_SESSION_TITLE)

    const messages: readonly Message[] = await chatStore.listMessages(sessionId)
    const userMessages = messages.filter(
      (m) => m.role === 'user' && m.subtype === MessageSubtype.NORMAL,
    )
    // 核心断言：命令层若照旧实现再落一次盘，这里会是 2
    expect(userMessages).toHaveLength(1)
    expect(userMessages[0]?.content).toBe(INIT_PROMPT.zh)
    // 整个会话里也只有这一条消息体等于 prompt（防止落成别的 subtype 绕过上面那条）
    expect(messages.filter((m) => m.content === INIT_PROMPT.zh)).toHaveLength(1)
  }, 20_000)

  it('已有会话时：提交到当前会话，不新建', async () => {
    const { app, chatStore } = await buildApp()
    const session = await app.createSession(app.localPrincipalId, '既有会话')
    const registry = new CommandRegistry()
    registry.register(createInitCommand())

    const result = await registry.execute(
      {
        raw: '/init',
        principalId: app.localPrincipalId,
        sessionId: session.id,
        signal: new AbortController().signal,
      },
      new CommandHostAdapter(app),
    )
    await app.flush()

    expect(result.data).toMatchObject({ kind: 'switch_session', sessionId: session.id })
    const conversations = await chatStore.listConversations()
    expect(conversations).toHaveLength(1)
    expect((await chatStore.getConversation(session.id)).title).toBe('既有会话')

    const messages = await chatStore.listMessages(session.id)
    expect(
      messages.filter((m) => m.role === 'user' && m.subtype === MessageSubtype.NORMAL),
    ).toHaveLength(1)
  }, 20_000)
})
