# 05 — TUI 层（Textual 应用）复刻规格

> Web 浏览器模式不是 TUI 的分支实现。使用 `--web-ui` 时由独立 HTTP/WebSocket adapter 提供界面，遵守 `09-typescript-agent-standard.md` 的监听、认证、事件补发和 session 授权规范；TUI 与 Web UI 共享同一个 Agent runtime。

> **导航**：本文件是 `docs/REWRITE_SPEC.md`（总纲）的子规格。建议先读总纲了解架构全景，再回到本文件逐条实现。
> 相关：总纲 §0.2.1（文档与代码冲突清单）、§7（已知缺陷与复刻决策）、§8（复刻路线图）。


> 目标：用另一种语言从零复刻 FlyinChat 的终端界面层。本文件覆盖 `src/flyinchat/app.py`（2435 行，单一巨型 App 类）、`chat_message.py`、`file_mentions.py`、`i18n/`、`__main__.py` 以及相关测试与设计文档。
> 阅读顺序建议：§1 结构 → §2 布局 → §3 键位 → §4 命令 → §5 @引用 → §6 模式 → §7 权限 → §8 流式 → §9 引擎接口 → §10 i18n → §11 初始化序列 → §12 不变量与检查清单。

---

## 0. 模块边界与定位

TUI 层由以下文件组成：

| 文件 | 行数 | 职责 |
|---|---|---|
| `src/flyinchat/app.py` | 2435 | 唯一入口 `FlyinChatApp(App[None])`，持有全部 UI 状态 + 引擎引用 + 工具注册表 |
| `src/flyinchat/chat_message.py` | 21 | `ChatMessage(Markdown)`，单条消息 widget |
| `src/flyinchat/file_mentions.py` | 102 | `@` 提及的纯函数（无 UI 依赖，可单测） |
| `src/flyinchat/i18n/{__init__,keys,store,en,zh}.py` | 4+229+42+255+252 | 静态翻译表 |
| `src/flyinchat/__main__.py` | 4 | `python -m flyinchat` → `app.run()` |

TUI 层的架构约束（来自 `docs/tui-to-queryengine/README.md` §3A）：

- **UI 不直接调用工具**，只通过 `QueryEngine`。
- **UI 不拼接上下文**（system prompt、历史裁剪、compact 全在引擎侧）。
- **UI 只做三件事**：把用户输入交给引擎、消费 `TurnEvent` 更新界面、把用户对权限/提问的决策回传引擎。

违反这一点的两处已存在的例外（复刻时必须保留，否则行为不一致）：

1. `_resolve_pending_permission()` 在 UI 侧额外对 `ToolExecutor` 写入 allowlist（`app.py:1481-1511`），引擎侧也做一遍（`query_engine.py:1019-1068`）。
2. `/compact` 命令直接构造 `CompactionEngine` 并调用（`app.py:1707-1717`），绕过 `QueryEngine`。

---

## 1. 应用结构

### 1.1 模块级前置动作

```python
# app.py:8 —— 必须在 import textual 之前执行
os.environ.setdefault("TEXTUAL_DISABLE_KITTY_KEY", "1")
```

阻止 Textual 启用 kitty 键盘协议增强（否则某些终端下 `shift+tab` 等键上报不一致）。

`_EMPTY_LOGO`（`app.py:78-85`）是一段 6 行 ASCII art 大标题（`███████╗██╗...`），`.strip()` 后作为首页 logo。

### 1.2 两个不可变数据类

```python
# app.py:88-92
@dataclass(frozen=True)
class SelectionItem:
    key: str          # 选中后回传的稳定标识（命令名 / model id / "approve" / 文件相对路径）
    title: str        # 显示标题
    description: str  # 副标题（缩进 4 空格渲染在下一行）

# app.py:95-99
@dataclass(frozen=True)
class FormState:
    kind: str                  # "deepseek" | "openai" | "anthropic"
    step: int                  # 当前步（0-based）
    values: tuple[str, ...]    # 已收集的值
```

### 1.3 `FlyinChatApp.__init__`（`app.py:106-163`）

```python
class FlyinChatApp(App[None]):
    TITLE = "FlyinChat"                                   # app.py:103
    SPINNER_FRAMES = ("|", "/", "—", "\\")                # app.py:104
```

构造函数签名：`__init__(self, paths: AppPaths | None = None, observability_client: ObservabilityClient | None = None)`。

构造期**只赋初值，不做任何 I/O**。全部实例字段（复刻时必须逐一同名，测试直接访问它们）：

| 字段 | 初值 | 语义 |
|---|---|---|
| `i18n` | `I18nStore()` | 翻译存储（默认 EN） |
| `paths` | 参数或 `None` | `AppPaths`，在 `compose()` 里才被 `initialize_storage` 填充 |
| `_injected_observability_client` | 参数 | 测试注入用；非 None 时 `_init_observability` 直接返回 |
| `_observability_client` | 注入值或 `NoopObservabilityClient()` | 可观测客户端 |
| `active_conversation_id` | `None` | **当前会话 id；None 表示"还没建会话"** |
| `selection_context` | `None` | 当前选择菜单的语境，见 §4.8 |
| `selection_title` / `selection_header` / `selection_footer` | `""` | 菜单文本三段 |
| `selection_items` | `()` | `tuple[SelectionItem, ...]` |
| `selected_index` | `0` | 高亮项 |
| `form_state` | `None` | 多步表单状态 |
| `_last_escape_time` | `0.0` | 双击 Esc 判定（`time.monotonic()`） |
| `_suppress_menu_update` | `False` | 程序化改 `Input.value` 时抑制菜单重算 |
| `_last_usage` | `{}` | **只写不读**（历史遗留），见 §12 |
| `_total_output_tokens` | `0` | 会话累计输出 token |
| `_last_input_tokens` | `0` | 最近一轮输入 token |
| `_tool_registry` / `_tool_executor` / `_tool_context` | `None` | 工具三件套 |
| `_query_engine` | `None` | **一旦为 None 就重建**（换会话/换模型/换 langfuse 都会置 None） |
| `_compacting` | `False` | 状态栏分支 |
| `_is_streaming` | `False` | 状态栏分支 + Esc 语义切换 |
| `_spinner_frame` | `0` | 动画帧索引 |
| `_spinner_timer` | `None` | Textual `Timer` 句柄 |
| `_streaming_output_tokens` | `0` | 流式期间粗估（`len(text)//4`） |
| `_pending_permission_request_id` | `None` | **单槽位**权限请求 |
| `_pending_permission_tool_input` / `_pending_permission_tool_name` | `{}` / `""` | 用于 always-allow 规则推导 |
| `_pending_user_input_request_id` | `None` | 单槽位提问请求 |
| `_pending_user_input_questions` | `[]` | `list[dict]`，来自 ask_user 工具 |
| `_pending_user_input_current_q` | `0` | 当前第几问 |
| `_pending_user_input_answers` | `{}` | `dict[int, str | list[str]]` |
| `_pending_prompt` | `None` | 流式中再次提交时暂存的 prompt（打断重提） |
| `_streaming_assistant_text` | `""` | 本轮已累积的流式文本 |
| `_last_stream_render_at` | `0.0` | 节流时间戳 |
| `_stream_render_interval` | `0.05` | 50ms 节流窗口 |
| `_prompt_history` | `()` | 上箭头历史（含 `/` 命令） |
| `_prompt_history_index` / `_prompt_history_draft` | `None` / `""` | 历史游标 + 草稿 |
| `_active_mention_span` | `None` | 当前生效的 `@` 区间 |
| `_mode` | `0` | **0=normal, 1=auto_edit, 2=yolo, 3=plan（不持久化）** |
| `_mcp_manager` | `None` | MCP 管理器 |
| `_skill_registry` / `_subagent_registry` | `None` | 定义注册表 |
| `_pending_mcp_action_server` | `None` | MCP 详情页当前 server 名 |
| `_todos` | `[]` | todo 面板数据 |
| `_message_widgets` | `{}` | `dict[message_id, ChatMessage]` 增量渲染缓存 |
| `_streaming_widget` | `None` | 流式占位 widget |
| `_transient_counter` | `0` | 临时 widget id 计数器（生成 `__panel_N__` 等） |

### 1.4 `compose()`（`app.py:317-336`）

**注意：`compose()` 有副作用，不只是声明 UI。** 顺序固定：

```python
def compose(self) -> ComposeResult:
    self.paths = initialize_storage(self.paths)   # 1) 建 ~/.flyinchat/config.json + <ws>/.flyinchat/chat.json
    self._load_language()                          # 2) 读 app_setting "language"
    self._init_observability()                     # 3) 建 Langfuse/Noop 客户端
    self._init_tools()                             # 4) 权限上下文 + 注册表 + 全部内置工具
    t = self.i18n.t
    yield Header()
    with Container(id="chat-area"):
        with Vertical(id="empty-state"):
            yield Static(_EMPTY_LOGO, id="empty-logo")
            yield Static(t(TKey.EMPTY_HINT), id="empty-hint")
        yield Vertical(id="message-view")
    with Vertical(id="composer"):
        yield Static("", id="todo-panel")
        yield Static("", id="command-menu")
        yield Static(t(TKey.LABEL_MESSAGE), id="input-label")
        yield Input(placeholder=t(TKey.PLACEHOLDER_INPUT), id="prompt-input")
        yield Static("", id="status-bar")
    yield Footer()
```

复刻要点：
- 语言必须在**构造 widget 之前**加载，否则首屏文案是英文。
- `#command-menu` 与 `#todo-panel` 初始为空字符串且 CSS `display: none`。
- `#message-view` 是 `Vertical`，所有 `ChatMessage` 都 mount 到这里，顺序 = 历史顺序。

### 1.5 生命周期钩子

| 钩子 | 位置 | 行为 |
|---|---|---|
| `on_mount` | `app.py:358-361` | `#prompt-input` 聚焦 → `_render_status_bar()` → `_init_mcp_servers()`（`@work(exclusive=True)` 后台 worker） |
| `on_unmount` | — | **不存在**。清理放在 `action_quit` |
| `action_quit` | `app.py:363-369` | set `_mcp_shutdown_event` → `await mcp_manager.shutdown()` → `observability_client.shutdown()` → `super().action_quit()` |
| `run()` | `app.py:2433-2435` | `configure_logging()` 然后 `FlyinChatApp().run()` |

`on_mount` 不做 `_render_history()`：首屏靠 `#empty-state` 显示 logo。

### 1.6 键盘绑定

```python
BINDINGS = [("q", "quit", "Quit")]     # app.py:315
```

只有一个 App 级绑定。因为 `Input` 聚焦时会消费可打印字符，实际打字 `q` 进输入框，不会退出；Footer 只是显示该提示。真正的退出路径是 Ctrl+C / Ctrl+Q（Textual 内建）或命令面板。

---

## 2. 界面组成

### 2.1 布局树

```
Screen                      (CSS: background #0a0e17, layout vertical)
├── Header                  (@0f1724)
├── Container#chat-area     (height:1fr, padding 1 2, overflow-y auto)
│   ├── Vertical#empty-state (width:100%, align center middle)
│   │   ├── Static#empty-logo   (@7dd3fc, bold, 居中)
│   │   └── Static#empty-hint   (@8b9bb4, 居中, margin-top 1)
│   └── Vertical#message-view   (width 100%, height auto, overflow-y hidden)
│                                └── ChatMessage*   (margin-bottom 1)
├── Vertical#composer       (height auto, padding 1 2, border-top solid #1f2a3d)
│   ├── Static#todo-panel   (display:none 默认; max-height:10; border round #2d4a3e)
│   ├── Static#command-menu (display:none 默认; margin-bottom 1; border round #334155)
│   ├── Static#input-label  (@8b9bb4, margin-bottom 1)
│   ├── Input#prompt-input  (border round #334155; focus 时 #7dd3fc)
│   └── Static#status-bar   (height 1, padding 0 2, margin-top 1, @6b7d99)
└── Footer                  (@0f1724)
```

完整 CSS 见 `app.py:209-313`。所有颜色为硬编码十六进制。

### 2.2 组件逐个说明

#### `Header` / `Footer`
Textual 内建。Header 显示 `TITLE = "FlyinChat"`；Footer 显示 `q Quit`。

#### `#empty-state`（`Vertical`）
只有 logo + 提示语。`display` 开关控制：
- 初始 `True`
- `turn_start` 事件 → `False`（`app.py:493`）
- `_render_history()` → `False`（`app.py:2366`）
- `_show_panel()` → `False`（`app.py:2421`）
- `/clear`（`_start_new_session`）→ 重新 `True`（`app.py:1658`）

#### `#message-view`（`Vertical`）
所有 `ChatMessage` 挂载点。两种 id 命名：

- **持久 widget**：`f"msg-{msg.id}"`，由 `_sync_message_widgets` 增量维护，按历史增删。
- **临时 widget**：id 以 `__` 开头，含 `__panel_N__`、`__hint_N__`、`__streaming_N__`、`__error_N__`、`__empty_N__`。任何 `_sync_message_widgets` 都会先删掉它们（`app.py:2337-2340`：`cid.startswith("__") or cid == ""`）。

#### `ChatMessage`（`chat_message.py:12-21`）

```python
class ChatMessage(Markdown):
    def __init__(self, display_text: str, *, widget_id: str = ""):
        super().__init__(display_text, id=widget_id or None)
```

就是 `textual.widgets.Markdown` 的薄包装。文档注释说明设计动机：**Markdown 在构造时解析一次并内部缓存**，所以增量 mount/update 比整表重建快得多——这是长会话不卡的关键。文件头的注释提到 `msg-user`/`msg-assistant` 等 class，但**代码并未实现**（没有传 classes），复刻时可忽略。

#### `#todo-panel`（`Static`）
由 `_render_todo_panel()`（`app.py:2210-2238`）驱动。内容格式：

```
[bold green]{t(TKey.TODO_TITLE)}[/]  {summary}
{marker} {content}
...
```

- `markers = {"completed": "[green]✓[/]", "in_progress": "[yellow]▸[/]", "pending": "[#555566]○[/]"}`，未知状态 fallback `"○"`。
- `summary` 由三段用 `" · "` 拼接：`f"{done} done"`、`f"{active} active"`、`f"{pending} pending"`（为 0 则省略）。
- 空列表 → `panel.display = False`。

数据来源（两条路径）：
1. `turn_start` → `_todos = []` + 重渲染（清空）。
2. `tool_result` 事件且 `name == "todo_write"` → `_refresh_todos_from_context()` 读 `self._tool_context.turn_state["todos"]`（`app.py:2201-2208`；写入方见 `tools/plan_tools.py:66`）。注意：若 `todos` 为空则**直接 return，不清空面板**——即 todo 列表一旦有内容，不会因为工具回传空列表而消失（只在新 turn 开始时清空）。

