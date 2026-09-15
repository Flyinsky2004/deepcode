/**
 * CommandRegistry 的**剩余分支**补充：边界输入与"坏 host"路径。
 *
 * `registry.test.ts` 已经覆盖了主流程；这里只补三类容易漏的分支：
 * 1. 参数切出来是**空串**（用户写了 `""`）——它与"没写"在语义上不同，
 *    但对 `required` 来说同样是"没给"；
 * 2. `schema` 失败但**没有 issues**——zod 正常不会这样，可一旦哪个自定义
 *    schema 这么返回，不能让 `issues[0]?.message` 把整条命令打成异常；
 * 3. host 的审计/落盘/幂等接口**抛错**时命令仍然要出结果——事件与消息
 *    是旁路，不能因为它们故障就让用户看到"命令失败"。
 */
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

/** 与 registry.test.ts 同形的假 host，额外支持按需让某个方法抛错。 */
class FakeHost implements CommandHost {
  readonly localPrincipalId = LOCAL
  readonly published: { type: string; data: unknown }[] = []
  readonly idempotency = new Map<string, { requestHash: string; response: unknown }>()
  readonly recorded: { command: string; text: string }[] = []
  busy = false
  /** 让 publish / recordCommandResult / putIdempotency 抛错。 */
  failPublish = false
  failRecord = false
  failPutIdempotency = false

