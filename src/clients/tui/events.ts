/**
 * 事件 → UI 状态的归约（`app.py:486-537` 的 `_handle_turn_event`）。
 *
 * ## 三条容易搞错的地方
 *
 * 1. **`thinking` 与 `tool_use` 被显式忽略**（旧实现就是 `pass`）。流式阶段
 *    它们只有进度意义；历史重绘时消息从**存储**读出完整 content block 再渲染，
 *    在这里渲染增量会造成同一条内容出现两次。
 * 2. **`error` 也是终止信号**。只等 `turn_end` 的 UI 在失败路径上会永久挂住
 *    （`src/core/turn.ts` 的 `isTerminalEvent` 已把它纳入）。重提排队 prompt
 *    的逻辑与 `turn_end(cancelled)` 共用。
 * 3. **消息区不在这里累加**。`turn_end` 之后发一条 `render-history` 效果去读盘，
 *    而不是把流式文本"扶正"成消息——真相源是存储。
 */

import type { RuntimeEventEnvelope } from '../../core/events.js'
import type { AskUserQuestion } from '../../core/input.js'
import { RuntimeEventType } from '../../core/turn.js'

import type { RiskLevel } from '../../core/tool.js'

import { TKey } from './i18n/keys.js'
import { translate } from './i18n/index.js'
import {
  SelectionContext,
  MODE_NAMES,
  type ModeIndex,
  type Questionnaire,
  type TuiState,
} from './types.js'
import type { TuiEffect, PendingPermission } from './types.js'

/**
 * 风险徽标（4 档，ADR 0002 §七）。
 *
 * 旧实现只有 3 档（`app.py:1246`），未识别的等级走 `risk_level.upper()`。
 * 这里补齐 `critical`，并**保留 upper() 兜底**——事件里的 risk_level 是裸字符串，
 * 未来新增档位时界面不该显示空白。
 */
export function riskBadge(riskLevel: string, language: TuiState['language']): string {
  const keys: Readonly<Record<string, string>> = {
    low: TKey.RISK_LOW,
    medium: TKey.RISK_MEDIUM,
    high: TKey.RISK_HIGH,
    critical: TKey.RISK_CRITICAL,
  }
  const key = keys[riskLevel]
  return key === undefined ? riskLevel.toUpperCase() : translate(language, key)
}

/** 归约结果。 */
export interface EventResult {
  readonly state: TuiState
  readonly effects: readonly TuiEffect[]
}

