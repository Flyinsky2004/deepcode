import { z } from 'zod'

import { AgentError, ErrorCode } from '../core/errors.js'
import {
  PermissionAction,
  RiskLevel,
  ToolCapability,
  type Tool,
  type ToolContext,
  type ToolResult,
  type ValidationResult,
} from '../core/tool.js'
import { SubAgentRunMode, SubAgentVisibility, type SubAgentSession } from './models.js'
import type { SubAgentManager } from './manager.js'

const runSchema = z.object({
  action: z.literal('run').default('run'),
  agent_type: z.string().min(1),
  task: z.string().min(1).max(20_000),
  context: z.string().max(50_000).optional(),
  expected_output: z.string().max(10_000).optional(),
  constraints: z.string().max(20_000).optional(),
  allowed_paths: z.array(z.string().min(1)).max(100).optional(),
  run_mode: z.enum(SubAgentRunMode).optional(),
  visibility: z.enum(SubAgentVisibility).optional(),
  detached: z.boolean().optional(),
})
const statusSchema = z.object({ action: z.literal('status'), session_id: z.string().min(1) })
const cancelSchema = z.object({ action: z.literal('cancel'), session_id: z.string().min(1) })
const resumeSchema = z.object({
  action: z.literal('resume'),
  continuation_handle: z.string().min(1),
})
const listSchema = z.object({ action: z.literal('list') })
const schema = z.union([runSchema, statusSchema, cancelSchema, resumeSchema, listSchema])

function validated(input: unknown): ValidationResult {
  const result = schema.safeParse(input)
  return result.success
    ? { ok: true, value: result.data }
    : {
        ok: false,
        errors: result.error.issues.map((issue) => ({
          path: issue.path.filter(
            (item): item is string | number => typeof item === 'string' || typeof item === 'number',
          ),
          message: issue.message,
        })),
      }
}

function visibleStatus(session: SubAgentSession): Readonly<Record<string, unknown>> {
  return {
    sessionId: session.sessionId,
    agentType: session.agentType,
    status: session.status,
    continuationHandle: session.continuationHandle,
    ...(session.result === undefined ? {} : { result: session.result }),
  }
}

async function ownedSession(
  manager: SubAgentManager,
  sessionId: string,
  ctx: ToolContext,
): Promise<SubAgentSession> {
  const session = await manager.status(sessionId)
  if (session.parentSessionId !== ctx.sessionId || session.principalId !== ctx.principalId)
    throw new AgentError({
      code: ErrorCode.SESSION_NOT_FOUND,
      message: 'sub-agent session not found',
      source: 'subagents.tool',
    })
  return session
}

