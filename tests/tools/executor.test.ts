/**
 * `ToolExecutor` 的执行、审批与幂等路径单测。
 *
 * `ToolExecutor` 是**唯一**会真正调用工具的地方，也是"权限不可绕过"这条设计约束
 * 的落点。它同时承担三件事，每一件出错都会造成真实伤害：
 *
 * 1. **防重放**：同一 (turn, toolCallId, inputHash) 只执行一次。恢复时若已成功
 *    必须直接返回缓存结果，状态未知（UNKNOWN）必须拒绝执行——重复执行一个
 *    `bash` 的副作用是不可逆的。
 * 2. **审批**：`ASK` 决策经 `ApprovalService` 往返；没有审批服务时必须返回
 *    `PERMISSION_REQUIRED` 并带上真实的风险等级与到期时刻，让 runtime 能广播
 *    出正确的 `permission_required` 事件。
 * 3. **等待提问**：`ask_user_question` 与权限审批同构，超时回灌
 *    `{"_timeout": true}` 让 turn 继续（与权限"超时即拒"不同）。
 *
 * 所有测试只固化既有行为，不修改实现。
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { ErrorCode } from '../../src/core/errors.js'
import { InMemoryObservationSink } from '../../src/core/observability.js'
import type { AskUserQuestion, UserInputService } from '../../src/core/input.js'
import type { SessionId, ToolCallId, TurnId } from '../../src/core/ids.js'
import {
  PermissionAction,
  PermissionMode,
  PermissionRequestStatus,
  ToolExecutionStatus,
  type ApprovalService,
  type PermissionDecision,
  type PermissionEngine,
  type PermissionQuery,
  type PermissionResolution,
  type Tool,
  type ToolDescriptor,
  type ToolResult,
} from '../../src/core/tool.js'
import { createFakeClock } from '../../src/core/time.js'
import { ChatStore } from '../../src/storage/chat-store.js'
import { resolveAppPaths } from '../../src/storage/paths.js'
import { ToolRegistry } from '../../src/tools/registry.js'
import { ToolExecutor, type ExecuteToolOptions } from '../../src/tools/executor.js'

const descriptor = (overrides: Partial<ToolDescriptor> = {}): ToolDescriptor => ({
  name: 'demo',
  description: 'demo tool',
  input_schema: { type: 'object' },
  version: '1',
  risk_level: 'low',
  capabilities: [],
  source: { kind: 'native' },
  ...overrides,
})

function fakeTool(
  overrides: {
    descriptor?: Partial<ToolDescriptor>
    validate?: Tool['validate']
    run?: (input: unknown) => Promise<ToolResult> | ToolResult
    safetyCheck?: Tool['safetyCheck']
  } = {},
): Tool {
  const tool: Tool = {
    descriptor: descriptor(overrides.descriptor),
    validate:
      overrides.validate ??
      ((input: unknown) => ({
        ok: true as const,
        value: (input ?? {}) as Readonly<Record<string, unknown>>,
      })),
    execute: async (_ctx, input) =>
      overrides.run
        ? await overrides.run(input)
        : { ok: true, content: 'done', error_code: null, meta: {} },
  }
  if (overrides.safetyCheck)
    (tool as { safetyCheck?: Tool['safetyCheck'] }).safetyCheck = overrides.safetyCheck
  return tool
}

const allow: PermissionEngine = {
  decide: (q: PermissionQuery) =>
    Promise.resolve({
      action: PermissionAction.ALLOW,
      reason: '',
      policyId: 'test.allow',
      risk: q.descriptor.risk_level,
    }),
}
const engine = (
  action: PermissionAction,
  risk: PermissionDecision['risk'] = 'low',
): PermissionEngine => ({
  decide: () =>
    Promise.resolve({ action, reason: `policy says ${action}`, policyId: 'test.policy', risk }),
})

async function harness(
  tools: readonly Tool[],
  options: {
    permissionEngine?: PermissionEngine
    approvalService?: ApprovalService
    userInputService?: UserInputService
    withStore?: boolean
    outputLimitChars?: number
    timeoutMs?: number
    clock?: ReturnType<typeof createFakeClock>
  } = {},
): Promise<{
  executor: ToolExecutor
  store: ChatStore | undefined
  events: string[]
  observations: InMemoryObservationSink
}> {
  const registry = new ToolRegistry()
  for (const tool of tools) registry.register(tool)
  let store: ChatStore | undefined
  if (options.withStore !== false) {
    const dir = await mkdtemp(join(tmpdir(), 'deepcode-executor-'))
    store = new ChatStore(resolveAppPaths({ home: dir, cwd: dir }), options.clock)
  }
  const events: string[] = []
  const observations = new InMemoryObservationSink(options.clock)
  const executor = new ToolExecutor({
    registry,
    permissionEngine: options.permissionEngine ?? allow,
    ...(store === undefined ? {} : { chatStore: store }),
    ...(options.approvalService === undefined ? {} : { approvalService: options.approvalService }),
    ...(options.userInputService === undefined
      ? {}
      : { userInputService: options.userInputService }),
    ...(options.outputLimitChars === undefined
      ? {}
      : { outputLimitChars: options.outputLimitChars }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    onEvent: (type) => {
      events.push(type)
    },
    observationSink: observations,
  })
  return { executor, store, events, observations }
}

const options = (overrides: Partial<ExecuteToolOptions> = {}): ExecuteToolOptions => ({
  sessionId: 's1' as SessionId,
  turnId: 't1' as TurnId,
  toolCallId: 'tc1' as ToolCallId,
  principalId: 'p',
  input: { path: 'a.ts' },
  workspaceRoot: process.cwd(),
  budget: {} as ExecuteToolOptions['budget'],
  signal: new AbortController().signal,
  ...overrides,
})

describe('ToolExecutor 查找与输入校验', () => {
  it('工具不存在时返回结构化错误而不是抛出', async () => {
    const { executor } = await harness([])
    await expect(executor.executeNamed('ghost', options())).resolves.toMatchObject({
      ok: false,
      error_code: ErrorCode.TOOL_NOT_FOUND,
    })
  })

  it('输入校验失败时带上具体错误项', async () => {
    const tool = fakeTool({
      validate: () => ({ ok: false, errors: [{ path: ['path'], message: 'path 必须是字符串' }] }),
    })
    const { executor } = await harness([tool])
    await expect(executor.executeNamed('demo', options())).resolves.toMatchObject({
      ok: false,
      error_code: ErrorCode.TOOL_INVALID_INPUT,
      meta: { errors: [{ path: ['path'], message: 'path 必须是字符串' }] },
    })
  })

  it('execute() 能从输入的 __toolName 取到工具名', async () => {
    const tool = fakeTool()
    const { executor } = await harness([tool])
    await expect(
      executor.execute(options({ input: { __toolName: 'demo' } })),
    ).resolves.toMatchObject({ ok: true })

    // 非 object 输入取不到名字 → 走"工具不存在"路径，而不是崩溃。
    await expect(executor.execute(options({ input: 'nope' }))).resolves.toMatchObject({
      error_code: ErrorCode.TOOL_NOT_FOUND,
    })
  })
})

describe('ToolExecutor 防重放', () => {
  it('已成功的同一调用直接返回缓存结果，不再执行', async () => {
    let runs = 0
    const tool = fakeTool({
      run: () => {
        runs += 1
        return { ok: true, content: 'first', error_code: null, meta: {} }
      },
    })
    const { executor } = await harness([tool])
    const first = await executor.executeNamed('demo', options())
    const second = await executor.executeNamed('demo', options())
    expect(runs).toBe(1)
    expect(second).toEqual(first)
  })

  it('状态未知或仍在执行的同一调用被拒绝，不重新执行', async () => {
    let runs = 0
    const tool = fakeTool({
      run: () => {
        runs += 1
        return { ok: true, content: 'x', error_code: null, meta: {} }
      },
    })
    const clock = createFakeClock()
    const { executor, store } = await harness([tool], { clock })
    await store!.createConversation()
    // 预置一条 RUNNING 记录，模拟"进程中断在工具执行中途"。
    await store!.addToolExecution({
      executionId: 'ex1',
      sessionId: 's1' as SessionId,
      turnId: 't1' as TurnId,
      toolCallId: 'tc1' as ToolCallId,
      toolName: 'demo',
      inputHash: (await import('../../src/storage/audit.js')).inputHash({ path: 'a.ts' }),
      status: ToolExecutionStatus.RUNNING,
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: null,
      errorCode: null,
      elapsedMs: null,
      input: { path: 'a.ts' },
      descriptorVersion: '1',
      idempotent: true,
      principalId: 'p',
    })
    await expect(executor.executeNamed('demo', options())).resolves.toMatchObject({
      ok: false,
      error_code: ErrorCode.TOOL_EXECUTION_UNKNOWN,
      content: 'tool execution is still running',
    })
    expect(runs).toBe(0)

    await store!.updateToolExecution('ex1', { status: ToolExecutionStatus.UNKNOWN })
    await expect(executor.executeNamed('demo', options())).resolves.toMatchObject({
      ok: false,
      error_code: ErrorCode.TOOL_EXECUTION_UNKNOWN,
      content: 'tool execution status is unknown; manual confirmation required',
    })
    expect(runs).toBe(0)
  })

  it('inputHash 不同的同一 toolCallId 视为新调用', async () => {
    let runs = 0
    const tool = fakeTool({
      run: () => {
        runs += 1
        return { ok: true, content: 'x', error_code: null, meta: {} }
      },
    })
    const { executor } = await harness([tool])
    await executor.executeNamed('demo', options({ input: { path: 'a.ts' } }))
    await executor.executeNamed('demo', options({ input: { path: 'b.ts' } }))
    expect(runs).toBe(2)
  })

  it('没有 chatStore 时不做防重放（纯执行）', async () => {
    let runs = 0
    const tool = fakeTool({
      run: () => {
        runs += 1
        return { ok: true, content: 'x', error_code: null, meta: {} }
      },
    })
    const { executor } = await harness([tool], { withStore: false })
    await executor.executeNamed('demo', options())
    await executor.executeNamed('demo', options())
    expect(runs).toBe(2)
  })
})

describe('ToolExecutor 权限决策', () => {
  it('DENY 直接返回策略 id，不执行工具', async () => {
    let runs = 0
    const tool = fakeTool({
      run: () => {
        runs += 1
        return { ok: true, content: 'x', error_code: null, meta: {} }
      },
    })
    const { executor } = await harness([tool], { permissionEngine: engine(PermissionAction.DENY) })
    await expect(executor.executeNamed('demo', options())).resolves.toMatchObject({
      ok: false,
      error_code: ErrorCode.PERMISSION_DENIED,
      meta: { policy_id: 'test.policy' },
    })
    expect(runs).toBe(0)
  })

  it('没有审批服务时返回 PERMISSION_REQUIRED，并带上真实风险与到期时刻', async () => {
    const clock = createFakeClock(Date.parse('2026-01-01T00:00:00.000Z'))
    const tool = fakeTool({ descriptor: { risk_level: 'high' } })
    const { executor, store } = await harness([tool], {
      permissionEngine: engine(PermissionAction.ASK, 'high'),
      clock,
    })
    const result = await executor.executeNamed('demo', options())
    expect(result).toMatchObject({
      ok: false,
      error_code: ErrorCode.PERMISSION_REQUIRED,
      // ⚠️ 这里必须是**决策给出的**风险等级，而不是硬编码 'medium'——
      // 旧实现硬编码 medium + Date.now()+120_000，UI 显示的风险徽标是错的。
      meta: { risk_level: 'high' },
    })
    // 到期时刻来自注入的时钟 + 默认审批超时，不是当前墙钟。
    expect(result.meta['expires_at']).toBe(Date.parse('2026-01-01T00:00:00.000Z') + 120_000)
    expect(result.meta['request_id']).toMatch(/^[0-9a-f-]{36}$/)
    // 请求必须先落盘，重连的 UI 才能看到它。
    await expect(store!.listPermissionRequests()).resolves.toMatchObject([
      { status: PermissionRequestStatus.PENDING_USER_APPROVAL },
    ])
  })

  it('审批通过后执行工具，并把请求标记为已批准', async () => {
    const seen: string[] = []
    const approvalService: ApprovalService = {
      request: (request): Promise<PermissionResolution> => {
        seen.push(request.request_id)
        return Promise.resolve({
          requestId: request.request_id,
          decision: PermissionAction.ALLOW,
          resolvedBy: 'user',
        })
      },
    }
    const tool = fakeTool()
    const { executor, store, observations } = await harness([tool], {
      permissionEngine: engine(PermissionAction.ASK),
      approvalService,
    })
    await expect(executor.executeNamed('demo', options())).resolves.toMatchObject({ ok: true })
    expect(seen).toHaveLength(1)
    await expect(store!.listPermissionRequests()).resolves.toMatchObject([
      { status: PermissionRequestStatus.APPROVED, resolved_by: 'user' },
    ])
    expect(observations.records.map((record) => record.type)).toEqual([
      'permission.decided',
      'permission.requested',
      'permission.resolved',
    ])
    expect(observations.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'permission.decided',
          policyId: 'test.policy',
          toolCallId: 'tc1',
        }),
      ]),
    )
  })

  it('bash 审批单独提供命令预览，审计请求仍保留脱敏摘要', async () => {
    let commandPreview = ''
    const approvalService: ApprovalService = {
      request: (request, _signal, presentation) => {
        commandPreview = presentation?.commandPreview ?? ''
        return Promise.resolve({
          requestId: request.request_id,
          decision: PermissionAction.ALLOW,
          resolvedBy: 'user',
        })
      },
    }
    const { executor, store } = await harness([fakeTool({ descriptor: { name: 'bash' } })], {
      permissionEngine: engine(PermissionAction.ASK),
      approvalService,
    })

    await executor.executeNamed('bash', options({ input: { command: 'npm run build' } }))

    expect(commandPreview).toBe('npm run build')
    const [saved] = await store!.listPermissionRequests()
    expect(saved?.args_preview).toBe('{"command":"[redacted]"}')
  })

  it('审批被拒时返回拒绝理由并记录失败', async () => {
    const approvalService: ApprovalService = {
      request: (request): Promise<PermissionResolution> =>
        Promise.resolve({
          requestId: request.request_id,
          decision: PermissionAction.DENY,
          resolvedBy: 'user',
          reason: '用户拒绝了',
        }),
    }
    const tool = fakeTool()
    const { executor, store } = await harness([tool], {
      permissionEngine: engine(PermissionAction.ASK),
      approvalService,
    })
    await expect(executor.executeNamed('demo', options())).resolves.toMatchObject({
      ok: false,
      content: '用户拒绝了',
      error_code: ErrorCode.PERMISSION_DENIED,
    })
    await expect(store!.listToolExecutions('s1' as SessionId)).resolves.toMatchObject([
      { status: ToolExecutionStatus.FAILURE, errorCode: ErrorCode.PERMISSION_DENIED },
    ])
  })

  it('审批服务抛异常时按拒绝处理（不是挂起）', async () => {
    const approvalService: ApprovalService = {
      request: () => Promise.reject(new Error('UI 崩了')),
    }
    const tool = fakeTool()
    const { executor } = await harness([tool], {
      permissionEngine: engine(PermissionAction.ASK),
      approvalService,
    })
    await expect(executor.executeNamed('demo', options())).resolves.toMatchObject({
      ok: false,
      error_code: ErrorCode.PERMISSION_DENIED,
    })
  })

  it('low 风险工具只审批一次', async () => {
    let calls = 0
    const approvalService: ApprovalService = {
      request: (request) => {
        calls += 1
        return Promise.resolve({
          requestId: request.request_id,
          decision: PermissionAction.ALLOW,
          resolvedBy: 'user',
        })
      },
    }
    const tool = fakeTool()
    const { executor } = await harness([tool], {
      permissionEngine: engine(PermissionAction.ASK, 'low'),
      approvalService,
    })
    await expect(executor.executeNamed('demo', options())).resolves.toMatchObject({ ok: true })
    expect(calls).toBe(1)
  })

  it('high 风险工具需要二次确认，两次都批准才执行', async () => {
    let calls = 0
    const approvalService: ApprovalService = {
      request: (request) => {
        calls += 1
        return Promise.resolve({
          requestId: request.request_id,
          decision: PermissionAction.ALLOW,
          resolvedBy: 'user',
        })
      },
    }
    const tool = fakeTool({ descriptor: { risk_level: 'high' } })
    const { executor } = await harness([tool], {
      permissionEngine: engine(PermissionAction.ASK, 'high'),
      approvalService,
    })
    await expect(executor.executeNamed('demo', options())).resolves.toMatchObject({ ok: true })
    expect(calls).toBe(2)
  })

  it('完全没有审批服务时，high 风险也只停在第一次 REQUIRED（拿不到二次确认分支）', async () => {
    // ⚠️ 既有行为：`!this.approvalService` 的早退（第一次 REQUIRED）在**二次确认
    // 判断之前**，所以没有审批服务时 `second_confirmation` 永远为 false。
    // 该分支只在"请求已获批 + 无审批服务 + 高风险"的恢复场景里才可达（见下一个用例）。
    const tool = fakeTool({ descriptor: { risk_level: 'high' } })
    const { executor } = await harness([tool], {
      permissionEngine: engine(PermissionAction.ASK, 'high'),
    })
    const result = await executor.executeNamed('demo', options())
    expect(result).toMatchObject({
      ok: false,
      error_code: ErrorCode.PERMISSION_REQUIRED,
      meta: { risk_level: 'high' },
    })
    expect(result.meta).not.toHaveProperty('second_confirmation')
  })

  it('进程重启后已获批的 high 风险工具、且无审批服务时，要求二次确认', async () => {
    // 恢复场景：上一进程已批准过一次，但还没执行就退出了；重启后没有审批服务，
    // 于是高风险操作必须再确认一次，而不是直接放行。
    const tool = fakeTool({ descriptor: { risk_level: 'high' } })
    const { executor, store } = await harness([tool], {
      permissionEngine: engine(PermissionAction.ASK, 'high'),
    })
    await store!.createConversation()
    await store!.addPermissionRequest({
      request_id: 'perm_done',
      session_id: 's1' as SessionId,
      turn_id: 't1' as TurnId,
      tool_call_id: 'tc1' as ToolCallId,
      tool_name: 'demo',
      args_preview: '{}',
      risk_level: 'high',
      reason: 'needs approval',
      status: PermissionRequestStatus.APPROVED,
      created_at: '2026-01-01T00:00:00.000Z',
      expires_at: 1,
      resolved_at: null,
      resolved_by: 'user',
      resolution: 'approved',
    })
    await store!.addToolExecution({
      executionId: 'ex1',
      sessionId: 's1' as SessionId,
      turnId: 't1' as TurnId,
      toolCallId: 'tc1' as ToolCallId,
      toolName: 'demo',
      inputHash: (await import('../../src/storage/audit.js')).inputHash({ path: 'a.ts' }),
      status: ToolExecutionStatus.PENDING,
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: null,
      errorCode: null,
      elapsedMs: null,
      input: { path: 'a.ts' },
      descriptorVersion: '1',
      idempotent: false,
      principalId: 'p',
      permissionRequestIds: ['perm_done'],
    })
    await expect(executor.executeNamed('demo', options())).resolves.toMatchObject({
      ok: false,
      content: 'second confirmation required',
      error_code: ErrorCode.PERMISSION_REQUIRED,
      meta: { second_confirmation: true, risk_level: 'high' },
    })
  })

  it('二次确认被拒时不执行工具', async () => {
    let calls = 0
    const approvalService: ApprovalService = {
      request: (request) => {
        calls += 1
        return Promise.resolve(
          calls === 1
            ? {
                requestId: request.request_id,
                decision: PermissionAction.ALLOW,
                resolvedBy: 'user',
              }
            : {
                requestId: request.request_id,
                decision: PermissionAction.DENY,
                resolvedBy: 'user',
                reason: '二次拒绝',
              },
        )
      },
    }
    const tool = fakeTool({ descriptor: { risk_level: 'critical' } })
    const { executor } = await harness([tool], {
      permissionEngine: engine(PermissionAction.ASK, 'critical'),
      approvalService,
    })
    await expect(executor.executeNamed('demo', options())).resolves.toMatchObject({
      ok: false,
      content: '二次拒绝',
      error_code: ErrorCode.PERMISSION_DENIED,
    })
    expect(calls).toBe(2)
  })

  it('二次确认服务抛异常时按拒绝处理', async () => {
    let calls = 0
    const approvalService: ApprovalService = {
      request: (request) => {
        calls += 1
        if (calls === 2) return Promise.reject(new Error('第二次的 UI 崩了'))
        return Promise.resolve({
          requestId: request.request_id,
          decision: PermissionAction.ALLOW,
          resolvedBy: 'user',
        })
      },
    }
    const tool = fakeTool({ descriptor: { risk_level: 'high' } })
    const { executor } = await harness([tool], {
      permissionEngine: engine(PermissionAction.ASK, 'high'),
      approvalService,
    })
    await expect(executor.executeNamed('demo', options())).resolves.toMatchObject({
      ok: false,
      error_code: ErrorCode.PERMISSION_DENIED,
    })
  })

  it('恢复时已有的待审批请求会被复用，而不是再建一条', async () => {
    const clock = createFakeClock()
    const approvalService: ApprovalService = {
      request: (request) =>
        Promise.resolve({
          requestId: request.request_id,
          decision: PermissionAction.ALLOW,
          resolvedBy: 'user',
        }),
    }
    const tool = fakeTool()
    const { executor, store } = await harness([tool], {
      permissionEngine: engine(PermissionAction.ASK),
      approvalService,
      clock,
    })
    await store!.createConversation()
    const hash = (await import('../../src/storage/audit.js')).inputHash({ path: 'a.ts' })
    // 预置一条"上一进程留下、且已获批"的权限请求与对应的执行记录。
    await store!.addPermissionRequest({
      request_id: 'perm_existing',
      session_id: 's1' as SessionId,
      turn_id: 't1' as TurnId,
      tool_call_id: 'tc1' as ToolCallId,
      tool_name: 'demo',
      args_preview: '{}',
      risk_level: 'low',
      reason: 'needs approval',
      status: PermissionRequestStatus.PENDING_USER_APPROVAL,
      created_at: '2026-01-01T00:00:00.000Z',
      expires_at: 1,
      resolved_at: null,
      resolved_by: '',
      resolution: '',
    })
    // 用 store 自己的写入路径把它标成已批准：`resolvePermission` 会同时记下
    // 决议内容，而重放时的幂等判定正是比对这份决议——缺了它，恢复路径的
    // 二次 `resolvePermission` 会因"已解决且决议对不上"而抛错。
    await store!.resolvePermission('perm_existing', {
      requestId: 'perm_existing',
      decision: PermissionAction.ALLOW,
      resolvedBy: 'user',
    })
    await store!.addToolExecution({
      executionId: 'ex1',
      sessionId: 's1' as SessionId,
      turnId: 't1' as TurnId,
      toolCallId: 'tc1' as ToolCallId,
      toolName: 'demo',
      inputHash: hash,
      status: ToolExecutionStatus.PENDING,
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: null,
      errorCode: null,
      elapsedMs: null,
      input: { path: 'a.ts' },
      descriptorVersion: '1',
      idempotent: true,
      principalId: 'p',
      permissionRequestIds: ['perm_existing'],
    })
    await expect(executor.executeNamed('demo', options())).resolves.toMatchObject({ ok: true })
    // 仍然只有一条请求：恢复路径复用，不新建。
    await expect(store!.listPermissionRequests()).resolves.toHaveLength(1)
  })
})

describe('ToolExecutor 执行、超时与截断', () => {
  /** 超时用例里用来观察 executor 传进来的信号。 */
  let toolSignal: AbortSignal | undefined
  it('工具抛异常时转成结构化失败结果', async () => {
    const tool = fakeTool({
      run: () => {
        throw Object.assign(new Error('磁盘满了'), { code: 'EIO' })
      },
    })
    const { executor } = await harness([tool])
    await expect(executor.executeNamed('demo', options())).resolves.toMatchObject({ ok: false })
  })

  it('超过时限的工具被换成 TOOL_TIMEOUT 结果', async () => {
    // 工具**响应**信号的路径：`timeoutMs` 到点后 abort 传给工具的 signal，
    // 工具据此以 AbortError 结束，随后结果被换成 TOOL_TIMEOUT。
    const tool = fakeTool({
      run: () =>
        new Promise<ToolResult>((_resolve, reject) => {
          // 工具尊重取消信号：signal 一 abort 就立刻以 AbortError 结束。
          toolSignal?.addEventListener('abort', () => {
            const error = new Error('aborted')
            error.name = 'AbortError'
            reject(error)
          })
        }),
    })
    toolSignal = undefined
    const { executor } = await harness(
      [
        {
          ...tool,
          execute: async (ctx) => {
            toolSignal = ctx.signal
            return await tool.execute(ctx, { path: 'a.ts' })
          },
        },
      ],
      { timeoutMs: 5 },
    )
    await expect(executor.executeNamed('demo', options())).resolves.toMatchObject({
      ok: false,
      error_code: ErrorCode.TOOL_TIMEOUT,
    })
  })

  it('完全忽略信号的工具也会被超时中断（不再无限等待）', async () => {
    // 这里原本是一个缺陷（已修）：
    //
    // 早先 `await tool.execute(...)` 是普通 await，而 `timedOut()` 在它**之后**
    // 才被检查。于是工具只要不理会 signal，`await` 就会一直等到它真正跑完——
    // 超时只把"已经完成的"结果标成 TOOL_TIMEOUT，形同虚设。
    // 现在用 `abortable` 包住，**等待本身**在超时时结束。
    //
    // ⚠️ 注意这**不代表工具停了**：它可能仍在后台运行并产生副作用。
    // 这种"副作用是否发生不可知"的语义见 ADR 0002 §六（`UNKNOWN`）。
    let resolved = false
    const tool = fakeTool({
      run: () =>
        new Promise<ToolResult>(() => {
          // 刻意永不 resolve、且不监听 signal —— 最不配合的工具
          resolved = true
        }),
    })
    const { executor } = await harness(
      [{ ...tool, execute: (ctx) => tool.execute(ctx, { path: 'a.ts' }) }],
      { timeoutMs: 20 },
    )

    const started = Date.now()
    await expect(executor.executeNamed('demo', options())).resolves.toMatchObject({
      ok: false,
      error_code: ErrorCode.TOOL_TIMEOUT,
    })
    // 关键：在有限时间内返回，而不是永远挂住
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(resolved).toBe(true)
  })

  it('输出超过上限时截断并打标记', async () => {
    const tool = fakeTool({
      run: () => ({ ok: true, content: 'x'.repeat(50), error_code: null, meta: { a: 1 } }),
    })
    const { executor } = await harness([tool], { outputLimitChars: 10 })
    const result = await executor.executeNamed('demo', options())
    expect(result.content).toBe(`${'x'.repeat(10)}\n... [output truncated]`)
    expect(result.meta).toMatchObject({ output_truncated: true, output_limit_chars: 10, a: 1 })
  })

  it('直接放行时广播 tool.start 与 tool.complete', async () => {
    const tool = fakeTool()
    const { executor, events } = await harness([tool])
    await executor.executeNamed('demo', options())
    expect(events).toEqual(['tool.start', 'tool.complete'])
  })

  it('进入审批时先广播 permission.request，再广播工具起止', async () => {
    const approvalService: ApprovalService = {
      request: (request) =>
        Promise.resolve({
          requestId: request.request_id,
          decision: PermissionAction.ALLOW,
          resolvedBy: 'user',
        }),
    }
    const tool = fakeTool()
    const { executor, events } = await harness([tool], {
      permissionEngine: engine(PermissionAction.ASK),
      approvalService,
    })
    await executor.executeNamed('demo', options())
    expect(events).toEqual(['permission.request', 'tool.start', 'tool.complete'])
  })
})