#### `#command-menu`（`Static`）
**一个 widget 承担 4 种角色**，靠 `selection_context` 区分：

1. **主命令菜单**（`context="main"`）：`/` 开头的模糊过滤列表。
2. **文件提及菜单**（`context="file_mention"`）：`@` 补全列表。
3. **权限动作菜单**（`context="permission_request"`）：approve / always_approve / deny。
4. **MCP 菜单**（`context="mcp_select"` / `"mcp_action"`）。
5. **ask_user 问卷**（无 context，直接 `update()` 覆盖文本，不走 `_render_selection`）。

渲染函数 `_render_selection(target_menu=False)`（`app.py:2088-2107`）：

```python
rows = []
if self.selection_header: rows.append(self.selection_header)
if self.selection_items:
    rows.append(self.selection_title)
    for index, item in enumerate(self.selection_items):
        pointer = ">" if index == self.selected_index else " "
        rows.append(f"{pointer} {index + 1}. {item.title}\n    {item.description}")
if self.selection_footer: rows.append(self.selection_footer)
content = "\n".join(rows)
if target_menu or self.selection_context in ("main", "file_mention", "permission_request", "mcp_action"):
    command_menu.update(content); command_menu.display = True; return
self._show_panel(self.selection_title, content)
```

**关键分流规则**：`main` / `file_mention` / `permission_request` / `mcp_action` 以及显式 `target_menu=True` → 渲染进 `#command-menu`；其余 context（`api_actions`、`model_select`、`thinking_toggle`、`reasoning_select`、`effort_select`、`session_select`）→ 走 `_show_panel()`，即**全屏替换消息区为一个 Markdown 面板**。

#### `#input-label` + `#prompt-input`
`_set_input_prompt(label, placeholder)`（`app.py:2127-2129`）同时改两者。默认值 `(t(TKey.LABEL_MESSAGE), t(TKey.PLACEHOLDER_INPUT))`。权限/表单流程会把它改成别的文案，流程结束后用 `_reset_selection()` 或显式 `_set_input_prompt` 还原。

#### `#status-bar`（`Static`）
`_render_status_bar()`（`app.py:2240-2307`），**优先级从高到低**：

```python
def _update(text): self.query_one("#status-bar", Static).update(f"{mode_label}  {text}")
# mode_label 永远是前缀，形如 "[#7dd3fc]NORMAL[/#7dd3fc]"

1. if self._compacting:  → t(TKey.STATUS_COMPACTING)   # "Compacting conversation history..."
2. if self._is_streaming:→ f"{t(STATUS_WORKING)}... {spinner} {tok} tok"  # tok 为 0 时省略 " {tok} tok"
3. primary = get_primary_llm_model(config_path)
   if primary is None:  → t(TKey.STATUS_NO_MODEL)
4. 正常态，parts 用 "  |  " join:
   - f"{channel.name} / {model.name}"
   - t(STATUS_THINK, status=("ON" if model.thinking_enabled else "OFF"))   # "Think: ON"
   - f"Effort: {model.reasoning_effort}"
   - f"Ctx: {ctx_label}"   # context_window>=1_000_000 → "1M"，否则 f"{cw//1000}K"
   - f"Out: {out_label}"   # max_output_tokens<1_000_000 → f"{mot//1000}K"，否则 "1M"
   - 若有会话：t(STATUS_MSGS, count=len(msgs))            # "12 msgs"
     且 (inp or total_out) 非零时追加：
       有 ctx 且 inp: f"↑{inp} ↓{total_out} ({pct:.1f}%)"   # pct = inp/ctx*100
       否则:        f"↑{inp} ↓{total_out}"
   - 无会话：t(STATUS_NO_CONV)                            # "No conversation"
   - MCP（仅当 _mcp_manager 非 None 且 status 非空）：
       有 error: f"MCP: {connected}/{total} [red]{errors} err[/]"
       无 error: f"MCP: {connected}/{total}"
   - t(STATUS_LANGFUSE_ON) 或 t(STATUS_LANGFUSE_OFF)
```

**这一段每帧都调用 `list_messages()` 读盘**（`app.py:2279`），是已知性能点。

#### 模式标签 `_mode_label()`（`app.py:2141-2158`）

```python
mode_keys = {0: ("normal", "#7dd3fc"), 1: ("auto_edit", "#fbbf24"), 2: ("yolo", "bold #dc2626"), 3: ("plan", "#60a5fa")}
i18n_keys = {0: STATUS_MODE_NORMAL, 1: STATUS_MODE_AUTO_EDIT, 2: STATUS_MODE_YOLO, 3: STATUS_MODE_PLAN}
return f"[{color}]{label}[/{color}]"       # label = i18n 值：NORMAL / AUTO EDIT / YOLO / PLAN / 常规 / 自动 / YOLO / 计划
```

（`mode_keys` 的第一个元素 `"normal"` 实际未被使用，只取 color。）

#### 消息格式化 `_format_msg_display(msg)`（`app.py:2317-2326`）

```python
if msg.role == "tool":     return f"**{t(LABEL_TOOL)}**\n\n{message_to_display(msg)}"
elif msg.role == "system": return f"**{t(LABEL_SYSTEM)}**\n\n{message_to_display(msg)}"
else:  role_label = f"**{t(LABEL_YOU)}**" if msg.role=="user" else f"**{t(LABEL_ASSISTANT)}**"
       return f"{role_label}\n\n{message_to_display(msg)}"
```

`message_to_display` 来自 `message_utils.py`，负责把 JSON content 还原成人类可读文本（tool_result 截断到 8000 字符 / 15 行，参见 `message_utils._MAX_RESULT_CHARS/_MAX_RESULT_LINES`）。

#### 面板 `_show_panel(title, body)`（`app.py:2420-2426`）

```python
self.query_one("#empty-state", Vertical).display = False
self._clear_message_view()                          # 清空整个消息区（包括持久消息 widget！）
self._transient_counter += 1
panel = ChatMessage(f"## {title}\n\n{body}", widget_id=f"__panel_{self._transient_counter}__")
self.query_one("#message-view", Vertical).mount(panel)
self._scroll_chat_to_bottom()
```

`_clear_message_view()` 会清 `_message_widgets` 并移除全部 child——所以面板是"覆盖式"显示，返回会话视图需要显式调用 `_render_history()`（多数命令 handler 会调）。

---

## 3. 键盘绑定完整表

所有按键逻辑集中在**单个 `on_key` 事件处理器**（`app.py:591-667`）里，按以下**严格顺序**判断。这个顺序是行为正确性的核心。

### 3.1 `on_key` 判定顺序（app.py:591-667）

| 序 | 条件 | 键 | 行为 | 代码位置 |
|---|---|---|---|---|
| 1 | 无条件 | `shift+tab` | `prevent_default()`；`self._mode = (self._mode + 1) % 4`；`_apply_mode_permissions()`；`_render_status_bar()`；**return** | 592-597 |
| 2 | 无条件 | `escape` 且 `_is_streaming` | `_request_cancel()`；**return** | 599-602 |
| 3 | 无条件 | `escape` 且距上次 <0.5s | 重置 `_last_escape_time=0.0`；若有 pending permission → `_resolve_pending_permission("deny")`；`_clear_input()`；`_reset_selection()`；**return** | 603-610 |
| 4 | 无条件 | `escape`（首次） | 只记录 `_last_escape_time = now`；**return** | 611-612 |
| 5 | `_pending_permission_request_id` 非空 | `y` | `_resolve_pending_permission("approve")` | 615-618 |
| 6 | 同上 | `a` | `_resolve_pending_permission("always_approve")` | 619-622 |
| 7 | 同上 | `n` 或 `escape` | `_resolve_pending_permission("deny")` | 623-626 |
| 8 | `_pending_user_input_request_id` 非空 | 任意 | `_handle_user_input_key(event)`；**return** | 628-630 |
| 9 | `selection_items` 为空 | `up` | `_navigate_prompt_history(-1)`；**return** | 632-636 |
| 10 | 同上 | `down` | `_navigate_prompt_history(1)`；**return** | 637-640 |
| 11 | 同上 | 其他 | **return（不再往下走）** | 641 |
| 12 | 有 `selection_items` | `up` | `selected_index = (idx-1) % len`；`_render_selection()`；**return** | 643-647 |
| 13 | 有 `selection_items` | `down` | `selected_index = (idx+1) % len`；`_render_selection()`；**return** | 649-653 |
| 14 | 有 `selection_items` | `tab` | 见下 | 655-667 |

`tab` 分支（`app.py:655-667`）：

```python
if self.selection_context == "file_mention":
    self._insert_selected_file_mention()   # 与 Enter 行为相同
    return
prompt_input = self.query_one("#prompt-input", Input)
self._suppress_menu_update = True
prompt_input.value = self.selection_items[self.selected_index].key     # 把命令名写进输入框
prompt_input.action_end()                                             # 光标移到末尾
self.selected_index = (self.selected_index + 1) % len(self.selection_items)   # 注意：选中项也跟着前进
self._render_selection()
```

**注意 `tab` 的副作用**：补全命令名的同时把 `selected_index` 递增——这是"反复按 Tab 循环候选"的实现方式。

### 3.2 关键结论与陷阱

1. **单次 `escape` 永远不会拒绝权限**。第 3/4 步的 `escape` 分支总是提前 `return`，所以第 7 步里 `event.key == "escape"` 是**不可达分支**。拒绝权限要么双击 Esc（<0.5s），要么按 `n`。
2. **流式中 `escape` 是"取消当前轮"**，不是清输入框。取消后若有 `_pending_prompt`，会立即重提交（见 §9.4）。
3. **`up`/`down` 的双重语义**：菜单打开时选择菜单，菜单关闭时翻输入历史。二者互斥（靠 `selection_items` 是否为空判断）。
4. **`shift+tab` 是全局最高优先级**，即使权限对话框打开也会切模式。
5. 模式序号循环 `(mode + 1) % 4`，顺序固定：normal → auto_edit → yolo → plan → normal。

### 3.3 输入框内的特殊按键

`Input` widget 自身消费的键（Enter、左右、Backspace、可打印字符等）不经 `on_key` 的第 5 步之后逻辑；其中 Enter 触发 `on_input_submitted`，字符变化触发 `on_input_changed`。`up`/`down` 在 `Input` 里不做光标上下移动（单行），因此会冒泡到 `App.on_key`。

### 3.4 `on_input_changed`（`app.py:669-692`）判定顺序

```python
if self._suppress_menu_update:            # 1. 程序化修改 → 吃掉这次事件
    self._suppress_menu_update = False
    return
if self.form_state is not None:  return  # 2. 表单进行中，不弹菜单
if self._pending_permission_request_id: return  # 3. 权限中，不弹菜单
value = event.value.strip()
if value.startswith("/"):                 # 4. 命令菜单
    self._active_mention_span = None
    self._show_command_menu(value)
    return
cursor_position = getattr(event.input, "cursor_position", len(event.value))
if self._show_file_mention_menu(event.value, cursor_position):  # 5. @ 提及菜单（用未 strip 的原值）
    return
self.query_one("#command-menu", Static).display = False          # 6. 都不匹配 → 关菜单
if self.selection_context in ("main", "file_mention"):
    self._clear_selection()
```

要点：`/` 判定用 **strip 后**的值（前导空格也算命令）；`@` 判定用**原值** + 光标位置。`cursor_position` 用 `getattr` 兜底（防 Textual 版本差异）。

### 3.5 `on_input_submitted`（`app.py:694-760`）判定顺序

**这是整个 TUI 最复杂的控制流，必须逐字复刻。**

```python
prompt = event.value.strip()
if self.paths is None: return                                   # 1
if self.form_state is not None:                                 # 2 多步表单
    self._submit_form_value(prompt, event.input); return
if self.selection_context == "file_mention" and self.selection_items:   # 3 @ 补全确认
    self._activate_selection(); return
if prompt.startswith("/api add ") or prompt.startswith("/model use "):  # 4 直接命令行形式
    self._run_command(prompt); event.input.value = ""; command_menu.display = False; return
if self._pending_permission_request_id:                          # 5 权限中按 Enter = 激活当前选中项
    event.input.value = ""; self._activate_selection(); return
if self.selection_items and (not prompt or prompt.startswith("/")):     # 6 菜单选择
    self._activate_selection(); event.input.value = ""; command_menu.display = False; return
if not prompt: return                                            # 7
if self._is_streaming:                                           # 8 流式中提交 = 打断重提
    self._pending_prompt = prompt; self._request_cancel(); event.input.value = ""; return
if prompt.startswith("/"):                                       # 9 斜杠命令
    self._run_command(prompt); event.input.value = ""; command_menu.display = False; return
if self.active_conversation_id is None:                          # 10 惰性建会话
    conversation = create_conversation(self.paths.chat_path, title=prompt[:80])
    self.active_conversation_id = conversation.id
    self._last_usage = {}; self._total_output_tokens = 0; self._last_input_tokens = 0
    self._query_engine = None
    self._render_status_bar()
self._clear_selection()                                          # 11
add_message(...); self._record_prompt_history(prompt); self._render_history()
event.input.value = ""
self._start_spinner()
self._submit_via_engine(prompt)
```

**第 4 步的意义**：`/api add ...` 与 `/model use ...` 带参数，不走菜单，直接执行。注意判定发生在第 5/6 步**之前**，因此即使在权限对话框打开时输入 `/api add ...` 也会执行命令。

**第 10 步的会话标题 = 首条消息前 80 字符**（测试 `test_submitting_prompt_creates_project_conversation` 断言 `title == "Explain this project"`）。

### 3.6 输入历史（`app.py:762-803`）

- `_record_prompt_history(prompt)`：追加到 `_prompt_history`，重置游标与草稿。**命令也记录**（`/not-a-command` 会进历史，测试 `test_prompt_history_restores_draft_and_skips_commands` 验证了这点；"skips commands" 是测试名误导，实际不跳过）。
- `_load_prompt_history()`：从存储读**所有** `role == "user" and subtype == "normal"` 的消息内容（换会话时调用）。注意 `subtype == "normal"` 过滤掉了 `permission_event` 等系统消息。
- `_navigate_prompt_history(direction)`：
  - 无历史 → return。
  - 游标为 None 且 `direction > 0` → return（首次按 down 无效）。
  - 游标为 None 且 `direction < 0` → 保存当前输入为 `_prompt_history_draft`，从 `len-1` 开始。
  - 越界下界钳到 0；越界上界 → 恢复草稿、游标置 None。
  - 每次设置 value 后调用 `prompt_input.action_end()`（光标到末尾）。

---

## 4. 斜杠命令系统

