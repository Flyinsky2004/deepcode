/**
 * DTO 脱敏。
 *
 * ## 为什么这组测试是安全测试而不是格式测试
 *
 * `parts/09` §1.1：「Web UI 不得接收完整 API key、MCP 环境变量、绝对路径 secrets
 * 或未经脱敏的工具参数」。这条要求一旦被破坏，**不会有任何报错**——密钥只是
 * 安静地出现在浏览器里。所以这里用"往配置里塞一个假密钥，再断言它不在输出中"
 * 的方式把它变成可执行断言。
 */

import { describe, expect, it } from 'vitest'

import type { RuntimeEventEnvelope } from '../../src/core/events.js'
import type { EventId, MessageId, SessionId, TurnId } from '../../src/core/ids.js'
import type { Conversation, Message } from '../../src/core/models.js'
import type { TurnResult } from '../../src/core/turn.js'
import type { ConfigDocument } from '../../src/storage/types.js'
import {
  REDACTED,
  isSensitiveKey,
  redactKeys,
  redactSecrets,
  redactValueShapes,
  renderJson,
  toConfigDto,
  toEventDto,
  toHealthDto,
  toMessageDto,
  toPendingApprovalDto,
  toSessionDto,
  toTurnResultDto,
} from '../../src/clients/web/dto.js'

/** 假密钥。形状与真实 key 一致，但显然是测试值。 */
const FAKE_SECRET = 'sk-ant-FAKE0123456789abcdefghijklmnop'

/** 一份**到处都藏着**假密钥的配置文档。 */
function pollutedConfig(): ConfigDocument {
  return {
    schema_version: 1,
    // 旧项目继承来的自由结构——里面完全可能存着明文 key
    llm_channels: [{ name: 'legacy', api_key: FAKE_SECRET }],
    llm_models: [{ id: 'm1', token: FAKE_SECRET }],
    app_settings: {
      api_key: FAKE_SECRET,
      policy: { http_burst: '5' } as unknown as string,
      'policy.http_burst': '5',
      local_principal_id: 'p-1',
    },
    providers: [
      {
        id: 'p',
        name: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        apiKeyRef: { source: 'env', key: 'ANTHROPIC_API_KEY' },
        createdAt: '',
        updatedAt: '',
        enabled: true,
      },
    ],
    model_profiles: [
      {
        id: 'm1',
        providerId: 'p',
        contextWindow: 200_000,
        maxOutputTokens: 8192,
        supportsThinking: true,
        supportsTools: true,
        supportsVision: false,
        supports1MContext: false,
        enabled: true,
      },
    ],
    tier_assignments: [
      {
        tier: 'implementation',
        modelRef: { providerId: 'p', modelId: 'm1' },
        enabled: true,
        fallbackModelRefs: [{ providerId: 'p', modelId: 'm2' }],
      },
    ],
    mcp_servers: [{ name: 'srv', env: { API_KEY: FAKE_SECRET } }],
  }
}

describe('配置 DTO：白名单 + 脱敏', () => {
  it('⚠️ 输出 JSON 里不含假密钥', () => {
    const dto = toConfigDto(pollutedConfig())
    expect(renderJson(dto)).not.toContain(FAKE_SECRET)
    // 连 key 名都不该出现——说明 `llm_channels` 这类自由结构根本没参与构造
    expect(renderJson(dto)).not.toContain('api_key')
  })

  it('只暴露明确列出的字段', () => {
    const dto = toConfigDto(pollutedConfig())
    expect(dto.providers[0]?.name).toBe('anthropic')
    expect(dto.providers[0]?.hasSecretRef).toBe(true)
    expect(dto.models[0]?.id).toBe('m1')
    expect(dto.tiers[0]?.fallbackCount).toBe(1)
    expect(dto.mcpServerCount).toBe(1)
  })

  it('app_settings 只放行 policy.* —— 其余键（可能含密钥）一律不外泄', () => {
    const dto = toConfigDto(pollutedConfig())
    expect(dto.policySettings).toEqual({ 'policy.http_burst': '5' })
    expect(Object.keys(dto.policySettings)).not.toContain('api_key')
    expect(Object.keys(dto.policySettings)).not.toContain('local_principal_id')
  })
})

