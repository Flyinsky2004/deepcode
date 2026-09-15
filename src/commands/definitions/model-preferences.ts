/**
 * `/thinking`、`/reasoning`、`/effort`、`/1M` —— 主模型的能力与运行偏好开关。
 *
 * 四条命令在旧实现里都是 TUI 的 handler（`app.py:1868-2031`），作用对象是
 * **唯一主模型**（`get_primary_llm_model`）。本项目把它们下沉到命令层，
 * 作用对象是 `PRIMARY_TIER` 指向的那个 `ModelProfile`——语义等价
 * （"主循环实际会用的那个模型"），但三个客户端因此共用一份实现。
 *
 * ## 一、为什么这些命令以前是"诚实降级"
 *
 * 因为它们只改配置、**不产生任何行为变化**：`ModelProfile.thinkingEnabled` /
 * `reasoningEffort` 当时只被 TUI 状态栏读来显示（`clients/tui/status-bar.ts:118`），
 * `AgentRuntime` 构造 `ModelRequest` 时从不填 `thinking`。写一个没有消费者的开关
 * 就是"欺骗性的空操作"。现在 runtime 侧已消费（见 `thinkingConfigFor`），
 * 四条命令才成立。**顺序不能反**：先让配置有效，再开放写入口。
 *
 * ## 二、四条命令的语义（对齐旧实现，每条的出处见各自注释）
 *
 * | 命令 | 作用 | 落点 |
 * |---|---|---|
 * | `/thinking on\|off` | 开关思考 | `ModelProfile.thinkingEnabled` |
 * | `/reasoning <l\|m\|h>` | 设置思考强度 | `ModelProfile.reasoningEffort` |
 * | `/effort <l\|m\|h\|xhigh>` | `/thinking` + `/reasoning` 的**复合** | 两者 |
 * | `/1M` | 切换上下文窗口 | `ModelProfile.contextWindow` |
 *
 * ## 三、两处能力校验（旧实现没有，属新增）
 *
 * `/thinking on` 要求 `supportsThinking`，`/1M` 要求 `supports1MContext`。
 * `parts/09` §9.2 的原话是「若开启但模型不支持，必须在保存或选择时拒绝，
 * **不能静默降级**」。旧项目没有这两个字段，也就没有这条校验；本项目把它们
 * 显式化成能力声明，就必须在写入前用它——否则字段存在的唯一意义就没了。
 */

import { z } from 'zod'

import { ErrorCode } from '../../core/errors.js'
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_REASONING_EFFORT,
  isReasoningEffort,
  type ReasoningEffort,
} from '../../core/models.js'
import { THINKING_BUDGET_BY_EFFORT } from '../../core/provider.js'
import {
  CommandResultCode,
  PRIMARY_TIER,
  type CommandConfigView,
  type CommandDefinition,
  type CommandContext,
  type CommandResult,
} from '../types.js'

/**
 * 1M 上下文窗口的取值。
 *
 * 旧实现的双向切换就在这两个数之间（`app.py:2020`：
 * `125_000 if model.context_window >= 1_000_000 else 1_000_000`）。
 * 下界取 `DEFAULT_CONTEXT_WINDOW`，与 `config-store` 的归一化默认同源。
 */
const ONE_MILLION = 1_000_000

/**
 * `/effort` 的取值。
 *
 * 比 `/reasoning` 多一个 `xhigh`——旧实现的菜单就是这样
 * （`_get_effort_levels`, `app.py:192-199` vs `_get_reasoning_levels`, `app.py:184-190`）。
 * 而旧实现的落盘校验只认前三项，选 xhigh 会抛 `ValueError`
 * 且因为 `_set_effort` 没有 try/except 而**半写**配置。
 * 本实现把 `xhigh` 纳入合法集合（`REASONING_EFFORTS`），见 ADR 0004 D4。
 */
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh'] as const

/** `/reasoning` 的取值——**不含** `xhigh`，对齐旧菜单。 */
const REASONING_LEVELS = ['low', 'medium', 'high'] as const

/** 主模型在当前配置下的定位结果。 */
type PrimaryModel =
  | {
      readonly ok: true
      readonly tier: typeof PRIMARY_TIER
      readonly providerId: string
      readonly providerName: string
      readonly model: CommandConfigView['models'][number]
    }
  | { readonly ok: false; readonly reason: string }

