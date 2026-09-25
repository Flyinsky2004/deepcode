/**
 * 模型接入契约。
 *
 * ## 只支持 Anthropic Messages API
 *
 * `parts/09` §9.1 的硬性约束：「新实现只实现一种线上协议」。**供应商不是协议类型，
 * 而是一个 Anthropic-compatible endpoint**——需要兼容其它模型时，由供应商负责
 * 提供 Anthropic 格式转换。
 *
 * 因此本文件里**不会**出现 OpenAI Chat Completions / Responses 的任何形状，
 * 也不会有供应商专属分支。旧实现里的 `reasoning` 事件（OpenAI 专有的思考载体）
 * 与 `provider_type` 分派逻辑都不迁移。
 *
 * ## 关于 `incomplete_tool_call`
 *
 * 旧实现有一个 `incomplete_tool_call` 事件（工具调用 JSON 被流式截断），
 * 用于触发"续跑一次"的恢复路径。它只在 OpenAI 兼容分支产生。Anthropic 的
 * 工具调用以完整 content block 为单位下发，不存在这个中间态。
 *
 * 结论：**不迁移该事件**，相应地也不迁移 `incomplete_tool_call_limit_reached`
 * 这条终止原因。这是去掉 OpenAI 支持的直接后果，属有意为之——保留一个
 * 永远不触发的恢复路径只会增加状态机复杂度而不带来任何能力。
 */

import { DEFAULT_REASONING_EFFORT, isReasoningEffort, type ReasoningEffort } from './models.js'
import { type ToolDescriptor } from './tool.js'

// ── 模型与供应商配置 ──────────────────────────────────────────────

/**
 * 供应商。
 *
 * `apiKeyRef` 默认保存外部引用；`source: 'value'` 是用户显式选择的本地明文模式。
 * 无论来源如何，密钥都不得进入日志、事件、导出文件、URL、前端响应或 `chat.json`。
 */
export interface Provider {
  /** 稳定 UUID。**不使用名称作为主键**——名称可改，ID 不可变。 */
  readonly id: string
  /** 用户可读名称。展示名有空格时用引号或 canonical slug 引用。 */
  readonly name: string
  /** Anthropic API 根地址。客户端在其上拼接 `/v1/messages`。 */
  readonly baseUrl: string
  /** 密钥引用，不是密钥本身。 */
  readonly apiKeyRef: SecretRef
  readonly createdAt: string
  readonly updatedAt: string
}

/**
 * 密钥引用。
 *
 * `env` / `keychain` / `file` 让配置可安全导出；`value` 会把明文直接写入
 * `config.json`，仅供用户明确接受本地磁盘风险时使用。
 */
export interface SecretRef {
  /** 取密钥的来源。 */
  readonly source: 'env' | 'keychain' | 'file' | 'value'
  /** 来源内的定位符；`value` 模式下这里就是明文密钥。 */
  readonly key: string
}

/**
 * 一个 provider 下的具体模型。
 *
 * 能力是**声明**而非猜测：`supportsTools` 为假的模型不能用于实现类档位，
 * 路由时必须据此校验（parts/09 §9.4）。
 */
