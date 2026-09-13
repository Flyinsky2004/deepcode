import { describe, expect, it } from 'vitest'

import {
  PermissionAction,
  PermissionRequestStatus,
  RiskLevel,
  TERMINAL_PERMISSION_STATUSES,
  ToolCapability,
  ToolExecutionStatus,
  canTransitionPermission,
} from '../../src/core/tool.js'

describe('RiskLevel', () => {
  it('4 档，含 critical（09 §5 为准，旧实现只有 3 档）', () => {
    expect(Object.values(RiskLevel).sort()).toEqual(['critical', 'high', 'low', 'medium'])
  })
})

describe('PermissionAction', () => {
  it('三值动作，取代旧实现的双布尔编码', () => {
    expect(Object.values(PermissionAction).sort()).toEqual(['allow', 'ask', 'deny'])
  })
})

describe('ToolCapability', () => {
  it('覆盖读/写/网络/shell/交互/委派/数据访问', () => {
    expect(Object.values(ToolCapability).sort()).toEqual([
      'data_access',
      'delegate',
      'interactive',
      'network',
      'read',
      'shell',
      'write',
    ])
  })
})

describe('PermissionRequestStatus', () => {
  it('5 个状态（旧实现的 8 个把执行进展混进了审批状态）', () => {
    expect(Object.values(PermissionRequestStatus).sort()).toEqual([
      'APPROVED',
      'CANCELLED',
      'CREATED',
      'DENIED',
      'EXPIRED',
      'PENDING_USER_APPROVAL',
    ])
  })

  it('APPROVED 不是终态（它必须继续走向执行）', () => {
    // 若把 APPROVED 当终态，恢复时就无法判断"已批准但未执行"该做什么
    expect(TERMINAL_PERMISSION_STATUSES.has(PermissionRequestStatus.APPROVED)).toBe(false)
  })

  it('拒绝/过期/取消是终态', () => {
    expect(TERMINAL_PERMISSION_STATUSES.has(PermissionRequestStatus.DENIED)).toBe(true)
    expect(TERMINAL_PERMISSION_STATUSES.has(PermissionRequestStatus.EXPIRED)).toBe(true)
    expect(TERMINAL_PERMISSION_STATUSES.has(PermissionRequestStatus.CANCELLED)).toBe(true)
  })

  it('状态字符串与旧实现逐字一致（磁盘契约）', () => {
    expect(PermissionRequestStatus.PENDING_USER_APPROVAL).toBe('PENDING_USER_APPROVAL')
    expect(PermissionRequestStatus.EXPIRED).toBe('EXPIRED')
  })
})

describe('权限状态迁移', () => {
  it('CREATED → PENDING_USER_APPROVAL', () => {
    expect(
      canTransitionPermission(
        PermissionRequestStatus.CREATED,
        PermissionRequestStatus.PENDING_USER_APPROVAL,
      ),
    ).toBe(true)
  })

  it('PENDING 可走向批准/拒绝/过期/取消', () => {
    for (const next of [
      PermissionRequestStatus.APPROVED,
      PermissionRequestStatus.DENIED,
      PermissionRequestStatus.EXPIRED,
      PermissionRequestStatus.CANCELLED,
    ]) {
      expect(
        canTransitionPermission(PermissionRequestStatus.PENDING_USER_APPROVAL, next),
        `应可迁移到 ${next}`,
      ).toBe(true)
    }
  })

  it('终态没有出边', () => {
    for (const terminal of TERMINAL_PERMISSION_STATUSES) {
      for (const target of Object.values(PermissionRequestStatus)) {
        expect(canTransitionPermission(terminal, target), `${terminal} → ${target}`).toBe(false)
      }
    }
  })

  it('APPROVED 没有出边（执行由独立的执行状态记录）', () => {
    for (const target of Object.values(PermissionRequestStatus)) {
      expect(canTransitionPermission(PermissionRequestStatus.APPROVED, target)).toBe(false)
    }
  })

  it('不能从 CREATED 直接跳到 APPROVED（必须先进入待审批）', () => {
    expect(
      canTransitionPermission(PermissionRequestStatus.CREATED, PermissionRequestStatus.APPROVED),
    ).toBe(false)
  })
})

describe('ToolExecutionStatus', () => {
  it('包含 UNKNOWN（进程中断时副作用是否发生无法确定）', () => {
    expect(ToolExecutionStatus.UNKNOWN).toBe('unknown')
  })

  it('5 个状态', () => {
    expect(Object.values(ToolExecutionStatus).sort()).toEqual([
      'failure',
      'pending',
      'running',
      'success',
      'unknown',
    ])
  })

  it('UNKNOWN 与 FAILURE 是不同的值（前者不得自动重放，后者可以判定为未生效）', () => {
    expect(ToolExecutionStatus.UNKNOWN).not.toBe(ToolExecutionStatus.FAILURE)
  })
})
