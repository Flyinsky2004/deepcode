import {
  PermissionAction,
  PermissionMode,
  type PermissionDecision,
  type PermissionEngine,
  type PermissionQuery,
} from '../core/tool.js'
import { isAbsolute, relative, resolve } from 'node:path'

const READ_ONLY = new Set([
  'file_read',
  'glob',
  'grep',
  'todo_write',
  'ask_user_question',
  'sub_agent',
])
const ASK_NORMAL = new Set(['file_write', 'file_edit', 'bash', 'web_fetch', 'web_search'])

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

    const guard = query.skillGuards.find(
      (g) => g.parameters['toolName'] === undefined || g.parameters['toolName'] === query.toolName,
    )
    if (guard?.action === PermissionAction.DENY) return deny(guard.reason, guard.guardId)
    if (guard?.action === PermissionAction.ASK) ask ??= request(guard.reason, guard.guardId)
    if (risk === 'critical') return deny('critical-risk tool denied', 'risk.critical-deny')
    if (risk === 'high' && !ask)
      ask = request('high-risk action requires approval', 'risk.high-approval')
    if (query.toolName.startsWith('mcp_') && risk !== 'low')
      ask ??= request('MCP tool requires approval', 'mcp.risk-approval')
    return ask ?? { action: PermissionAction.ALLOW, reason: '', policyId: 'mode.allow', risk }
  }
}
