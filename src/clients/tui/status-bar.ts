/**
 * 状态栏渲染（`app.py:2240-2307` 的逐行移植）。
 *
 * 优先级从高到低：**compacting → streaming → 无模型 → 正常态**。
 * 前两个是短路的：压缩中不显示模型信息，流式中不显示 token 统计
 * （流式期用的是粗估 token，见 §8.5）。
 *
 * ## 与旧实现的三处差异（都是显式决策）
 *
 * 1. **T-9 修正：不再每帧读盘。** 旧实现每次渲染都调 `list_messages()`
 *    只为拿消息条数（`app.py:2279`）。这里改用状态里**已经读过的**
 *    `messages.length`——消息区本来就由 `render-history` 从存储刷新，
 *    计数因此永远是同一份数据的长度，行为等价而不多一次全文件读取。
 * 2. **去掉 MCP 与 Langfuse 两段。** 两者在 TS 侧尚不存在
 *    （`src/mcp` 属 Phase 10，可观测性未移植）。构造一段永远为空的输出
 *    只会让状态栏出现 `MCP: 0/0` 这种无意义文本。
 * 3. **新增 `Tier` 与成本两项**，来自 `progess.md` Phase 7 验收
 *    「展示模型档位、provider/model、token、成本」。
 */

import { TKey } from './i18n/keys.js'
import { translate } from './i18n/index.js'

import { COLORS, MODE_BOLD, MODE_COLORS, SPINNER_FRAMES } from './theme.js'
import type { ModeIndex, StatusModel, TuiState } from './types.js'

export type { StatusModel }

/** 状态栏的一行文本 + 前缀模式标签。 */
export interface StatusBarText {
  /** 模式标签（旧实现永远作为前缀）。 */
  readonly modeLabel: string
  readonly modeColor: string
  readonly modeBold: boolean
  readonly text: string
}

/** 上下文窗口标签：`>= 1_000_000` → `1M`，否则 `{//1000}K`。 */
export function contextWindowLabel(contextWindow: number): string {
  return contextWindow >= 1_000_000 ? '1M' : `${Math.floor(contextWindow / 1000)}K`
}

/** 输出上限标签：`< 1_000_000` → `{//1000}K`，否则 `1M`。 */
export function maxOutputLabel(maxOutputTokens: number): string {
  return maxOutputTokens < 1_000_000 ? `${Math.floor(maxOutputTokens / 1000)}K` : '1M'
}

/** 模式标签（`_mode_label`，`app.py:2141-2158`）。 */
export function modeLabel(mode: ModeIndex, language: TuiState['language']): string {
  const keys: readonly string[] = [
    TKey.STATUS_MODE_NORMAL,
    TKey.STATUS_MODE_AUTO_EDIT,
    TKey.STATUS_MODE_YOLO,
    TKey.STATUS_MODE_PLAN,
  ]
  const key = keys[mode] ?? TKey.STATUS_MODE_NORMAL
  return translate(language, key)
}

/**
 * 计算成本（美元）。
 *
 * 任一单价缺失就返回 `undefined`——报 `$0` 会被误读成"这次调用免费"。
 */
export function estimateCost(
  model: StatusModel,
  inputTokens: number,
  outputTokens: number,
): number | undefined {
  const { inputCostPerMillion, outputCostPerMillion } = model
  if (inputCostPerMillion === undefined && outputCostPerMillion === undefined) return undefined
  const input = (inputTokens * (inputCostPerMillion ?? 0)) / 1_000_000
  const output = (outputTokens * (outputCostPerMillion ?? 0)) / 1_000_000
  return input + output
}

/** 成本显示：4 位小数足够区分小额，且不会随 token 增长变成科学计数法。 */
export function formatCost(cost: number): string {
  return cost.toFixed(4)
}

/**
 * 渲染状态栏。
 *
 * `model` 为 `undefined` 表示"没有可用的主模型"——对应旧实现的
 * `get_primary_llm_model()` 返回 `None`。
 */
export function renderStatusBar(state: TuiState, model: StatusModel | undefined): StatusBarText {
  const language = state.language
  const t = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) =>
    translate(language, key, params)

  const label = modeLabel(state.mode, language)
  const chrome = {
    modeLabel: label,
    modeColor: MODE_COLORS[state.mode] ?? COLORS.logo,
    modeBold: MODE_BOLD[state.mode] ?? false,
  }

  // 1. 压缩中
  if (state.compacting) return { ...chrome, text: t(TKey.STATUS_COMPACTING) }

  // 2. 流式中（spinner + 粗估 token）
  if (state.streaming) {
    const spinner = SPINNER_FRAMES[state.spinnerFrame % SPINNER_FRAMES.length] ?? '|'
    const tokens = state.streamingTokens
    const base = `${t(TKey.STATUS_WORKING)}... ${spinner}`
    return { ...chrome, text: tokens ? `${base} ${tokens} tok` : base }
  }

  // 3. 无模型
  if (!model) return { ...chrome, text: t(TKey.STATUS_NO_MODEL) }

  // 4. 正常态：各段用 "  |  " 连接
  const parts: string[] = [
    `${model.providerName} / ${model.modelName}`,
    t(TKey.STATUS_TIER, { tier: model.tier }),
    t(TKey.STATUS_THINK, { status: model.thinkingEnabled ? 'ON' : 'OFF' }),
    `Effort: ${model.reasoningEffort ?? 'default'}`,
    `Ctx: ${contextWindowLabel(model.contextWindow)}`,
    `Out: ${maxOutputLabel(model.maxOutputTokens)}`,
  ]

  if (state.sessionId !== undefined) {
    // T-9：用已读过的消息计数，不再每帧 `list_messages()`。
    parts.push(t(TKey.STATUS_MSGS, { count: state.messages.length }))

    const input = state.lastInputTokens
    const output = state.totalOutputTokens
    if (input || output) {
      const ctx = model.contextWindow
      if (ctx && input) {
        const pct = (input / ctx) * 100
        parts.push(`↑${input} ↓${output} (${pct.toFixed(1)}%)`)
      } else {
        parts.push(`↑${input} ↓${output}`)
      }
    }

    const cost = estimateCost(model, input, output)
    if (cost !== undefined) parts.push(t(TKey.STATUS_COST, { cost: formatCost(cost) }))
  } else {
    parts.push(t(TKey.STATUS_NO_CONV))
  }

  return { ...chrome, text: parts.join('  |  ') }
}

/** 状态栏整行（模式标签是前缀，中间两个空格）。 */
export function statusBarLine(rendered: StatusBarText): string {
  return `${rendered.modeLabel}  ${rendered.text}`
}
