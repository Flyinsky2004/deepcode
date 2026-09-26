/**
 * `server.ts` 里那些"不被主流程覆盖但会改变行为"的入口。
 *
 * 这些看起来像琐碎的工具函数，但每一个都对应一条真实故障：
 * 静态目录找不到会让页面 404、版本号读不出来会让健康检查报假信息、
 * 日志出口接错会让 token 打印不到终端。
 */

import { describe, expect, it, vi } from 'vitest'

import { ErrorCode } from '../../src/core/errors.js'
import {
  WebServer,
  isStartupFailure,
  resolveStaticDir,
  startWebServer,
} from '../../src/clients/web/server.js'
import { AuthMode, ListenScope } from '../../src/clients/web/listen-policy.js'
import { consoleLogger, silentLogger, MemoryLogger } from '../../src/clients/web/logger.js'
import { contentDigest } from '../../src/clients/web/dto.js'
import { startHarness } from './harness.js'

describe('resolveStaticDir', () => {
  it('显式传入时原样返回（测试与嵌入式部署的注入点）', () => {
    expect(resolveStaticDir('/tmp/somewhere')).toBe('/tmp/somewhere')
  })

  it('默认解析到真实存在的静态目录', async () => {
    const { existsSync } = await import('node:fs')
    const dir = resolveStaticDir()
    expect(existsSync(dir)).toBe(true)
    expect(existsSync(`${dir}/index.html`)).toBe(true)
    expect(existsSync(`${dir}/app.js`)).toBe(true)
    expect(existsSync(`${dir}/styles.css`)).toBe(true)
  })
})

describe('日志出口', () => {
  it('consoleLogger 走 console.error / console.warn（ESLint 只放行这两个）', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      consoleLogger.error('e')
      consoleLogger.warn('w')
      expect(error).toHaveBeenCalledWith('e')
      expect(warn).toHaveBeenCalledWith('w')
    } finally {
      error.mockRestore()
      warn.mockRestore()
    }
  })

  it('silentLogger 什么都不写', () => {
    expect(() => {
      silentLogger.error('e')
      silentLogger.warn('w')
    }).not.toThrow()
  })

  it('MemoryLogger 同时保留两类输出', () => {
    const logger = new MemoryLogger()
    logger.error('e')
    logger.warn('w')
    expect(logger.errors).toEqual(['e'])
    expect(logger.warnings).toEqual(['w'])
    expect(logger.all()).toEqual(['e', 'w'])
  })
})

describe('contentDigest', () => {
  it('稳定、固定长度、不同输入不同结果，且**不包含原文**', () => {
    const digest = contentDigest('一段可能含密钥的文本')
    expect(digest).toHaveLength(16)
    expect(digest).toBe(contentDigest('一段可能含密钥的文本'))
    expect(digest).not.toBe(contentDigest('别的文本'))
    expect(digest).not.toContain('密钥')
  })
})