function result(state: TuiState, effects: readonly TuiEffect[] = []): EventResult {
  return { state, effects }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** 流式 token 粗估：`max(1, len(text) // 4)`。 */
export function estimateStreamingTokens(text: string): number {
  return Math.max(1, Math.floor(text.length / 4))
}

/** 模式字符串 → 序号。未知字符串返回 `undefined`（不改模式）。 */
export function modeIndexFromName(name: string): ModeIndex | undefined {
  const index = MODE_NAMES.indexOf(name)
  if (index < 0 || index > 3) return undefined
  return index as ModeIndex
}

/**
 * `permission_required` / `user_input_required` 的入队。
 *
 * T-2（修正）：队列而不是单槽位。
 */
export function enqueuePermission(state: TuiState, event: RuntimeEventEnvelope): TuiState {
  const data = asRecord(event.data)
  const permission: PendingPermission = {
    requestId: asString(data['request_id']),
    toolName: asString(data['tool_name'], 'unknown'),
    // 事件的 risk_level 是裸字符串；4 档取值见 `RiskLevel`（ADR 0002 §七）。
    riskLevel: asString(data['risk_level'], 'medium') as RiskLevel,
    argsPreview: asString(data['args_preview']),
    reason: asString(data['reason']),
    expiresAt: asNumber(data['expires_at']),
  }
  // 同一 request_id 重复入队（重连补发）不产生第二条。
  if (state.permissionQueue.some((pending) => pending.requestId === permission.requestId))
    return state
  return {
    ...state,
    permissionQueue: [...state.permissionQueue, permission],
    // 输入框 label/placeholder 切到审批文案（`_show_permission_request` 末尾的
    // `_set_input_prompt(PERM_LABEL, PERM_PLACEHOLDER)`）。
    inputPrompt: { kind: 'permission' },
    // ⚠️ 审批说明**不进状态**：它完全由 `permissionQueue[0]` 决定，视图直接
    // 渲染（`app.tsx` 的 `MessageView`）。存成 `notice` 是不行的——旧实现里
    // 提示是在 `_render_history_with_hint` 里**先重绘历史、再追加**，
    // 而本实现的事件归约是同一次提交里既写状态又发 `render-history` 效果，
    // 后跑的重绘会把提示清掉（实测踩到过）。
    // 三个动作项渲染进 `#command-menu`（`target_menu=True`）。
    selection: {
      context: SelectionContext.PERMISSION_REQUEST,
      title: translate(state.language, TKey.PERM_ACTION_TITLE),
      header: '',
      footer: translate(state.language, TKey.PERM_ACTION_FOOTER),
      items: [
        {
          key: 'approve',
          title: translate(state.language, TKey.PERM_APPROVE),
          description: '',
        },
        {
          key: 'always_approve',
          title: translate(state.language, TKey.PERM_ALWAYS_APPROVE),
          description: '',
        },
        { key: 'deny', title: translate(state.language, TKey.PERM_DENY), description: '' },
      ],
      // ⚠️ 默认高亮第 1 项（approve）。设计文档建议"默认焦点在 Deny"，
      // **旧实现没有这么做**（`_set_selection` 总是把 selected_index 置 0），
      // 这里保持旧行为。
      selectedIndex: 0,
    },
  }
}

/** 审批说明文本（`PERM_TITLE` 模板的实参填充）。 */
export function permissionHintText(
  permission: PendingPermission,
  language: TuiState['language'],
): string {
  return translate(language, TKey.PERM_TITLE, {
    tool: permission.toolName,
    risk: riskBadge(permission.riskLevel, language),
    args: permission.argsPreview,
    reason: permission.reason,
  })
}

/** 构造问卷状态（T-10：光标是正式字段，每次新问卷重置）。 */
export function createQuestionnaire(
  requestId: string,
  questions: readonly AskUserQuestion[],
): Questionnaire {
  return {
    requestId,
    questions,
    currentQuestion: 0,
    answers: {},
    multiCursorLabel: undefined,
  }
}

/**
 * 单条事件的归约。
 *
 * 未知事件类型一律**原样返回**：`EventBus.subscribe` 会把命令审计等
 * 非 runtime 事件也推过来，UI 不该因为不认识就报错。
 */
export function applyEvent(state: TuiState, event: RuntimeEventEnvelope): EventResult {
  const data = asRecord(event.data)

  switch (event.type) {
    // ── turn_start：清空流式累积 + 清空待办 + 隐藏首页（`app.py:493`）──
    case RuntimeEventType.TURN_START:
      return result({
        ...state,
        streamingText: '',
        lastStreamRenderAt: 0,
        streamingTokens: 0,
        todos: [],
        todoVisible: false,
        emptyStateVisible: false,
        panel: undefined,
        notice: undefined,
        // 新的一轮开始，上一轮的错误提示到此为止。
        lastError: undefined,
      })

    // ── thinking / tool_use：**显式忽略**（§8.4）──
    case RuntimeEventType.THINKING:
    case RuntimeEventType.TOOL_USE:
      return result(state)

    // ── text：累积 + 粗估 token + 重绘（50ms 节流在渲染层）──
    case RuntimeEventType.TEXT: {
      const streamingText = state.streamingText + asString(data['content'])
      return result({
        ...state,
        streamingText,
        streamingTokens: estimateStreamingTokens(streamingText),
        streaming: true,
      })
    }

    // ── tool_result：只有 todo_write 会刷新待办面板 ──
    case RuntimeEventType.TOOL_RESULT: {
      if (asString(data['name']) !== 'todo_write') return result(state)
      return result(state, [{ kind: 'refresh-todos' }])
    }

    // ── skill_resolved：重绘历史 + 状态栏 ──
    case RuntimeEventType.SKILL_RESOLVED:
      return result(state, [{ kind: 'render-history' }])

    // ── compact_start / compact_end：切换状态栏分支 ──
    case RuntimeEventType.COMPACT_START:
      return result({ ...state, compacting: true })
    case RuntimeEventType.COMPACT_END:
      return result({ ...state, compacting: false })

    // ── auto_continue：本实现不发射（ADR 0002 §3 的连带后果），
    //    保留分支是为了事件契约完整时不必回来改 UI。
    case RuntimeEventType.AUTO_CONTINUE:
      return result(state)

    // ── permission_required ──
    case RuntimeEventType.PERMISSION_REQUIRED: {
      const next = enqueuePermission(state, event)
      return result(next, [{ kind: 'render-history' }])
    }

    // ── permission_resolved：**其他客户端或超时**解决的，收起本地对话框 ──
    //
    // 旧实现没有这个事件（决议只能来自本进程的 UI）。有了 broker 之后，
    // Web UI 或 120 秒超时都会让请求结束，本地若还挂着对话框，用户点下去
    // 只会得到 `duplicate` 或 `ok: false`——所以这里必须收起。
    case 'permission_resolved': {
      const requestId = asString(data['request_id'])
      return result({
        ...state,
        permissionQueue: state.permissionQueue.filter((pending) => pending.requestId !== requestId),
      })
    }

    // ── user_input_required：空问题列表立即作答（`{"_empty": True}`）──
    case RuntimeEventType.USER_INPUT_REQUIRED: {
      const requestId = asString(data['request_id'])
      const questions = Array.isArray(data['questions'])
        ? (data['questions'] as readonly AskUserQuestion[])
        : []
      if (questions.length === 0) {
        return result(state, [
          {
            kind: 'answer-user-input',
            requestId,
            answers: [],
            reason: 'empty',
          },
        ])
      }
      return result({ ...state, questionnaire: createQuestionnaire(requestId, questions) })
    }

    case 'user_input_resolved': {
      const requestId = asString(data['request_id'])
      if (state.questionnaire?.requestId !== requestId) return result(state)
      return result({ ...state, questionnaire: undefined })
    }

    // ─ turn_end：记账 + 停止流式 + 重绘历史 ──
    case RuntimeEventType.TURN_END: {
      const cancelled = data['cancelled'] === true
      const next: TuiState = {
        ...state,
        lastInputTokens: asNumber(data['input_tokens']),
        totalOutputTokens: state.totalOutputTokens + asNumber(data['output_tokens']),
        streaming: false,
        streamingText: '',
        streamingTokens: 0,
        lastStreamRenderAt: 0,
        // 权限/问卷在 turn 结束时必须收起：它们的等待方已经随 turn 一起结束。
        //
        // ⚠️ 只清队列是不够的——审批的**动作菜单与输入框文案**也要一起收起，
        // 否则界面上会留一个点不动的死对话框（`selection` 还在、队列已空，
        // 按 Enter 什么也不会发生）。旧实现在这里会留下悬空的对话框
        // （`parts/05` §7.4："PENDING + 会话取消 → 无转移"），本实现由 broker
        // 在取消时给出决议，因此不留残影是安全的。
        permissionQueue: [],
        selection:
          state.selection?.context === SelectionContext.PERMISSION_REQUEST
            ? undefined
            : state.selection,
        inputPrompt:
          state.inputPrompt.kind === 'permission' ? { kind: 'default' } : state.inputPrompt,
        questionnaire: undefined,
      }
      const effects: TuiEffect[] = [{ kind: 'render-history' }]

      // 取消后自动重提排队的那条（`app.py:525-527`）。
      if (cancelled && state.pendingPrompt !== undefined) {
        effects.push({ kind: 'submit-prompt', prompt: state.pendingPrompt })
        return result({ ...next, pendingPrompt: undefined }, effects)
      }
      return result(next, effects)
    }

    // ── error：终止信号（可能没有 turn_end 伴随）──
    case RuntimeEventType.ERROR: {
      const message = asString(data['message'])
      const next: TuiState = {
        ...state,
        streaming: false,
        streamingText: '',
        streamingTokens: 0,
        lastStreamRenderAt: 0,
        lastError: message,
      }
      const effects: TuiEffect[] = [{ kind: 'render-history' }]
      if (state.pendingPrompt !== undefined) {
        effects.push({ kind: 'submit-prompt', prompt: state.pendingPrompt })
        return result({ ...next, pendingPrompt: undefined }, effects)
      }
      return result(next, effects)
    }

    // ── mode.change：**权限模式切换的表现层一半**（T-6）──
    //
    // 旧项目的 `enter_plan_mode` 工具只写 `turn_state["plan_mode"]` 并 emit
    // `mode.change`（`tools/plan_tools.py:109-110`），真正把界面切到 plan 的
    // 那一半在表现层——而旧 `app.py` **没有实现它**，于是工具回话说
    // "已进入计划模式"，界面却仍是 NORMAL。
    //
    // 本实现的强制点仍在 runtime：`DefaultPermissionEngine` 读的是
    // `AgentRuntimeOptions.mode`（构造期固定），UI 改不了它，这是有意的分层
    // （UI 不得直接改权限状态）。所以这里做的是**表现层该做的那一半**：
    // 跟随事件切换模式显示，使状态栏与后续 `shift+tab` 的循环起点一致。
    case 'mode.change': {
      const index = modeIndexFromName(asString(data['mode']))
      return index === undefined ? result(state) : result({ ...state, mode: index })
    }

    default:
      return result(state)
  }
}