/**
 * 找到主模型。
 *
 * 判据与 `ModelRouter.resolveCandidate` 一致（档位启用 + provider 在且启用 +
 * 模型在且启用），因为那才是"这个 turn 真的跑得起来"的条件。
 * 与 `/init` 的 `hasPrimaryModel` 是同一个判据的两个用法：那里只问"有没有"，
 * 这里还要拿到模型本身去读写它的偏好。
 */
function findPrimaryModel(config: CommandConfigView): PrimaryModel {
  const assignment = config.tiers.find((t) => t.tier === PRIMARY_TIER && t.enabled)
  if (!assignment) return { ok: false, reason: '未配置主模型' }
  const provider = config.providers.find((p) => p.id === assignment.providerId)
  if (provider === undefined || !provider.enabled)
    return { ok: false, reason: `provider ${assignment.providerId} 不存在或已禁用` }
  const model = config.models.find(
    (m) => m.providerId === assignment.providerId && m.id === assignment.modelId,
  )
  if (model === undefined || !model.enabled)
    return { ok: false, reason: `模型 ${assignment.modelId} 不存在或已禁用` }
  return {
    ok: true,
    tier: PRIMARY_TIER,
    providerId: provider.id,
    providerName: provider.name,
    model,
  }
}

/** 无主模型时的统一面板——给出可执行的下一步，而不是只说"失败"。 */
function noPrimaryModel(reason: string): CommandResult {
  return {
    ok: false,
    code: CommandResultCode.PANEL,
    text: `没有可用的主模型（${reason}）。请先使用 /api 添加模型，再使用 /model 选择。`,
    errorCode: ErrorCode.MODEL_NOT_FOUND,
    data: { kind: 'model_preference_panel', reason: 'no_primary_model' },
  }
}

/**
 * 当前思考预算：把偏好折算成实际会发出的 `budget_tokens`。
 *
 * 入参只取需要的两个字段，而不是整个 `ModelProfile`——命令视图里的模型条目
 * 是配置投影（没有 `supportsVision` 之类），硬套 `ModelProfile` 会逼着视图
 * 去补一堆它不需要的字段。
 */
function describeThinking(model: {
  readonly thinkingEnabled?: boolean
  readonly reasoningEffort?: string
}): string {
  if (model.thinkingEnabled !== true) return 'off'
  const effort = isReasoningEffort(model.reasoningEffort)
    ? model.reasoningEffort
    : DEFAULT_REASONING_EFFORT
  return `on（${effort}，预算 ${THINKING_BUDGET_BY_EFFORT[effort]}）`
}

/** 展示名统一为 `providerName/modelId`（parts/09 §9.1）。 */
function label(primary: { providerName: string; model: { id: string } }): string {
  return `${primary.providerName}/${primary.model.id}`
}

/**
 * 复用的入参解析：可选枚举。
 *
 * `undefined` = 没给参数 → **只读展示**，不写任何东西。
 * 旧实现里"不带参数的 `/thinking`"是弹一个选择面板（`_show_thinking_settings`
 * → `_set_selection`），本项目由 `code: SELECTION` + `data.items` 表达同一件事
 * （见 `commandViewOf`：UI 据此渲染成可点选的列表）。
 *
 * 空串按"没给"处理，与 `CommandRegistry.validateArgs` 对 `required` 的判据一致。
 */
function optionalLevel<T extends string>(
  ctx: CommandContext,
  name: string,
  allowed: readonly T[],
):
  | { readonly ok: true; readonly value: T | undefined }
  | { readonly ok: false; readonly text: string } {
  const raw = ctx.args[name]
  if (raw === undefined || raw === '') return { ok: true, value: undefined }
  if (typeof raw !== 'string' || !(allowed as readonly string[]).includes(raw))
    return { ok: false, text: `参数 ${name} 非法：只接受 ${allowed.join(' / ')}` }
  return { ok: true, value: raw as T }
}

