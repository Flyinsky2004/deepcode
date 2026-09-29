/**
 * 模式提示词与系统提示组装的测试。
 *
 * 提示词**逐字决定模型行为**（CLAUDE.md 硬性约定），因此这里断言的是
 * "每个模式取到哪一段"，而不是文案细节——文案改动属于另一类评审。
 *
 * 同时固化一条硬要求：**执行层的模式权限表与提示层的模式描述必须同步**。
 * PLAN 的提示词还必须引导调查、澄清与制定可验证的实施方案。
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

  it('plan 模式段指导模型调查、提问、制定贴合工程的方案，并声明执行边界', () => {
    const plan = modePrompt(PermissionMode.PLAN)
    expect(plan).toContain("this project's engineering practices")
    expect(plan).toContain('inspect the existing code, documentation, tests, and conventions')
    expect(plan).toContain('do not invent current behavior')
    expect(plan).toContain('ask_user_question')
    expect(plan).toContain('Do not guess a consequential answer')
    expect(plan).toContain('affected components or files')
    expect(plan).toContain('verification and acceptance checks')
    expect(plan).toContain('If a critical answer is missing')
    expect(plan).toContain('Do not call file_write, file_edit')
    expect(plan).toContain('Read-only shell commands still require approval')
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

  it('通用安全提示允许计划模式以未来实施方案结束', () => {
    const rendered = renderSystemPrompt(createSystemPrompt(PermissionMode.PLAN))
    expect(rendered).toContain('In PLAN mode, proposed implementation steps are future work')
    expect(rendered).toContain('do not execute them in that turn')
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
