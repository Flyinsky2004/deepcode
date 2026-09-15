/**
 * `CommandHost` 的适配器：把命令层的窄端口接到 `AgentApplication` 上。
 *
 * 依赖方向是 `app → commands(端口)`，命令层不 import `src/app`——所以
 * 适配器必须写在 `src/app` 这一侧。这样命令层可以脱离应用被单测
 * （`tests/commands/*` 用的就是纯假的 host）。
 */

import { statSync } from 'node:fs'

import { AgentError, ErrorCode } from '../core/errors.js'
import type { PrincipalId, SessionId, TurnId } from '../core/ids.js'
import type { ModelTier } from '../core/provider.js'
import type { CommandConfigView, CommandHost, CommandResult } from '../commands/types.js'
import { CommandResultCode } from '../commands/types.js'
import type { AgentApplication } from './agent-application.js'

/**
 * 判断某个 `SecretRef` 是否**可用**。
 *
 * `parts/09` §9.1：「API key 不得出现在日志、事件、导出文件、URL 或前端响应中」
 * ——所以这里**只判断可用性，绝不读取明文**。
 */
function secretAvailable(ref: { source: string; key: string } | undefined): boolean {
  if (!ref) return false
  if (ref.source === 'env') {
    const value = process.env[ref.key]
    return typeof value === 'string' && value.length > 0
  }
  if (ref.source === 'file') {
    try {
      return statSync(ref.key).size > 0
    } catch {
      return false
    }
  }
  // keychain 尚未实现 —— 返回 false 而不是假装可用，否则 /workwith 会放行
  // 一个注定连不上的模型。
  return false
}

export class CommandHostAdapter implements CommandHost {
  readonly #app: AgentApplication

  constructor(app: AgentApplication) {
    this.#app = app
  }

  get localPrincipalId(): PrincipalId {
    return this.#app.localPrincipalId
  }

  // ── 会话 ───────────────────────────────────────────────────────

  async listSessions(principalId: PrincipalId) {
    const sessions = await this.#app.listSessions(principalId)
    return sessions.map((s) => ({
      id: s.id,
      title: s.title,
      current_turn: s.current_turn,
      agent_type: s.agent_type,
    }))
  }

  createSession(principalId: PrincipalId, title?: string) {
    return this.#app.createSession(principalId, title)
  }

  async sessionExists(principalId: PrincipalId, sessionId: SessionId): Promise<boolean> {
    try {
      await this.#app.getSession(principalId, sessionId)
      return true
    } catch {
      return false
    }
  }

  // ── turn ───────────────────────────────────────────────────────

  isBusy(sessionId: SessionId): boolean {
    return this.#app.isBusy(sessionId)
  }

  cancelTurn(sessionId: SessionId, reason: string): boolean {
    return this.#app.cancelTurn(sessionId, reason)
  }

