import { lookup } from 'node:dns/promises'
import { request as httpRequest, type IncomingHttpHeaders, type RequestOptions } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib'
import { z } from 'zod'

import { PermissionAction, type Tool, type ToolContext, type ToolResult } from '../core/tool.js'

const MAX_RESPONSE_BYTES = 2_000_000
const MAX_TEXT_CHARS = 50_000
const REQUEST_TIMEOUT_MS = 30_000
const MAX_REDIRECTS = 5
const SEARCH_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search'

function result(
  content: string,
  error_code: string | null,
  data?: Record<string, unknown>,
): ToolResult {
  return { ok: error_code === null, content, ...(data ? { data } : {}), error_code, meta: {} }
}

function validate(schema: z.ZodType, input: unknown): ReturnType<Tool['validate']> {
  const parsed = schema.safeParse(input)
  return parsed.success
    ? { ok: true, value: parsed.data as Record<string, unknown> }
    : {
        ok: false,
        errors: parsed.error.issues.map((issue) => ({
          path: issue.path.filter(
            (part): part is string | number => typeof part === 'string' || typeof part === 'number',
          ),
          message: issue.message,
        })),
      }
}

function normalizedUrl(raw: string): URL {
  const value = raw.trim()
  if (!value) throw new WebError('URL is required', 'INVALID_INPUT')
  const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`)
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password)
    throw new WebError(
      'Only HTTP(S) URLs without embedded credentials are supported',
      'INVALID_INPUT',
    )
  return url
}

function domainMatches(hostname: string, domain: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  const rule = domain.toLowerCase().trim().replace(/^\./, '').replace(/\.$/, '')
  return !!rule && (host === rule || host.endsWith(`.${rule}`))
}

function domainList(value: unknown): string[] {
  if (typeof value === 'string')
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

/** Reject loopback, link-local, private, multicast and other non-public destinations. */
export function isPublicAddress(address: string): boolean {
  const normalized = address.replace(/^\[|\]$/g, '')
  const family = isIP(normalized)
  if (family === 4) {
    const octets = normalized.split('.').map(Number)
    const [a = 0, b = 0, c = 0] = octets
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    )
  }
  if (family === 6) {
    const lower = normalized.toLowerCase()
    if (lower.includes('.')) {
      const mapped = lower.match(/(?:^|:)ffff:(\d+\.\d+\.\d+\.\d+)$/)
      if (mapped) return isPublicAddress(mapped[1]!)
    }
    const segments = lower.split(':')
    const first = Number.parseInt(segments[0] || '0', 16)
    const second = Number.parseInt(segments[1] || '0', 16)
    return !(
      (first & 0xe000) !== 0x2000 ||
      (first === 0x2001 && (second === 0 || second === 0x0db8)) ||
      first === 0x2002
    )
  }
  return false
}

class WebError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
  }
}

async function publicAddress(
  hostname: string,
  signal: AbortSignal,
): Promise<{ address: string; family: 4 | 6 }> {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local'))
    throw new WebError('Local network addresses are not allowed', 'UNSAFE_URL')
  const literalFamily = isIP(host)
  if (literalFamily) {
    if (!isPublicAddress(host))
      throw new WebError('Local network addresses are not allowed', 'UNSAFE_URL')
    return { address: host, family: literalFamily as 4 | 6 }
  }
  const addresses = await lookup(host, { all: true })
  if (addresses.length && addresses.every((entry) => isFakeIpAddress(entry.address)))
    return resolveThroughPublicDns(host, signal)
  if (!addresses.length || addresses.some((entry) => !isPublicAddress(entry.address)))
    throw new WebError('URL resolves to a non-public address', 'UNSAFE_URL')
  return addresses[0] as { address: string; family: 4 | 6 }
}

function isFakeIpAddress(address: string): boolean {
  const parts = address.split('.').map(Number)
  return isIP(address) === 4 && parts[0] === 198 && (parts[1] === 18 || parts[1] === 19)
}

/** Some TUN proxies return 198.18/15 fake IPs. Resolve the real public IP and pin the connection to it. */
async function resolveThroughPublicDns(
  hostname: string,
  signal: AbortSignal,
): Promise<{ address: string; family: 4 | 6 }> {
  const answers = await Promise.allSettled(
    ['A', 'AAAA'].map(async (type) => {
      const endpoint = new URL('https://cloudflare-dns.com/dns-query')
      endpoint.searchParams.set('name', hostname)
      endpoint.searchParams.set('type', type)
      const response = await fetch(endpoint, {
        headers: { Accept: 'application/dns-json' },
        redirect: 'error',
        signal,
      })
      if (!response.ok) throw new WebError('Public DNS lookup failed', 'NETWORK_ERROR')
      const payload: unknown = JSON.parse((await readFetchBody(response)).toString('utf8'))
      if (!payload || typeof payload !== 'object')
        throw new WebError('Invalid public DNS response', 'INVALID_RESPONSE')
      const rows = (payload as Record<string, unknown>)['Answer']
      if (!Array.isArray(rows)) return []
      return rows.flatMap((row: unknown) => {
        if (!row || typeof row !== 'object') return []
        const value = row as Record<string, unknown>
        if (
          typeof value['data'] !== 'string' ||
          !((type === 'A' && value['type'] === 1) || (type === 'AAAA' && value['type'] === 28))
        )
          return []
        const family = isIP(value['data'])
        return family ? [{ address: value['data'], family: family as 4 | 6 }] : []
      })
    }),
  )
  const resolved = answers.flatMap((answer) => (answer.status === 'fulfilled' ? answer.value : []))
  if (!resolved.length || resolved.some((entry) => !isPublicAddress(entry.address)))
    throw new WebError('URL does not resolve to a verified public address', 'UNSAFE_URL')
  return resolved[0]!
}

async function readStream(
  stream: AsyncIterable<Buffer | string>,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > maxBytes) throw new WebError('Response exceeds size limit', 'RESPONSE_TOO_LARGE')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

async function readFetchBody(response: Response): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0)
  const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader()
  const chunks: Buffer[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_RESPONSE_BYTES)
        throw new WebError('Response exceeds size limit', 'RESPONSE_TOO_LARGE')
      chunks.push(Buffer.from(value))
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks)
}

function decodeBody(body: Buffer, headers: IncomingHttpHeaders): string {
  const encoding = String(headers['content-encoding'] ?? '').toLowerCase()
  let bytes = body
  try {
    if (encoding === 'gzip') bytes = gunzipSync(body, { maxOutputLength: MAX_RESPONSE_BYTES })
    else if (encoding === 'deflate')
      bytes = inflateSync(body, { maxOutputLength: MAX_RESPONSE_BYTES })
    else if (encoding === 'br')
      bytes = brotliDecompressSync(body, { maxOutputLength: MAX_RESPONSE_BYTES })
    else if (encoding && encoding !== 'identity')
      throw new WebError(`Unsupported content encoding: ${encoding}`, 'UNSUPPORTED_CONTENT')
  } catch (error) {
    if (error instanceof WebError) throw error
    throw new WebError('Could not decode response body', 'INVALID_RESPONSE')
  }
  const charset =
    String(headers['content-type'] ?? '').match(/charset\s*=\s*([\w-]+)/i)?.[1] ?? 'utf-8'
  try {
    return new TextDecoder(charset).decode(bytes)
  } catch {
    return new TextDecoder().decode(bytes)
  }
}

interface PageResponse {
  readonly status: number
  readonly headers: IncomingHttpHeaders
  readonly body: Buffer
}
export type PageRequester = (url: URL, signal: AbortSignal) => Promise<PageResponse>

async function requestPage(url: URL, signal: AbortSignal): Promise<PageResponse> {
  const pinned = await publicAddress(url.hostname, signal)
  return new Promise((resolve, reject) => {
    const requestOptions = {
      method: 'GET',
      autoSelectFamily: false,
      headers: {
        'User-Agent': 'Deepcode/1.0',
        Accept: 'text/html,text/plain,application/json,application/xml;q=0.8',
        'Accept-Encoding': 'identity',
      },
      lookup: (_hostname, _options, callback) => callback(null, pinned.address, pinned.family),
      signal,
    } satisfies RequestOptions & { autoSelectFamily: boolean }
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      requestOptions,
      (response) => {
        void readStream(response, MAX_RESPONSE_BYTES)
          .then((body) =>
            resolve({ status: response.statusCode ?? 0, headers: response.headers, body }),
          )
          .catch((error: unknown) => {
            request.destroy()
            reject(error instanceof Error ? error : new Error('Failed to read response'))
          })
      },
    )
    request.once('error', reject)
    request.end()
  })
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    ndash: '–',
    mdash: '—',
    hellip: '…',
    copy: '©',
    reg: '®',
  }
  return value.replace(/&(#(?:x[\da-f]+|\d+)|[a-z]+);/gi, (entity, name: string) => {
    if (name.startsWith('#')) {
      const hex = name[1]?.toLowerCase() === 'x'
      const code = Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10)
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity
    }
    return named[name.toLowerCase()] ?? entity
  })
}

function htmlText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[^]*?-->/g, ' ')
      .replace(/<(script|style|noscript|iframe|svg|head)\b[^>]*>[^]*?<\/\1\s*>/gi, ' ')
      .replace(/<\s*br\s*\/?\s*>/gi, '\n')
      .replace(/<\/?(?:p|div|li|h[1-6]|tr|section|article|blockquote|pre)\b[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\r/g, '')
    .replace(/[\t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const fetchSchema = z.object({ url: z.string().trim().min(1), prompt: z.string().optional() })

export function createWebFetchTool(requester: PageRequester = requestPage): Tool {
  return {
    descriptor: {
      name: 'web_fetch',
      version: '1.0.0',
      risk_level: 'medium',
      capabilities: ['network'],
      source: { kind: 'native' },
      description:
        'Fetch a public HTTP(S) URL and extract text from HTML or other text pages. Use for documentation and specific web pages.',
      input_schema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'HTTP(S) URL to fetch' },
          prompt: { type: 'string', description: 'Information to find in the page' },
        },
        required: ['url'],
      },
    },
    validate: (input) => validate(fetchSchema, input),
    safetyCheck(input, ctx) {
      let url: URL
      try {
        url = normalizedUrl(typeof input['url'] === 'string' ? input['url'] : '')
      } catch {
        return { action: PermissionAction.DENY, reason: 'invalid URL' }
      }
      const hostname = url.hostname.replace(/^\[|\]$/g, '')
      if (
        hostname === 'localhost' ||
        hostname.endsWith('.localhost') ||
        hostname.endsWith('.local') ||
        (isIP(hostname) !== 0 && !isPublicAddress(hostname))
      )
        return { action: PermissionAction.DENY, reason: 'local network address is not allowed' }
      const blocked = domainList(ctx.turnState['web_denied_domains'])
      const allowed = domainList(ctx.turnState['web_allowed_domains'])
      if (blocked.some((domain) => domainMatches(url.hostname, domain)))
        return { action: PermissionAction.DENY, reason: `domain denied: ${url.hostname}` }
      if (allowed.length && !allowed.some((domain) => domainMatches(url.hostname, domain)))
        return { action: PermissionAction.DENY, reason: `domain not in allowlist: ${url.hostname}` }
      return undefined
    },
    async execute(ctx, input) {
      try {
        let url = normalizedUrl(typeof input['url'] === 'string' ? input['url'] : '')
        const blocked = domainList(ctx.turnState['web_denied_domains'])
        const allowed = domainList(ctx.turnState['web_allowed_domains'])
        const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        const signal = AbortSignal.any([ctx.signal, timeout])
        for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
          if (
            blocked.some((domain) => domainMatches(url.hostname, domain)) ||
            (allowed.length && !allowed.some((domain) => domainMatches(url.hostname, domain)))
          )
            throw new WebError(`Domain is not allowed: ${url.hostname}`, 'UNSAFE_URL')
          // Validate every hop, including when a test requester is injected.
          const hostname = url.hostname.replace(/^\[|\]$/g, '')
          if (
            !isIP(hostname) &&
            (hostname === 'localhost' ||
              hostname.endsWith('.localhost') ||
              hostname.endsWith('.local'))
          )
            throw new WebError('Local network addresses are not allowed', 'UNSAFE_URL')
          if (isIP(hostname) && !isPublicAddress(hostname))
            throw new WebError('Local network addresses are not allowed', 'UNSAFE_URL')
          const response = await requester(url, signal)
          if ([301, 302, 303, 307, 308].includes(response.status)) {
            if (redirects === MAX_REDIRECTS)
              throw new WebError('Too many redirects', 'TOO_MANY_REDIRECTS')
            const location = response.headers.location
            if (!location) throw new WebError('Redirect is missing Location', 'INVALID_RESPONSE')
            url = normalizedUrl(new URL(location, url).href)
            continue
          }
          if (response.status < 200 || response.status >= 300)
            return result(`HTTP ${response.status} fetching ${url.href}`, 'HTTP_ERROR', {
              status: response.status,
              url: url.href,
            })
          const type = String(response.headers['content-type'] ?? 'text/html').toLowerCase()
          if (!/^(text\/|application\/(json|xml|xhtml\+xml))/.test(type))
            return result(`Unsupported content type: ${type}`, 'UNSUPPORTED_CONTENT')
          if (response.body.length > MAX_RESPONSE_BYTES)
            throw new WebError('Response exceeds size limit', 'RESPONSE_TOO_LARGE')
          const body = decodeBody(response.body, response.headers)
          const extracted = /html|xhtml/.test(type) ? htmlText(body) : body.trim()
          const clipped =
            extracted.length > MAX_TEXT_CHARS
              ? `${extracted.slice(0, MAX_TEXT_CHARS)}\n\n... [content truncated]`
              : extracted
          const prompt = typeof input['prompt'] === 'string' ? input['prompt'].trim() : ''
          return result(
            prompt ? `Extract info about: ${prompt}\n\n--- Page content ---\n${clipped}` : clipped,
            null,
            { url: url.href, content_length: clipped.length },
          )
        }
        throw new WebError('Too many redirects', 'TOO_MANY_REDIRECTS')
      } catch (error) {
        const code =
          error instanceof WebError
            ? error.code
            : ctx.signal.aborted
              ? 'CANCELLED'
              : error instanceof Error && error.name === 'TimeoutError'
                ? 'TIMEOUT'
                : 'NETWORK_ERROR'
        return result(
          error instanceof WebError
            ? error.message
            : `Failed to fetch URL: ${error instanceof Error ? error.message : String(error)}`,
          code,
        )
      }
    },
  }
}

const searchSchema = z.object({
  query: z.string().trim().min(1).max(600),
  allowed_domains: z.array(z.string().trim().min(1)).optional(),
  blocked_domains: z.array(z.string().trim().min(1)).optional(),
})

function searchResults(payload: unknown): { title: string; url: string; description: string }[] {
  if (!payload || typeof payload !== 'object')
    throw new WebError('Invalid search response', 'INVALID_RESPONSE')
  const web = (payload as Record<string, unknown>)['web']
  if (web === undefined) return []
  const rows =
    web && typeof web === 'object' ? (web as Record<string, unknown>)['results'] : undefined
  if (!Array.isArray(rows)) throw new WebError('Invalid search response', 'INVALID_RESPONSE')
  return rows.flatMap((row: unknown) => {
    if (!row || typeof row !== 'object') return []
    const value = row as Record<string, unknown>
    if (typeof value['url'] !== 'string' || typeof value['title'] !== 'string') return []
    try {
      const url = normalizedUrl(value['url'])
      return [
        {
          title: value['title'].slice(0, 300),
          url: url.href,
          description:
            typeof value['description'] === 'string'
              ? htmlText(value['description']).slice(0, 1000)
              : '',
        },
      ]
    } catch {
      return []
    }
  })
}

export function createWebSearchTool(searchFetch: typeof fetch = fetch): Tool {
  return {
    descriptor: {
      name: 'web_search',
      version: '1.0.0',
      risk_level: 'high',
      capabilities: ['network'],
      source: { kind: 'native' },
      description:
        'Search the web with Brave Search. Returns result titles, URLs, and snippets. Requires DEEPCODE_BRAVE_SEARCH_API_KEY.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          allowed_domains: {
            type: 'array',
            items: { type: 'string' },
            description: 'Only include these domains',
          },
          blocked_domains: {
            type: 'array',
            items: { type: 'string' },
            description: 'Exclude these domains',
          },
        },
        required: ['query'],
      },
    },
    validate: (input) => validate(searchSchema, input),
    async execute(ctx: ToolContext, input) {
      const query = typeof input['query'] === 'string' ? input['query'].trim() : ''
      if (!query) return result('Search query is required', 'INVALID_INPUT')
      const key = process.env['DEEPCODE_BRAVE_SEARCH_API_KEY']?.trim()
      if (!key)
        return result(
          'Web search requires DEEPCODE_BRAVE_SEARCH_API_KEY. Set it in the environment and restart deepcode.',
          'NOT_CONFIGURED',
        )
      try {
        const endpoint = new URL(SEARCH_ENDPOINT)
        endpoint.searchParams.set('q', query)
        endpoint.searchParams.set('count', '20')
        const response = await searchFetch(endpoint, {
          headers: { Accept: 'application/json', 'X-Subscription-Token': key },
          signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
          redirect: 'error',
        })
        if (!response.ok)
          return result(`Search provider returned HTTP ${response.status}`, 'HTTP_ERROR', {
            status: response.status,
          })
        const bytes = await readFetchBody(response)
        let payload: unknown
        try {
          payload = JSON.parse(bytes.toString('utf8'))
        } catch {
          throw new WebError('Invalid search response', 'INVALID_RESPONSE')
        }
        const rows = searchResults(payload)
        const allowed = domainList(input['allowed_domains'])
        const blocked = domainList(input['blocked_domains'])
        const filtered = rows
          .filter((row) => {
            const host = new URL(row.url).hostname
            return (
              (!allowed.length || allowed.some((domain) => domainMatches(host, domain))) &&
              !blocked.some((domain) => domainMatches(host, domain))
            )
          })
          .slice(0, 10)
        const content = filtered.length
          ? filtered
              .map(
                (row, index) =>
                  `${index + 1}. ${row.title}\n${row.url}${row.description ? `\n${row.description}` : ''}`,
              )
              .join('\n\n')
          : 'No matching search results.'
        return result(content, null, { query, results: filtered, result_count: filtered.length })
      } catch (error) {
        const code =
          error instanceof WebError
            ? error.code
            : ctx.signal.aborted
              ? 'CANCELLED'
              : error instanceof Error && error.name === 'TimeoutError'
                ? 'TIMEOUT'
                : 'NETWORK_ERROR'
        return result(
          error instanceof WebError
            ? error.message
            : `Web search failed: ${error instanceof Error ? error.message : String(error)}`,
          code,
        )
      }
    },
  }
}
