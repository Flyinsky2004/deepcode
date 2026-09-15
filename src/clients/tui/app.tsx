/**
 * Ink 视图层（`compose()` 的布局树，`app.py:317-336`）。
 *
 * 这个文件**只做渲染**：所有状态都在 `TuiController` 里，所有判定都在
 * `keys.ts` / `input.ts` / `events.ts` 里。它做的三件事是：
 * 把 Ink 的按键事件翻译成 `KeyInput`、把状态画成帧、把终端的 Ctrl+C 接到
 * 优雅关闭上。
 *
 * ## 与 Textual 的渲染差异（有意，见 `theme.ts`）
 *
 * - Textual 的 CSS（`border: round #334155`）在这里换成 **Ink 的 `borderStyle`**，
 *   颜色沿用同一批硬编码值；
 * - Textual 的 `Markdown` widget 会解析 `**bold**`，Ink 的 `Text` 不会——
 *   因此角色标签、面板标题改成**用颜色与加粗属性表达**，而不是在文本里放
 *   标记字符。可观测的语义（谁说了什么、哪一行是标题）不变。
 * - **布局的层级与角色与旧实现一致**（`#chat-area` / `#empty-state` /
 *   `#message-view` / `#composer` / `#todo-panel` / `#command-menu` /
 *   `#input-label` / `#prompt-input` / `#status-bar`，见 `theme.ts` 的 `IDS`）。
 *   ⚠️ **但 Ink 7 的 `Box`/`Text` 没有 `id` 属性**（该 prop 已从组件类型中移除），
 *   因此这些 id 只作为结构文档存在，不能用来定位节点——测试按可见文本断言，
 *   与旧测试不得不遍历 `#message-view` 子 widget 的 `._markdown` 是同一类妥协。
 */

import { Box, Text, useApp, useInput, type Key } from 'ink'
import { useCallback, useEffect, useSyncExternalStore, type ReactElement } from 'react'

import { TKey } from './i18n/keys.js'
import { translate } from './i18n/index.js'

import {
  formatMessageDisplay,
  renderPanelText,
  renderSelectionText,
  renderTodoPanel,
} from './format.js'
import { renderStatusBar } from './status-bar.js'
import { APP_TITLE, COLORS, EMPTY_LOGO, FOOTER_HINT } from './theme.js'
import { resolveInputPrompt, selectionTargetsMenu, type KeyInput } from './keys.js'
import { permissionHintText } from './events.js'
import type { TuiController } from './controller.js'
import type { Message } from '../../core/models.js'
import type { TuiState } from './types.js'

/**
 * 最多渲染多少条历史消息。
 *
 * Textual 为每条消息缓存了一个 `Markdown` widget（`chat_message.py` 的注释
 * 解释过这一点），而 Ink 每帧重建整棵树——不设上限会让每次按键的开销随
 * 历史长度线性增长。超出的部分整段省略，并明确显示省略了多少条。
 */
export const MAX_RENDERED_MESSAGES = 200

/** Ink 的按键 → 归一化 `KeyInput`。 */
export function toKeyInput(input: string, key: Key): KeyInput {
  if (key.tab) return { name: key.shift ? 'shift+tab' : 'tab' }
  if (key.escape) return { name: 'escape' }
  if (key.upArrow) return { name: 'up' }
  if (key.downArrow) return { name: 'down' }
  if (key.leftArrow) return { name: 'left' }
  if (key.rightArrow) return { name: 'right' }
  if (key.return) return { name: 'enter' }
  if (key.backspace || key.delete) return { name: 'backspace' }
  if (input === ' ') return { name: 'space' }
  if (input.length > 0) return { name: 'char', char: input }
  return { name: 'other' }
}

/** 顶栏。 */
function Header(): ReactElement {
  return (
    <Box backgroundColor={COLORS.chrome} paddingX={1}>
      <Text color={COLORS.chromeText} bold>
        {APP_TITLE}
      </Text>
    </Box>
  )
}

/** 底栏（旧 `Footer` 只显示 `q Quit` 一条绑定）。 */
function Footer(): ReactElement {
  return (
    <Box backgroundColor={COLORS.chrome} paddingX={1}>
      <Text color={COLORS.muted}>{FOOTER_HINT}</Text>
    </Box>
  )
}

/** 首页（logo + 提示）。 */
function EmptyState({ hint }: { readonly hint: string }): ReactElement {
  return (
    <Box flexDirection="column" alignItems="center" justifyContent="center">
      <Text color={COLORS.logo} bold>
        {EMPTY_LOGO}
      </Text>
      <Box marginTop={1}>
        <Text color={COLORS.muted}>{hint}</Text>
      </Box>
    </Box>
  )
}