export interface ModelProfile {
  /** provider 内的模型标识，如 `claude-sonnet-5`。 */
  readonly id: string
  readonly providerId: string
  /** 展示名。统一呈现为 `providerName/modelId`，同名模型也靠 provider 前缀区分。 */
  readonly displayName?: string
  readonly contextWindow: number
  readonly maxOutputTokens: number
  readonly supportsThinking: boolean
  readonly supportsTools: boolean
  readonly supportsVision: boolean
  /**
   * 是否支持 1M 上下文。
   *
   * ⚠️ 这是**能力声明，不是 UI 开关**。只有 endpoint、模型、账户权限与 API 版本
   * 全部确认支持时才可为真。若用户开启而模型不支持，必须**在保存或选择时拒绝**，
   * 不能静默降级（parts/09 §9.2）。
   */
  readonly supports1MContext: boolean
  readonly inputCostPerMillion?: number
  readonly outputCostPerMillion?: number
  readonly enabled: boolean
  /**
   * 是否启用思考（运行偏好，**不是能力声明**）。
   *
   * 与 `supportsThinking` 的区别是本节最容易混的地方：
   * `supportsThinking` 是"这个模型能不能思考"，由供应商与端点决定，
   * 用户不能改；`thinkingEnabled` 是"这次要不要让它思考"，用户可以开关。
   * `parts/09` §9.2 禁止把能力当开关写（不支持时不得静默降级），
   * 所以两者必须分开存。
   */
  readonly thinkingEnabled?: boolean
  /** 思考强度偏好。折算为 `thinking.budgetTokens` 时受 `maxOutputTokens` 约束。 */
  readonly reasoningEffort?: string
}

/** 模型与供应商的组合引用。用于 turn 快照与审计。 */
export interface ModelRef {
  readonly providerId: string
  readonly modelId: string
}

// ── 请求 ──────────────────────────────────────────────────────────

/**
 * 一次模型调用的请求。
 *
 * 只包含 Anthropic Messages API 的字段。**刻意的缺席**：`temperature`、`top_p`、
 * `top_k`、`stop_sequences`、`metadata`、`tool_choice`——旧实现从不发送它们，
 * 本实现也不发，避免引入旧行为里不存在的采样控制。
 */
export interface ModelRequest {
  readonly model: string
  readonly maxTokens: number
  /**
   * 对话消息。
   *
   * 与 Anthropic 的 `messages` 一致：system 提示**不在**这里，而在 `system` 字段。
   */
  readonly messages: readonly ApiMessage[]
  /** 系统提示。组装后的完整文本。 */
  readonly system?: string
  /** 工具声明。为空或省略时不发送 `tools` 字段。 */
  readonly tools?: readonly ToolDescriptor[]
  /**
   * 思考配置。
   *
   * ⚠️ `budgetTokens` 是**官方 Anthropic 的必填项**，且要求
   * `maxTokens > budgetTokens`。旧实现从不发送它（因为主要面向不校验该字段的
   * 兼容端点），直接对接官方 API 会失败。本实现要求显式提供。
   */
  readonly thinking?: ThinkingConfig
}

/** 思考配置。 */
export interface ThinkingConfig {
  readonly type: 'enabled'
  /** 思考预算 token 数。必须小于 `maxTokens`。 */
  readonly budgetTokens: number
}

/**
 * 推理强度 → 思考预算的折算表。
 *
 * ⚠️ **这是新增协议，没有旧实现可转录**。旧项目的 Anthropic 请求体里
 * `thinking` 只有 `{"type": "enabled"}` 一个键（`api_client.py:383`），从不发
 * `budget_tokens`；`reasoning_effort` 字段只有 OpenAI 分支读（`parts/03` §2.1）。
 * 而官方 Anthropic 要求 `budget_tokens` 必填且 `max_tokens > budget_tokens`
 * ——`parts/03` 因此明确要求「对接官方 Anthropic API 时必须补 `budget_tokens`，
 * 复刻时请把这个差异显式标注」。
 *
 * 取值贴近官方常见区间（官方上限 64k），是**策略选择**而非转录结果；
 * 依据与取舍见 `docs/adr/0004-thinking-effort-and-model-commands.md`。
 */
export const THINKING_BUDGET_BY_EFFORT: Readonly<Record<ReasoningEffort, number>> = {
  low: 4_000,
  medium: 12_000,
  high: 24_000,
  /**
   * `/effort` 的第四档（旧 `/reasoning` 菜单里没有它）。
   *
   * 同样取 48k：官方上限附近，但仍留出足够输出空间。
   */
  xhigh: 48_000,
}

/**
 * 为思考预留的最小输出空间。
 *
 * Anthropic 要求 `max_tokens > budget_tokens`——思考预算不能把输出额度吃光，
 * 否则模型思考完就没有配额说话了。折算时从这个余量往下压预算。
 */