describe('redactKeys / redactSecrets', () => {
  it('按键名脱敏，且大小写与连字符变体都命中', () => {
    expect(isSensitiveKey('apiKey')).toBe(true)
    expect(isSensitiveKey('API_KEY')).toBe(true)
    expect(isSensitiveKey('api-key')).toBe(true)
    expect(isSensitiveKey('anthropicApiKey')).toBe(true)
    expect(isSensitiveKey('name')).toBe(false)

    const redacted = redactKeys({
      apiKey: FAKE_SECRET,
      nested: { authorization: 'Bearer x', keep: 'ok' },
      list: [{ password: 'p' }],
    }) as Record<string, unknown>
    expect(redacted['apiKey']).toBe(REDACTED)
    expect((redacted['nested'] as Record<string, unknown>)['authorization']).toBe(REDACTED)
    expect((redacted['nested'] as Record<string, unknown>)['keep']).toBe('ok')
    expect((redacted['list'] as Record<string, unknown>[])[0]?.['password']).toBe(REDACTED)
  })

  it('redactKeys 不按值形态涂——助手正文里出现 "token" 这个词不该被涂掉', () => {
    const result = redactKeys({ text: '讨论 token 这个词' }) as Record<string, unknown>
    expect(result['text']).toBe('讨论 token 这个词')
  })

  it('redactSecrets 额外按值形态脱敏', () => {
    const result = redactSecrets({ content: `key=${FAKE_SECRET}` }) as Record<string, unknown>
    expect(result['content']).toBe(`key=${REDACTED}`)
  })

  it.each([
    ['sk-ant-abcdefgh12345678', 'Anthropic 风格'],
    ['ghp_abcdefghijklmnopqrstuvwxyz0123', 'GitHub'],
    ['AKIAIOSFODNN7EXAMPLE', 'AWS'],
    ['xoxb-1234567890-abcdefghij', 'Slack'],
    ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcd', 'JWT'],
    ['Bearer abcdefghijklmnopqrstuvwx', 'Bearer'],
  ])('值形态 %s（%s）被涂掉', (value) => {
    expect(redactValueShapes(`前 ${value} 后`)).toContain(REDACTED)
    expect(redactValueShapes(`前 ${value} 后`)).not.toContain(value)
  })

  it('普通文本不被误伤（长 base64 / sha 形态不涂）', () => {
    const text = 'commit 9f2c1a4b8e7d6f5a4b3c2d1e0f9a8b7c6d5e4f3a 与 base64 aGVsbG8gd29ybGQ='
    expect(redactValueShapes(text)).toBe(text)
  })

  it('循环引用深度超限时停止下钻，不爆栈', () => {
    const deep: Record<string, unknown> = {}
    let cursor = deep
    for (let index = 0; index < 40; index += 1) {
      const next: Record<string, unknown> = {}
      cursor['next'] = next
      cursor = next
    }
    cursor['leaf'] = FAKE_SECRET
    const result = redactSecrets(deep)
    expect(renderJson(result)).not.toContain(FAKE_SECRET)
  })
})

describe('事件 DTO', () => {
  const envelope = (type: string, data: unknown): RuntimeEventEnvelope => ({
    eventId: 'e1' as EventId,
    sequence: 1,
    type,
    timestamp: '2026-01-01T00:00:00.000Z',
    sessionId: 's1' as SessionId,
    turnId: 'turn_1_s1' as TurnId,
    data,
  })

  it('⚠️ tool_use 的原始入参按值形态脱敏（那是密钥最容易出现的地方）', () => {
    const dto = toEventDto(
      envelope('tool_use', { id: 't1', name: 'write_file', input: { content: FAKE_SECRET } }),
    )
    expect(renderJson(dto)).not.toContain(FAKE_SECRET)
  })

  it('文本类事件**不**按值涂，正文保持完整', () => {
    const dto = toEventDto(envelope('text', { content: `这是 ${FAKE_SECRET} 的说明` }))
    // assistant 正文是用户要看的产出，按值猜测会毁掉正常内容；
    // 密钥防护由"工具入参才按值涂"这条规则承担。
    expect((dto.data as { content: string }).content).toBe(`这是 ${FAKE_SECRET} 的说明`)
  })

  it('载荷里的敏感键名仍然被涂', () => {
    const dto = toEventDto(envelope('some_event', { apiKey: FAKE_SECRET }))
    expect(renderJson(dto)).toContain(REDACTED)
    expect(renderJson(dto)).not.toContain(FAKE_SECRET)
  })

  it('turnId 缺失时为 null，字段名转成 camelCase', () => {
    const dto = toEventDto({
      eventId: 'e2' as EventId,
      sequence: 3,
      type: 'turn_start',
      timestamp: '2026-01-01T00:00:00.000Z',
      sessionId: 's1' as SessionId,
      data: { turn_number: 1 },
    })
    expect(dto.turnId).toBeNull()
    expect(dto.eventId).toBe('e2')
    expect(dto.sequence).toBe(3)
  })
})

