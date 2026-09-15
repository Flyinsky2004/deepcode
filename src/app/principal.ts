/**
 * 本机 principal 的确定与旧会话认领。
 *
 * TUI 是单用户界面，但它同样需要一个 `principalId`——因为
 * `Conversation.principal_id` 与权限校验都以它为准（`parts/09` §1.1）。
 *
 * ️ **必须持久化，不能每次启动随机生成**。否则重启后
 * `canAccess()` 会认为所有既有会话都不属于自己，用户会"丢失"全部历史。
 * 这里把它存在 `config.json` 的 `app_settings` 里。
 */

import { createPrincipalId, type PrincipalId } from '../core/ids.js'
import type { ChatStore } from '../storage/chat-store.js'
import type { ConfigStore } from '../storage/config-store.js'

/** `app_settings` 里存放本机 principal 的键名。 */
export const LOCAL_PRINCIPAL_SETTING = 'local_principal_id'

/** 标记"旧会话已被认领"，避免每次启动都重写整个 `chat.json`。 */
export const PRINCIPAL_CLAIM_SETTING = 'principal_claimed_at'

export interface EnsureLocalPrincipalResult {
  readonly principalId: PrincipalId
  /** 本次认领的会话数（值为 `principal_id === ''` 的历史会话）。 */
  readonly claimed: number
}

/**
 * 取得本机 principal；首次调用时生成并落盘。
 *
 * 同时把 `principal_id` 为空串的历史会话认领给本机 principal——
 * 旧 `chat.json` 没有这个字段（见 `Conversation.principal_id` 的说明），
 * 认领之后它们才对本机用户可见。
 *
 * 认领只在**首次**执行（用 `app_settings` 里的标记判断）：否则每次启动都会
 * 对整份 `chat.json` 做一次全量重写，而它本来就是写放大最严重的文件。
 */
export async function ensureLocalPrincipal(
  configStore: ConfigStore,
  chatStore: ChatStore,
): Promise<EnsureLocalPrincipalResult> {
  const config = await configStore.read()
  const existing = config.app_settings[LOCAL_PRINCIPAL_SETTING]

  let principalId: PrincipalId
  if (typeof existing === 'string' && existing.length > 0) {
    principalId = existing as PrincipalId
  } else {
    principalId = createPrincipalId()
    await configStore.update((doc) => ({
      ...doc,
      app_settings: { ...doc.app_settings, [LOCAL_PRINCIPAL_SETTING]: principalId },
    }))
  }

  const alreadyClaimed = (await configStore.read()).app_settings[PRINCIPAL_CLAIM_SETTING]
  if (typeof alreadyClaimed === 'string' && alreadyClaimed.length > 0)
    return { principalId, claimed: 0 }

  const conversations = await chatStore.listConversations()
  const orphans = conversations.filter((c) => c.principal_id === '')
  if (orphans.length > 0) {
    await chatStore.update((doc) => ({
      ...doc,
      conversations: doc.conversations.map((c) =>
        c.principal_id === '' ? { ...c, principal_id: principalId } : c,
      ),
    }))
  }

  await configStore.update((doc) => ({
    ...doc,
    app_settings: {
      ...doc.app_settings,
      [PRINCIPAL_CLAIM_SETTING]: new Date().toISOString(),
    },
  }))

  return { principalId, claimed: orphans.length }
}

/**
 * 判断某 principal 能否访问某会话。
 *
 * `principal_id` 为空串是**旧数据**——只有本机 principal 能访问，
 * 避免 Web 上的其他用户读到迁移前的历史。
 */
export function canAccess(
  principalId: string,
  conversation: { readonly principal_id: string },
  localPrincipalId: string,
): boolean {
  if (conversation.principal_id === principalId) return true
  return conversation.principal_id === '' && principalId === localPrincipalId
}
