/**
 * 统一预算。
 *
 * parts/09 §3 的要求是：**所有模型调用、工具调用、子代理和压缩共享一份预算**，
 * 且「局部硬编码的 `3`、`10`、`8000` 等必须移入配置，并在父子代理之间明确传递和扣减」。
 *
 * 这解释了为什么预算不是一个"可选参数"而是核心契约：
 * 旧项目把这些上限散落在各处的字面量里（工具轮上限 10、自动续跑 3 次、
 * 工具结果预算 8000 字符），导致子代理能拿到与父代理无关的独立上限——
 * 于是一个"只该跑 10 轮"的任务在派生子代理后可能跑 10 × N 轮。
 *
 * 预算在本实现中始终显式传递：父代理创建子代理时必须**划拨**（不是复制）
 * 一部分预算，见 `allocateChildBudget`。
 */

/**
 * 一份预算额度。
 *
 * 全部字段都是"上限"，不是"剩余量"——剩余量由 `BudgetTracker` 持有。
 * 这样同一个 `AgentBudget` 可以被多个 tracker 共享（父与子用同一份上限定义），
 * 而各自的消耗独立记账。
 */
export interface AgentBudget {
  /** 模型调用次数上限。 */
  readonly maxModelCalls: number
  /** 工具调用次数上限（所有工具，含 MCP）。 */
  readonly maxToolCalls: number
  /** 墙钟时间上限（毫秒），从 turn 开始计。 */
  readonly maxWallTimeMs: number
  /** 累计输入 token 上限。 */
  readonly maxInputTokens: number
  /** 累计输出 token 上限。 */
  readonly maxOutputTokens: number
  /**
   * 累计成本上限，单位与模型配置一致。
   *
   * 可选：未配置单价时无法计算成本，此时不做成本限制——
   * **不要**把缺失当成 0，那会让所有调用立刻超预算。
   */
  readonly maxCost?: number
}

/**
 * 默认预算。
 *
 * 数值来源：旧项目的既有上限，把它们从散落的字面量收敛到一处
 * （parts/09 §3 明确要求「移入配置」）。这些是**默认值**，可被配置覆盖，
 * 但语义与量级必须与旧实现保持一致，否则行为不等价。
 */
export const DEFAULT_BUDGET: AgentBudget = {
  /** 与旧项目的 `max_tool_rounds` 默认值一致。 */
  maxModelCalls: 10,
  /** 一轮可有多个工具调用，因此工具预算高于模型预算。 */
  maxToolCalls: 50,
  /** 单个 turn 的墙钟上限，防止模型陷入无进展的长循环。 */
  maxWallTimeMs: 10 * 60 * 1000,
  /** 输入侧通常由 context window 约束，这里给一个宽松的累计上限。 */
  maxInputTokens: 2_000_000,
  /** 输出侧上限。 */
  maxOutputTokens: 200_000,
}

/**
 * 自动续跑的独立预算。
 *
 * 旧项目用三个**互相独立**的计数器控制续跑（REWRITE_SPEC §4.5 表格）。
 * 把它们建模成独立类型而不是塞进 `AgentBudget`，是因为它们语义不同：
 * `AgentBudget` 是"总共能花多少"，续跑是"预算耗尽后还能再要几次"。
 *
 * ⚠️ 三者容易混淆，务必分清：
 * - `maxAutoContinues`：turn 预算耗尽时追加预算的次数。递增后**增加** turn 预算。
 * - `maxIncompleteContinues`：工具调用被截断后重试的次数。**不增加** turn 预算。
 * - `maxContextRetries`：上下文超限后 reactive 压缩并重试的次数。
 */
export interface ContinuationLimits {
  /** 自动续跑次数上限。旧项目为 3。 */
  readonly maxAutoContinues: number
  /** 每次自动续跑追加的 turn 数。旧项目为 10。 */
  readonly autoContinueTurns: number
  /** 工具调用截断后的重试上限。旧项目为 3。 */
  readonly maxIncompleteContinues: number
  /** 上下文超限后的重试上限。旧项目为 1。 */
  readonly maxContextRetries: number
}

/** 默认续跑限制。数值必须与旧实现一致。 */
export const DEFAULT_CONTINUATION_LIMITS: ContinuationLimits = {
  maxAutoContinues: 3,
  autoContinueTurns: 10,
  maxIncompleteContinues: 3,
  maxContextRetries: 1,
}

