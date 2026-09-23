/**
 * 事件 → UI 映射（`app.py:486-537`）。
 *
 * 重点断言三件事：
 * 1. `thinking` / `tool_use` **被忽略**（§8.4）；
 * 2. `error` 与 `turn_end` 一样是终止信号，都触发排队重提；
 * 3. T-6：`mode.change` 由**表现层**完成模式切换。
 */

import { describe, expect, it } from 'vitest'

import type { RuntimeEventEnvelope } from '../../src/core/events.js'
import type { PrincipalId } from '../../src/core/ids.js'
import { RuntimeEventType } from '../../src/core/turn.js'
import {
  applyEvent,
  createQuestionnaire,
  enqueuePermission,
  estimateStreamingTokens,
  modeIndexFromName,
} from '../../src/clients/tui/events.js'
import { createInitialState, type TuiState } from '../../src/clients/tui/types.js'

function state(overrides: Partial<TuiState> = {}): TuiState {
  return { ...createInitialState({ principalId: 'p' as PrincipalId }), ...overrides }
}

function event(type: string, data: unknown): RuntimeEventEnvelope {
  return {
    eventId: `evt-${type}` as RuntimeEventEnvelope['eventId'],
    sequence: 1,
    type,
    timestamp: '2026-09-15T00:00:00.000Z',
    sessionId: 'session-1' as RuntimeEventEnvelope['sessionId'],
    data,
  }
}

describe('estimateStreamingTokens', () => {
  it('粗估是 max(1, len//4)', () => {
    expect(estimateStreamingTokens('')).toBe(1)
    expect(estimateStreamingTokens('abc')).toBe(1)
    expect(estimateStreamingTokens('a'.repeat(40))).toBe(10)
  })
})

describe('modeIndexFromName', () => {
  it('四个模式名映射到序号', () => {
    expect(modeIndexFromName('normal')).toBe(0)
    expect(modeIndexFromName('auto_edit')).toBe(1)
    expect(modeIndexFromName('yolo')).toBe(2)
    expect(modeIndexFromName('plan')).toBe(3)
  })

  it('未知字符串返回 undefined（不改模式）', () => {
    expect(modeIndexFromName('turbo')).toBeUndefined()
  })
})

describe('turn_start', () => {
  it('清空流式累积、待办与面板，并隐藏首页', () => {
    const before = state({
      streamingText: 'partial',
      streamingTokens: 9,
      todos: [{ content: 'x', status: 'pending' }],
      todoVisible: true,
      emptyStateVisible: true,
      panel: { title: 't', body: 'b' },
      notice: 'n',
    })
    const applied = applyEvent(before, event(RuntimeEventType.TURN_START, { turn_number: 1 }))
    expect(applied.state.streamingText).toBe('')
    expect(applied.state.streamingTokens).toBe(0)
    expect(applied.state.todos).toEqual([])
    expect(applied.state.todoVisible).toBe(false)
    expect(applied.state.emptyStateVisible).toBe(false)
    expect(applied.state.panel).toBeUndefined()
    expect(applied.state.notice).toBeUndefined()
  })
})

describe('thinking 与 tool_use 被忽略', () => {
  it('thinking 不产生任何状态变化或效果', () => {
    const before = state()
    const applied = applyEvent(
      before,
      event(RuntimeEventType.THINKING, { content: 'hmm', preview: 'hmm' }),
    )
    expect(applied.state).toBe(before)
    expect(applied.effects).toEqual([])
  })

  it('tool_use 不产生任何状态变化或效果', () => {
    const before = state()
    const applied = applyEvent(
      before,
      event(RuntimeEventType.TOOL_USE, { id: 't1', name: 'file_read', input: {} }),
    )
    expect(applied.state).toBe(before)
    expect(applied.effects).toEqual([])
  })
})

describe('text', () => {
  it('增量累积并粗估 token', () => {
    let current = state()
    current = applyEvent(current, event(RuntimeEventType.TEXT, { content: 'hello ' })).state
    current = applyEvent(current, event(RuntimeEventType.TEXT, { content: 'world' })).state
    expect(current.streamingText).toBe('hello world')
    expect(current.streamingTokens).toBe(2)
    expect(current.streaming).toBe(true)
  })

  it('缺 content 时按空串处理', () => {
    const applied = applyEvent(state(), event(RuntimeEventType.TEXT, {}))
    expect(applied.state.streamingText).toBe('')
  })
})

describe('tool_result', () => {
  it('只有 todo_write 触发待办刷新', () => {
    expect(
      applyEvent(state(), event(RuntimeEventType.TOOL_RESULT, { name: 'file_read' })).effects,
    ).toEqual([])
    expect(
      applyEvent(state(), event(RuntimeEventType.TOOL_RESULT, { name: 'todo_write' })).effects,
    ).toEqual([{ kind: 'refresh-todos' }])
  })
})

describe('compact_start / compact_end', () => {
  it('切换 compacting 标记', () => {
    const started = applyEvent(
      state(),
      event(RuntimeEventType.COMPACT_START, { strategy: 'preflight' }),
    )
    expect(started.state.compacting).toBe(true)
    const ended = applyEvent(started.state, event(RuntimeEventType.COMPACT_END, { applied: true }))
    expect(ended.state.compacting).toBe(false)
  })
})

