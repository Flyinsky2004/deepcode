/**
 * 标识符：品牌类型、生成与解析。
 *
 * 可恢复性契约（progess.md 设计约束 4）要求"所有 turn、tool call、权限请求和
 * compact boundary 都必须可恢复"。要做到这一点，每个标识符必须：
 *
 * - **语义独立**：`SessionId` 不能和 `TurnId` 互相赋值，否则恢复时会张冠李戴。
 * - **可解析**：能从 ID 本身看出它属于哪个层次（见 `parseTurnId`）。
 * - **格式稳定**：ID 会落盘、进事件日志、出现在 API 响应里，格式即契约。
 */

import { randomUUID } from 'node:crypto'

import { type Brand } from './brand.js'

// ── 品牌类型 ──────────────────────────────────────────────────────

/**
 * 会话标识。旧项目中即 `Conversation.id`（子代理会话也是同一个命名空间，
 * 靠 `parent_conversation_id` 区分）。
 */
export type SessionId = Brand<string, 'SessionId'>

/**
 * turn 标识。两种格式，靠前缀区分：
 * - 主代理：`turn_<序号>_<会话 id 前 8 位>`
 * - 子代理：`subagent_turn_<序号>_<会话 id 前 8 位>`
 *
 * 前缀是主代理与子代理消息的**唯一**磁盘级判别标记。见 `createTurnId`。
 */
export type TurnId = Brand<string, 'TurnId'>

/** 模型请求中单个工具调用的标识，由 provider 返回，用于配对 tool_use / tool_result。 */
export type ToolCallId = Brand<string, 'ToolCallId'>

/** 消息标识。 */
export type MessageId = Brand<string, 'MessageId'>

/**
 * 主体标识。Web UI 下每个用户映射到独立 `principalId`，
 * 会话、权限请求和事件都必须校验该主体（parts/09 §1.1）。
 */
export type PrincipalId = Brand<string, 'PrincipalId'>

/** 权限请求标识。持久化后可恢复，因此必须全局唯一。 */
export type PermissionRequestId = Brand<string, 'PermissionRequestId'>

/** 运行时事件标识。WebSocket 重连时用 `lastEventId` 补发事件（parts/09 §1.1）。 */
export type EventId = Brand<string, 'EventId'>

/** 子代理会话标识。 */
export type SubAgentSessionId = Brand<string, 'SubAgentSessionId'>

/** 压缩边界标识。版本化 schema 的组成部分（parts/09 §4）。 */
export type CompactBoundaryId = Brand<string, 'CompactBoundaryId'>

/** `/workwith` 建立的模型覆盖标识。 */
export type ModelOverrideId = Brand<string, 'ModelOverrideId'>

/** 工具执行记录标识，用于 `toolCallId + inputHash` 去重（parts/09 §2）。 */
export type ToolExecutionId = Brand<string, 'ToolExecutionId'>

// ── 生成 ──────────────────────────────────────────────────────────

/**
 * 生成一个随机标识（UUID v4）。
 *
 * 所有不需要人类可读性的标识都用它。使用 `node:crypto` 的 `randomUUID`
 * 而非 `Math.random`——ID 会进入持久化数据与审计日志，必须不可预测，
 * 否则 Web UI 场景下可被枚举（parts/09 §1.1 要求校验 principal 而非仅凭 URL）。
 */
function randomId<T extends Brand<string, string>>(): T {
  return randomUUID() as T
}

/** 生成会话 ID。 */
export function createSessionId(): SessionId {
  return randomId<SessionId>()
}

/** 生成消息 ID。 */
export function createMessageId(): MessageId {
  return randomId<MessageId>()
}

/** 生成工具调用 ID（仅用于本地合成，正常来自 provider）。 */
export function createToolCallId(): ToolCallId {
  return randomId<ToolCallId>()
}

/** 生成权限请求 ID。 */
export function createPermissionRequestId(): PermissionRequestId {
  return randomId<PermissionRequestId>()
}

/** 生成事件 ID。 */
export function createEventId(): EventId {
  return randomId<EventId>()
}

/** 生成子代理会话 ID。 */
export function createSubAgentSessionId(): SubAgentSessionId {
  return randomId<SubAgentSessionId>()
}

/** 生成压缩边界 ID。 */
export function createCompactBoundaryId(): CompactBoundaryId {
  return randomId<CompactBoundaryId>()
}

/** 生成模型覆盖 ID。 */
export function createModelOverrideId(): ModelOverrideId {
  return randomId<ModelOverrideId>()
}

