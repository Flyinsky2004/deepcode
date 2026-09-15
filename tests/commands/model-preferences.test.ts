/**
 * `/thinking`、`/reasoning`、`/effort`、`/1M`。
 *
 * 这四条命令的用例刻意集中在**旧实现出错或有隐患的地方**，而不是把每个分支
 * 平铺一遍——平铺只能证明"代码跑到过"，证明不了"改对了"：
 *
 * - `/effort xhigh`：旧菜单提供它、旧落盘校验拒绝它，选一次就把配置**半写**
 *   （thinking 已开、effort 没改）；
 * - `/thinking on`：模型没声明支持思考时必须拒绝，而不是写一个不生效的开关；
 * - `/1M`：开启方向要能力校验，关闭方向不需要；
 * - 四条命令都必须在没有主模型时给可执行的指引，而不是一句失败。
 */

import { describe, expect, it } from 'vitest'

import {
  createContextModeCommand,
  createEffortCommand,
  createReasoningCommand,
  createThinkingCommand,
} from '../../src/commands/definitions/model-preferences.js'
import { CommandRegistry } from '../../src/commands/registry.js'
import { CommandResultCode, type CommandDefinition } from '../../src/commands/types.js'
import { ErrorCode } from '../../src/core/errors.js'
import { LOCAL, PEER, RecordingHost, SESSION, makeConfig, primaryTier } from './fixture.js'

const COMMANDS: readonly (readonly [string, () => CommandDefinition])[] = [
  ['thinking', createThinkingCommand],
  ['reasoning', createReasoningCommand],
  ['effort', createEffortCommand],
  ['1M', createContextModeCommand],
]

/** 按命令名构建单条命令的注册表。 */
const registryFor = (name: string): CommandRegistry => {
  const entry = COMMANDS.find(([n]) => n === name)
  if (entry === undefined) throw new Error(`未知命令：${name}`)
  const registry = new CommandRegistry()
  registry.register(entry[1]())
  return registry
}

