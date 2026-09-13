import { describe, expect, it } from 'vitest'

import {
  createCompactBoundaryId,
  createEventId,
  createMessageId,
  createModelOverrideId,
  createPermissionRequestId,
  createPrincipalId,
  createSessionId,
  createSubAgentSessionId,
  createToolCallId,
  createToolExecutionId,
  createTurnId,
  isValidId,
  parseTurnId,
  type SessionId,
} from '../../src/core/ids.js'

describe('createTurnId', () => {
  it('生成旧项目兼容的格式 turn_<序号>_<会话前8位>', () => {
    const sessionId = '9fc43b3a-1111-2222-3333-444455556666' as SessionId
    expect(createTurnId(sessionId, 3)).toBe('turn_3_9fc43b3a')
  })

  it('子代理使用 subagent_turn_ 前缀', () => {
    const sessionId = '9fc43b3a-1111-2222-3333-444455556666' as SessionId
    expect(createTurnId(sessionId, 1, { isSubAgent: true })).toBe('subagent_turn_1_9fc43b3a')
  })

  it('序号为 0 时格式不变', () => {
    const sessionId = 'abcdefgh-rest' as SessionId
    expect(createTurnId(sessionId, 0)).toBe('turn_0_abcdefgh')
  })

  it('会话 id 不足 8 位时按实际长度截取，不补位', () => {
    const sessionId = 'abc' as SessionId
    expect(createTurnId(sessionId, 1)).toBe('turn_1_abc')
  })

  it('大序号不做截断', () => {
    const sessionId = '12345678' as SessionId
    expect(createTurnId(sessionId, 12345)).toBe('turn_12345_12345678')
  })
})

describe('parseTurnId', () => {
  it('往返一致（主代理）', () => {
    const sessionId = '9fc43b3a-1111-2222-3333-444455556666' as SessionId
    const turnId = createTurnId(sessionId, 7)
    const parsed = parseTurnId(turnId)

    expect(parsed).toEqual({ turnNumber: 7, sessionPrefix: '9fc43b3a', isSubAgent: false })
  })

  it('往返一致（子代理）', () => {
    const sessionId = '9fc43b3a-1111-2222-3333-444455556666' as SessionId
    const turnId = createTurnId(sessionId, 2, { isSubAgent: true })
    const parsed = parseTurnId(turnId)

    expect(parsed).toEqual({ turnNumber: 2, sessionPrefix: '9fc43b3a', isSubAgent: true })
  })

  it('子代理前缀不会被主代理正则先行匹配', () => {
    // subagent_turn_1_abc 若被 /^turn_/ 匹配会失败（因 "subagent" 开头），
    // 这里确认 isSubAgent 判定正确、序号解析正确
    const parsed = parseTurnId('subagent_turn_42_abcdefgh')
    expect(parsed).toEqual({ turnNumber: 42, sessionPrefix: 'abcdefgh', isSubAgent: true })
  })

  it('对非法格式返回 undefined 而非抛错（读取侧必须容错）', () => {
    const invalid = [
      '',
      'turn_',
      'turn_1',
      'turn__abc',
      'turn_abc_def', // 序号非数字
      'nope_1_abc',
      'turn_-1_abc',
      'subagent_turn_',
      'subagent_turn_1',
      'subagent_turn_abc_def',
    ]

    for (const value of invalid) {
      expect(parseTurnId(value), `应拒绝: ${value}`).toBeUndefined()
    }
  })

  it('会话前缀含下划线时整体归入 prefix（前缀不按 8 位裁剪解析）', () => {
    // 解析侧不做长度校验：只要序号后有一段非空内容就算合法。
    // 恢复路径仅用 prefix 做归属核对，长度不符会被调用方判为不一致。
    expect(parseTurnId('turn_1_abc_extra')).toEqual({
      turnNumber: 1,
      sessionPrefix: 'abc_extra',
      isSubAgent: false,
    })
  })

  it('容错解析但能识别前导零序号', () => {
    expect(parseTurnId('turn_007_abcdefgh')).toEqual({
      turnNumber: 7,
      sessionPrefix: 'abcdefgh',
      isSubAgent: false,
    })
  })
})

describe('ID 生成器', () => {
  it('生成非空且互不相同的 id', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 100; i += 1) {
      ids.add(createSessionId())
    }
    expect(ids.size).toBe(100)
  })

  it('不同类别的 id 都可用作字符串', () => {
    expect(typeof createMessageId()).toBe('string')
    expect(createMessageId().length).toBeGreaterThan(0)
  })
})

describe('isValidId', () => {
  it('接受非空字符串', () => {
    expect(isValidId('abc')).toBe(true)
  })

  it('拒绝空串与非字符串', () => {
    expect(isValidId('')).toBe(false)
    expect(isValidId(undefined)).toBe(false)
    expect(isValidId(null)).toBe(false)
    expect(isValidId(123)).toBe(false)
    expect(isValidId({})).toBe(false)
  })
})

describe('其余 ID 生成器', () => {
  it('每个生成器都返回非空字符串', () => {
    expect(createToolCallId().length).toBeGreaterThan(0)
    expect(createPermissionRequestId().length).toBeGreaterThan(0)
    expect(createEventId().length).toBeGreaterThan(0)
    expect(createSubAgentSessionId().length).toBeGreaterThan(0)
    expect(createCompactBoundaryId().length).toBeGreaterThan(0)
    expect(createModelOverrideId().length).toBeGreaterThan(0)
    expect(createToolExecutionId().length).toBeGreaterThan(0)
    expect(createPrincipalId().length).toBeGreaterThan(0)
  })

  it('生成 UUID v4 格式', () => {
    const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    expect(createSessionId()).toMatch(uuidV4)
    expect(createEventId()).toMatch(uuidV4)
  })
})