  /** 有界等待：命令层不关心如何等，只要求"最多这么久"。 */
  async awaitTurn(sessionId: SessionId, timeoutMs: number): Promise<void> {
    const pending = this.#app.awaitTurn(sessionId)
    if (timeoutMs <= 0) {
      await pending
      return
    }
    await Promise.race([
      pending,
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs)
        timer.unref?.()
      }),
    ])
  }

  async submitTurn(input: {
    readonly principalId: PrincipalId
    readonly sessionId: SessionId
    readonly prompt: string
    readonly override?: Parameters<CommandHost['submitTurn']>[0]['override']
  }): Promise<{ readonly turnId: TurnId }> {
    const { turnId } = await this.#app.submitTurn({
      principalId: input.principalId,
      sessionId: input.sessionId,
      prompt: input.prompt,
      ...(input.override === undefined ? {} : { override: input.override }),
    })
    return { turnId }
  }

  // ─ 配置 ────────────────────────────────────────────────────────

  async readConfig(): Promise<CommandConfigView> {
    const doc = await this.#app.configStore.read()
    return {
      providers: doc.providers.map((p) => ({
        id: p.id,
        name: p.name,
        enabled: p.enabled,
        hasSecret: secretAvailable(p.apiKeyRef),
      })),
      models: doc.model_profiles.map((m) => ({
        id: m.id,
        providerId: m.providerId,
        displayName: m.displayName ?? m.id,
        enabled: m.enabled,
        supportsTools: m.supportsTools,
        supportsThinking: m.supportsThinking,
        supports1MContext: m.supports1MContext,
        contextWindow: m.contextWindow,
        maxOutputTokens: m.maxOutputTokens,
        // 运行偏好（可缺省）。缺省与 `false` 在存储里是**不同的**：
        // 前者表示"从未设置过"，后者表示"用户明确关掉了"。视图如实透出这个
        // 区别，由 `thinkingConfigFor` / ADR 0004 D3 决定怎么解释。
        ...(m.thinkingEnabled === undefined ? {} : { thinkingEnabled: m.thinkingEnabled }),
        ...(m.reasoningEffort === undefined ? {} : { reasoningEffort: m.reasoningEffort }),
      })),
      tiers: doc.tier_assignments.map((t) => ({
        tier: t.tier,
        providerId: t.modelRef.providerId,
        modelId: t.modelRef.modelId,
        enabled: t.enabled,
      })),
      settings: doc.app_settings,
      raw: doc,
    }
  }

  async updateConfig(mutator: (view: CommandConfigView) => CommandConfigView): Promise<void> {
    // 命令层只看得见一个受限视图，写回时把视图里的可变部分合并回原文档。
    // 这样命令不需要知道 `app_settings`、`llm_channels` 等字段的存在。
    const before = await this.readConfig()
    const after = mutator(before)
    await this.#app.updateConfigRaw((doc) => ({
      ...doc,
      app_settings: { ...doc.app_settings, ...after.settings },
      tier_assignments: after.tiers.map((t) => {
        // ⚠️ 必须在**既有 assignment 上合并**，不能按视图字段重建。
        // 视图只暴露 tier/providerId/modelId/enabled 四项，重建会把
        // `maxCostPerTurn` 之类没进视图的字段静默清掉——此前每次 `/language`
        // 写设置都会触发一次（`/language` 也会走到这条回写路径）。
        const existing = doc.tier_assignments.find((d) => d.tier === t.tier)
        return {
          ...(existing ?? { tier: t.tier, fallbackModelRefs: [] }),
          tier: t.tier,
          modelRef: { providerId: t.providerId, modelId: t.modelId },
          enabled: t.enabled,
        }
      }),
    }))
  }

  async updateModelPreferences(
    tier: ModelTier,
    patch: { readonly thinkingEnabled?: boolean; readonly reasoningEffort?: string },
  ): Promise<void> {
    await this.#app.updateModelPreferences(tier, patch)
  }

  async assignTierModel(tier: ModelTier, providerId: string, modelId: string): Promise<void> {
    await this.#app.assignTierModel(tier, providerId, modelId)
  }

  async setModelContextWindow(tier: ModelTier, contextWindow: number): Promise<void> {
    await this.#app.setModelContextWindow(tier, contextWindow)
  }

  // ── 事件与审计 ──────────────────────────────────────────────────

  async publish(input: {
    readonly sessionId: SessionId | undefined
    readonly turnId?: TurnId
    readonly type: string
    readonly data: unknown
  }): Promise<void> {
    // 没有会话归属的命令（如 /api 列 provider）没有可落的会话日志；
    // 直接丢弃而不是编一个假 sessionId——那会污染某个真实会话的事件流。
    if (input.sessionId === undefined) return
    await this.#app.bus
      .publish({
        sessionId: input.sessionId,
        ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
        type: input.type,
        data: input.data,
      })
      .then(
        () => undefined,
        () => undefined,
      )
  }

  // ── 幂等 ────────────────────────────────────────────────────────

  async getIdempotency(key: string) {
    const record = await this.#app.chatStore.getIdempotency(key)
    return record === undefined
      ? undefined
      : { requestHash: record.requestHash, response: record.response }
  }

  async putIdempotency(record: {
    readonly key: string
    readonly operation: string
    readonly requestHash: string
    readonly response: unknown
  }): Promise<void> {
    await this.#app.chatStore.putIdempotency({
      key: record.key,
      operation: record.operation,
      requestHash: record.requestHash,
      response: record.response,
      createdAt: this.#app.now(),
    })
  }

  // ── 结果落地 ────────────────────────────────────────────────────

  async recordCommandResult(input: {
    readonly sessionId: SessionId
    readonly command: string
    readonly result: CommandResult
  }): Promise<string | undefined> {
    const message = await this.#app.chatStore.addMessage({
      conversation_id: input.sessionId,
      role: 'system',
      content: input.result.text,
      turn_id: '',
      subtype: 'command_event',
      tool_call_id: null,
      meta: JSON.stringify({
        command: input.command,
        ok: input.result.ok,
        code: input.result.code,
      }),
      agent_type: '',
    })
    return message.id
  }

  async compact(sessionId: SessionId, signal: AbortSignal): Promise<CommandResult> {
    try {
      const applied = await this.#app.compactor.compact(
        sessionId,
        // 手动压缩没有 working memory 上下文，给一份空的；压缩器会自行
        // 从消息流里重建可保留的部分。
        {
          userConstraints: [],
          openTasks: [],
          pendingToolCalls: [],
          permissionDecisions: [],
          fileChanges: [],
          appliedSkills: [],
        },
        signal,
        true,
      )
      return applied === undefined
        ? { ok: true, code: CommandResultCode.OK, text: '当前上下文无需压缩' }
        : {
            ok: true,
            code: CommandResultCode.OK,
            text: `已压缩上下文（摘要 ${applied.summary.slice(0, 40)}）`,
          }
    } catch (error) {
      const e = AgentError.is(error)
        ? error
        : new AgentError({
            code: ErrorCode.INTERNAL_ERROR,
            message: error instanceof Error ? error.message : '压缩失败',
            source: 'command.compact',
          })
      return { ok: false, code: CommandResultCode.FAILED, text: e.message, errorCode: e.code }
    }
  }

  now(): string {
    return this.#app.now()
  }
}
