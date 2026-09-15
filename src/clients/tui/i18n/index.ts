/**
 * 翻译存储。
 *
 * 复刻 `i18n/store.py` 的三条行为：
 * 1. **零 I/O**：两张表是模块级字面量，import 时就在内存里。
 * 2. **缺键返回键名本身**（`str(key)`），不抛错——界面显示 `status.working`
 *    比整屏崩掉有用。
 * 3. `kwargs` 非空时走模板替换。JS 的模板是 `${name}` 而 Python 是 `{name}`，
 *    为保持与旧表**逐字兼容**（文案表是从 `en.py`/`zh.py` 抄来的），
 *    这里自己实现 `{name}` 替换，不用 JS 模板字符串。
 */

import { TKey, Language, type TKey as TKeyType } from './keys.js'
import { EN } from './en.js'
import { ZH } from './zh.js'

/** 键 → 模板。 */
const TRANSLATIONS: Readonly<Record<Language, Readonly<Record<TKeyType, string>>>> = {
  [Language.EN]: EN,
  [Language.ZH]: ZH,
}

/** 模板占位符：`{name}`，与旧表一致。 */
const PLACEHOLDER = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g

export type TranslationParams = Readonly<Record<string, string | number>>

/**
 * 渲染一条文案。
 *
 * 未知语言、缺失键都退化为键名——`t()` 是 UI 热路径，不能抛错。
 */
export function translate(language: Language, key: string, params?: TranslationParams): string {
  const table = TRANSLATIONS[language] ?? TRANSLATIONS[Language.EN]
  const template = table[key as TKeyType]
  if (template === undefined) return key
  if (params === undefined) return template
  return template.replace(PLACEHOLDER, (match, name: string) => {
    const value = params[name]
    // 未提供的占位符原样保留：让漏传参数在界面上可见，而不是显示 "undefined"。
    return value === undefined ? match : String(value)
  })
}

/**
 * 翻译存储。
 *
 * **不可变**：`withLanguage()` 返回新实例而不是原地改语言。旧实现是原地
 * `set_language`，但那使"这一帧用哪种语言渲染"取决于调用顺序；
 * 本实现把语言放进 `TuiState`，切换即产生新状态（`common/coding-style.md`）。
 */
export class I18nStore {
  readonly language: Language

  constructor(language: Language = Language.EN) {
    // 非法值静默退回 EN —— 旧实现 `_load_language` 用 `except ValueError: pass`
    // 吞掉非法值，行为保持一致。
    this.language = language in TRANSLATIONS ? language : Language.EN
  }

  /** 返回切换语言后的新实例。 */
  withLanguage(language: Language): I18nStore {
    return language === this.language ? this : new I18nStore(language)
  }

  /** 取文案。 */
  t(key: TKeyType, params?: TranslationParams): string {
    return translate(this.language, key, params)
  }
}

export { TKey, Language }
export type { TKeyType }
export { EN } from './en.js'
export { ZH } from './zh.js'
export { ALL_KEYS } from './keys.js'
