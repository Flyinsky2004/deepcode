import {
  PermissionAction,
  PermissionMode,
  type PermissionDecision,
  type PermissionEngine,
  type PermissionQuery,
} from '../core/tool.js'
import { isAbsolute, relative, resolve } from 'node:path'
import { evaluateSkillGuards } from '../skills/guards.js'

const READ_ONLY = new Set([
  'file_read',
  'glob',
  'grep',
  'todo_write',
  'ask_user_question',
  'sub_agent',
])
const ASK_NORMAL = new Set(['file_write', 'file_edit', 'bash', 'web_fetch', 'web_search'])
/**
 * MCP 工具的命名前缀（`mcp_<server>_<tool>`）。
 *
 * ⚠️ 必须让它们**走到风险策略段**，否则 `mcp.risk-approval` 是条死规则：
 * 早先 `mcp_*` 既不在 `READ_ONLY` 也不在 `ASK_NORMAL`，模式白名单会在风险段
 * 之前直接返回 `mode.tool-whitelist`——普通模式下 MCP 工具不是"需审批"而是
 * **直接拒绝**，与代码里写明的意图相反。留下一条永不触发的规则比没有这条规则
 * 更坏：后来人会照着它以为 MCP 在普通模式下可用（同 ADR 0002 §三 移除
 * `incomplete_tool_call` 的理由）。
 *
 * 当前 MCP 尚未实现（Phase 10），所以这个洞暂时不可达——正因为如此才要现在修，
 * 免得实现 MCP 时才在"普通模式下工具全被拒"上浪费一轮排查。
 */
const isMcpTool = (name: string): boolean => name.startsWith('mcp_')

/** Ordered, single permission gate used by every tool execution. */
export class DefaultPermissionEngine implements PermissionEngine {
  async decide(query: PermissionQuery): Promise<PermissionDecision> {
    await Promise.resolve()
    const risk = query.descriptor.risk_level
    let ask: PermissionDecision | undefined
    const deny = (reason: string, policyId: string): PermissionDecision => ({
      action: PermissionAction.DENY,
      reason,
      policyId,
      risk,
    })
    const request = (reason: string, policyId: string): PermissionDecision => ({
      action: PermissionAction.ASK,
      reason,
      policyId,
      risk,
    })

    // Tool claim ASK is deferred: later hard-deny policies must still win.
    if (query.toolClaim?.action === PermissionAction.DENY)
      return deny(query.toolClaim.reason, 'tool-claim')
    if (query.toolClaim?.action === PermissionAction.ASK)
      ask = request(query.toolClaim.reason, 'tool-claim.ask')

    if (['file_read', 'file_write', 'file_edit', 'glob', 'grep'].includes(query.toolName)) {
      const raw = typeof query.input['path'] === 'string' ? query.input['path'] : '.'
      const candidate = resolve(isAbsolute(raw) ? raw : query.ctx.workspaceRoot, raw)
      const roots = ['file_read', 'glob', 'grep'].includes(query.toolName)
        ? query.ctx.allowedReadRoots
        : query.ctx.allowedWriteRoots
      const allowed = roots.length ? roots : [query.ctx.workspaceRoot]
      if (
        !allowed.some((root) => {
          const rel = relative(
            resolve(isAbsolute(root) ? root : query.ctx.workspaceRoot, root),
            candidate,
          )
          return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
        })
      )
        return deny('path is outside allowed workspace roots', 'workspace.path-sandbox')
    }

    if (
      query.mode === PermissionMode.PLAN &&
      (query.descriptor.capabilities.includes('write') ||
        (query.descriptor.capabilities.includes('shell') &&
          query.toolClaim?.action !== PermissionAction.ALLOW))
    )
      return deny('tool is not allowed in plan mode', 'mode.plan.read-only')

    const modeAllowed =
      query.mode === PermissionMode.YOLO ||
      // MCP 工具**放行到风险策略**，而不是在模式阶段就下结论。
      //
      // 它们的风险等级由 server 声明，而模式白名单只认识内置工具名——把 `mcp_*`
      // 挡在这里会让风险段那条 `mcp.risk-approval` 规则**永远不可达**（留一条
      // 永不触发的规则比没有更坏，见 ADR 0002 §三 移除 `incomplete_tool_call`
      // 的同一条理由）。
      //
      // ⚠️ 但**不在 PLAN 下放行**：PLAN 是只读模式，而 MCP 工具的能力未知，
      // 放行等于用"未知风险"换掉"确定的只读保证"。保持 fail-closed。
      (query.mode !== PermissionMode.PLAN && isMcpTool(query.toolName)) ||
      (query.mode === PermissionMode.PLAN
        ? READ_ONLY.has(query.toolName) ||
          (query.descriptor.capabilities.includes('shell') &&
            query.toolClaim?.action === PermissionAction.ALLOW)
        : query.mode === PermissionMode.AUTO_EDIT
          ? READ_ONLY.has(query.toolName) || ['file_write', 'file_edit'].includes(query.toolName)
          : READ_ONLY.has(query.toolName))
    if (!modeAllowed) {
      if (ASK_NORMAL.has(query.toolName) || query.toolClaim?.action === PermissionAction.ASK)
        ask ??= request('tool requires approval', `mode.${query.mode}.ask`)
      else return deny(`tool denied: ${query.toolName}`, 'mode.tool-whitelist')
    }

    const guardOutcome = evaluateSkillGuards(
      query.skillGuards,
      query.toolName,
      query.input,
      query.ctx,
    )
    if (!guardOutcome.allowed && guardOutcome.guard?.action === PermissionAction.DENY)
      return deny(guardOutcome.reason, guardOutcome.guard.guardId)
    if (!guardOutcome.allowed && guardOutcome.guard?.action === PermissionAction.ASK)
      ask ??= request(guardOutcome.reason, guardOutcome.guard.guardId)
    if (risk === 'critical') return deny('critical-risk tool denied', 'risk.critical-deny')
    if (risk === 'high' && !ask)
      ask = request('high-risk action requires approval', 'risk.high-approval')
    if (query.toolName.startsWith('mcp_') && risk !== 'low')
      ask ??= request('MCP tool requires approval', 'mcp.risk-approval')
    return ask ?? { action: PermissionAction.ALLOW, reason: '', policyId: 'mode.allow', risk }
  }
}