### 4.1 命令注册表 `_get_commands()`（`app.py:165-182`）

```python
SelectionItem("/api",       t(TKey.CMD_API),       t(TKey.CMD_API_DESC)),
SelectionItem("/model",     t(TKey.CMD_MODEL),     t(TKey.CMD_MODEL_DESC)),
SelectionItem("/thinking",  t(TKey.CMD_THINKING),  t(TKey.CMD_THINKING_DESC)),
SelectionItem("/reasoning", t(TKey.CMD_REASONING), t(TKey.CMD_REASONING_DESC)),
SelectionItem("/effort",    t(TKey.CMD_EFFORT),    t(TKey.CMD_EFFORT_DESC)),
SelectionItem("/1M",        t(TKey.CMD_1M),        t(TKey.CMD_1M_DESC)),
SelectionItem("/sessions",  t(TKey.CMD_SESSIONS),  t(TKey.CMD_SESSIONS_DESC)),
SelectionItem("/clear",     t(TKey.CMD_CLEAR),     t(TKey.CMD_CLEAR_DESC)),
SelectionItem("/compact",   t(TKey.CMD_COMPACT),   t(TKey.CMD_COMPACT_DESC)),
SelectionItem("/language",  t(TKey.CMD_LANGUAGE),  t(TKey.CMD_LANGUAGE_DESC)),
SelectionItem("/mcp",       t(TKey.CMD_MCP),       t(TKey.CMD_MCP_DESC)),
SelectionItem("/skills",    t(TKey.CMD_SKILLS),    t(TKey.CMD_SKILLS_DESC)),
SelectionItem("/langfuse",  t(TKey.CMD_LANGFUSE),  t(TKey.CMD_LANGFUSE_DESC)),
SelectionItem("/init",      t(TKey.CMD_INIT),      t(TKey.CMD_INIT_DESC)),
```

**14 条命令，顺序即菜单顺序。** `key` 与 `title` 都等于命令字面量（因为 `CMD_*` 的英/中翻译值就是命令名本身），`description` 才是可翻译描述。

另有三个子选项表：

```python
_get_reasoning_levels()  # app.py:184-190 → low/medium/high，title==key，desc 用 REASONING_*
_get_effort_levels()     # app.py:192-199 → low/medium/high/xhigh，desc 用 EFFORT_*
_get_api_actions()       # app.py:201-207 → deepseek/openai/anthropic（key 是 preset 名），用 API_*_TITLE / API_*_DESC
```

### 4.2 命令菜单的弹出与过滤

`_show_command_menu(query)`（`app.py:1107-1122`）：

```python
matches = tuple(c for c in self._get_commands() if c.key.startswith(query))   # 大小写敏感的 startswith
if not matches:
    self._clear_selection()
    command_menu.update(t(TKey.CMENU_NO_MATCHES))
    command_menu.display = True
    return
self._set_selection(context="main", title=t(TKey.CMENU_COMMANDS), items=matches,
                    footer=t(TKey.CMENU_FOOTER), target_menu=True)
```

- **过滤算法：前缀匹配，大小写敏感**。`/1` 只匹配 `/1M`；`/M` 不匹配 `/mcp`。
- 无匹配时**不清空 `selection_items` 之外的东西**——`_clear_selection()` 会把 `selection_items` 置空，因此无匹配时 up/down 走输入历史。
- 菜单文本渲染格式（来自 `_render_selection`）：

```
Commands
> 1. /api
    LLM API provider settings
  2. /model
    Choose the primary model
...
Use ↑/↓ to select, Tab to autocomplete, Enter to open.
```

### 4.3 选择激活 `_activate_selection()`（`app.py:1164-1207`）

按 `selection_context` 分派（**完整 match 表**）：

| context | 行为 |
|---|---|
| `"main"` | `self._run_command(item.key)` |
| `"api_actions"` | `self._start_api_form(item.key)` |
| `"model_select"` | `self._set_primary_model_by_id(item.key)` |
| `"thinking_toggle"` | `self._toggle_thinking(item.key)`（key 为 `"on"`/`"off"`） |
| `"reasoning_select"` | `self._set_reasoning_effort(item.key)` |
| `"effort_select"` | `self._set_effort(item.key)` |
| `"file_mention"` | `self._insert_selected_file_mention()` |
| `"session_select"` | 见下 |
| `"permission_request"` | `self._resolve_pending_permission(item.key)`（key 为 `approve`/`always_approve`/`deny`） |
| `"mcp_select"` | `self._show_mcp_detail(item.key)` |
| `"mcp_action"` | `reconnect` → `_mcp_reconnect(_pending_mcp_action_server)`；`back` → `_show_mcp_servers()` |

`session_select` 分支（`app.py:1184-1198`）：

```python
self.active_conversation_id = item.key
conv = get_conversation(self.paths.chat_path, conversation_id=item.key)
self._total_output_tokens = conv.total_output_tokens if conv else 0
self._last_input_tokens   = conv.last_input_tokens   if conv else 0
self._last_usage = {}
self._query_engine = None                    # 强制重建，绑定新会话
self._load_prompt_history()
self._clear_selection()
self._render_history()
self._render_status_bar()
```

### 4.4 命令分派 `_run_command(command)`（`app.py:805-848`）

```python
if command == "/api":            → _show_api_settings()
if command.startswith("/api add "):  → _add_api_channel(command)
if command == "/model":          → _show_model_settings()
if command.startswith("/model use "):→ _select_primary_model(command)
match command:
    "/thinking" → _show_thinking_settings()
    "/reasoning"→ _show_reasoning_settings()
    "/effort"   → _show_effort_settings()
    "/1M"       → _toggle_context_mode()
    "/sessions" → _show_sessions()
    "/clear"    → _start_new_session()
    "/compact"  → _run_compact()          # @work async
    "/language" → _toggle_language()
    "/init"     → _run_init()
    "/mcp"      → _show_mcp_servers()
    "/skills"   → _show_skills()
    "/langfuse" → _toggle_langfuse()
    _           → _show_panel(t(PANEL_UNKNOWN_CMD), t(PANEL_UNKNOWN_CMD_BODY, command=command))
```

### 4.5 逐条命令 handler 行为

#### `/api`（`_show_api_settings`, `app.py:1562-1575`）
1. 若无 `paths` 直接 return。
2. `channels = list_llm_channels(config_path)`。
3. header = `t(SEL_API_HEADER, channels=_format_channels(channels), presets="\n".join(_format_presets()))`，模板：
   ```
   Configured channels
   {channels}

   Presets
   {presets}
   ```
4. `_set_selection(context="api_actions", title=t(SEL_API_TITLE), items=_get_api_actions(), header=header, footer=t(SEL_API_FOOTER))` → 因 context 不在菜单白名单且 `target_menu=False`，**渲染为面板**。

`_format_channels`（`app.py:2033-2049`）每行：
```
{index}. {channel.name} · {channel.provider_type} · {base_url or "default endpoint"} · key {masked}
   models: {", ".join(names) or "No models"}
```
无 channels → `t(MISC_NO_PROVIDERS_ADD)`（"No providers configured yet. Select a preset below to add one."）。

`_format_presets`（`app.py:2061-2068`）遍历 `PROVIDER_PRESETS`：
```
{id}: {name} · {provider_type} · {base_url}
   models: {", ".join(model_names)}
```
当前只有 `deepseek` 一条 preset（`storage.py:31-40`）：
`deepseek: DeepSeek · anthropic · https://api.deepseek.com/anthropic`，models `deepseek-v4-pro, deepseek-v4-flash`，context_window `1_000_000`，max_output_tokens `128_000`。

`_mask_api_key(api_key)`（`app.py:2428-2431`）：`len<=6` → `t(MISC_CONFIGURED)`（"configured"）；否则 `f"{key[:3]}...{key[-2:]}"`（测试断言 `"dee...et"`）。

#### `/api add ...`（`_add_api_channel`, `app.py:1513-1560`）
`shlex.split(command)` 后按 `parts[2]` 分三种形态：

| 形态 | 参数个数 | 调用 |
|---|---|---|
| `deepseek` | 必须 `len==4`：`/api add deepseek <api-key>` | `create_preset_channel(config_path, preset_id="deepseek", api_key=parts[3])` |
| `openai` | 必须 `len==7`：`/api add openai <name> <base-url> <api-key> <m1,m2>` | `create_channel_with_models(..., provider_type="openai_compatible", base_url=parts[4], api_key=parts[5], model_names=parts[6].split(","))` |
| `anthropic` | 必须 `len==6`：`/api add anthropic <name> <api-key> <m1,m2>` | `create_channel_with_models(..., provider_type="anthropic", api_key=parts[4], model_names=parts[5].split(","))` |

参数个数不符/类型未知 → `ValueError` → `_clear_selection()` + `_show_panel(t(PANEL_API_SETUP_ERR), str(error))`（错误文案是硬编码英文，未 i18n）。
成功 → `_clear_selection()` + `_show_channel_added(channel, models)`（`app.py:1850-1855`），面板标题 `PANEL_API_CHANNEL_ADDED`，正文：
```
{channel.name}
{channel.provider_type}
{channel.base_url or "default endpoint"}
models: {", ".join(model.name)}
```

#### `/model`（`_show_model_settings`, `app.py:1577-1604`）
1. 无 channels → 面板 `(PANEL_PRIMARY_MODEL, PANEL_NO_PROVIDERS)`。
2. `primary = get_primary_llm_model(config_path)`。
3. 遍历 channels（1-based）与每个 channel 的 models（1-based），构造：
   - `rows.append(f"{ci}. {channel.name} · {channel.provider_type}")`
   - `rows.append(_format_model_row(ci, mi, model, primary))` → `t(MISC_MODEL_ROW, ci, mi, name, marker)`，模板 `"   {ci}.{mi} {name}{marker}"`，`marker = t(MISC_PRIMARY_MARKER)` = `" [primary]"`（仅当 `primary[1].id == model.id`）。
   - `items.append(SelectionItem(model.id, f"{channel.name} / {model.name}", t(CMD_MODEL_DESC)))`
4. header = `t(SEL_MODEL_HEADER)` + `"\n".join(rows)`；`_set_selection(context="model_select", ...)` → 面板。

#### `/model use <ch> <mo>`（`_select_primary_model`, `app.py:1606-1627`）
`shlex.split` 后必须 `len==4`；`channel_index = int(parts[2]) - 1`，`model_index = int(parts[3]) - 1`；越界/非数字 → `(IndexError, ValueError)` → 面板 `(PANEL_MODEL_SELECT_ERR, PANEL_MODEL_SELECT_USAGE)`；成功 → `set_primary_llm_model(config_path, model_id=model.id)` → `_show_primary_model_selected(...)`。

`_show_primary_model_selected`（`app.py:1857-1866`）：清 `_last_usage`；`hint = t(HINT_PRIMARY_MODEL, channel, model)`；`_render_history_with_hint(hint, fallback_title=PANEL_PRIMARY_MODEL, fallback_body=...)`；`_render_status_bar()`。**注意：换主模型不会置 `_query_engine = None`**——引擎在每轮 `submit_message` 里重新读 primary model，所以不需要重建。

#### `/thinking`（`_show_thinking_settings`, `app.py:1868-1891`）
无 primary → 面板 `(PANEL_THINKING_MODE, PANEL_THINKING_NO_MODEL)`。否则：
```python
status = "enabled" if model.thinking_enabled else "disabled"
options = (SelectionItem("on", t(SEL_THINKING_ON), t(SEL_THINKING_ON_DESC)),
           SelectionItem("off", t(SEL_THINKING_OFF), t(SEL_THINKING_OFF_DESC)))
header = f"{channel.name} / {model.name}\nThinking is currently {status}"
_set_selection(context="thinking_toggle", title=t(SEL_THINKING_TITLE), items=options, header=header, footer=t(SEL_THINKING_FOOTER))
```
→ 面板（context 不在菜单白名单）。

`_toggle_thinking(action)`（`app.py:1893-1913`）：`enabled = (action == "on")` → `set_model_thinking(config_path, model_id, enabled)` → `hint = t(HINT_THINKING_ON/OFF, channel, model)` → `_render_history_with_hint(hint, fallback_title=PANEL_THINKING_MODE, fallback_body=hint.lstrip("> "))` → `_render_status_bar()`。

#### `/reasoning`（`_show_reasoning_settings`, `app.py:1915-1933`）
header = `f"{channel.name} / {model.name}\nCurrent level: {model.reasoning_effort}"`；items = `_get_reasoning_levels()`；context `"reasoning_select"` → 面板。

`_set_reasoning_effort(level)`（`app.py:1935-1954`）：`set_model_reasoning_effort(config_path, model_id, effort=level)` → `hint = t(HINT_REASONING_SET, effort, channel, model)` → `_render_history_with_hint(...)` → `_render_status_bar()`。

#### `/effort`（`_show_effort_settings`, `app.py:1956-1979`）
```python
current = f"think: on, effort: {model.reasoning_effort}" if model.thinking_enabled else "think: off (low)"
header = f"{channel.name} / {model.name}\nCurrent: {current}"
```
items = `_get_effort_levels()`（low/medium/high/xhigh）；context `"effort_select"` → 面板。

`_set_effort(level)`（`app.py:1981-2007`）——**`/effort` 是 `/thinking` + `/reasoning` 的复合**：
```python
if level == "low":
    updated = set_model_thinking(config_path, model_id, enabled=False)     # 只关思考，effort 不变
else:
    updated = set_model_thinking(config_path, model_id, enabled=True)
    updated = set_model_reasoning_effort(config_path, model_id, effort=level)
hint = t(HINT_EFFORT_ON, effort, channel, model) if updated.thinking_enabled else t(HINT_EFFORT_OFF, channel, model)
```

#### `/1M`（`_toggle_context_mode`, `app.py:2009-2031`）
```python
new_size = 125_000 if model.context_window >= 1_000_000 else 1_000_000     # 双向切换
updated = set_model_context_window(config_path, model_id=model.id, context_window=new_size)
label = "1M" if new_size == 1_000_000 else "125K"
hint = t(HINT_CTX_SET, label=label, channel=channel.name, model=updated.name)
```
无 primary → 面板 `(PANEL_CTX_WINDOW, PANEL_CTX_NO_MODEL)`。

#### `/sessions`（`_show_sessions`, `app.py:1629-1648`）
无会话 → 面板 `(PANEL_SESSION_HISTORY, PANEL_NO_SESSIONS)`。否则：
```python
items = tuple(SelectionItem(conv.id, conv.title, conv.updated_at) for conv in list_conversations(chat_path))
_set_selection(context="session_select", title=t(SEL_SESSION_TITLE), items=items, footer=t(SEL_SESSION_FOOTER))
```
→ 面板。选定后走 §4.3 的 `session_select` 分支。

