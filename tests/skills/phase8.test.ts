import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { DEFAULT_BUDGET } from '../../src/core/budget.js'
import { EMPTY_WORKING_MEMORY } from '../../src/core/context.js'
import { InMemoryEventSink } from '../../src/core/events.js'
import { ErrorCode } from '../../src/core/errors.js'
import type { ToolCallId, TurnId } from '../../src/core/ids.js'
import { MessageSubtype } from '../../src/core/models.js'
import { ModelEventType, type ModelProvider, type ModelRequest } from '../../src/core/provider.js'
import {
  PermissionAction,
  PermissionMode,
  type SkillGuardRef,
  type ToolContext,
} from '../../src/core/tool.js'
import { TurnPhase } from '../../src/core/turn.js'
import { AgentRuntime } from '../../src/runtime/agent-runtime.js'
import { ContextBuilder } from '../../src/runtime/context-builder.js'
import {
  SkillCompiler,
  SkillRegistry,
  SkillResolver,
  evaluateSkillGuards,
  parseSkillText,
} from '../../src/skills/index.js'
import { ChatStore } from '../../src/storage/chat-store.js'
import { resolveAppPaths } from '../../src/storage/paths.js'
import { createFileReadTool, createFileWriteTool } from '../../src/tools/builtins.js'
import { ToolExecutor } from '../../src/tools/executor.js'
import { DefaultPermissionEngine } from '../../src/tools/permission-engine.js'
import { ToolRegistry } from '../../src/tools/registry.js'

function skillText(name: string, version = '1.0.0', constraint = ''): string {
  return `---
name: ${name}
description: Use this skill to edit files safely
version: ${version}
triggers: [edit]
${constraint}---
## Workflow
Read the file before editing.

## Verification Checklist
Check the final content.
`
}

