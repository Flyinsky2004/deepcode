/**
 * `AgentRuntime` 的分支覆盖测试。
 *
 * 目标：把 `src/runtime/agent-runtime.ts` 的**行为分支**（并发拒绝、恢复校验、
 * 预算耗尽与 finalization、压缩触发、provider 异常与重试/降级、工具循环的
 * 工作记忆收敛、取消与墙钟超时、异常兜底）逐条固定下来。
 *
 * 约定与已有测试保持一致：
 * - 用**假 provider**（实现 `ModelProvider`）+ 真实 `ChatStore`（`mkdtemp` 临时目录）；
 * - macOS 上 `mkdtemp` 返回 `/var/...`，`realpath` 得到 `/private/var/...`，
 *   凡是要与工具写出的路径做比较的地方都必须用 `realpath` 规范化，否则是假阴性；
 * - 只断言**有语义**的结果，不写"调用一下看不抛错"的空测试；
 * - 发现可疑行为时**固化现状**并在注释里写明分析，绝不改 `src/` 让它"变对"。
 */
import { mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { AgentRuntime, type AgentRuntimeOptions } from '../../src/runtime/agent-runtime.js'
import { ContextBuilder } from '../../src/runtime/context-builder.js'
import type { ContextCompactor } from '../../src/runtime/compaction.js'
import { ChatStore } from '../../src/storage/chat-store.js'
import { resolveAppPaths } from '../../src/storage/paths.js'
import { inputHash } from '../../src/storage/audit.js'
import { InMemoryEventSink } from '../../src/core/events.js'
import { InMemoryObservationSink, type ObservationSink } from '../../src/core/observability.js'
import { AgentError, ErrorCode } from '../../src/core/errors.js'
import { EMPTY_WORKING_MEMORY } from '../../src/core/context.js'
import {
  ModelEventType,
  ModelTier,
  type ModelProvider,
  type ModelRequest,
  type ModelStream,
  type ModelEvent,
  type Provider,
  type TokenUsage,
} from '../../src/core/provider.js'
import type { ResolvedModelRoute } from '../../src/providers/router.js'
import { ModelRouter } from '../../src/providers/router.js'
import {
  PermissionAction,
  PermissionMode,
  ToolExecutionStatus,
  type PermissionEngine,
  type Tool,
  type ToolContext,
  type ToolResult,
  type SkillGuardRef,
} from '../../src/core/tool.js'
import { TerminalReason, TurnPhase, TurnStatus, type TurnStreamEvent } from '../../src/core/turn.js'
import type { SessionId, TurnId } from '../../src/core/ids.js'
import type { AgentBudget } from '../../src/core/budget.js'
import type { PersistedTurn, ConfigDocument } from '../../src/storage/types.js'
import { ToolExecutor } from '../../src/tools/executor.js'
import { ToolRegistry } from '../../src/tools/registry.js'
import { DefaultPermissionEngine } from '../../src/tools/permission-engine.js'
import { createFileWriteTool, createTodoWriteTool } from '../../src/tools/builtins.js'

// ── 通用工具 ──────────────────────────────────────────────────────

const BUDGET: AgentBudget = {
  maxModelCalls: 5,
  maxToolCalls: 10,
  maxWallTimeMs: 10 * 60 * 1000,
  maxInputTokens: 100_000,
  maxOutputTokens: 100_000,
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 墙钟类用例的时间常量。
 *
 * ️ 这些用例**必须**用真实定时器触发超时：收尾判定读的是
 * `wallTimeout.timedOut()`，它只认真实定时器，注入假时钟没用。
 * 于是预算必须**明显大于**"turn 启动 → 进入目标阶段"的耗时——那段路上要写盘
 * （`ChatStore` 每次 update 都带 fsync），在并行跑全量测试时会到几十毫秒。
 * 早先这里用 20~30ms，于是随机在 `STARTING` 阶段就超时，断言变成
 * `starting -> budget_exceeded`，测试在满载时偶发失败。改用秒级余量换确定性：
 * 预算 300ms 足以让首个 loop 检查稳定通过，而工作耗时 700ms 保证定时器
 * 一定在目标阶段内触发。
 */
const WALL_BUDGET_MS = 300
const WALL_WORK_MS = 700

const text = (content: string): ModelEvent => ({ type: ModelEventType.TEXT, content })

const toolUse = (id: string, name: string, input: unknown): ModelEvent => ({
  type: ModelEventType.TOOL_USE,
  id,
  name,
  input: input as Record<string, unknown>,
})

/** 一轮 provider 调用的脚本。 */
interface TurnScript {
  readonly events?: readonly ModelEvent[]
  readonly usage?: TokenUsage
  /** 本次调用抛出该错误（模拟 provider 异常）。 */
  readonly error?: Error
  /** 挂起直到信号中止（模拟超时 / 取消）。 */
  readonly hang?: true
}

/**
 * 按调用次序回放脚本的假 provider；脚本用尽后重复最后一项。
 *
 * 同时收集每次 `stream()` 收到的请求，便于断言 finalization 轮不带工具声明
 * 之类的协议细节。
 */
function scriptedProvider(...turns: readonly TurnScript[]) {
  const requests: ModelRequest[] = []
  let calls = 0
  // 首次 `stream()` 被调用的信号。测试里凡是要"在 provider 流中"触发取消/超时，
  // 都必须先 await 它——`ChatStore` 的写入带 fsync，靠 sleep 猜时间会假阴性。
  let markEntered: () => void = () => undefined
  const firstCall = new Promise<void>((resolve) => {
    markEntered = resolve
  })
  const streamFor = (turn: TurnScript, signal: AbortSignal): ModelStream => {
    const iterate = async function* (): AsyncGenerator<ModelEvent> {
      if (turn.error !== undefined) throw turn.error
      if (turn.hang === true) {
        await new Promise<never>((_resolve, reject) => {
          if (signal.aborted) reject(new Error('aborted by signal'))
          else
            signal.addEventListener('abort', () => reject(new Error('aborted by signal')), {
              once: true,
            })
        })
      }
      for (const event of turn.events ?? []) yield event
    }
    const result: { usage?: TokenUsage } & AsyncIterable<ModelEvent> = {
      [Symbol.asyncIterator]: () => iterate(),
    }
    if (turn.usage !== undefined) result.usage = turn.usage
    return result as ModelStream
  }
  const provider: ModelProvider = {
    stream(request, signal) {
      requests.push(request)
      const index = Math.min(calls, turns.length - 1)
      calls += 1
      const turn: TurnScript = turns[index] ?? {}
      markEntered()
      return streamFor(turn, signal)
    },
    probe: () => Promise.resolve({ ok: true }),
  }
  return { provider, requests, callCount: () => calls, firstCall }
}

/** 低风险的假工具：YOLO 模式下无需审批即可执行。 */
function fakeTool(
  name: string,
  execute: (ctx: ToolContext, input: Readonly<Record<string, unknown>>) => Promise<ToolResult>,
): Tool {
  return {
    descriptor: {
      name,
      description: `fake tool ${name}`,
      input_schema: { type: 'object', properties: {} },
      version: '1.0.0',
      risk_level: 'low',
      capabilities: ['interactive'],
      source: { kind: 'native' },
    },
    // 假工具不做输入校验，原样收窄——测试只关心 runtime 的行为。
    validate: (input) => ({
      ok: true,
      value: (typeof input === 'object' && input !== null ? input : {}) as Readonly<
        Record<string, unknown>
      >,
    }),
    execute,
  }
}

const okResult = (content: string, data?: Readonly<Record<string, unknown>>): ToolResult => ({
  ok: true,
  content,
  error_code: null,
  meta: {},
  ...(data === undefined ? {} : { data }),
})

// ── 测试骨架 ──────────────────────────────────────────────────────

interface HarnessOptions {
  readonly provider?: ModelProvider
  readonly model?: string
  readonly register?: (registry: ToolRegistry) => void
  readonly mode?: PermissionMode
  readonly compactor?: ContextCompactor
  readonly router?: ModelRouter
  readonly providerFactory?: (route: ResolvedModelRoute) => ModelProvider
  readonly permissionEngine?: PermissionEngine
  readonly budget?: AgentBudget
  readonly maxTurns?: number
  /** 替换 contextBuilder，用于制造"上下文组装阶段抛异常"的场景。 */
  readonly buildContext?: unknown
  readonly observationSink?: ObservationSink
}

async function harness(options: HarnessOptions = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'deepcode-ar-')))
  const store = new ChatStore(resolveAppPaths({ home: dir, cwd: dir }))
  const conversation = await store.createConversation()
  const registry = new ToolRegistry()
  options.register?.(registry)
  const executor = new ToolExecutor({
    registry,
    permissionEngine: options.permissionEngine ?? new DefaultPermissionEngine(),
    chatStore: store,
    ...(options.observationSink === undefined ? {} : { observationSink: options.observationSink }),
  })
  const builder = new ContextBuilder({ chatStore: store, tools: () => registry.descriptors() })
  const sink = new InMemoryEventSink()
  const model = options.model ?? (options.provider === undefined ? undefined : 'test-model')
  const runtimeOptions: AgentRuntimeOptions = {
    chatStore: store,
    contextBuilder: (options.buildContext ?? builder) as ContextBuilder,
    toolExecutor: executor,
    eventSink: sink,
    ...(options.observationSink === undefined ? {} : { observationSink: options.observationSink }),
    workspaceRoot: dir,
    principalId: 'p',
    ...(options.provider === undefined ? {} : { provider: options.provider }),
    ...(model === undefined ? {} : { model }),
    ...(options.mode === undefined ? {} : { mode: options.mode }),
    ...(options.compactor === undefined ? {} : { compactor: options.compactor }),
    ...(options.router === undefined ? {} : { router: options.router }),
    ...(options.providerFactory === undefined ? {} : { providerFactory: options.providerFactory }),
    ...(options.budget === undefined ? {} : { budget: options.budget }),
    ...(options.maxTurns === undefined ? {} : { maxTurns: options.maxTurns }),
  }
  const runtime = new AgentRuntime(runtimeOptions)
  return {
    dir,
    store,
    conversation,
    registry,
    executor,
    sink,
    runtime,
    events: (): readonly TurnStreamEvent[] => sink.events as unknown as readonly TurnStreamEvent[],
    findEvent: <T extends string>(type: T) =>
      (sink.events as unknown as readonly TurnStreamEvent[]).find((e) => e.type === type),
  }
}

/** 把 turn 沿合法迁移路径推到目标阶段（`chat-store` 会校验迁移合法性）。 */
const PHASE_PATH: Readonly<Record<string, readonly TurnPhase[]>> = {
  [TurnPhase.BUILDING_CONTEXT]: [TurnPhase.BUILDING_CONTEXT],
  [TurnPhase.CALLING_MODEL]: [TurnPhase.BUILDING_CONTEXT, TurnPhase.CALLING_MODEL],
  [TurnPhase.EXECUTING_TOOLS]: [
    TurnPhase.BUILDING_CONTEXT,
    TurnPhase.CALLING_MODEL,
    TurnPhase.EXECUTING_TOOLS,
  ],
  [TurnPhase.AWAITING_PERMISSION]: [
    TurnPhase.BUILDING_CONTEXT,
    TurnPhase.CALLING_MODEL,
    TurnPhase.EXECUTING_TOOLS,
    TurnPhase.AWAITING_PERMISSION,
  ],
  [TurnPhase.AWAITING_USER_INPUT]: [
    TurnPhase.BUILDING_CONTEXT,
    TurnPhase.CALLING_MODEL,
    TurnPhase.EXECUTING_TOOLS,
    TurnPhase.AWAITING_USER_INPUT,
  ],
  [TurnPhase.FINALIZING]: [
    TurnPhase.BUILDING_CONTEXT,
    TurnPhase.CALLING_MODEL,
    TurnPhase.FINALIZING,
  ],
}

/** beginTurn + 推到目标阶段 + 打补丁。 */
async function seedTurn(
  store: ChatStore,
  sessionId: SessionId,
  phase: TurnPhase,
  patch: Partial<PersistedTurn> = {},
  workingMemory = EMPTY_WORKING_MEMORY,
  budget: AgentBudget = BUDGET,
): Promise<PersistedTurn> {
  const turn = await store.beginTurn(sessionId, 'seeded', 'p', budget, workingMemory)
  const turnId = turn.turnId as TurnId
  for (const step of PHASE_PATH[phase] ?? [phase])
    await store.updateTurn(sessionId, turnId, { phase: step })
  if (Object.keys(patch).length > 0) await store.updateTurn(sessionId, turnId, patch)
  return turn
}