  listSessions() {
    return Promise.resolve([] as const)
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
    return Promise.resolve({} as never)
  }
  updateConfig(): Promise<void> {
    return Promise.resolve()
  }
  updateModelPreferences(): Promise<void> {
    return Promise.resolve()
  }
  publish(input: { type: string; data: unknown }): Promise<void> {
    if (this.failPublish) return Promise.reject(new Error('事件写入失败'))
    this.published.push({ type: input.type, data: input.data })
    return Promise.resolve()
  }
  getIdempotency(key: string) {
    return Promise.resolve(this.idempotency.get(key))
  }
  putIdempotency(record: { key: string; requestHash: string; response: unknown }): Promise<void> {
    if (this.failPutIdempotency) return Promise.reject(new Error('幂等写回失败'))
    this.idempotency.set(record.key, {
      requestHash: record.requestHash,
      response: record.response,
    })
    return Promise.resolve()
  }
  recordCommandResult(input: { command: string; result: { text: string } }): Promise<string> {
    if (this.failRecord) return Promise.reject(new Error('消息写入失败'))
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

describe('CommandRegistry：注册表自身的接口', () => {
  it('registerAll 批量注册，names() 返回主名（不含别名）', () => {
    const registry = new CommandRegistry()
    registry.registerAll([
      command({ name: 'model', aliases: ['m'] }),
      command({ name: 'context', aliases: ['1m'] }),
    ])
    expect(registry.names()).toEqual(['model', 'context'])
    expect(registry.get('m')?.name).toBe('model')
  })

  it('别名与已有命令名冲突时同样报错', () => {
    // 别名占用了一个真实命令名会让后者永远注册不上——必须显式失败
    const registry = new CommandRegistry()
    registry.register(command({ name: 'model' }))
    expect(() => registry.register(command({ name: 'other', aliases: ['model'] }))).toThrow(
      /命令名重复/,
    )
  })
})

describe('CommandRegistry：会话与参数边界', () => {
  it('没有会话归属时不查忙碌状态（/api 这类全局命令不受 turn 影响）', async () => {
    const registry = new CommandRegistry()
    let isBusyCalls = 0
    registry.register(command())
    const host = new FakeHost()
    host.busy = true
    const original = host.isBusy.bind(host)
    host.isBusy = () => {
      isBusyCalls++
      return original()
    }

    const result = await registry.execute(input('/demo', { sessionId: undefined }), host)

    expect(result.ok).toBe(true)
    // 关键：忙碌检查根本没被调用，而不是"调用了但结果被忽略"
    expect(isBusyCalls).toBe(0)
  })

  it('interrupt=always 的命令即使会话忙也放行（不需要二次确认）', async () => {
    // 这类命令的语义就是"打断并接管"，忙碌不是拒绝理由
    const registry = new CommandRegistry()
    registry.register(command({ interrupt: 'always' }))
    const host = new FakeHost()
    host.busy = true

    const result = await registry.execute(input('/demo'), host)
    expect(result.ok).toBe(true)
  })

  it('引号包出来的空串等同于"没给参数"', async () => {
    // `""` 切出来是 ''（不是 undefined），required 判定必须同时覆盖这两种
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

    const result = await registry.execute(input('/demo ""'), new FakeHost())
    expect(result.code).toBe(CommandResultCode.INVALID_ARGUMENTS)
    expect(result.text).toMatch(/缺少参数：ref/)
    expect(executed).toBe(false)
  })

  it('可选参数为空串时跳过校验，命令照常执行', async () => {
    const registry = new CommandRegistry()
    registry.register(
      command({
        parameters: {
          positionals: [{ name: 'note', required: false, description: '', schema: z.string() }],
        },
      }),
    )
    const result = await registry.execute(input('/demo ""'), new FakeHost())
    expect(result.ok).toBe(true)
  })

  it('schema 报错但 issues 为空时退回通用文案，而不是抛出', async () => {
    // 自定义 schema（如基于外部校验器包装的）可能返回空的 issues；
    // 直接读 issues[0].message 会把一条"参数非法"变成未捕获异常。
    const registry = new CommandRegistry()
    registry.register(
      command({
        parameters: {
          positionals: [
            {
              name: 'ref',
              required: true,
              description: '',
              schema: {
                safeParse: () => ({ success: false as const, error: { issues: [] } }),
              } as unknown as z.ZodType<unknown>,
            },
          ],
        },
      }),
    )

    const result = await registry.execute(input('/demo x'), new FakeHost())
    expect(result.code).toBe(CommandResultCode.INVALID_ARGUMENTS)
    expect(result.text).toContain('格式不正确')
  })
})

describe('CommandRegistry：host 旁路故障不影响命令结果', () => {
  it('审计事件写不进去时命令仍然执行（事件是旁路，不是前置条件）', async () => {
    const registry = new CommandRegistry()
    let executed = false
    registry.register(
      command({
        execute: () => {
          executed = true
          return Promise.resolve({ ok: true, code: CommandResultCode.OK, text: 'done' })
        },
      }),
    )
    const host = new FakeHost()
    host.failPublish = true

    const result = await registry.execute(input('/demo'), host)
    expect(executed).toBe(true)
    expect(result.ok).toBe(true)
  })

  it('结果无法落盘时返回 ok 但 messageId 为 null（不假装写成功了）', async () => {
    const registry = new CommandRegistry()
    registry.register(command({ persistResult: true }))
    const host = new FakeHost()
    host.failRecord = true

    const result = await registry.execute(input('/demo'), host)
    expect(result.ok).toBe(true)
    // 落盘失败必须体现为 messageId: null，客户端据此不去历史里找这条消息
    const completed = host.published.find((p) => p.type === 'command_completed')
    expect((completed?.data as { messageId: string | null }).messageId).toBeNull()
  })

  it('幂等写回失败不影响本次结果（下次重放会重跑，但不会骗用户）', async () => {
    const registry = new CommandRegistry()
    let runs = 0
    registry.register(
      command({
        idempotency: { kind: 'keyed', ttlMs: 1000 },
        execute: () => {
          runs++
          return Promise.resolve({ ok: true, code: CommandResultCode.OK, text: 'done' })
        },
      }),
    )
    const host = new FakeHost()
    host.failPutIdempotency = true

    const result = await registry.execute(input('/demo', { idempotencyKey: 'k1' }), host)
    expect(result.ok).toBe(true)
    expect(runs).toBe(1)
    expect(host.idempotency.size).toBe(0)
  })

  it('keyed 命令未带幂等键时退化为一普通命令（不查、不写幂等表）', async () => {
    const registry = new CommandRegistry()
    let runs = 0
    registry.register(
      command({
        idempotency: { kind: 'keyed', ttlMs: 1000 },
        execute: () => {
          runs++
          return Promise.resolve({ ok: true, code: CommandResultCode.OK, text: 'done' })
        },
      }),
    )
    const host = new FakeHost()

    await registry.execute(input('/demo'), host)
    await registry.execute(input('/demo'), host)

    // 没有键就无从去重——两次都必须真的执行，且不污染幂等表
    expect(runs).toBe(2)
    expect(host.idempotency.size).toBe(0)
  })

  it('执行抛出的非 Error（字符串）也被折成稳定错误码', async () => {
    const registry = new CommandRegistry()
    registry.register(
      command({
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        execute: () => Promise.reject('裸字符串'),
      }),
    )
    const result = await registry.execute(input('/demo'), new FakeHost())
    expect(result.code).toBe(CommandResultCode.FAILED)
    expect(result.errorCode).toBe(ErrorCode.INTERNAL_ERROR)
  })
})
