/**
 * `ContextCompactor` 的触发判定与落盘形态测试。
 *
 * 压缩是**有损**操作：一旦保留窗口算错，被摘要掉的消息就不会再进入请求，
 * 且只能靠 `compact_boundary` 里的 id 列表回放。因此这里重点覆盖：
 *
 * 1. **触发条件**（消息条数 / token 比例 / force）各自独立生效；
 * 2. **保留窗口不能从 tool 消息中间切开**——否则会在协议上留下孤儿 tool_result；
 * 3. **落盘内容的自洽性**：boundary 里的 `preserved_*` 必须与 summary 的 id 对得上，
 *    这样第二次压缩才不会静默丢消息；
 * 4. `deterministicSummary` 在工作记忆为空/非空两种形态下的输出。
 *
 * 用假的 `ChatStore` 而非真实存储：这里测的是压缩策略本身，不应该依赖磁盘时序。
 * 只固化既有行为，不修改实现。
 */
import { describe, expect, it } from 'vitest'

import { MessageRole, MessageSubtype, type Message } from '../../src/core/models.js'
import { EMPTY_WORKING_MEMORY, type WorkingMemory } from '../../src/core/context.js'
import { createFakeClock } from '../../src/core/time.js'
import type { ChatStore } from '../../src/storage/chat-store.js'
import {
  ContextCompactor,
  DEFAULT_COMPACTION_POLICY,
  type CompactionPolicy,
} from '../../src/runtime/compaction.js'

type SessionId = Parameters<ChatStore['listActiveMessages']>[0]

const SESSION = 'session-1' as SessionId

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-1' as Message['id'],
    conversation_id: 'session-1',
    role: MessageRole.USER,
    content: 'hello',
    created_at: '2026-01-01T00:00:00.000Z',
    turn_id: '',
    subtype: MessageSubtype.NORMAL,
    tool_call_id: null,
    meta: '{}',
    agent_type: '',
    ...overrides,
  } as Message
}

/** 造 n 条消息，id 形如 m0..mn，便于断言保留窗口。 */
function messages(
  count: number,
  overrides: (index: number) => Partial<Message> = () => ({}),
): Message[] {
  return Array.from({ length: count }, (_, index) =>
    message({
      id: `m${index}` as Message['id'],
      content: `content-${index}`,
      role: MessageRole.USER,
      ...overrides(index),
    }),
  )
}

interface FakeStore {
  readonly store: ChatStore
  readonly appended: Array<{ summary: Message; boundary: Message; compactedCount: number }>
  readonly listCalls: string[]
}

function makeStore(all: readonly Message[]): FakeStore {
  const appended: FakeStore['appended'] = []
  const listCalls: string[] = []
  const fake = {
    clock: createFakeClock(0),
    listActiveMessages: (sessionId: string) => {
      listCalls.push(sessionId)
      return Promise.resolve(all)
    },
    appendCompaction: (summary: Message, boundary: Message, compactedCount: number) => {
      appended.push({ summary, boundary, compactedCount })
      return Promise.resolve()
    },
  }
  return { store: fake as unknown as ChatStore, appended, listCalls }
}

/** 阈值友好：usable = 1000，触发线 500 token。 */
const POLICY: Partial<CompactionPolicy> = {
  contextWindow: 1000,
  reserveOutputTokens: 0,
  reserveSystemTokens: 0,
  reserveToolTokens: 0,
  triggerRatio: 0.5,
  preserveRecentMessages: 2,
  toolResultBudgetChars: 8000,
}

const signal = new AbortController().signal

/** 制造一段估算 token 明显超过触发线的内容。 */
const heavy = (index: number) => `${index}:${'x'.repeat(3000)}`

