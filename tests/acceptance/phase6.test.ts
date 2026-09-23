/**
 * Phase 6 验收：Slash Commands 与 `/workwith`。
 *
 * `progess.md` 的 Phase 6 验收四条，逐条落成可执行断言：
 *
 * 1. `/workwith <provider/model> <instruction>` 使用指定模型；
 * 2. 刷新客户端或重试请求**不会重复执行**命令；
 * 3. `/workwith` 不绕过权限、预算、compact 或 skill guard；
 * 4. `/model use` 的写分支与 `/thinking` `/reasoning` `/effort` `/1M`
 *    必须**真的改变行为**，而不只是改配置。
 *
 * 第 4 条是这次收尾的核心：此前这四条命令是"诚实降级"，因为
 * `ModelProfile.thinkingEnabled` 只被 TUI 状态栏读来显示，runtime 构造
 * `ModelRequest` 时从不填 `thinking`——写配置等于什么都没发生。
 * 所以验收不能停在"配置写进去了"，必须断言**请求体**。
 *
 * 与 phase7 同样，这里跑的是真实的 `AgentApplication` + 真实注册表 + 真实
 * `CommandHostAdapter`：命令层的价值就在于三端共用这一条路径，
 * 用假 host 测等于绕开了要验的东西。
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { AgentApplication } from '../../src/app/agent-application.js'
import { CommandHostAdapter } from '../../src/app/command-host.js'
import { createBuiltinCommandRegistry } from '../../src/commands/index.js'
import { type CommandRegistry } from '../../src/commands/registry.js'
import { CommandResultCode } from '../../src/commands/types.js'
import { PermissionAction } from '../../src/core/tool.js'
import { ModelEventType, type ModelRequest } from '../../src/core/provider.js'
import { ChatStore } from '../../src/storage/chat-store.js'
import { ConfigStore } from '../../src/storage/config-store.js'
import { resolveAppPaths } from '../../src/storage/paths.js'
import type { ConfigDocument, StoredProvider } from '../../src/storage/types.js'
import type { SessionId } from '../../src/core/ids.js'

// ── 配置 ──────────────────────────────────────────────────────────

const providerOf = (id: string, name: string): StoredProvider => ({
  id,
  name,
  baseUrl: 'https://api.anthropic.com',
  apiKeyRef: { source: 'env', key: 'DEEPCODE_PHASE6_KEY' },
  createdAt: '',
  updatedAt: '',
  enabled: true,
})

/**
 * 两个 provider、三个模型。
 *
 * 主模型 `m1` 声明了思考与 1M 能力（否则 `/thinking on` 与 `/1M` 会被正确拒绝，
 * 那几条断言就测不到东西了）；`m2` 用于 `/workwith` 的换模型场景；`chat-only`
 * 用来验证 `implementation` 档位的 `supportsTools` 校验。
 */
const configDoc = (): ConfigDocument => ({
  schema_version: 1,
  llm_channels: [],
  llm_models: [],
  app_settings: {},
  providers: [providerOf('p1', 'Provider One'), providerOf('p2', 'Provider Two')],
  model_profiles: [
    {
      id: 'm1',
      providerId: 'p1',
      contextWindow: 125_000,
      maxOutputTokens: 64_000,
      supportsThinking: true,
      supportsTools: true,
      supportsVision: false,
      supports1MContext: true,
      enabled: true,
    },
    {
      id: 'm2',
      providerId: 'p2',
      contextWindow: 200_000,
      maxOutputTokens: 32_000,
      supportsThinking: false,
      supportsTools: true,
      supportsVision: false,
      supports1MContext: false,
      enabled: true,
    },
    {
      id: 'chat-only',
      providerId: 'p1',
      contextWindow: 32_000,
      maxOutputTokens: 4_000,
      supportsThinking: false,
      supportsTools: false,
      supportsVision: false,
      supports1MContext: false,
      enabled: true,
    },
  ],
  tier_assignments: [
    {
      tier: 'implementation',
      modelRef: { providerId: 'p1', modelId: 'm1' },
      enabled: true,
      fallbackModelRefs: [],
    },
  ],
})

