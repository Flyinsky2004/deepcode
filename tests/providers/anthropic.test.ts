/**
 * `AnthropicMessagesProvider` 的流解析与错误映射单测。
 *
 * 这些测试**只固化既有实现的行为**，不修改实现。覆盖的重点是错误路径：
 * HTTP 状态码到错误码的映射、SSE 分帧的边界（跨 chunk 的半行、末尾无换行的
 * 残留缓冲）、content block 的增量累积与非法输入。这些都是"出问题时才会走到、
 * 但一旦走错就整轮对话失败"的分支。
 */
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { ErrorCode } from '../../src/core/errors.js'
import { ModelEventType, type Provider } from '../../src/core/provider.js'
import { AnthropicMessagesProvider } from '../../src/providers/anthropic.js'

const provider: Provider = {
  id: 'p',
  name: 'test',
  baseUrl: 'https://api.anthropic.com/',
  apiKeyRef: { source: 'env', key: 'DEEPCODE_TEST_KEY' },
  createdAt: '',
  updatedAt: '',
}

/** 把若干字符串片段拼成一个假的 SSE 响应体。分片边界由调用方控制。 */
function bodyStream(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

function sse(...events: readonly (string | Record<string, unknown>)[]): ReadableStream<Uint8Array> {
  return bodyStream(
    events.map((event) =>
      typeof event === 'string' ? event : `data: ${JSON.stringify(event)}\n\n`,
    ),
  )
}

/** 一次完整的 message_start / ... / message_stop 包裹，方便只关心中间事件。 */
function wrapped(...middle: readonly (string | Record<string, unknown>)[]): ReadableStream {
  return sse({ type: 'message_start', message: { usage: { input_tokens: 7 } } }, ...middle, {
    type: 'message_stop',
  })
}

function makeProvider(
  response: Response | (() => Promise<Response>),
  overrides: Partial<ConstructorParameters<typeof AnthropicMessagesProvider>[0]> = {},
): AnthropicMessagesProvider {
  return new AnthropicMessagesProvider({
    provider,
    resolveSecret: { resolve: () => Promise.resolve('sk-test') },
    fetchImpl: async () => (typeof response === 'function' ? await response() : response),
    ...overrides,
  })
}

async function collect(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const events: unknown[] = []
  for await (const event of stream) events.push(event)
  return events
}

describe('AnthropicMessagesProvider 请求构造与鉴权', () => {
  it('拒绝 thinking 预算不小于 maxTokens 的请求', async () => {
    const instance = makeProvider(new Response(null))
    await expect(
      collect(
        instance.stream(
          {
            model: 'm',
            maxTokens: 100,
            messages: [],
            thinking: { type: 'enabled', budgetTokens: 100 },
          },
          new AbortController().signal,
        ),
      ),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_FAILED })
  })

  it('密钥不可用时拒绝发起请求', async () => {
    const instance = makeProvider(new Response(null), {
      resolveSecret: { resolve: () => Promise.resolve(undefined) },
    })
    await expect(
      collect(instance.stream({ model: 'm', maxTokens: 10, messages: [] }, neverAborts())),
    ).rejects.toMatchObject({ code: ErrorCode.PROVIDER_AUTH_FAILED })
  })

  it('默认解析器支持 env / file / value 三种来源，keychain 返回 undefined', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deepcode-secret-'))
    const secretFile = join(dir, 'key.txt')
    await writeFile(secretFile, '  sk-from-file\n', 'utf8')
    process.env['DEEPCODE_TEST_ENV_KEY'] = 'sk-from-env'

    // 不传 resolveSecret → 走 defaultResolver。密钥来源不同，断言最终发出的 header。
    const captured: string[] = []
    const capture = ((_url: string, init: RequestInit) => {
      captured.push((init.headers as Record<string, string>)['x-api-key']!)
      return Promise.resolve(new Response(sse({ type: 'message_start' }, { type: 'message_stop' })))
    }) as unknown as typeof fetch

    const fromEnv = new AnthropicMessagesProvider({
      provider: { ...provider, apiKeyRef: { source: 'env', key: 'DEEPCODE_TEST_ENV_KEY' } },
      fetchImpl: capture,
    })
    await collect(fromEnv.stream({ model: 'm', maxTokens: 10, messages: [] }, neverAborts()))

    const fromFile = new AnthropicMessagesProvider({
      provider: { ...provider, apiKeyRef: { source: 'file', key: secretFile } },
      fetchImpl: capture,
    })
    await collect(fromFile.stream({ model: 'm', maxTokens: 10, messages: [] }, neverAborts()))

    const fromValue = new AnthropicMessagesProvider({
      provider: {
        ...provider,
        apiKeyRef: { source: 'value', key: 'inline-direct-test-value' },
      },
      fetchImpl: capture,
    })
    await collect(fromValue.stream({ model: 'm', maxTokens: 10, messages: [] }, neverAborts()))

    expect(captured).toEqual(['sk-from-env', 'sk-from-file', 'inline-direct-test-value'])

    // keychain 来源旧实现未落地，默认解析器返回 undefined → 视为密钥不可用。
    const fromKeychain = new AnthropicMessagesProvider({
      provider: { ...provider, apiKeyRef: { source: 'keychain', key: 'entry' } },
      fetchImpl: capture,
    })
    await expect(
      collect(fromKeychain.stream({ model: 'm', maxTokens: 10, messages: [] }, neverAborts())),
    ).rejects.toMatchObject({ code: ErrorCode.PROVIDER_AUTH_FAILED })
  })

  it('拼接 API 根地址，并且只在提供了可选字段时才发送它们', async () => {
    let url = ''
    let payload: Record<string, unknown> = {}
    const instance = makeProvider(new Response(null), {
      fetchImpl: ((input: string, init: RequestInit) => {
        url = input
        payload = JSON.parse(init.body as string) as Record<string, unknown>
        return Promise.resolve(
          new Response(sse({ type: 'message_start' }, { type: 'message_stop' })),
        )
      }) as unknown as typeof fetch,
    })
    await collect(
      instance.stream({ model: 'm', maxTokens: 10, messages: [], tools: [] }, neverAborts()),
    )
    // baseUrl 末尾的 `/` 必须被去掉，否则会拼出 `//v1/messages`。
    expect(url).toBe('https://api.anthropic.com/v1/messages')
    // system / tools / thinking 都是可选字段：未提供时不出现在 body 里。
    expect(payload).not.toHaveProperty('system')
    expect(payload).not.toHaveProperty('tools')
    expect(payload).not.toHaveProperty('thinking')
  })

  it('提供了 system / tools / thinking 时按 Anthropic 形状发送', async () => {
    let payload: Record<string, unknown> = {}
    const instance = makeProvider(new Response(null), {
      apiVersion: '2024-01-01',
      fetchImpl: ((_input: string, init: RequestInit) => {
        payload = JSON.parse(init.body as string) as Record<string, unknown>
        return Promise.resolve(
          new Response(sse({ type: 'message_start' }, { type: 'message_stop' })),
        )
      }) as unknown as typeof fetch,
    })
    await collect(
      instance.stream(
        {
          model: 'm',
          maxTokens: 100,
          messages: [{ role: 'user', content: 'hi' }],
          system: 'sys',
          thinking: { type: 'enabled', budgetTokens: 50 },
          tools: [
            {
              name: 't',
              description: 'd',
              input_schema: { type: 'object' },
              version: '1',
              risk_level: 'low',
              capabilities: [],
              source: { kind: 'native' },
            },
          ],
        },
        neverAborts(),
      ),
    )
    expect(payload).toMatchObject({
      system: 'sys',
      thinking: { type: 'enabled', budget_tokens: 50 },
      tools: [{ name: 't', description: 'd', input_schema: { type: 'object' } }],
      stream: true,
    })
    // 工具声明只发送协议字段：内部元数据（version/risk_level/...）不得泄漏到线上请求。
    expect(Object.keys((payload['tools'] as Record<string, unknown>[])[0]!).sort()).toEqual([
      'description',
      'input_schema',
      'name',
    ])
  })
})