const persisted = (store: ChatStore, sessionId: SessionId, turnId: string) =>
  store.getTurn(sessionId, turnId as TurnId)

// ─ 会话并发 ──────────────────────────────────────────────────────

describe('会话并发（SESSION_BUSY）', () => {
  it('同一会话已有 active turn 时，submitMessage / resumeTurn 立即拒绝，且 turn 结束后解除', async () => {
    // 覆盖 94 / 145：`busy` 集合是"同 session 只允许一个 active turn"的**内存**守卫
    // （存储层还有一道基于 phase 的守卫，两者独立）。漏了它会让两个 turn 并发写同一份 chat.json。
    const script = scriptedProvider({ hang: true }, { events: [text('after')] })
    const h = await harness({ provider: script.provider })
    const controller = new AbortController()

    const first = h.runtime.submitMessage(h.conversation.id, 'first', controller.signal)
    // 等到第一轮真的进入 provider 流再继续，避免"取消发生在调用之前"的竞态
    await script.firstCall

    await expect(h.runtime.submitMessage(h.conversation.id, 'second')).rejects.toMatchObject({
      code: ErrorCode.SESSION_BUSY,
    })
    // resumeTurn 同样先看 busy 集合（此时它甚至不会去读 turn）
    await expect(
      h.runtime.resumeTurn(h.conversation.id, 'whatever' as TurnId),
    ).rejects.toMatchObject({ code: ErrorCode.SESSION_BUSY })

    controller.abort()
    expect((await first).status).toBe(TurnStatus.CANCELLED)

    // 结束（含异常路径）后必须释放，否则会话被永久锁死
    expect(h.runtime.busy.size).toBe(0)
    // 释放后可以正常再开一轮（同时也覆盖 submit 这个薄封装）
    const second = await h.runtime.submit(h.conversation.id, 'third')
    expect(second.status).toBe(TurnStatus.COMPLETED)
    expect(second.final_text).toBe('after')
  })
})

// ─ resumeTurn 的前置校验 ─────────────────────────────────────────

describe('resumeTurn 的前置校验', () => {
  it('turn 属于其它 principal 时拒绝', async () => {
    // 覆盖 152：恢复不能跨 principal——否则重启后 A 的未完成 turn 会被 B 接手执行。
    const h = await harness({ provider: scriptedProvider({ events: [text('x')] }).provider })
    const turn = await h.store.beginTurn(
      h.conversation.id,
      'x',
      'other-principal',
      BUDGET,
      EMPTY_WORKING_MEMORY,
    )
    await expect(
      h.runtime.resumeTurn(h.conversation.id, turn.turnId as TurnId),
    ).rejects.toMatchObject({ code: ErrorCode.PERMISSION_DENIED })
  })

  it('已进入终态的 turn 直接返回持久化结果，不再调用模型', async () => {
    // 覆盖 158 / 160：重复 resume 一个已完成的 turn 必须幂等返回原结果，
    // 而不是重新跑一遍（那会重复执行工具副作用）。
    const script = scriptedProvider({
      events: [text('done')],
      usage: { inputTokens: 3, outputTokens: 4 },
    })
    const h = await harness({ provider: script.provider })

    const first = await h.runtime.submitMessage(h.conversation.id, 'go')
    expect(first.status).toBe(TurnStatus.COMPLETED)

    const again = await h.runtime.resumeTurn(h.conversation.id, first.turn_id)
    expect(again).toEqual(first)
    expect(script.callCount()).toBe(1)
  })

  it('终态但没有 result 的 turn：合成不可恢复结果并带上已持久化的进展字段', async () => {
    // 覆盖 160/163/164/171：进程可能在写完 phase 但没写 result 时崩溃。
    // 此时 resume 必须给出**失败**结果并尽量带上已有产出，而不是抛异常或静默返回空。
    const h = await harness({ provider: scriptedProvider({ events: [text('x')] }).provider })
    const withFields = await seedTurn(h.store, h.conversation.id, TurnPhase.FAILED, {
      finalText: '半成品',
      toolRounds: 3,
      lastToolError: ErrorCode.TOOL_TIMEOUT,
    })
    const bare = await seedTurn(h.store, h.conversation.id, TurnPhase.FAILED)

    const rich = await h.runtime.resumeTurn(h.conversation.id, withFields.turnId as TurnId)
    expect(rich).toMatchObject({
      status: TurnStatus.FAILED,
      final_text: '半成品',
      tool_rounds: 3,
      last_tool_error: ErrorCode.TOOL_TIMEOUT,
      error: 'turn is not resumable',
      terminal_reason: TerminalReason.ERROR,
    })
    expect(rich.max_turns).toBe(BUDGET.maxModelCalls)

    // 字段缺失时退化为空值（而不是 undefined 泄漏进 TurnResult）
    const empty = await h.runtime.resumeTurn(h.conversation.id, bare.turnId as TurnId)
    expect(empty).toMatchObject({
      status: TurnStatus.FAILED,
      final_text: '',
      tool_rounds: 0,
      last_tool_error: null,
      num_turns: 0,
    })
  })
})

// ── 模型配置缺失与预算耗尽 ────────────────────────────────────────

describe('模型配置与预算', () => {
  it('既没有 provider 也没有 router 时以 failed 收尾，并给出可操作的提示', async () => {
    // 覆盖 363：配置缺失是**用户可修复**的状态，错误文案必须指向修复动作（/api、/model）。
    const h = await harness({})
    const result = await h.runtime.submitMessage(h.conversation.id, 'go')
    expect(result.status).toBe(TurnStatus.FAILED)
    expect(result.error).toContain('No model configured')
    expect((await persisted(h.store, h.conversation.id, result.turn_id)).phase).toBe(
      TurnPhase.FAILED,
    )
  })

  it('maxTurns 收窄模型调用预算，工具轮后耗尽即以 partial 收尾并落到 budget_exceeded 阶段', async () => {
    // 覆盖 106 / 274 / 284 / 810：
    // - 106：maxTurns 与 budget.maxModelCalls 取**更严**的一侧，而不是覆盖它；
    // - 284：executing_tools 没有直达 budget_exceeded 的边，必须先经 calling_model -> finalizing
    //   （冻结的状态机行为，测试固化它以免被"顺手简化"）。
    const h = await harness({
      provider: scriptedProvider({
        events: [toolUse('c1', 'todo_write', { todos: [{ content: 'a', status: 'pending' }] })],
        usage: { inputTokens: 1, outputTokens: 1 },
      }).provider,
      register: (registry) => registry.register(createTodoWriteTool()),
      maxTurns: 1,
    })

    const result = await h.runtime.submitMessage(h.conversation.id, 'go')
    expect(result.status).toBe(TurnStatus.PARTIAL)
    expect(result.terminal_reason).toBe(TerminalReason.BUDGET_EXCEEDED)
    expect(result.error).toContain('modelCall')
    expect(result.max_turns).toBe(1)

    const turn = await persisted(h.store, h.conversation.id, result.turn_id)
    expect(turn.phase).toBe(TurnPhase.BUDGET_EXCEEDED)
    // 收窄后的预算要落盘，恢复时才能一致地继续
    expect(turn.budget.maxModelCalls).toBe(1)
    expect(turn.transitions.map((t) => `${t.from}->${t.to}`)).toContain(
      'executing_tools->calling_model',
    )
  })

  it('恢复时预算已耗尽却停在 awaiting_permission：返回 partial，不再抛异常、不再锁死会话', async () => {
    // 这是 ADR 0003 修掉的核心场景。
    //
    // 原缺陷有两个叠加机制：
    // 1) 循环顶部发现预算耗尽后走 `finish(PARTIAL, BUDGET_EXCEEDED)`，它会尝试把
    //    awaiting_permission **直接**迁移到 budget_exceeded，而 `TRANSITIONS` 里没有
    //    这条边，于是 `transition()` 抛 INVALID_STATE_TRANSITION；
    // 2) 该拒绝**没有被 runTurn 的 catch 接住**——`return finish(...)` 返回的是被拒绝的
    //    Promise，而 `return` 不 await 它，try/catch 拦不到。
    //
    // 实测后果曾是：`resumeTurn` 抛异常；turn 停在 awaiting_permission、既无 result
    // 也无终态，该会话被 store 层的 SESSION_BUSY 锁死，只能手改 chat.json。
    // `parts/09` §7.4 要求 partial 不得伪装成失败，而当时连"失败结果"都没返回。
    //
    // 现在：预算耗尽统一绕行 finalizing（既有边组合，不扩大迁移表），且所有
    // `return finish(...)` 都改成了 `return await finish(...)`。
    const h = await harness({ provider: scriptedProvider({ events: [text('x')] }).provider })
    const turn = await seedTurn(h.store, h.conversation.id, TurnPhase.AWAITING_PERMISSION, {
      consumption: {
        modelCalls: BUDGET.maxModelCalls,
        toolCalls: 0,
        wallTimeMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        cost: 0,
      },
    })

    const result = await h.runtime.resumeTurn(h.conversation.id, turn.turnId as TurnId)
    expect(result.status).toBe(TurnStatus.PARTIAL)
    expect(result.terminal_reason).toBe(TerminalReason.BUDGET_EXCEEDED)

    const stored = await persisted(h.store, h.conversation.id, turn.turnId)
    // 终态已落盘，而不是停在原地。
    expect(stored.phase).toBe(TurnPhase.BUDGET_EXCEEDED)
    expect(stored.result?.status).toBe(TurnStatus.PARTIAL)
    // 会话不再被残留的 active turn 挡住——这是修复带来的直接收益。
    await expect(h.runtime.submitMessage(h.conversation.id, 'again')).resolves.toBeDefined()
  })
})

// ── finalization ──────────────────────────────────────────────────

describe('预算耗尽后的 finalization', () => {
  it('恢复时预算已耗尽且停在 calling_model：先迁到 finalizing 再跑一次无工具的收尾生成', async () => {
    // 覆盖 475 / 476(true) / 482(true) / 536 / 658：
    // 收尾生成必须**不带工具声明**（`tools: []`），否则模型会继续请求工具而无法收尾。
    const script = scriptedProvider({ events: [text('收尾文本')] })
    const h = await harness({ provider: script.provider })
    const turn = await seedTurn(h.store, h.conversation.id, TurnPhase.CALLING_MODEL, {
      consumption: {
        modelCalls: BUDGET.maxModelCalls,
        toolCalls: 0,
        wallTimeMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        cost: 0,
      },
    })

    const result = await h.runtime.resumeTurn(h.conversation.id, turn.turnId as TurnId)
    expect(result.status).toBe(TurnStatus.PARTIAL)
    expect(result.terminal_reason).toBe(TerminalReason.BUDGET_EXCEEDED)
    expect(result.final_text).toBe('收尾文本')
    expect(script.requests).toHaveLength(1)
    expect(script.requests[0]?.tools).toEqual([])

    const stored = await persisted(h.store, h.conversation.id, result.turn_id)
    expect(stored.phase).toBe(TurnPhase.BUDGET_EXCEEDED)
    expect(stored.transitions.map((t) => t.to)).toContain(TurnPhase.FINALIZING)
  })

  it('收尾轮遇到暂时性错误：允许再重试一次（不计入"只允许一次"的收尾）', async () => {
    // 覆盖 482(true)：`finalizationAttempted && phase === FINALIZING` 那条空分支
    // 表达的是"进程可能恰好停在唯一一次收尾调用上，恢复时允许再补一次"。
    // 这里用**暂时性 provider 错误**触发第二轮循环，从而走到它。
    const script = scriptedProvider(
      {
        error: new AgentError({
          code: ErrorCode.PROVIDER_UNAVAILABLE,
          message: '5xx',
          source: 'test',
        }),
      },
      { events: [text('收尾补跑')] },
    )
    const h = await harness({ provider: script.provider })
    const turn = await seedTurn(h.store, h.conversation.id, TurnPhase.CALLING_MODEL, {
      consumption: {
        modelCalls: BUDGET.maxModelCalls,
        toolCalls: 0,
        wallTimeMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        cost: 0,
      },
    })

    const result = await h.runtime.resumeTurn(h.conversation.id, turn.turnId as TurnId)
    expect(result.status).toBe(TurnStatus.PARTIAL)
    expect(result.terminal_reason).toBe(TerminalReason.BUDGET_EXCEEDED)
    expect(result.final_text).toBe('收尾补跑')
    expect(script.callCount()).toBe(2)
  })

  it('恢复停在 finalizing 的 turn：收尾轮仍请求工具时以 finalization_tool_call 终止', async () => {
    // 覆盖 216 / 660：进程可能恰好停在"最后一次收尾生成"上。重放它是允许的，
    // 但若它又请求了工具，就必须终止——否则就绕过了"收尾不提供工具"的约定。
    const h = await harness({
      provider: scriptedProvider({
        events: [toolUse('c9', 'todo_write', { todos: [{ content: 'a', status: 'pending' }] })],
      }).provider,
      register: (registry) => registry.register(createTodoWriteTool()),
    })
    const turn = await seedTurn(h.store, h.conversation.id, TurnPhase.FINALIZING)

    const result = await h.runtime.resumeTurn(h.conversation.id, turn.turnId as TurnId)
    expect(result.status).toBe(TurnStatus.PARTIAL)
    expect(result.terminal_reason).toBe(TerminalReason.FINALIZATION_TOOL_CALL)
    expect(result.error).toContain('finalization response requested tools')
  })
})