describe('shouldCompact', () => {
  it('显式传入 token 估算时直接比较，不再自己算', () => {
    const { store } = makeStore([])
    const compactor = new ContextCompactor(store, POLICY)
    // usable = 1000，触发线 = 500
    expect(compactor.shouldCompact([], 499)).toBe(false)
    expect(compactor.shouldCompact([], 500)).toBe(true)
  })

  it('未传估算时按消息内容估算', () => {
    const { store } = makeStore([])
    const compactor = new ContextCompactor(store, POLICY)
    const light = [message({ content: 'short' })]
    const heavyMessages = [message({ content: 'x'.repeat(3000) })]

    const lightTokens = compactor.estimator.estimate('short')
    expect(compactor.shouldCompact(light, lightTokens)).toBe(false)
    expect(compactor.shouldCompact(heavyMessages)).toBe(true)
    expect(compactor.shouldCompact(light)).toBe(false)
  })

  it('触发线与保留预算（输出/系统/工具）联动：预留越多越早触发', () => {
    const { store } = makeStore([])
    const generous = new ContextCompactor(store, { contextWindow: 1000, triggerRatio: 0.5 })
    // 默认预留 18000 token，窗口只有 1000 → usable 为负 → 任何输入都触发
    expect(generous.shouldCompact([], 1)).toBe(true)
  })

  it('未指定的策略字段回落到默认值（部分覆盖而不是整体替换）', () => {
    const { store } = makeStore([])
    const compactor = new ContextCompactor(store, { preserveRecentMessages: 3 })
    expect(compactor.policy.preserveRecentMessages).toBe(3)
    expect(compactor.policy.contextWindow).toBe(DEFAULT_COMPACTION_POLICY.contextWindow)
    expect(compactor.policy.triggerRatio).toBe(DEFAULT_COMPACTION_POLICY.triggerRatio)
  })
})

describe('compact：不触发的情形', () => {
  it('消息条数不超过保留窗口且未 force 时直接返回 undefined', () => {
    const { store, appended } = makeStore(messages(2))
    const compactor = new ContextCompactor(store, POLICY)
    return compactor.compact(SESSION, EMPTY_WORKING_MEMORY, signal).then((result) => {
      expect(result).toBeUndefined()
      expect(appended).toHaveLength(0)
    })
  })

  it('条数够多但 token 未到触发线、且未 force 时返回 undefined', () => {
    const { store, appended } = makeStore(messages(4))
    const compactor = new ContextCompactor(store, POLICY)
    return compactor.compact(SESSION, EMPTY_WORKING_MEMORY, signal).then((result) => {
      expect(result).toBeUndefined()
      expect(appended).toHaveLength(0)
    })
  })

  it('force 会跳过比例判定，但保留窗口为空时仍返回 undefined（没有可摘要的历史）', async () => {
    // 保留窗口起点落在 tool 消息上会一直回退，最终 old 为空
    const all = messages(4, (index) => ({
      role: index === 3 ? MessageRole.USER : MessageRole.TOOL,
    }))
    const { store, appended } = makeStore(all)
    const compactor = new ContextCompactor(store, POLICY)
    expect(await compactor.compact(SESSION, EMPTY_WORKING_MEMORY, signal, true)).toBeUndefined()
    expect(appended).toHaveLength(0)
  })

  it('从子代理会话读取时把 sessionId 原样传给存储（不做改写）', async () => {
    const { store, listCalls } = makeStore(messages(4, (index) => ({ content: heavy(index) })))
    const compactor = new ContextCompactor(store, POLICY)
    await compactor.compact('sub-session' as SessionId, EMPTY_WORKING_MEMORY, signal)
    expect(listCalls).toEqual(['sub-session'])
  })
})