const run = async (
  raw: string,
  host = new RecordingHost(),
  principalId = LOCAL,
  idempotencyKey?: string,
) => {
  const name = raw.trim().replace(/^\//, '').split(/\s+/)[0] ?? ''
  return {
    host,
    result: await registryFor(name).execute(
      {
        raw,
        principalId,
        sessionId: SESSION,
        signal: new AbortController().signal,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      },
      host,
    ),
  }
}

/** 主模型存在、且支持思考与 1M 的默认配置。 */
const withPrimary = (host = new RecordingHost()): RecordingHost => {
  host.config = makeConfig({ tiers: [primaryTier] })
  return host
}

describe('无主模型时的共同行为', () => {
  it.each(COMMANDS.map(([name]) => name))('%s 返回可执行的指引，而不是一句失败', async (name) => {
    const { result } = await run(`/${name}`, new RecordingHost())
    expect(result.ok).toBe(false)
    expect(result.code).toBe(CommandResultCode.PANEL)
    expect(result.errorCode).toBe(ErrorCode.MODEL_NOT_FOUND)
    expect(result.text).toContain('/api')
    expect(result.text).toContain('/model')
  })

  it('档位被禁用时同样视为"没有主模型"', async () => {
    const host = new RecordingHost()
    host.config = makeConfig({ tiers: [{ ...primaryTier, enabled: false }] })
    const { result } = await run('/thinking on', host)
    expect(result.errorCode).toBe(ErrorCode.MODEL_NOT_FOUND)
    expect(host.preferenceWrites).toHaveLength(0)
  })
})

describe('/thinking', () => {
  it('不带参数时给出选择列表，并回报当前状态', async () => {
    const { result } = await run('/thinking', withPrimary())
    expect(result.code).toBe(CommandResultCode.SELECTION)
    expect(result.text).toContain('off')
    expect(result.data).toMatchObject({ kind: 'thinking_toggle' })
  })

  it('on 写入 thinkingEnabled: true', async () => {
    const { host, result } = await run('/thinking on', withPrimary())
    expect(result.ok).toBe(true)
    expect(host.preferenceWrites).toEqual([
      { tier: 'implementation', patch: { thinkingEnabled: true } },
    ])
  })

  it('off 写入 thinkingEnabled: false', async () => {
    const { host } = await run('/thinking off', withPrimary())
    expect(host.preferenceWrites[0]?.patch).toEqual({ thinkingEnabled: false })
  })

  it('模型未声明 supportsThinking 时拒绝开启，且一个字节都不写', async () => {
    // parts/09 §9.2 的同源原则：不能静默降级。写进去只会得到一个
    // 永远不生效的开关——那正是这四条命令此前被标为"不可用"的原因。
    const host = new RecordingHost()
    host.config = makeConfig({
      tiers: [{ ...primaryTier, providerId: 'p_deepseek', modelId: 'v4-flash' }],
    })
    const { result } = await run('/thinking on', host)
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe(ErrorCode.MODEL_CAPABILITY_UNAVAILABLE)
    expect(host.preferenceWrites).toHaveLength(0)
  })

  it('未声明支持时**关闭**仍然允许（关不需要能力）', async () => {
    const host = new RecordingHost()
    host.config = makeConfig({
      tiers: [{ ...primaryTier, providerId: 'p_deepseek', modelId: 'v4-flash' }],
    })
    const { result } = await run('/thinking off', host)
    expect(result.ok).toBe(true)
    expect(host.preferenceWrites[0]?.patch).toEqual({ thinkingEnabled: false })
  })

  it('参数非法 → INVALID_COMMAND_ARGUMENTS', async () => {
    const { result } = await run('/thinking maybe', withPrimary())
    expect(result.errorCode).toBe(ErrorCode.INVALID_COMMAND_ARGUMENTS)
  })
})

describe('/reasoning', () => {
  it('不带参数时列出 low / medium / high 三档（不含 xhigh）', async () => {
    const { result } = await run('/reasoning', withPrimary())
    expect(result.code).toBe(CommandResultCode.SELECTION)
    const keys = (result.data?.['items'] as { key: string }[]).map((i) => i.key)
    expect(keys).toEqual(['/reasoning low', '/reasoning medium', '/reasoning high'])
  })

  it('写入 reasoningEffort **并同时打开思考**，回执里的预算才是真的', async () => {
    // ⚠️ 只写 effort 是个空操作：`reasoningEffort` 的唯一消费者是
    // `thinkingConfigFor`，而它要求 `thinkingEnabled === true`（D3 把缺省改成关闭）。
    // 分开写会报出一句"强度已设为 medium（预算 12000）"，而那个 12000
    // 永远不会出现在任何请求里——正是本项目判定"写没有消费者的开关比不写更坏"
    // 的那种情况。打开思考也更接近旧实现的实际行为（旧 thinking 默认 True）。
    const { host, result } = await run('/reasoning medium', withPrimary())
    expect(host.preferenceWrites).toEqual([
      { tier: 'implementation', patch: { thinkingEnabled: true, reasoningEffort: 'medium' } },
    ])
    expect(result.text).toContain('12000')
  })

  it('模型未声明 supportsThinking 时拒绝，不写任何字段', async () => {
    const host = new RecordingHost()
    host.config = makeConfig({
      tiers: [{ ...primaryTier, providerId: 'p_deepseek', modelId: 'v4-flash' }],
    })
    const { result } = await run('/reasoning high', host)
    expect(result.errorCode).toBe(ErrorCode.MODEL_CAPABILITY_UNAVAILABLE)
    expect(host.preferenceWrites).toHaveLength(0)
  })

  it('拒绝 xhigh——它只属于 /effort（对齐旧菜单）', async () => {
    const { host, result } = await run('/reasoning xhigh', withPrimary())
    expect(result.errorCode).toBe(ErrorCode.INVALID_COMMAND_ARGUMENTS)
    expect(host.preferenceWrites).toHaveLength(0)
  })
})

describe('/effort', () => {
  it('low 只关思考，**不动**强度', async () => {
    // 旧实现 `_set_effort` 的 if 分支就是这样。理由：强度只在思考开启时有意义，
    // 关掉思考却顺手改强度，会让"再打开思考"时强度被无声重置。
    const { host, result } = await run('/effort low', withPrimary())
    expect(result.ok).toBe(true)
    expect(host.preferenceWrites).toEqual([
      { tier: 'implementation', patch: { thinkingEnabled: false } },
    ])
  })

  it('xhigh 把 thinking 与强度**合成一次写**（旧实现在这里半写配置）', async () => {
    // 旧实现：先 `set_model_thinking(enabled=True)` 落盘成功，再
    // `set_model_reasoning_effort('xhigh')` 抛 ValueError 且无人捕获
    // （`app.py:1981-2007` + `storage.py:295-298`）——配置停在
    // "思考已开、强度未改"的半途中。本实现把两个字段并成一次写，
    // 并把 xhigh 纳入合法集合（ADR 0004 D4）。
    const { host, result } = await run('/effort xhigh', withPrimary())
    expect(result.ok).toBe(true)
    expect(host.preferenceWrites).toEqual([
      { tier: 'implementation', patch: { thinkingEnabled: true, reasoningEffort: 'xhigh' } },
    ])
    expect(result.text).toContain('48000')
  })

  it('medium / high 同样一次写入两个字段', async () => {
    const { host } = await run('/effort high', withPrimary())
    expect(host.preferenceWrites).toHaveLength(1)
    expect(host.preferenceWrites[0]?.patch).toEqual({
      thinkingEnabled: true,
      reasoningEffort: 'high',
    })
  })

  it('模型未声明 supportsThinking 时拒绝，且不写任何字段', async () => {
    const host = new RecordingHost()
    host.config = makeConfig({
      tiers: [{ ...primaryTier, providerId: 'p_deepseek', modelId: 'v4-flash' }],
    })
    const { result } = await run('/effort high', host)
    expect(result.errorCode).toBe(ErrorCode.MODEL_CAPABILITY_UNAVAILABLE)
    expect(host.preferenceWrites).toHaveLength(0)
  })
})

describe('/1M', () => {
  it('从标准窗口切到 1M', async () => {
    const host = new RecordingHost()
    host.config = makeConfig({
      tiers: [primaryTier],
      models: makeConfig().models.map((m) =>
        m.id === 'gpt-6-astra' ? { ...m, contextWindow: 125_000 } : m,
      ),
    })
    const { result } = await run('/1M', host)
    expect(result.ok).toBe(true)
    expect(host.contextWindowWrites).toEqual([{ tier: 'implementation', contextWindow: 1_000_000 }])
    expect(result.text).toContain('1M')
  })

  it('从 1M 切回标准窗口', async () => {
    const { host, result } = await run('/1M', withPrimary())
    expect(host.contextWindowWrites).toEqual([{ tier: 'implementation', contextWindow: 125_000 }])
    expect(result.text).toContain('125K')
  })

  it('模型未声明 supports1MContext 时拒绝开启，不静默降级成 125K', async () => {
    // parts/09 §9.2 原话：「若开启但模型不支持，必须在保存或选择时拒绝，
    // 不能静默降级」。
    const host = new RecordingHost()
    host.config = makeConfig({
      tiers: [{ ...primaryTier, providerId: 'p_deepseek', modelId: 'v4-flash' }],
    })
    const { result } = await run('/1M', host)
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe(ErrorCode.MODEL_CAPABILITY_UNAVAILABLE)
    expect(host.contextWindowWrites).toHaveLength(0)
  })

  it('不支持 1M 的模型**回到**标准窗口不需要能力，允许执行', async () => {
    const host = new RecordingHost()
    host.config = makeConfig({
      tiers: [{ ...primaryTier, providerId: 'p_deepseek', modelId: 'v4-flash' }],
      models: makeConfig().models.map((m) =>
        m.id === 'v4-flash' ? { ...m, contextWindow: 1_000_000 } : m,
      ),
    })
    const { result } = await run('/1M', host)
    expect(result.ok).toBe(true)
    expect(host.contextWindowWrites).toEqual([{ tier: 'implementation', contextWindow: 125_000 }])
  })
})

describe('权限与审计', () => {
  it.each(COMMANDS.map(([name]) => name))(
    '%s 会写全局配置，非本机 principal 被拒',
    async (name) => {
      const host = withPrimary()
      const { result } = await run(`/${name}`, host, PEER)
      expect(result.code).toBe(CommandResultCode.PERMISSION_DENIED)
      expect(host.preferenceWrites).toHaveLength(0)
      expect(host.contextWindowWrites).toHaveLength(0)
    },
  )
})

describe('/1M 的幂等语义', () => {
  it('是 keyed 幂等——它是开关，重跑一次会切回去', async () => {
    // 另外三条偏好命令是"设置成某个值"，重放与重跑等价，所以用 read-only。
    // `/1M` 不同：浏览器重发一次就把用户的意图反向执行了，而两次响应
    // 都报"已设为 XX"，界面上看不出来。
    // 起点设为标准窗口，于是首次执行是"往上切"，重放若发生就会切回去。
    const host = new RecordingHost()
    host.config = makeConfig({
      tiers: [primaryTier],
      models: makeConfig().models.map((m) =>
        m.id === 'gpt-6-astra' ? { ...m, contextWindow: 125_000 } : m,
      ),
    })
    const windowOf = (): number | undefined =>
      host.config.models.find((m) => m.id === 'gpt-6-astra')?.contextWindow
    expect(windowOf()).toBe(125_000)

    const publishedBefore = host.published.length
    const { result } = await run('/1M', host, LOCAL, 'key-1M')
    expect(result.ok).toBe(true)
    expect(host.contextWindowWrites).toHaveLength(1)

    const replay = await run('/1M', host, LOCAL, 'key-1M')
    // 回放的是**首次结果本身**（`registry` 直接返回 `prior.response`），
    // 所以断言文本一致是有意义的；但真正证明"没重跑"的是下面两条——
    // 没有第二次写入、也没有第二次命令完成事件。
    expect(replay.result.text).toBe(result.text)
    expect(host.contextWindowWrites).toHaveLength(1)
    // 首次执行发两条（审计 + command_completed）；重放**只**发审计。
    // 审计在幂等查询**之前**，这是管线的既定顺序——"谁在什么时候试图跑什么
    // 命令"要记录每一次尝试，包括被回放挡下的那次。而 `command_completed`
    // 在幂等命中时根本走不到，所以不会重复。
    const after = host.published.slice(publishedBefore)
    expect(after.map((e) => e.type)).toEqual([
      'command_received',
      'command_completed',
      'command_received',
    ])
    // 开关**没有**被切第二次：窗口停在 1M，而不是被重放转回 125K
    expect(windowOf()).toBe(1_000_000)
  })
})

describe('选择列表的 key 必须是可执行的命令原文', () => {
  // TUI 不设 `data.context` 时落到 `SelectionContext.MAIN`，而
  // `activateSelection` 对 MAIN 的处理是**把 item.key 当命令原文执行**。
  // 旧 TUI 为这四个面板各建了一个专属语境并写 handler；本项目让选项本身
  // 就是那条后续命令，于是按键行为与手打命令天然一致。
  // 这条约定没有类型能强制，只能靠用例守住——写成裸值 `on` 的话，
  // 用户选中"开启思考"会去执行一条叫 `on` 的未知命令。
  it.each([
    ['/thinking', '/thinking on', '/thinking off'],
    ['/reasoning', '/reasoning low', '/reasoning medium', '/reasoning high'],
    ['/effort', '/effort low', '/effort medium', '/effort high', '/effort xhigh'],
  ])('%s 的每个选项都能被注册表执行', async (command, ...expected) => {
    const { result } = await run(command, withPrimary())
    const keys = (result.data?.['items'] as { key: string }[]).map((i) => i.key)
    expect(keys).toEqual(expected)

    for (const key of keys) {
      const replayed = await run(key, withPrimary())
      // 未知命令会得到 NOT_AVAILABLE；这里必须是一个"认识这个命令"的结果
      expect(replayed.result.code, `${key} 应当是可执行的命令`).not.toBe(
        CommandResultCode.NOT_AVAILABLE,
      )
    }
  })
})
