/**
 * 内置命令注册。
 *
 * ## 关于"未实现子系统"的处理原则
 *
 * 有几条命令指向尚未实现的子系统（MCP 属 Phase 10、可观测性属
 * Phase 11）。它们**一律返回 `not_available` 并说明原因**，
 * 而不是：
 *
 * - 返回假数据（用户会以为功能可用）；
 * - 返回空列表假装成功（同上，且更难排查）；
 * - 写一个没有任何消费者的配置开关（产生"我开了但没生效"的误导）。
 *
 * 这与 `CLAUDE.md` 的缺陷协议同源：**不要静默地"顺手做好"**。
 */

import { z } from 'zod'

import { ErrorCode } from '../../core/errors.js'
import { CommandRegistry } from '../registry.js'
import { CommandResultCode, type CommandDefinition, type CommandResult } from '../types.js'
import { createInitCommand } from './init.js'
import { createModelCommand } from './model.js'
import {
  createContextModeCommand,
  createEffortCommand,
  createReasoningCommand,
  createThinkingCommand,
} from './model-preferences.js'
import { createWorkwithCommand } from './workwith.js'

/** 生成一条"诚实的降级"命令。 */
function unavailableCommand(input: {
  readonly name: string
  readonly description: string
  readonly subsystem: string
  readonly phase: string
  /** 仍可只读展示的已配置项（不假装它们已生效）。 */
  readonly listConfigured?: (
    host: Parameters<CommandDefinition['execute']>[0]['host'],
  ) => Promise<string>
}): CommandDefinition {
  return {
    name: input.name,
    description: input.description,
    parameters: { positionals: [] },
    interrupt: 'never',
    permission: { kind: 'always' },
    auditEvent: 'command_received',
    idempotency: { kind: 'read-only' },
    persistResult: true,
    execute: async (ctx): Promise<CommandResult> => {
      const extra = input.listConfigured === undefined ? '' : await input.listConfigured(ctx.host)
      return {
        ok: false,
        code: CommandResultCode.NOT_AVAILABLE,
        errorCode: ErrorCode.COMMAND_NOT_AVAILABLE,
        text:
          `${input.name} 依赖的「${input.subsystem}」子系统尚未实现（${input.phase}）。` +
          (extra === '' ? '该命令当前不产生任何效果。' : `\n\n${extra}`),
        data: { subsystem: input.subsystem, phase: input.phase },
      }
    },
  }
}