#### `/clear`（`_start_new_session`, `app.py:1650-1660`）
```python
self.active_conversation_id = None
self._last_usage = {}; self._total_output_tokens = 0; self._last_input_tokens = 0
self._query_engine = None
self._load_prompt_history()                 # 此时 active_conversation_id 为 None → 历史置空
self._clear_selection()
self.query_one("#empty-state", Vertical).display = True
self._show_panel(t(PANEL_NEW_SESSION), t(PANEL_NEW_SESSION_BODY))
self._render_status_bar()
```
**注意 `_show_panel` 会把 `empty-state` 重新 `display = False`**（`app.py:2421`），所以第 7 行的 `display = True` 会被立刻覆盖 —— 结果仍显示 "New session" 面板。复刻时保持这个顺序（行为等价于只需 `_show_panel`）。

#### `/compact`（`_run_compact`, `app.py:1662-1748`，`@work` async）
1. 无 `paths` 或 `active_conversation_id` → 面板 `(PANEL_COMPACT, PANEL_NO_CONVERSATION)`。
2. 无 primary model → 面板 `(PANEL_COMPACT, PANEL_NO_MODEL)`。
3. 读 `all_messages = list_messages(...)`、`active_messages = list_active_messages(...)`；`already_compacted = len(active) < len(all)`。
4. `policy = CompactionPolicy.from_model(model)`；`estimated = TokenEstimator().estimate_messages(active_messages)`。
5. **已压缩且 `estimated <= policy.soft_limit`** → 面板 `(PANEL_COMPACT, t(PANEL_COMPACT_OK, tokens=estimated//1000, limit=policy.soft_limit//1000))` 并 return。
6. `api_messages = [message_to_api_format(m) for m in active_messages if ... is not None]`。
7. 起一个独立 `AgentTrace`（`turn_id=f"compact_{conversation_id[:8]}"`，`user_input="/compact"`，agent_mode/permission_mode 都用 `mode_int_to_str(self._mode)`）。
8. `self._compacting = True; _render_status_bar()`。
9. `CompactionEngine(chat_path, conversation_id, _i18n=self.i18n, _observability=trace)`，`await engine.compact_if_needed_async(active_messages, api_messages, policy, force=True, model=model, channel=channel)`。
10. `self._compacting = False`；若 `result.applied` → `trace.mark_compaction(tokens_before, tokens_after)`；`trace.finish(TurnResult(...status="completed"...), task_latency_ms=...)`。
11. 应用成功 → 面板 `(PANEL_COMPACT_DONE, f"Strategy: {result.strategy}\nTokens: {before_k}K → {after_k}K")`，然后 `_render_history()` + `_render_status_bar()`。未应用 → 面板 `(PANEL_COMPACT, PANEL_COMPACT_NOT_NEEDED)` + `_render_status_bar()`。

#### `/language`（`_toggle_language`, `app.py:878-888`）
```python
new_lang = Language.ZH if self.i18n.language == Language.EN else Language.EN
self.i18n.set_language(new_lang)
if self.paths is not None:
    set_app_setting(self.paths.config_path, "language", new_lang.value)   # 持久化 "en"/"zh"
self._clear_selection()
self._show_panel(t(CMD_LANGUAGE), t(HINT_LANGUAGE_SET))
self._render_status_bar()
```
**注意：切换语言不重建已有 widget**——`#input-label`、`#empty-hint`、历史消息里的角色标签都保持旧语言，直到下次被重写。这是已知的行为缺陷，复刻时若要"更好"需自行决定。

#### `/mcp`（`_show_mcp_servers`, `app.py:948-1000`）
1. 读 `load_mcp_config(paths).servers`（无 manager 时也读）。
2. 无 servers → 面板 `(CMD_MCP, PANEL_MCP_NO_SERVERS)`。
3. `status_map = self._mcp_manager.get_status() if manager else {}`（返回 `dict[str,str]`，值为 `"connected"|"error"|"connecting"|"disconnected"`）。
4. `status_label(name)` → `"[{已连接|连接错误|连接中|已断开}]"`（i18n）。
5. `items = tuple(SelectionItem(server.name, f"{server.name} {status_label}", f"command: {server.command} {' '.join(server.args)}"))`。
6. `_set_selection(context="mcp_select", title=t(SEL_MCP_TITLE), items=items, footer=t(SEL_MCP_FOOTER), target_menu=True)`。
7. `_force_command_menu_refresh()`（`app.py:997-1000`）：`#command-menu.display = False`，然后 `call_later(self._render_selection)`。这是为了绕开"菜单已在显示 → display 不变 → 不重绘"的问题。

`_show_mcp_detail(server_name)`（`app.py:1002-1082`）：
- 无 manager → 面板 `(PANEL_MCP_DETAIL, "MCP manager not initialized.")`（硬编码英文）。
- server 不存在 → 面板 `(PANEL_MCP_DETAIL, f"Server '{name}' not found.")`（硬编码英文）。
- 正文行（Markdown）：
  ```
  **Server:** {name}
  **Status:** {status_text(status)}
  **Transport:** {server.transport}
  **Command:** {server.command}
  **Args:** `{...}`          # 仅当 server.args 非空
  **Env:** k=v, ...          # 仅当 server.env 非空
  **Timeout:** {server.timeout_seconds}s
  （空行）
  **Error:** ```{err_msg}``` # 仅当 get_error() 返回非空
  （空行）
  **Tools ({n}):**
    - `{tool_name}` — {description[:60]}     # 工具名以 mcp_{server_name}_ 前缀过滤，排序后输出
  **Tools:** None registered                  # 无工具时
  （空行）
  ---
  *按 **Enter** 查看选项*                     # 硬编码中文，未 i18n
  ```
- 末尾设置 `_pending_mcp_action_server = server_name`，然后：
  ```python
  _set_selection(context="mcp_action", title=t(PANEL_MCP_ACTION_TITLE),
                 items=(SelectionItem("reconnect", t(PANEL_MCP_RECONNECT), f"Reconnect {server_name}"),
                        SelectionItem("back", t(PANEL_MCP_BACK), "Back to MCP list")))
  command_menu.update(""); command_menu.display = False
  self.call_later(self._render_selection)
  ```
  这里 `_set_selection` 内部的 `_render_selection` 会立即写菜单，随后被 `update("")` + `display=False` 抹掉，再靠 `call_later` 重绘 —— 效果是"面板在消息区、动作菜单在 command-menu"。

`_mcp_reconnect(server_name)`（`app.py:1084-1105`，`@work`）：`get_server_config(name)` → 面板 `(PANEL_MCP_DETAIL, t(PANEL_MCP_RECONNECTING, name=...))` → `await manager.reconnect_server(server, registry, tool_context)` → 面板 `(PANEL_MCP_DETAIL, t(PANEL_MCP_RECONNECT_OK, count=...))`；异常 → `f"Reconnect failed for {name}"`（硬编码英文）；`call_later(_render_status_bar)`。

#### `/skills`（`_show_skills`, `app.py:850-876`）
```python
workspace = self.paths.project_dir.parent
if self._skill_registry is None: self._skill_registry = SkillRegistry(workspace)
snapshot = self._skill_registry.refresh()
rows = []
if snapshot.loaded_skills:
    rows.append(f"Loaded: {len(snapshot.loaded_skills)}")
    for skill in snapshot.loaded_skills:
        manifest = skill.manifest
        tags = ", ".join(manifest.tags) if manifest.tags else "-"
        rows.append(f"- **{manifest.ref}** `{manifest.source}`\n"
                    f"  {manifest.description}\n"
                    f"  category: `{manifest.category}` · tags: `{tags}`\n"
                    f"  path: `{skill.path}`")
else:
    rows.append(t(PANEL_SKILLS_EMPTY))
if snapshot.invalid_skills:
    rows.append(f"\nInvalid: {len(snapshot.invalid_skills)}")
    for invalid in snapshot.invalid_skills:
        rows.append(f"- `{invalid.path}`\n  {invalid.reason}")
self._show_panel(t(PANEL_SKILLS), "\n\n".join(rows))
```
测试断言输出含 `"Agent Skills"`、`"safe-edit@1.0.0"`（即 `manifest.ref` = `name@version`）、描述与 tags。

#### `/langfuse`（`_toggle_langfuse`, `app.py:890-908`）
```python
if self.paths is None: → 面板 (CMD_LANGFUSE, PANEL_NO_CONFIG); return
currently_enabled = self._observability_client.enabled
new_value = "false" if currently_enabled else "true"
set_app_setting(self.paths.config_path, "langfuse_enabled", new_value)
new_config = ObservabilityConfig.from_config_store(self.paths.config_path)
self._observability_client = create_observability_client(new_config)
self._query_engine = None          # 强制重建以绑定新 client
self._clear_selection()
self._show_panel(t(CMD_LANGFUSE), t(STATUS_LANGFUSE_ON if new_config.enabled else STATUS_LANGFUSE_OFF))
self._render_status_bar()
```
注意 `new_config.enabled` 可能与 `new_value` 不一致（缺 keys 时 `enabled=False`，`disabled_reason="Langfuse keys are missing"`），面板文案按 `new_config.enabled` 显示。

#### `/init`（`_run_init`, `app.py:910-946`）
1. `paths is None` → return。
2. **无 primary model** → 面板 `(PANEL_INIT_NO_MODEL, "")` 并 return。
3. `_clear_selection()`。
4. 无会话则建一个，标题固定 `"/init"`，并重置 usage 计数、置 `_query_engine = None`、`_render_status_bar()`。
5. 面板 `(PANEL_INIT, PANEL_INIT_BODY)`。
6. `prompt = t(TKey.INIT_PROMPT)`（一段很长的中/英文初始化指令，要求模型先探索项目再写 `FLYINCHAT.md`）。
7. `add_message(role="user", content=prompt)` → `_record_prompt_history(prompt)` → `_render_history()` → `_start_spinner()` → `_submit_via_engine(prompt)`。

即 `/init` **就是一条预置 prompt 的普通提问**，不是独立流程。

#### 未知命令
`_show_panel(t(PANEL_UNKNOWN_CMD), t(PANEL_UNKNOWN_CMD_BODY, command=command))`。

### 4.6 多步表单（`/api` 的三个 preset 表单）

`_start_api_form(kind)`（`app.py:1750-1753`）：`_clear_selection()`；`form_state = FormState(kind=kind, step=0, values=())`；`_render_form_prompt()`。

字段表 `_api_form_fields(kind)`（`app.py:1818-1828`）：

| kind | 字段序列（i18n key） |
|---|---|
| `deepseek` | `(FORM_DEEPSEEK_KEY,)` — 1 步 |
| `openai` | `(FORM_OPENAI_NAME, FORM_OPENAI_URL, FORM_OPENAI_KEY, FORM_OPENAI_MODELS)` — 4 步 |
| `anthropic` | `(FORM_ANTHROPIC_NAME, FORM_ANTHROPIC_KEY, FORM_ANTHROPIC_MODELS)` — 3 步 |

`_render_form_prompt()`（`app.py:1806-1816`）：取 `fields[form_state.step]` 作为 label **和 placeholder**（`_set_input_prompt(field, field)`），并 `_show_panel(t(PANEL_ADD_API), t(FORM_STEP, step=step+1, total=len(fields), field=field))`，模板 `"Step {step}/{total}: {field}"`。

`_submit_form_value(value, input_widget)`（`app.py:1755-1804`）——由 `on_input_submitted` 第 2 步调用：
1. `form_state is None or paths is None` → return。
2. **空值** → 面板 `(PANEL_INPUT_REQUIRED, PANEL_INPUT_PROMPT)` + `_render_form_prompt()`（不清空输入框、不推进）。
3. `values = (*form_state.values, value)`；若 `len(values) < len(fields)` → 推进 step，**清空输入框**，`_render_form_prompt()`，return。
4. 收集齐 → 按 kind 调用 `create_preset_channel` / `create_channel_with_models`：
   - `deepseek`: `api_key=values[0]`
   - `openai`: `name=values[0]`, `base_url=values[1]`, `api_key=values[2]`, `model_names=values[3].split(",")`
   - `anthropic`: `name=values[0]`, `api_key=values[1]`, `model_names=values[2].split(",")`
5. `ValueError` → `form_state = None`，清空输入框，**`_set_input_prompt("Message", "Ask FlyinChat anything, or type / for commands")`（硬编码英文，未用 i18n）**，面板 `(PANEL_API_SETUP_ERR, str(error))`。
6. 成功 → `form_state = None`，清空输入框，**同样的硬编码英文 `_set_input_prompt`**，`_show_channel_added(channel, models)`。

`_api_form_title(kind)`（`app.py:1830-1840`）**定义了但从未被调用**（死代码）。

**表单进行中的行为约束**：
- `on_input_changed` 第 2 步直接 return，所以表单期间不弹命令/提及菜单。
- `on_key` 里表单**没有**专门分支 —— `up`/`down` 会落到"无 selection_items → 输入历史"分支，可以翻历史填入表单字段。
- 表单期间没有取消机制（Esc 会走第 3/4 步清空输入框，但 `form_state` 不会被清）。这是已知缺陷。

---

## 5. `@` 文件引用（file_mentions）

### 5.1 纯函数层（`file_mentions.py`）

**忽略目录集合**（`file_mentions.py:5-16`）：

```python
IGNORED_DIR_NAMES = frozenset({".git", ".flyinchat", "__pycache__", ".pytest_cache",
                               ".venv", "node_modules", "dist", "build"})
```

判定 `_is_ignored_path(path, root)`：把 `path` 相对 `root` 化后，**任一路径段**命中集合就忽略（所以 `.venv/lib/app.py` 被丢）。注意这是**按目录名逐段判定**，不是前缀匹配。

```python
@dataclass(frozen=True)
class MentionSpan:      start: int; end: int; query: str
@dataclass(frozen=True)
class WorkspacePathSuggestion:  path: str; is_dir: bool
```

`find_active_mention(value, cursor_position=None) -> MentionSpan | None`（`file_mentions.py:32-43`）：

```python
cursor = len(value) if cursor_position is None else cursor_position
cursor = max(0, min(cursor, len(value)))          # 钳位
start = value.rfind("@", 0, cursor)               # 光标前最后一个 @
if start == -1: return None
query = value[start + 1 : cursor]
if any(ch.isspace() for ch in query): return None  # query 中含空白 → 不是活跃提及
return MentionSpan(start=start, end=cursor, query=query)
```

语义：**`@` 到光标之间不能有空白**。因此 `"fix @app now"`（光标在末尾）→ `query="app now"` 含空白 → `None`（测试 `test_find_active_mention_ignores_completed_token`）。`"fix @app"` 光标末尾 → `start=4, end=8, query="app"`。**`end` 永远是光标位置，不是 token 结尾。**