/** 创建唯一的子代理工具入口；执行仍经过父 ToolExecutor 的统一权限与审计。 */
export function createSubAgentTool(manager: SubAgentManager): Tool {
  return {
    descriptor: {
      name: 'sub_agent',
      description:
        'Delegate a self-contained task to a specialized sub-agent, query/cancel it, or resume it from a continuation handle.',
      input_schema: {
        type: 'object',
        properties: {
          action: { enum: ['run', 'status', 'cancel', 'resume', 'list'], default: 'run' },
          agent_type: { type: 'string' },
          task: { type: 'string' },
          context: { type: 'string' },
          expected_output: { type: 'string' },
          constraints: { type: 'string' },
          allowed_paths: { type: 'array', items: { type: 'string' } },
          run_mode: { enum: Object.values(SubAgentRunMode) },
          visibility: { enum: Object.values(SubAgentVisibility) },
          detached: { type: 'boolean' },
          session_id: { type: 'string' },
          continuation_handle: { type: 'string' },
        },
        oneOf: [
          {
            properties: { action: { const: 'run' } },
            required: ['agent_type', 'task'],
          },
          {
            properties: { action: { const: 'status' } },
            required: ['action', 'session_id'],
          },
          {
            properties: { action: { const: 'cancel' } },
            required: ['action', 'session_id'],
          },
          {
            properties: { action: { const: 'resume' } },
            required: ['action', 'continuation_handle'],
          },
          {
            properties: { action: { const: 'list' } },
            required: ['action'],
          },
        ],
      },
      version: '1.0.0',
      risk_level: RiskLevel.LOW,
      capabilities: [ToolCapability.DELEGATE],
      source: { kind: 'native' },
    },
    validate: validated,
    safetyCheck: (input) =>
      input['detached'] === true
        ? {
            action: PermissionAction.ASK,
            reason: 'detached sub-agent continues after its parent turn ends',
          }
        : undefined,
    async execute(ctx, input): Promise<ToolResult> {
      const action = typeof input['action'] === 'string' ? input['action'] : 'run'
      try {
        if (action === 'run') {
          const result = await manager.launch(
            {
              agentType: String(input['agent_type']),
              task: String(input['task']),
              ...(typeof input['context'] === 'string' ? { context: input['context'] } : {}),
              ...(typeof input['expected_output'] === 'string'
                ? { expectedOutput: input['expected_output'] }
                : {}),
              ...(typeof input['constraints'] === 'string'
                ? { constraints: input['constraints'] }
                : {}),
              ...(Array.isArray(input['allowed_paths'])
                ? { allowedPaths: input['allowed_paths'].map(String) }
                : {}),
              ...(Object.values(SubAgentRunMode).includes(input['run_mode'] as SubAgentRunMode)
                ? { runMode: input['run_mode'] as SubAgentRunMode }
                : {}),
              ...(Object.values(SubAgentVisibility).includes(
                input['visibility'] as SubAgentVisibility,
              )
                ? { visibility: input['visibility'] as SubAgentVisibility }
                : {}),
              ...(typeof input['detached'] === 'boolean' ? { detached: input['detached'] } : {}),
            },
            ctx,
          )
          return {
            ok: true,
            content: JSON.stringify(result),
            data: { session_id: result.sessionId, status: result.status },
            error_code: null,
            meta: { continuation_handle: result.continuationHandle },
          }
        }
        if (action === 'status') {
          const session = await ownedSession(manager, String(input['session_id']), ctx)
          return {
            ok: true,
            content: JSON.stringify(visibleStatus(session)),
            data: { session_id: session.sessionId, status: session.status },
            error_code: null,
            meta: {},
          }
        }
        if (action === 'cancel') {
          await ownedSession(manager, String(input['session_id']), ctx)
          const cancelled = manager.cancel(String(input['session_id']))
          return {
            ok: cancelled,
            content: cancelled ? 'sub-agent cancellation requested' : 'sub-agent is not running',
            error_code: cancelled ? null : ErrorCode.SESSION_NOT_FOUND,
            meta: {},
          }
        }
        if (action === 'resume') {
          const handle = String(input['continuation_handle'])
          const session = await ownedSession(manager, handle.replace(/^subagent:/u, ''), ctx)
          if (session.continuationHandle !== handle)
            throw new AgentError({
              code: ErrorCode.SUBAGENT_RESUME_FAILED,
              message: 'invalid sub-agent continuation handle',
              source: 'subagents.tool',
            })
          const result = await manager.resume(handle)
          return {
            ok: true,
            content: JSON.stringify(result),
            data: { session_id: result.sessionId, status: result.status },
            error_code: null,
            meta: { continuation_handle: result.continuationHandle },
          }
        }
        const sessions = (await manager.list(ctx.sessionId))
          .filter((session) => session.principalId === ctx.principalId)
          .map(visibleStatus)
        return {
          ok: true,
          content: JSON.stringify(sessions),
          data: { count: sessions.length },
          error_code: null,
          meta: {},
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          ok: false,
          content: message,
          error_code:
            error instanceof AgentError ? error.code : ErrorCode.SUBAGENT_DEFINITION_INVALID,
          meta: {},
        }
      }
    },
  }
}
