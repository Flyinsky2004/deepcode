import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ToolContext } from '../../src/core/tool.js'
import {
  createWebFetchTool,
  createWebSearchTool,
  isPublicAddress,
  type PageRequester,
} from '../../src/tools/web-tools.js'

function context(turnState: Record<string, unknown> = {}): ToolContext {
  return {
    sessionId: 's1' as ToolContext['sessionId'],
    turnId: 't1' as ToolContext['turnId'],
    principalId: 'p1',
    workspaceRoot: '/workspace',
    allowedReadRoots: ['/workspace'],
    allowedWriteRoots: ['/workspace'],
    turnState,
    budget: {} as ToolContext['budget'],
    signal: new AbortController().signal,
  }
}

afterEach(() => vi.unstubAllEnvs())

describe('web_fetch', () => {
  it('extracts page text, decodes entities, follows a public redirect, and includes final URL', async () => {
    const requester = vi.fn<PageRequester>((url) =>
      Promise.resolve(
        url.pathname === '/start'
          ? { status: 302, headers: { location: '/final' }, body: Buffer.alloc(0) }
          : {
              status: 200,
              headers: { 'content-type': 'text/html; charset=utf-8' },
              body: Buffer.from(
                '<html><head><title>Hidden</title></head><body><h1>A &amp; B</h1><script>ignore()</script><p>One&nbsp;two</p></body></html>',
              ),
            },
      ),
    )
    const tool = createWebFetchTool(requester)
    const output = await tool.execute(context(), {
      url: 'https://example.com/start',
      prompt: 'heading',
    })
    expect(output).toMatchObject({
      ok: true,
      error_code: null,
      data: { url: 'https://example.com/final' },
    })
    expect(output.content).toContain('A & B')
    expect(output.content).toContain('One two')
    expect(output.content).toContain('Extract info about: heading')
    expect(output.content).not.toContain('Hidden')
    expect(output.content).not.toContain('ignore()')
    expect(requester).toHaveBeenCalledTimes(2)
  })

  it('rejects local destinations and redirects before making a local request', async () => {
    const requester = vi.fn<PageRequester>(() =>
      Promise.resolve({
        status: 302,
        headers: { location: 'http://127.0.0.1/admin' },
        body: Buffer.alloc(0),
      }),
    )
    const tool = createWebFetchTool(requester)
    expect(tool.safetyCheck?.({ url: 'http://127.0.0.1/' }, context())).toMatchObject({
      action: 'deny',
    })
    expect(await tool.execute(context(), { url: 'http://127.0.0.1/' })).toMatchObject({
      ok: false,
      error_code: 'UNSAFE_URL',
    })
    expect(requester).not.toHaveBeenCalled()
    expect(await tool.execute(context(), { url: 'example.com/' })).toMatchObject({
      ok: false,
      error_code: 'UNSAFE_URL',
    })
    expect(requester).toHaveBeenCalledTimes(1)
  })

  it('applies domain policy to requested and redirected URLs', async () => {
    const requester = vi.fn<PageRequester>(() =>
      Promise.resolve({
        status: 302,
        headers: { location: 'https://other.example/page' },
        body: Buffer.alloc(0),
      }),
    )
    const tool = createWebFetchTool(requester)
    const ctx = context({
      web_allowed_domains: 'example.com',
      web_denied_domains: 'blocked.example.com',
    })
    expect(tool.safetyCheck?.({ url: 'https://blocked.example.com' }, ctx)).toMatchObject({
      action: 'deny',
    })
    expect(tool.safetyCheck?.({ url: 'https://notexample.com' }, ctx)).toMatchObject({
      action: 'deny',
    })
    expect(await tool.execute(ctx, { url: 'https://example.com' })).toMatchObject({
      ok: false,
      error_code: 'UNSAFE_URL',
    })
    expect(requester).toHaveBeenCalledTimes(1)
  })

  it('rejects unsupported schemes, content types and oversized responses', async () => {
    const tool = createWebFetchTool(() =>
      Promise.resolve({
        status: 200,
        headers: { 'content-type': 'application/pdf' },
        body: Buffer.alloc(0),
      }),
    )
    expect(await tool.execute(context(), { url: 'ftp://example.com' })).toMatchObject({
      ok: false,
      error_code: 'INVALID_INPUT',
    })
    expect(await tool.execute(context(), { url: 'https://example.com' })).toMatchObject({
      ok: false,
      error_code: 'UNSUPPORTED_CONTENT',
    })
    const large = createWebFetchTool(() =>
      Promise.resolve({
        status: 200,
        headers: {},
        body: Buffer.alloc(2_000_001),
      }),
    )
    expect(await large.execute(context(), { url: 'https://example.com' })).toMatchObject({
      ok: false,
      error_code: 'RESPONSE_TOO_LARGE',
    })
  })

  it('blocks non-public IPs, including IPv6, and allows public addresses', () => {
    for (const address of [
      '127.0.0.1',
      '10.0.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '::1',
      '0:0:0:0:0:0:0:1',
      'fc00::1',
      '2001:db8::1',
      '2001:0000::1',
      '192.0.0.10',
      '::ffff:127.0.0.1',
    ])
      expect(isPublicAddress(address), address).toBe(false)
    expect(isPublicAddress('1.1.1.1')).toBe(true)
    expect(isPublicAddress('2001:4860:4860::8888')).toBe(true)
  })
})