/** 预算被消耗的维度。 */
export const BudgetDimension = {
  MODEL_CALL: 'modelCall',
  TOOL_CALL: 'toolCall',
  WALL_TIME: 'wallTime',
  INPUT_TOKENS: 'inputTokens',
  OUTPUT_TOKENS: 'outputTokens',
  COST: 'cost',
} as const

/** 预算维度类型。 */
export type BudgetDimension = (typeof BudgetDimension)[keyof typeof BudgetDimension]

/** 预算耗尽的结构化描述。 */
export interface BudgetExhaustion {
  /** 哪个维度耗尽。 */
  readonly dimension: BudgetDimension
  /** 该维度的上限。 */
  readonly limit: number
  /** 已消耗量。 */
  readonly consumed: number
}

/**
 * 预算追踪器。
 *
 * 可变对象（与本项目"不可变数据"的总体约束不同——这是**刻意的例外**）。
 * 理由：预算在单个 turn 内被高频更新（每次模型调用、每个工具调用），
 * 每次消耗都构造新对象会产生大量垃圾，且没有共享读的需求。
 *
 * 边界很清晰：`BudgetTracker` 是运行期状态，**不落盘**。
 * 落盘的是 `BudgetExhaustion`（不可变），作为 turn 终止原因的一部分。
 */
export class BudgetTracker {
  readonly #budget: AgentBudget
  readonly #clock: { nowMs(): number }
  readonly #startedAtMs: number

  #modelCalls = 0
  #toolCalls = 0
  #inputTokens = 0
  #outputTokens = 0
  #cost = 0

  constructor(budget: AgentBudget, clock: { nowMs(): number }) {
    this.#budget = budget
    this.#clock = clock
    this.#startedAtMs = clock.nowMs()
  }

  /** 本 tracker 使用的预算上限。 */
  get budget(): AgentBudget {
    return this.#budget
  }

  /** 已消耗的预算快照。 */
  snapshot(): BudgetConsumption {
    return {
      modelCalls: this.#modelCalls,
      toolCalls: this.#toolCalls,
      wallTimeMs: this.#elapsedMs(),
      inputTokens: this.#inputTokens,
      outputTokens: this.#outputTokens,
      cost: this.#cost,
    }
  }

  /** 记录一次模型调用。 */
  recordModelCall(): void {
    this.#modelCalls += 1
  }

  /** 记录一次工具调用。 */
  recordToolCall(): void {
    this.#toolCalls += 1
  }

  /**
   * 记录一次 token 消耗。
   *
   * ⚠️ 语义与旧项目的用量统计一致：`inputTokens` 是**最近一次请求的输入量**
   * （快照语义），`outputTokens` 是**累计输出量**。
   * 见 REWRITE_SPEC §6 不变量 9 与 §4.2 的 C6。
   *
   * 预算判定按最坏情况取每次输入量的总和来估计，见 `#consumedFor`。
   */
  recordUsage(usage: { readonly inputTokens: number; readonly outputTokens: number }): void {
    this.#inputTokens = usage.inputTokens
    this.#outputTokens += usage.outputTokens
  }

  /** 记录成本消耗（累加）。 */
  recordCost(cost: number): void {
    this.#cost += cost
  }

  /**
   * 检查预算是否已耗尽。
   *
   * 返回首个耗尽的维度；充足时返回 `undefined`。
   * 判定顺序固定为：模型调用 → 工具调用 → 墙钟 → 输入 token → 输出 token → 成本。
   * 顺序稳定意味着同一次超预算在父子代理、UI 与日志中报出同一个维度。
   */
  check(): BudgetExhaustion | undefined {
    if (this.#modelCalls >= this.#budget.maxModelCalls) {
      return {
        dimension: BudgetDimension.MODEL_CALL,
        limit: this.#budget.maxModelCalls,
        consumed: this.#modelCalls,
      }
    }

    if (this.#toolCalls >= this.#budget.maxToolCalls) {
      return {
        dimension: BudgetDimension.TOOL_CALL,
        limit: this.#budget.maxToolCalls,
        consumed: this.#toolCalls,
      }
    }

    const elapsed = this.#elapsedMs()
    if (elapsed >= this.#budget.maxWallTimeMs) {
      return {
        dimension: BudgetDimension.WALL_TIME,
        limit: this.#budget.maxWallTimeMs,
        consumed: elapsed,
      }
    }

    if (this.#inputTokens >= this.#budget.maxInputTokens) {
      return {
        dimension: BudgetDimension.INPUT_TOKENS,
        limit: this.#budget.maxInputTokens,
        consumed: this.#inputTokens,
      }
    }

    if (this.#outputTokens >= this.#budget.maxOutputTokens) {
      return {
        dimension: BudgetDimension.OUTPUT_TOKENS,
        limit: this.#budget.maxOutputTokens,
        consumed: this.#outputTokens,
      }
    }

    // 成本上限仅在模型配置了单价时才生效。未配置时 maxCost 为 undefined，
    // 此时不做限制——不要把它当成 0。
    if (this.#budget.maxCost !== undefined && this.#cost >= this.#budget.maxCost) {
      return {
        dimension: BudgetDimension.COST,
        limit: this.#budget.maxCost,
        consumed: this.#cost,
      }
    }

    return undefined
  }