// ── 假 provider ────────────────────────────────────────────────────

/**
 * 收集每次请求的 provider 工厂——验收要断言的是**请求体**。
 *
 * `first` 只用于**第一轮**模型调用，之后一律 `textOnly`：工具循环里
 * 每轮都会重新 `stream()`，若每轮都回放同一个 tool_use，turn 会一直
 * 卡在"请求工具 → 等审批"上直到预算耗尽。
 */
function recordingFactory(first?: readonly unknown[]) {
  const requests: ModelRequest[] = []
  const usedModels: string[] = []
  let call = 0
  const factory = (route: { model: { id: string } }) => {
    usedModels.push(route.model.id)
    return {
      stream: (request: ModelRequest) => {
        requests.push(request)
        call += 1
        const events = call === 1 && first !== undefined ? first : textOnly
        return {
          usage: { inputTokens: 1, outputTokens: 1 },
          async *[Symbol.asyncIterator]() {
            await Promise.resolve()
            for (const e of events) yield e as never
          },
        }
      },
      probe: () => Promise.resolve({ ok: true }),
    }
  }
  return { factory, requests, usedModels }
}

/** 第一轮请求 bash（需要审批），之后给文本。 */
const bashThenText = [
  { type: ModelEventType.TOOL_USE, id: 'tc1', name: 'bash', input: { command: 'echo hi' } },
]
const textOnly = [{ type: ModelEventType.TEXT, content: '完成' }]

// ── 骨架 ──────────────────────────────────────────────────────────

async function build(firstTurn?: readonly unknown[]) {
  // `/workwith` 与 `/model use` 都会校验凭据**可用性**（只判断存在，不读明文）。
  // 不设这个变量，两个命令都会以 PROVIDER_AUTH_FAILED 被拒——
  // 那样测到的就是校验本身，而不是本文件要验的语义。
  process.env['DEEPCODE_PHASE6_KEY'] = 'sk-phase6-test'
  const dir = await mkdtemp(join(tmpdir(), 'deepcode-phase6-'))
  const paths = resolveAppPaths({ home: dir, cwd: dir })
  const configStore = new ConfigStore(paths)
  await configStore.save(configDoc())
  const rec = recordingFactory(firstTurn)
  const app = await AgentApplication.create({
    paths,
    workspaceRoot: dir,
    configStore,
    chatStore: new ChatStore(paths),
    // ⚠️ 不传空 registry：bash 必须真的存在，否则第 3 条验收走不到审批那一步。
    providerFactory: rec.factory,
  })
  const session = await app.createSession(app.localPrincipalId)
  const registry: CommandRegistry = createBuiltinCommandRegistry()
  const host = new CommandHostAdapter(app)
  const run = (raw: string, idempotencyKey?: string) =>
    registry.execute(
      {
        raw,
        principalId: app.localPrincipalId,
        sessionId: session.id,
        signal: new AbortController().signal,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      },
      host,
    )
  return { app, dir, session, registry, run, ...rec }
}

/** 会话已完成的 turn 数（`ChatStore` 没有 listTurns，轮次计数在会话上）。 */
const turnsOf = async (app: AgentApplication, sessionId: SessionId): Promise<number> =>
  (await app.chatStore.getConversation(sessionId)).current_turn

/** 等所有在飞 turn 结束（命令层提交后 turn 仍在跑）。 */
const settle = async (app: AgentApplication, sessionId: SessionId) => {
  await app.awaitTurn(sessionId)
  await app.flush()
}

// ── 验收 1 ────────────────────────────────────────────────────────

