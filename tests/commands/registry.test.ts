import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { CommandRegistry } from '../../src/commands/registry.js'
import {
  CommandResultCode,
  type CommandDefinition,
  type CommandHost,
} from '../../src/commands/types.js'
import { ErrorCode } from '../../src/core/errors.js'
import type { PrincipalId, SessionId } from '../../src/core/ids.js'

const LOCAL = 'local' as PrincipalId

/** 只在测试里用到的、记录调用的假 host。 */
class FakeHost implements CommandHost {
  readonly localPrincipalId = LOCAL
  readonly published: { type: string; data: unknown }[] = []
  readonly idempotency = new Map<string, { requestHash: string; response: unknown }>()
  readonly recorded: { command: string; text: string }[] = []
  busy = false
  sessions: { id: SessionId; title: string }[] = []

  listSessions(): Promise<
    readonly { id: SessionId; title: string; current_turn: number; agent_type: string }[]
  > {
    return Promise.resolve(this.sessions.map((s) => ({ ...s, current_turn: 0, agent_type: '' })))
  }
  createSession(): Promise<{ id: SessionId }> {
    return Promise.resolve({ id: 's_new' as SessionId })
  }
  sessionExists(): Promise<boolean> {
    return Promise.resolve(true)
  }
  isBusy(): boolean {
    return this.busy
  }
  cancelTurn(): boolean {
    return true
  }
  awaitTurn(): Promise<void> {
    return Promise.resolve()
  }
  submitTurn(): Promise<{ turnId: never }> {
    return Promise.resolve({ turnId: 'turn_x' as never })
  }
  readConfig(): Promise<never> {
    return Promise.resolve({ providers: [], models: [], tiers: [], settings: {}, raw: {} } as never)
  }
  updateConfig(): Promise<void> {
    return Promise.resolve()
  }
  updateModelPreferences(): Promise<void> {
    return Promise.resolve()
  }
  publish(input: { type: string; data: unknown }): Promise<void> {
    this.published.push({ type: input.type, data: input.data })
    return Promise.resolve()
  }
  getIdempotency(key: string) {
    return Promise.resolve(this.idempotency.get(key))
  }
  putIdempotency(record: { key: string; requestHash: string; response: unknown }): Promise<void> {
    this.idempotency.set(record.key, {
      requestHash: record.requestHash,
      response: record.response,
    })
    return Promise.resolve()
  }
  recordCommandResult(input: { command: string; result: { text: string } }): Promise<string> {
    this.recorded.push({ command: input.command, text: input.result.text })
    return Promise.resolve('msg_1')
  }
  compact(): Promise<never> {
    return Promise.resolve({ ok: true, code: 'ok', text: 'x' } as never)
  }
  now(): string {
    return '2026-09-15T00:00:00.000Z'
  }
}

const command = (over: Partial<CommandDefinition> = {}): CommandDefinition => ({
  name: 'demo',
  description: '演示',
  parameters: { positionals: [] },
  interrupt: 'never',
  permission: { kind: 'always' },
  auditEvent: 'command_received',
  idempotency: { kind: 'read-only' },
  persistResult: false,
  execute: () => Promise.resolve({ ok: true, code: CommandResultCode.OK, text: 'done' }),
  ...over,
})

const input = (raw: string, over: Record<string, unknown> = {}) => ({
  raw,
  principalId: LOCAL,
  sessionId: 's1' as SessionId,
  signal: new AbortController().signal,
  ...over,
})

describe('CommandRegistry：查找', () => {
  it('大小写不敏感', () => {
    const registry = new CommandRegistry()
    registry.register(command({ name: 'model' }))
    expect(registry.get('MODEL')?.name).toBe('model')
    expect(registry.get('Model')?.name).toBe('model')
  })

  it('别名指向同一个定义', () => {
    const registry = new CommandRegistry()
    registry.register(command({ name: 'context', aliases: ['1m'] }))
    expect(registry.get('1M')?.name).toBe('context')
  })

  it('list 去重（别名不重复列出）', () => {
    const registry = new CommandRegistry()
    registry.register(command({ name: 'context', aliases: ['1m'] }))
    expect(registry.list()).toHaveLength(1)
  })

  it('重名直接报错，而不是静默覆盖', () => {
    const registry = new CommandRegistry()
    registry.register(command({ name: 'a' }))
    expect(() => registry.register(command({ name: 'A' }))).toThrow(/命令名重复/)
  })
})

