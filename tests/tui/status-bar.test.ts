/**
 * 状态栏的优先级与各分支（`app.py:2240-2307`）。
 *
 * 优先级：**compacting → streaming → 无模型 → 正常态**。
 * 另加 Phase 7 的新增项：模型档位与成本。
 */

import { describe, expect, it } from 'vitest'

import type { PrincipalId, SessionId } from '../../src/core/ids.js'
import {
  contextWindowLabel,
  estimateCost,
  formatCost,
  maxOutputLabel,
  modeLabel,
  renderStatusBar,
  statusBarLine,
} from '../../src/clients/tui/status-bar.js'
import { createInitialState, type StatusModel, type TuiState } from '../../src/clients/tui/types.js'

const MODEL: StatusModel = {
  providerName: 'DeepSeek',
  modelName: 'deepseek-v4-pro',
  thinkingEnabled: true,
  reasoningEffort: 'high',
  contextWindow: 1_000_000,
  maxOutputTokens: 128_000,
  tier: 'implementation',
  inputCostPerMillion: 0.5,
  outputCostPerMillion: 1.5,
}

function state(overrides: Partial<TuiState> = {}): TuiState {
  return { ...createInitialState({ principalId: 'p' as PrincipalId }), ...overrides }
}

describe('标签计算', () => {
  it('上下文窗口：>= 1M 显示 1M，否则 K', () => {
    expect(contextWindowLabel(1_000_000)).toBe('1M')
    expect(contextWindowLabel(125_000)).toBe('125K')
    expect(contextWindowLabel(999_999)).toBe('999K')
  })

  it('输出上限：< 1M 显示 K，否则 1M', () => {
    expect(maxOutputLabel(128_000)).toBe('128K')
    expect(maxOutputLabel(1_000_000)).toBe('1M')
  })

  it('模式标签按语言给出四个模式名', () => {
    expect(modeLabel(0, 'en')).toBe('NORMAL')
    expect(modeLabel(1, 'en')).toBe('AUTO EDIT')
    expect(modeLabel(2, 'en')).toBe('YOLO')
    expect(modeLabel(3, 'en')).toBe('PLAN')
    expect(modeLabel(0, 'zh')).toBe('常规')
    expect(modeLabel(3, 'zh')).toBe('计划')
  })
})

describe('成本', () => {
  it('按百万 token 单价计算', () => {
    expect(estimateCost(MODEL, 1_000_000, 1_000_000)).toBeCloseTo(2, 10)
  })

  it('单价缺失时返回 undefined（不报 $0）', () => {
    const noCost: StatusModel = {
      ...MODEL,
      inputCostPerMillion: undefined,
      outputCostPerMillion: undefined,
    }
    expect(estimateCost(noCost, 1000, 1000)).toBeUndefined()
  })

  it('只缺一侧时另一侧按 0 计', () => {
    const half: StatusModel = { ...MODEL, outputCostPerMillion: undefined }
    expect(estimateCost(half, 1_000_000, 1_000_000)).toBeCloseTo(0.5, 10)
  })

  it('格式化保留 4 位小数', () => {
    expect(formatCost(0.012345)).toBe('0.0123')
    expect(formatCost(0)).toBe('0.0000')
  })
})

describe('优先级', () => {
  it('compacting 压过一切', () => {
    const rendered = renderStatusBar(
      state({ compacting: true, streaming: true, sessionId: 's' as SessionId }),
      MODEL,
    )
    expect(rendered.text).toBe('Compacting conversation history...')
  })

  it('streaming 压过模型信息，并带 spinner 与粗估 token', () => {
    const rendered = renderStatusBar(
      state({ streaming: true, spinnerFrame: 1, streamingTokens: 42, sessionId: 's' as SessionId }),
      MODEL,
    )
    expect(rendered.text).toBe('Working... / 42 tok')
  })

  it('token 为 0 时省略 " {tok} tok"', () => {
    const rendered = renderStatusBar(state({ streaming: true, streamingTokens: 0 }), MODEL)
    expect(rendered.text).toBe('Working... |')
  })

  it('spinner 帧循环取模', () => {
    const rendered = renderStatusBar(state({ streaming: true, spinnerFrame: 5 }), MODEL)
    expect(rendered.text.endsWith('/')).toBe(true) // 5 % 4 === 1
  })

  it('无模型时给出提示，与语言一致', () => {
    expect(renderStatusBar(state(), undefined).text).toBe(
      'No model configured — use /api then /model',
    )
    expect(renderStatusBar(state({ language: 'zh' }), undefined).text).toBe(
      '未配置模型 — 请使用 /api 然后 /model',
    )
  })
})

