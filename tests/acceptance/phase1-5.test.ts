import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventLog } from '../../src/storage/event-log.js'
import { NullEventSink } from '../../src/core/events.js'
import { ChatStore } from '../../src/storage/chat-store.js'
import { resolveAppPaths } from '../../src/storage/paths.js'
import { DefaultPermissionEngine } from '../../src/tools/permission-engine.js'
import {
  createFileReadTool,
  createFileEditTool,
  createFileWriteTool,
  createBashTool,
} from '../../src/tools/builtins.js'
import { PermissionAction, PermissionMode, type ToolContext } from '../../src/core/tool.js'
import { ModelEventType, type Provider } from '../../src/core/provider.js'
import { AnthropicMessagesProvider } from '../../src/providers/anthropic.js'
import { AgentRuntime } from '../../src/runtime/agent-runtime.js'
import { ContextBuilder } from '../../src/runtime/context-builder.js'
import { ToolExecutor } from '../../src/tools/executor.js'
import { ToolRegistry } from '../../src/tools/registry.js'
import { createTodoWriteTool } from '../../src/tools/builtins.js'
import { ModelRouter } from '../../src/providers/router.js'
import { ContextCompactor } from '../../src/runtime/compaction.js'
import type { ConfigDocument } from '../../src/storage/types.js'
import { ConfigStore } from '../../src/storage/config-store.js'
import { AgentError } from '../../src/core/errors.js'
import { EMPTY_WORKING_MEMORY } from '../../src/core/context.js'
import { inputHash } from '../../src/storage/audit.js'
import { TurnPhase } from '../../src/core/turn.js'

const abort = () => new AbortController().signal
const provider: Provider = {
  id: 'p',
  name: 'test',
  baseUrl: 'https://api.anthropic.com',
  apiKeyRef: { source: 'env', key: 'TEST_KEY' },
  createdAt: '',
  updatedAt: '',
}

