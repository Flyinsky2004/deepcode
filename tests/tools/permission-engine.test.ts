/**
 * `DefaultPermissionEngine` 的判定顺序与边界测试。
 *
 * 这是**唯一门控**（progess.md 设计约束 3）：所有工具执行都必须经过它，
 * UI 与模型都绕不过。因此这里按 `core/tool.ts` 声明的固定顺序逐段覆盖：
 *
 * ```
 * 工具策略(claim) → 参数/workspace 策略 → 模式策略 → skill guard → 风险策略
 * ```
 *
 * 重点不是"每种工具返回什么"，而是**顺序本身**——例如工具自己声明的 ASK
 * 必须能被后面的硬拒覆盖，critical 风险必须压过一切审批请求。
 */
import { describe, expect, it } from 'vitest'

import {
  PermissionAction,
  PermissionMode,
  type PermissionQuery,
  type SkillGuardRef,
  type ToolCapability,
  type ToolContext,
  type ToolDescriptor,
  type RiskLevel,
} from '../../src/core/tool.js'
import { DefaultPermissionEngine } from '../../src/tools/permission-engine.js'

const WORKSPACE = '/ws'
const signal = new AbortController().signal

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: 'session-1',
    turnId: 'turn-1',
    principalId: 'principal-1',
    workspaceRoot: WORKSPACE,
    allowedReadRoots: [WORKSPACE],
    allowedWriteRoots: [WORKSPACE],
    turnState: {},
    budget: {},
    signal,
    ...overrides,
  } as unknown as ToolContext
}

function makeDescriptor(
  name: string,
  risk: RiskLevel = 'low',
  capabilities: readonly ToolCapability[] = ['read'],
): ToolDescriptor {
  return {
    name,
    description: `${name} desc`,
    input_schema: { type: 'object' },
    version: '1',
    risk_level: risk,
    capabilities,
    source: { kind: 'native' },
  }
}

/** 与真实内置工具一致的声明，避免用"假风险等级"得出结论。 */
const DESCRIPTORS = {
  file_read: makeDescriptor('file_read', 'low', ['read']),
  file_write: makeDescriptor('file_write', 'medium', ['write']),
  file_edit: makeDescriptor('file_edit', 'medium', ['write']),
  glob: makeDescriptor('glob', 'low', ['read']),
  grep: makeDescriptor('grep', 'low', ['read']),
  bash: makeDescriptor('bash', 'high', ['shell']),
  todo_write: makeDescriptor('todo_write', 'low', ['write']),
  sub_agent: makeDescriptor('sub_agent', 'medium', ['delegate']),
  mcp_demo_tool: makeDescriptor('mcp_demo_tool', 'medium', ['data_access']),
} as const

function makeQuery(overrides: Partial<PermissionQuery> = {}): PermissionQuery {
  return {
    toolName: 'file_read',
    input: { path: 'a.txt' },
    descriptor: DESCRIPTORS.file_read,
    ctx: makeContext(),
    mode: PermissionMode.NORMAL,
    skillGuards: [],
    ...overrides,
  }
}

function makeGuard(overrides: Partial<SkillGuardRef> = {}): SkillGuardRef {
  return {
    guardId: 'guard-1',
    skillName: 'demo-skill',
    guardType: 'deny_tool',
    action: PermissionAction.DENY,
    reason: 'skill 禁止该工具',
    parameters: {},
    ...overrides,
  }
}

const engine = new DefaultPermissionEngine()

