import { describe, expect, it } from 'vitest'

import { parseCliArgs } from '../src/cli.js'
import { AgentError, ErrorCode } from '../src/core/errors.js'

function expectInvalid(args: readonly string[]): void {
  try {
    parseCliArgs(args)
    throw new Error('expected parseCliArgs to fail')
  } catch (error) {
    expect(AgentError.is(error)).toBe(true)
    if (AgentError.is(error)) expect(error.code).toBe(ErrorCode.INVALID_COMMAND_ARGUMENTS)
  }
}

describe('正式 CLI 参数', () => {
  it('解析 Web UI 的全部监听、安全和跨源选项', () => {
    expect(
      parseCliArgs([
        '--web-ui',
        '--port',
        '8080',
        '--listen',
        'lan',
        '--host',
        '192.168.1.8',
        '--auth',
        'token',
        '--token',
        'secret-token',
        '--cors',
        'https://console.example,https://admin.example',
      ]),
    ).toEqual({
      webUi: true,
      port: 8080,
      portExplicit: true,
      listen: 'lan',
      host: '192.168.1.8',
      auth: 'token',
      token: 'secret-token',
      cors: 'https://console.example,https://admin.example',
    })
  })

  it('支持等号形式，并保留显式 --port 0', () => {
    expect(
      parseCliArgs(['--web-ui', '--port=0', '--listen=local', '--host=127.0.0.1', '--auth=token']),
    ).toEqual({
      webUi: true,
      port: 0,
      portExplicit: true,
      listen: 'local',
      host: '127.0.0.1',
      auth: 'token',
    })
  })

  it('默认走 TUI，帮助参数不触发启动', () => {
    expect(parseCliArgs([])).toEqual({ webUi: false, portExplicit: false })
    expect(parseCliArgs(['--help'])).toEqual({ help: true })
  })

  it('拒绝非法参数', () => {
    const cases: readonly (readonly string[])[] = [
      ['--web-ui', '--host'],
      ['--web-ui', '--port', '65536'],
      ['--web-ui', '--listen', 'everywhere'],
      ['--web-ui', '--auth', 'basic'],
      ['--web-ui', '--unknown'],
      ['--port', '8080'],
    ]
    for (const args of cases) expectInvalid(args)
  })
})