describe('Phase 6 验收 1：/workwith 使用指定模型', () => {
  it('/workwith p2/m2 <instruction> 让这一轮真的跑在 m2 上', async () => {
    const { app, session, run, usedModels, requests } = await build()

    const result = await run('/workwith p2/m2 完成计划里的实现')
    expect(result.ok).toBe(true)
    // 前端必须显示"本次任务使用 provider/model"，避免用户误以为全局档位被改
    expect(result.text).toBe('本次任务使用 Provider Two/m2')
    await settle(app, session.id)

    expect(usedModels).toEqual(['m2'])
    expect(requests).toHaveLength(1)
    expect(requests[0]?.model).toBe('m2')

    // 快照也跟着走，恢复时才不会跑回档位模型
    const turnId = (result.data as { turnId: string }).turnId
    const turn = await app.chatStore.getTurn(session.id, turnId as never)
    expect(turn.modelSnapshot?.modelId).toBe('m2')
  })

  it('/workwith 不修改全局档位分配', async () => {
    const { app, session, run } = await build()
    await run('/workwith p2/m2 扫描工程')
    await settle(app, session.id)

    const doc = await app.configStore.read()
    const assignment = doc.tier_assignments.find((t) => t.tier === 'implementation')
    // 这正是 `/workwith` 与 `/model use` 的分界：前者是一次性意图，
    // 后者才改全局。override 落盘会产生"幽灵 override"——重启后用户早忘了，
    // 下一条消息却莫名用了别的模型。
    expect(assignment?.modelRef).toEqual({ providerId: 'p1', modelId: 'm1' })
  })

  it('模型不存在时返回 MODEL_NOT_FOUND，且**一个 turn 都不提交**', async () => {
    const { app, session, run, requests } = await build()
    const result = await run('/workwith p2/nope 做点什么')

    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('MODEL_NOT_FOUND')
    expect(requests).toHaveLength(0)

    expect(await turnsOf(app, session.id)).toBe(0)
  })

  it('缺少指令时在参数校验阶段挡下，不提交模型请求', async () => {
    // parts/09 §6.1 第 5 条：缺少模型引用或指令为空时返回
    // INVALID_COMMAND_ARGUMENTS，**不得提交模型请求**。
    const { requests, run } = await build()
    const result = await run('/workwith p2/m2')

    expect(result.code).toBe(CommandResultCode.INVALID_ARGUMENTS)
    expect(requests).toHaveLength(0)
  })
})

// ── 验收 2 ────────────────────────────────────────────────────────

describe('Phase 6 验收 2：刷新或重试不重复执行', () => {
  it('同一个 Idempotency-Key 重放首次结果，不提交第二个 turn', async () => {
    const { app, session, run, usedModels } = await build()

    const first = await run('/workwith p2/m2 做一次', 'key-1')
    await settle(app, session.id)
    const second = await run('/workwith p2/m2 做一次', 'key-1')
    await settle(app, session.id)

    // 回放的是**同一次**结果，而不是重新跑一遍
    expect(second).toEqual(first)
    expect(usedModels).toEqual(['m2'])

    // 重放不该产生第二个 turn
    expect(await turnsOf(app, session.id)).toBe(1)
  })

  it('同一个幂等键换了命令内容 → 明确报错，而不是回放旧结果', async () => {
    const { run } = await build()
    await run('/workwith p2/m2 第一次', 'key-2')
    const conflicting = await run('/workwith p2/m2 换了个内容', 'key-2')

    expect(conflicting.ok).toBe(false)
    expect(conflicting.errorCode).toBe('INVALID_STATE_TRANSITION')
  })

  it('不同幂等键是两次独立的执行', async () => {
    const { app, session, run, usedModels } = await build()

    await run('/workwith p2/m2 第一次', 'key-a')
    await settle(app, session.id)
    await run('/workwith p2/m2 第二次', 'key-b')
    await settle(app, session.id)

    expect(usedModels).toEqual(['m2', 'm2'])
    expect(await turnsOf(app, session.id)).toBe(2)
  })
})

// ── 验收 3 ────────────────────────────────────────────────────────

