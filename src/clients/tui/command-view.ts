/**
 * `CommandResult` → 界面意图的**纯映射**。
 *
 * 命令层与 UI 之间只需要一条窄协议：命令说明"这是什么性质的结果"
 * （`code` + `data.kind`），UI 决定"画成什么"。把这张映射表写成纯函数而不是
 * 塞在控制器里，有两个好处：
 *
 * 1. **规则可单测**——不需要起控制器、应用或渲染器就能断言每一条分支；
 * 2. **命令层加命令时 UI 不用改**：分支按 `code`/`kind` 而不是按命令名，
 *    `/compact`、`/model`、以及 9 条"诚实降级"的命令走的都是同一条路径。
 *
 * 映射规则：
 *
 * | 输入 | 界面意图 |
 * |---|---|
 * | `ok` + `data.kind: 'switch_session'` | 切到指定会话，文本作为提示 |
 * | `ok` + `data.kind: 'set_language'` | 换翻译表（+ 写设置），文本作为提示 |
 * | `ok` + `data.kind: 'session_select'` | 会话选择列表 |
 * | `ok` + `data.items` + `code: 'selection'` | 通用选择列表 |
 * | `ok` + `code: 'panel'` | 面板：标题是命令名，正文优先 `data.body` |
 * | `ok` | 文本直接输出 |
 * | 失败 + 注册表认识该命令 | 面板：**标题是命令名**，正文照实显示命令层文本 |
 * | 失败 + 注册表不认识 | 面板：标题是"未知命令" |
 *
 * 最后两行是"诚实降级"的关键：`/mcp`、`/skills` 等命令返回
 * `not_available` + 原因，它们**存在但不可用**。渲染成"未知命令"会让用户以为
 * 是自己拼错了，而正文里的「依赖的 XX 子系统尚未实现（Phase N）」正是要
 * 传达的信息。
 */

import { CommandResultCode, type CommandResult } from '../../commands/types.js'
import { TKey, type Language } from './i18n/keys.js'
import { translate } from './i18n/index.js'
import { asRecord, contextFromData, stringField } from './sources.js'
import { SelectionContext, type Selection } from './types.js'

/** 界面意图。控制器负责把它落到状态与效果上。 */
export type CommandView =
  /** 文本输出（消息区的临时提示）。 */
  | { readonly kind: 'text'; readonly text: string }
  /** 覆盖式面板。 */
  | { readonly kind: 'panel'; readonly title: string; readonly body: string }
  /** 选择列表（渲染到 `#command-menu` 或面板，由语境决定）。 */
  | { readonly kind: 'selection'; readonly selection: Selection }
  /** 切到另一个会话（`/clear` 的命令层语义）。 */
  | { readonly kind: 'switch-session'; readonly sessionId: string; readonly text: string }
  /** 换翻译表（`/language`）——UI 侧的表现层动作。 */
  | { readonly kind: 'set-language'; readonly language: string; readonly text: string }

/** 映射输入。 */
export interface CommandViewInput {
  /** 命令原文（含前导 `/`）。 */
  readonly raw: string
  readonly result: CommandResult
  /** 注册表是否认识这条命令（区分"未知命令"与"存在但不可用"）。 */
  readonly known: boolean
  readonly language: Language
}

/** 从命令原文里取命令名（去掉前导 `/`，忽略参数）。 */
export function commandNameOf(raw: string): string {
  return (raw.trim().split(/\s+/)[0] ?? raw.trim()).replace(/^\//, '')
}

/** 映射。 */
export function commandViewOf(input: CommandViewInput): CommandView {
  const { result, language } = input
  const name = commandNameOf(input.raw)
  const data = result.data ?? {}
  const typed = stringField(data, 'kind')

  // ── 1. `data.kind` 约定的界面意图 ──
  if (result.ok && typed === 'switch_session')
    return { kind: 'switch-session', sessionId: stringField(data, 'sessionId'), text: result.text }

  if (result.ok && typed === 'set_language')
    return { kind: 'set-language', language: stringField(data, 'language'), text: result.text }

  if (result.ok && typed === 'session_select')
    return {
      kind: 'selection',
      selection: {
        context: SelectionContext.SESSION_SELECT,
        title: translate(language, TKey.SEL_SESSION_TITLE),
        header: '',
        footer: translate(language, TKey.SEL_SESSION_FOOTER),
        items: asArray(data['sessions']).map((entry) => {
          const record = asRecord(entry)
          return {
            key: stringField(record, 'id'),
            title: stringField(record, 'title'),
            // 旧 TUI 的副标题是会话时间戳；命令层给的是轮次，同样有信息量。
            description: `${typeof record['current_turn'] === 'number' ? record['current_turn'] : 0}`,
          }
        }),
        selectedIndex: 0,
      },
    }

  // ─ 2. 通用选择列表（旧形状 `data.items`）──
  if (result.code === CommandResultCode.SELECTION)
    return {
      kind: 'selection',
      selection: {
        context: contextFromData(data['context']),
        title: result.text,
        header: '',
        footer: '',
        items: asArray(data['items']).map((entry) => {
          const record = asRecord(entry)
          return {
            key: stringField(record, 'key'),
            title: stringField(record, 'title'),
            description: stringField(record, 'description'),
          }
        }),
        selectedIndex: 0,
      },
    }

  // ── 3. 面板 ─
  if (result.code === CommandResultCode.PANEL)
    return {
      kind: 'panel',
      title: `/${name}`,
      body: stringField(data, 'body') || result.text,
    }

  // ── 4. 失败：按"命令是否存在"分流 ──
  if (!result.ok)
    return {
      kind: 'panel',
      title: input.known ? `/${name}` : translate(language, TKey.PANEL_UNKNOWN_CMD),
      body: result.text,
    }

  // ── 5. 成功：文本直接输出 ──
  return { kind: 'text', text: result.text }
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}
