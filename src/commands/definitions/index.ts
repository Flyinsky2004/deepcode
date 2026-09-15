/**
 * 内置命令注册。
 *
 * ## 关于"未实现子系统"的处理原则
 *
 * 有几条命令指向尚未实现的子系统（Skill 属 Phase 8、MCP 属 Phase 10、
 * 可观测性属 Phase 11）。它们**一律返回 `not_available` 并说明原因**，
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

/** `/model` —— 查看/设置档位到模型的分配。 */
function modelCommand(): CommandDefinition {
  return {
    name: 'model',
    description: '查看或设置档位模型',
    parameters: {
      positionals: [
        { name: 'action', required: false, description: 'use', schema: z.literal('use') },
        { name: 'tier', required: false, description: '档位名', schema: z.string() },
        { name: 'ref', required: false, description: 'provider/model', schema: z.string() },
      ],
    },
    interrupt: 'never',
    // 会写全局配置 —— 只允许本机 principal
    permission: { kind: 'local-principal' },
    auditEvent: 'command_received',
    idempotency: { kind: 'read-only' },
    persistResult: false,
    execute: async (ctx): Promise<CommandResult> => {
      const config = await ctx.host.readConfig()
      if (ctx.args['action'] !== 'use') {
        const lines = config.tiers.map((t) => `${t.tier} → ${t.providerId}/${t.modelId}`)
        return {
          ok: true,
          code: CommandResultCode.PANEL,
          text: lines.length === 0 ? '尚未配置任何档位' : `当前档位分配：\n${lines.join('\n')}`,
          data: { kind: 'model_panel', tiers: config.tiers, models: config.models },
        }
      }
      // `use` 分支需要 `resolveModelRef` 的消歧与能力校验，属于 Phase 6 的
      // 后续增量；先明确报未实现，而不是写一个不校验的版本。
      return {
        ok: false,
        code: CommandResultCode.NOT_AVAILABLE,
        text: '设置档位模型尚未实现（需要 provider/model 消歧与能力校验）',
        errorCode: ErrorCode.COMMAND_NOT_AVAILABLE,
        data: { subsystem: 'model assignment', phase: 'Phase 6 后续' },
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
    modelCommand(),

    // 诚实降级：这些命令指向尚未实现的子系统。
    // 它们**存在**（用户在补全列表里能看到、能理解为什么不可用），
    // 但绝不假装成功。
    unavailableCommand({
      name: 'skills',
      description: '查看 skills',
      subsystem: 'Skill',
      phase: 'Phase 8',
    }),
    unavailableCommand({
      name: 'mcp',
      description: '查看 MCP 服务',
      subsystem: 'MCP',
      phase: 'Phase 10',
    }),
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
      phase: 'Phase 6 后续',
    }),
    unavailableCommand({
      name: 'thinking',
      description: '开关思考',
      subsystem: '思考开关的运行时消费',
      // 配置侧已就绪（ModelProfile.thinkingEnabled），但 runtime 构造
      // ModelRequest 时**从不发送 thinking 字段** —— 只改配置不产生任何
      // 行为变化，是"欺骗性的空操作"。
      phase: 'runtime 侧尚未消费 ModelRequest.thinking',
    }),
    unavailableCommand({
      name: 'reasoning',
      description: '设置思考强度',
      subsystem: '思考强度的运行时消费',
      phase: 'runtime 侧尚未消费 ModelRequest.thinking',
    }),
    unavailableCommand({
      name: 'effort',
      description: '设置思考档位',
      subsystem: '思考档位的运行时消费',
      phase: 'runtime 侧尚未消费 ModelRequest.thinking',
    }),
    unavailableCommand({
      name: '1M',
      description: '切换 1M 上下文',
      subsystem: '1M 上下文切换',
      // parts/09 §9.2：开启但模型不支持时必须拒绝，不能静默降级。
      // 这需要先有"当前档位模型的能力快照"，属 Phase 6 后续。
      phase: 'Phase 6 后续',
    }),
  ])
  return registry
}
