import { describe, expect, it } from 'vitest'

import { DEFAULT_REASONING_EFFORT } from '../../src/core/models.js'
import {
  ModelEventType,
  ModelTier,
  THINKING_BUDGET_BY_EFFORT,
  THINKING_MIN_BUDGET_TOKENS,
  thinkingConfigFor,
  type ModelEvent,
  type ModelRequest,
} from '../../src/core/provider.js'

describe('ModelEventType', () => {
  it('只有 4 种事件（Anthropic-only：移除了 reasoning 与 incomplete_tool_call）', () => {
    expect(Object.values(ModelEventType).sort()).toEqual(['text', 'thinking', 'tool_use'])
  })

  it('刻意缺席的事件（旧实现也没有，不得凭空增加）', () => {
    const values: string[] = Object.values(ModelEventType)
    // 用量经 TokenUsage 独立返回，不是事件
    expect(values).not.toContain('usage')
    // 错误以异常抛出，不是事件
    expect(values).not.toContain('error')
    // 不存在生命周期事件
    expect(values).not.toContain('start')
    expect(values).not.toContain('stop')
    expect(values).not.toContain('done')
    expect(values).not.toContain('stop_reason')
    // OpenAI 兼容分支专有，随 Anthropic-only 一并移除
    expect(values).not.toContain('reasoning')
    expect(values).not.toContain('incomplete_tool_call')
  })

  it('事件名与 Anthropic 语义对齐', () => {
    expect(ModelEventType.THINKING).toBe('thinking')
    expect(ModelEventType.TEXT).toBe('text')
    expect(ModelEventType.TOOL_USE).toBe('tool_use')
  })
})

describe('ModelEvent 判别联合', () => {
  it('thinking 事件携带完整文本与签名（非增量）', () => {
    const event: ModelEvent = {
      type: ModelEventType.THINKING,
      thinking: '让我想想',
      signature: 'EqQBCgIYAh',
    }
    expect(event.thinking).toBe('让我想想')
    expect(event.signature).toBe('EqQBCgIYAh')
  })

  it('text 事件是增量，空串合法（Anthropic 会下发空 delta）', () => {
    const empty: ModelEvent = { type: ModelEventType.TEXT, content: '' }
    expect(empty.content).toBe('')

    const chunk: ModelEvent = { type: ModelEventType.TEXT, content: '你好' }
    expect(chunk.content).toBe('你好')
  })

  it('tool_use 的 input 已是解析后的对象，不是 JSON 字符串', () => {
    const event: ModelEvent = {
      type: ModelEventType.TOOL_USE,
      id: 'toolu_01ABC',
      name: 'file_read',
      input: { path: 'src/a.ts' },
    }
    if (event.type === ModelEventType.TOOL_USE) {
      expect(typeof event.input).toBe('object')
      expect(event.input['path']).toBe('src/a.ts')
    }
  })

  it('可按 type 判别收窄访问字段', () => {
    const events: ModelEvent[] = [
      { type: ModelEventType.THINKING, thinking: 't', signature: 's' },
      { type: ModelEventType.TEXT, content: 'x' },
      { type: ModelEventType.TOOL_USE, id: 'i', name: 'n', input: {} },
    ]

    const kinds = events.map((e) => e.type)
    expect(kinds).toEqual(['thinking', 'text', 'tool_use'])
  })
})

describe('ModelTier', () => {
  it('6 个档位', () => {
    expect(Object.values(ModelTier).sort()).toEqual([
      'exploration',
      'fast',
      'implementation',
      'planning',
      'review',
      'writing',
    ])
  })

  it('档位只是策略名，不绑定任何模型品牌', () => {
    // parts/09 §9.3：代码里不得把档位映射到具体模型
    for (const tier of Object.values(ModelTier)) {
      expect(tier).not.toMatch(/claude|gpt|gemini|deepseek|qwen/i)
    }
  })
})

describe('thinking budget 约束', () => {
  it('官方 Anthropic 要求 maxTokens > budgetTokens', () => {
    // 旧实现从不发送 budget_tokens（面向不校验该字段的兼容端点），
    // 直接对接官方 API 会失败。本实现要求显式提供，构造方需自行满足约束。
    const request: ModelRequest = {
      model: 'claude-sonnet-5',
      maxTokens: 8192,
      messages: [{ role: 'user', content: 'hi' }],
      thinking: { type: 'enabled', budgetTokens: 4096 },
    }

    expect(request.thinking!.budgetTokens).toBeLessThan(request.maxTokens)
  })

  it('不发送旧的采样控制字段', () => {
    const request: ModelRequest = {
      model: 'm',
      maxTokens: 100,
      messages: [],
    }
    // temperature / top_p / top_k 等旧实现从不发送，本实现也不发
    expect(Object.keys(request)).not.toContain('temperature')
    expect(Object.keys(request)).not.toContain('top_p')
    expect(Object.keys(request)).not.toContain('tool_choice')
  })
})