`workspace_path_suggestions(workspace_root, query, *, limit=12)`（`file_mentions.py:46-72`）：

1. `root = workspace_root.resolve()`；不存在或非目录 → `()`。
2. `normalized_query = query.casefold()`。
3. **`root.rglob("*")` 全量遍历**（无深度限制，靠忽略集合剪枝——注意剪枝是在**遍历之后**对每个候选做的，所以 `node_modules` 下的文件仍会被 walk 到再丢弃）。
4. 跳过忽略路径；跳过既非文件也非目录的项。
5. `relative_path = candidate.relative_to(root).as_posix()`（**始终用正斜杠**，跨平台一致）。
6. 匹配 `_matches_path`：`if not query: True`，否则 `query in name.casefold() or query in relative_path.casefold()`（**子串匹配，非前缀**）。
7. `sorted(matches, key=_sort_key)`，取前 `limit`（默认 12）。

排序键 `_sort_key`（`file_mentions.py:86-102`）—— `(rank, file_rank, path)`：

| rank | 条件（均 casefold 后比较） |
|---|---|
| 0 | `query` 为空，或 `name == query` |
| 1 | `name.startswith(query)` |
| 2 | `query in name` |
| 3 | `path.startswith(query)` |
| 4 | 其他（含 `query in path`） |

`file_rank = 1 if is_dir else 0` —— **同 rank 下文件排在目录前**。第三键是路径字典序。

### 5.2 UI 集成

`_show_file_mention_menu(value, cursor_position) -> bool`（`app.py:1124-1162`）：

```python
if self.paths is None: return False
span = find_active_mention(value, cursor_position)
if span is None:
    self._active_mention_span = None; return False
self._active_mention_span = span
suggestions = workspace_path_suggestions(self.paths.project_dir.parent, span.query)   # ← 工作区根
command_menu = self.query_one("#command-menu", Static)
if not suggestions:
    self.selection_context = "file_mention"
    self.selection_title = t(FILE_MENTION_TITLE)
    self.selection_header = ""; self.selection_footer = ""; self.selection_items = (); self.selected_index = 0
    command_menu.update(t(FILE_MENTION_NO_MATCHES, query=span.query)); command_menu.display = True
    return True
items = tuple(SelectionItem(suggestion.path,
                            f"{suggestion.path}/" if suggestion.is_dir else suggestion.path,
                            t(FILE_MENTION_DIR if suggestion.is_dir else FILE_MENTION_FILE))
              for suggestion in suggestions)
self._set_selection(context="file_mention", title=t(FILE_MENTION_TITLE), items=items,
                    footer=t(FILE_MENTION_FOOTER), target_menu=True)
return True
```

要点：
- **工作区根 = `paths.project_dir.parent`**（`project_dir` 是 `<cwd>/.flyinchat`，parent 才是真正的项目目录）。这在整个 app 里出现 6 次，且与 `_init_tools` 里 `workspace` 的计算一致。
- 目录项的 `key` 是**无尾斜杠**的相对路径，但 `title` 带 `/`（视觉区分）；插入时插的是 `key`（无斜杠），因为 `/` 会被当作目录分隔符与后续输入冲突…… 实际插入的仍是 `key` = `src`，用户继续输 `/` 即可展开。
- 无匹配时**保留 `selection_context`/`title` 但清空 `items`**，因此此时 up/down 会走输入历史（因为 `selection_items` 为空）。同时 `on_input_submitted` 第 3 步要求 `self.selection_items` 非空才拦截 —— 无匹配时 Enter 直接提交当前文本。

### 5.3 插入算法 `_insert_selected_file_mention()`（`app.py:1209-1230`）

```python
if not self.selection_items: return
prompt_input = self.query_one("#prompt-input", Input)
cursor_position = getattr(prompt_input, "cursor_position", len(prompt_input.value))
span = find_active_mention(prompt_input.value, cursor_position) or self._active_mention_span
if span is None: self._clear_selection(); return

selected_path = self.selection_items[self.selected_index].key
suffix = prompt_input.value[span.end :]
separator = "" if suffix[:1].isspace() else " "
replacement = f"{selected_path}{separator}"
new_value = f"{prompt_input.value[:span.start]}{replacement}{suffix}"
new_cursor = span.start + len(replacement)
self._suppress_menu_update = True
prompt_input.value = new_value
prompt_input.cursor_position = new_cursor
self._active_mention_span = None
self._clear_selection()
```

**注入格式（原文）**：`replacement = f"{selected_path}{separator}"`，`separator` 为 `""`（后缀首字符已是空白时）或 `" "`。

**关键：`@` 被替换掉（不是保留 `@` 再插路径）**，因为 `span.start` 指向 `@` 的下标。示例：
- `"Explain @app"` 光标末尾，选中 `src/flyinchat/app.py` → `"Explain src/flyinchat/app.py "`（末尾一个空格，因为 suffix 为空）。
- `"Read @app now"` → suffix = `" now"`，`suffix[:1].isspace()` 真 → separator `""` → `"Read src/flyinchat/app.py now"`。

**不读文件内容**：插入的只是相对路径字符串。测试 `test_file_mention_menu_inserts_relative_path` 与 `test_file_mention_submit_persists_path_without_content` 都断言 `SECRET-CONTENT`（文件内容）不出现在输入框或持久化消息里。真正的文件读取由模型随后调用 `file_read` 工具完成。

---

## 6. 模式切换

### 6.1 三种表示

| 位置 | 表示 |
|---|---|
| `self._mode: int` | `0=normal, 1=auto_edit, 2=yolo, 3=plan`，**不持久化**，每次启动重置为 0 |
| `ToolContext.permission` | `PermissionContext{allowed_tools, ask_tools, denied_tools}` —— **原地 mutate** |
| `QueryEngine.mode` | `mode_int_to_str(self._mode)` → `"normal"/"auto_edit"/"yolo"/"plan"` 字符串，进系统提示 |
| 状态栏 | `_mode_label()`（Rich 颜色 + i18n 名称） |

### 6.2 切换触发

只有两处：
1. `on_key` 的 `shift+tab`：`self._mode = (self._mode + 1) % 4` → `_apply_mode_permissions()` → `_render_status_bar()`。
2. `compose()` → `_init_tools()` 末尾调用一次 `_apply_mode_permissions()`（`app.py:420`）。

引擎重建时（`_ensure_query_engine`，`app.py:456`）也会 `self._query_engine.mode = mode_int_to_str(self._mode)`。

### 6.3 `_apply_mode_permissions()` 权限表（`app.py:2160-2199`）

| mode | `allowed_tools` | `ask_tools` | `denied_tools` |
|---|---|---|---|
| 0 normal | `file_read, glob, grep, todo_write, ask_user_question, sub_agent` | `file_write, file_edit, bash, web_fetch, web_search, enter_plan_mode, exit_plan_mode` | `set()` |
| 1 auto_edit | `file_read, file_write, file_edit, glob, grep, todo_write, ask_user_question, sub_agent` | `bash, web_fetch, web_search, enter_plan_mode, exit_plan_mode` | `set()` |
| 2 yolo | **`None`（= 全部允许）** | `set()` | `set()` |
| 3 plan | `file_read, glob, grep, todo_write, ask_user_question, sub_agent, enter_plan_mode, exit_plan_mode` | `bash, web_fetch, web_search` | `file_write, file_edit` |

`allowed_read_roots` / `allowed_write_roots` 恒为 `[workspace]`，`_apply_mode_permissions` **不改**它们。

与 `CLAUDE.md` 文档的对照：文档里 Plan 模式写"denied: write/edit"，但**代码里 plan 模式的 `ask_tools` 包含 `enter_plan_mode`/`exit_plan_mode` 之外的差异**——实际以 `app.py:2190-2197` 为准：plan 模式把 `enter_plan_mode`/`exit_plan_mode` 放进 **allowed**，bash/web 放 ask，write/edit 放 denied。

### 6.4 工具执行时的权限判定（供交叉验证）

`ToolExecutor._tool_allowed`（`tools/core.py:146-161`）判定顺序：`denied` → `allowed`（`allowed_tools is None` 时视为全部允许）→ `ask` → **`mcp_` 前缀默认 ask** → `allowed_tools is None` → 否则拒绝。`ask` 分支里还会先查 `_is_tool_auto_allowed`（always-allow 记忆）决定是否跳过弹窗。

---

## 7. 权限请求 UI 与状态机

### 7.1 端到端时序

```
QueryEngine._execute_tool
  └─ ToolExecutor.execute() → ToolResult(error_code=PERMISSION_REQUIRED)
      └─ QueryEngine._handle_permission_required()            query_engine.py:914
          1. 读 tool.risk_level，args_preview = sanitize_args(tool_input)
          2. PermissionRequest.create(...timeout_seconds=120.0)
          3. request.with_status(PENDING_USER_APPROVAL); _permission_store.save(request)
          4. _write_permission_transcript("permission_request_created", ...)   → role=system, subtype=permission_event
          5. future = loop.create_future(); _pending_permissions[request_id] = future
          6. emit TurnEvent("permission_required", {request_id, tool_name, tool_call_id,
                                                    tool_input, args_preview, risk_level,
                                                    reason, expires_at})
                └─ TUI: _handle_turn_event → _show_permission_request(data)   app.py:1232
          7. remaining = max(expires_at - time.time(), 1.0)
             resolution = await asyncio.wait_for(future, timeout=remaining)   # 超时 → "timeout"
          8. del _pending_permissions[request_id]
          9. 分支：approve / always_approve / deny / timeout
```

### 7.2 权限对话框 UI（`_show_permission_request`, `app.py:1232-1270`）

```python
tool_name    = data.get("tool_name", "unknown")
risk_level   = data.get("risk_level", "medium")
args_preview = data.get("args_preview", "")
reason       = data.get("reason", "")
request_id   = data.get("request_id", "")
tool_input   = data.get("tool_input", {})

self._pending_permission_request_id = request_id
self._pending_permission_tool_input = tool_input
self._pending_permission_tool_name  = tool_name

risk_labels = {"low": t(RISK_LOW), "medium": t(RISK_MEDIUM), "high": t(RISK_HIGH)}   # LOW/MEDIUM/HIGH 或 低/中/高
risk_badge = risk_labels.get(risk_level, risk_level.upper())
hint = t(PERM_TITLE, tool=tool_name, risk=risk_badge, args=args_preview, reason=reason)
if not self._render_history_with_hint(hint, fallback_title=t(PERM_LABEL), fallback_body=hint):
    self._show_panel(t(PERM_LABEL), hint)
self._set_input_prompt(t(PERM_LABEL), t(PERM_PLACEHOLDER))

items = (SelectionItem("approve",        t(PERM_APPROVE),        ""),
         SelectionItem("always_approve", t(PERM_ALWAYS_APPROVE), ""),
         SelectionItem("deny",           t(PERM_DENY),           ""))
self._set_selection(context="permission_request", title=t(PERM_ACTION_TITLE),
                    items=items, footer=t(PERM_ACTION_FOOTER), target_menu=True)
```

`PERM_TITLE` 模板（`en.py:189`，注意它本身**以 `## ` 开头**）：
```
## Permission Required

**Tool:** {tool}

**Risk:** {risk}

**Args:** `{args}`

**Reason:** {reason}

---
Press **Enter** to approve, or **n** to deny
```
`PERM_ACTION_TITLE` = `"Action required"`；`PERM_ACTION_FOOTER` = `"↑/↓ select  |  Enter confirm  |  y=approve  a=always allow  n=deny  esc=deny"`。

**选项只有三个**：`approve` / `always_approve` / `deny`。设计文档（`PERMISSION_REQUEST_STATE_MACHINE.md` §7）建议的"默认焦点在 Deny"**未实现** —— `_set_selection` 总是把 `selected_index` 置 0（= approve）。

UI 呈现方式：权限说明作为 `__hint_N__` 临时消息追加在历史末尾（或退化为全屏面板），动作菜单在 `#command-menu` 里，输入框 label/placeholder 变成 "Permission required"/"Press Enter to approve, n to deny"。

### 7.3 结果回传与 always-allow 记忆（`_resolve_pending_permission`, `app.py:1481-1511`）

```python
def _resolve_pending_permission(self, resolution: str) -> None:
    engine = self._query_engine
    if engine is not None and self._pending_permission_request_id:
        if resolution == "always_approve":
            tool_name  = getattr(self, "_pending_permission_tool_name", "")
            tool_input = getattr(self, "_pending_permission_tool_input", {})
            if self._tool_executor is not None:
                if tool_name.startswith("mcp_"):
                    self._tool_executor.add_auto_allow_tool(tool_name)          # MCP：按工具名放行
                else:
                    cmd = tool_input.get("command", "").strip()                 # 只有 bash 有 command
                    if cmd:
                        parts = shlex.split(cmd)  # except ValueError: cmd.split()
                        if parts:
                            pattern = f"{parts[0]} {parts[1]}" if (len(parts) >= 2 and parts[0] == "git") else parts[0]
                            self._tool_executor.add_command_to_allowlist(pattern)
        engine.resolve_permission(self._pending_permission_request_id, resolution)
    self._pending_permission_request_id = None
    self._clear_selection()
    self.query_one("#command-menu", Static).display = False
    t = self.i18n.t
    self._set_input_prompt(t(TKey.LABEL_MESSAGE), t(TKey.PLACEHOLDER_INPUT))
    self._render_history()
```

**UI 侧与引擎侧重复写 allowlist**：`QueryEngine._handle_permission_required` 在 `always_approve` 分支也做一遍（`query_engine.py:1019-1028`），用 `_extract_command_pattern(parts)`（`query_engine.py:1275-1278`，逻辑与 UI 完全相同）。两处都执行，结果幂等（存进同一个 `set`）。

**always-allow 的作用域与生命周期**：
- `ToolExecutor.command_auto_allowlist` 初始 = `SEED_AUTO_ALLOW_PATTERNS`（`tools/core.py:16-27`：`ls, cat, head, tail, wc, grep, rg, find, echo, date, pwd, which, file, stat, sort, uniq, du, df, ps, env, printenv, tree, basename, dirname, realpath, readlink, cut, tr, diff, jq, md5sum, sha1sum, sha256sum, git status, git log, git diff, git show, git branch, git stash list, git remote, git ls-files, git tag, git rev-parse, git config --get`）。
- `_auto_allow_tools`: 初始空集，放 MCP 工具名。
- **两者都只存在于内存中，进程退出即丢失。不写 config.json。**
- 匹配规则（`tools/core.py:127-141`）：仅对 `bash` 生效；`cmd == pattern or cmd.startswith(pattern + " ")`（前缀 + 空格边界）。