/** `/skills`：读取当前 registry 的实际快照；无注册表时明确降级。 */
function skillsCommand(): CommandDefinition {
  return {
    name: 'skills',
    description: '查看 skills',
    parameters: { positionals: [] },
    interrupt: 'never',
    permission: { kind: 'always' },
    auditEvent: 'command_received',
    idempotency: { kind: 'read-only' },
    persistResult: false,
    execute: async (ctx): Promise<CommandResult> => {
      const catalog = await ctx.host.listSkills?.()
      if (catalog === undefined)
        return {
          ok: false,
          code: CommandResultCode.NOT_AVAILABLE,
          errorCode: ErrorCode.COMMAND_NOT_AVAILABLE,
          text: '当前客户端未提供 Skill 注册表，无法列出 skills。',
          data: { subsystem: 'Skill', reason: 'registry_unavailable' },
        }
      const loaded = catalog.loadedSkills
        .map(
          (skill) =>
            `- **${skill.ref}** \`${skill.source}\`\n  ${skill.description}\n  category: \`${skill.category}\` · tags: \`${skill.tags.length ? skill.tags.join(', ') : '-'}\`\n  path: \`${skill.path}\``,
        )
        .join('\n')
      const invalid = catalog.invalidSkills.length
        ? `\n\nInvalid: ${catalog.invalidSkills.length}\n${catalog.invalidSkills.map((item) => `- \`${item.path}\`\n  ${item.reason}`).join('\n')}`
        : ''
      return {
        ok: true,
        code: CommandResultCode.PANEL,
        text:
          catalog.loadedSkills.length === 0 && catalog.invalidSkills.length === 0
            ? '未加载任何 skill。请在工作区 skills/**/SKILL.md 或用户目录 ~/.deepcode/skills 下添加 SKILL.md。'
            : `Loaded: ${catalog.loadedSkills.length}\n${loaded}${invalid}`,
        data: catalog,
      }
    },
  }
}

function mcpCommand(): CommandDefinition {
  return {
    name: 'mcp',
    description: '查看或重连 MCP 服务',
    parameters: {
      positionals: [
        {
          name: 'action',
          required: false,
          description: 'list 或 reconnect',
          schema: z.enum(['list', 'reconnect']),
        },
        {
          name: 'server',
          required: false,
          description: '要重连的 server 名称',
          schema: z.string().min(1),
        },
      ],
    },
    interrupt: 'never',
    permission: { kind: 'always' },
    auditEvent: 'command_received',
    idempotency: { kind: 'keyed', ttlMs: 60_000 },
    persistResult: false,
    execute: async (ctx): Promise<CommandResult> => {
      if (ctx.args['action'] === 'reconnect') {
        const server = ctx.args['server']
        if (typeof server !== 'string')
          return {
            ok: false,
            code: CommandResultCode.INVALID_ARGUMENTS,
            errorCode: ErrorCode.INVALID_COMMAND_ARGUMENTS,
            text: '用法：/mcp reconnect <server>',
          }
        const status = await ctx.host.reconnectMcpServer?.(server)
        if (status === undefined)
          return {
            ok: false,
            code: CommandResultCode.NOT_AVAILABLE,
            errorCode: ErrorCode.COMMAND_NOT_AVAILABLE,
            text: '当前客户端未提供 MCP 重连能力。',
          }
        return {
          ok: status.status === 'connected',
          code: status.status === 'connected' ? CommandResultCode.OK : CommandResultCode.FAILED,
          text: `${status.name}：${status.status}（${status.toolCount} tools）${status.error ? `\n${status.error}` : ''}`,
          data: { server: status },
        }
      }
      const servers = await ctx.host.listMcpServers?.()
      if (servers === undefined)
        return {
          ok: false,
          code: CommandResultCode.NOT_AVAILABLE,
          errorCode: ErrorCode.COMMAND_NOT_AVAILABLE,
          text: '当前客户端未提供 MCP 管理器。',
        }
      if (servers.length === 0)
        return {
          ok: true,
          code: CommandResultCode.PANEL,
          text: '尚未配置 MCP server。',
          data: { servers: [] },
        }
      return {
        ok: true,
        code: CommandResultCode.PANEL,
        text: servers
          .map(
            (server) =>
              `- **${server.name}** \`${server.status}\` · ${server.transport} · ${server.toolCount} tools` +
              (server.error ? `\n  ${server.error}` : ''),
          )
          .join('\n'),
        data: { servers },
      }
    },
  }
}

/** `/sessions` —— 列出本 principal 可见的会话。 */
function sessionsCommand(): CommandDefinition {
  return {
    name: 'sessions',
    description: '列出会话',
    parameters: { positionals: [] },
    interrupt: 'never',
    permission: { kind: 'always' },
    auditEvent: 'command_received',
    idempotency: { kind: 'read-only' },
    persistResult: false,
    execute: async (ctx): Promise<CommandResult> => {
      const sessions = await ctx.host.listSessions(ctx.principalId)
      if (sessions.length === 0)
        return { ok: true, code: CommandResultCode.OK, text: '还没有任何会话' }
      // 走 selection 而不是纯文本：UI 需要知道"这是一个可选项列表"，
      // 才能渲染成可点/可选的形态（旧 TUI 的 #command-menu 就是这个用途）
      return {
        ok: true,
        code: CommandResultCode.SELECTION,
        text: sessions.map((s) => `${s.title}（${s.current_turn} 轮）`).join('\n'),
        data: { kind: 'session_select', sessions },
      }
    },
  }
}

/** `/clear` —— 新建一个会话并切过去。 */
function clearCommand(): CommandDefinition {
  return {
    name: 'clear',
    description: '开始新会话',
    parameters: { positionals: [] },
    interrupt: 'never',
    permission: { kind: 'always' },
    auditEvent: 'command_received',
    idempotency: { kind: 'keyed', ttlMs: 60_000 },
    persistResult: true,
    execute: async (ctx): Promise<CommandResult> => {
      const created = await ctx.host.createSession(ctx.principalId)
      return {
        ok: true,
        code: CommandResultCode.OK,
        text: '已开始新会话',
        data: { kind: 'switch_session', sessionId: created.id },
      }
    },
  }
}