describe('DefaultPermissionEngine：工具自身声明（claim）', () => {
  it('claim DENY 是最优先的门：即使 YOLO 模式也直接拒绝', async () => {
    const decision = await engine.decide(
      makeQuery({
        toolName: 'bash',
        descriptor: DESCRIPTORS.bash,
        mode: PermissionMode.YOLO,
        toolClaim: { action: PermissionAction.DENY, reason: '命令含 shell 元字符' },
      }),
    )
    expect(decision).toEqual({
      action: PermissionAction.DENY,
      reason: '命令含 shell 元字符',
      policyId: 'tool-claim',
      risk: 'high',
    })
  })

  it('claim DENY 先于 plan 模式的只读硬拒（顺序固定，不可交换）', async () => {
    const decision = await engine.decide(
      makeQuery({
        toolName: 'file_write',
        descriptor: DESCRIPTORS.file_write,
        mode: PermissionMode.PLAN,
        toolClaim: { action: PermissionAction.DENY, reason: '工具自身拒绝' },
      }),
    )
    // 若顺序相反，这里会得到 mode.plan.read-only
    expect(decision.policyId).toBe('tool-claim')
  })

  it('claim ASK 被 plan 模式的硬拒覆盖（延迟的审批不能救活只读模式下的写工具）', async () => {
    const decision = await engine.decide(
      makeQuery({
        toolName: 'file_write',
        descriptor: DESCRIPTORS.file_write,
        mode: PermissionMode.PLAN,
        toolClaim: { action: PermissionAction.ASK, reason: '需要确认' },
      }),
    )
    expect(decision.action).toBe(PermissionAction.DENY)
    expect(decision.policyId).toBe('mode.plan.read-only')
  })

  it('claim ASK 被 critical 风险硬拒覆盖', async () => {
    const decision = await engine.decide(
      makeQuery({
        toolName: 'bash',
        descriptor: makeDescriptor('bash', 'critical', ['shell']),
        mode: PermissionMode.NORMAL,
        toolClaim: { action: PermissionAction.ASK, reason: '需要确认' },
      }),
    )
    expect(decision.action).toBe(PermissionAction.DENY)
    expect(decision.policyId).toBe('risk.critical-deny')
  })

  it('claim ASK 是最先登记的 ask，后续策略不覆盖其 policyId（ask ??= 语义）', async () => {
    const decision = await engine.decide(
      makeQuery({
        toolName: 'bash',
        descriptor: DESCRIPTORS.bash,
        mode: PermissionMode.NORMAL,
        toolClaim: { action: PermissionAction.ASK, reason: '需要确认' },
      }),
    )
    // 模式策略与风险策略都想 ask，但保留最先的 tool-claim.ask
    expect(decision.action).toBe(PermissionAction.ASK)
    expect(decision.policyId).toBe('tool-claim.ask')
    expect(decision.reason).toBe('需要确认')
  })

  it('claim ASK 让非白名单工具在 NORMAL 模式下也能进入审批（典型是 MCP 工具）', async () => {
    const decision = await engine.decide(
      makeQuery({
        toolName: 'mcp_demo_tool',
        descriptor: DESCRIPTORS.mcp_demo_tool,
        input: {},
        mode: PermissionMode.NORMAL,
        toolClaim: { action: PermissionAction.ASK, reason: 'MCP 调用需要确认' },
      }),
    )
    expect(decision.action).toBe(PermissionAction.ASK)
    expect(decision.policyId).toBe('tool-claim.ask')
  })

  it('claim ALLOW 不是放行凭证：模式策略仍可拒绝', async () => {
    const decision = await engine.decide(
      makeQuery({
        toolName: 'bash',
        descriptor: DESCRIPTORS.bash,
        input: { command: 'git status' },
        mode: PermissionMode.PLAN,
        toolClaim: { action: PermissionAction.ALLOW, reason: '只读命令' },
      }),
    )
    // 工具声明为只读后，计划模式仍要求人工批准。
    expect(decision.action).toBe(PermissionAction.ASK)
    expect(decision.policyId).toBe('mode.plan.shell-approval')
  })
})