// ── 压缩 ──────────────────────────────────────────────────────────

describe('压缩触发', () => {
  it('上下文就绪后触发 preflight 压缩，压缩后重建上下文继续本轮', async () => {
    // 覆盖 504/506/507：preflight 压缩发生在组装上下文之后、调用模型之前；
    // 压缩完必须回到 building_context 重新组装（否则会用旧上下文发请求）。
    let requested = 0
    let compactCalls = 0
    const compactor = {
      shouldCompact: () => {
        requested += 1
        return true
      },
      compact: () => {
        compactCalls += 1
        return Promise.resolve(undefined)
      },
    } as unknown as ContextCompactor
    const observations = new InMemoryObservationSink()
    const h = await harness({
      provider: scriptedProvider({ events: [text('ok')] }).provider,
      compactor,
      observationSink: observations,
    })

    const result = await h.runtime.submitMessage(h.conversation.id, 'go')
    expect(result.status).toBe(TurnStatus.COMPLETED)
    // 一个 turn 最多触发一次 preflight 压缩（`compactedThisTurn` 护栏）：
    // 压缩回到循环顶部后会再走一遍 `if (...)`，但被护栏短路，shouldCompact 不再被调用。
    expect(compactCalls).toBe(1)
    expect(requested).toBe(1)

    const types = h.events().map((e) => e.type)
    expect(types).toContain('compact_start')
    expect(types).toContain('compact_end')
    const end = h.findEvent('compact_end')
    // 压缩器返回 undefined 表示"没有真正压缩"，事件必须如实反映
    expect((end?.data as { applied: boolean }).applied).toBe(false)
    expect(observations.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'compact.completed',
          data: expect.objectContaining({ strategy: 'preflight', applied: false }),
        }),
      ]),
    )
  })

  it('provider 报 CONTEXT_EXCEEDED 时做一次 reactive 压缩并重试本轮', async () => {
    // 覆盖 579/581/582/584-588：reactive 压缩与 preflight 是两条不同的入口，
    // 压缩后回到 building_context 重试（而不是直接失败）。
    let reactiveCalls = 0
    const compactor = {
      shouldCompact: () => false,
      compactReactive: () => {
        reactiveCalls += 1
        return Promise.resolve({
          boundaryId: 'b',
          strategy: 'autocompact_v1',
          summary: 's',
          tokensBefore: 1,
          tokensAfter: 1,
        })
      },
    } as unknown as ContextCompactor
    const observations = new InMemoryObservationSink()
    const h = await harness({
      provider: scriptedProvider(
        {
          error: new AgentError({
            code: ErrorCode.CONTEXT_EXCEEDED,
            message: 'too long',
            source: 'test',
          }),
        },
        { events: [text('压缩后成功')] },
      ).provider,
      compactor,
      observationSink: observations,
    })

    const result = await h.runtime.submitMessage(h.conversation.id, 'go')
    expect(result.status).toBe(TurnStatus.COMPLETED)
    expect(result.final_text).toBe('压缩后成功')
    expect(reactiveCalls).toBe(1)
    expect(h.events().map((event) => event.type)).toEqual(
      expect.arrayContaining(['compact_start', 'compact_end']),
    )
    expect(observations.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'compact.completed',
          data: expect.objectContaining({ strategy: 'reactive', applied: true }),
        }),
      ]),
    )
    // 第二次超限时不再压缩，而是按上下文超限收尾（覆盖 590）
    let secondReactive = 0
    const h2 = await harness({
      provider: scriptedProvider(
        {
          error: new AgentError({
            code: ErrorCode.CONTEXT_EXCEEDED,
            message: 'too long',
            source: 'test',
          }),
        },
        {
          error: new AgentError({
            code: ErrorCode.CONTEXT_EXCEEDED,
            message: 'too long',
            source: 'test',
          }),
        },
      ).provider,
      compactor: {
        shouldCompact: () => false,
        compactReactive: () => {
          secondReactive += 1
          return Promise.resolve(undefined)
        },
      } as unknown as ContextCompactor,
    })
    const failed = await h2.runtime.submitMessage(h2.conversation.id, 'go')
    expect(failed.status).toBe(TurnStatus.CONTEXT_EXCEEDED)
    expect(failed.terminal_reason).toBe(TerminalReason.CONTEXT_EXCEEDED)
    expect(secondReactive).toBe(1)
    expect((await persisted(h2.store, h2.conversation.id, failed.turn_id)).phase).toBe(
      TurnPhase.CONTEXT_EXCEEDED,
    )
  })

  it('没有压缩器时 CONTEXT_EXCEEDED 直接以 context_exceeded 收尾', async () => {
    // 覆盖 579(false) / 590：没有压缩器就不能假装"已经处理过"，必须显式失败。
    const h = await harness({
      provider: scriptedProvider({
        error: new AgentError({
          code: ErrorCode.CONTEXT_EXCEEDED,
          message: 'too long',
          source: 'test',
        }),
      }).provider,
    })
    const result = await h.runtime.submitMessage(h.conversation.id, 'go')
    expect(result.status).toBe(TurnStatus.CONTEXT_EXCEEDED)
    expect(result.error).toBe('too long')
  })

  it('压缩过程中用户取消：回到循环顶部即判为 cancelled', async () => {
    // 覆盖 466/467(false)/472：压缩是不可中断的长操作，但**回到循环顶部后**
    // 必须立刻响应取消，而不是继续发一次模型请求。
    const controller = new AbortController()
    const compactor = {
      shouldCompact: () => true,
      compact: () => {
        controller.abort()
        return Promise.resolve(undefined)
      },
    } as unknown as ContextCompactor
    const h = await harness({
      provider: scriptedProvider({ events: [text('不应到达')] }).provider,
      compactor,
    })

    const result = await h.runtime.submitMessage(h.conversation.id, 'go', controller.signal)
    expect(result.status).toBe(TurnStatus.CANCELLED)
    expect(result.terminal_reason).toBe(TerminalReason.CANCELLED)
    expect(result.final_text).toBe('')
  })

  it('压缩期间墙钟耗尽：返回 partial + budget_exceeded，而不是抛非法迁移', async () => {
    // 覆盖循环顶部识别出"墙钟耗尽"后以 partial 收尾的路径。修复前它会抛
    // `building_context -> budget_exceeded`：迁移表里该阶段没有到终态的边，
    // 且 `return finish(...)` 未 await，拒绝绕过 catch 逃到调用方。
    // 现在预算耗尽统一绕行 finalizing（ADR 0003）。
    const compactor = {
      shouldCompact: () => true,
      compact: async () => {
        await delay(WALL_WORK_MS)
        return undefined
      },
    } as unknown as ContextCompactor
    const h = await harness({
      provider: scriptedProvider({ events: [text('不应到达')] }).provider,
      compactor,
      budget: { ...BUDGET, maxWallTimeMs: WALL_BUDGET_MS },
    })

    const result = await h.runtime.submitMessage(h.conversation.id, 'go')
    expect(result.status).toBe(TurnStatus.PARTIAL)
    expect(result.terminal_reason).toBe(TerminalReason.BUDGET_EXCEEDED)
    expect(result.error).toBe('budget exceeded: wallTime')
    // 压缩本身是跑过的——失败点从来不在压缩
    expect(h.events().some((e) => e.type === 'compact_start')).toBe(true)

    const stored = (await h.store.read()).runtime.turns[0]
    expect(stored?.phase).toBe(TurnPhase.BUDGET_EXCEEDED)
    expect(stored?.result?.status).toBe(TurnStatus.PARTIAL)
    // 收尾必须经过 finalizing：那是 BUDGET_EXCEEDED 的唯一入口（ADR 0003）。
    expect(stored?.transitions.map((t) => t.to)).toContain(TurnPhase.FINALIZING)
  })
})

// ─ provider 流与异常 ─────────────────────────────────────────────