### 7.4 状态转移表（文档 vs 代码）

设计文档 `docs/tui-to-queryengine/PERMISSION_REQUEST_STATE_MACHINE.md` §4 定义了 8 个状态。**代码实现的是一份简化子集**（`tools/permission_request.py` 的 `RequestStatus`）：

| 状态 | 代码是否实现 | 触发点 |
|---|---|---|
| `CREATED` | 间接（`PermissionRequest.create` 的初始态，随即被覆盖） | `query_engine.py:928` |
| `PENDING_USER_APPROVAL` | ✅ | `query_engine.py:938` |
| `APPROVED` | ✅ | `query_engine.py:979-981`（approve）、`1029-1031`（always_approve） |
| `DENIED` | ✅ | `query_engine.py:1070-1072` |
| `EXPIRED` | ✅ | `query_engine.py:1087-1089` |
| `EXECUTED` | ✅ | `query_engine.py:994-997` / `1044-1047`（执行 ok 时） |
| `FAILED_AFTER_APPROVAL` | ✅ | `query_engine.py:1005-1008` / `1055-1058`（执行 !ok） |
| `CANCELLED` | ❌ **未实现** | 会话取消时 pending future 不会被显式置为 cancelled；`request_cancel()` 只 set `_cancel_event` |

**完整状态转移表（代码实际行为）**：

| 当前 | 事件 | 下一状态 | 代码位置 | 副作用 |
|---|---|---|---|---|
| (new) | tool 返回 `PERMISSION_REQUIRED` | `PENDING_USER_APPROVAL` | qe:928-939 | 存 store；写 transcript `permission_request_created`；建 future；emit 事件 |
| PENDING | UI `approve` | APPROVED → 执行 | qe:978-1017 | `execute_approved()`；成功 → `EXECUTED` + transcript `permission_effect_applied(outcome="executed")`；失败 → `FAILED_AFTER_APPROVAL` + `outcome="failed"` |
| PENDING | UI `always_approve` | APPROVED → 执行 | qe:1019-1067 | 先 `add_command_to_allowlist(_extract_command_pattern(parts))`；transcript `resolution="always_approved"`；后续同 approve |
| PENDING | UI `deny` | DENIED | qe:1069-1084 | transcript `resolution="denied"`；返回 `ToolResult(ok=False, content=f"User denied permission for {tool_name}", error_code="PERMISSION_DENIED")` |
| PENDING | `wait_for` 超时（`expires_at - now`，`timeout_seconds=120.0`） | EXPIRED | qe:970-974, 1086-1101 | transcript `resolution="timeout"`；返回 `ToolResult(ok=False, content=f"Permission request timed out for {tool_name}", error_code="PERMISSION_DENIED")` |
| PENDING | 进程被杀 / 会话取消 | **无转移（悬空）** | — | future 随事件循环销毁 |

### 7.5 并发与排队

- **引擎侧**：工具调用在 `for tu in tool_uses:` 里**串行** await（`query_engine.py:735-759`），所以同一轮内**最多一个 pending permission**。多个 `permission_required` 事件不会并发到达。
- **UI 侧**：`_pending_permission_request_id` 是**单槽位**。若在已有 pending 时又收到一个 `permission_required`，`_show_permission_request` 会**覆盖**该字段 —— 前一个 future 留在引擎的 `_pending_permissions` 里直到 120 秒超时。这是真实存在但难以触发的风险（复刻时建议改为队列，或至少保留此行为并记录）。跨轮次也不会并发（`submit_message` 一次一轮）。
- **UI `resolve_permission` 的防御**：引擎侧 `resolve_permission` 在 `future is None or future.done()` 时返回 False 并打 warning（`query_engine.py:1223-1232`），所以重复/迟到的解决不会崩。

### 7.6 transcript 落盘（消息链三事件）

`_write_permission_transcript(turn_id, event_type, **kwargs)`（`query_engine.py:1207-1221`）把 `json.dumps({"event": event_type, **kwargs})` 写成 `role="system", subtype="permission_event"` 的消息。三个事件：

1. `permission_request_created` — `{request_id, tool_name, args_preview, risk_level}`
2. `permission_request_resolved` — `{request_id, resolution}`，resolution ∈ `approved` / `always_approved` / `denied` / `timeout`
3. `permission_effect_applied` — `{request_id, outcome, error?}`，outcome ∈ `executed` / `failed`

**关键不变量**：`message_to_api_format` 对 `subtype in {"permission_event", "skill_event"}` 返回 `None`（`message_utils.py:26-27`），即这些消息**不发给模型**；`message_to_display` 会把它渲染成可读文本。

### 7.7 与 AskUserQuestionTool 的边界

| | Permission Request | AskUserQuestionTool |
|---|---|---|
| 触发 | `ToolResult.error_code == "PERMISSION_REQUIRED"` | `ToolResult.error_code == "USER_INPUT_REQUIRED"` |
| 引擎入口 | `_handle_permission_required`（qe:914） | `_handle_user_input_required`（qe:1103） |
| future 容器 | `_pending_permissions[request_id]` | `_pending_user_inputs[user_input_id]` |
| request_id 来源 | `PermissionRequest.create()` 生成 | `str(uuid4())` |
| 超时 | `request.expires_at - now`（≈120s） | 硬编码 `120.0` |
| 超时结果 | `ToolResult(ok=False, error_code="PERMISSION_DENIED")` | `ToolResult(ok=True, content=json.dumps({"_timeout": True}))` |
| 落盘 | store + 3 条 transcript | 无 |
| UI 入口 | `_show_permission_request` | `_show_user_input_form` |
| 回传 | `engine.resolve_permission(id, "approve"\|"always_approve"\|"deny")` | `engine.resolve_user_input(id, answers_dict)` |

两者**绝不混用**（设计文档 §11 明确要求）。

### 7.8 ask_user 问卷 UI（`app.py:1272-1479`）

**数据结构**：`questions` 是 `list[dict]`，每项 `{question: str, header: str, options: [ {label, description} ], multiSelect: bool}`。

`_show_user_input_form(data)`（1272-1285）：设置四个 `_pending_user_input_*` 字段并重置；**问题列表为空时立即 `_resolve_pending_user_input({"_empty": True})`**。

`_render_user_input_question()`（1287-1330）直接 `update()` 到 `#command-menu`（不走 `_render_selection`）：

```
[{header}] {question_text}
({q_idx + 1}/{总数})

{marker}{label} — {desc}
...

（multiSelect 时）Space=toggle  Enter=confirm selection  →=next  ←=prev
（单选时）↑↓=navigate  Enter=select  ←=prev
```

marker 计算（1288-1319，注意判定顺序）：
- multi 且已选列表含该 label → `"[x] "`
- 单选且已有答案 == 该 label → `"(*) "`
- 单选且 `i == 0` 且尚无答案 → `"(*) "`（默认选中第一项）
- 否则 `"  "`；`i == 0` 时为 `"> "`（但会被上面覆盖，因为单选 i==0 无答案时走 `"(*) "`）

按键处理 `_handle_user_input_key(event)`（1344-1422）——由 `on_key` 第 8 步调用：

| 键 | multi | 单选 |
|---|---|---|
| `escape` | `_resolve_pending_user_input({"_cancelled": True})` | 同 |
| `left` | `q_idx > 0` 则回上一题并重渲染 | 同 |
| `right` / `enter` | 若无选中则默认选第一项；写答案；最后一题 → resolve，否则下一题 | 记录当前 label；最后一题 → resolve，否则下一题 |
| `up` | `_toggle_multi_option(-1)`（移动光标，**不改选中集**） | `_navigate_single_option(-1)`（改选中项） |
| `down` | `_toggle_multi_option(1)` | `_navigate_single_option(1)` |
| `space` | `_toggle_multi_select()`（切换当前光标项） | 无操作 |

multi 的"光标"存在**动态属性** `self._multi_cursor_label`（用 `getattr(..., default)` 读，`app.py:1454`/`1469`），**不在 `__init__` 里初始化**，因此在同一 App 实例内跨问卷会残留。单选导航用 `_navigate_single_option`：从 `options` 找当前 label 的下标（找不到则 `0 if direction > 0 else -1`），`new_idx = (idx + direction) % len(options)`（**循环**）。

`_resolve_pending_user_input(answers)`（1332-1342）：`engine.resolve_user_input(request_id, answers)` → 清空四个字段 → 隐藏 `#command-menu` → 还原输入框 label/placeholder。

---

## 8. 流式渲染

### 8.1 启动/停止 spinner

```python
def _start_spinner(self) -> None:                     # app.py:465-469
    self._is_streaming = True
    self._spinner_frame = 0
    self._spinner_timer = self.set_interval(0.12, self._tick_spinner)   # 120ms/帧
    self._render_status_bar()

def _stop_spinner(self) -> None:                      # app.py:471-475
    self._is_streaming = False
    if self._spinner_timer is not None:
        self._spinner_timer.stop(); self._spinner_timer = None

def _tick_spinner(self) -> None:                      # app.py:481-484
    self._spinner_frame = (self._spinner_frame + 1) % len(self.SPINNER_FRAMES)   # ("|", "/", "—", "\\")
    self._render_status_bar()
    self._scroll_chat_to_bottom()
```

**spinner 每 120ms 同时滚动聊天区到底部**——这是 `_tick_spinner` 里容易漏掉的一半职责。

调用点：`_submit_pending`（569-581）、`on_input_submitted` 主路径（759）、`_run_init`（945）。

### 8.2 文本增量渲染（`_render_streaming_assistant`, `app.py:2395-2418`）

```python
if not self._streaming_assistant_text: return
if self.paths is None or self.active_conversation_id is None: return

now = time.monotonic()
if self._last_stream_render_at and now - self._last_stream_render_at < self._stream_render_interval:
    return                                   # ← 50ms 节流（_stream_render_interval = 0.05）
self._last_stream_render_at = now

label = t(TKey.LABEL_ASSISTANT)
streaming_text = f"**{label}**\n\n{self._streaming_assistant_text}"

if self._streaming_widget is None:
    msg_view = self.query_one("#message-view", Vertical)
    self._transient_counter += 1
    self._streaming_widget = ChatMessage(streaming_text, widget_id=f"__streaming_{self._transient_counter}__")
    msg_view.mount(self._streaming_widget)
else:
    self._streaming_widget.update(streaming_text)      # ← 原地更新已有 widget

self._scroll_chat_to_bottom()
```

**防闪烁的两个机制**：
1. **50ms 节流**（`_stream_render_interval`）—— 丢弃落在窗口内的 `text` 事件，只更新 UI 不重排。
2. **复用同一个 widget**（`_streaming_widget`）—— 只有一个 widget 被反复 `update()`，而非每个 token mount 一个新 widget。

**累积逻辑**（`_handle_turn_event` 的 `"text"` 分支，`app.py:497-501`）：
```python
self._streaming_assistant_text += event.data.get("content", "")
self._streaming_output_tokens = max(1, len(self._streaming_assistant_text) // 4)   # 粗估，非真实 token
self._render_streaming_assistant()
self._render_status_bar()          # 每次都刷状态栏（未节流）
```
节流窗口内的 `text` 事件仍会累加文本、仍会刷状态栏，只是不重绘消息 widget。

`turn_end` / `turn_start` 时 `_streaming_assistant_text = ""`、`_last_stream_render_at = 0.0`；`turn_end` 还会调 `_render_history()` —— `_sync_message_widgets` 会先删掉所有 `__` 前缀 widget（含流式 widget），再从存储 mount 最终消息。**流式 widget 是纯临时产物**，不参与持久化。

### 8.3 滚动（`_scroll_chat_to_bottom`, `app.py:2131-2139`）

```python
def scroll_end():
    try: self.query_one("#chat-area", Container).scroll_end(animate=False)
    except NoMatches: return
self.call_after_refresh(scroll_end)     # 布局完成后滚
self.set_timer(0.08, scroll_end)        # 80ms 后再滚一次，兜住 Markdown 异步渲染导致的尺寸变化
```
**双保险**：`call_after_refresh` + 80ms 定时器。`NoMatches` 被静默吞掉（widget 已卸载时）。

### 8.4 思考内容的显示

**当前实现完全不显示思考内容。** `_handle_turn_event` 的 `"thinking"` 分支是 `pass`（`app.py:495-496`），`"tool_use"` 也是 `pass`（`app.py:502-503`）。

引擎仍在 emit 这些事件（`query_engine.py:485-505`，含 `{"content": ..., "preview": ...}`），TUI 只是忽略。思考块最终由引擎写入 assistant 消息的 content 数组（`{"thinking": ..., "signature": ""}`），在 `turn_end` 后的 `_render_history()` 里通过 `message_to_display` → `_format_assistant_blocks` 整体呈现。

**没有折叠/展开交互**，没有 thinking 折叠 UI。

### 8.5 token 计数显示

| 变量 | 更新点 | 来源 |
|---|---|---|
| `_streaming_output_tokens` | 每个 `text` 事件 | `len(累积文本) // 4`（伪 token，仅用于流式期状态栏） |
| `_last_input_tokens` | `turn_end` | `event.data["input_tokens"]` |
| `_total_output_tokens` | `turn_end` | `+= event.data["output_tokens"]` |
| 会话切换时 | `session_select` | 从 `Conversation.last_input_tokens` / `total_output_tokens` 恢复 |

流式期状态栏文案：`f"{t(STATUS_WORKING)}... {spinner} {tok} tok"`，`tok == 0` 时退化为 `f"... {spinner}"`。

---

## 9. 与 QueryEngine 的接口

### 9.1 所有权关系

```
FlyinChatApp
 ├── self.paths: AppPaths                    (compose 里 initialize_storage 后填充)
 ├── self._query_engine: QueryEngine | None  ← 惰性创建，None 表示"需要重建"
 ├── self._tool_registry: ToolRegistry
 ├── self._tool_executor: ToolExecutor
 ├── self._tool_context: ToolContext         (持有 PermissionContext，被 _apply_mode_permissions 原地改)
 ├── self._skill_registry: SkillRegistry
 ├── self._subagent_registry: SubAgentRegistry
 ├── self._mcp_manager: MCPManager | None
 └── self._observability_client: ObservabilityClient
```

**App 持有引擎**（而非引擎持有 App）。引擎通过 `on_event` 回调把 `TurnEvent` 推给 App。

### 9.2 `_ensure_query_engine()`（`app.py:447-463`）