describe('permission_required', () => {
  it('入队并触发历史重绘', () => {
    const applied = applyEvent(
      state(),
      event(RuntimeEventType.PERMISSION_REQUIRED, {
        request_id: 'req-1',
        tool_name: 'file_write',
        risk_level: 'high',
        args_preview: '{"path":"a"}',
        reason: 'needs approval',
        expires_at: 123,
      }),
    )
    expect(applied.state.permissionQueue).toEqual([
      {
        requestId: 'req-1',
        toolName: 'file_write',
        riskLevel: 'high',
        argsPreview: '{"path":"a"}',
        reason: 'needs approval',
        expiresAt: 123,
      },
    ])
    expect(applied.effects).toEqual([{ kind: 'render-history' }])
  })

  it('T-2：多条审批排队而不是互相覆盖', () => {
    let current = state()
    current = applyEvent(
      current,
      event(RuntimeEventType.PERMISSION_REQUIRED, { request_id: 'a', tool_name: 't' }),
    ).state
    current = applyEvent(
      current,
      event(RuntimeEventType.PERMISSION_REQUIRED, { request_id: 'b', tool_name: 't' }),
    ).state
    expect(current.permissionQueue.map((p) => p.requestId)).toEqual(['a', 'b'])
  })

  it('同一 request_id 重发（重连补发）不产生第二条', () => {
    const first = enqueuePermission(
      state(),
      event(RuntimeEventType.PERMISSION_REQUIRED, { request_id: 'a' }),
    )
    const second = enqueuePermission(
      first,
      event(RuntimeEventType.PERMISSION_REQUIRED, { request_id: 'a' }),
    )
    expect(second).toBe(first)
  })

  it('缺失字段时给出可渲染的默认值', () => {
    const applied = applyEvent(state(), event(RuntimeEventType.PERMISSION_REQUIRED, {}))
    expect(applied.state.permissionQueue[0]).toMatchObject({
      requestId: '',
      toolName: 'unknown',
      riskLevel: 'medium',
    })
  })
})

describe('permission_resolved', () => {
  it('其他客户端或超时解决的审批会收起本地对话框', () => {
    const before = state({
      permissionQueue: [
        {
          requestId: 'a',
          toolName: 't',
          riskLevel: 'low',
          argsPreview: '',
          reason: '',
          expiresAt: 0,
        },
        {
          requestId: 'b',
          toolName: 't',
          riskLevel: 'low',
          argsPreview: '',
          reason: '',
          expiresAt: 0,
        },
      ],
    })
    const applied = applyEvent(before, event('permission_resolved', { request_id: 'a' }))
    expect(applied.state.permissionQueue.map((p) => p.requestId)).toEqual(['b'])
  })
})

describe('user_input_required', () => {
  const questions = [
    {
      question: 'Q1',
      header: 'H',
      options: [{ label: 'a', description: '' }],
    },
  ]

  it('有题目时打开问卷', () => {
    const applied = applyEvent(
      state(),
      event(RuntimeEventType.USER_INPUT_REQUIRED, { request_id: 'q1', questions }),
    )
    expect(applied.state.questionnaire?.requestId).toBe('q1')
    expect(applied.state.questionnaire?.currentQuestion).toBe(0)
    expect(applied.state.questionnaire?.multiCursorLabel).toBeUndefined()
    expect(applied.effects).toEqual([])
  })

  it('空问题列表立即作答（{"_empty": true} 语义）', () => {
    const applied = applyEvent(
      state(),
      event(RuntimeEventType.USER_INPUT_REQUIRED, { request_id: 'q2', questions: [] }),
    )
    expect(applied.state.questionnaire).toBeUndefined()
    expect(applied.effects).toEqual([
      { kind: 'answer-user-input', requestId: 'q2', answers: [], reason: 'empty' },
    ])
  })

  it('questions 不是数组时也按空处理', () => {
    const applied = applyEvent(
      state(),
      event(RuntimeEventType.USER_INPUT_REQUIRED, { request_id: 'q3', questions: 'nope' }),
    )
    expect(applied.effects).toEqual([
      { kind: 'answer-user-input', requestId: 'q3', answers: [], reason: 'empty' },
    ])
  })

  it('createQuestionnaire 每次重置光标（T-10：不跨问卷残留）', () => {
    const first = createQuestionnaire('a', questions)
    expect(first.multiCursorLabel).toBeUndefined()
  })

  it('user_input_resolved 收起对应问卷', () => {
    const before = state({ questionnaire: createQuestionnaire('q1', questions) })
    const applied = applyEvent(before, event('user_input_resolved', { request_id: 'q1' }))
    expect(applied.state.questionnaire).toBeUndefined()
    // 不匹配的 request_id 不动
    expect(
      applyEvent(before, event('user_input_resolved', { request_id: 'x' })).state.questionnaire,
    ).not.toBeUndefined()
  })
})

