import { describe, expect, it } from 'vitest'

import {
  BudgetDimension,
  BudgetTracker,
  DEFAULT_BUDGET,
  DEFAULT_CONTINUATION_LIMITS,
  allocateChildBudget,
} from '../../src/core/budget.js'
import { createFakeClock } from '../../src/core/time.js'

function tracker(overrides: Partial<typeof DEFAULT_BUDGET> = {}): {
  tracker: BudgetTracker
  clock: ReturnType<typeof createFakeClock>
} {
  const clock = createFakeClock()
  return { tracker: new BudgetTracker({ ...DEFAULT_BUDGET, ...overrides }, clock), clock }
}

describe('DEFAULT_BUDGET', () => {
  it('模型调用上限沿用旧项目的 max_tool_rounds 默认值 10', () => {
    expect(DEFAULT_BUDGET.maxModelCalls).toBe(10)
  })
})

describe('DEFAULT_CONTINUATION_LIMITS', () => {
  it('三个计数器与旧实现一致', () => {
    expect(DEFAULT_CONTINUATION_LIMITS.maxAutoContinues).toBe(3)
    expect(DEFAULT_CONTINUATION_LIMITS.autoContinueTurns).toBe(10)
    expect(DEFAULT_CONTINUATION_LIMITS.maxIncompleteContinues).toBe(3)
    expect(DEFAULT_CONTINUATION_LIMITS.maxContextRetries).toBe(1)
  })
})

describe('BudgetTracker', () => {
  it('初始未耗尽', () => {
    const { tracker: t } = tracker()
    expect(t.check()).toBeUndefined()
    expect(t.exhausted).toBe(false)
  })

  it('模型调用达到上限即耗尽', () => {
    const { tracker: t } = tracker({ maxModelCalls: 2 })
    t.recordModelCall()
    expect(t.exhausted).toBe(false)
    t.recordModelCall()
    expect(t.check()).toEqual({ dimension: BudgetDimension.MODEL_CALL, limit: 2, consumed: 2 })
  })

  it('工具调用达到上限即耗尽', () => {
    const { tracker: t } = tracker({ maxToolCalls: 1, maxModelCalls: 99 })
    t.recordToolCall()
    expect(t.check()?.dimension).toBe(BudgetDimension.TOOL_CALL)
  })

  it('墙钟超时即耗尽', () => {
    const { tracker: t, clock } = tracker({ maxWallTimeMs: 1000 })
    clock.advance(999)
    expect(t.exhausted).toBe(false)
    clock.advance(1)
    expect(t.check()?.dimension).toBe(BudgetDimension.WALL_TIME)
  })

  it('output_tokens 累加，input_tokens 取快照', () => {
    const { tracker: t } = tracker({ maxInputTokens: 1000, maxOutputTokens: 1000 })

    t.recordUsage({ inputTokens: 100, outputTokens: 10 })
    t.recordUsage({ inputTokens: 50, outputTokens: 20 })

    // input 是最近一次的快照（50），不是累加（150）
    expect(t.snapshot().inputTokens).toBe(50)
    // output 是累加（30）
    expect(t.snapshot().outputTokens).toBe(30)
  })

  it('未配置 maxCost 时不施加成本限制', () => {
    const { tracker: t } = tracker()
    t.recordCost(999_999)
    expect(t.check()).toBeUndefined()
  })

  it('配置了 maxCost 时按成本耗尽', () => {
    const { tracker: t } = tracker({ maxCost: 5 })
    t.recordCost(4)
    expect(t.exhausted).toBe(false)
    t.recordCost(1)
    expect(t.check()?.dimension).toBe(BudgetDimension.COST)
  })

  it('判定顺序固定：模型调用优先于其它维度', () => {
    const { tracker: t } = tracker({ maxModelCalls: 1, maxToolCalls: 1 })
    t.recordModelCall()
    t.recordToolCall()
    expect(t.check()?.dimension).toBe(BudgetDimension.MODEL_CALL)
  })

  it('snapshot 反映全部维度', () => {
    const { tracker: t, clock } = tracker()
    t.recordModelCall()
    t.recordToolCall()
    t.recordUsage({ inputTokens: 7, outputTokens: 3 })
    clock.advance(250)

    expect(t.snapshot()).toEqual({
      modelCalls: 1,
      toolCalls: 1,
      wallTimeMs: 250,
      inputTokens: 7,
      outputTokens: 3,
      cost: 0,
    })
  })

  it('remainingRatio 在充足时为 1，耗尽时截断到 0 不为负', () => {
    const { tracker: t } = tracker({ maxModelCalls: 2 })
    expect(t.remainingRatio()).toBe(1)

    t.recordModelCall()
    t.recordModelCall()
    t.recordModelCall()
    expect(t.remainingRatio()).toBe(0)
  })
})

describe('allocateChildBudget', () => {
  const parent = {
    maxModelCalls: 10,
    maxToolCalls: 50,
    maxWallTimeMs: 600_000,
    maxInputTokens: 2_000_000,
    maxOutputTokens: 200_000,
    maxCost: 100,
  }

  it('子代理预算不得超过父代理（安全属性：委派不能放大预算）', () => {
    const child = allocateChildBudget(parent, { maxModelCalls: 999, maxToolCalls: 999 })
    expect(child.maxModelCalls).toBe(10)
    expect(child.maxToolCalls).toBe(50)
  })

  it('定义声明的更小上限生效', () => {
    const child = allocateChildBudget(parent, { maxModelCalls: 3 })
    expect(child.maxModelCalls).toBe(3)
    expect(child.maxToolCalls).toBe(50)
  })

  it('未声明的维度继承父代理上限', () => {
    const child = allocateChildBudget(parent, {})
    expect(child).toEqual(parent)
  })

  it('父未配置成本上限时，子也不会凭空获得成本上限', () => {
    // 显式省略 maxCost（而非传 undefined），与未配置单价的真实情形一致
    const noCost = {
      maxModelCalls: 10,
      maxToolCalls: 50,
      maxWallTimeMs: 600_000,
      maxInputTokens: 2_000_000,
      maxOutputTokens: 200_000,
    }
    const child = allocateChildBudget(noCost, { maxCost: 10 })
    expect(child.maxCost).toBeUndefined()
  })

  it('成本上限也取更严格的一方', () => {
    expect(allocateChildBudget(parent, { maxCost: 5 }).maxCost).toBe(5)
    expect(allocateChildBudget(parent, { maxCost: 500 }).maxCost).toBe(100)
  })

  it('子代理可用更小的预算运行', () => {
    const clock = createFakeClock()
    const childBudget = allocateChildBudget(parent, { maxModelCalls: 2 })
    const tracker = new BudgetTracker(childBudget, clock)

    tracker.recordModelCall()
    tracker.recordModelCall()

    expect(tracker.exhausted).toBe(true)
  })
})
