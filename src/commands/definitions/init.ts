/**
 * `/init` —— 用一段预置 prompt 让模型探索项目并生成/更新 `FLYINCHAT.md`。
 *
 * 旧实现是 `app.py:910-946` 的 `_run_init()`，`parts/05` §4.5 的结论很准确：
 * 「`/init` **就是一条预置 prompt 的普通提问**，不是独立流程」——它没有专属的
 * 工具、没有专属的 agent，只是"建会话 → 把这段文本当用户消息提交"。
 *
 * ## 与旧实现的两处**有意不同**（其余逐条对齐）
 *
 * 1. **由谁落盘用户消息**。旧实现里 `add_message(role="user", content=prompt)`
 *    这一步是 **UI 做的**（`app.py:937-943`），引擎不重复落盘——这正是
 *    `parts/05` §12.1 不变量 7「用户消息由 TUI 落盘，引擎不重复落盘」。
 *    本项目的 TS 架构把这次落盘挪进了 runtime：`submitTurn` → `beginTurn` 会写
 *    用户消息（`chat-runtime` 的 turn 起点）。所以这里**只调 `submitTurn`，
 *    不额外落盘**——照着旧代码再调一次就会写进两条一模一样的用户消息，
 *    模型会把整个任务做两遍。`tests/commands/init.test.ts` 里有一条真应用
 *    （`AgentApplication` + `CommandHostAdapter`）的用例专门断言"只有一条"。
 * 2. **输入历史**。旧实现显式 `_record_prompt_history(prompt)`；本项目的历史
 *    是**从落盘消息派生**的（TUI 读 `role=user & subtype=normal`），用户消息
 *    既然已由 runtime 落盘，历史自然就有了，不需要（也没有）额外的记录调用。
 *
 * 其余步骤逐条对齐 `_run_init()`：
 * 先查主模型 → 无则弹面板且**什么都不提交** → 无会话则建一个（标题固定
 * `"/init"`）→ 弹面板 → 提交 prompt。
 */

import { ErrorCode, toAgentError } from '../../core/errors.js'
import { INIT_PANEL, INIT_PROMPT, INIT_SESSION_TITLE, type PromptLanguage } from '../prompts.js'
import {
  CommandResultCode,
  PRIMARY_TIER,
  type CommandConfigView,
  type CommandDefinition,
  type CommandResult,
} from '../types.js'

/**
 * 取界面语言。
 *
 * 旧实现用的是当前 i18n 语言（`t(TKey.INIT_PROMPT)`），而语言来自
 * `app_settings.language`（`app.py:338-345`）。`/language` 命令写的正是这一项，
 * 所以这里按同一来源选文案；未设置时按项目默认的 `zh`。
 */
function languageOf(config: CommandConfigView): PromptLanguage {
  return config.settings['language'] === 'en' ? 'en' : 'zh'
}

/**
 * 主模型是否可用。
 *
 * 判据与 `ModelRouter.resolveCandidate` 保持一致（档位启用 + provider 在且启用
 * + 模型在且启用），因为那才是"这个 turn 真的跑得起来"的条件。**不看
 * fallbackModelRefs**：旧实现只看主模型（`is_default`），没有回退概念。
 *
 * 存在的意义是"提前挡下注定失败的提交"：没有主模型时提交，模型只会拿到一个
 * 路由错误，而用户看到的应该是「请先配置模型」这条可执行的指引。
 */
function hasPrimaryModel(config: CommandConfigView): boolean {
  const assignment = config.tiers.find((t) => t.tier === PRIMARY_TIER && t.enabled)
  if (!assignment) return false
  const provider = config.providers.find((p) => p.id === assignment.providerId)
  if (provider === undefined || !provider.enabled) return false
  const model = config.models.find(
    (m) => m.id === assignment.modelId && m.providerId === assignment.providerId,
  )
  return model !== undefined && model.enabled
}

export function createInitCommand(): CommandDefinition {
  return {
    name: 'init',
    description: '初始化项目上下文',
    parameters: { positionals: [] },
    // 旧实现不打断也不排队：`/init` 在 turn 运行中提交会撞上 runtime 的忙碌检查，
    // 由注册表统一返回 `SESSION_BUSY`（`_run_init` 自己没有忙碌分支）
    interrupt: 'never',
    permission: { kind: 'always' },
    auditEvent: 'command_received',
    // 会**新建会话并提交一个 turn**，必须幂等：浏览器刷新、TUI 重发都不该
    // 产生第二个会话和第二遍任务。与 `/clear` 用同一个 TTL。
    idempotency: { kind: 'keyed', ttlMs: 60_000 },
    persistResult: true,
    execute: async (ctx): Promise<CommandResult> => {
      const config = await ctx.host.readConfig()
      const language = languageOf(config)
      const panel = INIT_PANEL[language]

      // ── 1. 无主模型：弹面板并**直接返回**（`app.py:915-919`）──
      // 注意这里连会话都不建：旧实现是 `return`，不产生任何副作用。
      if (!hasPrimaryModel(config))
        return {
          ok: false,
          code: CommandResultCode.PANEL,
          text: panel.noModel,
          errorCode: ErrorCode.MODEL_NOT_FOUND,
          data: { kind: 'init_panel', reason: 'no_primary_model' },
        }

      // ── 2. 无会话则新建，标题固定 `"/init"`（`app.py:926-931`）──
      // 固定标题而不是默认的"新会话"：旧实现如此，且用户在 `/sessions` 里能
      // 一眼看出这个会话是被 `/init` 开出来的。
      let sessionId = ctx.sessionId
      if (sessionId === undefined)
        sessionId = (await ctx.host.createSession(ctx.principalId, INIT_SESSION_TITLE)).id

      // ── 3. 提交 prompt（`app.py:935-945`）──
      // 用户消息的落盘由 runtime 在 `beginTurn` 里完成，这里**不重复落盘**，
      // 理由见文件头注释第 1 条。
      try {
        await ctx.host.submitTurn({
          principalId: ctx.principalId,
          sessionId,
          prompt: INIT_PROMPT[language],
        })
      } catch (error) {
        const e = toAgentError(error, 'command.init')
        return {
          ok: false,
          code: CommandResultCode.FAILED,
          text: e.message,
          errorCode: e.code,
        }
      }

      // `code: PANEL` 对应旧实现的面板（`_show_panel(PANEL_INIT, PANEL_INIT_BODY)`），
      // `data.kind: 'switch_session'` 让 UI 切到刚建/当前会话——与 `/clear` 同一约定。
      // 两者同时给是有意的：TUI 的 `commandViewOf` 先认 `data.kind`（面板里那句话
      // 就作为提示文本显示），而按 `code` 分流的客户端仍能拿到标题与正文。
      return {
        ok: true,
        code: CommandResultCode.PANEL,
        text: panel.body,
        data: {
          kind: 'switch_session',
          sessionId,
          title: panel.title,
          body: panel.body,
        },
      }
    },
  }
}
