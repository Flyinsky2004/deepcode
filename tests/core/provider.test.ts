import { describe, expect, it } from 'vitest'

import {
  ModelEventType,
  ModelTier,
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