export const THINKING_MIN_OUTPUT_RESERVE = 1_024

/**
 * `budget_tokens` 的**官方下限**。
 *
 * 官方文档写的是两条约束，不是一条：**最小 1024**，且必须小于 `max_tokens`
 * （「Minimum of 1,024 tokens. The API rejects smaller values.」）。
 *
 * ⚠️ 早先这里只保证了后者（下界取 1）。后果是 `maxOutputTokens` 在
 * 1025..2047 之间的模型会发出 `budget_tokens: 1000` 之类的值——**必然被
 * endpoint 拒绝**，而这恰恰是 D1 要修的那件事（旧实现因为不发 budget_tokens
 * 而对接不上官方 API）。压低到一个必然被拒的值，等于把"缺字段"换成"字段非法"。
 *
 * 压不到这个下限时**不发** `thinking`（返回 `undefined`），而不是发一个非法值：
 * 与 §9.2「不能静默降级」同源——宁可让这一轮没有思考，也不发一个 400。
 */
export const THINKING_MIN_BUDGET_TOKENS = 1_024

/**
 * 把一个 `ModelProfile` 的运行偏好折算成请求里的 `thinking` 字段。
 *
 * 返回 `undefined` 表示**不发** `thinking` 字段，三种情形：
 *
 * 1. `thinkingEnabled !== true`——缺省即关闭（见 ADR 0004 D3）。
 *    这里与旧实现的 `thinking_enabled` 默认 `True` **有意不同**：本项目
 *    `supportsThinking` 的缺省是 `false`，沿用旧默认会让默认配置发出模型
 *    根本没声明的能力请求；TUI 状态栏也一直把缺省渲染成 OFF。
 * 2. `maxTokens` 不是有限正数——配置被手改坏时（`asNum` 只校验
 *    `Number.isFinite`，见 `config-store.ts`）不能把 `NaN` 传出去。
 * 3. 折算出的预算压不到官方下限 `THINKING_MIN_BUDGET_TOKENS`——
 *    `maxOutputTokens` 太小时无解，见该常量的说明。
 *
 * 成功时保证 `THINKING_MIN_BUDGET_TOKENS <= budgetTokens < maxTokens`
 * 且 `budgetTokens` 为整数——两条都是 endpoint 的硬性要求。
 *
 * 纯函数、无 IO，runtime 与命令层共用，避免两处各算一遍而漂移。
 */
export function thinkingConfigFor(
  profile: Pick<ModelProfile, 'thinkingEnabled' | 'reasoningEffort'>,
  maxTokens: number,
): ThinkingConfig | undefined {
  if (profile.thinkingEnabled !== true) return undefined
  if (!Number.isFinite(maxTokens)) return undefined
  // 取整：`maxOutputTokens` 只由 `upsertModelProfile` 保证是安全整数，
  // 而外部手改 `config.json` 或旧数据仍可能含小数，归一化不会拦它。
  const budgetable = Math.floor(maxTokens)
  if (budgetable <= 0) return undefined

  const effort = isReasoningEffort(profile.reasoningEffort)
    ? profile.reasoningEffort
    : DEFAULT_REASONING_EFFORT
  const desired = THINKING_BUDGET_BY_EFFORT[effort]

  // 余量取 `clamp(⌊maxTokens/2⌋, 1, 1024)`：`maxTokens` 小（<2048）时余量按比例
  // 收缩，别把窗口吃光；下界 1 保证 `budgetTokens < maxTokens` 严格成立
  //（少了它 `maxTokens = 1` 会算出 `budgetTokens = 1`，恰好让
  // `maxTokens > budgetTokens` 不成立，到发请求时才炸）。
  const reserve = Math.max(1, Math.min(THINKING_MIN_OUTPUT_RESERVE, Math.floor(budgetable / 2)))
  const budgetTokens = Math.min(desired, budgetable - reserve)
  return budgetTokens >= THINKING_MIN_BUDGET_TOKENS ? { type: 'enabled', budgetTokens } : undefined
}