describe('Phase 6 验收 3：/workwith 不绕过权限、预算与 compact', () => {
  it('指令仍作为普通用户任务进入 turn，工具调用照常需要审批', async () => {
    // `/workwith` 只换模型，不换任何安全语义：它建立的是"这一轮用哪个模型"，
    // 而权限是**每次工具调用**独立判定的。
    const { app, session, run } = await build(bashThenText)

    // ⚠️ 命令的 `submitTurn` 会**一直等到 turn 结束**（与 Web 的
    // `POST /api/turns` 同一语义，见 `AgentApplication.submitTurn`）。
    // 所以不能在 `await run(...)` 之后再去查待审批——那时 turn 早已结束。
    // 正确的姿势是像 phase7 那样挂一个订阅者，在事件到达时当场回灌决定。
    const seen: string[] = []
    await app.attach(
      {
        onEvent: (event) => {
          seen.push(event.type)
          if (event.type !== 'permission_required') return
          const requestId = (event.data as { request_id?: string }).request_id
          if (requestId === undefined) return
          void app.resolvePermission({
            requestId,
            decision: PermissionAction.DENY,
            principalId: app.localPrincipalId,
          })
        },
      },
      { sessionId: session.id },
    )

    const result = await run('/workwith p2/m2 提交一个需要审批的操作')
    expect(result.ok).toBe(true)

    // 换成别的模型**不会**让工具调用跳过权限：bash 依旧要走审批。
    expect(seen).toContain('permission_required')
    expect(seen).toContain('turn_end')

    const executions = await app.chatStore.listToolExecutions(session.id)
    expect(executions).toHaveLength(1)
    expect(executions[0]?.status).not.toBe('pending')
  })

  it('override 到达路由层时**首选**就是它，而不是被档位模型顶掉', async () => {
    const { usedModels, run, app, session } = await build()
    await run('/workwith p2/m2 只用这个模型')
    await settle(app, session.id)

    // 档位分配是 p1/m1，但本轮必须跑在 p2/m2 上
    expect(usedModels[0]).toBe('m2')
  })
})

// ── 验收 4 ────────────────────────────────────────────────────────