describe('provider 流与异常', () => {
  it('多段文本增量合并进同一个 content block', async () => {
    // 覆盖 551：同一条助手消息里的连续 text delta 必须合并，
    // 否则持久化下来会是一堆只有一个字的 block（渲染与回灌都会退化）。
    const h = await harness({
      provider: scriptedProvider({ events: [text('你'), text('好')] }).provider,
    })
    const result = await h.runtime.submitMessage(h.conversation.id, 'go')
    expect(result.final_text).toBe('你好')

    const messages = await h.store.listMessages(h.conversation.id)
    const assistant = messages.find((m) => m.role === 'assistant')
    expect(JSON.parse(assistant?.content ?? '[]')).toEqual([{ type: 'text', text: '你好' }])
  })

  it('thinking 事件既落进 content block 也发出运行时事件（preview 截断到 200 字符）', async () => {
    // 覆盖 555-564：思考内容必须进持久化 blocks（含 signature，回灌时要原样带回），
    // 同时发一条只带摘要的事件供状态栏使用。
    const thinking = 'x'.repeat(260)
    const h = await harness({
      provider: scriptedProvider({
        events: [{ type: ModelEventType.THINKING, thinking, signature: 'sig-1' }, text('结论')],
      }).provider,
    })
    const result = await h.runtime.submitMessage(h.conversation.id, 'go')
    expect(result.status).toBe(TurnStatus.COMPLETED)

    const messages = await h.store.listMessages(h.conversation.id)
    const assistant = messages.find((m) => m.role === 'assistant')
    expect(JSON.parse(assistant?.content ?? '[]')).toEqual([
      { type: 'thinking', thinking, signature: 'sig-1' },
      { type: 'text', text: '结论' },
    ])

    const event = h.findEvent('thinking')
    expect((event?.data as { content: string }).content).toBe(thinking)
    // ️ 契约文档（core/turn.ts 的 ThinkingEvent）说截断后会加 "..."，
    // 实现只做了 slice——差异记录在此，不改实现。
    expect((event?.data as { preview: string }).preview).toHaveLength(200)
  })

  it('流没有返回 usage 时不记录用量', async () => {
    // 覆盖 643：usage 是可选的（部分兼容端点不返回），缺失时不得伪造或崩溃。
    const h = await harness({
      provider: scriptedProvider({ events: [text('无用量')] }).provider,
    })
    const result = await h.runtime.submitMessage(h.conversation.id, 'go')
    expect(result.input_tokens).toBe(0)
    expect(result.output_tokens).toBe(0)
    const end = h.findEvent('turn_end')
    expect((end?.data as { input_tokens: number }).input_tokens).toBe(0)
  })

  it('模型返回空响应：不写入空的助手消息，直接以 completed 收尾', async () => {
    // 覆盖 645(false)：`blocks.length > 0` 的守卫。模型完全不给内容时
    // （既无文本也无工具），写一条 `[]` 的助手消息会污染后续上下文与压缩估算。
    const h = await harness({ provider: scriptedProvider({ events: [] }).provider })
    const result = await h.runtime.submitMessage(h.conversation.id, 'go')

    expect(result.status).toBe(TurnStatus.COMPLETED)
    expect(result.final_text).toBe('')
    const messages = await h.store.listMessages(h.conversation.id)
    expect(messages.some((m) => m.role === 'assistant')).toBe(false)
  })

  it('非暂时性 provider 错误：不重试，直接 failed', async () => {
    // 覆盖 600(false)/604(false)/641：鉴权失败这类错误重试只会浪费配额，
    // parts/09 §9.5 明确不重试、也不降级到别的模型。
    const script = scriptedProvider({
      error: new AgentError({
        code: ErrorCode.PROVIDER_AUTH_FAILED,
        message: '鉴权失败',
        source: 'test',
      }),
    })
    const h = await harness({ provider: script.provider })
    const result = await h.runtime.submitMessage(h.conversation.id, 'go')
    expect(result.status).toBe(TurnStatus.FAILED)
    expect(result.error).toBe('鉴权失败')
    expect(script.callCount()).toBe(1)
    expect((await persisted(h.store, h.conversation.id, result.turn_id)).phase).toBe(
      TurnPhase.FAILED,
    )
  })

  it('暂时性 provider 错误：无候选模型时原地重试两次后 failed', async () => {
    // 覆盖 600(true)/601-602：暂时性错误最多重试 2 次（共 3 次调用）；
    // 没有 router 时没有候选可以降级，超限即失败。
    const script = scriptedProvider({
      error: new AgentError({
        code: ErrorCode.PROVIDER_UNAVAILABLE,
        message: '5xx',
        source: 'test',
      }),
    })
    const h = await harness({ provider: script.provider })
    const result = await h.runtime.submitMessage(h.conversation.id, 'go')
    expect(result.status).toBe(TurnStatus.FAILED)
    expect(result.error).toBe('5xx')
    expect(script.callCount()).toBe(3)
    expect(result.num_turns).toBe(3)
  })

  it('暂时性错误且存在候选模型：切换到下一候选并重写模型快照', async () => {
    // 覆盖 604-640 与 618：重试耗尽后按 candidates 顺序降级。
    // 这里让 providerFactory 对**第二个**候选返回 undefined，从而走 `?? new
    // AnthropicMessagesProvider(...)` 的兜底构造（覆盖 618 而不真的联网）——
    // 该真 provider 的密钥引用指向一个必定不存在的环境变量，因此下一轮
    // 以 PROVIDER_AUTH_FAILED 结束（可断言、离线、确定性）。
    const provider: Provider = {
      id: 'p1',
      name: 'p1',
      baseUrl: 'https://api.example.invalid',
      apiKeyRef: { source: 'env', key: 'DEEPCODE_TEST_UNSET_KEY_2' },
      createdAt: '',
      updatedAt: '',
    }
    const config: ConfigDocument = {
      schema_version: 1,
      llm_channels: [],
      llm_models: [],
      app_settings: {},
      providers: [provider, { ...provider, id: 'p2' }].map((p) => ({ ...p, enabled: true })),
      model_profiles: (['m1', 'm2'] as const).map((id, index) => ({
        id,
        providerId: index === 0 ? 'p1' : 'p2',
        contextWindow: 1000,
        maxOutputTokens: 100,
        supportsThinking: false,
        supportsTools: true,
        supportsVision: false,
        supports1MContext: false,
        enabled: true,
      })),
      tier_assignments: [
        {
          tier: 'implementation',
          modelRef: { providerId: 'p1', modelId: 'm1' },
          enabled: true,
          fallbackModelRefs: [{ providerId: 'p2', modelId: 'm2' }],
        },
      ],
    }
    delete process.env['DEEPCODE_TEST_UNSET_KEY_2']
    const transientProvider: ModelProvider = {
      stream: () => {
        throw new AgentError({
          code: ErrorCode.PROVIDER_UNAVAILABLE,
          message: '5xx',
          source: 'test',
        })
      },
      probe: () => Promise.resolve({ ok: true }),
    }
    // 工厂对第二个候选"明确不给 provider"，从而走到 runtime 的兜底构造
    const noProvider = undefined as unknown as ModelProvider
    const h = await harness({
      router: new ModelRouter(config),
      providerFactory: (route) => (route.model.id === 'm1' ? transientProvider : noProvider),
    })

    const result = await h.runtime.submitMessage(h.conversation.id, 'go')
    expect(result.status).toBe(TurnStatus.FAILED)
    // 第二轮走的是真实 Anthropic provider → 缺密钥
    expect(result.error).toBe('provider secret is unavailable')

    const turn = await persisted(h.store, h.conversation.id, result.turn_id)
    expect(turn.modelSnapshot?.modelId).toBe('m2')
    expect(turn.routeSnapshot?.provider.id).toBe('p2')
  })

  it('provider 挂起触墙钟上限：返回 partial + budget_exceeded（生产里最常见的入口）', async () => {
    // 流式响应卡住 → 墙钟预算到点 → runSignal 被超时中止。修复前这条路径会抛
    // `calling_model -> budget_exceeded`，把纯资源限制报成内部状态机错误，
    // 并且因为 `return finish(...)` 未 await 而绕过 catch，最终锁死会话。
    const script = scriptedProvider({ hang: true })
    const h = await harness({
      provider: script.provider,
      budget: { ...BUDGET, maxWallTimeMs: WALL_BUDGET_MS },
    })

    const pending = h.runtime.submitMessage(h.conversation.id, 'go')
    await script.firstCall // 确保已经进入 provider 流，超时才算数
    const result = await pending
    expect(result.status).toBe(TurnStatus.PARTIAL)
    expect(result.terminal_reason).toBe(TerminalReason.BUDGET_EXCEEDED)

    const stored = (await h.store.read()).runtime.turns[0]
    expect(stored?.phase).toBe(TurnPhase.BUDGET_EXCEEDED)
    expect(stored?.result?.status).toBe(TurnStatus.PARTIAL)
    // turn_end 必须发出——收尾逻辑真的走到了最后一步（修复前根本到不了）。
    expect(h.events().some((e) => e.type === 'turn_end')).toBe(true)
    // 会话没有被锁死：下一个 turn 能正常起来。
    await expect(h.runtime.submitMessage(h.conversation.id, 'again')).resolves.toBeDefined()
  })
})

// ── 工具循环与工作记忆 ────────────────────────────────────────────

describe('工具循环与工作记忆', () => {
  it('todo_write 的结果收敛进 openTasks（完成的条目不进）', async () => {
    // 覆盖 687-699 与 672 的 filter 回调：pendingToolCalls 在工具执行完后必须清空，
    // 未完成任务进 openTasks，已完成的不进（否则恢复时会把已完成的事再提一遍）。
    const h = await harness({
      provider: scriptedProvider(
        {
          events: [
            toolUse('c1', 'todo_write', {
              todos: [
                { content: 'a', status: 'pending' },
                { content: 'b', status: 'completed' },
                { content: 'c', status: 'in_progress' },
              ],
            }),
            // 同一轮内第二个工具调用：用于覆盖"从非空 pendingToolCalls 中过滤"的回调
            toolUse('c2', 'todo_write', { todos: [{ content: 'd', status: 'pending' }] }),
          ],
          usage: { inputTokens: 1, outputTokens: 1 },
        },
        { events: [text('done')], usage: { inputTokens: 1, outputTokens: 1 } },
      ).provider,
      register: (registry) => registry.register(createTodoWriteTool()),
    })

    const result = await h.runtime.submitMessage(h.conversation.id, 'go')
    expect(result.status).toBe(TurnStatus.COMPLETED)
    expect(result.tool_rounds).toBe(1)

    const turn = await persisted(h.store, h.conversation.id, result.turn_id)
    expect(turn.workingMemory.openTasks).toEqual(['d'])
    expect(turn.workingMemory.pendingToolCalls).toEqual([])
    expect(turn.workingMemory.permissionDecisions).toHaveLength(2)
    expect(turn.workingMemory.permissionDecisions[0]).toMatchObject({
      toolCallId: 'c1',
      toolName: 'todo_write',
      action: 'allow',
      resolution: 'executed',
    })
  })

  it('file_write 新建文件记为 created（beforeHash 为 null），覆盖已有文件记为 modified', async () => {
    // 覆盖 700-723（含 711/714）：fileChanges 是恢复与"外部改动检测"的依据，
    // 必须区分 created / modified 并带上前后哈希。
    const h = await harness({
      provider: scriptedProvider(
        {
          events: [
            toolUse('c1', 'file_write', { path: 'new.txt', content: 'fresh' }),
            toolUse('c2', 'file_write', { path: 'exist.txt', content: 'next' }),
          ],
          usage: { inputTokens: 1, outputTokens: 1 },
        },
        { events: [text('done')], usage: { inputTokens: 1, outputTokens: 1 } },
      ).provider,
      register: (registry) => registry.register(createFileWriteTool()),
      mode: PermissionMode.AUTO_EDIT,
    })
    await writeFile(join(h.dir, 'exist.txt'), 'old')

    const result = await h.runtime.submitMessage(h.conversation.id, 'go')
    expect(result.status).toBe(TurnStatus.COMPLETED)

    const turn = await persisted(h.store, h.conversation.id, result.turn_id)
    const changes = turn.workingMemory.fileChanges
    expect(changes).toHaveLength(2)
    expect(changes[0]).toMatchObject({
      path: join(h.dir, 'new.txt'),
      kind: 'created',
      beforeHash: null,
      afterHash: createHash('sha256').update('fresh').digest('hex'),
    })
    expect(changes[1]).toMatchObject({
      path: join(h.dir, 'exist.txt'),
      kind: 'modified',
      beforeHash: createHash('sha256').update('old').digest('hex'),
      afterHash: createHash('sha256').update('next').digest('hex'),
    })
  })

  it('工具以 ok=false 且 error_code 为 null 返回时，决策记录用 error 兜底', async () => {
    // 覆盖 738 的 `?? 'error'`：错误码缺失时不能让审计字段变成 undefined
    // （落盘后无法区分"没记录"与"没有错误码"）。
    const h = await harness({
      provider: scriptedProvider(
        {
          events: [toolUse('c1', 'softfail', {})],
          usage: { inputTokens: 1, outputTokens: 1 },
        },
        { events: [text('done')], usage: { inputTokens: 1, outputTokens: 1 } },
      ).provider,
      register: (registry) =>
        registry.register(
          fakeTool('softfail', () =>
            Promise.resolve({
              ok: false,
              content: '软失败',
              error_code: null,
              meta: { request_id: 'req-loop' },
            }),
          ),
        ),
      mode: PermissionMode.YOLO,
    })

    const result = await h.runtime.submitMessage(h.conversation.id, 'go')
    expect(result.status).toBe(TurnStatus.COMPLETED)
    // 失败的工具不该污染 lastToolError（error_code 为 null）
    expect(result.last_tool_error).toBeNull()

    const turn = await persisted(h.store, h.conversation.id, result.turn_id)
    expect(turn.workingMemory.permissionDecisions[0]).toMatchObject({
      action: 'deny',
      resolution: 'error',
      reason: '软失败',
      requestId: 'req-loop',
    })
  })

  it('模型发起新工具调用时，陈旧的 pendingToolCalls 只按同名清理（可疑行为，固化现状）', async () => {
    // 覆盖 672 的 filter 回调：正常路径下 pendingToolCalls 在每轮工具里
    // "加入前过滤、写回后再删"，因此那个回调几乎不会被执行；只有恢复时留下的
    // 陈旧条目能让它跑起来。
    // ⚠️ 可疑行为（已固化，未修改实现）：陈旧条目（其执行记录已不存在）不会被
    // 自动回收——恢复逻辑只清理与已持久化记录配对的项（见 438-442 行）。
    // 结果是 workingMemory 里会残留一个永远消不掉的 pendingToolCall，并被继续落盘。
    const h = await harness({
      provider: scriptedProvider(
        {
          events: [toolUse('c1', 'todo_write', { todos: [{ content: 'new', status: 'pending' }] })],
          usage: { inputTokens: 1, outputTokens: 1 },
        },
        { events: [text('done')], usage: { inputTokens: 1, outputTokens: 1 } },
      ).provider,
      register: (registry) => registry.register(createTodoWriteTool()),
    })
    const turn = await seedTurn(
      h.store,
      h.conversation.id,
      TurnPhase.AWAITING_PERMISSION,
      {},
      {
        ...EMPTY_WORKING_MEMORY,
        pendingToolCalls: [{ toolCallId: 'stale', toolName: 'todo_write', input: {} }],
      },
    )

    const result = await h.runtime.resumeTurn(h.conversation.id, turn.turnId as TurnId)
    expect(result.status).toBe(TurnStatus.COMPLETED)
    const stored = await persisted(h.store, h.conversation.id, result.turn_id)
    expect(stored.workingMemory.pendingToolCalls.map((p) => p.toolCallId)).toEqual(['stale'])
  })

  it('工具报 PERMISSION_REQUIRED：有元数据时原样透传，缺元数据时用安全兜底值', async () => {
    // 覆盖 772-793 的**两侧**（776/787/792 的取值与兜底）。
    // 这条分支只在**没有审批服务**时可达（有 broker 时事件由 broker 发出）。
    //
    // ⚠️ 可疑行为（已固化，未修改实现）：缺元数据时兜底出的 `request_id` 是空串，
    // 客户端拿它无法回灌审批（审批请求根本不存在）；`risk_level` 恒为 'medium'
    // （哪怕真实风险更高），`expires_at` 用当前时钟现算。旧实现同样硬编码
    // medium + now+120s，因此这里按 bug-compatible **保留**，并用测试固化，
    // 以免它被当成"新缺陷"顺手改掉、或反过来被当成正确行为扩散。
    const h = await harness({
      provider: scriptedProvider(
        {
          events: [toolUse('c1', 'selfask', {}), toolUse('c2', 'selfask_meta', {})],
          usage: { inputTokens: 1, outputTokens: 1 },
        },
        { events: [text('done')], usage: { inputTokens: 1, outputTokens: 1 } },
      ).provider,
      register: (registry) =>
        registry.register(
          fakeTool('selfask', () =>
            Promise.resolve({
              ok: false,
              content: '需要人工审批',
              error_code: ErrorCode.PERMISSION_REQUIRED,
              meta: {},
            }),
          ),
        ),
      mode: PermissionMode.YOLO,
    })
    h.registry.register(
      fakeTool('selfask_meta', () =>
        Promise.resolve({
          ok: false,
          content: '需要人工审批',
          error_code: ErrorCode.PERMISSION_REQUIRED,
          meta: { request_id: 'req-7', risk_level: 'high', expires_at: 1_900_000_000_000 },
        }),
      ),
    )

    await h.runtime.submitMessage(h.conversation.id, 'go')
    const events = h
      .events()
      .filter((e) => e.type === 'permission_required')
      .map(
        (e) =>
          e.data as {
            request_id: string
            risk_level: string
            expires_at: number
            tool_name: string
            args_preview: string
            reason: string
          },
      )
    expect(events).toHaveLength(2)

    const [fallback, passthrough] = events
    expect(fallback).toMatchObject({
      request_id: '',
      risk_level: 'medium',
      tool_name: 'selfask',
      reason: '需要人工审批',
    })
    expect(fallback?.expires_at).toBeGreaterThan(Date.now())
    expect(typeof fallback?.args_preview).toBe('string')

    // 有元数据时必须是真实值——审批 UI 就靠 request_id 回灌
    expect(passthrough).toMatchObject({
      request_id: 'req-7',
      risk_level: 'high',
      expires_at: 1_900_000_000_000,
      tool_name: 'selfask_meta',
    })
  })
})