describe('web_search', () => {
  it('requires an API key and returns actionable configuration guidance', async () => {
    vi.stubEnv('DEEPCODE_BRAVE_SEARCH_API_KEY', '')
    const tool = createWebSearchTool()
    expect(await tool.execute(context(), { query: 'typescript' })).toMatchObject({
      ok: false,
      error_code: 'NOT_CONFIGURED',
    })
    expect(tool.validate({ query: '' }).ok).toBe(false)
  })

  it('calls Brave and filters results by exact or subdomain', async () => {
    vi.stubEnv('DEEPCODE_BRAVE_SEARCH_API_KEY', 'test-key')
    const searchFetch = vi.fn((_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ 'X-Subscription-Token': 'test-key' })
      return Promise.resolve(
        new Response(
          JSON.stringify({
            web: {
              results: [
                {
                  title: 'Good',
                  url: 'https://docs.example.com/a',
                  description: '<b>Useful &amp; current</b>',
                },
                { title: 'Blocked', url: 'https://bad.docs.example.com/b', description: 'Ignore' },
                { title: 'Other', url: 'https://example.net/c', description: 'Ignore' },
              ],
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      )
    })
    const tool = createWebSearchTool(searchFetch)
    const output = await tool.execute(context(), {
      query: 'test query',
      allowed_domains: ['example.com'],
      blocked_domains: ['bad.docs.example.com'],
    })
    expect(output).toMatchObject({ ok: true, data: { result_count: 1 } })
    expect(output.content).toContain('https://docs.example.com/a')
    expect(output.content).toContain('Useful & current')
    expect(output.content).not.toContain('example.net')
    const searchUrl = searchFetch.mock.calls[0]?.[0]
    expect(searchUrl).toBeInstanceOf(URL)
    if (searchUrl instanceof URL) expect(searchUrl.searchParams.get('q')).toBe('test query')
  })

  it('maps provider and malformed-response errors', async () => {
    vi.stubEnv('DEEPCODE_BRAVE_SEARCH_API_KEY', 'test-key')
    const unavailable = createWebSearchTool(() =>
      Promise.resolve(new Response('', { status: 429 })),
    )
    expect(await unavailable.execute(context(), { query: 'test' })).toMatchObject({
      ok: false,
      error_code: 'HTTP_ERROR',
      data: { status: 429 },
    })
    const malformed = createWebSearchTool(() => Promise.resolve(new Response('not json')))
    expect(await malformed.execute(context(), { query: 'test' })).toMatchObject({
      ok: false,
      error_code: 'INVALID_RESPONSE',
    })
  })
})