describe('其余 DTO', () => {
  it('健康检查只有三个字段，不泄露配置/密钥/路径', () => {
    const dto = toHealthDto({ version: '1.2.3', uptimeMs: 1234.6 })
    expect(dto).toEqual({ ok: true, version: '1.2.3', uptimeMs: 1235 })
    expect(Object.keys(dto).sort()).toEqual(['ok', 'uptimeMs', 'version'])
  })

  it('会话 DTO 标明是否为子代理会话', () => {
    const conversation: Conversation = {
      id: 's1' as SessionId,
      title: '标题',
      total_output_tokens: 10,
      last_input_tokens: 5,
      compacted_message_count: 0,
      current_turn: 2,
      status: 'active',
      parent_conversation_id: '',
      agent_type: '',
      principal_id: 'p',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    }
    expect(toSessionDto(conversation)).toMatchObject({ isSubAgent: false, currentTurn: 2 })
    expect(
      toSessionDto({ ...conversation, parent_conversation_id: 's0' as SessionId }),
    ).toMatchObject({ isSubAgent: true })
  })

  it('消息 DTO 解析 meta 并脱敏；坏 JSON 退化为 null 而不是透传原文', () => {
    const message = (meta: string): Message => ({
      id: 'm1' as MessageId,
      conversation_id: 's1' as SessionId,
      role: 'tool',
      content: '内容',
      created_at: '2026-01-01T00:00:00.000Z',
      turn_id: '',
      subtype: 'normal',
      tool_call_id: null,
      meta,
      agent_type: '',
    })

    expect(toMessageDto(message('{"apiKey":"x","keep":1}')).meta).toEqual({
      apiKey: REDACTED,
      keep: 1,
    })
    expect(toMessageDto(message('{ 坏 JSON')).meta).toBeNull()
    expect(toMessageDto(message('{}')).meta).toBeNull()
    expect(toMessageDto(message('')).turnId).toBeNull()
  })

  it('turn 结果 DTO 保留正文，cancelled 由 status 派生', () => {
    const result: TurnResult = {
      turn_id: 'turn_1_s1' as TurnId,
      status: 'cancelled',
      final_text: '半截产出',
      tool_rounds: 1,
      input_tokens: 10,
      output_tokens: 3,
      error: null,
      num_turns: 2,
      max_turns: 5,
      terminal_reason: null,
      last_tool_error: null,
    }
    const dto = toTurnResultDto(result)
    expect(dto.cancelled).toBe(true)
    expect(dto.finalText).toBe('半截产出')
  })

  it('待审批 DTO 对 args_preview 再涂一遍（最后一道出口）', () => {
    const dto = toPendingApprovalDto({
      requestId: 'r1',
      sessionId: 's1',
      turnId: 't1',
      toolName: 'run_command',
      toolCallId: 'c1',
      argsPreview: `command=curl -H "Authorization: Bearer abcdefghijklmnopqrst"`,
      riskLevel: 'high',
      reason: '需要授权 (second confirmation)',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: 1,
      secondConfirmation: true,
    })
    expect(dto.argsPreview).not.toContain('abcdefghijklmnopqrst')
    expect(dto.secondConfirmation).toBe(true)
  })
})