/**
 * 一条 provider 消息。
 *
 * `content` 可以是字符串（纯文本）或 content block 数组。工具结果以
 * `tool_result` 块的形式出现在 `user` 消息里——这是 Anthropic 的协议约定：
 * 工具结果由"用户"回传。
 */
export interface ApiMessage {
  readonly role: 'user' | 'assistant'
  readonly content: string | readonly ApiContentBlock[]
}

/** provider 消息里的 content block。 */
export type ApiContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'thinking'
      readonly thinking: string
      readonly signature: string
    }
  | {
      readonly type: 'tool_use'
      readonly id: string
      readonly name: string
      readonly input: Readonly<Record<string, unknown>>
    }
  | {
      readonly type: 'tool_result'
      readonly tool_use_id: string
      readonly content: string
      readonly is_error?: boolean
    }

// ── 流式事件 ──────────────────────────────────────────────────────

/**
 * provider 流式事件的类型。
 *
 * ⚠️ **只有 4 种**。旧实现有 5 种，其中 `reasoning`（OpenAI 专有）与
 * `incomplete_tool_call` 已随"只支持 Anthropic"而移除。
 *
 * 同样**刻意缺席**的（旧实现也没有，不要凭空增加）：
 * - 没有 `start` / `stop` / `done` 事件
 * - **没有 `usage` 事件**——用量通过 `StreamResult.usage` 单独返回
 * - **没有 `error` 事件**——错误以异常抛出（见 `ProviderStreamError`）
 * - 没有 `stop_reason` 事件
 */
export const ModelEventType = {
  /** 思考内容。**一次性给出完整文本**，不是增量。 */
  THINKING: 'thinking',
  /** 文本增量。**每个事件是一小段**，调用方需自行累积。 */
  TEXT: 'text',
  /** 工具调用。`input` 已是解析后的对象，不是 JSON 字符串。 */
  TOOL_USE: 'tool_use',
} as const

/** provider 流式事件类型。 */
export type ModelEventType = (typeof ModelEventType)[keyof typeof ModelEventType]

/** 思考事件。 */
export interface ThinkingModelEvent {
  readonly type: typeof ModelEventType.THINKING
  readonly thinking: string
  /** 完整性签名，必须原样回传。无签名时为空串。 */
  readonly signature: string
}

/** 文本增量事件。 */
export interface TextModelEvent {
  readonly type: typeof ModelEventType.TEXT
  /** 本轮增量。空串是合法值（Anthropic 会下发空 delta）。 */
  readonly content: string
}

/** 工具调用事件。 */
export interface ToolUseModelEvent {
  readonly type: typeof ModelEventType.TOOL_USE
  readonly id: string
  readonly name: string
  readonly input: Readonly<Record<string, unknown>>
}

/** 全部 provider 流式事件。 */
export type ModelEvent = ThinkingModelEvent | TextModelEvent | ToolUseModelEvent

/**
 * 流式调用结束后的用量统计。
 *
 * 作为**独立返回值**而非事件——这是刻意的：用量是"整个流的属性"，
 * 不是流中的一个时间点。旧实现用一个可变的 out-param 字典传出，
 * 那种做法在并发或异常路径下容易丢掉数据。
 */
export interface TokenUsage {
  /** 最近一次请求的输入 token。 */
  readonly inputTokens: number
  /** 本次响应产出的 token。 */
  readonly outputTokens: number
}

// ── 核心接口 ──────────────────────────────────────────────────────

/**
 * 模型供应商客户端。
 *
 * 这是内核与具体模型 SDK 之间**唯一**的接触面。实现它即可接入新供应商，
 * 而 Agent 主循环、工具、权限、压缩全部无需改动
 * （progess.md 设计约束 1：内核不得依赖具体模型 SDK）。
 *
 * 每个异步边界都接收 `AbortSignal`（parts/09 §2），取消必须主动中断流。
 */