// ── 恢复：待执行工具、routeSnapshot、skillGuards ──────────────────

describe('恢复搁置的工作', () => {
  const pendingRecord = (
    sessionId: SessionId,
    turnId: string,
    toolName: string,
    input: Readonly<Record<string, unknown>>,
    status: ToolExecutionStatus,
  ) => ({
    executionId: `exec-${toolName}`,
    sessionId,
    turnId: turnId as TurnId,
    toolCallId: `call-${toolName}` as never,
    toolName,
    inputHash: inputHash(input),
    status,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    errorCode: null,
    elapsedMs: null,
    input,
    descriptorVersion: '1.0.0',
    idempotent: true,
    principalId: 'p',
  })

  it('停在 awaiting_permission 且有 PENDING 执行：先回到 executing_tools 再重放工具', async () => {
    // 覆盖 384(true)/385/409/441/461(true)：
    // 崩溃后"工具已持久化但结果未写回"是最常见的残留状态，必须真正重放它，
    // 否则模型会看到悬空的 tool_use。
    const todos = [{ content: 'resume me', status: 'pending' }]
    const h = await harness({
      provider: scriptedProvider({
        events: [text('恢复完成')],
        usage: { inputTokens: 1, outputTokens: 1 },
      }).provider,
      register: (registry) => registry.register(createTodoWriteTool()),
    })
    const turn = await seedTurn(
      h.store,
      h.conversation.id,
      TurnPhase.AWAITING_PERMISSION,
      {},
      {
        ...EMPTY_WORKING_MEMORY,
        pendingToolCalls: [
          { toolCallId: 'call-todo_write', toolName: 'todo_write', input: { todos } },
        ],
      },
    )
    await h.store.addToolExecution(
      pendingRecord(
        h.conversation.id,
        turn.turnId,
        'todo_write',
        { todos },
        ToolExecutionStatus.PENDING,
      ),
    )

    const result = await h.runtime.resumeTurn(h.conversation.id, turn.turnId as TurnId)
    expect(result.status).toBe(TurnStatus.COMPLETED)
    expect(result.final_text).toBe('恢复完成')

    const executions = await h.store.listToolExecutions(h.conversation.id)
    expect(executions[0]?.status).toBe(ToolExecutionStatus.SUCCESS)
    const messages = await h.store.listMessages(h.conversation.id)
    expect(messages.some((m) => m.subtype === 'tool_result')).toBe(true)

    // workingMemory 里的悬空 pendingToolCalls 必须被清掉，并留下审批决策记录
    const stored = await persisted(h.store, h.conversation.id, result.turn_id)
    expect(stored.workingMemory.pendingToolCalls).toEqual([])
    expect(stored.workingMemory.permissionDecisions).toHaveLength(1)
    expect(stored.transitions.map((t) => `${t.from}->${t.to}`)).toContain(
      'awaiting_permission->executing_tools',
    )
  })

  it('残留工具的结果已经写回时：不重复写消息、不重复发事件', async () => {
    // 覆盖 413(false)：崩溃窗口可能是"工具结果已落盘、但执行记录还没更新"。
    // 此时如果无条件再 addMessage，模型历史里会出现**两条** tool_result，
    // 上下文从此与真实执行对不上。
    const todos = [{ content: 'resume me', status: 'pending' }]
    const h = await harness({
      provider: scriptedProvider({
        events: [text('继续')],
        usage: { inputTokens: 1, outputTokens: 1 },
      }).provider,
      register: (registry) => registry.register(createTodoWriteTool()),
    })
    const turn = await seedTurn(h.store, h.conversation.id, TurnPhase.EXECUTING_TOOLS)
    await h.store.addToolExecution(
      pendingRecord(
        h.conversation.id,
        turn.turnId,
        'todo_write',
        { todos },
        ToolExecutionStatus.PENDING,
      ),
    )
    // 预先写回一份工具结果（模拟上一进程已写消息、未更新执行记录）
    await h.store.addMessage({
      conversation_id: h.conversation.id,
      role: 'tool',
      content: JSON.stringify({ tool_use_id: 'call-todo_write', content: 'already persisted' }),
      turn_id: turn.turnId as TurnId,
      subtype: 'tool_result',
      tool_call_id: 'call-todo_write',
      meta: '{}',
      agent_type: '',
    })

    const result = await h.runtime.resumeTurn(h.conversation.id, turn.turnId as TurnId)
    expect(result.status).toBe(TurnStatus.COMPLETED)

    const messages = await h.store.listMessages(h.conversation.id)
    const toolResults = messages.filter((m) => m.subtype === 'tool_result')
    expect(toolResults).toHaveLength(1)
    expect(toolResults[0]?.content).toContain('already persisted')
    expect(h.events().some((e) => e.type === 'tool_result')).toBe(false)
    // 执行记录仍然会被推进到 success（工具确实被重放了一次）
    expect((await h.store.listToolExecutions(h.conversation.id))[0]?.status).toBe(
      ToolExecutionStatus.SUCCESS,
    )
  })

  it('停在 executing_tools 且没有残留执行记录：直接回到 calling_model', async () => {
    // 覆盖 461(true) 的另一半：没有待重放的工具时不能停在 executing_tools
    // （那里没有到终态的边，会卡死）。
    const h = await harness({
      provider: scriptedProvider({
        events: [text('继续')],
        usage: { inputTokens: 1, outputTokens: 1 },
      }).provider,
    })
    const turn = await seedTurn(h.store, h.conversation.id, TurnPhase.EXECUTING_TOOLS)

    const result = await h.runtime.resumeTurn(h.conversation.id, turn.turnId as TurnId)
    expect(result.status).toBe(TurnStatus.COMPLETED)
    const stored = await persisted(h.store, h.conversation.id, result.turn_id)
    expect(stored.transitions.map((t) => `${t.from}->${t.to}`)).toContain(
      'executing_tools->calling_model',
    )
  })

  it('停在 awaiting_permission 且没有残留执行记录：不额外迁移，直接续跑', async () => {
    // 覆盖 384(false)/461(false)：审批可能已经被外部解决，此时不该凭空造出
    // 一次 executing_tools 迁移（那会在审计里留下从未发生的状态）。
    const h = await harness({
      provider: scriptedProvider({
        events: [text('继续')],
        usage: { inputTokens: 1, outputTokens: 1 },
      }).provider,
    })
    const turn = await seedTurn(h.store, h.conversation.id, TurnPhase.AWAITING_PERMISSION)

    const result = await h.runtime.resumeTurn(h.conversation.id, turn.turnId as TurnId)
    expect(result.status).toBe(TurnStatus.COMPLETED)
    const stored = await persisted(h.store, h.conversation.id, result.turn_id)
    expect(stored.transitions.map((t) => t.from)).not.toContain(TurnPhase.EXECUTING_TOOLS)
  })

  it('UNKNOWN 执行记录绝不自动重放，只写回"需人工确认"的结果', async () => {
    // 覆盖 391/425/447/450/451：未知状态意味着副作用**可能已经发生**，
    // parts/09 §2 要求不得幂等重放。同时覆盖决策记录的兜底字段：
    // - meta 没有 request_id → requestId 退化为 ''
    // - ok=false → action 'deny'
    let executed = 0
    const h = await harness({
      provider: scriptedProvider({
        events: [text('继续')],
        usage: { inputTokens: 1, outputTokens: 1 },
      }).provider,
      register: (registry) =>
        registry.register(
          fakeTool('rarely_run', () => {
            executed += 1
            return Promise.resolve(okResult('不该被执行'))
          }),
        ),
    })
    const turn = await seedTurn(h.store, h.conversation.id, TurnPhase.EXECUTING_TOOLS)
    await h.store.addToolExecution(
      pendingRecord(h.conversation.id, turn.turnId, 'rarely_run', {}, ToolExecutionStatus.UNKNOWN),
    )

    const result = await h.runtime.resumeTurn(h.conversation.id, turn.turnId as TurnId)
    expect(executed).toBe(0) // 关键：没有被重放
    expect(result.status).toBe(TurnStatus.COMPLETED)

    const messages = await h.store.listMessages(h.conversation.id)
    const toolResult = messages.find((m) => m.subtype === 'tool_result')
    expect(toolResult?.content).toContain('tool execution status is unknown')

    const stored = await persisted(h.store, h.conversation.id, result.turn_id)
    expect(stored.workingMemory.permissionDecisions[0]).toMatchObject({
      requestId: '',
      action: 'deny',
      resolution: ErrorCode.TOOL_EXECUTION_UNKNOWN,
    })
    expect(stored.lastToolError).toBe(ErrorCode.TOOL_EXECUTION_UNKNOWN)
  })

  it('重放残留工具时把 ok=false / 空 data / 字符串 request_id 如实写进决策记录', async () => {
    // 覆盖 425(false)/447(true)/451：工具返回 data 为 undefined、meta 带 request_id
    // 时，决策记录必须原样反映（requestId 取真值而不是空串）。
    const h = await harness({
      provider: scriptedProvider({
        events: [text('继续')],
        usage: { inputTokens: 1, outputTokens: 1 },
      }).provider,
      register: (registry) =>
        registry.register(
          fakeTool('denier', () =>
            Promise.resolve({
              ok: false,
              content: '被拒绝',
              error_code: 'PERMISSION_DENIED',
              meta: { request_id: 'req-9' },
            }),
          ),
        ),
      mode: PermissionMode.YOLO,
    })
    // 再加一个"失败但没给错误码"的工具：429-451 那一组决策记录同样需要
    // 覆盖 `error_code ?? 'error'` 的兜底一侧。
    h.registry.register(
      fakeTool('softfail', () =>
        Promise.resolve({
          ok: false,
          content: '软失败',
          error_code: null,
          meta: {},
        }),
      ),
    )
    const turn = await seedTurn(h.store, h.conversation.id, TurnPhase.EXECUTING_TOOLS)
    await h.store.addToolExecution(
      pendingRecord(h.conversation.id, turn.turnId, 'denier', {}, ToolExecutionStatus.PENDING),
    )
    await h.store.addToolExecution(
      pendingRecord(h.conversation.id, turn.turnId, 'softfail', {}, ToolExecutionStatus.PENDING),
    )

    const result = await h.runtime.resumeTurn(h.conversation.id, turn.turnId as TurnId)
    expect(result.status).toBe(TurnStatus.COMPLETED)
    const stored = await persisted(h.store, h.conversation.id, result.turn_id)
    expect(stored.workingMemory.permissionDecisions[0]).toMatchObject({
      requestId: 'req-9',
      action: 'deny',
      resolution: 'PERMISSION_DENIED',
    })
    expect(stored.workingMemory.permissionDecisions[1]).toMatchObject({
      requestId: '',
      action: 'deny',
      resolution: 'error',
    })
  })

  it('routeSnapshot 存在时按快照重建路由（不重新路由），并把 factory 用在该路由上', async () => {
    // 覆盖 326-362：恢复必须使用 turn 固定的模型快照，否则重启后配置变化会让
    // 同一个 turn 换模型继续跑（历史不可复现）。
    const snapshotProvider: Provider = {
      id: 'snap-provider',
      name: 'snap',
      baseUrl: 'https://api.example.invalid',
      apiKeyRef: { source: 'env', key: 'DEEPCODE_TEST_UNSET_KEY' },
      createdAt: '',
      updatedAt: '',
    }
    const h = await harness({})
    const turn = await seedTurn(h.store, h.conversation.id, TurnPhase.BUILDING_CONTEXT, {
      routeSnapshot: {
        provider: snapshotProvider,
        model: {
          id: 'snap-model',
          providerId: 'snap-provider',
          contextWindow: 4096,
          maxOutputTokens: 512,
          supportsThinking: false,
          supportsTools: true,
          supportsVision: false,
          supports1MContext: false,
          enabled: true,
        },
        tier: 'implementation',
      },
    })

    const seen: ResolvedModelRoute[] = []
    const script = scriptedProvider({ events: [text('快照恢复')] })
    const withFactory = new AgentRuntime({
      chatStore: h.store,
      contextBuilder: new ContextBuilder({ chatStore: h.store, tools: () => [] }),
      toolExecutor: h.executor,
      eventSink: h.sink,
      workspaceRoot: h.dir,
      principalId: 'p',
      providerFactory: (route) => {
        seen.push(route)
        return script.provider
      },
    })

    const result = await withFactory.resumeTurn(h.conversation.id, turn.turnId as TurnId)
    expect(result.status).toBe(TurnStatus.COMPLETED)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.model.id).toBe('snap-model')
    // 候选列表只含快照本身——不允许从快照里凭空展开出别的候选
    expect(seen[0]?.candidates).toEqual([{ providerId: 'snap-provider', modelId: 'snap-model' }])
    // 请求里用的是快照的 maxOutputTokens
    expect(script.requests[0]?.maxTokens).toBe(512)
  })

  it('source=value 只留在全局配置，不复制进 turn routeSnapshot', async () => {
    const inlineSecret = 'direct-config-secret-without-known-prefix'
    const provider: Provider = {
      id: 'inline-provider',
      name: 'inline',
      baseUrl: 'https://api.example.invalid',
      apiKeyRef: { source: 'value', key: inlineSecret },
      createdAt: '',
      updatedAt: '',
    }
    const model = {
      id: 'inline-model',
      providerId: provider.id,
      contextWindow: 4096,
      maxOutputTokens: 512,
      supportsThinking: false,
      supportsTools: true,
      supportsVision: false,
      supports1MContext: false,
      enabled: true,
    }
    const config: ConfigDocument = {
      schema_version: 1,
      llm_channels: [],
      llm_models: [],
      app_settings: {},
      providers: [{ ...provider, enabled: true }],
      model_profiles: [model],
      tier_assignments: [
        {
          tier: 'implementation',
          modelRef: { providerId: provider.id, modelId: model.id },
          enabled: true,
          fallbackModelRefs: [],
        },
      ],
    }
    const script = scriptedProvider({ events: [text('ok')] })
    const h = await harness({
      router: new ModelRouter(config),
      providerFactory: () => script.provider,
    })

    const result = await h.runtime.submitMessage(h.conversation.id, 'go')
    const stored = await persisted(h.store, h.conversation.id, result.turn_id)
    expect(JSON.stringify(stored)).not.toContain(inlineSecret)
    expect(stored.routeSnapshot?.provider).not.toHaveProperty('apiKeyRef')
  })

  it('恢复无凭据快照时从当前 config 补取 source=value，但仍不重新落盘', async () => {
    const inlineSecret = 'direct-config-secret-for-resume'
    const provider: Provider = {
      id: 'inline-provider',
      name: 'inline',
      baseUrl: 'https://api.example.invalid',
      apiKeyRef: { source: 'value', key: inlineSecret },
      createdAt: '',
      updatedAt: '',
    }
    const model = {
      id: 'inline-model',
      providerId: provider.id,
      contextWindow: 4096,
      maxOutputTokens: 512,
      supportsThinking: false,
      supportsTools: true,
      supportsVision: false,
      supports1MContext: false,
      enabled: true,
    }
    const config: ConfigDocument = {
      schema_version: 1,
      llm_channels: [],
      llm_models: [],
      app_settings: {},
      providers: [{ ...provider, enabled: true }],
      model_profiles: [model],
      tier_assignments: [],
    }
    const seen: Provider[] = []
    const script = scriptedProvider({ events: [text('恢复')] })
    const h = await harness({
      router: new ModelRouter(config),
      providerFactory: (route) => {
        seen.push(route.provider)
        return script.provider
      },
    })
    const turn = await seedTurn(h.store, h.conversation.id, TurnPhase.BUILDING_CONTEXT, {
      routeSnapshot: {
        provider: {
          id: provider.id,
          name: provider.name,
          baseUrl: provider.baseUrl,
          createdAt: provider.createdAt,
          updatedAt: provider.updatedAt,
        },
        model,
        tier: 'implementation',
      },
    })

    const result = await h.runtime.resumeTurn(h.conversation.id, turn.turnId as TurnId)
    expect(result.status).toBe(TurnStatus.COMPLETED)
    expect(seen[0]?.apiKeyRef).toEqual({ source: 'value', key: inlineSecret })
    expect(
      JSON.stringify(await persisted(h.store, h.conversation.id, result.turn_id)),
    ).not.toContain(inlineSecret)
  })

  it('routeSnapshot 存在但没有 providerFactory：兜底构造真实 provider，缺密钥即以 failed 收尾', async () => {
    // 覆盖 341：没有注入工厂时 runtime 会自己构造 Anthropic provider。
    // 该 provider 的密钥引用指向一个必定不存在的环境变量，因此这一轮
    // 确定性地以 PROVIDER_AUTH_FAILED 结束（离线、不发起任何网络请求）。
    delete process.env['DEEPCODE_TEST_UNSET_KEY']
    const h = await harness({})
    const turn = await seedTurn(h.store, h.conversation.id, TurnPhase.BUILDING_CONTEXT, {
      routeSnapshot: {
        provider: {
          id: 'snap-provider',
          name: 'snap',
          baseUrl: 'https://api.example.invalid',
          apiKeyRef: { source: 'env', key: 'DEEPCODE_TEST_UNSET_KEY' },
          createdAt: '',
          updatedAt: '',
        },
        model: {
          id: 'snap-model',
          providerId: 'snap-provider',
          contextWindow: 4096,
          maxOutputTokens: 512,
          supportsThinking: false,
          supportsTools: true,
          supportsVision: false,
          supports1MContext: false,
          enabled: true,
        },
        tier: 'implementation',
      },
    })

    const result = await h.runtime.resumeTurn(h.conversation.id, turn.turnId as TurnId)
    expect(result.status).toBe(TurnStatus.FAILED)
    expect(result.error).toBe('provider secret is unavailable')
  })

  it('skillGuards 从持久化的 turn 透传给工具执行（权限引擎能看到它们）', async () => {
    // 覆盖 409：skill 守护必须随 turn 落盘并传给权限引擎，否则重启后
    // 同一个 turn 会以更宽松的权限继续跑（委派/守护被静默绕过）。
    const guards: readonly SkillGuardRef[] = [
      {
        guardId: 'g1',
        skillName: 'review',
        guardType: 'deny_tool',
        action: PermissionAction.ASK,
        reason: 'review skill 要求确认',
        parameters: {},
      },
    ]
    const seen: unknown[] = []
    const engine = new DefaultPermissionEngine()
    const h = await harness({
      provider: scriptedProvider({
        events: [text('继续')],
        usage: { inputTokens: 1, outputTokens: 1 },
      }).provider,
      register: (registry) => registry.register(createTodoWriteTool()),
      permissionEngine: {
        decide: (query) => {
          seen.push(query.skillGuards)
          return engine.decide(query)
        },
      },
    })
    const turn = await seedTurn(
      h.store,
      h.conversation.id,
      TurnPhase.EXECUTING_TOOLS,
      { skillGuards: guards },
      EMPTY_WORKING_MEMORY,
    )
    await h.store.addToolExecution(
      pendingRecord(
        h.conversation.id,
        turn.turnId,
        'todo_write',
        { todos: [{ content: 'x', status: 'pending' }] },
        ToolExecutionStatus.PENDING,
      ),
    )

    await h.runtime.resumeTurn(h.conversation.id, turn.turnId as TurnId)
    expect(seen[0]).toEqual(guards)
  })

  it('从 awaiting_user_input 恢复：直接回到 calling_model 而不是重放提问', async () => {
    // 覆盖 318/319：等待用户提问的 turn 重启后不能让问题悬空——
    // 提问由 executor 消化（超时回灌 {"_timeout": true}），runtime 只负责续跑。
    const h = await harness({
      provider: scriptedProvider({
        events: [text('用户已答')],
        usage: { inputTokens: 1, outputTokens: 1 },
      }).provider,
    })
    const turn = await seedTurn(h.store, h.conversation.id, TurnPhase.AWAITING_USER_INPUT)

    const result = await h.runtime.resumeTurn(h.conversation.id, turn.turnId as TurnId)
    expect(result.status).toBe(TurnStatus.COMPLETED)
    expect(result.final_text).toBe('用户已答')
    const stored = await persisted(h.store, h.conversation.id, result.turn_id)
    expect(stored.transitions.map((t) => `${t.from}->${t.to}`)).toContain(
      'awaiting_user_input->calling_model',
    )
  })
})

