import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { DEFAULT_BUDGET } from '../../src/core/budget.js'
import { InMemoryEventSink } from '../../src/core/events.js'
import type { SessionId, TurnId } from '../../src/core/ids.js'
import { ModelEventType, type ModelProvider, type ModelRequest } from '../../src/core/provider.js'
import { PermissionMode, type ToolContext } from '../../src/core/tool.js'
import type { ConfigDocument } from '../../src/storage/types.js'
import { ModelRouter } from '../../src/providers/router.js'
import { ChatStore } from '../../src/storage/chat-store.js'
import { resolveAppPaths } from '../../src/storage/paths.js'
import { createBuiltinTools } from '../../src/tools/builtins.js'
import { ToolRegistry } from '../../src/tools/registry.js'
import {
  SubAgentManager,
  SubAgentRegistry,
  SubAgentSessionStatus,
  createSubAgentTool,
} from '../../src/subagents/index.js'

const config: ConfigDocument = {
  schema_version: 1,
  llm_channels: [],
  llm_models: [],
  app_settings: {},
  providers: [
    {
      id: 'p',
      name: 'test',
      baseUrl: 'https://example.test',
      apiKeyRef: { source: 'env', key: 'TEST_KEY' },
      enabled: true,
      createdAt: '',
      updatedAt: '',
    },
  ],
  model_profiles: [
    {
      id: 'm',
      providerId: 'p',
      contextWindow: 100_000,
      maxOutputTokens: 4_096,
      supportsThinking: false,
      supportsTools: true,
      supportsVision: false,
      supports1MContext: false,
      enabled: true,
    },
  ],
  tier_assignments: [
    {
      tier: 'implementation',
      modelRef: { providerId: 'p', modelId: 'm' },
      enabled: true,
      fallbackModelRefs: [],
    },
  ],
}