/** 单条消息（角色标签 + 正文）。 */
function MessageBlock({
  message,
  language,
}: {
  readonly message: Message
  readonly language: TuiState['language']
}): ReactElement {
  const display = formatMessageDisplay(message, language)
  const [label, ...rest] = display.split('\n\n')
  const body = rest.join('\n\n')
  const color =
    message.role === 'user'
      ? COLORS.logo
      : message.role === 'assistant'
        ? COLORS.body
        : COLORS.muted
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={color} bold>
        {label}
      </Text>
      <Text color={COLORS.screenText}>{body}</Text>
    </Box>
  )
}

/** 消息区。 */
function MessageView({ state }: { readonly state: TuiState }): ReactElement {
  // 面板是**覆盖式**的：出现面板时消息区只渲染面板（BUG-COMPAT，§12.2 第 14 项）。
  if (state.panel) {
    return (
      <Box flexDirection="column">
        <Text color={COLORS.body}>{renderPanelText(state.panel)}</Text>
      </Box>
    )
  }

  const messages = state.messages
  const hidden = Math.max(0, messages.length - MAX_RENDERED_MESSAGES)
  const visible = hidden > 0 ? messages.slice(hidden) : messages

  return (
    <Box flexDirection="column">
      {hidden > 0 ? (
        <Text color={COLORS.muted}>{`… (${hidden} earlier messages hidden)`}</Text>
      ) : null}
      {visible.map((message) => (
        <MessageBlock key={message.id} message={message} language={state.language} />
      ))}
      {state.streamingText ? (
        <Box flexDirection="column" marginBottom={1}>
          <Text color={COLORS.body} bold>
            {translate(state.language, TKey.LABEL_ASSISTANT)}
          </Text>
          <Text color={COLORS.screenText}>{state.streamingText}</Text>
        </Box>
      ) : null}
      {state.notice ? <Text color={COLORS.muted}>{state.notice}</Text> : null}
      {/*
        审批说明（`_show_permission_request` 的 hint）。
        从队列派生而不是存进状态：见 `events.ts` 的说明。
        旧实现在"没有历史"时退回 `_show_panel`，本实现不需要那条分支——
        Ink 的消息区始终存在，提示直接渲染在这里；文本内容与面板完全相同
        （`PERM_TITLE` 自带 `## Permission Required` 标题）。
      */}
      {state.permissionQueue[0] ? (
        <Text color={COLORS.body}>
          {permissionHintText(state.permissionQueue[0], state.language)}
        </Text>
      ) : null}
      {state.lastError ? (
        <Text color={COLORS.todoTitle}>
          {translate(state.language, TKey.MISC_ERROR_PREFIX, { error: state.lastError })}
        </Text>
      ) : null}
    </Box>
  )
}

/** 待办面板。 */
function TodoPanel({ state }: { readonly state: TuiState }): ReactElement | null {
  if (!state.todoVisible) return null
  const rendered = renderTodoPanel(state.todos, state.language)
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={COLORS.todoBorder} paddingX={1}>
      <Text color={COLORS.todoTitle} bold>
        {`${rendered.title}  ${rendered.summary}`}
      </Text>
      {rendered.rows.map((row, index) => (
        <Text key={index} color={row.color}>
          {`${row.marker} ${row.content}`}
        </Text>
      ))}
    </Box>
  )
}

/** 命令菜单 / 提及菜单 / 权限动作菜单（一个 widget 承担多角色）。 */
function CommandMenu({ state }: { readonly state: TuiState }): ReactElement | null {
  if (state.selection && selectionTargetsMenu(state.selection)) {
    return (
      <Box borderStyle="round" borderColor={COLORS.menuBorder} paddingX={1}>
        <Text color={COLORS.screenText}>
          {renderSelectionText(state.selection, state.selection.selectedIndex)}
        </Text>
      </Box>
    )
  }
  if (state.menuNotice) {
    return (
      <Box borderStyle="round" borderColor={COLORS.menuBorder} paddingX={1}>
        <Text color={COLORS.muted}>{state.menuNotice}</Text>
      </Box>
    )
  }
  // 走到这里还有两类需要渲染的：
  // 1. 权限问卷（`#command-menu` 的第二角色，不走 `_render_selection`）；
  // 2. 语境不在菜单白名单的选择（`session_select` 等）——旧实现走 `_show_panel`。
  if (state.questionnaire) {
    return (
      <Box borderStyle="round" borderColor={COLORS.menuBorder} paddingX={1}>
        <Text color={COLORS.screenText}>{renderQuestionnaire(state)}</Text>
      </Box>
    )
  }
  if (state.selection) {
    return (
      <Box borderStyle="round" borderColor={COLORS.menuBorder} paddingX={1}>
        <Text color={COLORS.screenText}>
          {renderSelectionText(state.selection, state.selection.selectedIndex)}
        </Text>
      </Box>
    )
  }
  return null
}

