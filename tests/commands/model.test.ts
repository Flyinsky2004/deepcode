/**
 * `/model` 的写分支（`/model use <tier> <provider/model>`）。
 *
 * 旧实现的写分支是**按下标选**（`/model use <ch> <mo>`，`app.py:1606-1627`），
 * 本项目改成 canonical 引用——理由见 ADR 0004 D7。这里固定住改动的三条性质：
 *
 * 1. 引用解析与 `/workwith` **完全同一套**（同一个输入给同一个结果），
 *    否则用户得记两套规则；
 * 2. 写入前必须过能力校验（`parts/09` §9.3），失败时**一个字节都不写**；
 * 3. 成功回执反映的是**回读后的磁盘状态**，不是入参回显。
 */

import { describe, expect, it } from 'vitest'

import { createModelCommand } from '../../src/commands/definitions/model.js'
import { CommandRegistry } from '../../src/commands/registry.js'
import { CommandResultCode } from '../../src/commands/types.js'
import { ErrorCode } from '../../src/core/errors.js'
import { LOCAL, PEER, RecordingHost, SESSION, makeConfig, primaryTier } from './fixture.js'

const run = async (raw: string, host = new RecordingHost(), principalId = LOCAL) => {
  const registry = new CommandRegistry()
  registry.register(createModelCommand())
  return {
    host,
    result: await registry.execute(
      {
        raw,
        principalId,
        sessionId: SESSION,
        signal: new AbortController().signal,
      },
      host,
    ),
  }
}

describe('/model（只读分支）', () => {
  it('没有档位时给出用法提示，而不是空列表假装成功', async () => {
    const { result } = await run('/model')
    expect(result.ok).toBe(true)
    expect(result.code).toBe(CommandResultCode.PANEL)
    expect(result.text).toContain('/model use')
    expect(result.data).toMatchObject({ kind: 'model_panel', tiers: [] })
  })

  it('列出档位分配，并把禁用状态标出来', async () => {
    const host = new RecordingHost()
    host.config = makeConfig({
      tiers: [primaryTier, { ...primaryTier, tier: 'fast', enabled: false }],
    })
    const { result } = await run('/model', host)
    expect(result.text).toContain('implementation → OpenAI/gpt-6-astra')
    expect(result.text).toContain('fast（已禁用）')
  })

  it('档位指向一个已被删除的模型时不崩，照样把它显示出来', async () => {
    // 悬空分配是用户要能看见的事实，不是异常。
    const host = new RecordingHost()
    host.config = makeConfig({
      tiers: [{ ...primaryTier, providerId: 'p_gone', modelId: 'ghost' }],
    })
    const { result } = await run('/model', host)
    expect(result.ok).toBe(true)
    // provider 已被删除 → 退回 id，但绝不崩
    expect(result.text).toContain('p_gone/ghost')
  })
})