describe('DefaultPermissionEngine：路径沙箱（参数 / workspace 策略）', () => {
  it('读工具路径越界被拒，且发生在模式判定之前', async () => {
    const decision = await engine.decide(
      makeQuery({
        toolName: 'file_read',
        input: { path: '../secret.txt' },
        mode: PermissionMode.YOLO,
      }),
    )
    expect(decision.action).toBe(PermissionAction.DENY)
    expect(decision.policyId).toBe('workspace.path-sandbox')
  })

  it('plan 模式下写工具越界时，报的是路径逃逸而不是 plan 只读（顺序固化）', async () => {
    const decision = await engine.decide(
      makeQuery({
        toolName: 'file_write',
        descriptor: DESCRIPTORS.file_write,
        input: { path: '/etc/passwd' },
        mode: PermissionMode.PLAN,
      }),
    )
    expect(decision.policyId).toBe('workspace.path-sandbox')
  })

  it('前缀相同但不同目录的路径不算命中（`/ws-evil` 不是 `/ws` 的子路径）', async () => {
    const decision = await engine.decide(
      makeQuery({ toolName: 'file_read', input: { path: '/ws-evil/a.txt' } }),
    )
    expect(decision.policyId).toBe('workspace.path-sandbox')
  })

  it('缺少 path 参数时按 `.`（工作区根）处理', async () => {
    const decision = await engine.decide(makeQuery({ toolName: 'glob', input: {} }))
    expect(decision.action).toBe(PermissionAction.ALLOW)
  })

  it('path 参数不是字符串时同样回退到 `.`（不信任模型给的类型）', async () => {
    const decision = await engine.decide(
      makeQuery({ toolName: 'grep', input: { path: 42, pattern: 'x' } }),
    )
    expect(decision.action).toBe(PermissionAction.ALLOW)
  })

  it('绝对路径落在允许根内则通过', async () => {
    const decision = await engine.decide(
      makeQuery({ toolName: 'file_read', input: { path: `${WORKSPACE}/a.txt` } }),
    )
    expect(decision.action).toBe(PermissionAction.ALLOW)
  })

  it('允许根为空表时退化为仅工作区根', async () => {
    const decision = await engine.decide(
      makeQuery({
        toolName: 'file_read',
        ctx: makeContext({ allowedReadRoots: [], allowedWriteRoots: [] }),
      }),
    )
    expect(decision.action).toBe(PermissionAction.ALLOW)
  })

  it('相对形式的允许根按工作区根拼接', async () => {
    const decision = await engine.decide(
      makeQuery({
        toolName: 'file_read',
        input: { path: 'sub/a.txt' },
        ctx: makeContext({ allowedReadRoots: ['sub'] }),
      }),
    )
    expect(decision.action).toBe(PermissionAction.ALLOW)

    const outside = await engine.decide(
      makeQuery({
        toolName: 'file_read',
        input: { path: 'a.txt' },
        ctx: makeContext({ allowedReadRoots: ['sub'] }),
      }),
    )
    expect(outside.policyId).toBe('workspace.path-sandbox')
  })

  it('读工具用 allowedReadRoots、写工具用 allowedWriteRoots（两套根互不串用）', async () => {
    const ctx = makeContext({ allowedReadRoots: ['/other'], allowedWriteRoots: [WORKSPACE] })

    const writeInside = await engine.decide(
      makeQuery({
        toolName: 'file_write',
        descriptor: DESCRIPTORS.file_write,
        input: { path: 'a.txt' },
        ctx,
        mode: PermissionMode.AUTO_EDIT,
      }),
    )
    expect(writeInside.action).toBe(PermissionAction.ALLOW)

    const readOutside = await engine.decide(
      makeQuery({ toolName: 'file_read', input: { path: 'a.txt' }, ctx }),
    )
    expect(readOutside.policyId).toBe('workspace.path-sandbox')
  })

  it('⚠️ 名字以 `..` 开头的工作区内路径被误判为越界（可疑，保留现状）', async () => {
    // 分析：这里用 `rel.startsWith('..')` 判越界，会把 `..foo` 这类**段名**开头的
    // 合法路径误伤（`relative('/ws','/ws/..foo')` 恰好等于 '..foo'）。
    // 同类函数 `path-sandbox.resolveWorkspacePath` 判的是 `'..'` / `'../'` 前缀，
    // 结论与这里不一致。方向是"多拒"而非"漏放"，不影响安全性；固化现状待裁决。
    const decision = await engine.decide(
      makeQuery({ toolName: 'file_read', input: { path: '..foo' } }),
    )
    expect(decision.action).toBe(PermissionAction.DENY)
    expect(decision.policyId).toBe('workspace.path-sandbox')
  })

  it('非路径工具完全跳过沙箱阶段（例如 bash / todo_write 没有 path 参数）', async () => {
    const decision = await engine.decide(
      makeQuery({
        toolName: 'todo_write',
        descriptor: DESCRIPTORS.todo_write,
        input: { todos: [] },
        mode: PermissionMode.AUTO_EDIT,
      }),
    )
    expect(decision.action).toBe(PermissionAction.ALLOW)
  })
})

