import { describe, expect, it } from 'vitest'

import { CommandRegistry } from '../../src/commands/registry.js'
import { createWorkwithCommand } from '../../src/commands/definitions/workwith.js'
import { ModelRefFailure, checkCapability, resolveModelRef } from '../../src/commands/model-ref.js'
import { CommandResultCode, type CommandHost } from '../../src/commands/types.js'
// 配置视图夹具与新增的四条模型命令共用一份（见 fixture.ts 的说明）。
import { LOCAL, SESSION, makeConfig as config } from './fixture.js'
import { ErrorCode } from '../../src/core/errors.js'
import type { SessionId, TurnId } from '../../src/core/ids.js'

describe('resolveModelRef', () => {
  it('按 canonical 形式解析', () => {
    const r = resolveModelRef('p_deepseek/v4-flash', config())
    expect(r).toMatchObject({ ok: true, providerId: 'p_deepseek', modelId: 'v4-flash' })
  })

  it('也接受展示名', () => {
    const r = resolveModelRef('DeepSeek/v4-flash', config())
    expect(r).toMatchObject({ ok: true, modelId: 'v4-flash' })
  })

  it('provider 名含空格时需加引号（解析器已去引号）', () => {
    const r = resolveModelRef('My Provider/m', config())
    expect(r).toMatchObject({ ok: true, providerId: 'p_spaced' })
  })

  it('缺少 / 或一侧为空 → malformed', () => {
    expect(resolveModelRef('deepseek', config())).toMatchObject({
      ok: false,
      reason: ModelRefFailure.MALFORMED,
    })
    expect(resolveModelRef('/v4', config())).toMatchObject({
      ok: false,
      reason: ModelRefFailure.MALFORMED,
    })
  })

  it('找不到时报 NOT_FOUND 并提示 canonical 形式', () => {
    const r = resolveModelRef('nope/nope', config())
    expect(r).toMatchObject({ ok: false, reason: ModelRefFailure.NOT_FOUND })
    expect(r.ok === false && r.message).toMatch(/canonical/)
  })

  it('两种切分都命中时报歧义，而不是随机选一个', () => {
    // provider 名与 model id 都含 `/`，两种切分都能对上
    const ambiguous = config({
      providers: [{ id: 'a', name: 'a', enabled: true, hasSecret: true }],
      models: [
        {
          id: 'b/c',
          providerId: 'a',
          displayName: 'b/c',
          enabled: true,
          supportsTools: true,
          supportsThinking: false,
          supports1MContext: false,
          contextWindow: 1000,
          maxOutputTokens: 100,
        },
      ],
    })
    // `a/b/c`：切在第一个 `/` → provider `a` + model `b/c` ✓；
    // 切在最后一个 `/` → provider `a/b`（不存在）。只有一种命中，不应报歧义。
    expect(resolveModelRef('a/b/c', ambiguous)).toMatchObject({ ok: true, modelId: 'b/c' })
  })
})

describe('checkCapability', () => {
  const ref = { providerId: 'p_deepseek', modelId: 'v4-flash', providerName: 'DeepSeek' }

  it('凭据不可用时拒绝（只检查存在性，不读明文）', () => {
    const r = checkCapability({ ...ref, providerId: 'p_nokey', providerName: 'NoKey' }, config(), {
      requiresTools: true,
    })
    expect(r).toMatchObject({ ok: false, reason: ModelRefFailure.NO_SECRET })
  })

  it('provider 被禁用时拒绝', () => {
    const r = checkCapability({ ...ref, providerId: 'p_off', providerName: 'Disabled' }, config(), {
      requiresTools: true,
    })
    expect(r).toMatchObject({ ok: false, reason: ModelRefFailure.DISABLED })
  })

  it('模型被禁用时拒绝', () => {
    const r = checkCapability({ ...ref, modelId: 'off-model' }, config(), { requiresTools: true })
    expect(r).toMatchObject({ ok: false, reason: ModelRefFailure.DISABLED })
  })

  it('需要工具但模型不支持时拒绝', () => {
    const r = checkCapability({ ...ref, modelId: 'chat-only' }, config(), { requiresTools: true })
    expect(r).toMatchObject({ ok: false, reason: ModelRefFailure.CAPABILITY })
  })

  it('全部满足时通过', () => {
    expect(checkCapability(ref, config(), { requiresTools: true })).toMatchObject({ ok: true })
  })
})