describe('/model use', () => {
  it('解析 canonical 引用、校验、写入、回读后回报', async () => {
    const { host, result } = await run('/model use implementation p_openai/gpt-6-astra')

    expect(result.ok).toBe(true)
    expect(host.tierAssignments).toEqual([
      { tier: 'implementation', providerId: 'p_openai', modelId: 'gpt-6-astra' },
    ])
    // 展示名统一为 `providerName/modelId`，与 `/workwith` 的回执同一形状
    expect(result.text).toBe('档位 implementation → OpenAI/gpt-6-astra')
  })

  it('也接受展示名（与 /workwith 同一套消歧）', async () => {
    const { host } = await run('/model use implementation DeepSeek/v4-flash')
    expect(host.tierAssignments[0]).toMatchObject({ providerId: 'p_deepseek', modelId: 'v4-flash' })
  })

  it('provider 展示名含空格时用引号包裹（解析器已去引号）', async () => {
    const { host } = await run('/model use writing "My Provider"/m')
    expect(host.tierAssignments[0]).toMatchObject({ providerId: 'p_spaced', modelId: 'm' })
  })

  it('未知档位 → INVALID_COMMAND_ARGUMENTS，且不写任何东西', async () => {
    const { host, result } = await run('/model use nonsense p_openai/gpt-6-astra')
    expect(result.code).toBe(CommandResultCode.INVALID_ARGUMENTS)
    expect(result.errorCode).toBe(ErrorCode.INVALID_COMMAND_ARGUMENTS)
    expect(host.tierAssignments).toHaveLength(0)
  })

  it('模型不存在 → MODEL_NOT_FOUND', async () => {
    const { result } = await run('/model use implementation p_openai/nope')
    expect(result.errorCode).toBe(ErrorCode.MODEL_NOT_FOUND)
  })

  it('provider 被禁用 → MODEL_NOT_FOUND', async () => {
    const { result } = await run('/model use implementation p_off/gpt-6-astra')
    expect(result.errorCode).toBe(ErrorCode.MODEL_NOT_FOUND)
  })

  it('模型被禁用 → MODEL_NOT_FOUND', async () => {
    const { result } = await run('/model use implementation p_deepseek/off-model')
    expect(result.errorCode).toBe(ErrorCode.MODEL_NOT_FOUND)
  })

  it('凭据不可用 → PROVIDER_AUTH_FAILED（只查存在性，不读明文）', async () => {
    const { host, result } = await run('/model use implementation p_nokey/nokey-model')
    expect(result.errorCode).toBe(ErrorCode.PROVIDER_AUTH_FAILED)
    expect(host.tierAssignments).toHaveLength(0)
  })

  it('implementation 要求 supportsTools，不支持的模型被拒', async () => {
    // parts/09 §9.3 明示的一条；其余档位规格没规定，所以不设约束。
    const { result } = await run('/model use implementation p_deepseek/chat-only')
    expect(result.errorCode).toBe(ErrorCode.MODEL_CAPABILITY_UNAVAILABLE)
  })

  it('规格没规定能力要求的档位不额外设卡', async () => {
    // 不发明约束：planning 用不支持工具的模型是规格允许的配置。
    // 注定跑不起来由 ModelRouter 在每个 turn 上按 TaskIntent 拒绝。
    const { host, result } = await run('/model use planning p_deepseek/chat-only')
    expect(result.ok).toBe(true)
    expect(host.tierAssignments).toHaveLength(1)
  })

  it('引用有歧义 → INVALID_COMMAND_ARGUMENTS，不随机选', async () => {
    // 两个 provider 取了同一个**展示名**，各自又都有名为 `shared` 的模型：
    // `Dup/shared` 因此同时命中两个 (providerId, modelId) 组合。
    const host = new RecordingHost()
    host.config = makeConfig({
      providers: [
        { id: 'p_a', name: 'Dup', enabled: true, hasSecret: true },
        { id: 'p_b', name: 'Dup', enabled: true, hasSecret: true },
      ],
      models: [
        {
          id: 'shared',
          providerId: 'p_a',
          displayName: 'shared',
          enabled: true,
          supportsTools: true,
          supportsThinking: false,
          supports1MContext: false,
          contextWindow: 32_000,
          maxOutputTokens: 4_000,
        },
        {
          id: 'shared',
          providerId: 'p_b',
          displayName: 'shared',
          enabled: true,
          supportsTools: true,
          supportsThinking: false,
          supports1MContext: false,
          contextWindow: 32_000,
          maxOutputTokens: 4_000,
        },
      ],
    })
    const { result } = await run('/model use implementation Dup/shared', host)
    expect(result.errorCode).toBe(ErrorCode.INVALID_COMMAND_ARGUMENTS)
    expect(result.text).toContain('歧义')
  })

  it('非本机 principal 被拒（会写全局配置）', async () => {
    const { host, result } = await run(
      '/model use implementation p_openai/gpt-6-astra',
      new RecordingHost(),
      PEER,
    )
    expect(result.code).toBe(CommandResultCode.PERMISSION_DENIED)
    expect(result.errorCode).toBe(ErrorCode.PERMISSION_DENIED)
    expect(host.tierAssignments).toHaveLength(0)
  })

  it('未知动作在参数校验阶段就被挡下（不会误当成只读分支）', async () => {
    const { host, result } = await run('/model frobnicate implementation p_openai/gpt-6-astra')
    expect(result.code).toBe(CommandResultCode.INVALID_ARGUMENTS)
    expect(host.published.some((e) => e.type === 'model_tier_assigned')).toBe(false)
  })

  it('成功时发出审计事件，记录 tier 与去向', async () => {
    const { host } = await run('/model use implementation p_openai/gpt-6-astra')
    const assigned = host.published.find((e) => e.type === 'model_tier_assigned')
    expect(assigned?.data).toMatchObject({
      tier: 'implementation',
      to: 'gpt-6-astra',
      providerId: 'p_openai',
    })
  })
})