/**
 * 构造一个"选择列表"式的结果（旧实现的 `_set_selection` 面板）。
 *
 * ⚠️ `items[].key` 必须是**可执行的完整命令原文**（`/thinking on`），
 * 而不是 `on` 这样的裸值。
 *
 * 理由在 TUI 侧：命令层不设 `data.context` 时，`contextFromData` 落到
 * `SelectionContext.MAIN`，而 `activateSelection` 对 MAIN 的处理是
 * **把 `item.key` 当命令原文执行**（`input.ts`）。旧 TUI 为这四个面板各建了
 * 一个专属语境（`thinking_toggle` / `reasoning_select` / `effort_select`）并写
 * 对应的 handler；本项目不复刻那套语境，改让选项**本身**就是那条后续命令——
 * 于是表现层一行都不用改，按键行为还天然与手打命令一致。
 *
 * 这条约定是隐式的（没有类型能强制），所以 `model-preferences.test.ts` 里有一条
 * 用例遍历所有选项、断言每个 key 都真的能被注册表执行。
 */
function selectionResult(input: {
  readonly kind: string
  readonly text: string
  readonly items: readonly { readonly key: string; readonly title: string }[]
  readonly extra?: Readonly<Record<string, unknown>>
}): CommandResult {
  return {
    ok: true,
    code: CommandResultCode.SELECTION,
    text: input.text,
    data: {
      kind: input.kind,
      items: input.items,
      ...(input.extra ?? {}),
    },
  }
}

// ── `/thinking` ──────────────────────────────────────────────────

/**
 * `/thinking [on|off]`（旧：`_show_thinking_settings` + `_toggle_thinking`,
 * `app.py:1868-1913`）。
 */
export function createThinkingCommand(): CommandDefinition {
  return {
    name: 'thinking',
    description: '开关思考',
    parameters: {
      positionals: [
        {
          name: 'state',
          required: false,
          description: 'on 或 off',
          schema: z.enum(['on', 'off']),
        },
      ],
    },
    interrupt: 'never',
    permission: { kind: 'local-principal' },
    auditEvent: 'command_received',
    idempotency: { kind: 'read-only' },
    persistResult: false,
    execute: async (ctx): Promise<CommandResult> => {
      const config = await ctx.host.readConfig()
      const primary = findPrimaryModel(config)
      if (!primary.ok) return noPrimaryModel(primary.reason)

      const requested = optionalLevel(ctx, 'state', ['on', 'off'] as const)
      if (!requested.ok)
        return {
          ok: false,
          code: CommandResultCode.INVALID_ARGUMENTS,
          text: requested.text,
          errorCode: ErrorCode.INVALID_COMMAND_ARGUMENTS,
        }

      if (requested.value === undefined)
        return selectionResult({
          kind: 'thinking_toggle',
          text: `${label(primary)}：思考当前为 ${describeThinking(primary.model)}`,
          items: [
            { key: '/thinking on', title: '开启思考' },
            { key: '/thinking off', title: '关闭思考' },
          ],
          extra: { tier: primary.tier },
        })

      const enabled = requested.value === 'on'

      // 能力校验（§9.2 的同源原则）：模型没声明支持思考时**拒绝**，
      // 而不是写进去一个永远不会生效的开关。
      if (enabled && !primary.model.supportsThinking)
        return capabilityFailure(`模型 ${primary.model.id} 未声明支持思考（supportsThinking）`)

      await ctx.host.updateModelPreferences(primary.tier, { thinkingEnabled: enabled })
      return {
        ok: true,
        code: CommandResultCode.OK,
        text: `${label(primary)}：思考已${enabled ? '开启' : '关闭'}`,
        data: { kind: 'set_thinking', tier: primary.tier, thinkingEnabled: enabled },
      }
    },
  }
}

// ── `/reasoning` ─────────────────────────────────────────────────

