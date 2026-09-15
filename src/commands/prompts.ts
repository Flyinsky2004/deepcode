/**
 * 命令层用到的**逐字转录**提示词与面板文案。
 *
 * ## 为什么单独成文件
 *
 * `CLAUDE.md` 的硬性约定：「提示词逐字一致……改写即导致行为不等价」。这段文本
 * 直接决定模型行为（它要求模型先探索项目再写 `FLYINCHAT.md`），所以它既不能
 * 自撰、也不该和命令逻辑混在一起——单独放一处，日后与旧源码核对时只看这个文件。
 *
 * ## 来源（旧 Python 项目 `FlyinChat`）
 *
 * | 键 | 文件:行 | 使用处 |
 * |---|---|---|
 * | `TKey.INIT_PROMPT`（zh） | `src/flyinchat/i18n/zh.py:219-236` | `app.py:936` |
 * | `TKey.INIT_PROMPT`（en） | `src/flyinchat/i18n/en.py:219-239` | 同上 |
 * | `TKey.PANEL_INIT` | `i18n/{zh,en}.py:107` | `app.py:934` |
 * | `TKey.PANEL_INIT_BODY` | `i18n/{zh,en}.py:108` | `app.py:934` |
 * | `TKey.PANEL_INIT_NO_MODEL` | `i18n/{zh,en}.py:109` | `app.py:917` |
 *
 * 调用方是 `src/flyinchat/app.py:910-946` 的 `_run_init()`。
 *
 * ## 转录规则
 *
 * - Python 用的是**相邻字符串字面量隐式拼接**，这里用 `+` 显式拼接，**按旧源码
 *   的换行位置逐行对应**——这样 diff 时能一眼看出哪一段对不上。
 * - 标点、空格、`\n` 的数量、以及"看起来像笔误"的地方**一律照抄**（下方有标注）。
 * - zh 与 en **不是逐句对应**的译文：en 版要求 3 里保留着中文 `"TODO:待确认"`
 *   （原文如此，见 `i18n/en.py:234`），en 版还把几句话重新断行了。两者都照抄，
 *   不做对齐。
 * - 文本里的 `FLYINCHAT.md` 是旧项目的文件名。本项目的数据目录已改名
 *   （`~/.deepcode/`），但**提示词里的文件名保持原样**——改了就不是逐字转录，
 *   模型产出的文件也就与旧项目不可比。是否改名为 `DEEPCODE.md` 属于产品决策，
 *   不在转录范围内。
 */

/**
 * 提示词语言。
 *
 * 取值与 `app_settings.language` 一致（`/language` 命令写入的那一项），
 * 也与旧实现的 `I18nStore` 一致——旧 `_run_init` 用的是 `t(TKey.INIT_PROMPT)`，
 * 即**跟随界面语言**，不是写死某一种。
 */
export type PromptLanguage = 'zh' | 'en'

/** 新建会话的固定标题（`app.py:928`：`create_conversation(..., title="/init")`）。 */
export const INIT_SESSION_TITLE = '/init'

/** `TKey.INIT_PROMPT`：`/init` 提交给模型的那段初始化指令。 */
export const INIT_PROMPT: Readonly<Record<PromptLanguage, string>> = {
  // ── i18n/zh.py:219-236 ──
  zh:
    '你正在执行项目初始化任务。目标是为当前工作区生成或更新一份 FLYINCHAT.md 文件，' +
    '作为后续 AI 协作的项目约束文档。\n\n' +
    '要求：\n' +
    '1. 先通过阅读关键文件（README、包配置、源码结构、测试配置、lint 配置）探索项目再动笔，' +
    '不得凭空编造命令或技术栈。\n' +
    '2. FLYINCHAT.md 必须覆盖：\n' +
    '   - 项目简介与目标\n' +
    '   - 目录结构与关键模块\n' +
    '   - 安装/启动/测试命令\n' +
    '   - 代码规范与提交约定\n' +
    '   - 常见风险与禁止事项\n' +
    '   - 推荐工作流（如先计划后改动）\n' +
    '3. 信息不确定时，明确标注"TODO:待确认"，并给出建议确认方式。\n' +
    '4. 输出为可保存的 Markdown，直接写入工作区根目录的 FLYINCHAT.md。\n' +
    '5. 保持简洁、可执行、可维护。\n' +
    '6. 若 FLYINCHAT.md 已存在，请保留有效规则并做增量改进，避免无关重写。',

  // ── i18n/en.py:219-239 ──
  en:
    'You are executing a project initialization task. Your goal is to generate or update ' +
    'a FLYINCHAT.md file in the workspace root, which will serve as the project constraint ' +
    'document for future AI collaboration.\n\n' +
    'Requirements:\n' +
    '1. First, explore the project by reading key files (README, package config, source ' +
    'structure, test config, lint config) before writing anything. Do NOT fabricate commands ' +
    'or tech stack.\n' +
    '2. The FLYINCHAT.md must cover:\n' +
    '   - Project overview and goals\n' +
    '   - Directory structure and key modules\n' +
    '   - Install/run/test commands\n' +
    '   - Code conventions and commit conventions\n' +
    '   - Common risks and prohibited actions\n' +
    '   - Recommended workflow (e.g., plan first, then change)\n' +
    // 原文如此：en 版这条里的 "TODO:待确认" 是中文，未翻译（i18n/en.py:234）
    '3. Mark uncertain information clearly as "TODO:待确认" and suggest how to verify it.\n' +
    '4. Output as clean, well-structured Markdown saved to FLYINCHAT.md in the workspace root.\n' +
    '5. Keep it concise, actionable, and maintainable.\n' +
    '6. If FLYINCHAT.md already exists, preserve valid rules and make incremental improvements ' +
    'rather than rewriting everything.',
}

/**
 * `/init` 的面板文案。
 *
 * 旧实现里这三个键分别用在两处：无主模型时 `_show_panel(PANEL_INIT_NO_MODEL, "")`
 * （`app.py:915-919`），有主模型时 `_show_panel(PANEL_INIT, PANEL_INIT_BODY)`
 * （`app.py:934`）。
 *
 * `TKey.PANEL_INIT_DONE`（"FLYINCHAT.md 已生成到工作区根目录。"）**没有转录**：
 * 它在旧源码里只被定义、从未被引用（`grep -rn PANEL_INIT_DONE` 除 i18n 表外无命中），
 * 转录一个没有调用点的文案只会制造"这里本该有段逻辑"的错觉。
 */
export const INIT_PANEL: Readonly<
  Record<
    PromptLanguage,
    { readonly title: string; readonly body: string; readonly noModel: string }
  >
> = {
  // ── i18n/zh.py:107-109 ──
  zh: {
    title: '项目初始化',
    body: '正在探索项目结构并生成 FLYINCHAT.md...',
    noModel: '未配置主模型。请先使用 /api 添加模型，再使用 /model 选择。',
  },
  // ── i18n/en.py:107-109 ──
  en: {
    title: 'Project Initialization',
    body: 'Exploring project structure and generating FLYINCHAT.md...',
    noModel:
      'No primary model configured. Please add one with /api first, then select it with /model.',
  },
}