describe('正常态', () => {
  it('各段用 "  |  " 连接，顺序与旧实现一致', () => {
    const rendered = renderStatusBar(state(), MODEL)
    const parts = rendered.text.split('  |  ')
    expect(parts[0]).toBe('DeepSeek / deepseek-v4-pro')
    expect(parts[1]).toBe('Tier: implementation')
    expect(parts[2]).toBe('Think: ON')
    expect(parts[3]).toBe('Effort: high')
    expect(parts[4]).toBe('Ctx: 1M')
    expect(parts[5]).toBe('Out: 128K')
    // 无会话
    expect(parts[6]).toBe('No conversation')
  })

  it('thinking 关闭时显示 OFF', () => {
    const rendered = renderStatusBar(state(), { ...MODEL, thinkingEnabled: false })
    expect(rendered.text).toContain('Think: OFF')
  })

  it('reasoningEffort 缺失时显示 default', () => {
    const rendered = renderStatusBar(state(), { ...MODEL, reasoningEffort: undefined })
    expect(rendered.text).toContain('Effort: default')
  })

  it('有会话时显示消息条数（T-9：取自已读过的状态，不再读盘）', () => {
    const rendered = renderStatusBar(
      state({
        sessionId: 's' as SessionId,
        messages: [{ id: 'm1' } as never, { id: 'm2' } as never, { id: 'm3' } as never],
      }),
      MODEL,
    )
    expect(rendered.text).toContain('3 msgs')
  })

  it('有 token 记账时追加 ↑in ↓out (pct%)', () => {
    const rendered = renderStatusBar(
      state({ sessionId: 's' as SessionId, lastInputTokens: 250_000, totalOutputTokens: 1000 }),
      MODEL,
    )
    expect(rendered.text).toContain('↑250000 ↓1000 (25.0%)')
  })

  it('没有输入 token 时退化为无百分比的形态', () => {
    const rendered = renderStatusBar(
      state({ sessionId: 's' as SessionId, lastInputTokens: 0, totalOutputTokens: 7 }),
      MODEL,
    )
    expect(rendered.text).toContain('↑0 ↓7')
    expect(rendered.text).not.toContain('%')
  })

  it('token 全为 0 时不显示用量段', () => {
    const rendered = renderStatusBar(state({ sessionId: 's' as SessionId }), MODEL)
    expect(rendered.text).not.toContain('↑')
  })

  it('有单价时显示成本', () => {
    const rendered = renderStatusBar(
      state({
        sessionId: 's' as SessionId,
        lastInputTokens: 1_000_000,
        totalOutputTokens: 1_000_000,
      }),
      MODEL,
    )
    expect(rendered.text).toContain('$2.0000')
  })

  it('无单价时不显示成本段', () => {
    const rendered = renderStatusBar(state({ sessionId: 's' as SessionId, lastInputTokens: 100 }), {
      ...MODEL,
      inputCostPerMillion: undefined,
      outputCostPerMillion: undefined,
    })
    expect(rendered.text).not.toContain('$')
  })
})

describe('模式标签前缀', () => {
  it('模式标签带颜色，yolo 加粗', () => {
    expect(renderStatusBar(state({ mode: 0 }), MODEL)).toMatchObject({
      modeLabel: 'NORMAL',
      modeColor: '#7dd3fc',
      modeBold: false,
    })
    expect(renderStatusBar(state({ mode: 1 }), MODEL).modeColor).toBe('#fbbf24')
    expect(renderStatusBar(state({ mode: 2 }), MODEL)).toMatchObject({
      modeColor: '#dc2626',
      modeBold: true,
    })
    expect(renderStatusBar(state({ mode: 3 }), MODEL).modeColor).toBe('#60a5fa')
  })

  it('整行是 "模式标签" + 两个空格 + 正文', () => {
    const rendered = renderStatusBar(state(), MODEL)
    expect(statusBarLine(rendered)).toBe(`NORMAL  ${rendered.text}`)
  })
})