```python
if self._query_engine is None and self.paths is not None and self.active_conversation_id is not None:
    config = QueryEngineConfig(paths=self.paths,
                               conversation_id=self.active_conversation_id,
                               skill_registry=self._skill_registry,
                               observability_client=self._observability_client)
    self._query_engine = QueryEngine(config)
    self._query_engine.mode = mode_int_to_str(self._mode)
    if 工具三件套齐备:
        self._query_engine.configure_tools(self._tool_registry, self._tool_executor, self._tool_context)
if self._query_engine is None:
    raise RuntimeError("QueryEngine not initialized")
return self._query_engine
```

**"One QueryEngine per conversation"**：换会话 / `/clear` / `/langfuse` 都置 `self._query_engine = None`，下次提交时按当前 `active_conversation_id` 重建。

`QueryEngineConfig` 其余字段用默认值（复刻时可自定义，但 TUI 不传）：`max_tool_rounds=10`, `max_turns=None`, `max_context_retries=1`, `enable_auto_compact=True`, `enable_auto_continue=True`, `max_auto_continues=3`, `auto_continue_turns=10`。

### 9.3 提交与 worker

```python
@work                                   # Textual Worker（异步，非 exclusive）
async def _submit_via_engine(self, prompt: str) -> None:            # app.py:539-567
    if self.paths is None: return
    engine = self._ensure_query_engine()
    result = await engine.submit_message(prompt, on_event=self._handle_turn_event,
                                        user_message_persisted=True)   # ← 用户消息已由 App 持久化
    if result.status == "error" and result.error:
        self._stop_spinner()
        从 conv 恢复 _last_input_tokens / _total_output_tokens
        history = list_messages(...)
        self.query_one("#empty-state", Vertical).display = False
        self._sync_message_widgets(history)
        self._transient_counter += 1
        error_widget = ChatMessage(f"**{t(LABEL_ASSISTANT)}**\n\n{t(MISC_ERROR_PREFIX, error=result.error)}",
                                   widget_id=f"__error_{self._transient_counter}__")
        self.query_one("#message-view", Vertical).mount(error_widget)
        self._scroll_chat_to_bottom(); self._render_status_bar()
        return
    self._render_history()
    self._render_status_bar()
```

`user_message_persisted=True` 是因为**用户消息由 App 自己写**（`_submit_pending` / `on_input_submitted` 里的 `add_message`），引擎不再重复写。

`_submit_pending(prompt)`（`app.py:569-581`）是"先落盘 user 消息再跑引擎"的封装，被 `turn_end(cancelled=True)` 和 `error` 分支用于重提交被打断的 prompt。

`_message_to_api_format` / `_message_to_display` 是**静态方法薄包装**（`app.py:583-589`），转调 `message_utils`。

### 9.4 `_handle_turn_event` 完整分派（`app.py:486-537`）

| event_type | 数据字段 | UI 行为 |
|---|---|---|
| `turn_start` | `turn_number` | 清空 `_streaming_assistant_text`/`_last_stream_render_at`/`_streaming_output_tokens`；`_todos = []`；`#empty-state.display = False`；`_render_todo_panel()` |
| `thinking` | `content`, `preview` | **`pass`（忽略）** |
| `thinking`（reasoning 变体） | 同上 | 同上 |
| `text` | `content` | 累积文本 → 粗估 token → `_render_streaming_assistant()` → `_render_status_bar()` |
| `tool_use` | `name`, `id`, `input` | **`pass`（忽略）** |
| `tool_result` | `tool_use_id`, `name`, `ok`, `content`, `error_code` | 仅当 `name == "todo_write"` → `_refresh_todos_from_context()` |
| `skill_resolved` | `applied_skills`, `active_phase`, `guards_applied` | `_render_history()` + `_render_status_bar()` |
| `compact_start` | `strategy`（`"preflight"`） | `_compacting = True` + `_render_status_bar()` |
| `compact_end` | `applied`, `strategy` | `_compacting = False` + `_render_status_bar()` |
| `turn_end` | `status`, `terminal_reason`, `final_text`, `tool_rounds`, `num_turns`, `base_max_turns`, `max_turns`, `current_max_turns`, `auto_continue_count`, `last_tool_error`, `input_tokens`, `output_tokens`, 以及 cancelled 时的 `cancelled: True` | 见下 |
| `error` | `message` | `_stop_spinner()`；若有 `_pending_prompt` → 取出并 `_submit_pending()`（重试） |
| `permission_required` | `request_id`, `tool_name`, `tool_call_id`, `tool_input`, `args_preview`, `risk_level`, `reason`, `expires_at` | `_show_permission_request(data)` |
| `user_input_required` | `request_id`, `tool_name`, `tool_call_id`, `questions` | `_show_user_input_form(data)` |

`turn_end` 分支（`app.py:516-527`）：
```python
self._last_input_tokens = event.data.get("input_tokens", 0)
self._total_output_tokens += event.data.get("output_tokens", 0)
self._streaming_assistant_text = ""; self._last_stream_render_at = 0.0
self._stop_spinner()
self._render_history()
self._render_status_bar()
if event.data.get("cancelled") and self._pending_prompt is not None:
    pending = self._pending_prompt; self._pending_prompt = None
    self._submit_pending(pending)          # 取消后自动提交排队的那条
```

**注意 `_render_history()` 在渲染前先 `list_messages` 读盘** —— UI 的"真相源"是存储，不是内存累加。这是"引擎驱动 UI"的具体体现。

### 9.5 取消/中断传导

```
用户流式中按 Enter（有新 prompt）       用户流式中按 Esc
  on_input_submitted 第 8 步              on_key 第 2 步
  _pending_prompt = prompt                _request_cancel()
  _request_cancel()                          ↓
      ↓                                  engine._cancel_event.set()
FlyinChatApp._request_cancel()               ↓
  self._query_engine.request_cancel()   引擎主循环检测 is_cancelled
      ↓                                      ↓
QueryEngine.request_cancel()              finish(cancelled=True, status="cancelled")
  self._cancel_event.set()                   ↓
                                         emit TurnEvent("turn_end", {..., "cancelled": True})
                                             ↓
                                         TUI: _pending_prompt 非空 → _submit_pending(pending)
```

要点：
- `request_cancel()`（`query_engine.py:76-77`）只 set `asyncio.Event`，不抛异常、不打断正在 await 的 permission future。若正值权限等待，取消不会生效（future 仍等 120s）。
- TUI 只在 `_is_streaming` 为 True 时把 Esc 解释为取消；否则是双击清屏。
- 排队重提需要 `_pending_prompt` 非 None；纯 Esc 取消（无新 prompt）不会重提。
- `error` 事件也走同样的重提路径（`app.py:528-533`）—— 引擎报错时若队列里有 prompt，会尝试提交它。

### 9.6 渲染真相源总结

| UI 元素 | 数据源 | 更新时机 |
|---|---|---|
| 消息区 | `list_messages(chat_path, conversation_id)` | `_render_history()`（读盘） |
| 状态栏 token / 消息数 | 内存计数 + `list_messages` 长度 | `_render_status_bar()` |
| 模型/思考/窗口信息 | `get_primary_llm_model(config_path)` | `_render_status_bar()` |
| todo 面板 | `ToolContext.turn_state["todos"]` | `tool_result(todo_write)` 事件 |
| MCP 状态 | `MCPManager.get_status()` | `_render_status_bar()` / `_show_mcp_servers()` |
| Langfuse 状态 | `ObservabilityClient.enabled` | `_render_status_bar()` |

---

## 10. i18n 系统

### 10.1 结构

```python
# i18n/keys.py
class TKey(StrEnum):     # 值形如 "cmd.api"、"panel.compact_done"、"status.mode.yolo"
    CMD_API = "cmd.api"
    ...
    # 共 ~190 个 key，分组：Commands / Reasoning / Effort / API actions / Role labels /
    # Placeholders / Empty state / Command menu / Panels / API form / Selection UI /
    # MCP panels / Status bar / Hints / Permission / Risk / Todo / Misc / Init / Compact engine

# i18n/store.py
class Language(StrEnum): EN = "en"; ZH = "zh"
_TRANSLATIONS: dict[Language, dict[TKey, str]] = {Language.EN: EN, Language.ZH: ZH}

class I18nStore:
    def __init__(self, lang: Language = Language.EN): self._lang = lang; self._dict = _TRANSLATIONS[lang]
    @property
    def language(self) -> Language: return self._lang
    def set_language(self, lang: Language) -> None: self._lang = lang; self._dict = _TRANSLATIONS[lang]
    def t(self, key: TKey, **kwargs: object) -> str:
        template = self._dict.get(key)
        if template is None: return str(key)          # 缺 key → 返回 key 的字符串形式，不抛错
        if not kwargs: return template
        return template.format(**{k: v for k, v in kwargs.items()})
```

`i18n/__init__.py`：`__all__ = ["I18nStore", "Language", "TKey"]`。

### 10.2 关键特性

- **零运行时文件 I/O**：翻译表是 Python 字面量 dict，import 时就在内存里。
- **查找**：`t(key, **kwargs)`；`kwargs` 非空时走 `str.format`。模板里用的占位符都是 `{name}` 形式。
- **缺 key 行为**：返回 `str(key)` —— 因为 `TKey` 是 `StrEnum`，`str(TKey.CMD_API)` 在 Python 3.11 对 StrEnum 返回 `"cmd.api"`（值）。这与 `t()` 用于 UI 文本的意图相符（显示原始 key 名而非崩溃）。
- **`EN` 与 `ZH` 必须覆盖完全相同的 key 集合**（否则某语言下会显示 key 值）。当前两边都是 190 个左右的完整映射。

### 10.3 语言切换与持久化

- 读取：`_load_language()`（`app.py:338-346`）在 `compose()` 里，`get_app_setting(config_path, "language")` 返回 `"en"/"zh"`，`Language(stored)` 转换，**非法值被 `except ValueError: pass` 吞掉**（保持默认 EN）。
- 写入：`_toggle_language()` 里 `set_app_setting(config_path, "language", new_lang.value)`。
- 存储位置：`~/.flyinchat/config.json` 的 `app_settings.language`（JSON 字符串）。

### 10.4 新增文案的流程（复刻时必须照做）

1. 在 `i18n/keys.py` 的 `TKey` 里加一行 `MY_KEY = "group.my_key"`（值用点分层级）。
2. 在 `i18n/en.py` 的 `EN` dict 里加 `TKey.MY_KEY: "English text"`。
3. 在 `i18n/zh.py` 的 `ZH` dict 里加 `TKey.MY_KEY: "中文文本"`。
4. 在 `app.py` 里用 `self.i18n.t(TKey.MY_KEY)` 或 `self.i18n.t(TKey.MY_KEY, name=value)`。**注意：每次调用都用 `self.i18n.t`（或局部 `t = self.i18n.t`），因为语言可能在运行中切换。**

### 10.5 未 i18n 的硬编码字符串（复刻基线必须保留）

| 位置 | 字符串 |
|---|---|
| `app.py:1803` | `_set_input_prompt("Message", "Ask FlyinChat anything, or type / for commands")`（`_submit_form_value` 成功路径；失败路径 `1797` 用 i18n） |
| `app.py:1006` | `"MCP manager not initialized."` |
| `app.py:1015` | `f"Server '{server_name}' not found."` |
| `app.py:1067` | `f"*按 **Enter** 查看选项*"`（中文硬编码） |
| `app.py:1076` | `f"Reconnect {server_name}"` |
| `app.py:1077` | `"Back to MCP list"` |
| `app.py:1104` | `f"Reconnect failed for {server_name}"` |
| `app.py:1520`等 | `_add_api_channel` / `_submit_form_value` 里的 `ValueError("Usage: ...")` 文案 |
| `app.py:1739` | `f"Strategy: {result.strategy}\nTokens: {before_k}K → {after_k}K"` |
| `_show_model_settings` / `_show_thinking_settings` 等的 header | `f"{channel.name} / {model.name}\nThinking is currently {status}"` 中的英文片段 |

另有若干 `TKey` 定义了但从未被使用：`TODO_EMPTY`、`PANEL_INIT_DONE`、`CMD_INIT_DESC` 之外的若干。复刻时保留 key 即可。

---

## 11. 初始化序列（工具 / skill / sub-agent / MCP）

### 11.1 `_init_tools()`（`app.py:371-424`），在 `compose()` 里调用

```python
1. workspace = self.paths.project_dir.parent if self.paths is not None else Path.cwd()
                # ← <cwd>/.flyinchat 的父目录 = 真正的项目根

2. permission = PermissionContext(
       allowed_tools={"file_read", "glob", "grep", "todo_write", "ask_user_question", "sub_agent"},
       ask_tools={"file_write", "file_edit", "bash", "web_fetch", "web_search",
                  "enter_plan_mode", "exit_plan_mode"},
       denied_tools=set(),
       allowed_read_roots=[workspace],
       allowed_write_roots=[workspace])

3. self._tool_context = ToolContext(session_id="flyinchat", user_id="user",
                                    workspace_root=workspace, permission=permission)
       # ← session_id 是常量 "flyinchat"，user_id 是常量 "user"

4. self._skill_registry = SkillRegistry(workspace); self._skill_registry.refresh()
5. self._subagent_registry = SubAgentRegistry(workspace); self._subagent_registry.refresh()

6. self._tool_registry = ToolRegistry()
   按此顺序 register（顺序 = 模型看到的工具顺序）：
     FileReadTool, FileWriteTool, FileEditTool, BashTool, GlobTool, GrepTool,
     WebFetchTool, WebSearchTool, AskUserQuestionTool, TodoWriteTool,
     EnterPlanModeTool, ExitPlanModeTool

7. self._tool_executor = ToolExecutor(self._tool_registry)

8. if self.paths is not None and self._subagent_registry is not None:
       self._tool_registry.register(SubAgentTool(
           config_path=self.paths.config_path,
           chat_path=self.paths.chat_path,
           subagent_registry=self._subagent_registry,
           tool_registry=self._tool_registry,        # ← 传自己，供子agent复制受限注册表
           tool_executor=self._tool_executor))
   # sub_agent 最后注册，注释说明原因：让子 agent 能拿到同一份注册表做受限副本

9. self._apply_mode_permissions()          # 用当前 _mode（compose 时恒为 0）覆盖 permission

10. if self._query_engine is not None:     # compose 时通常为 None
        self._query_engine.configure_tools(self._tool_registry, self._tool_executor, self._tool_context)
```

### 11.2 MCP 启动（`_init_mcp_servers`, `app.py:426-445`）

```python
@work(exclusive=True)                      # exclusive：重复调用会取消前一个 worker
async def _init_mcp_servers(self) -> None:
    if self.paths is None or self._tool_registry is None or self._tool_context is None: return
    self._mcp_manager = MCPManager()
    mcp_config = load_mcp_config(self.paths)
    if mcp_config.servers:
        await self._mcp_manager.connect_all(mcp_config.servers, self._tool_registry, self._tool_context)
    self.call_later(self._render_status_bar)
    # Keep the worker alive so anyio cancel scopes stay valid (Python 3.14 compat)
    self._mcp_shutdown_event = asyncio.Event()
    try:
        await self._mcp_shutdown_event.wait()
    except asyncio.CancelledError:
        pass
```

