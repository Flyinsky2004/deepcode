/**
 * 模式提示词与系统提示组装的测试。
 *
 * 提示词**逐字决定模型行为**（CLAUDE.md 硬性约定），因此这里断言的是
 * "每个模式取到哪一段"，而不是文案细节——文案改动属于另一类评审。
 *
 * 同时固化一条硬要求：**执行层的模式权限表与提示层的模式描述必须同步**。
 * `MODE_PLAN` 自称"写操作被禁止"，对应 `PermissionEngine` 里 plan 模式对
 * write 能力的硬拒；下面用一行断言把这条对应关系钉住。
 */
import { describe, expect, it } from 'vitest'

import { renderSystemPrompt } from '../../src/core/context.js'
import { PermissionMode } from '../../src/core/tool.js'
import {
  BASE_SYSTEM,
  MODE_AUTO_EDIT,
  MODE_NORMAL,
  MODE_PLAN,
  MODE_YOLO,
  SAFETY_POLICY,
  SUBAGENT_AWARENESS,
  createSystemPrompt,
  modePrompt,
} from '../../src/runtime/prompts.js'

describe('modePrompt', () => {
  it('四种权限模式各自取到对应的模式段', () => {
    expect(modePrompt(PermissionMode.NORMAL)).toBe(MODE_NORMAL)
    expect(modePrompt(PermissionMode.PLAN)).toBe(MODE_PLAN)
    expect(modePrompt(PermissionMode.AUTO_EDIT)).toBe(MODE_AUTO_EDIT)
    expect(modePrompt(PermissionMode.YOLO)).toBe(MODE_YOLO)
  })

  it('模式段两两不同（任何两个模式共用一段都意味着权限描述失真）', () => {
    const prompts = [
      modePrompt(PermissionMode.NORMAL),
      modePrompt(PermissionMode.PLAN),
      modePrompt(PermissionMode.AUTO_EDIT),
      modePrompt(PermissionMode.YOLO),
    ]
    expect(new Set(prompts).size).toBe(4)
  })

  it('plan 模式段声明只允许分析/只读，与执行层 plan 硬拒 write 能力一致', () => {
    const plan = modePrompt(PermissionMode.PLAN)
    expect(plan).toContain('ONLY analysis, planning, and information gathering are allowed')
    expect(plan).toContain('Forbidden: file_write')
    // 执行层：capabilities 含 write 的工具在 PLAN 下被 mode.plan.read-only 拒绝
    expect(plan).toContain('Each bash command requires user approval')
  })

  it('未识别的模式值回落到 NORMAL 段（不抛错，保证降级可用）', () => {
    expect(modePrompt('unknown-mode' as PermissionMode)).toBe(MODE_NORMAL)
  })
})

describe('createSystemPrompt', () => {
  it('四层固定内容始终存在', () => {
    const prompt = createSystemPrompt(PermissionMode.NORMAL)
    expect(prompt.base).toBe(BASE_SYSTEM)
    expect(prompt.mode).toBe(MODE_NORMAL)
    expect(prompt.safety).toBe(SAFETY_POLICY)
    expect(prompt.subagent).toBe(SUBAGENT_AWARENESS)
  })

  it('未提供 skill 指导与压缩摘要时省略对应层（渲染时不会被拼出空标题）', () => {
    const prompt = createSystemPrompt(PermissionMode.NORMAL)
    expect(Object.keys(prompt).sort()).toEqual(['base', 'mode', 'safety', 'subagent'])
    expect(renderSystemPrompt(prompt)).not.toContain('Skill planning guidance:')
    expect(renderSystemPrompt(prompt)).not.toContain('Historical summary')
  })

  it('提供 skill 指导时带上标题层', () => {
    const prompt = createSystemPrompt(PermissionMode.NORMAL, '先读 README')
    expect(prompt.skillGuidance).toBe('先读 README')
    expect(renderSystemPrompt(prompt)).toContain('Skill planning guidance:\n先读 README')
  })

  it('提供压缩摘要时带上历史摘要层，且排在 skill 指导之后', () => {
    const prompt = createSystemPrompt(PermissionMode.NORMAL, '指导', '之前讨论了 A')
    const rendered = renderSystemPrompt(prompt)
    expect(rendered).toContain('Historical summary (compacted conversation):\n之前讨论了 A')
    expect(rendered.indexOf('Skill planning guidance:')).toBeLessThan(
      rendered.indexOf('Historical summary'),
    )
  })

  it('只给压缩摘要、不给 skill 指导时同样正确（两个可选层互相独立）', () => {
    const prompt = createSystemPrompt(PermissionMode.NORMAL, undefined, '只有摘要')
    expect(prompt.skillGuidance).toBeUndefined()
    expect(prompt.compactSummary).toBe('只有摘要')
    expect(renderSystemPrompt(prompt)).not.toContain('Skill planning guidance:')
  })

  it('模式段随传入模式变化，其余层保持不变', () => {
    const normal = createSystemPrompt(PermissionMode.NORMAL)
    const yolo = createSystemPrompt(PermissionMode.YOLO)
    expect(yolo.mode).not.toBe(normal.mode)
    expect(yolo.base).toBe(normal.base)
    expect(yolo.safety).toBe(normal.safety)
  })
})