// ── 取消与墙钟超时（工具执行之后） ────────────────────────────────

describe('工具执行后的取消与超时', () => {
  it('工具执行期间用户取消：工具结果仍写回，随后以 cancelled 收尾且事件带 cancelled 标志', async () => {
    // 覆盖 795(true)/797(false)/802。
    // ⚠️ 行为说明（已固化）：取消检查在**工具结果写回之后**，因此被取消的那次
    // 工具调用仍会留下 tool_result——这是刻意的（否则模型历史里会出现悬空的
    // tool_use，恢复时无法判断副作用是否发生）。测试固定这个顺序。
    const controller = new AbortController()
    const h = await harness({
      provider: scriptedProvider(
        { events: [toolUse('c1', 'canceller', {})], usage: { inputTokens: 1, outputTokens: 1 } },
        { events: [text('不应到达')], usage: { inputTokens: 1, outputTokens: 1 } },
      ).provider,
      register: (registry) =>
        registry.register(
          fakeTool('canceller', () => {
            controller.abort()
            return Promise.resolve(okResult('已执行'))
          }),
        ),
      mode: PermissionMode.YOLO,
    })

    const result = await h.runtime.submitMessage(h.conversation.id, 'go', controller.signal)
    expect(result.status).toBe(TurnStatus.CANCELLED)
    expect(result.terminal_reason).toBe(TerminalReason.CANCELLED)
    expect(result.error).toBeNull()

    const messages = await h.store.listMessages(h.conversation.id)
    expect(messages.some((m) => m.subtype === 'tool_result')).toBe(true)
    const end = h.findEvent('turn_end')
    expect((end?.data as { cancelled?: boolean }).cancelled).toBe(true)
  })

  it('工具执行期间墙钟耗尽：partial + wallTime（不是 cancelled）', async () => {
    // 覆盖 795(true)/797(true)：工具自身的超时是 120s，但 turn 的墙钟预算更紧，
    // 此时必须报预算耗尽——把它报成"用户取消"会让 UI 重发排队中的 prompt。
    const h = await harness({
      provider: scriptedProvider(
        { events: [toolUse('c1', 'slow', {})], usage: { inputTokens: 1, outputTokens: 1 } },
        { events: [text('不应到达')], usage: { inputTokens: 1, outputTokens: 1 } },
      ).provider,
      register: (registry) =>
        registry.register(
          fakeTool('slow', async () => {
            await delay(WALL_WORK_MS)
            return okResult('慢工具完成了')
          }),
        ),
      mode: PermissionMode.YOLO,
      budget: { ...BUDGET, maxWallTimeMs: WALL_BUDGET_MS },
    })

    const result = await h.runtime.submitMessage(h.conversation.id, 'go')
    expect(result.status).toBe(TurnStatus.PARTIAL)
    expect(result.terminal_reason).toBe(TerminalReason.BUDGET_EXCEEDED)
    expect(result.error).toBe('budget exceeded: wallTime')
  })
})