/** `/reasoning [low|medium|high]`（旧：`_show_reasoning_settings`, `app.py:1915-1954`）。 */
export function createReasoningCommand(): CommandDefinition {
  return {
    name: 'reasoning',
    description: '设置思考强度',
    parameters: {
      positionals: [
        {
          name: 'level',
          required: false,
          description: 'low / medium / high',
          schema: z.enum(REASONING_LEVELS),
        },
      ],
    },
    interrupt: 'never',
    permission: { kind: 'local-principal' },
    auditEvent: 'command_received',
    idempotency: { kind: 'read-only' },
    persistResult: false,
    execute: async (ctx): Promise<CommandResult> => {
      const config = await ctx.host.readConfig()
      const primary = findPrimaryModel(config)
      if (!primary.ok) return noPrimaryModel(primary.reason)

      const requested = optionalLevel(ctx, 'level', REASONING_LEVELS)
      if (!requested.ok)
        return {
          ok: false,
          code: CommandResultCode.INVALID_ARGUMENTS,
          text: requested.text,
          errorCode: ErrorCode.INVALID_COMMAND_ARGUMENTS,
        }

      if (requested.value === undefined)
        return selectionResult({
          kind: 'reasoning_select',
          text: `${label(primary)}：当前强度 ${
            isReasoningEffort(primary.model.reasoningEffort)
              ? primary.model.reasoningEffort
              : DEFAULT_REASONING_EFFORT
          }`,
          items: REASONING_LEVELS.map((level) => ({
            key: `/reasoning ${level}`,
            title: `${level}（预算 ${THINKING_BUDGET_BY_EFFORT[level]}）`,
          })),
          extra: { tier: primary.tier },
        })

      if (!primary.model.supportsThinking)
        return capabilityFailure(`模型 ${primary.model.id} 未声明支持思考（supportsThinking）`)

      // ⚠️ **必须同时打开思考**，否则这条命令是个空操作。
      //
      // `reasoningEffort` 的消费者只有一处：`thinkingConfigFor`，而它要求
      // `thinkingEnabled === true`（ADR 0004 D3 把缺省改成了关闭）。
      // 于是"只写 effort"会报出一句"强度已设为 high（预算 24000）"，
      // 而那个 24000 永远不会出现在任何请求里——正是本项目判定
      // "写没有消费者的开关比不写更坏"的那种情况。
      //
      // 打开思考也**更接近旧实现的实际行为**：旧 `thinking_enabled` 默认
      // `True`，所以旧项目里 `/reasoning` 一设就生效。D3 改了缺省值，
      // 这里是那个改动的必要补偿。
      //
      // `/effort low` 是唯一"只关思考"的入口，语义不冲突。
      return await writeReasoning(ctx, primary, requested.value, { thinkingEnabled: true })
    },
  }
}

// ── `/effort` ────────────────────────────────────────────────────

/**
 * `/effort [low|medium|high|xhigh]`（旧：`_show_effort_settings` + `_set_effort`,
 * `app.py:1956-2007`）。
 *
 * ⚠️ `low` 是**特例**：它只关思考，**不动** `reasoningEffort`。旧实现如此
 * （`_set_effort` 的 `if level == "low"` 分支只调 `set_model_thinking(enabled=False)`），
 * 本实现照抄——理由是 effort 只在思考开启时有意义，关掉思考却把强度改掉
 * 会让"再打开思考"时强度被无声重置。
 */
export function createEffortCommand(): CommandDefinition {
  return {
    name: 'effort',
    description: '设置思考档位',
    parameters: {
      positionals: [
        {
          name: 'level',
          required: false,
          description: 'low / medium / high / xhigh',
          schema: z.enum(EFFORT_LEVELS),
        },
      ],
    },
    interrupt: 'never',
    permission: { kind: 'local-principal' },
    auditEvent: 'command_received',
    idempotency: { kind: 'read-only' },
    persistResult: false,
    execute: async (ctx): Promise<CommandResult> => {
      const config = await ctx.host.readConfig()
      const primary = findPrimaryModel(config)
      if (!primary.ok) return noPrimaryModel(primary.reason)

      const requested = optionalLevel(ctx, 'level', EFFORT_LEVELS)
      if (!requested.ok)
        return {
          ok: false,
          code: CommandResultCode.INVALID_ARGUMENTS,
          text: requested.text,
          errorCode: ErrorCode.INVALID_COMMAND_ARGUMENTS,
        }

      if (requested.value === undefined)
        return selectionResult({
          kind: 'effort_select',
          text: `${label(primary)}：当前 ${describeThinking(primary.model)}`,
          items: EFFORT_LEVELS.map((level) => ({
            key: `/effort ${level}`,
            title:
              level === 'low'
                ? 'low（关闭思考）'
                : `${level}（预算 ${THINKING_BUDGET_BY_EFFORT[level]}）`,
          })),
          extra: { tier: primary.tier },
        })

      if (requested.value === 'low') {
        // 与旧实现一致：只关思考，effort 保持不变。
        await ctx.host.updateModelPreferences(primary.tier, { thinkingEnabled: false })
        return {
          ok: true,
          code: CommandResultCode.OK,
          text: `${label(primary)}：思考已关闭（强度保持不变）`,
          data: { kind: 'set_effort', tier: primary.tier, level: 'low', thinkingEnabled: false },
        }
      }

      if (!primary.model.supportsThinking)
        return capabilityFailure(`模型 ${primary.model.id} 未声明支持思考（supportsThinking）`)

      // **先校验再写入**（ADR 0004 D4）：旧实现在这里分两次写，第二次校验失败
      // 已经把 thinking 打开了，配置停在半途中。这里把两个字段合成一次写。
      return await writeReasoning(ctx, primary, requested.value, { thinkingEnabled: true })
    },
  }
}