describe('ToolExecutor 等待用户提问', () => {
  const question: AskUserQuestion = {
    question: '选哪个？',
    header: '选择',
    options: [{ label: 'A', description: 'a' }],
  }
  const askTool = (): Tool =>
    fakeTool({
      run: () => ({
        ok: false,
        content: '需要用户输入',
        error_code: 'USER_INPUT_REQUIRED',
        meta: { questions: [question] },
      }),
    })

  it('没有提问服务时立即回灌超时占位，不挂起', async () => {
    const { executor, store } = await harness([askTool()])
    const result = await executor.executeNamed('demo', options())
    // ⚠️ 结果**是 ok: true**：提问超时不是失败，而是让 turn 带着
    // `{"_timeout": true}` 继续跑（`parts/05` §7.7 的形状，逐字保留）。
    expect(result).toMatchObject({ ok: true, content: JSON.stringify({ _timeout: true }) })
    expect(result.meta).toMatchObject({ answered: false })
    await expect(store!.listUserInputRequests()).resolves.toMatchObject([
      { status: 'EXPIRED', resolved_by: 'system' },
    ])
  })

  it('提问服务给出答案时回灌按问题对齐的文本', async () => {
    const userInputService: UserInputService = {
      request: (request) =>
        Promise.resolve({ requestId: request.request_id, answers: [['A']], resolvedBy: 'user' }),
    }
    const { executor, store } = await harness([askTool()], { userInputService })
    const result = await executor.executeNamed('demo', options())
    expect(JSON.parse(result.content)).toEqual({
      answers: [{ question: '选哪个？', answers: ['A'] }],
    })
    expect(result.meta).toMatchObject({ answered: true })
    await expect(store!.listUserInputRequests()).resolves.toMatchObject([
      { status: 'ANSWERED', resolved_by: 'user' },
    ])
  })

  it('提问服务抛异常时退回无答案，turn 仍继续', async () => {
    const userInputService: UserInputService = {
      request: () => Promise.reject(new Error('UI 崩了')),
    }
    const { executor } = await harness([askTool()], { userInputService })
    await expect(executor.executeNamed('demo', options())).resolves.toMatchObject({
      ok: true,
      content: JSON.stringify({ _timeout: true }),
    })
  })

  it('meta 里没有 questions 时按空问卷处理', async () => {
    const tool = fakeTool({
      run: () => ({ ok: false, content: '', error_code: 'USER_INPUT_REQUIRED', meta: {} }),
    })
    const { executor } = await harness([tool])
    // questions 非数组 → 空数组。无答案时 `_timeout` 优先于 `_empty`
    // （`formatAnswersForModel` 先判 `answers === null`）。
    await expect(executor.executeNamed('demo', options())).resolves.toMatchObject({
      ok: true,
      content: JSON.stringify({ _timeout: true }),
    })
  })

  it('空问卷但拿到了答案时回灌 _empty 形状', async () => {
    // `_empty` 只在"有答案、没问题"时出现——这条形状来自旧实现，逐字保留。
    const tool = fakeTool({
      run: () => ({ ok: false, content: '', error_code: 'USER_INPUT_REQUIRED', meta: {} }),
    })
    const userInputService: UserInputService = {
      request: (request) =>
        Promise.resolve({ requestId: request.request_id, answers: [], resolvedBy: 'user' }),
    }
    const { executor } = await harness([tool], { userInputService })
    await expect(executor.executeNamed('demo', options())).resolves.toMatchObject({
      ok: true,
      content: JSON.stringify({ _empty: true }),
    })
  })
})

describe('ToolExecutor 模式透传', () => {
  it('把调用方给的权限模式原样交给权限引擎', async () => {
    const seen: PermissionMode[] = []
    const permissionEngine: PermissionEngine = {
      decide: (q) => {
        seen.push(q.mode)
        return Promise.resolve({
          action: PermissionAction.ALLOW,
          reason: '',
          policyId: 'x',
          risk: q.descriptor.risk_level,
        })
      },
    }
    const { executor } = await harness([fakeTool()], { permissionEngine })
    await executor.executeNamed('demo', options())
    // 换一个 toolCallId，避免第二次调用被防重放缓存拦下而不经过权限引擎。
    await executor.executeNamed(
      'demo',
      options({ mode: PermissionMode.PLAN, toolCallId: 'tc2' as ToolCallId }),
    )
    expect(seen).toEqual([PermissionMode.NORMAL, PermissionMode.PLAN])
  })
})