describe('CommandRegistry：管线各步', () => {
  it('不是命令 → INVALID_ARGUMENTS', async () => {
    const registry = new CommandRegistry()
    const result = await registry.execute(input('你好'), new FakeHost())
    expect(result.code).toBe(CommandResultCode.INVALID_ARGUMENTS)
  })

  it('未知命令 → NOT_AVAILABLE', async () => {
    const registry = new CommandRegistry()
    const result = await registry.execute(input('/nope'), new FakeHost())
    expect(result.code).toBe(CommandResultCode.NOT_AVAILABLE)
    expect(result.errorCode).toBe(ErrorCode.COMMAND_NOT_AVAILABLE)
  })

  it('缺必需参数 → INVALID_ARGUMENTS，且**不执行**', async () => {
    const registry = new CommandRegistry()
    let executed = false
    registry.register(
      command({
        parameters: {
          positionals: [{ name: 'ref', required: true, description: '', schema: z.string() }],
        },
        execute: () => {
          executed = true
          return Promise.resolve({ ok: true, code: CommandResultCode.OK, text: '' })
        },
      }),
    )
    const result = await registry.execute(input('/demo'), new FakeHost())
    expect(result.code).toBe(CommandResultCode.INVALID_ARGUMENTS)
    expect(executed).toBe(false)
  })

  it('参数不满足 schema → INVALID_ARGUMENTS', async () => {
    const registry = new CommandRegistry()
    registry.register(
      command({
        parameters: {
          positionals: [
            { name: 'n', required: true, description: '', schema: z.coerce.number().int() },
          ],
        },
      }),
    )
    const result = await registry.execute(input('/demo abc'), new FakeHost())
    expect(result.code).toBe(CommandResultCode.INVALID_ARGUMENTS)
  })

  it('rest 声明必需时为空 → INVALID_ARGUMENTS（/workwith 的指令不能为空）', async () => {
    const registry = new CommandRegistry()
    registry.register(
      command({
        parameters: {
          positionals: [
            { name: 'ref', required: true, description: '', schema: z.string() },
            { name: 'rest', required: true, description: '', schema: z.string() },
          ],
          restFrom: 1,
        },
      }),
    )
    const result = await registry.execute(input('/demo p/m'), new FakeHost())
    expect(result.code).toBe(CommandResultCode.INVALID_ARGUMENTS)
  })

  it('忙碌且 interrupt=never → SESSION_BUSY', async () => {
    const registry = new CommandRegistry()
    registry.register(command())
    const host = new FakeHost()
    host.busy = true
    const result = await registry.execute(input('/demo'), host)
    expect(result.code).toBe(CommandResultCode.SESSION_BUSY)
    expect(result.errorCode).toBe(ErrorCode.SESSION_BUSY)
  })

  it('with-confirmation 未确认 → 要求确认；确认后放行', async () => {
    const registry = new CommandRegistry()
    registry.register(command({ interrupt: 'with-confirmation' }))
    const host = new FakeHost()
    host.busy = true

    const gated = await registry.execute(input('/demo'), host)
    expect(gated.data?.['needsConfirmation']).toBe(true)

    const confirmed = await registry.execute(input('/demo', { confirmInterrupt: true }), host)
    expect(confirmed.ok).toBe(true)
  })

  it('local-principal 命令拒绝其他 principal', async () => {
    const registry = new CommandRegistry()
    registry.register(command({ permission: { kind: 'local-principal' } }))
    const result = await registry.execute(input('/demo', { principalId: 'other' }), new FakeHost())
    expect(result.code).toBe(CommandResultCode.PERMISSION_DENIED)
  })

  it('审计事件在执行**之前**发出（被拒绝的也要留痕）', async () => {
    const registry = new CommandRegistry()
    const order: string[] = []
    registry.register(
      command({
        permission: { kind: 'local-principal' },
        auditEvent: 'command_received',
        execute: () => {
          order.push('execute')
          return Promise.resolve({ ok: true, code: CommandResultCode.OK, text: '' })
        },
      }),
    )
    const host = new FakeHost()
    const originalPublish = host.publish.bind(host)
    host.publish = (i: { type: string; data: unknown }) => {
      order.push(`publish:${i.type}`)
      return originalPublish(i)
    }

    await registry.execute(input('/demo', { principalId: 'other' }), host)
    expect(order).toEqual(['publish:command_received'])
  })

  it('执行抛错 → FAILED 且带稳定错误码，不向上抛', async () => {
    const registry = new CommandRegistry()
    registry.register(
      command({
        execute: () => Promise.reject(new Error('炸了')),
      }),
    )
    const result = await registry.execute(input('/demo'), new FakeHost())
    expect(result.code).toBe(CommandResultCode.FAILED)
    expect(result.errorCode).toBe(ErrorCode.INTERNAL_ERROR)
  })
})

