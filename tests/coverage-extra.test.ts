import { describe, expect, it } from 'vitest'
import { mkdtemp, writeFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { abortable, cancellableStream, retryDelay } from '../src/runtime/control.js'
import { messageToApiFormat, sanitizeApiMessages } from '../src/storage/message-converter.js'
import { ToolRegistry } from '../src/tools/registry.js'
import {
  createBuiltinTools,
  createFileReadTool,
  createFileWriteTool,
  createFileEditTool,
  createBashTool,
  createGlobTool,
  createGrepTool,
  createAskUserQuestionTool,
  createTodoWriteTool,
} from '../src/tools/builtins.js'
import { MessageRole, MessageSubtype, type Message } from '../src/core/models.js'
import { PermissionAction, type ToolContext } from '../src/core/tool.js'
import { ModelRouter } from '../src/providers/router.js'
import { ModelTier } from '../src/core/provider.js'

const signal = new AbortController().signal
const context = (root: string) =>
  ({
    sessionId: 's',
    turnId: 't',
    principalId: 'p',
    workspaceRoot: root,
    allowedReadRoots: [root],
    allowedWriteRoots: [root],
    turnState: {},
    budget: {},
    signal,
  }) as unknown as ToolContext

describe('runtime coverage helpers', () => {
  it('supports cancellation helpers and stream cleanup', async () => {
    await expect(abortable(Promise.resolve(1), signal)).resolves.toBe(1)
    async function* source() {
      await Promise.resolve()
      yield 1
      yield 2
    }
    const values: number[] = []
    for await (const value of cancellableStream(source(), signal)) values.push(value)
    expect(values).toEqual([1, 2])
    await retryDelay(0, signal)
    const controller = new AbortController()
    controller.abort()
    await expect(abortable(new Promise(() => {}), controller.signal)).rejects.toThrow()
  })

  it('converts protocol messages and repairs consecutive users', () => {
    const base = (content: string, role: MessageRole = MessageRole.USER): Message => ({
      id: Math.random().toString() as Message['id'],
      conversation_id: 's' as Message['conversation_id'],
      role,
      content,
      created_at: new Date().toISOString(),
      turn_id: 't' as Message['turn_id'],
      subtype: MessageSubtype.NORMAL,
      tool_call_id: null,
      meta: '{}',
      agent_type: '',
    })
    expect(
      messageToApiFormat({ ...base('x'), subtype: MessageSubtype.PERMISSION_EVENT }),
    ).toBeNull()
    expect(messageToApiFormat(base(JSON.stringify([{ type: 'text', text: 'x' }])))).not.toBeNull()
    expect(
      messageToApiFormat(base(JSON.stringify({ tool_use_id: 'c', content: 'ok' }))),
    ).not.toBeNull()
    expect(messageToApiFormat(base(JSON.stringify({ type: 'bad' })))).toEqual({
      role: 'user',
      content: JSON.stringify({ type: 'bad' }),
    })
    const repaired = sanitizeApiMessages([
      { role: 'user', content: 'one' },
      { role: 'user', content: 'two' },
    ])
    expect(repaired[1]?.role).toBe('assistant')
  })

  it('exercises every builtin tool and registry paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deepcode-extra-'))
    await writeFile(join(root, 'a.txt'), 'hello world\nhello again\n')
    const ctx = context(root)
    const read = createFileReadTool()
    expect((await read.execute(ctx, { path: 'a.txt', offset: 1, limit: 1 })).ok).toBe(true)
    expect((await read.execute(ctx, { path: 'missing.txt' })).ok).toBe(false)
    const write = createFileWriteTool()
    expect((await write.execute(ctx, { path: 'dir/new.txt', content: 'new' })).ok).toBe(true)
    expect(
      (await write.execute(ctx, { path: 'dir/new.txt', content: 'x', overwrite: false })).ok,
    ).toBe(false)
    const edit = createFileEditTool()
    expect(
      (
        await edit.execute(ctx, {
          file_path: 'a.txt',
          old_string: 'hello',
          new_string: 'hi',
          replace_all: true,
        })
      ).ok,
    ).toBe(true)
    const glob = createGlobTool()
    expect((await glob.execute(ctx, { pattern: '**/*.txt' })).ok).toBe(true)
    const grep = createGrepTool()
    expect((await grep.execute(ctx, { pattern: 'hi', include: '*.txt' })).ok).toBe(true)
    const bash = createBashTool()
    expect((await bash.execute(ctx, { command: 'pwd', timeout: 2 })).ok).toBe(true)
    expect(bash.safetyCheck?.({ command: 'echo $HOME' }, ctx)?.action).toBe(PermissionAction.DENY)
    expect(
      (
        await createAskUserQuestionTool().execute(ctx, {
          questions: [{ question: 'q', header: 'h', options: [{ label: 'a', description: 'a' }] }],
        })
      ).error_code,
    ).toBe('USER_INPUT_REQUIRED')
    expect(
      (await createTodoWriteTool().execute(ctx, { todos: [{ content: 'x', status: 'pending' }] }))
        .ok,
    ).toBe(true)
    const registry = new ToolRegistry()
    for (const tool of createBuiltinTools()) registry.register(tool)
    expect(registry.names().length).toBe(10)
    expect(() => registry.register(createFileReadTool())).toThrow()
    expect(() => registry.require('missing')).toThrow()
    registry.replace(read)
  })

  it('skips symlink escapes in search tools', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deepcode-link-'))
    const outside = await mkdtemp(join(tmpdir(), 'deepcode-out-'))
    await writeFile(join(outside, 'secret.txt'), 'secret')
    await symlink(join(outside, 'secret.txt'), join(root, 'link.txt'))
    const ctx = context(root)
    expect((await createGlobTool().execute(ctx, { pattern: '**/*' })).content).not.toContain(
      'secret.txt',
    )
    expect((await createGrepTool().execute(ctx, { pattern: 'secret' })).content).toBe('')
  })

  it('covers router capability and missing-model failures', async () => {
    const provider = {
      id: 'p',
      name: 'p',
      baseUrl: 'https://x.test',
      apiKeyRef: { source: 'env' as const, key: 'K' },
      createdAt: '',
      updatedAt: '',
    }
    const profile = {
      id: 'm',
      providerId: 'p',
      contextWindow: 10,
      maxOutputTokens: 5,
      supportsThinking: false,
      supportsTools: false,
      supportsVision: false,
      supports1MContext: false,
      enabled: true,
    }
    const base = {
      schema_version: 1,
      llm_channels: [],
      llm_models: [],
      app_settings: {},
      providers: [{ ...provider, enabled: true }],
      model_profiles: [profile],
      tier_assignments: [
        {
          tier: ModelTier.IMPLEMENTATION,
          modelRef: { providerId: 'p', modelId: 'm' },
          enabled: true,
          fallbackModelRefs: [],
        },
      ],
    }
    const router = new ModelRouter(base)
    await expect(
      router.resolve({
        tier: ModelTier.IMPLEMENTATION,
        purpose: 'implement',
        requiresTools: true,
        requiresThinking: false,
      }),
    ).rejects.toThrow()
    await expect(
      new ModelRouter({ ...base, tier_assignments: [] }).resolve({
        tier: ModelTier.IMPLEMENTATION,
        purpose: 'implement',
        requiresTools: false,
        requiresThinking: false,
      }),
    ).rejects.toThrow()
    await expect(
      router.resolveCandidate(
        {
          tier: ModelTier.IMPLEMENTATION,
          purpose: 'implement',
          requiresTools: false,
          requiresThinking: true,
        },
        { providerId: 'p', modelId: 'm' },
      ),
    ).rejects.toThrow()
  })
})