describe('AnthropicMessagesProvider HTTP 错误映射', () => {
  const cases: readonly [number, string, string][] = [
    [401, '', ErrorCode.PROVIDER_AUTH_FAILED],
    [403, '', ErrorCode.PROVIDER_AUTH_FAILED],
    [429, '', ErrorCode.PROVIDER_RATE_LIMITED],
    [500, '', ErrorCode.PROVIDER_UNAVAILABLE],
    [503, '', ErrorCode.PROVIDER_UNAVAILABLE],
    [400, 'prompt is too long: maximum context', ErrorCode.CONTEXT_EXCEEDED],
    [400, 'bad request', ErrorCode.PROVIDER_STREAM_INVALID],
    [418, '', ErrorCode.PROVIDER_CONNECTION_FAILED],
  ]

  for (const [status, body, code] of cases) {
    it(`HTTP ${status} 映射为 ${code}`, async () => {
      const instance = makeProvider(new Response(body, { status }))
      await expect(
        collect(instance.stream({ model: 'm', maxTokens: 10, messages: [] }, neverAborts())),
      ).rejects.toMatchObject({ code, context: { status } })
    })
  }

  it('把 retry-after 头折算成 retryAfterMs；缺失时不带该字段', async () => {
    const withHeader = makeProvider(
      new Response('', { status: 429, headers: { 'retry-after': '3' } }),
    )
    await expect(
      collect(withHeader.stream({ model: 'm', maxTokens: 10, messages: [] }, neverAborts())),
    ).rejects.toMatchObject({ retryAfterMs: 3000 })

    // ️ `AgentError.retryAfterMs` 是**始终存在**的类字段（无值时是 undefined），
    // 所以这里断言值而非 `toHaveProperty`——后者对 undefined 字段也会通过。
    const withoutHeader = makeProvider(new Response('', { status: 429 }))
    await expect(
      collect(withoutHeader.stream({ model: 'm', maxTokens: 10, messages: [] }, neverAborts())),
    ).rejects.toMatchObject({ retryAfterMs: undefined })
  })

  it('响应没有 body 时报告流非法', async () => {
    const instance = makeProvider(new Response(null, { status: 200 }))
    await expect(
      collect(instance.stream({ model: 'm', maxTokens: 10, messages: [] }, neverAborts())),
    ).rejects.toMatchObject({ code: ErrorCode.PROVIDER_STREAM_INVALID })
  })

  it('fetch 抛 TypeError 时归类为连接失败', async () => {
    const instance = makeProvider(new Response(null), {
      fetchImpl: (() => Promise.reject(new TypeError('fetch failed'))) as unknown as typeof fetch,
    })
    await expect(
      collect(instance.stream({ model: 'm', maxTokens: 10, messages: [] }, neverAborts())),
    ).rejects.toMatchObject({ code: ErrorCode.PROVIDER_CONNECTION_FAILED })
  })

  it('AbortError 原样抛出，不被包装成供应商错误', async () => {
    const abortError = new Error('aborted')
    abortError.name = 'AbortError'
    const instance = makeProvider(new Response(null), {
      fetchImpl: (() => Promise.reject(abortError)) as unknown as typeof fetch,
    })
    await expect(
      collect(instance.stream({ model: 'm', maxTokens: 10, messages: [] }, neverAborts())),
    ).rejects.toBe(abortError)
  })

  it('其它抛出物走通用错误转换', async () => {
    const instance = makeProvider(new Response(null), {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      fetchImpl: (() => Promise.reject('plain string')) as unknown as typeof fetch,
    })
    await expect(
      collect(instance.stream({ model: 'm', maxTokens: 10, messages: [] }, neverAborts())),
    ).rejects.toMatchObject({ code: ErrorCode.INTERNAL_ERROR })
  })

  it('超时后中止 fetch', async () => {
    const instance = makeProvider(new Response(null), {
      timeoutMs: 5,
      fetchImpl: ((_input: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const error = new Error('timed out')
            error.name = 'AbortError'
            reject(error)
          })
        })) as unknown as typeof fetch,
    })
    await expect(
      collect(instance.stream({ model: 'm', maxTokens: 10, messages: [] }, neverAborts())),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('AnthropicMessagesProvider SSE 解析', () => {
  it('累积文本增量、思考块与工具调用，并回传用量', async () => {
    const instance = makeProvider(
      new Response(
        sse(
          { type: 'message_start', message: { usage: { input_tokens: 11 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '好' } },
          { type: 'content_block_stop', index: 0 },
          {
            type: 'content_block_start',
            index: 1,
            content_block: { type: 'thinking', thinking: '前缀' },
          },
          {
            type: 'content_block_delta',
            index: 1,
            delta: { type: 'thinking_delta', thinking: '继续' },
          },
          {
            type: 'content_block_delta',
            index: 1,
            delta: { type: 'signature_delta', signature: 'sig' },
          },
          { type: 'content_block_stop', index: 1 },
          {
            type: 'content_block_start',
            index: 2,
            content_block: { type: 'tool_use', id: 'tool-1', name: 'file_read' },
          },
          {
            type: 'content_block_delta',
            index: 2,
            delta: { type: 'input_json_delta', partial_json: '{"path":' },
          },
          {
            type: 'content_block_delta',
            index: 2,
            delta: { type: 'input_json_delta', partial_json: '"a.ts"}' },
          },
          { type: 'content_block_stop', index: 2 },
          { type: 'message_delta', usage: { output_tokens: 5 } },
          { type: 'message_stop' },
        ),
      ),
    )
    const stream = instance.stream({ model: 'm', maxTokens: 10, messages: [] }, neverAborts())
    const events = await collect(stream)
    expect(events).toEqual([
      { type: ModelEventType.TEXT, content: '你' },
      { type: ModelEventType.TEXT, content: '好' },
      // thinking 事件的文本是「起始 thinking 字段 + 增量」，签名单独累积。
      { type: ModelEventType.THINKING, thinking: '前缀继续', signature: 'sig' },
      { type: ModelEventType.TOOL_USE, id: 'tool-1', name: 'file_read', input: { path: 'a.ts' } },
    ])
    expect(stream.usage).toEqual({ inputTokens: 11, outputTokens: 5 })
    expect(instance.lastUsage).toEqual({ inputTokens: 11, outputTokens: 5 })
  })

  it('工具调用没有增量 JSON 时回退到 content_block_start 里的 input', async () => {
    const instance = makeProvider(
      new Response(
        wrapped(
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 't', name: 'n', input: { k: 1 } },
          },
          { type: 'content_block_stop', index: 0 },
        ),
      ),
    )
    const events = await collect(
      instance.stream({ model: 'm', maxTokens: 10, messages: [] }, neverAborts()),
    )
    expect(events).toEqual([{ type: ModelEventType.TOOL_USE, id: 't', name: 'n', input: { k: 1 } }])
  })

  it('工具输入 JSON 非法时报告流非法', async () => {
    const instance = makeProvider(
      new Response(
        wrapped(
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 't', name: 'n' },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '{oops' },
          },
          { type: 'content_block_stop', index: 0 },
        ),
      ),
    )
    await expect(
      collect(instance.stream({ model: 'm', maxTokens: 10, messages: [] }, neverAborts())),
    ).rejects.toMatchObject({ code: ErrorCode.PROVIDER_STREAM_INVALID })
  })

  it('工具调用缺 id 或 name 时不产出事件', async () => {
    const instance = makeProvider(
      new Response(
        wrapped(
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', name: 'n' },
          },
          { type: 'content_block_stop', index: 0 },
        ),
      ),
    )
    await expect(
      collect(instance.stream({ model: 'm', maxTokens: 10, messages: [] }, neverAborts())),
    ).resolves.toEqual([])
  })

  it('未知 content block 类型与重复 index 都判定为流非法', async () => {
    const unknownType = makeProvider(
      new Response(
        wrapped({ type: 'content_block_start', index: 0, content_block: { type: 'image' } }),
      ),
    )
    await expect(
      collect(unknownType.stream({ model: 'm', maxTokens: 10, messages: [] }, neverAborts())),
    ).rejects.toMatchObject({ code: ErrorCode.PROVIDER_STREAM_INVALID })

    const duplicate = makeProvider(
      new Response(
        wrapped(
          { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
        ),
      ),
    )
    await expect(
      collect(duplicate.stream({ model: 'm', maxTokens: 10, messages: [] }, neverAborts())),
    ).rejects.toMatchObject({ code: ErrorCode.PROVIDER_STREAM_INVALID })
  })

  it('缺少 index 时按当前块数量/0 兜底，未知索引的增量被忽略', async () => {
    const instance = makeProvider(
      new Response(
        wrapped(
          // 没有 index → 用 blocks.size（0）作为隐式索引。
          { type: 'content_block_start', content_block: { type: 'text' } },
          // 没有 index 的增量 → 落到 0 号块。
          { type: 'content_block_delta', delta: { type: 'text_delta', text: 'a' } },
          // 指向不存在的块 → continue，不抛错。
          { type: 'content_block_delta', index: 9, delta: { type: 'text_delta', text: 'x' } },
          { type: 'content_block_stop', index: 9 },
        ),
      ),
    )
    await expect(
      collect(instance.stream({ model: 'm', maxTokens: 10, messages: [] }, neverAborts())),
    ).resolves.toEqual([{ type: ModelEventType.TEXT, content: 'a' }])
  })

  it('未知 delta 类型被静默忽略', async () => {
    const instance = makeProvider(
      new Response(
        wrapped(
          { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'citations_delta' } },
        ),
      ),
    )
    await expect(
      collect(instance.stream({ model: 'm', maxTokens: 10, messages: [] }, neverAborts())),
    ).resolves.toEqual([])
  })

  it('provider 显式下发 error 事件时抛出', async () => {
    const instance = makeProvider(
      new Response(sse({ type: 'message_start' }, { type: 'error' }, { type: 'message_stop' })),
    )
    await expect(
      collect(instance.stream({ model: 'm', maxTokens: 10, messages: [] }, neverAborts())),
    ).rejects.toMatchObject({ code: ErrorCode.PROVIDER_STREAM_INVALID })
  })

  it('流缺 message_start 或 message_stop 时抛出', async () => {
    const noStart = makeProvider(new Response(sse({ type: 'message_stop' })))
    await expect(
      collect(noStart.stream({ model: 'm', maxTokens: 10, messages: [] }, neverAborts())),
    ).rejects.toMatchObject({ code: ErrorCode.PROVIDER_STREAM_INVALID })

    const noStop = makeProvider(new Response(sse({ type: 'message_start' })))
    await expect(
      collect(noStop.stream({ model: 'm', maxTokens: 10, messages: [] }, neverAborts())),
    ).rejects.toMatchObject({ code: ErrorCode.PROVIDER_STREAM_INVALID })
  })

  it('处理跨 chunk 断行、无 data 前缀的行、[DONE] 与末尾残留缓冲', async () => {
    // 分片刻意切在 JSON 中间：解析器必须靠行缓冲拼回来。
    const instance = makeProvider(
      new Response(
        bodyStream([
          ': keep-alive\n\ndata: {"type":"message_st',
          'art"}\n\nevent: ping\ndata: {"type":"content_bl',
          'ock_start","index":0,"content_block":{"type":"text"}}\n\n',
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"z"}}\n\n',
          'data: {"type":"message_stop"}\n\n',
          'data: [DONE]\n\n',
        ]),
      ),
    )
    await expect(
      collect(instance.stream({ model: 'm', maxTokens: 10, messages: [] }, neverAborts())),
    ).resolves.toEqual([{ type: ModelEventType.TEXT, content: 'z' }])
  })

  it('最后一帧没有换行时仍会解析残留缓冲', async () => {
    // 流结束时 buffer 里还留着一条完整的 data 行（末尾无 \n），走 357-375 的收尾分支。
    const instance = makeProvider(
      new Response(
        bodyStream([
          'data: {"type":"message_start"}\n\ndata: {"type":"message_stop"}\n\ndata: {"type":"message_sto',
        ]),
      ),
    )
    // 残留的是被截断的 JSON → 收尾分支里的解析失败要抛流非法。
    await expect(
      collect(instance.stream({ model: 'm', maxTokens: 10, messages: [] }, neverAborts())),
    ).rejects.toMatchObject({ code: ErrorCode.PROVIDER_STREAM_INVALID })
  })

  it('残留缓冲是 [DONE] 时不做任何事', async () => {
    const instance = makeProvider(
      new Response(
        bodyStream([
          'data: {"type":"message_start"}\n\ndata: {"type":"message_stop"}\n\ndata: [DONE]',
        ]),
      ),
    )
    await expect(
      collect(instance.stream({ model: 'm', maxTokens: 10, messages: [] }, neverAborts())),
    ).resolves.toEqual([])
  })

  it('data 行不是合法 JSON 时报告流非法', async () => {
    const instance = makeProvider(new Response(bodyStream(['data: {not json}\n\n'])))
    await expect(
      collect(instance.stream({ model: 'm', maxTokens: 10, messages: [] }, neverAborts())),
    ).rejects.toMatchObject({ code: ErrorCode.PROVIDER_STREAM_INVALID })
  })

  it('data 行是合法 JSON 但不是 object 时被跳过', async () => {
    const instance = makeProvider(
      new Response(
        bodyStream([
          'data: 42\n\ndata: [1,2]\n\ndata: {"type":"message_start"}\n\ndata: {"type":"message_stop"}\n\n',
        ]),
      ),
    )
    await expect(
      collect(instance.stream({ model: 'm', maxTokens: 10, messages: [] }, neverAborts())),
    ).resolves.toEqual([])
  })

  it('用量字段非数字时按 0 计', async () => {
    const instance = makeProvider(
      new Response(
        sse(
          { type: 'message_start', message: { usage: { input_tokens: 'many' } } },
          { type: 'message_delta', usage: { output_tokens: Number.NaN } },
          { type: 'message_stop' },
        ),
      ),
    )
    const stream = instance.stream({ model: 'm', maxTokens: 10, messages: [] }, neverAborts())
    await collect(stream)
    expect(stream.usage).toEqual({ inputTokens: 0, outputTokens: 0 })
  })

  it('usage 再嵌套一层 usage 时仍能读出（兼容两种下发形状）', async () => {
    const instance = makeProvider(
      new Response(
        sse(
          { type: 'message_start', message: { usage: { input_tokens: 3 } } },
          { type: 'message_delta', usage: { usage: { output_tokens: 4 } } },
          { type: 'message_stop' },
        ),
      ),
    )
    const stream = instance.stream({ model: 'm', maxTokens: 10, messages: [] }, neverAborts())
    await collect(stream)
    expect(stream.usage).toEqual({ inputTokens: 3, outputTokens: 4 })
  })

  it('message_start 缺少 message 字段时输入用量按 0 计', async () => {
    const instance = makeProvider(
      new Response(sse({ type: 'message_start' }, { type: 'message_stop' })),
    )
    const stream = instance.stream({ model: 'm', maxTokens: 10, messages: [] }, neverAborts())
    await collect(stream)
    expect(stream.usage).toEqual({ inputTokens: 0, outputTokens: 0 })
  })

  it('未完成流时 usage getter 返回 undefined', () => {
    const instance = makeProvider(new Response(null))
    const stream = instance.stream({ model: 'm', maxTokens: 10, messages: [] }, neverAborts())
    expect(stream.usage).toBeUndefined()
    expect(instance.lastUsage).toBeUndefined()
  })
})

describe('AnthropicMessagesProvider.probe', () => {
  it('探针按实际事件报告工具与思考能力', async () => {
    const instance = makeProvider(
      new Response(
        sse(
          { type: 'message_start' },
          { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_stop' },
        ),
      ),
    )
    await expect(instance.probe(neverAborts())).resolves.toEqual({
      ok: true,
      capabilities: { streaming: true, tools: false, thinking: true, usage: true },
    })
  })

  it('探针失败时返回结构化错误而不是抛出', async () => {
    const instance = makeProvider(new Response('', { status: 401 }))
    await expect(instance.probe(neverAborts())).resolves.toMatchObject({
      ok: false,
      errorCode: ErrorCode.PROVIDER_AUTH_FAILED,
      capabilities: { streaming: false, tools: false, thinking: false, usage: false },
    })
  })
})

/** 不需要取消语义的用例统一用它，避免每个用例都建一个 controller。 */
function neverAborts(): AbortSignal {
  return new AbortController().signal
}