describe('CommandRegistry：幂等', () => {
  const keyed = (executed: string[]) =>
    command({
      name: 'keyed',
      idempotency: { kind: 'keyed', ttlMs: 1000 },
      execute: (ctx) => {
        executed.push(ctx.raw)
        return Promise.resolve({ ok: true, code: CommandResultCode.OK, text: `run:${ctx.raw}` })
      },
    })

  it('同一 Idempotency-Key 第二次回放首次结果，不重复执行', async () => {
    const registry = new CommandRegistry()
    const executed: string[] = []
    registry.register(keyed(executed))
    const host = new FakeHost()

    const first = await registry.execute(input('/keyed', { idempotencyKey: 'k1' }), host)
    const second = await registry.execute(input('/keyed', { idempotencyKey: 'k1' }), host)

    expect(first.text).toBe('run:/keyed')
    expect(second.text).toBe('run:/keyed')
    // 只执行过一次——刷新页面不该重复跑副作用
    expect(executed).toHaveLength(1)
  })

  it('同一 key 用于不同内容 → 报错而不是错误回放', async () => {
    const registry = new CommandRegistry()
    const executed: string[] = []
    registry.register(keyed(executed))
    const host = new FakeHost()

    await registry.execute(input('/keyed a', { idempotencyKey: 'k1' }), host)
    const conflict = await registry.execute(input('/keyed b', { idempotencyKey: 'k1' }), host)

    expect(conflict.code).toBe(CommandResultCode.FAILED)
    expect(conflict.errorCode).toBe(ErrorCode.INVALID_STATE_TRANSITION)
    expect(executed).toHaveLength(1)
  })

  it('read-only 命令不查幂等表', async () => {
    const registry = new CommandRegistry()
    const executed: string[] = []
    registry.register(
      command({
        execute: (ctx) => {
          executed.push(ctx.raw)
          return Promise.resolve({ ok: true, code: CommandResultCode.OK, text: '' })
        },
      }),
    )
    const host = new FakeHost()
    await registry.execute(input('/demo', { idempotencyKey: 'k1' }), host)
    await registry.execute(input('/demo', { idempotencyKey: 'k1' }), host)
    expect(executed).toHaveLength(2)
    expect(host.idempotency.size).toBe(0)
  })
})

describe('CommandRegistry：结果落地', () => {
  it('persistResult 时写入 transcript 并在事件里带 messageId', async () => {
    const registry = new CommandRegistry()
    registry.register(command({ persistResult: true }))
    const host = new FakeHost()

    await registry.execute(input('/demo'), host)

    expect(host.recorded).toHaveLength(1)
    const completed = host.published.find((p) => p.type === 'command_completed')
    // 消息是历史的真相源，事件用 messageId 指向它，客户端据此去重
    expect((completed?.data as { messageId?: string }).messageId).toBe('msg_1')
  })

  it('persistResult 为假时不写 transcript', async () => {
    const registry = new CommandRegistry()
    registry.register(command({ persistResult: false }))
    const host = new FakeHost()
    await registry.execute(input('/demo'), host)
    expect(host.recorded).toHaveLength(0)
  })
})