describe('DefaultPermissionEngine：模式策略', () => {
  it('NORMAL：只读工具直通，写/执行类工具进入审批', async () => {
    const read = await engine.decide(makeQuery({ toolName: 'file_read' }))
    expect(read).toMatchObject({ action: PermissionAction.ALLOW, policyId: 'mode.allow' })

    const write = await engine.decide(
      makeQuery({
        toolName: 'file_write',
        descriptor: DESCRIPTORS.file_write,
        input: { path: 'a.txt' },
      }),
    )
    expect(write).toMatchObject({
      action: PermissionAction.ASK,
      policyId: 'mode.normal.ask',
      reason: 'tool requires approval',
    })
  })

  it('NORMAL：既非只读也非待审批清单的工具被白名单硬拒', async () => {
    const decision = await engine.decide(
      makeQuery({
        toolName: 'unknown_tool',
        descriptor: makeDescriptor('unknown_tool', 'low', ['read']),
        input: {},
      }),
    )
    expect(decision).toMatchObject({
      action: PermissionAction.DENY,
      policyId: 'mode.tool-whitelist',
      reason: 'tool denied: unknown_tool',
    })
  })

  it('AUTO_EDIT：写文件免审批，shell 仍需审批', async () => {
    const write = await engine.decide(
      makeQuery({
        toolName: 'file_write',
        descriptor: DESCRIPTORS.file_write,
        input: { path: 'a.txt' },
        mode: PermissionMode.AUTO_EDIT,
      }),
    )
    expect(write.action).toBe(PermissionAction.ALLOW)

    const edit = await engine.decide(
      makeQuery({
        toolName: 'file_edit',
        descriptor: DESCRIPTORS.file_edit,
        input: { path: 'a.txt' },
        mode: PermissionMode.AUTO_EDIT,
      }),
    )
    expect(edit.action).toBe(PermissionAction.ALLOW)

    const shell = await engine.decide(
      makeQuery({
        toolName: 'bash',
        descriptor: DESCRIPTORS.bash,
        input: { command: 'ls' },
        mode: PermissionMode.AUTO_EDIT,
      }),
    )
    expect(shell).toMatchObject({
      action: PermissionAction.ASK,
      policyId: 'mode.auto_edit.ask',
    })
  })

  it('AUTO_EDIT：非写工具同样走白名单拒绝', async () => {
    const decision = await engine.decide(
      makeQuery({
        toolName: 'unknown_tool',
        descriptor: makeDescriptor('unknown_tool', 'low', ['network']),
        input: {},
        mode: PermissionMode.AUTO_EDIT,
      }),
    )
    expect(decision.policyId).toBe('mode.tool-whitelist')
  })

  it('PLAN：只读工具直通，写工具被硬拒', async () => {
    // READ_ONLY 白名单成员中，只有 sub_agent 不带 write 能力标签
    const allowedInPlan = [
      { name: 'file_read', descriptor: DESCRIPTORS.file_read, input: { path: 'a.txt' } },
      { name: 'glob', descriptor: DESCRIPTORS.glob, input: { path: 'a.txt' } },
      { name: 'grep', descriptor: DESCRIPTORS.grep, input: { path: 'a.txt' } },
      { name: 'sub_agent', descriptor: DESCRIPTORS.sub_agent, input: {} },
    ]
    for (const { name, descriptor, input } of allowedInPlan) {
      const decision = await engine.decide(
        makeQuery({ toolName: name, descriptor, input, mode: PermissionMode.PLAN }),
      )
      expect(decision.action, `${name} 在 plan 模式应放行`).toBe(PermissionAction.ALLOW)
    }

    const write = await engine.decide(
      makeQuery({
        toolName: 'file_write',
        descriptor: DESCRIPTORS.file_write,
        input: { path: 'a.txt' },
        mode: PermissionMode.PLAN,
      }),
    )
    expect(write).toMatchObject({
      action: PermissionAction.DENY,
      policyId: 'mode.plan.read-only',
      reason: 'tool is not allowed in plan mode',
    })
  })

  it('PLAN：todo_write 带 write 能力标签但属于只读白名单？——不，它被同一道硬拒挡住', async () => {
    // todo_write 在 READ_ONLY 集合里，但它声明了 write 能力：
    // 先执行的「plan 模式 + write 能力」硬拒优先，白名单根本没机会生效。
    const decision = await engine.decide(
      makeQuery({
        toolName: 'todo_write',
        descriptor: DESCRIPTORS.todo_write,
        input: { todos: [] },
        mode: PermissionMode.PLAN,
      }),
    )
    expect(decision.action).toBe(PermissionAction.DENY)
    expect(decision.policyId).toBe('mode.plan.read-only')
  })

  it('PLAN：没有 claim 的 shell 工具被硬拒（无法证明是只读命令）', async () => {
    const decision = await engine.decide(
      makeQuery({
        toolName: 'bash',
        descriptor: DESCRIPTORS.bash,
        input: { command: 'rm -rf /' },
        mode: PermissionMode.PLAN,
      }),
    )
    expect(decision.policyId).toBe('mode.plan.read-only')
  })

  it('PLAN：claim ASK 的 shell 工具同样被硬拒（ASK 不等于"已证明只读"）', async () => {
    const decision = await engine.decide(
      makeQuery({
        toolName: 'bash',
        descriptor: DESCRIPTORS.bash,
        input: { command: 'node script.js' },
        mode: PermissionMode.PLAN,
        toolClaim: { action: PermissionAction.ASK, reason: '需要审批' },
      }),
    )
    expect(decision.action).toBe(PermissionAction.DENY)
    expect(decision.policyId).toBe('mode.plan.read-only')
  })

  it('YOLO：模式层不再拦截，但高风险仍触发审批（风险门是最后一道、跨模式生效）', async () => {
    const write = await engine.decide(
      makeQuery({
        toolName: 'file_write',
        descriptor: DESCRIPTORS.file_write,
        input: { path: 'a.txt' },
        mode: PermissionMode.YOLO,
      }),
    )
    expect(write.action).toBe(PermissionAction.ALLOW)
    expect(write.policyId).toBe('mode.allow')

    const shell = await engine.decide(
      makeQuery({
        toolName: 'bash',
        descriptor: DESCRIPTORS.bash,
        input: { command: 'npm test' },
        mode: PermissionMode.YOLO,
      }),
    )
    expect(shell).toMatchObject({
      action: PermissionAction.ASK,
      policyId: 'risk.high-approval',
    })
  })

  it('每个决策都回填描述符的风险等级，便于事件流与 UI 展示', async () => {
    const decision = await engine.decide(
      makeQuery({ toolName: 'file_read', descriptor: makeDescriptor('file_read', 'medium') }),
    )
    expect(decision.risk).toBe('medium')
  })
})