describe('compact：触发后的落盘形态', () => {
  it('返回的摘要与写入存储的 boundary/summary 完全自洽', async () => {
    const all = messages(6, (index) => ({ content: heavy(index) }))
    const { store, appended } = makeStore(all)
    const compactor = new ContextCompactor(store, POLICY)

    const result = await compactor.compact(SESSION, EMPTY_WORKING_MEMORY, signal)

    expect(result).toBeDefined()
    expect(appended).toHaveLength(1)
    const [entry] = appended
    expect(entry?.compactedCount).toBe(4)

    // summary 消息
    const summaryContent = JSON.parse(entry!.summary.content) as Record<string, unknown>
    expect(entry!.summary.subtype).toBe(MessageSubtype.COMPACT_SUMMARY)
    expect(entry!.summary.role).toBe(MessageRole.SYSTEM)
    expect(entry!.summary.conversation_id).toBe('session-1')
    expect(summaryContent['type']).toBe('compact_summary')
    expect(summaryContent['schema_version']).toBe(1)
    expect(summaryContent['summarized_count']).toBe(4)
    expect(summaryContent['summary']).toBe(result!.summary)

    // boundary 消息
    const boundaryContent = JSON.parse(entry!.boundary.content) as Record<string, unknown>
    expect(entry!.boundary.subtype).toBe(MessageSubtype.COMPACT_BOUNDARY)
    expect(boundaryContent['type']).toBe('compact_boundary')
    expect(boundaryContent['boundary_id']).toBe(result!.boundaryId)
    expect(boundaryContent['strategy']).toBe('autocompact_v1')
    expect(boundaryContent['summary_msg_id']).toBe(entry!.summary.id)
    expect(boundaryContent['source_range_from']).toBe('m0')
    expect(boundaryContent['source_range_to']).toBe('m3')
    expect(boundaryContent['preserved_head_ids']).toEqual(['m4', 'm5'])
    expect(boundaryContent['preserved_tail_id']).toBe('m5')
    expect(boundaryContent['tokens_before']).toBe(result!.tokensBefore)
    expect(boundaryContent['tokens_after']).toBe(result!.tokensAfter)
    // 压缩后应当更小，否则压缩毫无意义
    expect(result!.tokensAfter).toBeLessThan(result!.tokensBefore)
  })

  it('boundary 的时间戳比 summary 晚 1ms（保证排序键唯一且 boundary 在后）', async () => {
    const { store, appended } = makeStore(messages(6, (index) => ({ content: heavy(index) })))
    const compactor = new ContextCompactor(store, POLICY)
    await compactor.compact(SESSION, EMPTY_WORKING_MEMORY, signal)

    const { summary, boundary } = appended[0]!
    expect(Date.parse(boundary.created_at) - Date.parse(summary.created_at)).toBe(1)
  })

  it('保留窗口起点落在 tool 消息上时向前扩展，不把 tool_result 与它的调用切开', async () => {
    // preserveRecentMessages = 2 → 起点 m4，但 m4/m3 都是 tool，需退到 m2
    const all = messages(6, (index) => ({
      role: index === 2 || index === 5 ? MessageRole.USER : MessageRole.TOOL,
      content: heavy(index),
    }))
    const { store, appended } = makeStore(all)
    const compactor = new ContextCompactor(store, POLICY)
    const result = await compactor.compact(SESSION, EMPTY_WORKING_MEMORY, signal)

    expect(result).toBeDefined()
    const boundaryContent = JSON.parse(appended[0]!.boundary.content) as Record<string, unknown>
    expect(boundaryContent['preserved_head_ids']).toEqual(['m2', 'm3', 'm4', 'm5'])
    expect(appended[0]?.compactedCount).toBe(2)
  })

  it('无 summarizer 时使用确定性摘要（不依赖模型也能压缩）', async () => {
    const all = messages(6, (index) => ({ content: `line-${index}` }))
    const { store, appended } = makeStore(all)
    const compactor = new ContextCompactor(store, POLICY)
    expect(compactor.summarizer).toBeUndefined()

    const result = await compactor.compact(SESSION, EMPTY_WORKING_MEMORY, signal, true)
    expect(result).toBeDefined()
    // 确定性摘要直接来自消息体
    expect(result!.summary).toContain('user: line-0')
    expect(result!.summary).toContain('user: line-3')
    expect(appended[0]?.summary.content).toContain('line-1')
  })

  it('提供 summarizer 时以它的返回值为准，并把旧消息按预算截断后传入', async () => {
    const all = messages(4, () => ({ content: 'y'.repeat(50) }))
    const { store } = makeStore(all)
    const seen: string[] = []
    const compactor = new ContextCompactor(
      store,
      { ...POLICY, toolResultBudgetChars: 5 },
      {
        summarize: (input) => {
          seen.push(input)
          return Promise.resolve('LLM 摘要')
        },
      },
    )

    const result = await compactor.compact(SESSION, EMPTY_WORKING_MEMORY, signal, true)
    expect(result!.summary).toBe('LLM 摘要')
    // 每条旧消息的 content 被截到 5 字符（`user: ` 前缀 + 5 个 y）
    expect(seen[0]?.split('\n')[0]).toBe('user: yyyyy')
  })

  it('summarizer 收到工作记忆原文，可以把约束带进摘要', async () => {
    const all = messages(4, (index) => ({ content: heavy(index) }))
    const { store } = makeStore(all)
    let received: WorkingMemory | undefined
    const memory: WorkingMemory = {
      ...EMPTY_WORKING_MEMORY,
      userConstraints: ['不要动 package.json'],
    }
    const compactor = new ContextCompactor(store, POLICY, {
      summarize: (_input, passedMemory) => {
        received = passedMemory
        return Promise.resolve('s')
      },
    })

    await compactor.compact(SESSION, memory, signal)
    expect(received).toBe(memory)
  })

  it('toolResultBudgetChars 只影响摘要输入，不影响被保留消息的原文', async () => {
    const all = messages(4, () => ({ content: 'z'.repeat(50) }))
    const { store, appended } = makeStore(all)
    const compactor = new ContextCompactor(store, { ...POLICY, toolResultBudgetChars: 1 })
    await compactor.compact(SESSION, EMPTY_WORKING_MEMORY, signal, true)
    // summary 里是截断后的内容，但 keep 部分（最后一个 z 串）仍是原文长度
    const boundaryContent = JSON.parse(appended[0]!.boundary.content) as Record<string, unknown>
    expect((boundaryContent['preserved_head_ids'] as string[]).length).toBe(2)
  })
})