/** `/compact` —— 手动压缩上下文。 */
function compactCommand(): CommandDefinition {
  return {
    name: 'compact',
    description: '压缩当前上下文',
    parameters: { positionals: [] },
    interrupt: 'never',
    permission: { kind: 'always' },
    auditEvent: 'command_received',
    idempotency: { kind: 'read-only' },
    persistResult: true,
    execute: async (ctx): Promise<CommandResult> => {
      if (ctx.sessionId === undefined)
        return {
          ok: false,
          code: CommandResultCode.INVALID_ARGUMENTS,
          text: '请先开始一个会话',
          errorCode: ErrorCode.INVALID_COMMAND_ARGUMENTS,
        }
      return ctx.host.compact(ctx.sessionId, ctx.signal)
    },
  }
}

/** `/language` —— 切换界面语言。只负责持久化设置，翻译表在各 client 内部。 */
function languageCommand(): CommandDefinition {
  return {
    name: 'language',
    description: '切换界面语言',
    parameters: {
      positionals: [
        { name: 'lang', required: false, description: 'en 或 zh', schema: z.enum(['en', 'zh']) },
      ],
    },
    interrupt: 'never',
    permission: { kind: 'always' },
    auditEvent: 'command_received',
    idempotency: { kind: 'read-only' },
    persistResult: false,
    execute: async (ctx): Promise<CommandResult> => {
      const requested = ctx.args['lang']
      const next = typeof requested === 'string' ? requested : undefined
      if (next === undefined) {
        const config = await ctx.host.readConfig()
        return {
          ok: true,
          code: CommandResultCode.OK,
          text: `当前语言：${config.settings['language'] ?? 'zh'}（用法：/language zh 或 /language en）`,
        }
      }
      // 真的落盘。各 client 只负责读这张表并重绘，不自己写设置——
      // 否则同一份设置在 TUI 与 Web 会各写一遍，迟早漂移。
      await ctx.host.updateConfig((view) => ({
        ...view,
        settings: { ...view.settings, language: next },
      }))
      return {
        ok: true,
        code: CommandResultCode.OK,
        text: `界面语言已切换为 ${next}`,
        data: { kind: 'set_language', language: next },
      }
    },
  }
}

/**
 * 构建内置命令注册表。
 *
 * **这是 Web / TUI / CLI 三端共用的唯一注册表**（`parts/09` §6：
 * 「Slash command 是独立的 `CommandRegistry`，与 TUI 无关」）。三端各自
 * 注册一份会立刻产生行为漂移。
 */
export function createBuiltinCommandRegistry(): CommandRegistry {
  const registry = new CommandRegistry()
  registry.registerAll([
    createWorkwithCommand(),
    // `/init` 曾是"诚实降级"（等旧源码的 prompt 转录）。转录已完成，见
    // `src/commands/prompts.ts` 顶部的来源表。
    createInitCommand(),
    sessionsCommand(),
    clearCommand(),
    compactCommand(),
    languageCommand(),
    createModelCommand(),

    // 四条模型偏好命令曾是"诚实降级"，等的是 runtime 侧消费
    // `ModelRequest.thinking`。那一步已完成（见 `core/provider.ts` 的
    // `thinkingConfigFor` 与 `runtime/agent-runtime.ts` 的请求构造），
    // 配置改动现在真的会改变发出的请求，所以它们可以开放写入口了。
    createThinkingCommand(),
    createReasoningCommand(),
    createEffortCommand(),
    createContextModeCommand(),

    // 诚实降级：这些命令指向尚未实现的子系统。
    // 它们**存在**（用户在补全列表里能看到、能理解为什么不可用），
    // 但绝不假装成功。
    skillsCommand(),
    mcpCommand(),
    unavailableCommand({
      name: 'langfuse',
      description: '切换可观测性上报',
      subsystem: '可观测性',
      phase: 'Phase 11',
    }),
    unavailableCommand({
      name: 'api',
      description: '管理 provider',
      subsystem: 'provider 管理界面',
      // ⚠️ 这一条**不是**"还没排到"，而是**刻意的推迟**，理由见 ADR 0004 D10：
      // 旧语法 `/api add deepseek <明文 API key>` 把密钥放进命令行参数，
      // 与 parts/09 §9.1「API key 不得出现在日志、事件、导出文件、URL 或
      // 前端响应中」直接冲突；而给 provider 管理设计一套安全的输入路径
      // （SecretRef 表单 / 连接测试 / 脱敏展示）是独立的一项工作。
      // 在此之前，用户通过编辑 `~/.deepcode/config.json` 添加 provider。
      phase: '需要先决定 SecretRef 输入方式（见 ADR 0004 D10）',
    }),
  ])
  return registry
}