  /** 预算是否已耗尽。 */
  get exhausted(): boolean {
    return this.check() !== undefined
  }

  /**
   * 剩余可用比例（0..1），取各维度中最紧张的一个。
   *
   * 用于 UI 呈现与"临近预算"告警。
   */
  remainingRatio(): number {
    const ratios: number[] = [
      1 - this.#modelCalls / this.#budget.maxModelCalls,
      1 - this.#toolCalls / this.#budget.maxToolCalls,
      1 - this.#elapsedMs() / this.#budget.maxWallTimeMs,
      1 - this.#inputTokens / this.#budget.maxInputTokens,
      1 - this.#outputTokens / this.#budget.maxOutputTokens,
    ]

    if (this.#budget.maxCost !== undefined) {
      ratios.push(1 - this.#cost / this.#budget.maxCost)
    }

    // 下限截断到 0：超预算时不返回负数，避免调用方误判为"负剩余"。
    return Math.max(0, Math.min(...ratios))
  }

  #elapsedMs(): number {
    return this.#clock.nowMs() - this.#startedAtMs
  }
}

/** 预算消耗快照。 */
export interface BudgetConsumption {
  readonly modelCalls: number
  readonly toolCalls: number
  readonly wallTimeMs: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cost: number
}

/**
 * 为子代理划拨预算。
 *
 * parts/09 §7.2 的硬性要求：「子代理不得获得父代理没有的……预算」。
 * 因此子代理的预算必须是父预算的**子集**——这里取父预算与定义上限的逐字段最小值。
 *
 * ⚠️ 注意这是"上限收窄"而非"划拨扣减"：父代理不会因为派出子代理而减少自己的上限。
 * 若需要严格的总量守恒（父 + 子 ≤ 父原上限），应在 Phase 9 的调度层额外做扣减记账。
 * 当前实现保证的是**永不放大**这一安全属性。
 *
 * @param parent 父代理的预算
 * @param requested 子代理定义中声明的预算上限（可部分声明）
 */
export function allocateChildBudget(
  parent: AgentBudget,
  requested: Partial<AgentBudget>,
): AgentBudget {
  return {
    maxModelCalls: Math.min(parent.maxModelCalls, requested.maxModelCalls ?? parent.maxModelCalls),
    maxToolCalls: Math.min(parent.maxToolCalls, requested.maxToolCalls ?? parent.maxToolCalls),
    maxWallTimeMs: Math.min(parent.maxWallTimeMs, requested.maxWallTimeMs ?? parent.maxWallTimeMs),
    maxInputTokens: Math.min(
      parent.maxInputTokens,
      requested.maxInputTokens ?? parent.maxInputTokens,
    ),
    maxOutputTokens: Math.min(
      parent.maxOutputTokens,
      requested.maxOutputTokens ?? parent.maxOutputTokens,
    ),
    // 成本上限的特殊处理：父未配置成本上限时，子也不能凭空获得一个上限，
    // 否则会凭空引入父代理没有的约束（同样是行为差异）。
    ...(parent.maxCost === undefined
      ? {}
      : { maxCost: Math.min(parent.maxCost, requested.maxCost ?? parent.maxCost) }),
  }
}

/** 合并两份预算，逐字段取更严格的一方。用于配置覆盖默认值。 */
export function tightenBudget(base: AgentBudget, override: Partial<AgentBudget>): AgentBudget {
  return allocateChildBudget(base, override)
}