describe('thinkingConfigFor', () => {
  const base = { thinkingEnabled: true, reasoningEffort: 'high' } as const

  it('缺省（未设置）即关闭——与旧 thinking_enabled 默认 True 有意不同', () => {
    // 依据 ADR 0004 D3：本项目 supportsThinking 缺省 false、TUI 状态栏也把
    // 缺省渲染成 OFF。沿用旧的 True 默认会让默认配置请求模型没声明的能力。
    expect(thinkingConfigFor({}, 128_000)).toBeUndefined()
    expect(thinkingConfigFor({ reasoningEffort: 'high' }, 128_000)).toBeUndefined()
  })

  it('显式 false 也关闭（缺省与 false 在存储里是两件事，行为上都是不发）', () => {
    expect(
      thinkingConfigFor({ thinkingEnabled: false, reasoningEffort: 'high' }, 128_000),
    ).toBeUndefined()
  })

  it('四档折算成预算表里的值', () => {
    expect(thinkingConfigFor({ thinkingEnabled: true, reasoningEffort: 'low' }, 128_000)).toEqual({
      type: 'enabled',
      budgetTokens: 4_000,
    })
    expect(
      thinkingConfigFor({ thinkingEnabled: true, reasoningEffort: 'medium' }, 128_000),
    ).toEqual({
      type: 'enabled',
      budgetTokens: 12_000,
    })
    expect(thinkingConfigFor(base, 128_000)).toEqual({ type: 'enabled', budgetTokens: 24_000 })
    expect(thinkingConfigFor({ thinkingEnabled: true, reasoningEffort: 'xhigh' }, 128_000)).toEqual(
      {
        type: 'enabled',
        budgetTokens: 48_000,
      },
    )
  })

  it('强度缺失或非法时回落到默认档，而不是不发 thinking', () => {
    // 开了思考却没写强度，是配置不完整而不是"不要思考"。
    expect(thinkingConfigFor({ thinkingEnabled: true }, 128_000)).toEqual({
      type: 'enabled',
      budgetTokens: THINKING_BUDGET_BY_EFFORT[DEFAULT_REASONING_EFFORT],
    })
    expect(thinkingConfigFor({ thinkingEnabled: true, reasoningEffort: 'ultra' }, 128_000)).toEqual(
      { type: 'enabled', budgetTokens: THINKING_BUDGET_BY_EFFORT[DEFAULT_REASONING_EFFORT] },
    )
  })

  it('maxTokens 小于预算时向下压，且恒满足 maxTokens > budgetTokens', () => {
    // Anthropic 要求 max_tokens > budget_tokens；压不动就会在 provider 层炸掉，
    // 所以这里必须保证不变式，而不是"尽量"。
    const config = thinkingConfigFor({ thinkingEnabled: true, reasoningEffort: 'high' }, 5_000)
    expect(config).toEqual({ type: 'enabled', budgetTokens: 5_000 - 1_024 })
    expect(5_000).toBeGreaterThan(config!.budgetTokens)
  })

  /**
   * `budget_tokens` 有**两条**官方硬性约束：最小 1024，且小于 `max_tokens`。
   *
   * 早先的实现只保证了后者（下界取 1），于是 `maxOutputTokens` 在
   * 1025..2047 之间的模型会发出 `budget_tokens: 1000`——必然被 endpoint 拒绝。
   * 而这正是 D1 要修的事：旧实现因为不发 budget_tokens 对接不上官方 API，
   * 压低到一个必然被拒的值只是把"缺字段"换成"字段非法"。
   * 现在的行为是**不发**：宁可这一轮没有思考，也不发一个 400。
   */
  it('maxTokens 小到放不下合法预算时 → 不发 thinking', () => {
    // 阈值是 2047 而不是 2048：`maxTokens < 2048` 时余量按 `⌊m/2⌋` 收缩，
    // 可用的预算是 `⌈m/2⌉`，它要到 `m = 2047` 才够 1024。
    expect(thinkingConfigFor(base, 2_046)).toBeUndefined()
    expect(thinkingConfigFor(base, 2_000)).toBeUndefined()
    expect(thinkingConfigFor(base, 1_024)).toBeUndefined()
    expect(thinkingConfigFor(base, 1)).toBeUndefined()
  })

  it('刚好放得下时取下限，且仍严格小于 maxTokens', () => {
    const config = thinkingConfigFor(base, 2_047)
    expect(config).toEqual({ type: 'enabled', budgetTokens: 1_024 })
    // 两条官方约束在边界上同时成立——这正是最容易写错的地方
    expect(config!.budgetTokens).toBeGreaterThanOrEqual(THINKING_MIN_BUDGET_TOKENS)
    expect(2_047).toBeGreaterThan(config!.budgetTokens)
  })

  it('对每个取得到的值都维持两条硬性约束', () => {
    for (const maxTokens of [2_048, 2_049, 5_000, 10_000, 64_000, 128_000, 1_000_000]) {
      for (const reasoningEffort of ['low', 'medium', 'high', 'xhigh']) {
        const config = thinkingConfigFor({ thinkingEnabled: true, reasoningEffort }, maxTokens)
        expect(config, `${reasoningEffort}/${maxTokens} 应当可行`).toBeDefined()
        expect(config!.budgetTokens).toBeGreaterThanOrEqual(THINKING_MIN_BUDGET_TOKENS)
        expect(config!.budgetTokens).toBeLessThan(maxTokens)
        expect(Number.isInteger(config!.budgetTokens)).toBe(true)
      }
    }
  })

  it('maxTokens 非有限或非整数时的行为是确定的', () => {
    // 手改 config.json（ADR 0004 D10 明确引导用户这么做）可以写小数或坏值；
    // `asNum` 只校验 Number.isFinite，归一化不会拦它。
    expect(thinkingConfigFor(base, Number.NaN)).toBeUndefined()
    expect(thinkingConfigFor(base, Number.POSITIVE_INFINITY)).toBeUndefined()
    expect(thinkingConfigFor(base, 0)).toBeUndefined()
    expect(thinkingConfigFor(base, -1)).toBeUndefined()
    // 小数先取整再折算，绝不把非整数发给 endpoint
    expect(thinkingConfigFor(base, 8_000.7)).toEqual({ type: 'enabled', budgetTokens: 6_976 })
  })
})