describe('DefaultPermissionEngine：MCP 工具审批', () => {
  it('MCP 工具在 YOLO 下按风险等级进入审批', async () => {
    const decision = await engine.decide(
      makeQuery({
        toolName: 'mcp_demo_tool',
        descriptor: DESCRIPTORS.mcp_demo_tool,
        input: {},
        mode: PermissionMode.YOLO,
      }),
    )
    expect(decision).toMatchObject({
      action: PermissionAction.ASK,
      policyId: 'mcp.risk-approval',
      reason: 'MCP tool requires approval',
    })
  })

  it('低风险 MCP 工具不需要审批', async () => {
    const decision = await engine.decide(
      makeQuery({
        toolName: 'mcp_demo_tool',
        descriptor: makeDescriptor('mcp_demo_tool', 'low', ['data_access']),
        input: {},
        mode: PermissionMode.YOLO,
      }),
    )
    expect(decision.action).toBe(PermissionAction.ALLOW)
    expect(decision.policyId).toBe('mode.allow')
  })

  it('critical 风险的 MCP 工具直接硬拒，不给审批机会', async () => {
    const decision = await engine.decide(
      makeQuery({
        toolName: 'mcp_demo_tool',
        descriptor: makeDescriptor('mcp_demo_tool', 'critical', ['data_access']),
        input: {},
        mode: PermissionMode.YOLO,
      }),
    )
    expect(decision.policyId).toBe('risk.critical-deny')
  })

  it('NORMAL/AUTO_EDIT 下 MCP 工具进入 MCP 审批策略，而不是被白名单直接拒绝', async () => {
    // 这里原本固化的是一个缺陷（已修）：
    //
    // MCP 审批分支在「风险策略」阶段，而模式白名单在更早的「模式策略」阶段就会
    // 拒绝任何不在白名单里的工具。`mcp_*` 不在 READ_ONLY / ASK_NORMAL 集合中，
    // 于是风险段那条 `mcp.risk-approval` 规则**永远不可达**——普通模式下 MCP 工具
    // 是"直接拒绝"而非"需审批"。
    //
    // 留一条永不触发的规则，比没有这条规则更坏：后来人会以为 MCP 在普通模式下
    // 「需审批」，实际是「不可调用」。（与 ADR 0002 §三 移除 `incomplete_tool_call`
    // 同一条理由。）
    for (const mode of [PermissionMode.NORMAL, PermissionMode.AUTO_EDIT]) {
      const decision = await engine.decide(
        makeQuery({
          toolName: 'mcp_demo_tool',
          descriptor: DESCRIPTORS.mcp_demo_tool,
          input: {},
          mode,
        }),
      )
      expect(decision.action, `${mode} 下 MCP 工具应进入审批`).toBe(PermissionAction.ASK)
      expect(decision.policyId).toBe('mcp.risk-approval')
    }
  })

  it('非 mcp_ 前缀的工具不会触发 MCP 审批', async () => {
    const decision = await engine.decide(
      makeQuery({
        toolName: 'file_write',
        descriptor: DESCRIPTORS.file_write,
        input: { path: 'a.txt' },
        mode: PermissionMode.YOLO,
      }),
    )
    expect(decision.policyId).toBe('mode.allow')
  })
})

