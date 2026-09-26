/**
 * 静态资源服务。
 *
 * ## 为什么自己写而不上 `serve-static` / `express.static`
 *
 * 需要暴露的文件很少（页面、脚本、样式及已安装的 Markdown 解析器），而依赖一个
 * 静态中间件意味着引入一整棵依赖树到 Agent 的进程里——那棵树的每个包都能
 * 读工作区文件。显式路径映射 + 路径穿越防护的实现成本远低于这个代价。
 *
 * ## 路径穿越防护
 *
 * 攻击面是 `GET /../../.deepcode/config.json` 这一类。做法是**先解码再规范化，
 * 然后要求结果仍以静态目录为前缀**——只检查原始字符串里有没有 `..` 是不够的，
 * `%2e%2e%2f` 与 `....//` 都能绕过朴素检查。
 */

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 仅暴露已安装的 marked 浏览器模块，不开放 node_modules 路径。 */
const MARKED_MODULE = fileURLToPath(import.meta.resolve('marked'))

/** 扩展名 → Content-Type。 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
}

/** 只为明确登记的前端路由返回入口，避免未知路径误返回 200。 */
function isAppRoute(pathname: string): boolean {
  const parts = pathname.split('/').filter(Boolean)
  if (parts.length === 0) return true
  if (parts.length === 1) return ['projects', 'settings', 'commands'].includes(parts[0] ?? '')
  if (parts[0] !== 'projects' || !/^[a-f0-9]{24}$/.test(parts[1] ?? '')) return false
  if (parts.length === 2) return true
  return parts.length === 4 && parts[2] === 'chats' && /^[A-Za-z0-9_-]+$/.test(parts[3] ?? '')
}

/** 路径 → 静态目录内的相对文件。前端路由映射到 `index.html`。 */
function resolveRequestPath(pathname: string, staticDir: string): string | undefined {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    // 非法百分号编码：直接当作非法路径，不要退回原始串（那正是绕过点）。
    return undefined
  }

  if (decoded === '/vendor/marked.js') return MARKED_MODULE

  const relative = isAppRoute(decoded) ? 'index.html' : decoded.replace(/^\/+/, '')

  const root = resolve(staticDir)
  const target = resolve(join(root, normalize(relative)))

  // 前缀检查必须带上分隔符，否则 `/static-evil` 会被 `/static` 前缀放过。
  if (target !== root && !target.startsWith(root + sep)) return undefined
  return target
}

/**
 * 服务一个静态资源。
 *
 * **不鉴权**是有意的：浏览器导航无法设置 `Authorization` 头，静态页面若要求
 * 鉴权就永远打不开；而这些资源里没有任何来自配置或会话的数据。
 * 真正的鉴权发生在 `/api/*` 上，前端拿到 token 后才可能读到任何内容。
 */
export async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  staticDir: string,
): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.statusCode = 405
    res.setHeader('Allow', 'GET, HEAD')
    res.end()
    return
  }

  const target = resolveRequestPath(pathname, staticDir)
  if (target === undefined) {
    res.statusCode = 400
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.end('bad path')
    return
  }

  let size: number
  try {
    const info = await stat(target)
    if (!info.isFile()) throw new Error('not a file')
    size = info.size
  } catch {
    res.statusCode = 404
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.end('not found')
    return
  }

  res.statusCode = 200
  res.setHeader(
    'Content-Type',
    CONTENT_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream',
  )
  res.setHeader('Content-Length', String(size))
  // 静态资源不参与 API 的 `no-store`；前端每次都得重下会显著变慢。
  // 但也**不做长缓存**：这个页面随版本走，缓存住旧 `app.js` 会让
  // 协议不一致的问题在浏览器里表现成"莫名失灵"。
  res.setHeader('Cache-Control', 'no-cache')

  if (req.method === 'HEAD') {
    res.end()
    return
  }

  const stream = createReadStream(target)
  stream.on('error', () => {
    // 已经在写响应体了，改不了状态码；断开让客户端知道传输不完整。
    res.destroy()
  })
  stream.pipe(res)
}