// ─ 异常兜底 ──────────────────────────────────────────────────────

describe('runTurn 外层异常兜底', () => {
  it('上下文组装抛异常：failed + 归一化后的错误消息', async () => {
    // 覆盖 821-830 的"既没超时也没取消"一侧：任何逃出内层 try 的异常都必须
    // 变成结构化结果，而不是让 submitMessage 直接抛给 UI。
    const h = await harness({
      provider: scriptedProvider({ events: [text('x')] }).provider,
      buildContext: {
        build: () => {
          throw new Error('组装上下文炸了')
        },
      },
    })
    const result = await h.runtime.submitMessage(h.conversation.id, 'go')
    expect(result.status).toBe(TurnStatus.FAILED)
    expect(result.terminal_reason).toBe(TerminalReason.ERROR)
    expect(result.error).toBe('组装上下文炸了')
  })

  it('上下文组装抛异常且期间被取消：cancelled（而不是 failed）', async () => {
    // 覆盖 822/823/827/828/830(null)：取消是控制流不是错误，
    // 即便异常恰好同时发生，也应当以取消收尾。
    const controller = new AbortController()
    const h = await harness({
      provider: scriptedProvider({ events: [text('x')] }).provider,
      buildContext: {
        build: () => {
          controller.abort()
          throw new Error('取消后抛出的异常')
        },
      },
    })
    const result = await h.runtime.submitMessage(h.conversation.id, 'go', controller.signal)
    expect(result.status).toBe(TurnStatus.CANCELLED)
    expect(result.terminal_reason).toBe(TerminalReason.CANCELLED)
    expect(result.error).toBeNull()
  })

  it('上下文组装抛异常且墙钟已耗尽：按 partial + budget_exceeded 收尾', async () => {
    // 外层 catch 的语义是"墙钟优先"：预算耗尽 + 异常同时发生时，报预算耗尽而不是
    // 失败。修复前这句话本身也逃逸（`return finish(...)` 未 await，且
    // building_context 没有到终态的边），于是"异常兜底"在最需要它的时候失效。
    const h = await harness({
      provider: scriptedProvider({ events: [text('x')] }).provider,
      budget: { ...BUDGET, maxWallTimeMs: WALL_BUDGET_MS },
      buildContext: {
        build: async () => {
          await delay(WALL_WORK_MS)
          throw new Error('超时后抛出的异常')
        },
      },
    })
    const result = await h.runtime.submitMessage(h.conversation.id, 'go')
    expect(result.status).toBe(TurnStatus.PARTIAL)
    expect(result.terminal_reason).toBe(TerminalReason.BUDGET_EXCEEDED)
    expect(result.error).toBe('budget exceeded: wallTime')
    const stored = (await h.store.read()).runtime.turns[0]
    expect(stored?.phase).toBe(TurnPhase.BUDGET_EXCEEDED)
  })
})

// ── 思考配置的消费与路由变更事件 ───────────────────────────────────

/**
 * `ModelRequest.thinking` 的产出与 `model_route_changed` 的发射。
 *
 * 这一段钉住 Phase 6 收尾时打通的那条链路：命令层写进 `ModelProfile` 的
 * 运行偏好，必须**真的**变成请求体里的 `thinking` 字段。此前它只被 TUI 状态栏
 * 读来显示，写配置不产生任何行为变化——那正是 `/thinking` 等四条命令
 * 此前只能"诚实降级"的原因。
 */
describe('思考配置的消费', () => {
  const profile = (
    id: string,
    over: Partial<ConfigDocument['model_profiles'][number]> = {},
  ): ConfigDocument['model_profiles'][number] => ({
    id,
    providerId: 'p1',
    contextWindow: 100_000,
    maxOutputTokens: 64_000,
    supportsThinking: true,
    supportsTools: true,
    supportsVision: false,
    supports1MContext: false,
    enabled: true,
    ...over,
  })

  const configFor = (
    profiles: readonly ConfigDocument['model_profiles'][number][],
  ): ConfigDocument => ({
    schema_version: 1,
    llm_channels: [],
    llm_models: [],
    app_settings: {},
    providers: [
      {
        id: 'p1',
        name: 'p1',
        baseUrl: 'https://api.example.invalid',
        apiKeyRef: { source: 'env', key: 'K' },
        createdAt: '',
        updatedAt: '',
        enabled: true,
      },
    ],
    model_profiles: profiles,
    tier_assignments: [
      {
        tier: 'implementation',
        modelRef: { providerId: 'p1', modelId: profiles[0]!.id },
        enabled: true,
        fallbackModelRefs: [],
      },
    ],
  })

  /** 跑一轮并把 provider 收到的请求交出来。 */
  const runOnce = async (doc: ConfigDocument, override?: unknown) => {
    const script = scriptedProvider({ events: [text('done')] })
    const h = await harness({
      router: new ModelRouter(doc),
      providerFactory: () => script.provider,
    })
    await h.runtime.submitMessage(h.conversation.id, 'go', undefined, override as never)
    return { request: script.requests[0]!, h }
  }

  it('缺省（从未设置）即关闭：请求里没有 thinking 字段', async () => {
    // ADR 0004 D3：与旧实现 thinking_enabled 默认 True 有意不同。
    // 不发明一个模型没声明的能力请求。
    const { request } = await runOnce(configFor([profile('m1')]))
    expect(request.thinking).toBeUndefined()
    expect('thinking' in request).toBe(false)
  })

  it('显式打开后，折算出的 budgetTokens 进入请求体', async () => {
    const { request } = await runOnce(
      configFor([profile('m1', { thinkingEnabled: true, reasoningEffort: 'medium' })]),
    )
    expect(request.thinking).toEqual({ type: 'enabled', budgetTokens: 12_000 })
    // Anthropic 的硬性约束，provider 层也会断言一次
    expect(request.maxTokens).toBeGreaterThan(request.thinking!.budgetTokens)
  })

  it('思考预算受 maxOutputTokens 约束，不会把输出额度吃光', async () => {
    const { request } = await runOnce(
      configFor([
        profile('m1', {
          thinkingEnabled: true,
          reasoningEffort: 'xhigh',
          maxOutputTokens: 10_000,
        }),
      ]),
    )
    expect(request.maxTokens).toBe(10_000)
    expect(request.thinking).toEqual({ type: 'enabled', budgetTokens: 10_000 - 1_024 })
  })

  it('显式关闭时不发 thinking，即使强度还留在配置里', async () => {
    const { request } = await runOnce(
      configFor([profile('m1', { thinkingEnabled: false, reasoningEffort: 'high' })]),
    )
    expect(request.thinking).toBeUndefined()
  })

  it('恢复的 turn 用**快照里**的模型资料，中途改配置不影响它', async () => {
    // parts/09 §9.1：「每个 turn 开始时保存 providerId、模型 id、能力快照……」
    // 恢复路径读的是 `persisted.routeSnapshot.model`，所以快照里的
    // thinkingEnabled 说了算，而不是磁盘上最新的那份配置。
    const snapshotProfile = profile('m1', { thinkingEnabled: true, reasoningEffort: 'high' })
    const script = scriptedProvider({ events: [text('resumed')] })
    const h = await harness({
      // 磁盘上的配置已经把思考关掉了
      router: new ModelRouter(configFor([profile('m1', { thinkingEnabled: false })])),
      providerFactory: () => script.provider,
    })
    const turn = await seedTurn(h.store, h.conversation.id, TurnPhase.CALLING_MODEL, {
      routeSnapshot: {
        provider: {
          id: 'p1',
          name: 'p1',
          baseUrl: 'https://api.example.invalid',
          apiKeyRef: { source: 'env', key: 'K' },
          createdAt: '',
          updatedAt: '',
        },
        model: snapshotProfile,
        tier: ModelTier.IMPLEMENTATION,
      },
    })

    await h.runtime.resumeTurn(h.conversation.id, turn.turnId as TurnId)

    expect(script.requests[0]?.thinking).toEqual({ type: 'enabled', budgetTokens: 24_000 })
  })
})

describe('model_route_changed 事件', () => {
  const provider = (id: string): ConfigDocument['providers'][number] => ({
    id,
    name: id,
    baseUrl: 'https://api.example.invalid',
    apiKeyRef: { source: 'env', key: 'K' },
    createdAt: '',
    updatedAt: '',
    enabled: true,
  })

  const profile = (id: string, providerId: string): ConfigDocument['model_profiles'][number] => ({
    id,
    providerId,
    contextWindow: 100_000,
    maxOutputTokens: 1_000,
    supportsThinking: false,
    supportsTools: true,
    supportsVision: false,
    supports1MContext: false,
    enabled: true,
  })

  const twoModelConfig = (): ConfigDocument => ({
    schema_version: 1,
    llm_channels: [],
    llm_models: [],
    app_settings: {},
    providers: [provider('p1'), provider('p2')],
    model_profiles: [profile('m1', 'p1'), profile('m2', 'p2')],
    tier_assignments: [
      {
        tier: 'implementation',
        modelRef: { providerId: 'p1', modelId: 'm1' },
        enabled: true,
        fallbackModelRefs: [{ providerId: 'p2', modelId: 'm2' }],
      },
    ],
  })

  const changedEvents = (h: { events: () => readonly TurnStreamEvent[] }) =>
    h.events().filter((e) => e.type === 'model_route_changed')

  it('没有 override、首选模型可用时不发事件（路由没有变化）', async () => {
    const script = scriptedProvider({ events: [text('ok')] })
    const h = await harness({
      router: new ModelRouter(twoModelConfig()),
      providerFactory: () => script.provider,
    })
    await h.runtime.submitMessage(h.conversation.id, 'go')
    expect(changedEvents(h)).toHaveLength(0)
  })

  it('显式 override 生效时发出事件，from 是"原本会用的档位模型"', async () => {
    // parts/09 §6.1 要求模型引用与路由决策写入审计事件：用户指定了 B，
    // 就必须能从事件里看出这次**没有**用档位分配的 A。
    const script = scriptedProvider({ events: [text('ok')] })
    const h = await harness({
      router: new ModelRouter(twoModelConfig()),
      providerFactory: () => script.provider,
    })
    await h.runtime.submitMessage(h.conversation.id, 'go', undefined, {
      overrideId: 'ov_1',
      scope: 'next-turn',
      providerId: 'p2',
      modelId: 'm2',
      requestedBy: 'local',
      instruction: 'go',
      createdAt: '2026-09-15T00:00:00.000Z',
    })

    const events = changedEvents(h)
    expect(events).toHaveLength(1)
    expect(events[0]?.data).toMatchObject({
      from_provider: 'p1',
      from_model: 'm1',
      to_provider: 'p2',
      to_model: 'm2',
      reason: 'override',
      override_id: 'ov_1',
      error_code: '',
    })
  })

  it('override 指向的就是档位模型时不算路由变化，不发事件', async () => {
    const script = scriptedProvider({ events: [text('ok')] })
    const h = await harness({
      router: new ModelRouter(twoModelConfig()),
      providerFactory: () => script.provider,
    })
    await h.runtime.submitMessage(h.conversation.id, 'go', undefined, {
      overrideId: 'ov_2',
      scope: 'next-turn',
      providerId: 'p1',
      modelId: 'm1',
      requestedBy: 'local',
      instruction: 'go',
      createdAt: '2026-09-15T00:00:00.000Z',
    })
    expect(changedEvents(h)).toHaveLength(0)
  })

  it('fallback 换候选时发出事件，并带上触发它的错误码', async () => {
    // parts/09 §9.5：「切换模型后必须重新构建请求并写 model_route_changed 事件」。
    // 用户明确指定的模型因连接失败被换掉，是必须能看见的事。
    const transient: ModelProvider = {
      stream: () => {
        throw new AgentError({
          code: ErrorCode.PROVIDER_UNAVAILABLE,
          message: '5xx',
          source: 'test',
        })
      },
      probe: () => Promise.resolve({ ok: true }),
    }
    const healthy = scriptedProvider({ events: [text('降级后成功')] }).provider
    const h = await harness({
      router: new ModelRouter(twoModelConfig()),
      providerFactory: (route) => (route.model.id === 'm1' ? transient : healthy),
    })

    const result = await h.runtime.submitMessage(h.conversation.id, 'go')
    expect(result.status).toBe(TurnStatus.COMPLETED)

    const events = changedEvents(h)
    expect(events).toHaveLength(1)
    expect(events[0]?.data).toMatchObject({
      from_provider: 'p1',
      from_model: 'm1',
      to_provider: 'p2',
      to_model: 'm2',
      reason: 'fallback',
      error_code: ErrorCode.PROVIDER_UNAVAILABLE,
      override_id: '',
    })
  })

  it('事件不改变终止语义：它不是终止信号', async () => {
    const script = scriptedProvider({ events: [text('ok')] })
    const h = await harness({
      router: new ModelRouter(twoModelConfig()),
      providerFactory: () => script.provider,
    })
    await h.runtime.submitMessage(h.conversation.id, 'go', undefined, {
      overrideId: 'ov_3',
      scope: 'next-turn',
      providerId: 'p2',
      modelId: 'm2',
      requestedBy: 'local',
      instruction: 'go',
      createdAt: '2026-09-15T00:00:00.000Z',
    })

    const types = h.events().map((e) => e.type)
    expect(types.indexOf('model_route_changed')).toBeLessThan(types.indexOf('turn_end'))
    expect(h.events().at(-1)?.type).toBe('turn_end')
  })
})

