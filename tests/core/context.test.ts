import { describe, expect, it } from 'vitest'

import {
  EMPTY_WORKING_MEMORY,
  SYSTEM_PROMPT_HEADINGS,
  filterModelVisible,
  isModelVisible,
  renderSystemPrompt,
  type SystemPrompt,
} from '../../src/core/context.js'
import { createMessageId, createSessionId, type MessageId } from '../../src/core/ids.js'
import { MessageSubtype, type Message, type MessageRole } from '../../src/core/models.js'

function prompt(overrides: Partial<SystemPrompt> = {}): SystemPrompt {
  return {
    base: 'BASE',
    mode: 'MODE',
    safety: 'SAFETY',
    subagent: 'SUBAGENT',
    ...overrides,
  }
}

describe('renderSystemPrompt', () => {
  it('按固定顺序拼接四层必选内容', () => {
    expect(renderSystemPrompt(prompt())).toBe('BASE\n\nMODE\n\nSAFETY\n\nSUBAGENT')
  })

  it('skill 指导带固定标题前缀', () => {
    const text = renderSystemPrompt(prompt({ skillGuidance: 'do the skill' }))
    expect(text).toContain(`${SYSTEM_PROMPT_HEADINGS.skillGuidance}\ndo the skill`)
  })

  it('压缩摘要带固定标题前缀', () => {
    const text = renderSystemPrompt(prompt({ compactSummary: 'earlier we did X' }))
    expect(text).toContain(`${SYSTEM_PROMPT_HEADINGS.compactSummary}\nearlier we did X`)
  })

  it('可选层为空或纯空白时整体省略（不留空标题）', () => {
    expect(renderSystemPrompt(prompt({ skillGuidance: '' }))).not.toContain(
      SYSTEM_PROMPT_HEADINGS.skillGuidance,
    )
    expect(renderSystemPrompt(prompt({ skillGuidance: '   \n  ' }))).not.toContain(
      SYSTEM_PROMPT_HEADINGS.skillGuidance,
    )
    expect(renderSystemPrompt(prompt({ compactSummary: '  ' }))).not.toContain(
      SYSTEM_PROMPT_HEADINGS.compactSummary,
    )
  })

  it('各层内容被 trim', () => {
    const text = renderSystemPrompt(prompt({ base: '  BASE  ' }))
    expect(text.startsWith('BASE')).toBe(true)
  })

  it('skill 层排在压缩摘要层之前', () => {
    const text = renderSystemPrompt(prompt({ skillGuidance: 'S', compactSummary: 'C' }))
    expect(text.indexOf(SYSTEM_PROMPT_HEADINGS.skillGuidance)).toBeLessThan(
      text.indexOf(SYSTEM_PROMPT_HEADINGS.compactSummary),
    )
  })

  it('两层可选内容都存在时都在输出里', () => {
    const text = renderSystemPrompt(prompt({ skillGuidance: 'S', compactSummary: 'C' }))
    expect(text).toContain('S')
    expect(text).toContain('C')
  })
})

describe('isModelVisible', () => {
  it('纯 UI 审计记录不进入模型请求', () => {
    expect(isModelVisible(MessageSubtype.PERMISSION_EVENT)).toBe(false)
    expect(isModelVisible(MessageSubtype.SKILL_EVENT)).toBe(false)
  })

  it('压缩边界是元数据，不进入请求', () => {
    expect(isModelVisible(MessageSubtype.COMPACT_BOUNDARY)).toBe(false)
  })

  it('压缩摘要必须进入请求（否则模型彻底丢失历史）', () => {
    // 这是最容易被误删的一条：摘要本身就是给模型看的
    expect(isModelVisible(MessageSubtype.COMPACT_SUMMARY)).toBe(true)
  })

  it('常规消息类型都可见', () => {
    expect(isModelVisible(MessageSubtype.NORMAL)).toBe(true)
    expect(isModelVisible(MessageSubtype.TOOL_CALL)).toBe(true)
    expect(isModelVisible(MessageSubtype.TOOL_RESULT)).toBe(true)
    expect(isModelVisible(MessageSubtype.INTERRUPTED)).toBe(true)
  })
})

describe('filterModelVisible', () => {
  const sessionId = createSessionId()

  function msg(id: string, subtype: Message['subtype'], role: MessageRole): Message {
    return {
      id: id as MessageId,
      conversation_id: sessionId,
      role,
      content: `content-${id}`,
      created_at: '2026-09-14T02:39:11.123Z',
      turn_id: '',
      subtype,
      tool_call_id: null,
      meta: '{}',
      agent_type: '',
    }
  }

  it('保留顺序，剔除不可见项', () => {
    const messages = [
      msg('a', MessageSubtype.NORMAL, 'user'),
      msg('b', MessageSubtype.PERMISSION_EVENT, 'system'),
      msg('c', MessageSubtype.TOOL_CALL, 'assistant'),
      msg('d', MessageSubtype.COMPACT_BOUNDARY, 'system'),
      msg('e', MessageSubtype.COMPACT_SUMMARY, 'system'),
      msg('f', MessageSubtype.SKILL_EVENT, 'system'),
      msg('g', MessageSubtype.NORMAL, 'user'),
    ]

    expect(filterModelVisible(messages).map((m) => m.id)).toEqual(['a', 'c', 'e', 'g'])
  })

  it('空输入返回空', () => {
    expect(filterModelVisible([])).toEqual([])
  })

  it('不修改输入数组', () => {
    const messages = [msg('a', MessageSubtype.NORMAL, 'user')]
    const before = [...messages]
    filterModelVisible(messages)
    expect(messages).toEqual(before)
  })
})

describe('WorkingMemory', () => {
  it('空工作记忆的每个集合都是空数组（而非 undefined）', () => {
    // 空数组与 undefined 的区别很重要：前者表示"确认没有"，后者表示"不知道"
    for (const value of Object.values(EMPTY_WORKING_MEMORY)) {
      expect(Array.isArray(value)).toBe(true)
      expect(value).toHaveLength(0)
    }
  })

  it('覆盖 parts/09 §4 要求保护的全部类别', () => {
    expect(Object.keys(EMPTY_WORKING_MEMORY).sort()).toEqual([
      'appliedSkills',
      'fileChanges',
      'openTasks',
      'pendingToolCalls',
      'permissionDecisions',
      'userConstraints',
    ])
  })

  it('import 的类型可用于构造', () => {
    const memory = {
      ...EMPTY_WORKING_MEMORY,
      userConstraints: ['不要修改 package.json'],
      openTasks: ['跑通测试'],
    }
    expect(memory.userConstraints).toHaveLength(1)
    expect(createMessageId()).toBeTruthy()
  })
})
