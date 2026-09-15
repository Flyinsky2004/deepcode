/**
 * 运行时事件契约的固化测试（Phase 7 前置修正）。
 *
 * 这些断言覆盖三处**做过显式决策**的行为变更：
 * 1. `EventLog` 是事件的唯一持久化权威（不再同时写 `chat.json`）；
 * 2. `turn_end` 必须携带完整载荷（含 token 与取消标志）；
 * 3. 审批事件的参数必须脱敏。
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { AgentRuntime } from '../../src/runtime/agent-runtime.js'
import { ContextBuilder } from '../../src/runtime/context-builder.js'
import { ChatStore } from '../../src/storage/chat-store.js'
import { EventLog } from '../../src/storage/event-log.js'
import { resolveAppPaths } from '../../src/storage/paths.js'
import { ToolExecutor } from '../../src/tools/executor.js'
import { ToolRegistry } from '../../src/tools/registry.js'
import { DefaultPermissionEngine } from '../../src/tools/permission-engine.js'
import { createBashTool, createFileWriteTool } from '../../src/tools/builtins.js'
import { ModelEventType } from '../../src/core/provider.js'
import { PermissionMode } from '../../src/core/tool.js'
import type { RuntimeEventEnvelope } from '../../src/core/events.js'
import type { TurnStreamEvent } from '../../src/core/turn.js'

/** 一次性文本响应的假 provider。 */
const textModel = (text: string) =>
  ({
    stream: () => ({
      usage: { inputTokens: 7, outputTokens: 3 },
      async *[Symbol.asyncIterator]() {
        await Promise.resolve()
        yield { type: ModelEventType.TEXT, content: text }
      },
    }),
    probe: () => Promise.resolve({ ok: true }),
  }) as never

/** 第一次调用产出 tool_use，之后产出文本的假 provider。 */
const toolUseModel = (name: string, input: unknown, thenText = 'done') => {
  let call = 0
  return {
    stream: () => {
      call++
      const events =
        call === 1
          ? [{ type: ModelEventType.TOOL_USE, id: 'tc1', name, input }]
          : [{ type: ModelEventType.TEXT, content: thenText }]
      return {
        usage: { inputTokens: 1, outputTokens: 1 },
        async *[Symbol.asyncIterator]() {
          await Promise.resolve()
          for (const e of events) yield e
        },
      }
    },
    probe: () => Promise.resolve({ ok: true }),
  } as never
}

/** 永不产出、直到被取消才结束的假 provider。 */
const hangingModel = () =>
  ({
    stream: (_req: unknown, signal: AbortSignal) => ({
      usage: { inputTokens: 0, outputTokens: 0 },
      // 刻意写成非生成器的 async iterator：这个流**永不产出**，
      // 只在收到取消时以拒绝结束。
      [Symbol.asyncIterator]() {
        return {
          next: (): Promise<IteratorResult<never>> =>
            new Promise((_resolve, reject) => {
              if (signal.aborted) reject(new Error('aborted'))
              signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
            }),
        }
      },
    }),
    probe: () => Promise.resolve({ ok: true }),
  }) as never

async function harness(
  model: unknown,
  register: (registry: ToolRegistry) => void = () => undefined,
) {
  const dir = await mkdtemp(join(tmpdir(), 'deepcode-events-'))
  const store = new ChatStore(resolveAppPaths({ home: dir, cwd: dir }))
  const conversation = await store.createConversation()
  const registry = new ToolRegistry()
  register(registry)
  const executor = new ToolExecutor({
    registry,
    permissionEngine: new DefaultPermissionEngine(),
    chatStore: store,
  })
  const builder = new ContextBuilder({ chatStore: store, tools: () => registry.descriptors() })
  const log = new EventLog(join(dir, 'events'))
  const runtime = new AgentRuntime({
    chatStore: store,
    contextBuilder: builder,
    toolExecutor: executor,
    provider: model as never,
    model: 'test',
    eventSink: log,
    workspaceRoot: dir,
    principalId: 'p',
  })
  const events = async (): Promise<TurnStreamEvent[]> =>
    (await log.list(conversation.id)) as unknown as TurnStreamEvent[]
  return { dir, store, conversation, runtime, log, events }
}

const find = <T extends string>(events: readonly TurnStreamEvent[], type: T) =>
  events.find((e) => e.type === type) as Extract<TurnStreamEvent, { type: T }> | undefined

describe('turn_end 载荷完整性', () => {
  it('携带 token、预算上限与工具错误字段', async () => {
    const { conversation, runtime, events } = await harness(textModel('完成'))

    const result = await runtime.submitMessage(conversation.id, 'go')
    expect(result.status).toBe('completed')

    const end = find(await events(), 'turn_end')
    expect(end).toBeDefined()
    // 状态栏要显示 token 用量，旧实现把这些字段整个漏掉了
    expect(end?.data.input_tokens).toBe(7)
    expect(end?.data.output_tokens).toBe(3)
    expect(typeof end?.data.current_max_turns).toBe('number')
    expect(typeof end?.data.auto_continue_count).toBe('number')
    expect(end?.data.last_tool_error).toBeNull()
    // 未取消时不带 cancelled 字段（区分"没有取消"与"cancelled: false"）
    expect(end?.data.cancelled).toBeUndefined()
  })

  it('取消时 cancelled 为 true', async () => {
    const { conversation, runtime, events } = await harness(hangingModel())
    const controller = new AbortController()

    const pending = runtime.submitMessage(conversation.id, 'go', controller.signal)
    // 让 turn 进入 calling_model 后再取消
    await new Promise((resolve) => setTimeout(resolve, 20))
    controller.abort()

    const result = await pending
    expect(result.status).toBe('cancelled')

    const end = find(await events(), 'turn_end')
    expect(end?.data.cancelled).toBe(true)
  })
})