/**
 * 问卷文本（`_render_user_input_question`，`app.py:1287-1330`）。
 *
 * T-13（修正）：旧实现在循环里先把 marker 设为 `"> "`，随后又被单选的
 * `"(*) "` 覆盖，于是那个分支在单选下**永不可见**。这里按真实状态推导标记：
 * 多选 `[x]`/`[ ]`（光标项带 `>`），单选 `(*)`/`( )`。
 *
 * 底部按键提示沿用旧实现**硬编码**的英文/符号串（`app.py:1322-1326`），
 * 与 §10.5 的"未 i18n 清单"一致。
 */
export function renderQuestionnaire(state: TuiState): string {
  const questionnaire = state.questionnaire
  if (!questionnaire) return ''
  const index = questionnaire.currentQuestion
  const question = questionnaire.questions[index]
  if (!question) return ''

  const answer = questionnaire.answers[index]
  const multi = question.multiSelect === true
  const lines = [
    `[${question.header}] ${question.question}`,
    `(${index + 1}/${questionnaire.questions.length})`,
    '',
  ]
  question.options.forEach((option, optionIndex) => {
    if (multi) {
      const selected = Array.isArray(answer) && answer.includes(option.label)
      const cursor =
        questionnaire.multiCursorLabel !== undefined
          ? questionnaire.multiCursorLabel
          : question.options[0]?.label
      const pointer = option.label === cursor ? '>' : ' '
      lines.push(`${pointer} ${selected ? '[x]' : '[ ]'} ${option.label} — ${option.description}`)
    } else {
      const selected = typeof answer === 'string' ? answer === option.label : optionIndex === 0
      lines.push(`${selected ? '(*)' : '( )'} ${option.label} — ${option.description}`)
    }
  })
  lines.push('')
  lines.push(
    multi
      ? 'Space=toggle  Enter=confirm selection  →=next  ←=prev'
      : '↑↓=navigate  Enter=select  ←=prev',
  )
  return lines.join('\n')
}

/** 输入框（含光标）。 */
function PromptInput({ state }: { readonly state: TuiState }): ReactElement {
  const { placeholder } = resolveInputPrompt(state)
  const active = state.permissionQueue.length === 0 && state.questionnaire === undefined
  const before = state.input.slice(0, state.cursor)
  const after = state.input.slice(state.cursor)
  return (
    <Box
      borderStyle="round"
      borderColor={active ? COLORS.focusBorder : COLORS.menuBorder}
      paddingX={1}
    >
      {state.input.length === 0 ? (
        <Text color={COLORS.muted}>{`> ${placeholder}`}</Text>
      ) : (
        <Text color={COLORS.body}>{`> ${before}${after}`}</Text>
      )}
    </Box>
  )
}

/** 状态栏。 */
function StatusBar({ state }: { readonly state: TuiState }): ReactElement {
  const rendered = renderStatusBar(state, state.statusModel)
  return (
    <Box paddingX={2} marginTop={1}>
      {/*
        ⚠️ 模式标签与正文必须放进**同一个** `<Text>`（嵌套 Text 继承外层样式），
        不能写成同一行 Box 里的两个 `<Text>`：那样 Ink 会把第一个子节点按
        剩余宽度压缩，`AUTO EDIT` 会被截成 `AUTO EDI`（实测）。
      */}
      <Text color={COLORS.status}>
        <Text color={rendered.modeColor} bold={rendered.modeBold}>
          {rendered.modeLabel}
        </Text>
        {`  ${rendered.text}`}
      </Text>
    </Box>
  )
}

/** 根组件。 */
export interface TuiAppProps {
  readonly controller: TuiController
  /** 退出时调用（`run.tsx` 用来做优雅关闭；测试可注入）。 */
  readonly onExit?: () => void
}

export function TuiApp({ controller, onExit }: TuiAppProps): ReactElement {
  const state = useSyncExternalStore(
    useCallback((listener: () => void) => controller.subscribe(listener), [controller]),
    useCallback(() => controller.getSnapshot(), [controller]),
  )
  const { exit } = useApp()

  useInput((input, key) => {
    // Ctrl+C 走优雅关闭（旧实现的 `action_quit` 语义）。
    if (key.ctrl && input === 'c') {
      onExit?.()
      exit()
      return
    }
    controller.applyKey(toKeyInput(input, key))
  })

  useEffect(() => {
    void controller.start()
    return () => {
      void controller.shutdown()
    }
  }, [controller])

  const { label } = resolveInputPrompt(state)
  const showEmpty =
    state.emptyStateVisible && state.messages.length === 0 && state.panel === undefined

  return (
    <>
      <Header />
      <Box flexDirection="column" paddingX={2} paddingY={1} flexGrow={1}>
        {showEmpty ? (
          <EmptyState hint={translate(state.language, TKey.EMPTY_HINT)} />
        ) : (
          <MessageView state={state} />
        )}
      </Box>
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <TodoPanel state={state} />
        <CommandMenu state={state} />
        <Text color={COLORS.muted}>{label}</Text>
        <PromptInput state={state} />
        <StatusBar state={state} />
      </Box>
      <Footer />
    </>
  )
}