describe('deterministicSummary：工作记忆的六个来源', () => {
  const fullMemory: WorkingMemory = {
    userConstraints: ['不要改配置'],
    openTasks: ['补测试'],
    pendingToolCalls: [{ toolCallId: 'tc1', toolName: 'bash', input: { command: 'ls' } }],
    permissionDecisions: [
      {
        requestId: 'r1',
        toolCallId: 'tc1',
        toolName: 'bash',
        action: 'ask',
        resolution: 'approved',
        reason: '需要确认',
      },
    ],
    fileChanges: [{ path: 'a.txt', kind: 'modified', beforeHash: 'h1', afterHash: 'h2' }],
    appliedSkills: ['demo@1'],
  }

  it('工作记忆为空时只输出消息正文', async () => {
    const { store, appended } = makeStore(messages(4, (index) => ({ content: `body-${index}` })))
    const compactor = new ContextCompactor(store, POLICY)
    await compactor.compact(SESSION, EMPTY_WORKING_MEMORY, signal, true)

    const summary = JSON.parse(appended[0]!.summary.content) as { summary: string }
    expect(summary.summary).not.toContain('Constraints:')
    expect(summary.summary).toContain('body-0')
  })

  it('工作记忆六项齐全时全部进入摘要（压缩不得丢失约束与待办）', async () => {
    const { store, appended } = makeStore(messages(4, (index) => ({ content: `body-${index}` })))
    const compactor = new ContextCompactor(store, POLICY)
    await compactor.compact(SESSION, fullMemory, signal, true)

    const summary = (JSON.parse(appended[0]!.summary.content) as { summary: string }).summary
    expect(summary).toContain('Constraints: 不要改配置')
    expect(summary).toContain('Open tasks: 补测试')
    expect(summary).toContain('Pending tools: ')
    expect(summary).toContain('Permission decisions: ')
    expect(summary).toContain('File changes: ')
    expect(summary).toContain('Applied skills: demo@1')
    expect(summary).toContain('body-0')
  })
})

describe('compactPreflight / compactManual / compactReactive', () => {
  it('preflight 与 reactive 都不强制，manual 强制压缩', async () => {
    // 条数超过保留窗口（4 > 2），但内容极短 → 比例判定不通过
    const all = messages(4)
    const expectPreflight = new ContextCompactor(makeStore(all).store, POLICY)
    expect(
      await expectPreflight.compactPreflight(SESSION, EMPTY_WORKING_MEMORY, signal),
    ).toBeUndefined()
    const expectReactive = new ContextCompactor(makeStore(all).store, POLICY)
    expect(
      await expectReactive.compactReactive(SESSION, EMPTY_WORKING_MEMORY, signal),
    ).toBeUndefined()

    const { store, appended } = makeStore(all)
    const manual = new ContextCompactor(store, POLICY)
    const result = await manual.compactManual(SESSION, EMPTY_WORKING_MEMORY, signal)
    expect(result).toBeDefined()
    expect(appended).toHaveLength(1)
  })

  it('三者的 force 差异是唯一区别（同一份输入下只有 manual 落盘）', async () => {
    const all = messages(6)
    const preflightStore = makeStore(all)
    const reactiveStore = makeStore(all)
    const manualStore = makeStore(all)

    await new ContextCompactor(preflightStore.store, POLICY).compactPreflight(
      SESSION,
      EMPTY_WORKING_MEMORY,
      signal,
    )
    await new ContextCompactor(reactiveStore.store, POLICY).compactReactive(
      SESSION,
      EMPTY_WORKING_MEMORY,
      signal,
    )
    await new ContextCompactor(manualStore.store, POLICY).compactManual(
      SESSION,
      EMPTY_WORKING_MEMORY,
      signal,
    )

    expect(preflightStore.appended).toHaveLength(0)
    expect(reactiveStore.appended).toHaveLength(0)
    expect(manualStore.appended).toHaveLength(1)
  })
})