describe('runtime core acceptance', () => {
  it('event log assigns monotonic sequences and deduplicates retries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deepcode-events-'))
    const log = new EventLog(dir)
    const first = await log.emit('session-a' as never, 'turn.started', { n: 1 })
    await log.append(first)
    await log.emit('session-a' as never, 'turn.completed', { n: 2 })
    const events = await log.list('session-a' as never)
    expect(events.map((e) => e.sequence)).toEqual([1, 2])
  })

  it('atomically rejects a second active turn and recovers running tools as unknown', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deepcode-chat-'))
    const paths = resolveAppPaths({ home: dir, cwd: dir })
    const store = new ChatStore(paths)
    const conversation = await store.createConversation()
    const turn = await store.beginTurn(
      conversation.id,
      'hello',
      'principal',
      {
        maxModelCalls: 2,
        maxToolCalls: 2,
        maxWallTimeMs: 1000,
        maxInputTokens: 1000,
        maxOutputTokens: 1000,
        maxCost: 1,
      },
      {
        userConstraints: [],
        openTasks: [],
        pendingToolCalls: [],
        permissionDecisions: [],
        fileChanges: [],
        appliedSkills: [],
      },
    )
    await expect(
      store.beginTurn(conversation.id, 'second', 'principal', turn.budget, turn.workingMemory),
    ).rejects.toMatchObject({ code: 'SESSION_BUSY' })
    await store.addToolExecution({
      executionId: 'e',
      sessionId: conversation.id,
      turnId: turn.turnId as never,
      toolCallId: 'c' as never,
      toolName: 'bash',
      inputHash: 'h',
      status: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      errorCode: null,
      elapsedMs: null,
      input: {},
      descriptorVersion: '1',
      idempotent: false,
    })
    const recovered = await store.recover()
    expect(recovered.unknownExecutions.some((e) => e.executionId === 'e')).toBe(true)
  })

  it('permission ordering lets hard plan denial override an ASK claim', async () => {
    const engine = new DefaultPermissionEngine()
    const ctx = {
      sessionId: 's',
      turnId: 't',
      principalId: 'p',
      workspaceRoot: '/tmp/work',
      allowedReadRoots: ['/tmp/work'],
      allowedWriteRoots: ['/tmp/work'],
      turnState: {},
      budget: {} as never,
      signal: abort(),
    } as unknown as ToolContext
    const decision = await engine.decide({
      toolName: 'file_write',
      input: { path: 'x' },
      descriptor: {
        name: 'file_write',
        description: '',
        input_schema: {},
        version: '1',
        risk_level: 'medium',
        capabilities: ['write'],
        source: { kind: 'native' },
      },
      ctx,
      mode: PermissionMode.PLAN,
      skillGuards: [],
      toolClaim: { action: PermissionAction.ASK, reason: 'ask' },
    })
    expect(decision.action).toBe(PermissionAction.DENY)
  })

  it('file edit requires file_path and treats replacement text literally', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deepcode-tools-'))
    const file = join(dir, 'a.txt')
    await writeFile(file, 'A $& A', 'utf8')
    const read = createFileReadTool()
    const edit = createFileEditTool()
    const ctx = {
      sessionId: 's',
      turnId: 't',
      principalId: 'p',
      workspaceRoot: dir,
      allowedReadRoots: [dir],
      allowedWriteRoots: [dir],
      turnState: {},
      budget: {} as never,
      signal: abort(),
    } as unknown as ToolContext
    expect((await read.execute(ctx, { path: 'a.txt' })).ok).toBe(true)
    const result = await edit.execute(ctx, {
      file_path: 'a.txt',
      old_string: 'A $& A',
      new_string: '$1',
    })
    expect(result.ok).toBe(true)
    expect(await readFile(file, 'utf8')).toBe('$1')
  })

  it('Anthropic stream sends official thinking field and reports nested usage', async () => {
    process.env['TEST_KEY'] = 'secret'
    const lines = [
      'data: {"type":"message_start","message":{"usage":{"input_tokens":4}}}\n\n',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n',
      'data: {"type":"content_block_stop","index":0}\n\n',
      'data: {"type":"message_delta","usage":{"output_tokens":2}}\n\n',
      'data: {"type":"message_stop"}\n\n',
    ].join('')
    let body: Record<string, unknown> | undefined
    const fetchImpl = (_url: string, init?: RequestInit) => {
      body = JSON.parse(typeof init?.body === 'string' ? init.body : '')
      return Promise.resolve(
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode(lines))
              c.close()
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
      )
    }
    const client = new AnthropicMessagesProvider({ provider, fetchImpl: fetchImpl as typeof fetch })
    const stream = client.stream(
      {
        model: 'm',
        maxTokens: 100,
        messages: [{ role: 'user', content: 'x' }],
        thinking: { type: 'enabled', budgetTokens: 10 },
      },
      abort(),
    )
    const events = []
    for await (const event of stream) events.push(event)
    expect(events).toEqual([{ type: ModelEventType.TEXT, content: 'ok' }])
    expect(stream.usage).toEqual({ inputTokens: 4, outputTokens: 2 })
    expect((body?.['thinking'] as Record<string, unknown>)?.['budget_tokens']).toBe(10)
  })

  it('shell safety marks read-only commands allow and operators deny', () => {
    const tool = createBashTool()
    const read = tool.safetyCheck?.({ command: 'ls -la' }, {} as never)
    const denied = tool.safetyCheck?.({ command: 'ls; rm -rf x' }, {} as never)
    expect(read?.action).toBe(PermissionAction.ALLOW)
    expect(denied?.action).toBe(PermissionAction.DENY)
  })

  it('runs a persisted model → tool → model → final turn', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deepcode-runtime-'))
    const store = new ChatStore(resolveAppPaths({ home: dir, cwd: dir }))
    const conversation = await store.createConversation()
    const registry = new ToolRegistry()
    registry.register(createTodoWriteTool())
    const permissions = new DefaultPermissionEngine()
    const executor = new ToolExecutor({ registry, permissionEngine: permissions, chatStore: store })
    const builder = new ContextBuilder({ chatStore: store, tools: () => registry.descriptors() })
    let call = 0
    const model = {
      stream: () => {
        call++
        const events =
          call === 1
            ? [
                {
                  type: ModelEventType.TOOL_USE,
                  id: 'tc',
                  name: 'todo_write',
                  input: { todos: [{ content: 'x', status: 'pending' }] },
                },
              ]
            : [{ type: ModelEventType.TEXT, content: 'done' }]
        return {
          usage: { inputTokens: 1, outputTokens: 1 },
          async *[Symbol.asyncIterator]() {
            await Promise.resolve()
            for (const e of events) yield e as never
          },
        }
      },
      probe: () => Promise.resolve({ ok: true }),
    } as never
    const runtime = new AgentRuntime({
      chatStore: store,
      contextBuilder: builder,
      toolExecutor: executor,
      provider: model,
      model: 'test',
      eventSink: new NullEventSink(),
      workspaceRoot: dir,
      principalId: 'p',
    })
    const result = await runtime.submitMessage(conversation.id, 'do it')
    expect(result.status).toBe('completed')
    expect(result.final_text).toBe('done')
    expect(call).toBe(2)
    expect(
      (await store.listMessages(conversation.id)).some((m) => m.subtype === 'tool_result'),
    ).toBe(true)
  })

  it('resumes an unfinished persisted turn after restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deepcode-resume-'))
    const store = new ChatStore(resolveAppPaths({ home: dir, cwd: dir }))
    const conversation = await store.createConversation()
    const budget = {
      maxModelCalls: 3,
      maxToolCalls: 2,
      maxWallTimeMs: 10000,
      maxInputTokens: 1000,
      maxOutputTokens: 1000,
      maxCost: 1,
    }
    const turn = await store.beginTurn(conversation.id, 'resume me', 'p', budget, {
      userConstraints: [],
      openTasks: [],
      pendingToolCalls: [],
      permissionDecisions: [],
      fileChanges: [],
      appliedSkills: [],
    })
    await store.updateTurn(conversation.id, turn.turnId as never, { phase: 'building_context' })
    const registry = new ToolRegistry()
    const executor = new ToolExecutor({
      registry,
      permissionEngine: new DefaultPermissionEngine(),
      chatStore: store,
    })
    const builder = new ContextBuilder({ chatStore: store, tools: () => [] })
    const model = {
      stream: () => ({
        usage: { inputTokens: 1, outputTokens: 1 },
        async *[Symbol.asyncIterator]() {
          await Promise.resolve()
          yield { type: ModelEventType.TEXT, content: 'resumed' } as never
        },
      }),
      probe: () => Promise.resolve({ ok: true }),
    } as never
    const runtime = new AgentRuntime({
      chatStore: store,
      contextBuilder: builder,
      toolExecutor: executor,
      provider: model,
      model: 'test',
      eventSink: new NullEventSink(),
      workspaceRoot: dir,
      principalId: 'p',
    })
    const result = await runtime.resumeTurn(conversation.id, turn.turnId as never)
    expect(result.status).toBe('completed')
    expect(result.final_text).toBe('resumed')
  })

  it('routes only within an assigned tier and compacts with a versioned boundary', async () => {
    const cfg: ConfigDocument = {
      schema_version: 1,
      llm_channels: [],
      llm_models: [],
      app_settings: {},
      providers: [{ ...provider, enabled: true }],
      model_profiles: [
        {
          id: 'm',
          providerId: 'p',
          contextWindow: 100,
          maxOutputTokens: 20,
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
    const route = await new ModelRouter(cfg).resolve({
      tier: 'implementation',
      purpose: 'implement',
      requiresTools: true,
      requiresThinking: false,
    })
    expect(route.model.id).toBe('m')
    await expect(
      new ModelRouter({ ...cfg, tier_assignments: [] }).resolve({
        tier: 'writing',
        purpose: 'write',
        requiresTools: false,
        requiresThinking: false,
      }),
    ).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND' })
    const dir = await mkdtemp(join(tmpdir(), 'deepcode-compact-'))
    const store = new ChatStore(resolveAppPaths({ home: dir, cwd: dir }))
    const c = await store.createConversation()
    for (let i = 0; i < 6; i++)
      await store.addMessage({
        conversation_id: c.id,
        role: 'user',
        content: `m${i}`,
        turn_id: '',
        subtype: 'normal',
        tool_call_id: null,
        meta: '{}',
        agent_type: '',
      })
    const summary = await new ContextCompactor(store, { preserveRecentMessages: 2 }).compact(
      c.id,
      {
        userConstraints: ['keep'],
        openTasks: [],
        pendingToolCalls: [],
        permissionDecisions: [],
        fileChanges: [],
        appliedSkills: [],
      },
      abort(),
      true,
    )
    expect(summary?.strategy).toBe('autocompact_v1')
    const all = await store.listMessages(c.id)
    const active = await store.listActiveMessages(c.id)
    expect(all.some((m) => m.subtype === 'compact_boundary')).toBe(true)
    expect(active.some((m) => m.content === 'm0')).toBe(false)
  })

  it('persists provider/model/tier configuration without storing secret material', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deepcode-config-'))
    const store = new ConfigStore(resolveAppPaths({ home: dir, cwd: dir }))
    await store.initialize()
    await store.upsertProvider({ ...provider, enabled: true })
    await store.upsertModelProfile({
      id: 'm',
      providerId: 'p',
      contextWindow: 100,
      maxOutputTokens: 20,
      supportsThinking: false,
      supportsTools: true,
      supportsVision: false,
      supports1MContext: false,
      enabled: true,
    })
    await store.setTierAssignment({
      tier: 'fast',
      modelRef: { providerId: 'p', modelId: 'm' },
      enabled: true,
      fallbackModelRefs: [],
    })
    const loaded = await store.read()
    expect(loaded.providers).toHaveLength(1)
    expect(loaded.model_profiles[0]?.providerId).toBe('p')
    expect(JSON.stringify(loaded)).not.toContain('secret-value')
    await expect(
      store.upsertProvider({ ...provider, baseUrl: 'https://x/v1/messages', enabled: true }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
  })

  it('falls back to the next assigned model only on a transient provider failure', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deepcode-fallback-'))
    const store = new ChatStore(resolveAppPaths({ home: dir, cwd: dir }))
    const c = await store.createConversation()
    const cfg: ConfigDocument = {
      schema_version: 1,
      llm_channels: [],
      llm_models: [],
      app_settings: {},
      providers: [
        { ...provider, enabled: true },
        { ...provider, id: 'p2', enabled: true },
      ],
      model_profiles: [
        {
          id: 'm1',
          providerId: 'p',
          contextWindow: 1000,
          maxOutputTokens: 20,
          supportsThinking: false,
          supportsTools: true,
          supportsVision: false,
          supports1MContext: false,
          enabled: true,
        },
        {
          id: 'm2',
          providerId: 'p2',
          contextWindow: 1000,
          maxOutputTokens: 20,
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
          modelRef: { providerId: 'p', modelId: 'm1' },
          enabled: true,
          fallbackModelRefs: [{ providerId: 'p2', modelId: 'm2' }],
        },
      ],
    }
    const router = new ModelRouter(cfg)
    const registry = new ToolRegistry()
    const executor = new ToolExecutor({
      registry,
      permissionEngine: new DefaultPermissionEngine(),
      chatStore: store,
    })
    const builder = new ContextBuilder({ chatStore: store, tools: () => [] })
    let calls = 0
    const providerFactory = (route: { model: { id: string } }) =>
      ({
        stream: () => {
          calls++
          if (route.model.id === 'm1')
            throw new AgentError({
              code: 'PROVIDER_UNAVAILABLE',
              message: 'temporary',
              source: 'test',
            })
          return {
            usage: { inputTokens: 1, outputTokens: 1 },
            async *[Symbol.asyncIterator]() {
              await Promise.resolve()
              yield { type: ModelEventType.TEXT, content: 'fallback ok' } as never
            },
          }
        },
        probe: () => Promise.resolve({ ok: true }),
      }) as never
    const runtime = new AgentRuntime({
      chatStore: store,
      contextBuilder: builder,
      toolExecutor: executor,
      router,
      providerFactory,
      eventSink: new NullEventSink(),
      workspaceRoot: dir,
      principalId: 'p',
    })
    const result = await runtime.submitMessage(c.id, 'fallback')
    expect(result.status).toBe('completed')
    expect(result.final_text).toBe('fallback ok')
    expect(calls).toBeGreaterThanOrEqual(3)
  })

  it('resumes a pending approval without creating a second first request', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deepcode-approval-'))
    const store = new ChatStore(resolveAppPaths({ home: dir, cwd: dir }))
    const c = await store.createConversation()
    const t = await store.beginTurn(
      c.id,
      'x',
      'p',
      {
        maxModelCalls: 2,
        maxToolCalls: 2,
        maxWallTimeMs: 1000,
        maxInputTokens: 1000,
        maxOutputTokens: 1000,
        maxCost: 1,
      },
      {
        userConstraints: [],
        openTasks: [],
        pendingToolCalls: [],
        permissionDecisions: [],
        fileChanges: [],
        appliedSkills: [],
      },
    )
    const registry = new ToolRegistry()
    registry.register(createFileWriteTool())
    const common = {
      sessionId: c.id,
      turnId: t.turnId as never,
      toolCallId: 'call' as never,
      principalId: 'p',
      input: { path: 'x.txt', content: 'ok' },
      workspaceRoot: dir,
      allowedReadRoots: [dir],
      allowedWriteRoots: [dir],
      mode: PermissionMode.NORMAL,
      budget: {} as never,
      signal: abort(),
    }
    const first = await new ToolExecutor({
      registry,
      permissionEngine: new DefaultPermissionEngine(),
      chatStore: store,
    }).executeNamed('file_write', common)
    expect(first.error_code).toBe('PERMISSION_REQUIRED')
    const requests = await store.listPermissionRequests(c.id)
    expect(requests).toHaveLength(1)
    const approvalService = {
      request: (request: { request_id: string }) =>
        Promise.resolve({
          requestId: request.request_id,
          decision: PermissionAction.ALLOW,
          resolvedBy: 'user' as const,
        }),
    }
    const second = await new ToolExecutor({
      registry,
      permissionEngine: new DefaultPermissionEngine(),
      chatStore: store,
      approvalService,
    }).executeNamed('file_write', common)
    expect(second.ok).toBe(true)
    expect(await store.listPermissionRequests(c.id)).toHaveLength(1)
  })

  it('resumes a durable pending tool execution before requesting the model', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deepcode-resume-tool-'))
    const store = new ChatStore(resolveAppPaths({ home: dir, cwd: dir }))
    const conversation = await store.createConversation()
    const turn = await store.beginTurn(
      conversation.id,
      'resume',
      'p',
      {
        maxModelCalls: 3,
        maxToolCalls: 3,
        maxWallTimeMs: 10000,
        maxInputTokens: 1000,
        maxOutputTokens: 1000,
      },
      EMPTY_WORKING_MEMORY,
    )
    await store.updateTurn(conversation.id, turn.turnId as never, {
      phase: TurnPhase.BUILDING_CONTEXT,
    })
    await store.updateTurn(conversation.id, turn.turnId as never, {
      phase: TurnPhase.CALLING_MODEL,
    })
    await store.updateTurn(conversation.id, turn.turnId as never, {
      phase: TurnPhase.EXECUTING_TOOLS,
    })
    await store.addToolExecution({
      executionId: 'pending-exec',
      sessionId: conversation.id,
      turnId: turn.turnId as never,
      toolCallId: 'pending-call' as never,
      toolName: 'todo_write',
      inputHash: inputHash({ todos: [{ content: 'resume me', status: 'pending' }] }),
      status: 'pending',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      errorCode: null,
      elapsedMs: null,
      input: { todos: [{ content: 'resume me', status: 'pending' }] },
      descriptorVersion: '1.0.0',
      idempotent: true,
      principalId: 'p',
    })
    const registry = new ToolRegistry()
    registry.register(createTodoWriteTool())
    const executor = new ToolExecutor({
      registry,
      permissionEngine: new DefaultPermissionEngine(),
      chatStore: store,
    })
    const builder = new ContextBuilder({ chatStore: store, tools: () => registry.descriptors() })
    const model = {
      stream: () => ({
        usage: { inputTokens: 1, outputTokens: 1 },
        *[Symbol.asyncIterator]() {
          yield { type: ModelEventType.TEXT, content: 'resumed' }
        },
      }),
      probe: () => Promise.resolve({ ok: true }),
    } as never
    const runtime = new AgentRuntime({
      chatStore: store,
      contextBuilder: builder,
      toolExecutor: executor,
      provider: model,
      model: 'test',
      eventSink: new NullEventSink(),
      workspaceRoot: dir,
      principalId: 'p',
    })
    const result = await runtime.resumeTurn(conversation.id, turn.turnId as never)
    expect(result.status).toBe('completed')
    expect((await store.listToolExecutions(conversation.id))[0]?.status).toBe('success')
  })
})