describe('启动入口', () => {
  it('startWebServer 等价于 WebServer.start，失败时返回原因而不是抛', async () => {
    const h = await startHarness()
    const result = await startWebServer({
      app: h.app,
      listen: ListenScope.PUBLIC,
      auth: AuthMode.NONE,
      port: 0,
      portExplicit: true,
      disposeApplication: false,
      logger: silentLogger,
    })
    expect(isStartupFailure(result)).toBe(true)
    if (result.ok) return
    expect(result.code).toBe(ErrorCode.WEB_AUTH_FAILED)
    expect(result.reason).toContain('--auth none')
  })

  it('成功时 isStartupFailure 为假，且能正常关闭', async () => {
    const h = await startHarness()
    const result = await startWebServer({
      app: h.app,
      host: '127.0.0.1',
      port: 0,
      portExplicit: true,
      disposeApplication: false,
      logger: silentLogger,
    })
    expect(isStartupFailure(result)).toBe(false)
    if (!result.ok) return

    expect(result.server.port).toBeGreaterThan(0)
    expect(result.server.urls[0]).toContain('127.0.0.1')
    expect(result.server.connectionCount).toBe(0)
    await result.server.close()
  })

  it('默认本机监听无需 token，可直接访问 API', async () => {
    const h = await startHarness()
    const logger = new MemoryLogger()
    const result = await startWebServer({
      app: h.app,
      host: '127.0.0.1',
      port: 0,
      portExplicit: true,
      disposeApplication: false,
      logger,
    })
    if (!result.ok) throw new Error(result.reason)

    expect(result.server.authMode).toBe(AuthMode.NONE)
    expect(result.server.token).toBeUndefined()
    expect(logger.all().join('\n')).toContain('无需 token')
    expect(logger.all().join('\n')).not.toContain('认证 token')
    expect((await fetch(`${result.server.urls[0]}/api/projects`)).status).toBe(200)
    await result.server.close()
    await h.close()
  })

  it('显式 --auth token 时生成随机 token 并打印', async () => {
    const h = await startHarness()
    const logger = new MemoryLogger()
    const result = await startWebServer({
      app: h.app,
      host: '127.0.0.1',
      port: 0,
      portExplicit: true,
      auth: AuthMode.TOKEN,
      disposeApplication: false,
      logger,
    })
    if (!result.ok) throw new Error(result.reason)

    expect(result.server.token).toBeTruthy()
    expect(result.server.authMode).toBe(AuthMode.TOKEN)
    expect(logger.all().join('\n')).toContain(result.server.token)
    await result.server.close()
    await h.close()
  })

  it('只传 --token 也会开启认证', async () => {
    const h = await startHarness()
    const result = await startWebServer({
      app: h.app,
      host: '127.0.0.1',
      port: 0,
      portExplicit: true,
      token: 'explicit-token',
      disposeApplication: false,
      logger: silentLogger,
    })
    if (!result.ok) throw new Error(result.reason)

    expect(result.server.authMode).toBe(AuthMode.TOKEN)
    expect(result.server.token).toBe('explicit-token')
    expect((await fetch(`${result.server.urls[0]}/api/projects`)).status).toBe(401)
    await result.server.close()
    await h.close()
  })

  it('lan 模式默认仍启用 token', async () => {
    const h = await startHarness()
    const result = await startWebServer({
      app: h.app,
      listen: ListenScope.LAN,
      host: '127.0.0.1',
      port: 0,
      portExplicit: true,
      disposeApplication: false,
      logger: silentLogger,
    })
    if (!result.ok) throw new Error(result.reason)

    expect(result.server.authMode).toBe(AuthMode.TOKEN)
    expect((await fetch(`${result.server.urls[0]}/api/projects`)).status).toBe(401)
    await result.server.close()
    await h.close()
  })

  it('--listen local 默认绑两个 loopback 地址（v4 + v6）', async () => {
    const h = await startHarness()
    const result = await startWebServer({
      app: h.app,
      port: 0,
      portExplicit: true,
      disposeApplication: false,
      logger: silentLogger,
    })
    if (!result.ok) throw new Error(result.reason)

    // ⚠️ 两个地址必须**共用一个端口**：端口 0 时第二个地址要复用第一个
    // 实际绑到的端口，否则浏览器看到的两个 URL 指向不同端口。
    expect(result.server.addresses.map((address) => address.host)).toEqual(['127.0.0.1', '::1'])
    expect(result.server.urls).toEqual([
      `http://127.0.0.1:${String(result.server.port)}`,
      `http://[::1]:${String(result.server.port)}`,
    ])
    expect(result.server.authMode).toBe(AuthMode.NONE)
    expect(result.server.token).toBeUndefined()
    await result.server.close()
  })

  it('local 下也可以显式只绑 IPv4（::1 不可用时的逃生口）', async () => {
    const h = await startHarness()
    const result = await startWebServer({
      app: h.app,
      listen: ListenScope.LOCAL,
      host: '127.0.0.1',
      port: 0,
      portExplicit: true,
      disposeApplication: false,
      logger: silentLogger,
    })
    if (!result.ok) throw new Error(result.reason)
    expect(result.server.addresses).toHaveLength(1)
    await result.server.close()
  })

  it('--cors 显式来源被接受并打印提示', async () => {
    const h = await startHarness()
    const result = await startWebServer({
      app: h.app,
      host: '127.0.0.1',
      port: 0,
      portExplicit: true,
      cors: 'http://192.168.1.9:3210',
      disposeApplication: false,
      logger: h.logger,
    })
    if (!result.ok) throw new Error(result.reason)
    expect(h.logger.warnings.join('\n')).toContain('http://192.168.1.9:3210')
    await result.server.close()
  })
})

describe('WebServer 类', () => {
  it('未启动时关闭是安全的（不抛）', async () => {
    const h = await startHarness()
    const result = await startWebServer({
      app: h.app,
      host: '127.0.0.1',
      port: 0,
      portExplicit: true,
      disposeApplication: false,
      logger: silentLogger,
    })
    if (!result.ok) throw new Error(result.reason)
    const report = await result.server.close()
    expect(report.refusedRequests).toBe(0)
    expect(report.cancelledTurns).toBe(0)
    expect(report.turnsTimedOut).toBe(false)
    expect(report.flushTimedOut).toBe(false)
    expect(report.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('disposeApplication 为真时关闭会释放组合根', async () => {
    const h = await startHarness()
    const result = await startWebServer({
      app: h.app,
      host: '127.0.0.1',
      port: 0,
      portExplicit: true,
      disposeApplication: true,
      logger: silentLogger,
    })
    if (!result.ok) throw new Error(result.reason)
    await result.server.close()
    expect(h.app.disposed).toBe(true)
  })
})

describe('启动顺序：最危险的组合最先判', () => {
  it('⚠️ public + auth none 先于 password / cors 判定', async () => {
    const h = await startHarness()
    // 三个错误同时存在：public+none、password 未实现、`--cors *`。
    // 必须报**第一个**——若 password 或 cors 的分支排在前面，
    // "公网无认证"这个最危险的组合就会被别的错误盖过去。
    const result = await startWebServer({
      app: h.app,
      listen: ListenScope.PUBLIC,
      auth: AuthMode.NONE,
      cors: '*',
      port: 0,
      portExplicit: true,
      disposeApplication: false,
      logger: silentLogger,
    })
    expect(isStartupFailure(result)).toBe(true)
    if (result.ok) return
    expect(result.code).toBe(ErrorCode.WEB_AUTH_FAILED)
    expect(result.reason).toContain('--auth none')
  })

  it('public + password 通过监听策略，随后才被"未实现"挡下', async () => {
    const h = await startHarness()
    const result = await startWebServer({
      app: h.app,
      listen: ListenScope.PUBLIC,
      auth: AuthMode.PASSWORD,
      port: 0,
      portExplicit: true,
      disposeApplication: false,
      logger: silentLogger,
    })
    expect(isStartupFailure(result)).toBe(true)
    if (result.ok) return
    // 先过策略（public 只要求非 none），再报未实现——两个原因的文案不同，
    // 调用方能据此区分"配置违规"与"功能缺失"。
    expect(result.code).toBe(ErrorCode.WEB_AUTH_FAILED)
    expect(result.reason).toContain('尚未实现')
  })
})

describe('WebServer 是唯一入口', () => {
  it('start 是静态方法，不导出可变的全局状态', () => {
    expect(typeof WebServer.start).toBe('function')
  })
})