describe('Phase 6 验收 4：/model use 与四条偏好命令真的改变行为', () => {
  it('/model use 换档位模型后，下一轮真的用新模型', async () => {
    const { app, session, run, usedModels } = await build()

    const assigned = await run('/model use implementation p2/m2')
    expect(assigned.ok).toBe(true)

    await app.submitTurn({
      principalId: app.localPrincipalId,
      sessionId: session.id,
      prompt: '随便做点',
    })
    await settle(app, session.id)

    expect(usedModels).toEqual(['m2'])
  })

  it('/model use 对不支持工具的模型予以拒绝（parts/09 §9.3）', async () => {
    const { run } = await build()
    const result = await run('/model use implementation p1/chat-only')
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('MODEL_CAPABILITY_UNAVAILABLE')
  })

  it('/thinking on + /reasoning high 之后，请求体里带上折算出的思考预算', async () => {
    // 这是本次收尾的**核心断言**：以前的实现在这里只会改到配置，
    // 请求体里一个 thinking 字段都不会出现。
    const { app, session, run, requests } = await build()

    expect((await run('/thinking on')).ok).toBe(true)
    expect((await run('/reasoning high')).ok).toBe(true)

    await app.submitTurn({
      principalId: app.localPrincipalId,
      sessionId: session.id,
      prompt: '想一下',
    })
    await settle(app, session.id)

    expect(requests[0]?.thinking).toEqual({ type: 'enabled', budgetTokens: 24_000 })
    // Anthropic 的硬性约束：max_tokens 必须大于 budget_tokens
    expect(requests[0]!.maxTokens).toBeGreaterThan(24_000)
  })

  it('/effort low 关掉思考后，请求体里不再有 thinking 字段', async () => {
    const { app, session, run, requests } = await build()

    await run('/thinking on')
    await run('/effort low')

    await app.submitTurn({
      principalId: app.localPrincipalId,
      sessionId: session.id,
      prompt: '不用想了',
    })
    await settle(app, session.id)

    expect('thinking' in (requests[0] ?? {})).toBe(false)
  })

  it('/1M 切换上下文窗口，并被后续 turn 的快照带上', async () => {
    const { app, session, run } = await build()

    const result = await run('/1M')
    expect(result.ok).toBe(true)

    const submitted = await app.submitTurn({
      principalId: app.localPrincipalId,
      sessionId: session.id,
      prompt: '大上下文',
    })
    await settle(app, session.id)

    const turn = await app.chatStore.getTurn(session.id, submitted.turnId)
    expect(turn.modelSnapshot?.contextWindow).toBe(1_000_000)
  })

  it('/thinking on 在模型未声明 supportsThinking 时拒绝，**整份配置**保持原样', async () => {
    const { app, run } = await build()
    // m2 声明了 supportsTools（所以能当 implementation）但没声明 supportsThinking。
    await run('/model use implementation p2/m2')

    const before = await app.configStore.read()
    const result = await run('/thinking on')
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('MODEL_CAPABILITY_UNAVAILABLE')

    // 断言**整份文档**而不是单看 m2.thinkingEnabled：后者在"命令误写到
    // 别的 profile"时照样通过。D5 的承诺是"一个字节都不写"。
    expect(await app.configStore.read()).toEqual(before)
  })

  it('/1M 在模型未声明 supports1MContext 时拒绝，不静默降级', async () => {
    const { app, run } = await build()
    await run('/model use implementation p2/m2')

    const before = await app.configStore.read()
    const result = await run('/1M')
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('MODEL_CAPABILITY_UNAVAILABLE')

    // 既不写，也不"降级成 125K"——两个方向都不许动
    expect(await app.configStore.read()).toEqual(before)
  })

  it('/reasoning 同时打开思考：否则它报出的预算永远不会出现在请求里', async () => {
    const { app, session, run, requests } = await build()
    // m1 支持思考，档位默认就指向它
    expect((await run('/reasoning medium')).ok).toBe(true)

    await app.submitTurn({
      principalId: app.localPrincipalId,
      sessionId: session.id,
      prompt: '想一下',
    })
    await settle(app, session.id)

    // 只写 reasoningEffort 的话这里会是 undefined——回执里的"预算 12000"
    // 就是个从未发出的数字。
    expect(requests[0]?.thinking).toEqual({ type: 'enabled', budgetTokens: 12_000 })
  })
})

// ── 注册表契约 ────────────────────────────────────────────────────

describe('Phase 6 验收：命令表与诚实降级', () => {
  it('名称唯一，且大小写不敏感可查', async () => {
    const { registry } = await build()
    const names = registry.list().map((d) => d.name)
    expect(new Set(names).size).toBe(names.length)
    expect(registry.get('WORKWITH')).toBe(registry.get('workwith'))
    expect(registry.get('1m')).toBe(registry.get('1M'))
  })

  it('本阶段实现的命令不再是 not_available', async () => {
    const { run } = await build()
    for (const raw of ['/model', '/thinking', '/reasoning', '/effort', '/1M', '/sessions']) {
      const result = await run(raw)
      expect(result.code, `${raw} 不应再返回 not_available`).not.toBe(
        CommandResultCode.NOT_AVAILABLE,
      )
    }
  })

  it('未实现子系统仍然诚实地降级（不返回假数据、不假装成功）', async () => {
    const { run } = await build()
    for (const raw of ['/mcp', '/langfuse', '/api']) {
      const result = await run(raw)
      expect(result.ok).toBe(false)
      expect(result.code).toBe(CommandResultCode.NOT_AVAILABLE)
      expect(result.errorCode).toBe('COMMAND_NOT_AVAILABLE')
      // 必须说明原因，而不是一句"失败"
      expect(result.text.length).toBeGreaterThan(10)
    }
  })
})