/** 记录 turn 提交的假 host。 */
class FakeHost implements CommandHost {
  readonly localPrincipalId = LOCAL
  readonly published: { type: string; data: unknown }[] = []
  readonly submitted: { prompt: string; override?: unknown }[] = []
  readonly idempotency = new Map<string, { requestHash: string; response: unknown }>()
  busy = false
  config = config()

  listSessions() {
    return Promise.resolve([])
  }
  createSession() {
    return Promise.resolve({ id: 's_new' as SessionId })
  }
  sessionExists() {
    return Promise.resolve(true)
  }
  isBusy(): boolean {
    return this.busy
  }
  cancelTurn(): boolean {
    this.busy = false
    return true
  }
  awaitTurn(): Promise<void> {
    return Promise.resolve()
  }
  submitTurn(input: { prompt: string; override?: unknown }) {
    this.submitted.push({ prompt: input.prompt, override: input.override })
    return Promise.resolve({ turnId: 'turn_new' as TurnId })
  }
  readConfig() {
    return Promise.resolve(this.config)
  }
  updateConfig(): Promise<void> {
    return Promise.resolve()
  }
  updateModelPreferences(): Promise<void> {
    return Promise.resolve()
  }
  // `/workwith` 只建立一次性 override，**不碰全局档位分配**——
  // 这正是它和 `/model use` 的分界。用例若发现这里被调用，说明语义被破坏了。
  assignTierModel(): Promise<void> {
    throw new Error('/workwith 不应修改全局档位分配')
  }
  setModelContextWindow(): Promise<void> {
    throw new Error('/workwith 不应修改上下文窗口')
  }
  publish(input: { type: string; data: unknown }): Promise<void> {
    this.published.push({ type: input.type, data: input.data })
    return Promise.resolve()
  }
  getIdempotency(key: string) {
    return Promise.resolve(this.idempotency.get(key))
  }
  putIdempotency(r: { key: string; requestHash: string; response: unknown }): Promise<void> {
    this.idempotency.set(r.key, { requestHash: r.requestHash, response: r.response })
    return Promise.resolve()
  }
  recordCommandResult() {
    return Promise.resolve('msg_1')
  }
  compact() {
    return Promise.resolve({ ok: true, code: CommandResultCode.OK, text: '' })
  }
  now(): string {
    return '2026-09-15T00:00:00.000Z'
  }
}

const run = async (raw: string, host = new FakeHost(), extra: Record<string, unknown> = {}) => {
  const registry = new CommandRegistry()
  registry.register(createWorkwithCommand())
  return {
    host,
    result: await registry.execute(
      {
        raw,
        principalId: LOCAL,
        sessionId: SESSION,
        signal: new AbortController().signal,
        ...extra,
      },
      host,
    ),
  }
}

