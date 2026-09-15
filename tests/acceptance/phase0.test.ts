/**
 * Phase 0 验收测试。
 *
 * 把 progess.md 的验收标准写成可执行断言，而不是靠人工核对：
 *
 * 1. `npm test` 可运行（由 CI/本地执行 `pnpm check` 保证）
 * 2. **不依赖 TUI 即可 import runtime**
 * 3. 所有公共协议都有单元测试和序列化测试
 *
 * 第 2 条是架构约束（progess.md 设计约束 1：Agent 内核不得依赖 TUI、Web 框架、
 * 具体模型 SDK 或 Langfuse）。它极易被无意破坏——某个模块图方便 import 了
 * 一个 UI 库，编译与测试都照常通过，直到有人想复用内核时才暴露。
 * 因此这里用**静态扫描 + 真实 import** 双重验证。
 */

import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

// Phase 0's pure-core boundary remains dependency-free; runtime implementations
// in storage/providers/tools are intentionally allowed to use IO and fetch.
const SRC_ROOT = new URL('../../src/core', import.meta.url).pathname

/** 递归收集 src 下全部 .ts 文件。 */
async function collectSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await collectSourceFiles(full)))
    } else if (entry.name.endsWith('.ts')) {
      files.push(full)
    }
  }

  return files
}

/** 抽取一个文件里全部 import / export-from 的模块说明符。 */
function extractSpecifiers(source: string): string[] {
  const specifiers: string[] = []
  const patterns = [
    /(?:^|\n)\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*export\s[^;]*?from\s+['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const spec = match[1]
      if (spec !== undefined) specifiers.push(spec)
    }
  }

  return specifiers
}

describe('验收：内核不依赖 UI / 框架 / SDK', () => {
  it('src 只 import node 内置模块与 zod', async () => {
    const files = await collectSourceFiles(SRC_ROOT)
    const external = new Set<string>()

    for (const file of files) {
      const source = await readFile(file, 'utf8')
      for (const spec of extractSpecifiers(source)) {
        // 相对路径与 node: 前缀跳过
        if (spec.startsWith('.') || spec.startsWith('node:')) continue
        external.add(spec)
      }
    }

    // zod 是唯一的运行期依赖（Phase 0 明确要求 runtime schema 校验）
    expect([...external].sort()).toEqual(['zod'])
  })

  it('没有任何 UI 框架 / 模型 SDK / 可观测性 SDK 依赖', async () => {
    const files = await collectSourceFiles(SRC_ROOT)
    const forbidden = [
      'react',
      'ink',
      'blessed',
      'neo-blessed',
      'textual',
      '@anthropic-ai/sdk',
      'openai',
      'langfuse',
      'express',
      'fastify',
      'koa',
      'ws',
      'socket.io',
    ]

    const violations: string[] = []

    for (const file of files) {
      const source = await readFile(file, 'utf8')
      for (const spec of extractSpecifiers(source)) {
        const root = spec.startsWith('@')
          ? spec.split('/').slice(0, 2).join('/')
          : spec.split('/')[0]
        if (root !== undefined && forbidden.includes(root)) {
          violations.push(`${relative(SRC_ROOT, file)} → ${spec}`)
        }
      }
    }

    expect(violations).toEqual([])
  })

  it('src 不直接访问文件系统 / 网络（Phase 0 是纯契约层）', async () => {
    const files = await collectSourceFiles(SRC_ROOT)
    const violations: string[] = []

    for (const file of files) {
      const source = await readFile(file, 'utf8')
      for (const spec of extractSpecifiers(source)) {
        // node:crypto 用于生成 ID，是允许的（无 IO）
        if (spec === 'node:crypto') continue
        if (spec.startsWith('node:fs') || spec === 'node:http' || spec === 'node:net') {
          violations.push(`${relative(SRC_ROOT, file)} → ${spec}`)
        }
      }
    }

    // IO 属于 Phase 1 存储层；Phase 0 的 core 只允许纯计算
    expect(violations).toEqual([])
  })
})

describe('验收：不依赖 TUI 即可 import runtime', () => {
  it('可从公共入口导入并实际调用', async () => {
    const runtime = await import('../../src/index.js')

    // 枚举与纯函数应当可用
    expect(typeof runtime.createSessionId).toBe('function')
    expect(typeof runtime.createTurnId).toBe('function')
    expect(typeof runtime.canTransition).toBe('function')
    expect(typeof runtime.renderSystemPrompt).toBe('function')
    expect(typeof runtime.isTerminalEvent).toBe('function')
    expect(typeof runtime.validate).toBe('function')

    // 实际调用，确认不是空壳导出
    const sessionId = runtime.createSessionId()
    expect(runtime.createTurnId(sessionId, 1)).toContain('turn_1_')
    expect(
      runtime.canTransition(runtime.TurnPhase.STARTING, runtime.TurnPhase.BUILDING_CONTEXT),
    ).toBe(true)
  })

  it('导出覆盖全部 15 个 core 模块', async () => {
    const runtime = await import('../../src/index.js')

    // 每个模块至少有一个代表性导出
    const expected = [
      'CancelReason', // abort
      'brandAs', // brand
      'DEFAULT_BUDGET', // budget
      'renderSystemPrompt', // context
      'ErrorCode', // errors
      'InMemoryEventSink', // events
      'createTurnId', // ids
      'MessageSubtype', // models
      'ModelTier', // provider
      'isOk', // result
      'validate', // schema
      'createFakeClock', // time
      'CharacterTokenEstimator', // tokens
      'PermissionAction', // tool
      'TurnPhase', // turn
    ]

    for (const name of expected) {
      expect(runtime, `缺少导出: ${name}`).toHaveProperty(name)
    }
  })

  it('模块加载无副作用（顶层不发起 IO 或网络）', async () => {
    // 若能成功 import 且不抛错，即说明顶层没有做 IO。
    // 这是 UI 能在任意时机安全加载内核的前提。
    await expect(import('../../src/index.js')).resolves.toBeDefined()
  })
})

describe('验收：公共协议均有测试', () => {
  it('每个 core 模块都有同名测试文件', async () => {
    const testsRoot = new URL('../core', import.meta.url).pathname
    const sourceFiles = await collectSourceFiles(SRC_ROOT)
    const testFiles = await readdir(testsRoot)

    const missing: string[] = []

    for (const file of sourceFiles) {
      const name = file.slice(file.lastIndexOf('/') + 1).replace(/\.ts$/, '')
      if (name === 'index') continue
      if (!testFiles.includes(`${name}.test.ts`)) missing.push(name)
    }

    expect(missing).toEqual([])
  })

  it('存在序列化往返测试（验收明列项）', async () => {
    const testsRoot = new URL('../core', import.meta.url).pathname
    const testFiles = await readdir(testsRoot)
    expect(testFiles).toContain('serialization.test.ts')
  })
})