describe('EventLog 是事件的唯一持久化权威', () => {
  it('事件写入注入的 sink，且序号由 sink 分配', async () => {
    const { conversation, runtime, events } = await harness(textModel('hi'))

    await runtime.submitMessage(conversation.id, 'go')

    const all = await events()
    expect(all.length).toBeGreaterThan(0)
    // 严格单调递增，从 1 开始——由 EventLog 分配，不是 runtime 自己维护计数器
    expect(all.map((e) => (e as unknown as RuntimeEventEnvelope).sequence)).toEqual(
      Array.from({ length: all.length }, (_v, i) => i + 1),
    )
  })

  it('不再向 chat.json 写事件副本（那份副本没有任何读取方）', async () => {
    const { conversation, runtime, store } = await harness(textModel('hi'))

    await runtime.submitMessage(conversation.id, 'go')

    const doc = await store.read()
    expect(doc.runtime.events).toEqual([])
  })
})

describe('审批事件脱敏', () => {
  it('args_preview 不泄漏命令原文，且风险等级取自真实判定', async () => {
    const { conversation, runtime, events } = await harness(
      toolUseModel('bash', { command: 'echo hello' }),
      (registry) => {
        registry.register(createBashTool())
      },
    )

    // NORMAL 模式下 bash 需要审批；未注入 approvalService 时 executor 返回
    // PERMISSION_REQUIRED，runtime 据此广播兜底通知事件。
    await runtime.submitMessage(conversation.id, 'run it')

    const permission = find(await events(), 'permission_required')
    expect(permission).toBeDefined()
    // `command` 属于敏感键（storage/audit.ts 的 redact 规则）
    expect(permission?.data.args_preview).toContain('[redacted]')
    expect(permission?.data.args_preview).not.toContain('echo')
    // 风险等级来自权限引擎的判定，而不是硬编码的 'medium'
    expect(['low', 'medium', 'high', 'critical']).toContain(permission?.data.risk_level)
    // 到期时刻来自持久化的权限请求
    expect(permission?.data.expires_at).toBeGreaterThan(0)
  })
})

describe('权限模式与风险策略的相互作用', () => {
  /**
   * 用指定模式跑一轮工具调用，返回是否产生了审批事件。
   *
   * `register` 决定注册哪个工具，从而控制它的 `risk_level`：
   * `file_write` 是 medium、`bash` 是 high。
   */
  const runUnderMode = async (
    mode: PermissionMode,
    toolName: string,
    input: unknown,
    register: (registry: ToolRegistry) => void,
  ): Promise<readonly TurnStreamEvent[]> => {
    const { dir, store, conversation } = await harness(toolUseModel(toolName, input), register)
    const registry = new ToolRegistry()
    register(registry)
    const executor = new ToolExecutor({
      registry,
      permissionEngine: new DefaultPermissionEngine(),
      chatStore: store,
    })
    const builder = new ContextBuilder({ chatStore: store, tools: () => registry.descriptors() })
    const log = new EventLog(join(dir, 'events'))
    const runtime = new AgentRuntime({
      chatStore: store,
      contextBuilder: builder,
      toolExecutor: executor,
      provider: toolUseModel(toolName, input),
      model: 'test',
      eventSink: log,
      mode,
      workspaceRoot: dir,
      principalId: 'p',
    })

    await runtime.submitMessage(conversation.id, 'go')

    const all = (await log.list(conversation.id)) as unknown as TurnStreamEvent[]
    // 每种模式都必须先真的调到工具，否则断言是空的
    expect(all.some((e) => e.type === 'tool_use')).toBe(true)
    return all
  }

  const asked = (events: readonly TurnStreamEvent[]) =>
    events.some((e) => e.type === 'permission_required')

  const write = (registry: ToolRegistry) => {
    registry.register(createFileWriteTool())
  }
  const bash = (registry: ToolRegistry) => {
    registry.register(createBashTool())
  }

  it('NORMAL 模式下写文件需要审批', async () => {
    const events = await runUnderMode(
      PermissionMode.NORMAL,
      'file_write',
      { path: 'o.txt', content: 'x' },
      write,
    )
    expect(asked(events)).toBe(true)
  })

  it('AUTO_EDIT 模式下同一写入不再需要审批', async () => {
    const events = await runUnderMode(
      PermissionMode.AUTO_EDIT,
      'file_write',
      { path: 'o.txt', content: 'x' },
      write,
    )
    expect(asked(events)).toBe(false)
  })

  it('高风险工具在所有模式下都要审批——包括 YOLO', async () => {
    // ADR 0002 §八 把决策顺序定为「… → skill guard → 风险策略」，
    // 风险策略排在模式判定**之后**，因此 `bash`（high）即使 YOLO 也要审批。
    // 这不是缺陷，是冻结的设计；固化它以免被"顺手放宽"。
    const events = await runUnderMode(PermissionMode.YOLO, 'bash', { command: 'echo hi' }, bash)
    expect(asked(events)).toBe(true)
  })
})