/**
 * fallback 的下标对齐（回归）。
 *
 * `ModelRouter.resolve()` 返回的是**第一个能通过校验的候选**，不是
 * `candidates[0]`——配置层就不可用的候选（模型被禁用、不支持工具、窗口太小）
 * 会被它跳过。这一点在 `implementation` 档位上尤其常见：`supportsTools` 为假的
 * 模型在保存配置时就会被 `/model use` 拒掉，但手改 `config.json` 或旧数据里
 * 完全可能存在，而 `TaskIntent.requiresTools` 恒为 `true`。
 *
 * 早先 runtime 假定"我从下标 0 开始、每次 fallback 加一"，于是下标与实际运行的
 * 模型错位，两个后果同时出现：
 * 1. `model_route_changed` 的 `from` 报出**一个从未运行过的模型**；
 * 2. fallback 重新请求**刚失败的那个模型**（还顺手把 `providerRetries` 归零）。
 *
 * 这条用例的配置刻意让 `candidates[0]` 不可用。
 */
describe('fallback 的下标与实际运行的模型对齐', () => {
  const provider = (id: string) => ({
    id,
    name: id,
    baseUrl: 'https://api.example.invalid',
    apiKeyRef: { source: 'env' as const, key: 'K' },
    createdAt: '',
    updatedAt: '',
    enabled: true,
  })

  const profile = (
    id: string,
    providerId: string,
    supportsTools: boolean,
  ): ConfigDocument['model_profiles'][number] => ({
    id,
    providerId,
    contextWindow: 100_000,
    maxOutputTokens: 1_000,
    supportsThinking: false,
    supportsTools,
    supportsVision: false,
    supports1MContext: false,
    enabled: true,
  })

  /**
   * `candidates[0]`（档位模型 m1）不支持工具 → `resolve()` 从 m2 起步。
   *
   * m2 必须在回退链里：`resolve()` 的候选 = [override?, 档位模型, ...回退链]，
   * 档位模型被跳过之后要有人接住，否则它会直接抛 "no eligible model"。
   */
  const configWithUnusableFirst = (): ConfigDocument => ({
    schema_version: 1,
    llm_channels: [],
    llm_models: [],
    app_settings: {},
    providers: [provider('p1'), provider('p2')],
    model_profiles: [profile('m1', 'p1', false), profile('m2', 'p2', true)],
    tier_assignments: [
      {
        tier: 'implementation',
        modelRef: { providerId: 'p1', modelId: 'm1' },
        enabled: true,
        fallbackModelRefs: [{ providerId: 'p2', modelId: 'm2' }],
      },
    ],
  })

  it('起点落在被跳过的候选之后时，真实调用的模型与 resolvedIndex 一致', async () => {
    const script = scriptedProvider({ events: [text('ok')] })
    const seen: string[] = []
    const h = await harness({
      router: new ModelRouter(configWithUnusableFirst()),
      providerFactory: (route) => {
        seen.push(route.model.id)
        return script.provider
      },
    })

    const result = await h.runtime.submitMessage(h.conversation.id, 'go')
    expect(result.status).toBe(TurnStatus.COMPLETED)
    // 第一个候选不可用 → 直接跑 m2，而不是"以为在跑 m1"
    expect(seen).toEqual(['m2'])

    const turn = await persisted(h.store, h.conversation.id, result.turn_id)
    expect(turn.modelSnapshot?.modelId).toBe('m2')
    // 路由没有变化（无 override、没走 fallback），不该有事件
    expect(h.events().filter((e) => e.type === 'model_route_changed')).toHaveLength(0)
  })

  it('fallback 的 from 是**刚失败的那个**，不是被跳过的候选', async () => {
    // 候选链 = [m1(不可用), m2(暂时性故障), m3(健康)]。
    // `resolve()` 跳过 m1 → 起点是 **m2**，而 `candidateIndex` 早先会是 0。
    const config: ConfigDocument = {
      ...configWithUnusableFirst(),
      providers: [provider('p1'), provider('p2'), provider('p3')],
      model_profiles: [
        profile('m1', 'p1', false),
        profile('m2', 'p2', true),
        profile('m3', 'p3', true),
      ],
      tier_assignments: [
        {
          tier: 'implementation',
          modelRef: { providerId: 'p1', modelId: 'm1' },
          enabled: true,
          fallbackModelRefs: [
            { providerId: 'p2', modelId: 'm2' },
            { providerId: 'p3', modelId: 'm3' },
          ],
        },
      ],
    }

    // 统计**真正发起过的请求**。重试复用同一个 provider 实例，
    // 所以要在 provider 内部数，不能数 `providerFactory` 的调用次数。
    let failingStreams = 0
    const transient: ModelProvider = {
      stream: () => {
        failingStreams += 1
        throw new AgentError({
          code: ErrorCode.PROVIDER_UNAVAILABLE,
          message: '5xx',
          source: 'test',
        })
      },
      probe: () => Promise.resolve({ ok: true }),
    }
    const healthy = scriptedProvider({ events: [text('降级后成功')] })
    const routed: string[] = []
    const h = await harness({
      router: new ModelRouter(config),
      providerFactory: (route) => {
        routed.push(route.model.id)
        return route.model.id === 'm2' ? transient : healthy.provider
      },
    })

    const result = await h.runtime.submitMessage(h.conversation.id, 'go')
    expect(result.status).toBe(TurnStatus.COMPLETED)

    const events = h.events().filter((e) => e.type === 'model_route_changed')
    expect(events).toHaveLength(1)
    // from 必须是**真的跑过的** m2。下标错位时这里会是 m1——一个从未被调用过的模型。
    expect(events[0]?.data).toMatchObject({
      from_provider: 'p2',
      from_model: 'm2',
      to_provider: 'p3',
      to_model: 'm3',
      reason: 'fallback',
    })
    // m2 只该被请求"1 次 + 2 次重试"；错位时它会被当成下一站再打一轮。
    // m1 从未被调用过——它连候选都没进得去（`resolve()` 跳过了它）。
    expect(failingStreams).toBe(3)
    expect(routed).toEqual(['m2', 'm3'])
    expect(healthy.callCount()).toBe(1)
  })

  it('候选链走完仍无可用者 → 以 failed 收尾，而不是抛异常出 runTurn', async () => {
    // 候选链 = [m1(不可用), m2(一直故障)]：往后找会一路找空。
    const config = configWithUnusableFirst()
    const transient: ModelProvider = {
      stream: () => {
        throw new AgentError({
          code: ErrorCode.PROVIDER_UNAVAILABLE,
          message: '5xx',
          source: 'test',
        })
      },
      probe: () => Promise.resolve({ ok: true }),
    }
    const h = await harness({
      router: new ModelRouter(config),
      providerFactory: () => transient,
    })

    const result = await h.runtime.submitMessage(h.conversation.id, 'go')
    expect(result.status).toBe(TurnStatus.FAILED)
    expect(result.error).toBe('5xx')
    // 没有"切到一个不存在的模型"的假事件
    expect(h.events().filter((e) => e.type === 'model_route_changed')).toHaveLength(0)
  })
})

describe('override 生效时 tierRef 的三种情形', () => {
  const provider = (id: string, enabled = true) => ({
    id,
    name: id,
    baseUrl: 'https://api.example.invalid',
    apiKeyRef: { source: 'env' as const, key: 'K' },
    createdAt: '',
    updatedAt: '',
    enabled,
  })

  const profile = (id: string, providerId: string): ConfigDocument['model_profiles'][number] => ({
    id,
    providerId,
    contextWindow: 100_000,
    maxOutputTokens: 1_000,
    supportsThinking: false,
    supportsTools: true,
    supportsVision: false,
    supports1MContext: false,
    enabled: true,
  })

  const override = {
    overrideId: 'ov',
    scope: 'next-turn' as const,
    providerId: 'p2',
    modelId: 'm2',
    requestedBy: 'local',
    instruction: 'go',
    createdAt: '2026-09-15T00:00:00.000Z',
  }

  const run = async (doc: ConfigDocument) => {
    const script = scriptedProvider({ events: [text('ok')] })
    const h = await harness({
      router: new ModelRouter(doc),
      providerFactory: () => script.provider,
    })
    await h.runtime.submitMessage(h.conversation.id, 'go', undefined, override)
    return h.events().filter((e) => e.type === 'model_route_changed')
  }

  const base = (tierEnabled: boolean): ConfigDocument => ({
    schema_version: 1,
    llm_channels: [],
    llm_models: [],
    app_settings: {},
    providers: [provider('p1'), provider('p2')],
    model_profiles: [profile('m1', 'p1'), profile('m2', 'p2')],
    tier_assignments: [
      {
        tier: 'implementation',
        modelRef: { providerId: 'p1', modelId: 'm1' },
        enabled: tierEnabled,
        fallbackModelRefs: [],
      },
    ],
  })

  it('档位启用且指向别的模型 → from 是该档位模型', async () => {
    const events = await run(base(true))
    expect(events).toHaveLength(1)
    expect(events[0]?.data).toMatchObject({
      from_provider: 'p1',
      from_model: 'm1',
      reason: 'override',
    })
  })

  it('档位被**禁用** → from 留空串，而不是指向一个"本来也不会被用"的模型', async () => {
    // 档位禁用时 `resolve()` 根本不会把它的模型放进候选（没有 override 会直接抛
    // MODEL_NOT_FOUND）。此时把 from 报成 m1 是不成立的叙述。
    const events = await run(base(false))
    expect(events).toHaveLength(1)
    expect(events[0]?.data).toMatchObject({
      from_provider: '',
      from_model: '',
      to_model: 'm2',
      reason: 'override',
    })
  })

  it('完全没有该档位 → 仍然发事件（override 确实改变了路由）', async () => {
    const events = await run({ ...base(true), tier_assignments: [] })
    expect(events).toHaveLength(1)
    expect(events[0]?.data).toMatchObject({ from_model: '', to_model: 'm2', reason: 'override' })
  })

  it('override 与档位模型相同 → 不发事件（路由没变）', async () => {
    const doc: ConfigDocument = {
      ...base(true),
      tier_assignments: [
        {
          tier: 'implementation',
          modelRef: { providerId: 'p2', modelId: 'm2' },
          enabled: true,
          fallbackModelRefs: [],
        },
      ],
    }
    expect(await run(doc)).toHaveLength(0)
  })
})