describe('turn_end', () => {
  it('记账：输入快照 + 输出累加', () => {
    const before = state({ lastInputTokens: 1, totalOutputTokens: 10 })
    const applied = applyEvent(
      before,
      event(RuntimeEventType.TURN_END, {
        input_tokens: 500,
        output_tokens: 20,
      }),
    )
    expect(applied.state.lastInputTokens).toBe(500)
    expect(applied.state.totalOutputTokens).toBe(30)
  })

  it('停止流式、清空临时权限与问卷，并重绘历史', () => {
    const before = state({
      streaming: true,
      streamingText: 'partial',
      permissionQueue: [
        {
          requestId: 'a',
          toolName: 't',
          riskLevel: 'low',
          argsPreview: '',
          reason: '',
          expiresAt: 0,
        },
      ],
      questionnaire: createQuestionnaire('q', []),
    })
    const applied = applyEvent(before, event(RuntimeEventType.TURN_END, {}))
    expect(applied.state.streaming).toBe(false)
    expect(applied.state.streamingText).toBe('')
    expect(applied.state.permissionQueue).toEqual([])
    expect(applied.state.questionnaire).toBeUndefined()
    expect(applied.effects).toEqual([{ kind: 'render-history' }])
  })

  it('取消且队列里有 prompt 时自动重提', () => {
    const before = state({ pendingPrompt: 'second question' })
    const applied = applyEvent(before, event(RuntimeEventType.TURN_END, { cancelled: true }))
    expect(applied.state.pendingPrompt).toBeUndefined()
    expect(applied.effects).toEqual([
      { kind: 'render-history' },
      { kind: 'submit-prompt', prompt: 'second question' },
    ])
  })

  it('取消但没有排队 prompt 时不重提', () => {
    const applied = applyEvent(state(), event(RuntimeEventType.TURN_END, { cancelled: true }))
    expect(applied.effects).toEqual([{ kind: 'render-history' }])
  })

  it('正常结束（未取消）即使有 pendingPrompt 也不重提', () => {
    const applied = applyEvent(state({ pendingPrompt: 'x' }), event(RuntimeEventType.TURN_END, {}))
    expect(applied.effects.some((effect) => effect.kind === 'submit-prompt')).toBe(false)
  })
})

describe('error 是终止信号', () => {
  it('停止流式、显示错误、重绘历史', () => {
    const applied = applyEvent(
      state({ streaming: true, streamingText: 'partial' }),
      event(RuntimeEventType.ERROR, { message: 'boom' }),
    )
    expect(applied.state.streaming).toBe(false)
    expect(applied.state.streamingText).toBe('')
    expect(applied.state.lastError).toBe('boom')
    expect(applied.effects).toEqual([{ kind: 'render-history' }])
  })

  it('与 turn_end 一样触发排队重提（否则 UI 会挂住）', () => {
    const applied = applyEvent(
      state({ pendingPrompt: 'queued' }),
      event(RuntimeEventType.ERROR, { message: 'boom' }),
    )
    expect(applied.effects).toEqual([
      { kind: 'render-history' },
      { kind: 'submit-prompt', prompt: 'queued' },
    ])
  })
})

describe('T-6：mode.change 由表现层完成', () => {
  it('事件把模式切到 plan', () => {
    const applied = applyEvent(state(), event('mode.change', { mode: 'plan' }))
    expect(applied.state.mode).toBe(3)
  })

  it('未知模式名不改状态', () => {
    const before = state({ mode: 2 })
    expect(applyEvent(before, event('mode.change', { mode: 'warp' })).state.mode).toBe(2)
  })
})

describe('未知事件类型', () => {
  it('原样返回（EventBus 也会推命令审计等事件）', () => {
    const before = state()
    const applied = applyEvent(before, event('command.audit', { anything: true }))
    expect(applied.state).toBe(before)
    expect(applied.effects).toEqual([])
  })
})

describe('skill_resolved / auto_continue', () => {
  it('skill_resolved 触发历史重绘', () => {
    const applied = applyEvent(
      state(),
      event(RuntimeEventType.SKILL_RESOLVED, {
        applied_skills: [],
        active_phase: '',
        guards_applied: 0,
      }),
    )
    expect(applied.effects).toEqual([{ kind: 'render-history' }])
  })

  it('auto_continue 不改变任何状态（本实现不发射）', () => {
    const before = state()
    expect(applyEvent(before, event(RuntimeEventType.AUTO_CONTINUE, { count: 1 })).state).toBe(
      before,
    )
  })

  it('model_route_changed 在状态栏留下路由切换提示', () => {
    const applied = applyEvent(
      state(),
      event(RuntimeEventType.MODEL_ROUTE_CHANGED, {
        from_provider: 'anthropic',
        from_model: 'claude-sonnet',
        to_provider: 'deepseek',
        to_model: 'deepseek-chat',
        reason: 'rate_limit',
      }),
    )
    expect(applied.state.notice).toContain('anthropic/claude-sonnet')
    expect(applied.state.notice).toContain('deepseek/deepseek-chat')
    expect(applied.state.notice).toContain('rate_limit')
  })
})