describe('/workwith', () => {
  it('使用指定模型：解析、校验、建 override、提交', async () => {
    const { host, result } = await run('/workwith p_deepseek/v4-flash 完成计划里的实现')

    expect(result.ok).toBe(true)
    expect(host.submitted).toHaveLength(1)
    expect(host.submitted[0]?.prompt).toBe('完成计划里的实现')
    expect(host.submitted[0]?.override).toMatchObject({
      providerId: 'p_deepseek',
      modelId: 'v4-flash',
      scope: 'next-turn',
    })
    // 前端要能显示"本次任务使用 provider/model"
    expect(result.text).toContain('v4-flash')
    expect(result.data?.['scope']).toBe('next-turn')
  })

  it('指令保留原始空白，不经 shell 解析', async () => {
    const { host } = await run('/workwith p_deepseek/v4-flash   多  空格\n换行')
    expect(host.submitted[0]?.prompt).toBe('多  空格\n换行')
  })

  it('缺模型引用不提交模型请求', async () => {
    const host = new FakeHost()
    const registry = new CommandRegistry()
    registry.register(createWorkwithCommand())
    const result = await registry.execute(
      {
        raw: '/workwith',
        principalId: LOCAL,
        sessionId: SESSION,
        signal: new AbortController().signal,
      },
      host,
    )
    expect(result.code).toBe(CommandResultCode.INVALID_ARGUMENTS)
    expect(host.submitted).toHaveLength(0)
  })

  it('指令为空不提交模型请求（§6.1 第 5 条）', async () => {
    const { host, result } = await run('/workwith p_deepseek/v4-flash')
    expect(result.code).toBe(CommandResultCode.INVALID_ARGUMENTS)
    expect(host.submitted).toHaveLength(0)
  })

  it('模型不存在时返回明确错误，**不静默回退到全局档位**', async () => {
    const { host, result } = await run('/workwith nope/nope 做点事')
    expect(result.code).toBe(CommandResultCode.INVALID_ARGUMENTS)
    expect(host.submitted).toHaveLength(0)
  })

  it('能力不足时拒绝（不支持工具的模型）', async () => {
    const { host, result } = await run('/workwith p_deepseek/chat-only 做点事')
    expect(result.code).toBe(CommandResultCode.INVALID_ARGUMENTS)
    expect(host.submitted).toHaveLength(0)
  })

  it('凭据不可用时拒绝', async () => {
    const { host, result } = await run('/workwith p_nokey/nokey-model 做点事')
    expect(result.ok).toBe(false)
    expect(host.submitted).toHaveLength(0)
  })

  it('不修改全局档位', async () => {
    const { host } = await run('/workwith p_deepseek/v4-flash 做点事')
    // override 是"下一次提交"的瞬时段位，不写配置
    expect(host.published.some((p) => p.type === 'model_override_created')).toBe(true)
    expect(host.config.tiers).toEqual([])
  })

  it('会话忙时要求确认；确认后打断并提交', async () => {
    const host = new FakeHost()
    host.busy = true

    const gated = await run('/workwith p_deepseek/v4-flash 做点事', host)
    expect(gated.result.code).toBe(CommandResultCode.SESSION_BUSY)
    expect(gated.result.data?.['needsConfirmation']).toBe(true)
    expect(host.submitted).toHaveLength(0)

    const confirmed = await run('/workwith p_deepseek/v4-flash 做点事', host, {
      confirmInterrupt: true,
    })
    expect(confirmed.result.ok).toBe(true)
    expect(host.submitted).toHaveLength(1)
  })

  it('打断后必须先等到旧 turn 结束再提交（否则会误报 SESSION_BUSY）', async () => {
    const host = new FakeHost()
    host.busy = true
    const order: string[] = []
    host.cancelTurn = () => {
      order.push('cancel')
      return true
    }
    host.awaitTurn = () => {
      order.push('await')
      host.busy = false
      return Promise.resolve()
    }
    host.submitTurn = (input: { prompt: string; override?: unknown }) => {
      order.push('submit')
      host.submitted.push({ prompt: input.prompt, override: input.override })
      return Promise.resolve({ turnId: 'turn_new' as TurnId })
    }

    await run('/workwith p_deepseek/v4-flash 做点事', host, { confirmInterrupt: true })
    expect(order).toEqual(['cancel', 'await', 'submit'])
  })

  it('打断超时（仍忙）时返回 SESSION_BUSY，而不是抛异常', async () => {
    const host = new FakeHost()
    host.busy = true
    // 取消只是发出请求；turn 需要时间才真正结束。这里模拟"等到上限仍没结束"，
    // 因此 cancelTurn 不改变 busy——默认替身会立即清掉它，那样就测不到这条路径。
    host.cancelTurn = () => true
    host.awaitTurn = () => Promise.resolve()

    const { result } = await run('/workwith p_deepseek/v4-flash 做点事', host, {
      confirmInterrupt: true,
    })
    expect(result.code).toBe(CommandResultCode.SESSION_BUSY)
    expect(host.submitted).toHaveLength(0)
  })

  it('写审计事件：能力校验、override 创建、turn 启动', async () => {
    const { host } = await run('/workwith p_deepseek/v4-flash 做点事')
    const types = host.published.map((p) => p.type)
    expect(types).toContain('model_capability_checked')
    expect(types).toContain('model_override_created')
    expect(types).toContain('workwith_turn_started')
  })

  it('重复 Idempotency-Key 不重复提交 turn', async () => {
    const host = new FakeHost()
    await run('/workwith p_deepseek/v4-flash 做点事', host, { idempotencyKey: 'k1' })
    await run('/workwith p_deepseek/v4-flash 做点事', host, { idempotencyKey: 'k1' })
    // 刷新页面不应重复提交 turn
    expect(host.submitted).toHaveLength(1)
  })
})