export interface ModelProvider {
  /**
   * 发起一次流式补全。
   *
   * 返回 `AsyncIterable` 而非 `AsyncGenerator`：实现方可以用任何方式产出事件，
   * 调用方只要求可 `for await`。
   *
   * ⚠️ 错误以**异常**抛出，不通过事件流传递。调用方用 `try/catch` 捕获，
   * 并用 `toAgentError()` 归一化为结构化错误码。
   */
  stream(request: ModelRequest, signal: AbortSignal): ModelStream

  /**
   * 探测连接与鉴权。
   *
   * parts/09 §9.1 要求：连接测试必须验证**鉴权、流式响应、tool use 和 usage**，
   * 而不是只发一个普通文本请求——否则会在真正用到工具时才暴露问题。
   */
  probe(signal: AbortSignal): Promise<ProviderProbeResult>
}

/** Stream plus usage metadata captured when iteration completes. */
export interface ModelStream extends AsyncIterable<ModelEvent> {
  readonly usage?: TokenUsage
}

/** 连接探测结果。 */
export interface ProviderProbeResult {
  readonly ok: boolean
  /** 失败时的结构化错误码。 */
  readonly errorCode?: string
  readonly message?: string
  /** 逐项能力探测结果。 */
  readonly capabilities?: {
    readonly streaming: boolean
    readonly tools: boolean
    readonly thinking: boolean
    readonly usage: boolean
  }
}

// ── 档位与路由 ────────────────────────────────────────────────────

/**
 * 工作场景档位。
 *
 * 档位只是**策略名称**。代码里不得把任何档位绑定到具体模型品牌
 * （parts/09 §9.3）——用户为档位挑选模型。
 */
export const ModelTier = {
  /** 读代码、搜索、收集事实。倾向低成本低延迟。 */
  EXPLORATION: 'exploration',
  /** 分析约束、拆解任务、风险判断。倾向高能力、允许思考。 */
  PLANNING: 'planning',
  /** 改代码、调工具、跑验证。倾向中高能力、工具调用稳定。 */
  IMPLEMENTATION: 'implementation',
  /** 文档、注释、提交信息。语言质量与成本平衡。 */
  WRITING: 'writing',
  /** 审 diff、找缺陷、安全检查。高准确度、只读优先。 */
  REVIEW: 'review',
  /** 标题、分类、简单改写。最低延迟与成本。 */
  FAST: 'fast',
} as const

/** 档位类型。 */
export type ModelTier = (typeof ModelTier)[keyof typeof ModelTier]

/**
 * 不可变的任务意图。
 *
 * 每次模型调用都带有它，路由据此选择模型（parts/09 §9.4）。
 * 路由顺序固定为：
 * 显式 turn override → 子代理 definition → skill policy → 当前任务 intent
 * → 全局 tier assignment → fallback。
 */
export interface TaskIntent {
  readonly tier: ModelTier
  readonly purpose: 'explore' | 'plan' | 'implement' | 'write' | 'review' | 'fast'
  readonly requiresTools: boolean
  readonly requiresThinking: boolean
  /** 预估输入 token，用于判断是否放得进候选模型的窗口。 */
  readonly estimatedInputTokens?: number
}

/**
 * `/workwith` 建立的模型覆盖。
 *
 * ⚠️ 作用域是**当前会话的下一项任务**，不是全局档位。用户若想继续用同一模型，
 * 必须再次 `/workwith`（parts/09 §6.1）。刷新客户端或重试请求不得重复执行。
 */
export interface ModelOverride {
  readonly overrideId: string
  readonly scope: 'next-turn' | 'session'
  readonly providerId: string
  readonly modelId: string
  readonly requestedBy: string
  readonly instruction: string
  readonly createdAt: string
  /** 指定了该字段时，override 在用完这个 turn 后失效。 */
  readonly expiresAfterTurnId?: string
}
