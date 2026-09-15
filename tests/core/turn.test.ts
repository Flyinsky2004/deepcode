import { describe, expect, it } from 'vitest'

import { createEventId, createSessionId, createTurnId } from '../../src/core/ids.js'
import { RuntimeEventType } from '../../src/core/turn.js'
import {
  ACTIVE_PHASES,
  TERMINAL_PHASES,
  TurnPhase,
  TurnStatus,
  canTransition,
  isTerminalEvent,
  nextPhases,
  requiresResolution,
  type TurnStreamEvent,
} from '../../src/core/turn.js'

describe('TurnPhase 集合', () => {
  it('终态与进行中阶段互斥且覆盖全集', () => {
    const all = Object.values(TurnPhase)
    expect(ACTIVE_PHASES.size + TERMINAL_PHASES.size).toBe(all.length)

    for (const phase of TERMINAL_PHASES) {
      expect(ACTIVE_PHASES.has(phase), `${phase} 不应同时是进行中`).toBe(false)
    }
  })

  it('5 个终态', () => {
    expect([...TERMINAL_PHASES].sort()).toEqual([
      'budget_exceeded',
      'cancelled',
      'completed',
      'context_exceeded',
      'failed',
    ])
  })

  it('补上了 parts/09 缺失的 awaiting_user_input（旧实现有此等待）', () => {
    // ask_user_question 会阻塞最多 120 秒。09 的 TurnPhase 没列这个状态，
    // 但恢复语义与 awaiting_permission 不同，因此显式建模。
    expect(TurnPhase.AWAITING_USER_INPUT).toBe('awaiting_user_input')
    expect(ACTIVE_PHASES.has(TurnPhase.AWAITING_USER_INPUT)).toBe(true)
  })
})

describe('状态迁移表', () => {
  it('终态没有出边', () => {
    for (const phase of TERMINAL_PHASES) {
      expect(nextPhases(phase), `${phase} 应是终态`).toEqual([])
    }
  })

  it('每个进行中阶段都至少有一条出边（不会卡死）', () => {
    for (const phase of ACTIVE_PHASES) {
      expect(nextPhases(phase).length, `${phase} 应有出边`).toBeGreaterThan(0)
    }
  })

  it('任何进行中阶段都能被取消', () => {
    for (const phase of ACTIVE_PHASES) {
      expect(canTransition(phase, TurnPhase.CANCELLED), `${phase} 应可取消`).toBe(true)
    }
  })

  it('任何进行中阶段都能失败（异常可在任意点抛出）', () => {
    for (const phase of ACTIVE_PHASES) {
      expect(canTransition(phase, TurnPhase.FAILED), `${phase} 应可失败`).toBe(true)
    }
  })

  it('主流程迁移合法', () => {
    expect(canTransition(TurnPhase.STARTING, TurnPhase.BUILDING_CONTEXT)).toBe(true)
    expect(canTransition(TurnPhase.BUILDING_CONTEXT, TurnPhase.CALLING_MODEL)).toBe(true)
    expect(canTransition(TurnPhase.CALLING_MODEL, TurnPhase.EXECUTING_TOOLS)).toBe(true)
    expect(canTransition(TurnPhase.EXECUTING_TOOLS, TurnPhase.CALLING_MODEL)).toBe(true)
    expect(canTransition(TurnPhase.CALLING_MODEL, TurnPhase.COMPLETED)).toBe(true)
  })

  it('calling_model 可自环（多轮工具循环里每轮都是一次模型调用）', () => {
    expect(canTransition(TurnPhase.CALLING_MODEL, TurnPhase.CALLING_MODEL)).toBe(true)
  })

  it('pending 授权被批准后进入执行，被拒绝后回到模型', () => {
    expect(canTransition(TurnPhase.AWAITING_PERMISSION, TurnPhase.EXECUTING_TOOLS)).toBe(true)
    expect(canTransition(TurnPhase.AWAITING_PERMISSION, TurnPhase.CALLING_MODEL)).toBe(true)
  })

  it('压缩可从上下文组装或模型调用进入，回到对应阶段', () => {
    expect(canTransition(TurnPhase.BUILDING_CONTEXT, TurnPhase.COMPACTING)).toBe(true)
    expect(canTransition(TurnPhase.CALLING_MODEL, TurnPhase.COMPACTING)).toBe(true)
    expect(canTransition(TurnPhase.COMPACTING, TurnPhase.BUILDING_CONTEXT)).toBe(true)
    expect(canTransition(TurnPhase.COMPACTING, TurnPhase.CALLING_MODEL)).toBe(true)
  })

  it('拒绝非法迁移', () => {
    // 终态不可再迁移
    expect(canTransition(TurnPhase.COMPLETED, TurnPhase.CALLING_MODEL)).toBe(false)
    expect(canTransition(TurnPhase.FAILED, TurnPhase.COMPLETED)).toBe(false)
    expect(canTransition(TurnPhase.CANCELLED, TurnPhase.CALLING_MODEL)).toBe(false)
    // 不能跳过上下文组装
    expect(canTransition(TurnPhase.STARTING, TurnPhase.CALLING_MODEL)).toBe(false)
    // 不能从执行直接完成（必须先经模型给出终结回复）
    expect(canTransition(TurnPhase.EXECUTING_TOOLS, TurnPhase.COMPLETED)).toBe(false)
  })
})