describe('Phase 8：Skills', () => {
  it('description 的 1024 字符上限按 Unicode 字符计算', () => {
    const parse = (description: string) =>
      parseSkillText(`---\nname: unicode\ndescription: ${description}\n---\nbody`)
    expect([...parse('🙂'.repeat(1024)).manifest.description]).toHaveLength(1024)
    expect(() => parse('🙂'.repeat(1025))).toThrow('description must be <= 1024 characters')
  })

  it('按 project > user > builtin 加载，并对所有有效文件计算目录快照', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deepcode-skills-registry-'))
    const project = join(root, 'project')
    const user = join(root, 'user')
    const builtin = join(root, 'builtin')
    const projectFile = join(project, 'skills', 'edit', 'SKILL.md')
    const userFile = join(user, 'skills', 'edit', 'SKILL.md')
    const builtinFile = join(builtin, 'review', 'SKILL.md')
    const invalidFile = join(project, 'skills', 'invalid', 'SKILL.md')
    for (const path of [projectFile, userFile, builtinFile, invalidFile])
      await mkdir(dirname(path), { recursive: true })
    const projectText = skillText('safe-edit')
    const userText = skillText('safe-edit', '2.0.0')
    const builtinText = skillText('review')
    await writeFile(projectFile, projectText)
    await writeFile(userFile, userText)
    await writeFile(builtinFile, builtinText)
    await writeFile(invalidFile, '---\nname: Bad Name\ndescription: broken\n---\nbody')

    const registry = new SkillRegistry(project, user, builtin)
    const first = registry.refresh()
    expect(first.loadedSkills.map((skill) => skill.manifest.ref)).toEqual([
      'review@1.0.0',
      'safe-edit@1.0.0',
    ])
    expect(first.byName?.('safe-edit')?.manifest.source).toBe('project')
    expect(first.invalidSkills).toEqual([
      { path: invalidFile, reason: 'name must be a lowercase slug' },
    ])
    const fileChecksums = [projectText, userText, builtinText].map((text) =>
      createHash('sha256').update(text).digest('hex'),
    )
    expect(first.checksum).toBe(
      createHash('sha256').update(fileChecksums.sort().join('')).digest('hex'),
    )

    await writeFile(projectFile, skillText('safe-edit', '3.0.0'))
    expect(registry.refresh().byName?.('safe-edit')?.manifest.ref).toBe('safe-edit@3.0.0')
    expect(first.byName?.('safe-edit')?.manifest.ref).toBe('safe-edit@1.0.0')
  })

  it('确定性排序依次比较得分、优先级、名称，并保留 rejected 原因', () => {
    const create = (name: string, description: string, priority: number, triggers = '') =>
      parseSkillText(`---
name: ${name}
description: ${description}
priority: ${priority}
triggers: [${triggers}]
---
## Overview
body`)
    const catalog = {
      loadedSkills: [
        create('a', 'unrelated', 3),
        create('b', 'match', 0),
        create('c', 'unrelated', 0, 'match'),
      ],
      invalidSkills: [],
      checksum: '',
    }
    const decision = new SkillResolver().resolve('match', catalog, 2)
    expect(decision.selected.map((skill) => skill.manifest.name)).toEqual(['c', 'a'])
    expect(decision.rejected).toEqual([{ name: 'b', score: 3, reason: 'lower ranked candidate' }])
    expect(decision.confidence).toBe(5 / 12)
    expect(new SkillCompiler().compile(decision).planningInjection).toContain('Active Skills:')
    // BUG-COMPAT：旧 resolver 的 ASCII 分词器无法命中纯中文请求。
    expect(new SkillResolver().resolve('编辑文件', catalog).selected).toEqual([])
  })

  it('成功读取的落盘结果可满足同一 turn 的 read-before-write guard', async () => {
    const workspaceRoot = await realpath(await mkdtemp(join(tmpdir(), 'deepcode-skills-read-')))
    await writeFile(join(workspaceRoot, 'note.txt'), 'old')
    const store = new ChatStore(resolveAppPaths({ home: workspaceRoot, cwd: workspaceRoot }))
    const session = await store.createConversation()
    const turn = await store.beginTurn(session.id, 'edit', 'local', DEFAULT_BUDGET, {
      userConstraints: [],
      openTasks: [],
      pendingToolCalls: [],
      permissionDecisions: [],
      fileChanges: [],
      appliedSkills: [],
    })
    const tools = new ToolRegistry()
    tools.register(createFileReadTool())
    tools.register(createFileWriteTool())
    let executor = new ToolExecutor({
      registry: tools,
      permissionEngine: new DefaultPermissionEngine(),
      chatStore: store,
    })
    const guard: SkillGuardRef = {
      guardId: 'sg_read_first',
      skillName: 'safe-edit',
      guardType: 'require_read_before_write',
      action: PermissionAction.DENY,
      reason: 'read first',
      parameters: {},
    }
    const execute = (toolName: string, input: Record<string, unknown>, id: string) =>
      executor.executeNamed(toolName, {
        sessionId: session.id,
        turnId: turn.turnId as TurnId,
        toolCallId: id as ToolCallId,
        principalId: 'local',
        input,
        workspaceRoot,
        mode: PermissionMode.YOLO,
        turnState: { runtime_guards: Object.freeze([guard]) },
        budget: DEFAULT_BUDGET,
        signal: new AbortController().signal,
      })

    const denied = await execute('file_write', { path: 'note.txt', content: 'new' }, 'first')
    expect(denied.error_code).toBe(ErrorCode.SKILL_GUARD_DENIED)
    expect(await readFile(join(workspaceRoot, 'note.txt'), 'utf8')).toBe('old')
    expect((await execute('file_read', { path: 'note.txt' }, 'read')).ok).toBe(true)
    executor = new ToolExecutor({
      registry: tools,
      permissionEngine: new DefaultPermissionEngine(),
      chatStore: store,
    })
    expect((await execute('file_write', { path: 'note.txt', content: 'new' }, 'second')).ok).toBe(
      true,
    )
    expect(await readFile(join(workspaceRoot, 'note.txt'), 'utf8')).toBe('new')
  })

  it('path_scope 按真实路径及目录边界判断', async () => {
    const workspaceRoot = await realpath(await mkdtemp(join(tmpdir(), 'deepcode-skills-scope-')))
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'deepcode-skills-outside-')))
    await mkdir(join(workspaceRoot, 'src'))
    await mkdir(join(workspaceRoot, 'src2'))
    await symlink(outside, join(workspaceRoot, 'src', 'link'))
    const guard: SkillGuardRef = {
      guardId: 'sg_scope',
      skillName: 'scoped-edit',
      guardType: 'path_scope',
      action: PermissionAction.DENY,
      reason: 'outside src',
      parameters: { paths: ['src'] },
    }
    const context = { workspaceRoot, turnState: {} } as ToolContext
    const check = (path: string) =>
      evaluateSkillGuards([guard], 'file_write', { path }, context).allowed
    expect(check('src/ok.txt')).toBe(true)
    expect(check('src2/no.txt')).toBe(false)
    expect(check('src/link/escaped.txt')).toBe(false)
  })

  it('turn 起点固定注入与守护；文件热更新只影响下一个 turn', async () => {
    const workspaceRoot = await realpath(await mkdtemp(join(tmpdir(), 'deepcode-skills-turn-')))
    const skillPath = join(workspaceRoot, 'skills', 'safe-edit', 'SKILL.md')
    await mkdir(join(workspaceRoot, 'skills', 'safe-edit'), { recursive: true })
    const denyConstraint = `constraints:\n  - type: deny_tool\n    tool: file_read\n    reason: do not read\n`
    await writeFile(skillPath, skillText('safe-edit', '1.0.0', denyConstraint))
    const store = new ChatStore(resolveAppPaths({ home: workspaceRoot, cwd: workspaceRoot }))
    const session = await store.createConversation()
    const tools = new ToolRegistry()
    tools.register(createFileReadTool())
    const executor = new ToolExecutor({
      registry: tools,
      permissionEngine: new DefaultPermissionEngine(),
      chatStore: store,
    })
    const builder = new ContextBuilder({ chatStore: store, tools: () => tools.descriptors() })
    const sink = new InMemoryEventSink()
    const requests: ModelRequest[] = []
    const provider: ModelProvider = {
      stream(request) {
        requests.push(request)
        const call = requests.length
        if (call === 1) writeFileSync(skillPath, skillText('safe-edit', '2.0.0'))
        return {
          usage: { inputTokens: 1, outputTokens: 1 },
          async *[Symbol.asyncIterator]() {
            await Promise.resolve()
            if (call === 1)
              yield {
                type: ModelEventType.TOOL_USE,
                id: 'read-attempt',
                name: 'file_read',
                input: { path: 'note.txt' },
              }
            else yield { type: ModelEventType.TEXT, content: 'done' }
          },
        }
      },
      probe: () => Promise.resolve({ ok: true }),
    }
    const runtime = new AgentRuntime({
      chatStore: store,
      contextBuilder: builder,
      toolExecutor: executor,
      eventSink: sink,
      provider,
      model: 'test',
      workspaceRoot,
      principalId: 'local',
      skillRegistry: new SkillRegistry(workspaceRoot, join(workspaceRoot, 'user')),
    })

    const first = await runtime.submitMessage(session.id, 'edit note')
    expect(first.status).toBe('completed')
    expect(requests[0]?.system).toContain('safe-edit@1.0.0')
    expect(requests[1]?.system).toContain('safe-edit@1.0.0')
    expect(requests[0]?.tools).toEqual([])
    expect(requests[1]?.tools).toEqual([])
    expect(sink.events.filter((event) => event.type === 'skill_resolved')).toHaveLength(1)
    expect(
      (await store.listToolExecutions(session.id)).find(
        (record) => record.toolCallId === 'read-attempt',
      )?.errorCode,
    ).toBe(ErrorCode.SKILL_GUARD_DENIED)
    const firstTurn = await store.getTurn(session.id, first.turn_id)
    expect(firstTurn.skillSnapshot?.appliedSkills).toEqual(['safe-edit@1.0.0'])
    const messages = await store.listMessages(session.id)
    expect(messages.some((m) => m.subtype === MessageSubtype.SKILL_EVENT)).toBe(true)
    const toolResult = messages.find((m) => m.tool_call_id === 'read-attempt')
    expect(JSON.parse(toolResult?.meta ?? '{}')).toMatchObject({
      skill_name: 'safe-edit',
      guard_type: 'deny_tool',
      guard_reason: 'do not read',
    })

    const second = await runtime.submitMessage(session.id, 'edit note again')
    expect((await store.getTurn(session.id, second.turn_id)).skillSnapshot?.appliedSkills).toEqual([
      'safe-edit@2.0.0',
    ])
    expect(requests[2]?.tools?.map((tool) => tool.name)).toContain('file_read')
  })

  it('进程恢复沿用已落盘的 skill 快照，不重新读取修改后的文件', async () => {
    const workspaceRoot = await realpath(await mkdtemp(join(tmpdir(), 'deepcode-skills-resume-')))
    const skillPath = join(workspaceRoot, 'skills', 'safe-edit', 'SKILL.md')
    await mkdir(dirname(skillPath), { recursive: true })
    await writeFile(
      skillPath,
      skillText('safe-edit', '1.0.0', 'constraints:\n  - type: deny_tool\n    tool: file_read\n'),
    )
    const skillRegistry = new SkillRegistry(workspaceRoot, join(workspaceRoot, 'user'))
    const catalog = skillRegistry.refresh()
    const compiled = new SkillCompiler().compile(new SkillResolver().resolve('edit note', catalog))
    const snapshot = {
      catalogChecksum: catalog.checksum,
      appliedSkills: compiled.runtimeState.appliedSkills,
      activePhase: compiled.runtimeState.activePhase,
      planningInjection: compiled.planningInjection,
      runtimeGuards: compiled.runtimeGuards,
      decisionReason: compiled.runtimeState.decisionReason,
    }
    const store = new ChatStore(resolveAppPaths({ home: workspaceRoot, cwd: workspaceRoot }))
    const session = await store.createConversation()
    const turn = await store.beginTurn(session.id, 'edit note', 'local', DEFAULT_BUDGET, {
      ...EMPTY_WORKING_MEMORY,
      appliedSkills: snapshot.appliedSkills,
    })
    await store.updateTurn(session.id, turn.turnId as TurnId, {
      phase: TurnPhase.BUILDING_CONTEXT,
      skillSnapshot: snapshot,
    })
    await writeFile(skillPath, skillText('safe-edit', '2.0.0'))

    const tools = new ToolRegistry()
    tools.register(createFileReadTool())
    const requests: ModelRequest[] = []
    const provider: ModelProvider = {
      stream(request) {
        requests.push(request)
        return {
          usage: { inputTokens: 1, outputTokens: 1 },
          async *[Symbol.asyncIterator]() {
            await Promise.resolve()
            yield { type: ModelEventType.TEXT, content: 'resumed' }
          },
        }
      },
      probe: () => Promise.resolve({ ok: true }),
    }
    const runtime = new AgentRuntime({
      chatStore: store,
      contextBuilder: new ContextBuilder({ chatStore: store, tools: () => tools.descriptors() }),
      toolExecutor: new ToolExecutor({
        registry: tools,
        permissionEngine: new DefaultPermissionEngine(),
        chatStore: store,
      }),
      eventSink: new InMemoryEventSink(),
      provider,
      model: 'test',
      workspaceRoot,
      principalId: 'local',
      skillRegistry,
    })

    expect((await runtime.resumeTurn(session.id, turn.turnId as TurnId)).status).toBe('completed')
    expect(requests[0]?.system).toContain('safe-edit@1.0.0')
    expect(requests[0]?.system).not.toContain('safe-edit@2.0.0')
    expect(requests[0]?.tools).toEqual([])
  })
})