describe('DefaultPermissionEngine：skill 运行时守护', () => {
  it('参数里写死 toolName 的 guard 只对同名工具生效', async () => {
    const guards = [makeGuard({ parameters: { toolName: 'bash' }, guardId: 'guard-bash' })]
    const decision = await engine.decide(
      makeQuery({
        toolName: 'bash',
        descriptor: DESCRIPTORS.bash,
        input: { command: 'ls' },
        skillGuards: guards,
      }),
    )
    expect(decision).toMatchObject({
      action: PermissionAction.DENY,
      policyId: 'guard-bash',
      reason: 'skill 禁止该工具',
    })
  })

  it('guard 的 toolName 不匹配时不影响判定（不是"任何一个 guard 命中就生效"）', async () => {
    const decision = await engine.decide(
      makeQuery({
        toolName: 'file_read',
        skillGuards: [makeGuard({ parameters: { toolName: 'bash' } })],
      }),
    )
    expect(decision.action).toBe(PermissionAction.ALLOW)
  })

  it('未写 toolName 的 guard 是通配，命中任意工具', async () => {
    const decision = await engine.decide(makeQuery({ skillGuards: [makeGuard()] }))
    expect(decision.action).toBe(PermissionAction.DENY)
    expect(decision.policyId).toBe('guard-1')
  })

  it('guard ASK 只登记审批，不阻止后续风险策略（这里由 guard 提供 ask）', async () => {
    const decision = await engine.decide(
      makeQuery({
        toolName: 'file_read',
        skillGuards: [makeGuard({ action: PermissionAction.ASK, guardId: 'guard-ask' })],
      }),
    )
    expect(decision).toMatchObject({ action: PermissionAction.ASK, policyId: 'guard-ask' })
  })

  it('guard ASK 不覆盖已有的 tool-claim.ask（先到先得）', async () => {
    const decision = await engine.decide(
      makeQuery({
        toolName: 'file_read',
        toolClaim: { action: PermissionAction.ASK, reason: '工具自身要求确认' },
        skillGuards: [makeGuard({ action: PermissionAction.ASK, guardId: 'guard-ask' })],
      }),
    )
    expect(decision.policyId).toBe('tool-claim.ask')
    expect(decision.reason).toBe('工具自身要求确认')
  })

  it('guard DENY 能被更早的模式白名单拒绝抢先（顺序固化：模式先于 guard）', async () => {
    const decision = await engine.decide(
      makeQuery({
        toolName: 'unknown_tool',
        descriptor: makeDescriptor('unknown_tool', 'low', ['read']),
        input: {},
        skillGuards: [makeGuard({ guardId: 'guard-late' })],
      }),
    )
    expect(decision.policyId).toBe('mode.tool-whitelist')
  })

  it('guard 是数组时按第一个匹配项判定（find 而非 every）', async () => {
    const decision = await engine.decide(
      makeQuery({
        skillGuards: [
          makeGuard({ parameters: { toolName: 'bash' }, guardId: 'guard-bash' }),
          makeGuard({ parameters: { toolName: 'file_read' }, guardId: 'guard-read' }),
        ],
      }),
    )
    expect(decision.policyId).toBe('guard-read')
  })
})