describe('TurnStatus', () => {
  it('6 个状态，part: partial 是正常结果不是失败', () => {
    expect(Object.values(TurnStatus).sort()).toEqual([
      'budget_exceeded',
      'cancelled',
      'completed',
      'context_exceeded',
      'failed',
      'partial',
    ])
  })

  it('partial 与 failed 是不同的值（不得互相伪装）', () => {
    expect(TurnStatus.PARTIAL).not.toBe(TurnStatus.FAILED)
  })
})

describe('事件判定', () => {
  const sessionId = createSessionId()
  const turnId = createTurnId(sessionId, 1)

  function makeEvent(type: string, data: Record<string, unknown> = {}): TurnStreamEvent {
    return {
      sessionId,
      turnId,
      type,
      data,
    } as unknown as TurnStreamEvent
  }

  it('isTerminalEvent 同时认可 turn_end 与 error', () => {
    // 部分失败路径只发 error 不发 turn_end——只认 turn_end 的消费方会永久等待
    expect(isTerminalEvent(makeEvent(RuntimeEventType.TURN_END))).toBe(true)
    expect(isTerminalEvent(makeEvent(RuntimeEventType.ERROR))).toBe(true)
    expect(isTerminalEvent(makeEvent(RuntimeEventType.TEXT))).toBe(false)
    expect(isTerminalEvent(makeEvent(RuntimeEventType.TOOL_RESULT))).toBe(false)
  })

  it('requiresResolution 只对需要回灌的事件为真', () => {
    expect(isTerminalEvent(makeEvent(RuntimeEventType.PERMISSION_REQUIRED))).toBe(false)
    expect(requiresResolution(makeEvent(RuntimeEventType.PERMISSION_REQUIRED))).toBe(true)
    expect(requiresResolution(makeEvent(RuntimeEventType.USER_INPUT_REQUIRED))).toBe(true)
    expect(requiresResolution(makeEvent(RuntimeEventType.TEXT))).toBe(false)
  })

  it('需要回灌的事件都不是终止事件', () => {
    for (const type of [
      RuntimeEventType.PERMISSION_REQUIRED,
      RuntimeEventType.USER_INPUT_REQUIRED,
    ]) {
      const event = makeEvent(type)
      expect(requiresResolution(event) && isTerminalEvent(event)).toBe(false)
    }
  })

  it('事件类型名与旧实现逐字一致（稳定契约）', () => {
    expect(Object.values(RuntimeEventType).sort()).toEqual([
      'auto_continue',
      'compact_end',
      'compact_start',
      'error',
      'model_route_changed',
      'permission_required',
      'skill_resolved',
      'text',
      'thinking',
      'tool_result',
      'tool_use',
      'turn_end',
      'turn_start',
      'user_input_required',
    ])
  })

  /**
   * 13 → 14。
   *
   * `model_route_changed` 是 ADR 0002 §3 冻结事件集之后**唯一**新增的一种
   * （ADR 0004 D8），依据是 `parts/09` §6.1 与 §9.5 都要求把路由决策写进事件。
   * 这条断言刻意写成精确数字：事件集是有意冻结的契约，静默增删必须让测试红。
   */
  it('恰好 14 种事件', () => {
    expect(Object.values(RuntimeEventType)).toHaveLength(14)
  })

  it('model_route_changed 是通知类事件，不是终止信号', () => {
    expect(isTerminalEvent(makeEvent(RuntimeEventType.MODEL_ROUTE_CHANGED))).toBe(false)
    expect(requiresResolution(makeEvent(RuntimeEventType.MODEL_ROUTE_CHANGED))).toBe(false)
  })
})

describe('PhaseTransition 审计字段', () => {
  it('迁移记录携带 turnId / reason / 时间 / eventId', () => {
    const sessionId = createSessionId()
    const transition = {
      turnId: createTurnId(sessionId, 3),
      from: TurnPhase.STARTING,
      to: TurnPhase.BUILDING_CONTEXT,
      reason: 'user message persisted',
      timestamp: '2026-09-14T02:39:11.123Z',
      eventId: createEventId(),
    }

    // 这些字段是恢复与审计的必需项（parts/09 §2）
    expect(transition.turnId).toBe('turn_3_' + sessionId.slice(0, 8))
    expect(transition.reason).toBeTruthy()
    expect(transition.eventId).toBeTruthy()
    expect(canTransition(transition.from, transition.to)).toBe(true)
  })
})