/** 生成工具执行记录 ID。 */
export function createToolExecutionId(): ToolExecutionId {
  return randomId<ToolExecutionId>()
}

/** 生成主体 ID。 */
export function createPrincipalId(): PrincipalId {
  return randomId<PrincipalId>()
}

// ── turn ID ───────────────────────────────────────────────────────

/** 会话 ID 在 turn ID 中保留的字符数。 */
const SESSION_PREFIX_LENGTH = 8

/** turn ID 的两种前缀。子代理的更长，必须优先匹配，否则会被主代理前缀吃掉。 */
const TURN_ID_PREFIX = 'turn'
const SUBAGENT_TURN_ID_PREFIX = 'subagent_turn'

/**
 * 生成 turn ID。
 *
 * 格式：
 * - 主代理：`turn_<序号>_<会话 id 前 8 位>`
 * - 子代理：`subagent_turn_<序号>_<会话 id 前 8 位>`（`isSubAgent = true`）
 *
 * ⚠️ 两种格式都是**兼容性契约**——旧项目写入磁盘的 `turn_id` 就是这两种，
 * 例如 `turn_3_9fc43b3a`、`subagent_turn_1_9fc43b3a`。前缀是判别消息来自
 * 主代理还是子代理的唯一磁盘级标记，省略它就无法在恢复时正确归属。
 *
 * 为什么内嵌会话前缀：turn 序号（`Conversation.current_turn`）是**每会话**
 * 自增的，单看 `turn_3` 无法区分会话。带上会话前缀后，turn ID 在全局
 * 日志里可以直接归属，无需回查。
 *
 * 会话 ID 短于 8 位时按实际长度截取（旧项目直接切片，不补位）。
 */
export function createTurnId(
  sessionId: SessionId,
  turnNumber: number,
  options: { readonly isSubAgent?: boolean } = {},
): TurnId {
  const prefix = sessionId.slice(0, SESSION_PREFIX_LENGTH)
  const kind = options.isSubAgent === true ? SUBAGENT_TURN_ID_PREFIX : TURN_ID_PREFIX
  return `${kind}_${turnNumber}_${prefix}` as TurnId
}

/** `parseTurnId` 的结果。 */
export interface ParsedTurnId {
  /** turn 序号，即 `Conversation.current_turn` 的值。 */
  readonly turnNumber: number
  /** 会话 ID 的前 8 位。**不是完整会话 ID**，仅用于归属核对。 */
  readonly sessionPrefix: string
  /** 该 turn 是否属于子代理。由前缀判定。 */
  readonly isSubAgent: boolean
}

/**
 * turn ID 的解析正则。
 *
 * 子代理分支必须写在前面（`subagent_turn` 也以 `turn` 结尾，但正则要求
 * `turn` 后紧跟 `_`，所以两者其实不冲突；显式分列是为了让意图明确）。
 * 序号部分必须是纯数字。
 */
const MAIN_TURN_ID_RE = /^turn_(\d+)_(.+)$/
const SUBAGENT_TURN_ID_RE = /^subagent_turn_(\d+)_(.+)$/

/**
 * 从 turn ID 解析出序号、会话前缀与代理类型。
 *
 * 用途：恢复场景下需要从 transcript 里的 `turn_id` 反推 turn 序号，
 * 核对它是否与 `Conversation.current_turn` 一致（不一致即说明数据被外部改动）；
 * 同时判定该消息属于主代理还是子代理。
 *
 * 解析失败返回 `undefined` 而不是抛错——transcript 可能来自旧版本或被手工编辑，
 * 读取侧必须容错（REWRITE_SPEC §3.2「所有反序列化必须对缺失字段容错」）。
 */
export function parseTurnId(turnId: TurnId | string): ParsedTurnId | undefined {
  const match = MAIN_TURN_ID_RE.exec(turnId) ?? SUBAGENT_TURN_ID_RE.exec(turnId)
  if (match === null) return undefined

  const [, rawNumber, sessionPrefix] = match
  if (rawNumber === undefined || sessionPrefix === undefined) return undefined

  return {
    turnNumber: Number.parseInt(rawNumber, 10),
    sessionPrefix,
    isSubAgent: turnId.startsWith(`${SUBAGENT_TURN_ID_PREFIX}_`),
  }
}

// ── 校验 ──────────────────────────────────────────────────────────

/**
 * 判断字符串是否是非空的、可用作标识符的值。
 *
 * 用于读取外部数据时的边界校验。注意这**只**检查非空——
 * 不检查 UUID 格式，因为旧项目写入的 `conversation_id` 未必是 UUID，
 * 强行校验会让旧数据读不出来。
 */
export function isValidId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}