describe('DefaultPermissionEngine：风险策略', () => {
  it('high 风险且尚无审批时补充审批', async () => {
    const decision = await engine.decide(
      makeQuery({
        toolName: 'bash',
        descriptor: DESCRIPTORS.bash,
        input: { command: 'npm run build' },
        mode: PermissionMode.NORMAL,
        toolClaim: { action: PermissionAction.ALLOW, reason: '只读' },
      }),
    )
    // NORMAL 模式下 bash 本就在待审批清单里，但 ask ??= 保留了模式策略的登记
    expect(decision.action).toBe(PermissionAction.ASK)
  })

  it('high 风险在 ask 已存在时不重复登记（保留第一个 policyId）', async () => {
    const decision = await engine.decide(
      makeQuery({
        toolName: 'bash',
        descriptor: DESCRIPTORS.bash,
        input: { command: 'ls' },
        mode: PermissionMode.YOLO,
        toolClaim: { action: PermissionAction.ASK, reason: '工具要求确认' },
      }),
    )
    expect(decision.policyId).toBe('tool-claim.ask')
  })

  it('medium / low 风险本身不触发审批', async () => {
    const decision = await engine.decide(
      makeQuery({
        toolName: 'file_write',
        descriptor: DESCRIPTORS.file_write,
        input: { path: 'a.txt' },
        mode: PermissionMode.YOLO,
      }),
    )
    expect(decision).toMatchObject({ action: PermissionAction.ALLOW, risk: 'medium' })

    const subAgent = await engine.decide(
      makeQuery({
        toolName: 'sub_agent',
        descriptor: DESCRIPTORS.sub_agent,
        input: {},
        mode: PermissionMode.YOLO,
      }),
    )
    expect(subAgent.action).toBe(PermissionAction.ALLOW)
  })

  it('critical 在任何模式都硬拒（含 YOLO 与已声明 ALLOW 的 shell）', async () => {
    const modes = [
      PermissionMode.NORMAL,
      PermissionMode.AUTO_EDIT,
      PermissionMode.YOLO,
      PermissionMode.PLAN,
    ]
    for (const mode of modes) {
      const decision = await engine.decide(
        makeQuery({
          toolName: 'bash',
          descriptor: makeDescriptor('bash', 'critical', ['shell']),
          input: { command: 'ls' },
          mode,
          toolClaim: { action: PermissionAction.ALLOW, reason: '只读' },
        }),
      )
      // plan + shell + claim ALLOW 会走到风险阶段；其它模式在更早的阶段就该拒绝
      expect(decision.action, `${mode} 下 critical 必须被拒`).toBe(PermissionAction.DENY)
    }
  })

  it('默认放行的 policyId 是 mode.allow，且 reason 为空（无需向用户解释）', async () => {
    const decision = await engine.decide(makeQuery({ toolName: 'file_read' }))
    expect(decision).toEqual({
      action: PermissionAction.ALLOW,
      reason: '',
      policyId: 'mode.allow',
      risk: 'low',
    })
  })

  it('已有授权只覆盖审批，不覆盖计划模式与硬拒策略', async () => {
    const matchingGrant = {
      kind: 'tool' as const,
      toolName: 'file_write',
      sessionId: 'session-1' as never,
      expiresAt: '2027-01-01T00:00:00.000Z',
    }
    const input = {
      toolName: 'file_write',
      descriptor: DESCRIPTORS.file_write,
      input: { path: 'a.txt' },
      matchingGrant,
    }
    await expect(engine.decide(makeQuery(input))).resolves.toMatchObject({
      action: PermissionAction.ALLOW,
      policyId: 'grant.tool',
    })
    await expect(
      engine.decide(makeQuery({ ...input, mode: PermissionMode.PLAN })),
    ).resolves.toMatchObject({ action: PermissionAction.DENY, policyId: 'mode.plan.read-only' })
    await expect(
      engine.decide(
        makeQuery({
          ...input,
          descriptor: makeDescriptor('file_write', 'critical', ['write']),
        }),
      ),
    ).resolves.toMatchObject({ action: PermissionAction.DENY, policyId: 'risk.critical-deny' })
  })

  it('计划模式仅让简单只读 Shell 命令进入审批', async () => {
    const command = (value: string) =>
      makeQuery({
        toolName: 'bash',
        descriptor: DESCRIPTORS.bash,
        input: { command: value },
        mode: PermissionMode.PLAN,
        toolClaim: { action: PermissionAction.ALLOW, reason: '只读' },
      })
    await expect(engine.decide(command('git status'))).resolves.toMatchObject({
      action: PermissionAction.ASK,
      policyId: 'mode.plan.shell-approval',
    })
    for (const unsafe of ['git worktree add /tmp/x', 'git diff --output=/tmp/x', 'rg --pre echo']) {
      await expect(engine.decide(command(unsafe))).resolves.toMatchObject({
        action: PermissionAction.DENY,
        policyId: 'mode.plan.read-only',
      })
    }
  })
})