describe('Phase 9：Sub-agent', () => {
  it('加载内置定义并拒绝同名定义冲突', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deepcode-sub-reg-'))
    const registry = new SubAgentRegistry(root, join(root, '.user'))
    expect(registry.refresh().map((item) => item.type)).toEqual([
      'code-reviewer',
      'debugger',
      'general-purpose',
      'test-runner',
    ])
  })

  it('使用独立 transcript、收窄工具集并返回结构化结果', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deepcode-sub-run-'))
    const store = new ChatStore(resolveAppPaths({ home: root, cwd: root }))
    await store.initialize()
    const parent = await store.createConversation('parent', '', '', 'principal')
    await store.addMessage({
      conversation_id: parent.id,
      role: 'user',
      content: 'PARENT_SECRET_MUST_NOT_BE_INJECTED',
      turn_id: 'turn_1_parent' as TurnId,
      subtype: 'normal',
      tool_call_id: null,
      meta: '{}',
      agent_type: '',
    })

    const tools = new ToolRegistry()
    for (const tool of createBuiltinTools()) tools.register(tool)
    const definitions = new SubAgentRegistry(root, join(root, '.user'))
    definitions.refresh()

    const requests: ModelRequest[] = []
    let call = 0
    const provider: ModelProvider = {
      stream(request) {
        requests.push(request)
        call += 1
        return {
          usage: { inputTokens: 10, outputTokens: 3 },
          async *[Symbol.asyncIterator]() {
            await Promise.resolve()
            if (call === 1) {
              yield { type: ModelEventType.TEXT, content: '初步发现' }
              yield {
                type: ModelEventType.TOOL_USE,
                id: 'denied-write',
                name: 'file_write',
                input: { path: 'should-not-exist.txt', content: 'x' },
              }
            } else yield { type: ModelEventType.TEXT, content: '只读调查完成' }
          },
        }
      },
      probe: () => Promise.resolve({ ok: true }),
    }
    const manager = new SubAgentManager({
      definitions,
      tools,
      chatStore: store,
      router: new ModelRouter(config),
      providerFactory: () => provider,
      eventSink: new InMemoryEventSink(),
      workspaceRoot: root,
      principalId: 'principal',
    })
    const parentContext: ToolContext = {
      sessionId: parent.id,
      turnId: 'turn_1_parent' as TurnId,
      principalId: 'principal',
      workspaceRoot: root,
      allowedReadRoots: [root],
      allowedWriteRoots: [root],
      turnState: {
        permission_mode: PermissionMode.YOLO,
        subagent_depth: 0,
        budget_consumption: { modelCalls: 3 },
      },
      budget: { ...DEFAULT_BUDGET, maxModelCalls: 4 },
      signal: new AbortController().signal,
    }

    const launched = await manager.launch(
      {
        agentType: 'general-purpose',
        task: '检查项目但不要修改文件',
        context: '只检查 package.json',
      },
      parentContext,
    )

    expect(launched.status).toBe(SubAgentSessionStatus.PARTIAL)
    expect(launched.result).toMatchObject({
      status: 'partial',
      summary: '初步发现',
    })
    expect(launched.result?.continuationHandle).toBe(`subagent:${launched.sessionId}`)
    await expect(manager.status(launched.sessionId)).resolves.toMatchObject({
      budget: { maxModelCalls: 1 },
    })
    expect(requests[0]?.tools?.map((tool) => tool.name)).not.toContain('file_write')
    expect(requests[0]?.tools?.map((tool) => tool.name)).not.toContain('bash')
    expect(requests[0]?.tools?.map((tool) => tool.name)).not.toContain('sub_agent')
    expect(JSON.stringify(requests[0]?.messages)).not.toContain(
      'PARENT_SECRET_MUST_NOT_BE_INJECTED',
    )
    const childConversation = await store.getConversation(launched.sessionId as SessionId)
    expect(childConversation.parent_conversation_id).toBe(parent.id)
    expect(childConversation.agent_type).toBe('general-purpose')
    const childTurn = (await store.read()).runtime.turns.find(
      (turn) => turn.sessionId === launched.sessionId,
    )
    expect(childTurn?.turnId).toMatch(/^subagent_turn_/u)

    const subAgentTool = createSubAgentTool(manager)
    const ownStatus = await subAgentTool.execute(parentContext, {
      action: 'status',
      session_id: launched.sessionId,
    })
    expect(ownStatus.ok).toBe(true)
    expect(ownStatus.content).not.toContain('只检查 package.json')
    const otherContext = { ...parentContext, principalId: 'another-principal' }
    const otherStatus = await subAgentTool.execute(otherContext, {
      action: 'status',
      session_id: launched.sessionId,
    })
    expect(otherStatus).toMatchObject({
      ok: false,
      error_code: 'SESSION_NOT_FOUND',
    })
    const otherList = await subAgentTool.execute(otherContext, { action: 'list' })
    expect(otherList.content).toBe('[]')

    const narrowedParent = {
      ...parentContext,
      allowedReadRoots: [join(root, 'src')],
      allowedWriteRoots: [join(root, 'src')],
    }
    const narrowed = await manager.launch(
      { agentType: 'code-reviewer', task: '只检查 src', allowedPaths: ['.'] },
      narrowedParent,
    )
    const narrowedSession = await manager.status(narrowed.sessionId)
    expect(narrowedSession.allowedReadRoots).toEqual([join(root, 'src')])
    expect(narrowedSession.allowedWriteRoots).toEqual([join(root, 'src')])
  })

  it('后台任务响应父取消，并能凭持久化句柄恢复', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deepcode-sub-background-'))
    const store = new ChatStore(resolveAppPaths({ home: root, cwd: root }))
    await store.initialize()
    const parent = await store.createConversation('parent', '', '', 'principal')
    const tools = new ToolRegistry()
    for (const tool of createBuiltinTools()) tools.register(tool)
    const definitions = new SubAgentRegistry(root, join(root, '.user'))
    definitions.refresh()
    let markStarted: (() => void) | undefined
    const started = new Promise<void>((resolveStarted) => {
      markStarted = resolveStarted
    })
    let calls = 0
    const provider: ModelProvider = {
      stream(_request, signal) {
        calls += 1
        const invocation = calls
        return {
          usage: { inputTokens: 10, outputTokens: 3 },
          async *[Symbol.asyncIterator]() {
            if (invocation === 1) {
              markStarted?.()
              await new Promise<void>((resolveAbort) => {
                signal.addEventListener('abort', () => resolveAbort(), { once: true })
              })
            } else yield { type: ModelEventType.TEXT, content: '恢复完成' }
          },
        }
      },
      probe: () => Promise.resolve({ ok: true }),
    }
    const managerOptions = {
      definitions,
      tools,
      chatStore: store,
      router: new ModelRouter(config),
      providerFactory: () => provider,
      eventSink: new InMemoryEventSink(),
      workspaceRoot: root,
      principalId: 'principal',
    }
    let manager = new SubAgentManager(managerOptions)
    const controller = new AbortController()
    const parentContext: ToolContext = {
      sessionId: parent.id,
      turnId: 'turn_1_parent' as TurnId,
      principalId: 'principal',
      workspaceRoot: root,
      allowedReadRoots: [root],
      allowedWriteRoots: [root],
      turnState: { permission_mode: PermissionMode.YOLO, subagent_depth: 0 },
      budget: DEFAULT_BUDGET,
      signal: controller.signal,
    }
    const launched = await manager.launch(
      { agentType: 'general-purpose', task: '后台调查', runMode: 'background' },
      parentContext,
    )
    expect(launched.status).toBe(SubAgentSessionStatus.QUEUED)
    await started
    controller.abort()
    const waitForStatus = async (status: string): Promise<void> => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((await manager.status(launched.sessionId)).status === status) return
        await new Promise((resolveWait) => setTimeout(resolveWait, 10))
      }
      const current = await manager.status(launched.sessionId)
      throw new Error(
        `sub-agent did not reach ${status}: ${current.status} ${current.result?.summary ?? ''}`,
      )
    }
    await waitForStatus(SubAgentSessionStatus.CANCELLED)
    // 模拟进程重启：新 manager 没有旧的任务/控制器映射，只依赖 chat.json 恢复。
    manager = new SubAgentManager(managerOptions)
    const resumed = await manager.resume(launched.continuationHandle)
    expect(resumed.accepted).toBe(true)
    await waitForStatus(SubAgentSessionStatus.COMPLETED)
    expect((await manager.status(launched.sessionId)).result?.summary).toBe('恢复完成')
  })
})
