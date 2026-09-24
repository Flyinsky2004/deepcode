import type { AgentBudget, BudgetConsumption } from '../core/budget.js'
import type { ModelRef, ModelTier } from '../core/provider.js'
import type { Finding, FileChange, Evidence, SubAgentResult } from '../core/turn.js'
import type { PermissionMode, SkillGuardRef } from '../core/tool.js'
import type { WorkingMemory } from '../core/context.js'

export const SubAgentContextPolicy = {
  MINIMAL: 'minimal',
  PROJECT_AWARE: 'project-aware',
  FILE_FOCUSED: 'file-focused',
  CONVERSATION_AWARE: 'conversation-aware',
  FULL_PARENT_SUMMARY: 'full-parent-summary',
} as const
export type SubAgentContextPolicy =
  (typeof SubAgentContextPolicy)[keyof typeof SubAgentContextPolicy]

export const SubAgentRunMode = {
  FOREGROUND: 'foreground',
  BACKGROUND: 'background',
  PARALLEL: 'parallel',
} as const
export type SubAgentRunMode = (typeof SubAgentRunMode)[keyof typeof SubAgentRunMode]

export const WorkingDirectoryPolicy = {
  PARENT: 'parent',
  ISOLATED: 'isolated',
  READONLY: 'readonly',
} as const
export type WorkingDirectoryPolicy =
  (typeof WorkingDirectoryPolicy)[keyof typeof WorkingDirectoryPolicy]

export const SubAgentVisibility = {
  PRIVATE: 'private',
  SUMMARY: 'summary',
  FULL: 'full',
} as const
export type SubAgentVisibility = (typeof SubAgentVisibility)[keyof typeof SubAgentVisibility]

export const SubAgentSessionStatus = {
  QUEUED: 'queued',
  RUNNING: 'running',
  COMPLETED: 'completed',
  PARTIAL: 'partial',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  RECOVERABLE: 'recoverable',
} as const
export type SubAgentSessionStatus =
  (typeof SubAgentSessionStatus)[keyof typeof SubAgentSessionStatus]

export interface ResultContract {
  readonly includeFindings: boolean
  readonly includeChanges: boolean
  readonly includeEvidence: boolean
  readonly includeUnresolved: boolean
  readonly maxSummaryChars: number
}

export const DEFAULT_RESULT_CONTRACT: ResultContract = {
  includeFindings: true,
  includeChanges: true,
  includeEvidence: true,
  includeUnresolved: true,
  maxSummaryChars: 12_000,
}

/**
 * 子代理定义的目标协议。额外的 `systemPrompt` / `model*` 是运行时所需字段；
 * 其余字段与 parts/09 §7.1 一一对应。
 */
export interface SubAgentDefinition {
  readonly type: string
  readonly version: string
  readonly description: string
  readonly systemPrompt: string
  readonly allowedTools: readonly string[]
  readonly deniedTools: readonly string[]
  readonly contextPolicy: SubAgentContextPolicy
  readonly runMode: SubAgentRunMode
  readonly resultContract: ResultContract
  readonly workingDirectoryPolicy: WorkingDirectoryPolicy
  readonly budget: Partial<AgentBudget>
  readonly visibility: SubAgentVisibility
  readonly modelRef?: ModelRef
  readonly modelTier?: ModelTier
  readonly allowRecursive?: boolean
  readonly maxDepth?: number
  readonly source: 'workspace' | 'user' | 'builtin'
  readonly path: string
  readonly checksum: string
}

/** 持久化的定义快照；定义文件后续变化不会影响已启动的 session。 */
export type SubAgentDefinitionSnapshot = Omit<SubAgentDefinition, 'path'> & {
  readonly path: string
}

export interface SubAgentSession {
  readonly sessionId: string
  readonly parentSessionId: string
  readonly parentTurnId: string
  readonly principalId: string
  readonly agentType: string
  readonly definitionVersion: string
  readonly definition: SubAgentDefinitionSnapshot
  readonly status: SubAgentSessionStatus
  readonly visibility: SubAgentVisibility
  readonly contextSnapshotHash: string
  readonly continuationHandle: string
  readonly runMode: SubAgentRunMode
  readonly workingDirectoryPolicy: WorkingDirectoryPolicy
  readonly workingDirectory: string
  readonly task: string
  readonly selectedContext: string
  readonly expectedOutput: string
  readonly constraints: string
  readonly allowedPaths: readonly string[]
  readonly allowedReadRoots: readonly string[]
  readonly allowedWriteRoots: readonly string[]
  readonly inheritedSkillGuards: readonly SkillGuardRef[]
  readonly parentMode: PermissionMode
  readonly budget: AgentBudget
  readonly consumption: BudgetConsumption
  readonly workingMemory: WorkingMemory
  readonly result?: SubAgentResult
  readonly createdAt: string
  readonly updatedAt: string
  readonly completedAt: string | null
  readonly detached: boolean
  readonly depth: number
}

export interface SubAgentRunRequest {
  readonly agentType: string
  readonly task: string
  readonly context?: string
  readonly expectedOutput?: string
  readonly constraints?: string
  readonly allowedPaths?: readonly string[]
  readonly runMode?: SubAgentRunMode
  readonly visibility?: SubAgentVisibility
  readonly detached?: boolean
}

export interface SubAgentLaunchResult {
  readonly accepted: boolean
  readonly sessionId: string
  readonly status: SubAgentSessionStatus
  readonly continuationHandle: string
  readonly result?: SubAgentResult
}

export type { Evidence, FileChange, Finding, SubAgentResult }