// ── `/1M` ────────────────────────────────────────────────────────

/** `/1M`（旧：`_toggle_context_mode`, `app.py:2009-2031`）。 */
export function createContextModeCommand(): CommandDefinition {
  return {
    name: '1M',
    description: '切换 1M 上下文',
    parameters: { positionals: [] },
    interrupt: 'never',
    permission: { kind: 'local-principal' },
    auditEvent: 'command_received',
    // ⚠️ **必须**带幂等键，与另外三条偏好命令不同。
    //
    // 那三条是"设置成某个值"：重复执行收敛到同一个状态，重放与重跑等价。
    // `/1M` 是**开关**——重跑一次就切回去了。而这在界面上完全看不出来
    // （两次响应都报"已设为 XX"，只是第二次报了另一个值）。
    //
    // 注意它覆盖的是**带幂等键的调用方**：Web 的 `POST /api/commands` 强制要求
    // `Idempotency-Key` 头，所以浏览器重发/网络层重试都被挡住；TUI 目前不传
    // 幂等键（`controller.ts` 的 `runCommand`），也**不会**自动重试输入过的命令，
    // 所以那条路径无风险——但若将来给 TUI 加重试，必须同时补上幂等键，
    // 否则这里就只剩一半的保护。
    idempotency: { kind: 'keyed', ttlMs: 60_000 },
    persistResult: false,
    execute: async (ctx): Promise<CommandResult> => {
      const config = await ctx.host.readConfig()
      const primary = findPrimaryModel(config)
      if (!primary.ok) return noPrimaryModel(primary.reason)

      const current = primary.model.contextWindow
      // 双向切换，与旧实现同一判据（`>= 1_000_000` 即视为 1M 态）。
      const next = current >= ONE_MILLION ? DEFAULT_CONTEXT_WINDOW : ONE_MILLION

      // §9.2：开启 1M 而模型没声明支持 → **拒绝**，不静默降级到 125K。
      // 「关闭」方向永远允许：回到标准窗口不需要任何能力。
      if (next === ONE_MILLION && !primary.model.supports1MContext)
        return capabilityFailure(
          `模型 ${primary.model.id} 未声明支持 1M 上下文（supports1MContext）`,
        )

      await ctx.host.setModelContextWindow(primary.tier, next)
      const label1M = next === ONE_MILLION ? '1M' : '125K'
      return {
        ok: true,
        code: CommandResultCode.OK,
        text: `${label(primary)}：上下文窗口已设为 ${label1M}`,
        data: {
          kind: 'set_context_window',
          tier: primary.tier,
          contextWindow: next,
          label: label1M,
        },
      }
    },
  }
}

// ── 共用 ──────────────────────────────────────────────────────────

/** 写 `reasoningEffort`（必要时一并写 `thinkingEnabled`），并回显生效值。 */
async function writeReasoning(
  ctx: CommandContext,
  primary: Extract<PrimaryModel, { ok: true }>,
  level: ReasoningEffort,
  patch: { readonly thinkingEnabled?: boolean } = {},
): Promise<CommandResult> {
  await ctx.host.updateModelPreferences(primary.tier, { reasoningEffort: level, ...patch })
  return {
    ok: true,
    code: CommandResultCode.OK,
    text: `${label(primary)}：强度已设为 ${level}（预算 ${THINKING_BUDGET_BY_EFFORT[level]}）`,
    data: { kind: 'set_reasoning', tier: primary.tier, reasoningEffort: level, ...patch },
  }
}

/** 能力不足 → `MODEL_CAPABILITY_UNAVAILABLE`，文案说明是"模型没声明"而不是"命令错了"。 */
function capabilityFailure(message: string): CommandResult {
  return {
    ok: false,
    code: CommandResultCode.INVALID_ARGUMENTS,
    text: message,
    errorCode: ErrorCode.MODEL_CAPABILITY_UNAVAILABLE,
    data: { reason: 'capability' },
  }
}
