/**
 * 从存储、配置与命令结果里**派生界面数据**的纯函数。
 *
 * 与控制器的其它部分没有耦合：输入是 `ConfigDocument` / 已落盘的 `Message` /
 * 命令返回的 `data`，输出是状态栏、待办面板与选择列表要用的数据。
 * 单独成文件有两个理由：控制器已经接近文件长度上限
 * （`common/coding-style.md`：800 行），而这几段逻辑是**可单独测试**的纯函数。
 */

import { PRIMARY_TIER } from '../../commands/types.js'
import { MessageSubtype } from '../../core/models.js'
import type { ConfigDocument } from '../../storage/types.js'

import { SelectionContext, type StatusModel, type TodoEntry } from './types.js'

/**
 * 从配置里解析状态栏的主模型。
 *
 * 主循环固定用 `PRIMARY_TIER`（定义在 `commands/types.ts`，那边有完整说明），
 * 所以状态栏展示的就是该档位绑定的模型。没有可用绑定时返回 `undefined`
 * ——状态栏据此显示 `STATUS_NO_MODEL`。
 */
export function describePrimaryModel(config: ConfigDocument): StatusModel | undefined {
  const assignment = config.tier_assignments.find(
    (item) => item.tier === PRIMARY_TIER && item.enabled,
  )
  if (!assignment) return undefined
  const { providerId, modelId } = assignment.modelRef
  const provider = config.providers.find((item) => item.id === providerId)
  const model = config.model_profiles.find(
    (item) => item.providerId === providerId && item.id === modelId,
  )
  if (!provider || !model) return undefined
  return {
    providerName: provider.name,
    modelName: model.displayName ?? model.id,
    thinkingEnabled: model.thinkingEnabled === true,
    reasoningEffort: model.reasoningEffort,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens,
    tier: assignment.tier,
    inputCostPerMillion: model.inputCostPerMillion,
    outputCostPerMillion: model.outputCostPerMillion,
  }
}

/** 从消息流里取最近一次 `todo_write` 的待办。 */
export function extractTodos(
  messages: readonly { meta: string; subtype: string }[],
): readonly TodoEntry[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message || message.subtype !== MessageSubtype.TOOL_RESULT) continue
    let meta: Record<string, unknown>
    try {
      meta = JSON.parse(message.meta) as Record<string, unknown>
    } catch {
      continue
    }
    if (meta['tool_name'] !== 'todo_write') continue
    const todos = meta['todos']
    if (!Array.isArray(todos)) return []
    return todos
      .map((entry) => {
        const record = (entry ?? {}) as Record<string, unknown>
        return {
          content: typeof record['content'] === 'string' ? record['content'] : '',
          status: typeof record['status'] === 'string' ? record['status'] : 'pending',
        }
      })
      .filter((entry) => entry.content.length > 0)
  }
  return []
}

/**
 * 把命令返回的 `data` 窄化成记录。
 *
 * `CommandResult.data` 的类型是 `Readonly<Record<string, unknown>>`，但它是
 * **跨模块边界的输入**：命令层可以塞任何东西进来。读之前一律先窄化。
 */
export function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {}
}

/** 取记录里的字符串字段。非字符串一律当空串——命令返回的 data 不可信。 */
export function stringField(record: Readonly<Record<string, unknown>>, key: string): string {
  const value = record[key]
  return typeof value === 'string' ? value : ''
}

/** 命令返回的 `data.context` → 选择语境。未知语境退回 `main`。 */
export function contextFromData(value: unknown): SelectionContext {
  if (value === SelectionContext.SESSION_SELECT) return SelectionContext.SESSION_SELECT
  if (value === SelectionContext.FILE_MENTION) return SelectionContext.FILE_MENTION
  if (value === SelectionContext.PERMISSION_REQUEST) return SelectionContext.PERMISSION_REQUEST
  return SelectionContext.MAIN
}

/**
 * 命令返回的 `data.body` → 面板正文。
 *
 * 目前没有命令用它（`panel` 类结果把正文放在 `text` 里），保留是因为它是
 * `panel` 契约的一部分：命令可以选择给出比 `text` 更长的正文。
 */
export function bodyFromData(data: Readonly<Record<string, unknown>>): string {
  const body = data['body']
  return typeof body === 'string' ? body : ''
}
