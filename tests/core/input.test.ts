import { describe, expect, it } from 'vitest'

import {
  UserInputRequestStatus,
  formatAnswersForModel,
  type AskUserQuestion,
  type UserInputResolution,
} from '../../src/core/input.js'

const questions: readonly AskUserQuestion[] = [
  {
    question: '用哪种方案？',
    header: '方案',
    options: [
      { label: '方案 A', description: '改动小' },
      { label: '方案 B', description: '更彻底' },
    ],
  },
  {
    question: '要覆盖哪些文件？',
    header: '范围',
    options: [
      { label: 'src', description: '源码' },
      { label: 'tests', description: '测试' },
    ],
    multiSelect: true,
  },
]

describe('UserInputRequestStatus', () => {
  it('四种状态，与权限请求状态分离（ADR 0002 §六 的同一思路）', () => {
    expect(Object.values(UserInputRequestStatus).sort()).toEqual([
      'ANSWERED',
      'CANCELLED',
      'EXPIRED',
      'PENDING_USER_INPUT',
    ])
  })
})

describe('formatAnswersForModel', () => {
  it('无答案时回灌 {"_timeout": true}——形状必须逐字保留', () => {
    // 模型已经学会据此继续工作而不是反复追问（parts/05 §7.7）
    expect(formatAnswersForModel(questions, null)).toBe('{"_timeout":true}')
  })

  it('问题列表为空时回灌 {"_empty": true}', () => {
    expect(formatAnswersForModel([], [])).toBe('{"_empty":true}')
  })

  it('答案按下标与问题配对', () => {
    const result = formatAnswersForModel(questions, [['方案 A'], ['src', 'tests']])
    expect(JSON.parse(result)).toEqual({
      answers: [
        { question: '用哪种方案？', answers: ['方案 A'] },
        { question: '要覆盖哪些文件？', answers: ['src', 'tests'] },
      ],
    })
  })

  it('答案缺项时补空数组，而不是错位或抛错', () => {
    const result = formatAnswersForModel(questions, [['方案 A']])
    expect(JSON.parse(result)).toEqual({
      answers: [
        { question: '用哪种方案？', answers: ['方案 A'] },
        { question: '要覆盖哪些文件？', answers: [] },
      ],
    })
  })

  it('输出是合法 JSON 字符串（要作为 tool_result 的 content 落盘）', () => {
    const result = formatAnswersForModel(questions, [['方案 A'], []])
    expect(() => JSON.parse(result) as unknown).not.toThrow()
  })
})

describe('UserInputResolution', () => {
  it('answers 可以为 null，表示"没拿到答案"而不是"答了空"', () => {
    const timeout: UserInputResolution = {
      requestId: 'req_1',
      answers: null,
      resolvedBy: 'system',
      reason: '提问等待超时',
    }
    expect(timeout.answers).toBeNull()
    expect(timeout.resolvedBy).toBe('system')
  })

  it('可序列化 —— 提问请求必须能落盘以便恢复', () => {
    const resolution: UserInputResolution = {
      requestId: 'req_1',
      answers: [['方案 A']],
      resolvedBy: 'user',
    }
    expect(JSON.parse(JSON.stringify(resolution))).toEqual(resolution)
  })
})