**必须在 `on_mount` 里调用**（`app.py:361`），不能在 `compose`（`@work` 需要运行中的事件循环）。MCP 工具以 `mcp_{server}_{tool}` 命名动态注册进 `_tool_registry`。

**三个易错点**：
1. worker 故意不退出（`await self._mcp_shutdown_event.wait()`），注释说明是为了让 anyio 的 cancel scope 有效（Python 3.14 兼容）。`action_quit` 里 set 该 event 来结束它。
2. `_mcp_shutdown_event` **不在 `__init__` 里初始化**，只能靠 `hasattr(self, "_mcp_shutdown_event")` 探测（`app.py:364`）。若 MCP 初始化还没走到那一步就退出，属性不存在。
3. `_mcp_manager` 是**在 worker 内部**才创建的，所以 `on_mount` 之后短时间内 `self._mcp_manager is None`，`/mcp` 与状态栏会走"无 manager"分支。

### 11.3 时序总结

```
FlyinChatApp.__init__            (无 I/O，仅赋初值)
   ↓
compose()
   ├─ initialize_storage()       (建 ~/.flyinchat/config.json + <ws>/.flyinchat/chat.json)
   ├─ _load_language()            (读 app_settings.language)
   ├─ _init_observability()       (Langfuse 或 Noop)
   ├─ _init_tools()               (workspace → permission → context → skill/subagent registry
   │                               → ToolRegistry(12 个工具) → ToolExecutor → SubAgentTool
   │                               → _apply_mode_permissions())
   └─ yield 布局树
   ↓
on_mount()
   ├─ #prompt-input.focus()
   ├─ _render_status_bar()
   └─ _init_mcp_servers()  [@work(exclusive=True) 后台]
         └─ MCPManager() → connect_all() → call_later(_render_status_bar)
            → await _mcp_shutdown_event.wait()   ← 常驻
   ↓
首次提交消息
   └─ _ensure_query_engine()      (惰性建 QueryEngine + configure_tools + mode)
```

---

## 12. 关键不变量、易错点与复刻检查清单

### 12.1 关键不变量（复刻时不可破坏）

1. **`active_conversation_id is None` ⟺ "尚无会话"**。首条消息触发 `create_conversation(title=prompt[:80])`。任何置 None 的操作（`/clear`）都必须同时置 `_query_engine = None`。
2. **`_query_engine is None` 是唯一的"重建信号"**。换会话、`/clear`、`/langfuse` 都靠它。旧引擎的 pending future 会被丢弃（若正好有权限等待，那个 future 永远不 resolve，旧 worker 卡到超时）。
3. **消息区真相源是存储**，不是内存。`_render_history()` 每次读盘。
4. **`_sync_message_widgets` 会删掉所有 id 以 `__` 开头或 id 为空的 child**。任何临时 widget 必须用 `__` 前缀；任何持久 widget 必须用 `msg-{message_id}`。
5. **`selection_items` 为空是 up/down 走输入历史的唯一开关**。
6. **`_pending_permission_request_id` / `_pending_user_input_request_id` 是单槽位**。
7. **用户消息由 TUI 落盘，引擎不重复落盘**（`user_message_persisted=True`）。
8. **`span.start` 指向 `@`，插入时 `@` 被替换掉**，不是追加。
9. **workspace 根 = `paths.project_dir.parent`**，出现在 `_init_tools`、`_show_skills`、`_show_file_mention_menu`、`_run_compact`（trace 的 workspace）、`_init_mcp_servers` 间接处。
10. **`_mode` 不持久化**，每次启动是 0（NORMAL）。
11. **always-allow 记忆只在内存**（`ToolExecutor` 实例），进程退出即丢。
12. **`thinking` / `tool_use` 事件被 TUI 忽略**（`pass`），不产生 UI 更新。
13. **`escape` 单次按下不拒绝权限**（双击才行，或按 `n`）。

### 12.2 已知缺陷 / 死代码（复刻时的决策点）

| 项 | 位置 | 说明 |
|---|---|---|
| `_api_form_title()` | `app.py:1830-1840` | 定义但从未调用 |
| `_last_usage` | 6 处写入，0 处读取 | 纯死字段 |
| `mcp_status` 局部变量 | `app.py:955` | 赋值后未使用 |
| 单次 Esc 拒绝权限不可达 | `app.py:623-626` | 被 599-612 提前 return 屏蔽 |
| `/clear` 里 `empty-state.display = True` 被 `_show_panel` 覆盖 | `app.py:1658-1659` | 无害但令人困惑 |
| `/language` 不刷新已有 widget | `app.py:878-888` | 切换后 input-label / empty-hint 仍是旧语言直到被重写 |
| 表单无法取消 | `app.py:1750-1816` | `form_state` 只能靠填完或异常清除；Esc 不清 |
| `_set_input_prompt` 硬编码英文 | `app.py:1803` 等 | 中文界面下会显示英文 |
| `_render_status_bar` 每帧读盘 | `app.py:2279` | `list_messages()` 在每次状态栏刷新时调用 |
| `_multi_cursor_label` 动态属性 | `app.py:1454`/`1461`/`1469` | 未在 `__init__` 初始化，跨问卷残留 |
| 权限请求无队列 | `app.py:1240` | 并发时会覆盖；引擎侧串行执行使其难以触发 |
| CANCELLED 状态未实现 | `query_engine.py` | 设计文档要求，代码没有 |
| `_render_user_input_question` 的 `"> "` marker | `app.py:1311` | 会被后续 `"(*) "` 覆盖，实际不可见 |
| `_show_panel` 清空整个消息区 | `app.py:2422` | 所有非菜单选择 UI 都会"覆盖"会话视图，需显式 `_render_history()` 恢复 |
| 无 `on_unmount` | — | 清理只在 `action_quit`；异常退出时 MCP/observability 不清理 |

### 12.3 复刻检查清单

**结构层**
- [ ] `App` 单类持有全部 UI 状态 + 引擎 + 工具注册表；`compose()` 有 4 个副作用且顺序固定
- [ ] 布局树 7 个容器 + 5 个 `Static` + 1 个 `Input` + Header/Footer，id 完全一致
- [ ] `#command-menu` 一 widget 五角色（命令/提及/权限/MCP/问卷）
- [ ] `ChatMessage` 是 Markdown 的薄包装，id 命名分 `msg-` / `__` 两类
- [ ] CSS 的全部颜色值照抄（14 条规则）
- [ ] `TEXTUAL_DISABLE_KITTY_KEY=1` 在 import textual 前设置

**交互层**
- [ ] `on_key` 的 14 步判定顺序（尤其 1-4 步的提前 return）
- [ ] `on_input_changed` 的 6 步判定顺序 + `_suppress_menu_update` 抑制机制
- [ ] `on_input_submitted` 的 11 步判定顺序（尤其第 4 步带参数命令、第 8 步打断重提）
- [ ] `up`/`down` 双重语义（菜单 vs 输入历史）
- [ ] `tab` 补全同时递增 `selected_index`
- [ ] 双击 Esc（<0.5s）= 清空输入 + 重置选择 + 拒绝权限
- [ ] 流式中 Esc = 取消；流式中 Enter = 排队 + 取消 + 自动重提

**命令层**
- [ ] 14 条命令，靠 `_get_commands()` 单点注册，前缀匹配（大小写敏感）
- [ ] `_run_command` 先判 `/api`、`/api add `、`/model`、`/model use `，再 `match` 其余
- [ ] `_activate_selection` 的 11 个 context 分支
- [ ] 6 个选择 UI 走面板（`api_actions`/`model_select`/`thinking_toggle`/`reasoning_select`/`effort_select`/`session_select`），5 个走 command-menu（`main`/`file_mention`/`permission_request`/`mcp_select`/`mcp_action`）
- [ ] `/effort low` 只关 thinking 不改 effort；其他级别开 thinking + 设 effort
- [ ] `/1M` 双向切换 125_000 ↔ 1_000_000
- [ ] `/init` = 建会话（title `"/init"`）+ 落盘 `INIT_PROMPT` + 走正常提交流程
- [ ] `/compact` 的 5 个早退分支 + 独立 AgentTrace
- [ ] API 多步表单 3 种 kind 的字段序列与写回参数对位
- [ ] `_mask_api_key`：`len<=6` → "configured"，否则 `first3...last2`

**@ 引用**
- [ ] `find_active_mention`：光标前最后一个 `@`，query 含空白 → None，end = 光标
- [ ] `IGNORED_DIR_NAMES` 8 项，逐路径段判定
- [ ] `rglob("*")` + `casefold` 子串匹配 + `(rank, file_rank, path)` 排序 + limit 12
- [ ] 排序 rank 5 级 + 文件在目录前
- [ ] 插入时**替换** `@`，separator 依后缀首字符是否为空白决定 `""`/`" "`，插入的是相对路径（posix 斜杠），不读文件内容

**模式与权限**
- [ ] 4 模式循环 `(mode+1)%4`，shift+tab 全局最高优先级
- [ ] `_apply_mode_permissions` 3 个集合的 4 套取值照抄；yolo 的 `allowed_tools = None`
- [ ] 引擎 `mode` 同步为 `mode_int_to_str`
- [ ] 权限对话框 3 选项（approve / always_approve / deny），footer 文案含 `y/a/n/esc` 提示
- [ ] 状态机 7 状态（CREATED/PENDING/APPROVED/DENIED/EXPIRED/EXECUTED/FAILED_AFTER_APPROVAL），CANCELLED 未实现
- [ ] 超时 120s → EXPIRED → 按 deny 处理（`PERMISSION_DENIED`）
- [ ] always_approve 写 `command_auto_allowlist`（git 两段式模式）或 `_auto_allow_tools`（mcp_ 前缀），仅内存
- [ ] 3 条 transcript（request_created / request_resolved / effect_applied），role=system + subtype=permission_event，且不发往 API
- [ ] ask_user 问卷走同一 `#command-menu` widget，题库为空时立即 resolve `{"_empty": True}`，Esc → `{"_cancelled": True}`，超时 → `{"_timeout": True}`

**流式与渲染**
- [ ] 50ms 节流 + 单 widget 复用（`_streaming_widget`）
- [ ] spinner 120ms/帧，同时滚到底部
- [ ] `_scroll_chat_to_bottom` 双保险（`call_after_refresh` + 80ms timer + `NoMatches` 吞掉）
- [ ] `thinking` / `tool_use` 事件 `pass`
- [ ] 流式 token 粗估 `max(1, len(text)//4)`
- [ ] `turn_end` 从事件取 `input_tokens` / 累加 `output_tokens`，然后 `_render_history()`

**引擎接口**
- [ ] `_ensure_query_engine` 惰性创建 + `mode_int_to_str` + `configure_tools`
- [ ] `_submit_via_engine` 是 `@work`，`user_message_persisted=True`
- [ ] 12 个 TurnEvent 类型的完整分派（含 3 个 `pass`）
- [ ] `turn_end(cancelled=True)` 与 `error` 都触发 `_pending_prompt` 重提
- [ ] `_request_cancel()` → `engine.request_cancel()`

**i18n**
- [ ] `TKey` 是 StrEnum，值是点分字符串；EN/ZH 两份 dict key 集合相同
- [ ] `t()` 缺 key 返回 `str(key)`；kwargs 走 `format`
- [ ] 语言持久化到 `app_settings.language`，在 `compose` 里读取（widget 构造之前）
- [ ] 新增文案需同时改 3 个文件

**初始化**
- [ ] `_init_tools` 的 12 步顺序（workspace → permission → context → skill/subagent → 12 工具 → executor → SubAgentTool → apply_mode → configure_tools）
- [ ] `workspace = paths.project_dir.parent`，`session_id="flyinchat"`，`user_id="user"`
- [ ] `_init_mcp_servers` 在 `on_mount` 里 `@work(exclusive=True)` 启动，常驻等 `_mcp_shutdown_event`
- [ ] `action_quit` 依次 shutdown MCP → observability → super
- [ ] `run()` = `configure_logging()` + `FlyinChatApp().run()`

**测试基线**（`tests/test_app.py` 814 行 / **30 个 `test_` 函数**；`tests/test_file_mentions.py` 4 个。复刻后必须全绿）
- [ ] `test_app_can_be_created` — `app.title == "FlyinChat"`
- [ ] `test_app_renders_empty_homepage` — logo 含 `███████`；input placeholder == `"Ask FlyinChat anything, or type / for commands"`；config/chat 文件已建
- [ ] `test_app_shutdown_calls_observability_client` — `shutdown_count == 1`
- [ ] `test_slash_opens_command_menu` — `/` 后菜单含 `/api`、`/sessions`、`/clear`
- [ ] `test_api_selection_flow_adds_deepseek` — 键盘全流程建渠道，模型名 `["deepseek-v4-pro", "deepseek-v4-flash"]`
- [ ] `test_api_page_masks_configured_keys` — 面板含 `"dee...et"`，不含明文 key
- [ ] `test_model_command_lists_configured_models` — 含 `"1. DeepSeek · anthropic"`、`"1.1 deepseek-v4-pro [primary]"`
- [ ] `test_streaming_text_renders_before_turn_end` — 分块流式，第一块后消息区含 `"partial"` 但不含 `"partial complete"`
- [ ] `test_tool_permission_request_appears_during_conversation` — 消息区含 `"Permission Required"`、`"file_write"`；菜单含 `"Approve"`；Enter 后文件被写
- [ ] `test_prompt_history_uses_arrow_keys` / `..._restores_draft_and_skips_commands`
- [ ] `test_file_mention_*` 4 个 — 插入 `"Explain src/flyinchat/app.py "`（注意尾空格），无文件内容泄漏
- [ ] `test_double_escape_clears_input` — 第一次 Esc 无效，第二次清空且 `selection_items == ()`
- [ ] `test_skills_command_shows_loaded_skills` — 含 `"safe-edit@1.0.0"`、tags
- [ ] `tests/test_file_mentions.py` 4 个纯函数测试

测试注入模式（复刻时保留可测试性）：`FlyinChatApp(paths=..., observability_client=FakeObservabilityClient())`；测试常替换 `app._submit_via_engine = lambda prompt: app._stop_spinner()` 来跳过真实 LLM；`_get_message_view_text(app)` 通过遍历 `#message-view` 子 widget 的 `._markdown` 属性拼文本（依赖 `Markdown` 的内部字段名，复刻到其它语言时需换可观测点，例如暴露 `content` 属性）。