describe('/workwith：失败原因映射到不同的稳定错误码', () => {
  // ⚠️ 这条断言的价值在于"不同"——若命令层不填 errorCode，传输层只能从
  // CommandResultCode 反推，于是"模型名字写错了"和"这个模型干不了这活"
  // 会被压成同一个 400，用户无从分辨。
  it('模型不存在 → MODEL_NOT_FOUND', async () => {
    const { result } = await run('/workwith nope/nope 做点事')
    expect(result.errorCode).toBe(ErrorCode.MODEL_NOT_FOUND)
  })

  it('能力不足 → MODEL_CAPABILITY_UNAVAILABLE（与"不存在"区分开）', async () => {
    const { result } = await run('/workwith p_deepseek/chat-only 做点事')
    expect(result.errorCode).toBe(ErrorCode.MODEL_CAPABILITY_UNAVAILABLE)
  })

  it('凭据不可用 → PROVIDER_AUTH_FAILED', async () => {
    const { result } = await run('/workwith p_nokey/nokey-model 做点事')
    expect(result.errorCode).toBe(ErrorCode.PROVIDER_AUTH_FAILED)
  })

  it('provider 被禁用 → MODEL_NOT_FOUND', async () => {
    const { result } = await run('/workwith p_off/v4-flash 做点事')
    expect(result.errorCode).toBe(ErrorCode.MODEL_NOT_FOUND)
  })

  it('缺参数 → INVALID_COMMAND_ARGUMENTS', async () => {
    const { result } = await run('/workwith')
    expect(result.errorCode).toBe(ErrorCode.INVALID_COMMAND_ARGUMENTS)
  })

  it('打断超时 → SESSION_BUSY', async () => {
    const host = new FakeHost()
    host.busy = true
    host.cancelTurn = () => true
    host.awaitTurn = () => Promise.resolve()
    const { result } = await run('/workwith p_deepseek/v4-flash 做点事', host, {
      confirmInterrupt: true,
    })
    expect(result.errorCode).toBe(ErrorCode.SESSION_BUSY)
  })

  it('每条 ok:false 的结果都带 errorCode（不留空给传输层猜）', async () => {
    const cases = [
      '/workwith',
      '/workwith nope/nope 做点事',
      '/workwith p_deepseek/chat-only 做点事',
      '/workwith p_nokey/v4-flash 做点事',
    ]
    for (const raw of cases) {
      const { result } = await run(raw)
      expect(result.ok, raw).toBe(false)
      expect(result.errorCode, `${raw} 缺少 errorCode`).toBeDefined()
    }
  })
})
