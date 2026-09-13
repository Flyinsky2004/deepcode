# 01 — 数据层 / 持久化层（Data Layer）实现规格

> **导航**：本文件是 `docs/REWRITE_SPEC.md`（总纲）的子规格。建议先读总纲了解架构全景，再回到本文件逐条实现。
> 相关：总纲 §0.2.1（文档与代码冲突清单）、§7（已知缺陷与复刻决策）、§8（复刻路线图）。


> 复刻目标：用另一种语言从零实现 FlyinChat 的数据层。
> 本文档所有内容均来自对源码的逐行阅读与**实际运行验证**（探针脚本输出已并入）。
> 引用格式 `文件:行号` 指向仓库当前 HEAD（branch `main`，最近提交 `9fc43b3 feat: sub agent`）。

---

## 0. 模块清单与文件位置

| 文件 | 行数 | 职责 |
|---|---|---|
| `src/flyinchat/models.py` | 82 | 全部不可变（frozen）dataclass 领域模型定义 |
| `src/flyinchat/paths.py` | 25 | 路径解析：全局配置目录 + per-project 目录 |
| `src/flyinchat/storage.py` | 903 | JSON 文件 CRUD、原子写入、默认值填充、SQLite 迁移、provider preset |
| `src/flyinchat/message_utils.py` | 307 | 内部 `Message` → provider API 字典 / 终端显示文本的双向转换 |
| `src/flyinchat/__init__.py` | 3 | 只导出 `FlyinChatApp`（会触发 `app.py` 导入，进而导入 Textual） |
| `src/flyinchat/logging_config.py` | 68 | 结构化 JSON 日志（与本层无持久化耦合，但路径与 `.flyinchat` 同源） |
| `src/flyinchat/observability/config.py` | 87 | **跨模块**：`app_settings` 的 Langfuse 子集读取（见 §4.7） |
| `src/flyinchat/mcp/config.py` | 49 | **跨模块**：`mcp_servers` 数组的解析（见 §4.6） |

**复刻提示**：`storage.py` 是唯一写盘的地方（除了 `logging_config`、`observability/config.py` 与测试）。整个数据层没有 ORM、没有连接池、没有事务——**每次读写都是"全量读 JSON → 在内存中改 → 全量原子写回"**。这是最重要的架构事实。

---

## 1. 模块在架构中的位置（谁调用谁）

```
                 ┌────────────────────────────────────────┐
                 │  paths.py                              │
                 │  AppPaths / resolve_app_paths()        │
                 └──────────────┬─────────────────────────┘
                                │ AppPaths(config_path, chat_path, ...)
                                ▼
   models.py ──────────► storage.py ◄─────────── mcp/config.py (MCPConfig.from_dict)
   (frozen dataclass)    (JSON 文件 CRUD)         observability/config.py (只读 app_settings)
                                ▲
                                │ 读/写
        ┌───────────────────────┼───────────────────────┬──────────────────┐
        │                       │                       │                  │
   query_engine.py         compact.py            subagents/executor.py   app.py
   (主循环)                (压缩)                 (子代理转录)            (Textual TUI)
        │                                                                  │
        └────────────► message_utils.py ◄─────────────────────────────────┘
                  message_to_api_format / message_to_display
```

### 1.1 调用方精确清单（导入符号级别）

`src/flyinchat/query_engine.py:19-28`：
```python
from .storage import (
    add_message_with_turn,
    get_conversation,
    get_primary_llm_model,
    increment_turn,
    list_active_messages,
    list_messages,
    update_conversation_usage,
)
```

`src/flyinchat/compact.py:14-19`：
```python
from flyinchat.storage import (
    add_message,
    list_messages,
    update_conversation_compacted_count,
    update_message_content,
)
```

`src/flyinchat/subagents/executor.py:12-19`：
```python
from flyinchat.storage import (
    add_message_with_turn,
    create_subagent_conversation,
    increment_turn,
    list_messages,
    update_conversation_usage,
)
```

`src/flyinchat/tools/sub_agent_tool.py:8`：
```python
from flyinchat.storage import get_primary_llm_model
```

`src/flyinchat/app.py:35-56`（TUI，导入最多）：
```python
from .storage import (
    PROVIDER_PRESETS, add_message, create_channel_with_models, create_conversation,
    create_preset_channel, get_app_setting, get_conversation, get_primary_llm_model,
    initialize_storage, list_active_messages, list_conversations, list_llm_channels,
    list_llm_models, list_messages, load_mcp_config, set_app_setting,
    set_model_context_window, set_model_reasoning_effort, set_model_thinking,
    set_primary_llm_model,
)
```

`src/flyinchat/app.py:20,22`：
```python
from .logging_config import configure_logging
from .message_utils import message_to_api_format, message_to_display
from .models import LLMChannel, LLMModel, TurnResult
```

### 1.2 初始化时序（**复刻必须照做**）

`app.py:318`（在 `compose()` 内，**不是** `__init__`）：
```python
self.paths = initialize_storage(self.paths)
```
即：构造 `FlyinChatApp(paths=None)` → `self.paths = None` → Textual 调 `compose()` → `initialize_storage(None)` → `resolve_app_paths()` 用真实 `Path.home()` / `Path.cwd()` → 立刻创建两个文件。

`storage.py:44-48`：
```python
def initialize_storage(paths: AppPaths | None = None) -> AppPaths:
    app_paths = paths if paths is not None else resolve_app_paths()
    initialize_config_store(app_paths.config_path)
    initialize_chat_store(app_paths.chat_path)
    return app_paths
```

**关键不变量**：`initialize_storage` **总是重写两个文件**（即使它们已存在）。它对已存在文件做的是"读→归一化→写回"，因此每次启动都会：
1. 补齐所有缺失字段的默认值；
2. 把 `schema_version` 强制为 `1`；
3. 用 `json.dumps(..., ensure_ascii=False, indent=2) + "\n"` 重新排版（会消除用户手工编辑的格式差异）。

**易错点**：这个过程会**丢失未知的顶层键**（见 §9.3）。

---

## 2. 全部 dataclass 的完整字段定义

所有 dataclass 都是 `@dataclass(frozen=True)`（不可变、可哈希、可用于 `==` 比较）。字段全部**无 `field(default_factory=...)`**，`meta` 之类的容器用 JSON 字符串表示而非 dict，正是为了保持 frozen 可哈希。

### 2.1 `LLMChannel` — `models.py:4-12`

| 字段 | 类型 | 默认 | 可选 | 语义 |
|---|---|---|---|---|
| `id` | `str` | 无 | 否 | UUID4 字符串（`str(uuid4())`） |
| `name` | `str` | 无 | 否 | 显示名，如 `"DeepSeek"`、`"Local"` |
| `provider_type` | `str` | 无 | 否 | 只能是 `"openai_compatible"` 或 `"anthropic"`（枚举见 §3.1） |
| `base_url` | `str \| None` | 无 | **是** | `None` 表示用 provider 默认端点（Anthropic 官方）；OpenAI 兼容必须给 |
| `api_key` | `str` | 无 | 否 | 明文存储，**不做任何加密** |
| `created_at` | `str` | 无 | 否 | ISO8601 UTC，毫秒精度，`Z` 后缀（见 §8.4） |
| `updated_at` | `str` | 无 | 否 | 同上 |

字段顺序即位置参数顺序，`_channel_from_dict` 用关键字参数构造。

### 2.2 `LLMModel` — `models.py:15-26`

| 字段 | 类型 | 默认 | 可选 | 语义 |
|---|---|---|---|---|
| `id` | `str` | 无 | 否 | UUID4 |
| `channel_id` | `str` | 无 | 否 | 外键 → `LLMChannel.id`，**无外键约束，无级联删除** |
| `name` | `str` | 无 | 否 | 传给 provider 的 model 名，如 `"deepseek-v4-pro"` |
| `is_default` | `bool` | 无 | 否 | 是否 primary model；**唯一性由代码保证，非 DB 约束** |
| `thinking_enabled` | `bool` | `True` | 否 | 映射到 anthropic `thinking={"type":"enabled"}` / openai `reasoning_effort` |
| `reasoning_effort` | `str` | `"high"` | 否 | 只允许 `"low"`/`"medium"`/`"high"`（写入时校验，**读取时不校验**） |
| `context_window` | `int` | `125_000` | 否 | 触发 soft/hard compaction 的上下文窗口 |
| `max_output_tokens` | `int` | `384_000` | 否 | ⚠️ **dataclass 默认 384_000，但所有写盘路径默认 128_000**，见 §9.1 |
| `created_at` | `str` | `""` | 否 | 写盘时总是显式赋值，`""` 只对直接构造 dataclass 的调用者可见 |
| `updated_at` | `str` | `""` | 否 | 同上 |

### 2.3 `Conversation` — `models.py:29-41`

| 字段 | 类型 | 默认 | 可选 | 语义 |
|---|---|---|---|---|
| `id` | `str` | 无 | 否 | UUID4 |
| `title` | `str` | 无 | 否 | 创建时必填、非空白（`ValueError("Conversation title is required")`） |
| `total_output_tokens` | `int` | `0` | 否 | 累计 output token（跨 turn 累加，见 §9.6） |
| `last_input_tokens` | `int` | `0` | 否 | **最后一次** turn 的 input token（不是累加） |
| `compacted_message_count` | `int` | `0` | 否 | 被 autocompact 摘要掉的消息条数（**覆盖写，非累加**，`compact.py:299-303`） |
| `current_turn` | `int` | `0` | 否 | turn 计数器；`increment_turn` 每次 +1 并返回新值 |
| `status` | `str` | `"active"` | 否 | 自由字符串；代码里只有 `"active"` 会被写入，从未被修改过 |
| `parent_conversation_id` | `str` | `""` | 否 | 非空 ⇒ 这是子代理会话；`""` ⇒ 主会话 |
| `agent_type` | `str` | `""` | 否 | 子代理类型名（`SubAgentDefinition.name`）；主会话为 `""` |
| `created_at` | `str` | `""` | 否 | 同 §2.1 |
| `updated_at` | `str` | `""` | 否 | 同 §2.1 |

**注意**：`Conversation` 没有 `workspace` / `cwd` 字段。workspace 是从 `AppPaths.project_dir.parent` 反推的（`app.py:372,854,1134,1701`）。

### 2.4 `Message` — `models.py:44-55`

| 字段 | 类型 | 默认 | 可选 | 语义 |
|---|---|---|---|---|
| `id` | `str` | 无 | 否 | UUID4 |
| `conversation_id` | `str` | 无 | 否 | 外键 → `Conversation.id` |
| `role` | `str` | 无 | 否 | 只能是 `"system"`/`"user"`/`"assistant"`/`"tool"`（§3.2） |
| `content` | `str` | 无 | 否 | **可以是纯文本，也可以是 JSON 字符串**——这是本层最核心的设计（§6） |
| `created_at` | `str` | 无 | 否 | 同 §2.1；排序键（`list_messages` 按此升序） |
| `turn_id` | `str` | `""` | 否 | 形如 `turn_{n}_{conversation_id[:8]}`（`query_engine.py:108`）或 `subagent_turn_{n}_{conversation_id[:8]}`（`subagents/executor.py:79`） |
| `subtype` | `str` | `"normal"` | 否 | 见 §5.1 的完整取值表 |
| `tool_call_id` | `str \| None` | `None` | **是** | 工具结果的 `tool_use_id`；非 tool 消息为 `None` |
| `meta` | `str` | `"{}"` | 否 | JSON 字符串；tool_result 的元数据（§5.3） |
| `agent_type` | `str` | `""` | 否 | 子代理消息标记；主代理为 `""` |

### 2.5 `TurnResult` — `models.py:58-70`

**不持久化**，只在内存中从 `QueryEngine` 传回 TUI 与 observability。

| 字段 | 类型 | 默认 | 语义 |
|---|---|---|---|
| `turn_id` | `str` | 无 | 与 `Message.turn_id` 同源 |
| `status` | `str` | 无 | 注释枚举（`models.py:61`）：`"completed" \| "error" \| "cancelled" \| "max_rounds"` |
| `final_text` | `str` | `""` | 最后一轮的 assistant 文本 |
| `tool_rounds` | `int` | `0` | 实际发生的工具调用轮数 |
| `input_tokens` | `int` | `0` | 本 turn 的 input token |
| `output_tokens` | `int` | `0` | 本 turn 的 output token |
| `error` | `str \| None` | `None` | 错误文本 |
| `num_turns` | `int` | `0` | LLM 往返次数 |
| `max_turns` | `int` | `0` | 本 turn 的最终轮数上限（含 auto-continue 追加，`query_engine.py:359`） |
| `terminal_reason` | `str \| None` | `None` | 终态原因字符串 |
| `last_tool_error` | `str \| None` | `None` | 最后一个失败工具的 error_code |

### 2.6 `SessionConfigSnapshot` — `models.py:73-81`

| 字段 | 类型 | 默认 |
|---|---|---|
| `model_name` | `str` | 无 |
| `channel_name` | `str` | 无 |
| `provider_type` | `str` | 无 |
| `thinking_enabled` | `bool` | `True` |
| `reasoning_effort` | `str` | `"high"` |
| `context_window` | `int` | `125_000` |
| `max_tool_rounds` | `int` | `10` |

> ⚠️ **死代码**：全仓库（`src/`、`tests/`）**没有任何地方引用 `SessionConfigSnapshot`**（`grep -rn "SessionConfigSnapshot" src/ tests/` 只命中定义处 `models.py:74`）。复刻时可实现但标注为未使用。

### 2.7 `ProviderPreset` — `storage.py:20-28`（在本层，但属于配置而不是持久化模型）

| 字段 | 类型 | 默认 |
|---|---|---|
| `id` | `str` | 无 |
| `name` | `str` | 无 |
| `provider_type` | `str` | 无 |
| `base_url` | `str \| None` | 无 |
| `model_names` | `tuple[str, ...]` | 无 |
| `context_window` | `int` | `125_000` |
| `max_output_tokens` | `int` | `128_000` |

### 2.8 `AppPaths` — `paths.py:5-10`

| 字段 | 类型 |
|---|---|
| `global_dir` | `Path` |
| `project_dir` | `Path` |
| `config_path` | `Path` |
| `chat_path` | `Path` |

### 2.9 关于 `Todo` 与 `Turn`（**文档纠偏**）

**不存在 `Todo` dataclass，也不存在 `Turn` dataclass，也不存在 `turns` 持久化键。**
- Todo 只活在 `ToolContext.turn_state["todos"]`（内存 dict，`src/flyinchat/tools/plan_tools.py:66`），其元素结构是 `{"content": str, "status": "pending"|"in_progress"|"completed"}`（schema 在 `plan_tools.py:18-42`）。**todo 不落盘**，重启即丢。
- 任务书提到的 "turns" 在磁盘上不存在；turn 只体现为 `Conversation.current_turn`（计数器）与 `Message.turn_id`（分组键）。

---

## 3. 枚举与常量（原样抄录）

`storage.py:15-18`：
```python
_PROVIDER_TYPES = frozenset({"openai_compatible", "anthropic"})
_MESSAGE_ROLES = frozenset({"system", "user", "assistant", "tool"})
_SCHEMA_VERSION = 1
```

### 3.1 Provider presets — `storage.py:31-41`（**全文抄录**）
```python
PROVIDER_PRESETS = {
    "deepseek": ProviderPreset(
        id="deepseek",
        name="DeepSeek",
        provider_type="anthropic",
        base_url="https://api.deepseek.com/anthropic",
        model_names=("deepseek-v4-pro", "deepseek-v4-flash"),
        context_window=1_000_000,
        max_output_tokens=128_000,
    )
}
```
（`PROVIDER_PRESETS` 是唯一 preset；TUI 的 `/api` 表单用它的 `name` 与 `model_names`。）

### 3.2 reasoning effort 合法值 — `storage.py:296`
```python
if effort not in ("low", "medium", "high"):
    raise ValueError(f"Invalid reasoning effort: {effort}. Must be low, medium, or high.")
```

### 3.3 message_utils 常量 — `message_utils.py:6-7`
```python
_MAX_RESULT_CHARS = 8000
_MAX_RESULT_LINES = 15
```

### 3.4 其它散落的魔法字符串（复刻时需保留语义）

| 值 | 位置 | 含义 |
|---|---|---|
| `"permission_event"`, `"skill_event"` | `message_utils.py:27` | 不发送给模型的 subtype 集合 |
| `"compact_boundary"` / `"compact_summary"` | `message_utils.py:40,42`；`storage.py:561,566,578,583`；`compact.py:264,286` | 压缩协议标记（§5） |
| `"tool_use_id"` 键的存在 | `message_utils.py:34,63`；`compact.py:201`；`storage.py` 无 | 判定"这是一条 tool_result"的哨兵 |
| `"Interrupted"` | `message_utils.py:21` | 修补连续 user 消息时插入的占位 assistant 文本 |
| `"[Interrupted]"` | `query_engine.py:373` | 取消时写入的 assistant 消息 content |
| `"[truncated {n} chars]"` | `compact.py:211` | 工具结果截断标记 |
| `"[truncated]"` | `message_utils.py:220` | 显示层截断标记（不同！） |
| `"(empty)"` | `message_utils.py:217` | 显示空内容 |
| `"(empty list)"` | `plan_tools.py:77` | todo 空列表 |
| `"autocompact_v1"` | `compact.py:272` | boundary strategy 值 |
| `"tool_result_budget"` | `compact.py:236` | 软截断 strategy 值 |
| `"reactive"` | `query_engine.py:548,581,590` | 事件里的 strategy 标签（不写盘） |

---

## 4. 磁盘 JSON 持久化格式（**逐字节精确**）

### 4.1 写入器实现 — `storage.py:644-651`（**全文抄录**）

```python
def _write_json(path: Path, store: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
    temp_path.write_text(
        json.dumps(store, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    os.replace(temp_path, path)
```

原子写入要点（复刻必须一致）：
1. 先 `mkdir -p` 父目录（`parents=True, exist_ok=True`）。
2. 临时文件名格式：`.<文件名>.<32位hex uuid>.tmp`，**与目标同目录**（保证 `os.replace` 同文件系统，是原子的）。
3. 编码 `utf-8`，`ensure_ascii=False`（中文/emoji 原样写入，不转 `\uXXXX`）。
4. `indent=2`，**末尾追加一个 `\n`**。
5. `os.replace` 覆盖目标（POSIX 原子；Windows 上也可覆盖）。
6. **不 fsync、不 fsync 目录、无文件锁、无重试**。崩溃可能留下孤儿 `.tmp` 文件（永远不会被清理）。
7. **每次写调用都重读整个文件、重建整个 dict、全量写回**。没有任何增量写。

### 4.2 读取器 + 容错 — `storage.py:632-641`（**全文抄录**）

```python
def _load_json(path: Path, default_factory) -> dict[str, Any]:
    if not path.exists():
        return default_factory()
    text = path.read_text(encoding="utf-8")
    if not text.strip():
        return default_factory()
    data = json.loads(text)
    if not isinstance(data, dict):
        raise ValueError(f"Invalid storage file: {path}")
    return data
```

实测容错行为：
- 文件不存在 → 默认空 store（**不报错**）。
- 文件存在但只有空白 → 默认空 store（**不报错**）。
- 文件内容是合法 JSON 但根不是 object（如 `[1,2]`）→ `ValueError: Invalid storage file: <path>`。
- 文件内容不是合法 JSON → `json.JSONDecodeError` **直接冒泡**（未捕获）。
- **没有备份、没有损坏恢复**。

### 4.3 `~/.flyinchat/config.json` — 完整骨架

`_default_config_store()` — `storage.py:654-660`（写盘时基线）：
```python
{
    "schema_version": 1,
    "llm_channels": [],
    "llm_models": [],
    "app_settings": {},
}
```

`_load_config_store()` — `storage.py:609-617`（**读时归一化后的形状，注意多出 `mcp_servers`**）：
```python
{
    "schema_version": int(store.get("schema_version", 1)),
    "llm_channels": [_normalize_channel_dict(row) for row in store.get("llm_channels", [])],
    "llm_models":   [_normalize_model_dict(row)   for row in store.get("llm_models", [])],
    "app_settings": dict(store.get("app_settings", {})),
    "mcp_servers":  list(store.get("mcp_servers", [])),
}
```

实测（运行 `initialize_storage` + `create_channel_with_models` + `set_app_setting("language","zh")` 后的真实内容）：
```json
{
  "schema_version": 1,
  "llm_channels": [
    {
      "id": "b820a1ad-827c-4bb0-8332-9acc4aa358a5",
      "name": "Local",
      "provider_type": "openai_compatible",
      "base_url": "http://localhost:11434/v1",
      "api_key": "k",
      "created_at": "2026-09-13T17:46:49.102Z",
      "updated_at": "2026-09-13T17:46:49.102Z"
    }
  ],
  "llm_models": [
    {
      "id": "3354b56b-7edd-4004-ad8d-41a3d9bfd497",
      "channel_id": "b820a1ad-827c-4bb0-8332-9acc4aa358a5",
      "name": "qwen3",
      "is_default": true,
      "thinking_enabled": true,
      "reasoning_effort": "high",
      "context_window": 125000,
      "max_output_tokens": 128000,
      "created_at": "2026-09-13T17:46:49.102Z",
      "updated_at": "2026-09-13T17:46:49.102Z"
    }
  ],
  "app_settings": {
    "language": "zh"
  },
  "mcp_servers": []
}
```

**重要陷阱**：`initialize_storage` 对**已存在**的 config.json 会调 `_load_config_store` → 归一化 → **把 `mcp_servers` 键注入文件**，而新建文件走 `_default_config_store()` 则**不含 `mcp_servers`**。所以：
- 全新安装的 config.json **没有** `mcp_servers` 键；
- 但用户手工添加过 MCP server（或在有 `mcp_servers` 的文件上启动过第二次）后，该键出现。
下游 `MCPConfig.from_dict` 用 `data.get("mcp_servers", [])` 容忍两种形状。

真实的 `~/.flyinchat/config.json`（本机验证）顶层键顺序：
`["schema_version", "llm_channels", "llm_models", "app_settings", "mcp_servers"]`。
`llm_channels[0]` 的键顺序：`['id','name','provider_type','base_url','api_key','created_at','updated_at']`。

### 4.4 `<workspace>/.flyinchat/chat.json` — 完整骨架

`_default_chat_store()` — `storage.py:663-668`：
```python
{
    "schema_version": 1,
    "conversations": [],
    "messages": [],
}
```

`_load_chat_store()` — `storage.py:620-629`：
```python
{
    "schema_version": int(store.get("schema_version", 1)),
    "conversations": [_normalize_conversation_dict(row) for row in store.get("conversations", [])],
    "messages":      [_normalize_message_dict(row)      for row in store.get("messages", [])],
}
```

实测创建的 conversation + user message：
```json
{
  "schema_version": 1,
  "conversations": [
    {
      "id": "f2f55b50-14e5-4de8-9387-b938e5c67bda",
      "title": "T",
      "total_output_tokens": 0,
      "last_input_tokens": 0,
      "compacted_message_count": 0,
      "current_turn": 0,
      "status": "active",
      "parent_conversation_id": "",
      "agent_type": "",
      "created_at": "2026-09-13T17:46:49.103Z",
      "updated_at": "2026-09-13T17:46:49.103Z"
    }
  ],
  "messages": [
    {
      "id": "efc94a45-ee3f-4068-942f-9d88c2ffc001",
      "conversation_id": "f2f55b50-14e5-4de8-9387-b938e5c67bda",
      "role": "user",
      "content": "hi",
      "created_at": "2026-09-13T17:46:49.103Z",
      "turn_id": "",
      "subtype": "normal",
      "tool_call_id": null,
      "meta": "{}",
      "agent_type": ""
    }
  ]
}
```

**messages 是单一扁平数组**，没有按 conversation 分组、没有索引。所有查询（`list_messages`/`get_turn_messages`/`list_active_messages`）都是 **O(n) 全表扫描**。

### 4.5 content 字段的真实形状（同一数组里混存不同形状）

`Message.content` 是 `str`，但实际有 5 类编码。以下全部为真实产生的 JSON 片段：

**(a) 纯文本**（user / 简单 assistant）
```json
"content": "hi"
```

**(b) assistant 块数组**（有 thinking 或 tool_use 时，`query_engine.py:311-315, 713-731`）
```json
[
  {"type": "thinking", "thinking": "让我想想……", "signature": "EqQBCgIYAh..."},
  {"type": "text", "text": "我来查看文件。"},
  {"type": "tool_use", "id": "toolu_01ABC", "name": "file_read", "input": {"path": "src/a.py"}}
]
```
注意：`thinking` 块**总是**带 `signature` 键（OpenAI 兼容的 reasoning 走 `{"thinking": ..., "signature": ""}`，`query_engine.py:490-492`）。

**(c) tool_result**（`query_engine.py:1167-1186`）
```json
"content": "{\"tool_use_id\": \"toolu_01ABC\", \"content\": \"1|import os\\n2|...\"}"
```
即 `json.dumps({"tool_use_id": str, "content": str})`。`tool_call_id` 字段与内层 `tool_use_id` 相同。

**(d) compact_summary**（`compact.py:263-267`）
```json
"content": "{\"type\": \"compact_summary\", \"summary\": \"<LLM 生成的摘要文本>\", \"summarized_count\": 12}"
```

**(e) compact_boundary**（`compact.py:285-296`）
```json
"content": "{\"type\":\"compact_boundary\",\"boundary_id\":\"<uuid4>\",\"strategy\":\"autocompact_v1\",\"source_range_from\":\"<msg id>\",\"source_range_to\":\"<msg id>\",\"preserved_head_ids\":[\"<id>\",...],\"preserved_tail_id\":\"<id>\",\"summary_msg_id\":\"<id>\",\"tokens_before\":87000,\"tokens_after\":0}"
```

**(f) permission_event / skill_event**（`query_engine.py:1210-1221`, `825`）
```json
"content": "{\"event\": \"permission_request_created\", \"tool_name\": \"bash\", \"risk_level\": \"high\", \"request_id\": \"...\"}"
"content": "{\"event\": \"skill.resolve.complete\", \"applied_skills\": [\"liquid-glass@0.1.0\"], \"confidence\": 1.0, \"active_phase\": \"discover\", \"guards_applied\": []}"
```

**tool_result 的 `meta` 形状**（`query_engine.py:1175-1185`）：
```json
{
  "tool_name": "file_read",
  "ok": true,
  "error_code": null,
  "elapsed_ms": 12,
  "data": {"path": "/workspace/src/example.py", "offset": 1, "returned_lines": 40, "total_lines": 200},
  "skill_guard_id": null,
  "skill_name": null,
  "guard_type": null,
  "guard_reason": null
}
```
子代理版本的 meta 少最后 4 个键（`subagents/executor.py:342-350`）。

### 4.6 `mcp_servers` 元素结构（跨模块，`src/flyinchat/mcp/config.py`）

写入 config.json（用户手写）：
```json
{
  "name": "chrome-devdevtools",
  "command": "npx",
  "args": ["-y", "chrome-devtools-mcp@latest"],
  "transport": "stdio",
  "env": {"KEY": "VALUE"},
  "timeout_seconds": 30
}
```
解析规则（`mcp/config.py:16-33`）：
- `name` 缺失/空 → **整条跳过**（返回 `None`）。
- `command` 缺失/空 → 整条跳过。
- `transport` 默认 `"stdio"`；**任何非 `"stdio"` 值 → 整条跳过**（phase 1 只支持 stdio）。
- `args` 默认 `[]`，`env` 默认 `{}`，`timeout_seconds` 默认 `30`。
- `_load_config_store` **不校验** `mcp_servers` 元素类型；`MCPConfig.from_dict` 对非 dict 元素会在 `item.get` 处 `AttributeError`（未做防御）。

### 4.7 `app_settings`：已知键全集（跨模块）

`app_settings` 是 `dict[str, str]`——**值一定是字符串**（`get_app_setting` 用 `str(value)`，`observability/config.py:80` 用 `str(v)`）。

| 键 | 写入方 | 读取方 | 语义 |
|---|---|---|---|
| `language` | `app.py:882` | `app.py:341`（`get_app_setting`） | `"en"` 或 `"zh"`（`Language` StrEnum 的 value） |
| `langfuse_enabled` | `app.py:899` | `observability/config.py:27` | 布尔串，见下 |
| `langfuse_public_key` | 用户手写 | `observability/config.py:28` | `.strip()` 后使用 |
| `langfuse_secret_key` | 用户手写 | `observability/config.py:29` | `.strip()` 后使用 |
| `langfuse_host` | 用户手写 | `observability/config.py:30` | 默认 `"https://cloud.langfuse.com"` |
| `langfuse_debug` | 用户手写 | `observability/config.py:31` | 布尔串 |
| `agent_env` | 用户手写 | `observability/config.py:32` | 默认 `"development"` |
| `agent_version` | 用户手写 | `observability/config.py:33` | 默认 `"local"` |

布尔解析规则（`observability/config.py:83-87`，**复刻必须照抄**）：
```python
raw.strip().lower() in {"1", "true", "yes", "on", "y"}
```
即 `"yes"`/`"y"`/`"on"`/`"1"` 都算真；`"false"`/`"0"`/`"no"` 算假；缺键用 `default`。

Langfuse 的启用判定是个**三段短路**（`observability/config.py:35-67`）：
1. `langfuse_enabled` 为假 → `enabled=False, disabled_reason="langfuse_enabled is false"`（keys 原样保留）。
2. 否则若 public/secret key 任一为空 → `enabled=False, disabled_reason="Langfuse keys are missing"`，且 **public_key/secret_key 被清成 `""`**（与分支 1 不同！）。
3. 否则 `enabled=True`。

`ObservabilityConfig.from_config_store` 对文件缺失/JSON 损坏/`app_settings` 非 dict 全部静默返回 `{}`（`observability/config.py:70-80`），与 `storage._load_json` 的严格行为不同。

**配置路径不一致（坑）**：`app.py:351-353` 显式传 `config_path=self.paths.config_path`，但 `observability/client.py:371` 的兜底默认是硬编码 `Path("~/.flyinchat/config.json").expanduser()`——绕过 `resolve_app_paths`，忽略注入的 `home`。

### 4.8 `chat.json` 里**没有**的东西

- 没有 `turns` 数组（只有 `Conversation.current_turn` 计数）。
- 没有 compaction boundary 的独立存储：**boundary 就是一条普通 system 消息**，插在 `messages` 数组中间。
- 没有 subagent conversation 的独立数组：**就是 `conversations` 里 `parent_conversation_id != ""` 的行**。
- 没有 soft-delete / tombstone：`update_message_content` 是真·原地改；没有删除任何消息的公开函数。
- 没有 `workspace` 字段。

### 4.9 版本迁移 / 默认值填充

**没有真正的版本迁移器。** `schema_version` 只是被读出来、被强制写成 `1`（`storage.py:612,623`；`_default_*_store` 里也是 `1`）。没有任何 `if version < N: migrate()` 逻辑。**任何 >1 的版本号会在下次写入时被静默降为 1。**

"迁移"实际上只是**字段级默认值填充**，由 4 个归一化函数完成（`storage.py:785-844`）。全部行为如下。

`_normalize_channel_dict` — `storage.py:785-795`：
```python
{
    "id": str(row["id"]),                        # 必需，缺失 → KeyError
    "name": str(row["name"]),                    # 必需，缺失 → KeyError
    "provider_type": str(row["provider_type"]),  # 必需，缺失 → KeyError
    "base_url": row.get("base_url"),             # 缺失 → None（唯一允许 None 的键）
    "api_key": str(row["api_key"]),              # 必需，缺失 → KeyError
    "created_at": str(row.get("created_at") or now),  # falsy → 当前时间
    "updated_at": str(row.get("updated_at") or now),  # falsy → 当前时间
}
```

`_normalize_model_dict` — `storage.py:798-811`：
```python
{
    "id": str(row["id"]),                                  # 必需
    "channel_id": str(row["channel_id"]),                  # 必需
    "name": str(row["name"]),                              # 必需
    "is_default": bool(row.get("is_default", False)),      # 缺失 → False
    "thinking_enabled": bool(row.get("thinking_enabled", True)),  # 缺失 → True
    "reasoning_effort": str(row.get("reasoning_effort") or "high"),
    "context_window": int(row.get("context_window") or 125_000),
    "max_output_tokens": int(row.get("max_output_tokens") or 128_000),
    "created_at": str(row.get("created_at") or now),
    "updated_at": str(row.get("updated_at") or now),
}
```

`_normalize_conversation_dict` — `storage.py:814-828`：
```python
{
    "id": str(row["id"]),                                                  # 必需
    "title": str(row["title"]),                                            # 必需
    "total_output_tokens": int(row.get("total_output_tokens") or 0),
    "last_input_tokens": int(row.get("last_input_tokens") or 0),
    "compacted_message_count": int(row.get("compacted_message_count") or 0),
    "current_turn": int(row.get("current_turn") or 0),
    "status": str(row.get("status") or "active"),
    "parent_conversation_id": str(row.get("parent_conversation_id") or ""),  # ← 旧库无此列
    "agent_type": str(row.get("agent_type") or ""),                          # ← 旧库无此列
    "created_at": str(row.get("created_at") or now),
    "updated_at": str(row.get("updated_at") or now),
}
```

`_normalize_message_dict` — `storage.py:831-844`：
```python
{
    "id": str(row["id"]),                                  # 必需
    "conversation_id": str(row["conversation_id"]),        # 必需
    "role": str(row["role"]),                              # 必需
    "content": str(row["content"]),                        # 必需
    "created_at": str(row.get("created_at") or now),
    "turn_id": str(row.get("turn_id") or ""),
    "subtype": str(row.get("subtype") or "normal"),
    "tool_call_id": row.get("tool_call_id"),               # 缺失 → None
    "meta": str(row.get("meta") or "{}"),
    "agent_type": str(row.get("agent_type") or ""),         # ← 旧库无此列
}
```

**归一化语义总结（复刻必须等价）**：
- 用 `or` 而非 `if is None`：**`0`/`""`/`False`/`None` 全部走默认值**。因此 `current_turn: 0` 每次启动都会被"重新默认"为 `0`（无害），但 `total_output_tokens: 0` 同理（也无害）。真正有害的是**任何被显式设为 falsy 的字段都会被覆盖**。
- `bool(row.get("is_default", False))` 对 JSON 里的整数 `0`/`1` 正确工作（旧 SQLite 迁移来的行就是 int）。
- `int(...)` 对字符串数字也有效（`int("125000")` → `125000`）。
- 未知键被**丢弃**（因为它们不在返回的 dict 里）。

### 4.10 旧 SQLite 迁移

触发条件（`storage.py:51-74`）：目标 JSON 文件**不存在**，且同目录存在同名 `.sqlite`。
- `config.json` 不存在 → 找 `config.sqlite`（`path.with_name("config.sqlite")`）。
- `chat.json` 不存在 → 找 `chat.sqlite`。
- **JSON 存在就完全不看 SQLite**（无合并、无增量迁移）。迁移后 **`.sqlite` 文件不删除**（`~/.flyinchat/config.sqlite` 会永久留在磁盘上——本机实测确实存在）。

`_migrate_config_store` — `storage.py:671-691`：
```python
# 读取表 llm_channels, llm_models, app_settings
settings = {
    str(row.get("key", "")): str(row.get("value", ""))
    for row in _fetch_sqlite_rows(connection, "app_settings")
    if row.get("key") is not None
}
# 返回 {"schema_version":1, "llm_channels":[...], "llm_models":[...], "app_settings":{...}}
# 注意：不读 mcp_servers（SQLite 时代没有），所以迁移结果里没有该键
```

`_migrate_chat_store` — `storage.py:694-708`：读 `conversations` 与 `messages` 两表。

`_fetch_sqlite_rows` — `storage.py:717-725`：
```python
exists = connection.execute(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
    (table,),
).fetchone()
if exists is None:
    return []                      # 表不存在 → 空列表，不报错
rows = connection.execute(f"SELECT * FROM {table}").fetchall()
return [dict(row) for row in rows]
```
- 用 `sqlite3.connect(path)` + `row_factory = sqlite3.Row`（`_connect_sqlite`, `storage.py:711-714`），并把它当 context manager 用（`with _connect_sqlite(...)` → 只 commit/rollback，**不 close**；进程退出时由 GC 关闭）。
- 表名是**字符串插入**（`f"SELECT * FROM {table}"`），但 `table` 只来自代码内硬编码的 4 个名字，非用户输入。
- 迁移后不做任何校验（不检查 column 是否齐全）；缺列的行会在归一化时 `KeyError`。
- 实际旧 schema（由 `tests/test_storage.py:316-413` 定义）**没有** `max_output_tokens`、`parent_conversation_id`、`agent_type` 列——正是 §4.9 中 `row.get(...)` 存在的原因：`_model_from_dict` 的 `row.get("max_output_tokens", 384_000)`（`storage.py:868`）就是为旧行准备的，但注意 `_normalize_model_dict` 已经先把它填成 `128_000` 了，所以 `_model_from_dict` 的 384_000 分支**永远走不到**（§9.1）。

---

## 5. 压缩协议与 compaction boundary

### 5.1 `Message.subtype` 完整取值表（全仓库 grep 结果）

| subtype | role | 写入方 | 语义 |
|---|---|---|---|
| `"normal"` | user/assistant/system | 多处 | 默认值；普通消息 |
| `"tool_call"` | assistant | `query_engine.py:729`，`subagents/executor.py:196` | content 是含 `tool_use` 的块数组 |
| `"tool_result"` | tool | `query_engine.py:872,1172`，`subagents/executor.py:339` | content 是 `{"tool_use_id","content"}` |
| `"interrupted"` | assistant | `query_engine.py:372` | 取消时写 `"[Interrupted]"` |
| `"skill_event"` | system | `query_engine.py:825` | content 是 `{"event":"skill.resolve.complete",...}`；**不发给模型** |
| `"permission_event"` | system | `query_engine.py:1219` | content 是 `{"event": ...}` 权限审计；**不发给模型** |
| `"compact_boundary"` | system | `compact.py` 经 `add_message`（role=`"system"`，**subtype 未显式传**，故实际写盘是 `"normal"`） | 见 §9.2 |

### 5.2 boundary 的检测：`list_active_messages` — `storage.py:557-588`（**全文抄录**）

```python
def list_active_messages(chat_path: Path, *, conversation_id: str) -> list[Message]:
    all_msgs = list_messages(chat_path, conversation_id=conversation_id)
    boundary_idx: int | None = None
    for index, msg in enumerate(all_msgs):
        if msg.subtype == "compact_boundary":
            boundary_idx = index
            break
        try:
            parsed = json.loads(msg.content)
            if isinstance(parsed, dict) and parsed.get("type") == "compact_boundary":
                boundary_idx = index
                break
        except (json.JSONDecodeError, TypeError):
            pass

    if boundary_idx is None:
        return all_msgs

    start = boundary_idx
    if start > 0:
        prev = all_msgs[start - 1]
        if prev.subtype == "compact_summary":
            start = boundary_idx - 1
        else:
            try:
                parsed = json.loads(prev.content)
                if isinstance(parsed, dict) and parsed.get("type") == "compact_summary":
                    start = boundary_idx - 1
            except (json.JSONDecodeError, TypeError):
                pass

    return all_msgs[start:]
```

精确语义（复刻必须逐条等价）：

1. 先取该 conversation 的全部消息，按 `created_at` 升序（`list_messages` 已排序）。
2. **从头线性扫描找"第一个"匹配项**——不是最后一个！所以**多次压缩后，只有第一次的 boundary 生效**（`break` 在首次命中）。
3. 匹配条件二选一：
   a. `msg.subtype == "compact_boundary"`（字符串 subtype）；
   b. `json.loads(msg.content)` 得到 dict 且 `parsed.get("type") == "compact_boundary"`。
   JSON 解析失败（`JSONDecodeError` / `TypeError`）**静默跳过**。注意裸 `str` 的 content 会先被 `json.loads` 处理：`json.loads("hi")` 抛 JSONDecodeError → 跳过；但 `json.loads("123")` 返回 `int` → `isinstance(parsed, dict)` 为假 → 跳过。**任何能解析成 dict 的消息都会被检查 `type` 键**，包括 tool_result（其 dict 没有 `type` 键 → `get` 返回 None → 不匹配）。
4. 找到 boundary 于索引 `i` 后，检查 `i-1`：若它（同样双条件）是 `compact_summary`，起点前移到 `i-1`，**使摘要消息留在活跃集内**（这样它才能被 `message_to_api_format` 转成 system 消息喂给模型）。
5. 返回 `all_msgs[start:]`——**boundary 本身也在活跃集里**（虽然它转 API 时返回 `None` 被过滤掉）。

**边界条件（实测确认）**：
- **boundary 在第 0 位**：`start=0`，`start > 0` 为假 → 不检查前一条 → 返回全部（等于没压缩）。这是"空会话压缩"的病态情形。
- **只有 compact_summary、没有 boundary**（例如崩溃在两步之间）：`boundary_idx is None` → **返回全部消息，一条都不裁** → 摘要会被当作 system 消息重复注入。实测：
  ```
  orphan-summary case: [('system','normal','{"type": "compact_summary", "s'),
                         ('user','normal','after')]
  ```
- **boundary 是首条 + 前一条是 summary**：不可能同时成立。
- **多次压缩**：第二次及以后的 boundary 被忽略；`start` 仍是第一次的 boundary − 1。第二次压缩后 summary/boundary 会插在数组更靠后的位置，但它们**已经在活跃窗口内**，所以第二次的 summary 仍是活跃的 system 消息（因为它在第一次 boundary 之后）。**但 `preserved_*` 元数据不被 `list_active_messages` 使用**——只被 UI/审计读取。
- `list_active_messages` **不做去重**：如果同一会话被压缩两次，会有两条 summary 都留在活跃窗口（第二条在窗口内），两条都会被转成 system 消息，最终在 `query_engine.py:1264-1272` 的 `_extract_compact_summary` 里被 `"\n\n".join` 拼接，再作为 `compact_summary=` 参数喂给 `assemble_system_prompt`。

### 5.3 谁用 `list_active_messages`，谁用 `list_messages`

| 调用点 | 用哪个 | 原因 |
|---|---|---|
| `query_engine.py:199`（每 turn 组装 API 消息） | `list_active_messages` | 只喂活跃窗口 |
| `query_engine.py:550`（reactive compact） | `list_messages` | 需要全量以便重新切分 |
| `compact.py:229,305,332` | `list_messages` | 压缩引擎操作全量 |
| `app.py:554,771,2365,2383` | `list_messages` | TUI 历史渲染 **显示全部消息（含被压缩掉的）** |
| `subagents/executor.py` | `list_messages` | 子代理不过压缩 |

**因此：被压缩掉的消息仍然显示在 TUI 里**——这是有意设计（保留完整审计轨迹），复刻时必须一致。

### 5.4 压缩的落盘副作用

`compact.py:259-303`（`_autocompact`）按顺序做 4 次**独立**的全量写盘（非事务！）：
1. `add_message(role="system", content=compact_summary JSON)`。
2. `add_message(role="system", content=compact_boundary JSON)`。
3. `update_conversation_compacted_count(count=len(summarize_msgs))` —— **覆盖写，不是累加**。
4. `list_messages(...)` 重读全量，算 `tokens_after`。

**崩溃点分析**：若在 1 与 2 之间崩溃 → 产生 §5.2 的孤儿 summary 情形（活跃窗口不裁剪）。若在 2 与 3 之间 → boundary 已生效但 `compacted_message_count` 未更新（仅影响 UI 显示）。

`CompactMetadata`（`compact.py:31-42`）字段：`boundary_id, strategy, source_range_from, source_range_to, preserved_head_ids: tuple[str,...], preserved_tail_id, summary_msg_id, tokens_before, tokens_after`。注意 `metadata.tokens_after` **恒为 0**（`compact.py:279` 写 `tokens_after=0`），真实值只在 `CompactionOutput` 里。

---

## 6. `message_utils.py` 转换逻辑（逐条规则）

### 6.1 `message_to_api_format(msg: Message) -> dict | None` — `message_utils.py:26-46`（**全文抄录 + 分支表**）

```python
def message_to_api_format(msg: Message) -> dict | None:
    if msg.subtype in {"permission_event", "skill_event"}:
        return None
    try:
        parsed = json.loads(msg.content)
        if isinstance(parsed, list):
            return {"role": msg.role, "content": parsed}
        if isinstance(parsed, dict):
            if "tool_use_id" in parsed:
                return {
                    "role": "tool",
                    "tool_use_id": parsed["tool_use_id"],
                    "content": parsed["content"],
                }
            if parsed.get("type") == "compact_boundary":
                return None
            if parsed.get("type") == "compact_summary":
                return {"role": "system", "content": parsed.get("summary", "")}
    except (json.JSONDecodeError, TypeError):
        pass
    return {"role": msg.role, "content": msg.content}
```

**决策表（顺序敏感，先命中先返回）**：

| # | 条件 | 返回 |
|---|---|---|
| 1 | `subtype ∈ {"permission_event", "skill_event"}` | `None`（丢弃） |
| 2 | `json.loads(content)` 得到 **list** | `{"role": msg.role, "content": <该 list>}` —— role 原样保留（通常是 `"assistant"`） |
| 3 | 解析得到 dict 且 **含键 `"tool_use_id"`** | `{"role": "tool", "tool_use_id": ..., "content": ...}` —— **role 被强制改写为 `"tool"`**，即使原 role 不是 tool |
| 4 | dict 且 `type == "compact_boundary"` | `None`（丢弃；boundary 是纯审计标记） |
| 5 | dict 且 `type == "compact_summary"` | `{"role": "system", "content": parsed.get("summary", "")}` —— role 强制改写为 `"system"`，且只取 `summary` 字段 |
| 6 | 上述都不匹配 | `{"role": msg.role, "content": msg.content}`（content 保持原始字符串） |
| 7 | `json.loads` 抛 `JSONDecodeError`/`TypeError` | 落到 #6 |
| 8 | 解析得到 dict 但**没有**以上的键（如 `{"event": ...}` 的 permission_event —— 已被 #1 拦掉；或任意其它 dict） | 落到 #6 → **整个 JSON 字符串原样作为 content 发给模型** |

**关键陷阱**：
- `parsed["content"]` 在 #3 用**下标**而非 `.get` → 含 `tool_use_id` 但**缺 `content`** 的 dict 会 `KeyError`（未被 `except` 捕获，因为 `except` 只捕获 `JSONDecodeError`/`TypeError`）。实际上 `KeyError` 是 `LookupError` 的子类，**不是** `TypeError`，所以会冒泡。
- #3 的判定用 `"tool_use_id" in parsed`（键存在），因此 `{"tool_use_id": null}` 也会命中。
- boundary（#4）与 summary（#5）的判定用 `parsed.get("type")`，而 `list_active_messages`（§5.2）同时接受 `subtype` 字符串与 JSON `type`——**两处判定不一致**：一条 `subtype="compact_boundary"` 但 content 是纯文本的 boundary 会被 `list_active_messages` 认作边界（裁剪生效），但 `message_to_api_format` **不会**丢弃它，而是走 #6 把纯文本发给模型。
- #2 与 #6 对 `role` 的处理不同：#2 保留 `msg.role`，但两者都不会把 `system` 之外的 role 改写成 system。

### 6.2 `sanitize_api_messages(messages: list[dict]) -> list[dict]` — `message_utils.py:10-23`（**全文抄录**）

```python
def sanitize_api_messages(messages: list[dict]) -> list[dict]:
    """Insert placeholder assistant messages between consecutive user messages.

    This recovers from crashes or cancellations that leave orphaned user
    messages in the database, ensuring valid role alternation for the API.
    """
    if not messages:
        return messages
    cleaned: list[dict] = []
    for msg in messages:
        if cleaned and msg.get("role") == "user" and cleaned[-1].get("role") == "user":
            cleaned.append({"role": "assistant", "content": "[Interrupted]"})
        cleaned.append(msg)
    return cleaned
```

规则：
- 空列表原样返回（**同一个对象**，非拷贝）。
- 单遍线性扫描；只看 `role`，**完全不看 content/subtype**。
- **只处理"连续 user"**。注意 `message_to_api_format` 的 #3 会把 tool_result 改写成 `role="tool"`，所以"user → tool → user"**不会**被修补（相邻判断只看 `cleaned[-1]`）。
- 插入的占位在**后一条 user 之前**，内容是字面量 `"[Interrupted]"`。
- **非用户相邻问题不修复**（如 `assistant` 紧跟 `assistant`）。
- Anthropic 路径下还会再经过 `_convert_messages_for_anthropic`（`api_client.py:251-282`）把所有 tool 消息缓冲成 `role="user"` 的 tool_result 块数组，因此 `sanitize_api_messages` 必须在**转换前**（对内部格式）调用——`query_engine.py:208` 确实在转换前调用。

### 6.3 `message_to_display(msg: Message) -> str` — `message_utils.py:49-67`（**全文抄录**）

```python
def message_to_display(msg: Message) -> str:
    try:
        parsed = json.loads(msg.content)
        if isinstance(parsed, list):
            return _format_assistant_blocks(parsed)
        if isinstance(parsed, dict):
            if parsed.get("event") == "skill.resolve.complete":
                return _format_skill_event(parsed)
            if "event" in parsed:
                return _format_permission_event(parsed)
            if parsed.get("type") == "compact_boundary":
                return _format_compact_boundary(parsed)
            if parsed.get("type") == "compact_summary":
                return _format_compact_summary(parsed)
            if "tool_use_id" in parsed:
                return _format_tool_result(msg, parsed)
    except (json.JSONDecodeError, TypeError):
        pass
    return msg.content
```

**决策表（顺序敏感）**：

| # | 条件 | 渲染函数 |
|---|---|---|
| 1 | list | `_format_assistant_blocks` |
| 2 | dict 且 `event == "skill.resolve.complete"` | `_format_skill_event` |
| 3 | dict 且**含 `"event"` 键**（任意值） | `_format_permission_event` |
| 4 | dict 且 `type == "compact_boundary"` | `_format_compact_boundary` |
| 5 | dict 且 `type == "compact_summary"` | `_format_compact_summary` |
| 6 | dict 且含 `"tool_use_id"` | `_format_tool_result` |
| 7 | 其它（含解析失败） | 返回 `msg.content` 原文 |

**与 API 路径的关键差异**：`message_to_display` **不丢弃任何消息**——permission_event / skill_event / compact_boundary 都有专门的显示渲染（API 路径丢弃它们）。这是"UI 展示完整审计轨迹"的设计。

### 6.4 `_format_assistant_blocks(blocks)` — `message_utils.py:77-92`

遍历块数组，按 `block["type"]`（**下标，缺键会 KeyError**）分派：

| block type | 输出 |
|---|---|
| `"thinking"` | `"\n\n💭 **thinking**\n```\n{preview}\n```\n"`，其中 `preview = thinking[:200] + "..."` 若 `len > 200`，否则全文 |
| `"text"` | `block["text"]` 原样追加 |
| `"tool_use"` | `_format_tool_use_block(block)` |
| 其它 | **静默跳过**（无 else 分支） |

结果用 `"".join(parts)` 拼接（**无分隔符**）。

### 6.5 `_format_tool_use_block` / `_format_tool_use_input` — `message_utils.py:239-264`

```
\n\n🔧 **{name}**\n
```
`name = block.get("name", "unknown")`，`tool_input = block.get("input", {})`。
然后对 `tool_input.items()` **按插入顺序**逐键输出：
- `str` 且 `len <= 120` 且无换行 → `- **{key}**: \`{value}\``
- `str` 其它 → `- **{key}**:\n\`\`\`\n{value[:500]}{"..." if len>500 else ""}\n\`\`\``
- `bool` → `- **{key}**: \`true\`` / `\`false\``（**在 int 之前判断**，因为 Python 里 `bool` 是 `int` 子类）
- `int`/`float` → `- **{key}**: \`{value}\``
- `None` → `- **{key}**: \`null\``
- 其它（dict/list）→ `- **{key}**: \`{json.dumps(value)}\``

### 6.6 `_format_tool_result(msg, parsed)` — `message_utils.py:112-141`（**最重要的显示分支**）

先解析 `msg.meta`（`_parse_meta`，`message_utils.py:70-74`，失败返回 `{}`）：
```python
tool_name = meta.get("tool_name", "")
ok = meta.get("ok", True)          # 默认 True！
error_code = meta.get("error_code")
elapsed_ms = meta.get("elapsed_ms", 0)
```
状态行：`status_icon = "✅" if ok else "❌"` →
```
\n\n{icon} **{tool_name}**
```
再按需追加：
- `if elapsed_ms:` → ` _({elapsed_ms}ms)_`（**falsy 的 0 不显示**）
- `if not ok and error_code:` → ` — \`{error_code}\``

然后按 `tool_name` **精确字符串匹配**分派（仅当 `ok` 为真，除最后一个分支）：

| tool_name | 渲染 |
|---|---|
| `"file_read"` | `_format_file_read_result(meta)` |
| `"web_fetch"` | `_format_web_fetch_result(meta, content)` |
| `"grep"` | `_format_grep_result(meta, content)` |
| `"glob"` | `_format_glob_result(meta, content)` |
| `"file_edit"` | `_format_file_edit_result(meta)` |
| 其它 / `ok` 为假 | `_format_result_content(content)` |

`content = parsed.get("content", "")`。

#### `_format_file_read_result(meta)` — `message_utils.py:144-162`
**故意不显示文件内容**（测试 `tests/test_message_utils.py:18-38` 断言 `"secret = 'hidden'" not in display`）。
```
File: **{Path(path).name}**
`{path}`
Lines {offset}-{end_line} of {total_lines}
```
- `path = str(data.get("path") or "")`；`filename = Path(path).name if path else "file"`。
- 第二行仅在 `path` 非空时输出。
- 第三行仅在 `offset`、`returned_lines`、`total_lines` **三者都是 int** 时输出，`end_line = max(offset, offset + returned_lines - 1)`。

#### `_format_web_fetch_result(meta, content)` — `message_utils.py:165-172`
```
Fetched: `{url}`
Size: {content_length:,} chars

Content is available in conversation context.
```
+ 代码块，preview 取 `content[:300]` 加 `"..."`。
- `url = data.get("url", "unknown URL")`
- `content_length = data.get("content_length", len(content))`（**默认值是运行时算的**）
- 注意 `{content_length:,}` 会**对非 int 抛 ValueError**（若 meta 里存了字符串）。

#### `_format_grep_result(meta, content)` — `message_utils.py:175-187`
```
{matches} matches across {files} files
```
+ 代码块，preview = `content.splitlines()` 中**非空且不以 `---` 开头**的前 6 行 join。
- `matches = data.get("matches", 0)`，`files = data.get("files", 0)`。
- `if len(preview_lines) < matches:` → 追加 `"\n... (results in context)"`。

#### `_format_glob_result(meta, content)` — `message_utils.py:190-201`
```
{matches} files
```
+ 代码块，preview = 非空行的前 8 行。同样的 `< matches` 尾巴逻辑。

#### `_format_file_edit_result(meta)` — `message_utils.py:204-212`
- `changes` 为真 → `` `{path}` — {changes} replacement(s) ``
- 否则 → `` `{path}` — no changes ``

#### `_format_result_content(content)` — `message_utils.py:215-236`（**通用回退**）
1. `if not content.strip():` → 返回 `"```\n(empty)\n```"`（**无语言标记**）。
2. `if len(content) > 8000:` → `content = content[:8000] + "\n... [truncated]"`。
3. 尝试 `json.loads(content)`：成功 → `lang="json"`, `formatted = json.dumps(structured, indent=2)`（**重新格式化，会改变空白**）；失败（`JSONDecodeError`/`TypeError`）→ `lang=""`, `formatted = content`。
4. `lines = formatted.splitlines()`；若 `len(lines) > 15` → 只留前 15 行 + `"\n... ({n-15} more lines, collapsed)\n"`。
5. 包成 ` ```{lang}\n{formatted}\n``` `。**空 lang 时是 ` ```\n...\n``` `（三反引号紧跟换行）**。

注意第 2 步用 **字符**截断、第 4 步用**行**截断，两者是独立的。

### 6.7 `_format_compact_boundary(parsed)` — `message_utils.py:95-102`
```
\n\n---\n\n📦 **Conversation Compacted** ({strategy})\n{before_k}K → {after_k}K tokens\n
```
`before_k = parsed.get("tokens_before", 0) // 1000`，`after_k` 同理。**整数除法**（87000 → 87）。

### 6.8 `_format_compact_summary(parsed)` — `message_utils.py:105-109`
```
\n\n📋 **Summary of earlier conversation:**\n\n{summary}\n
```

### 6.9 `_format_skill_event(parsed)` — `message_utils.py:267-280`
- `applied = parsed.get("applied_skills", [])`；**若不是 list 或为空 → 返回 `""`（空字符串）**。
- 输出：`\n\n🧩 **Loaded Skill** {skill_refs}\n` + `" · ".join(details)`
- `skill_refs = ", ".join(f"`{s}`" for s in applied)`
- `details` = `[f"confidence: `{confidence}`"]`，若 `phase` 真值则加 `f"phase: `{phase}`"`，然后总是加 `f"guards: `{guard_count}`"`（`guard_count = len(guards) if isinstance(guards,list) else 0`）。

### 6.10 `_format_permission_event(parsed)` — `message_utils.py:283-305`

| `event` | `resolution`/`outcome` | 输出 |
|---|---|---|
| `permission_request_created` | — | `\n\n🔐 **{tool_name}** — permission required{risk_badge}`，`risk_badge = f" [{risk}]" if risk else ""` |
| `permission_request_resolved` | `approved` | `\n\n✅ **{tool_name}** — permission approved` |
| 同上 | `denied` | `\n\n❌ **{tool_name}** — permission denied` |
| 同上 | `timeout` | `\n\n⏰ **{tool_name}** — permission timed out` |
| 同上 | 其它 | `\n\n🔐 **{tool_name}** — permission {resolution}` |
| `permission_effect_applied` | `executed` | `""`（空串，因为工具结果消息紧随其后） |
| 同上 | 其它 | `\n\n⚠️ **{tool_name}** — execution failed` |
| 其它 event | — | `""` |

### 6.11 完整调用链（谁怎么用这些函数）

`query_engine.py:203-208`：
```python
api_messages: list[dict] = [
    formatted
    for msg in active_messages
    if (formatted := message_to_api_format(msg)) is not None
]
api_messages = sanitize_api_messages(api_messages)
```
`app.py:2317-2326`（每消息的显示包装）：
```python
if msg.role == "tool":      → f"**{t(TKey.LABEL_TOOL)}**\n\n{message_to_display(msg)}"
elif msg.role == "system":  → f"**{t(TKey.LABEL_SYSTEM)}**\n\n{message_to_display(msg)}"
else:                       → f"**{LABEL_YOU|LABEL_ASSISTANT}**\n\n{message_to_display(msg)}"
```

---

## 7. `paths.py` 路径解析规则

`paths.py:13-24`（**全文抄录**）：
```python
def resolve_app_paths(home: Path | None = None, cwd: Path | None = None) -> AppPaths:
    base_home = home if home is not None else Path.home()
    base_cwd = cwd if cwd is not None else Path.cwd()
    global_dir = base_home / ".flyinchat"
    project_dir = base_cwd / ".flyinchat"

    return AppPaths(
        global_dir=global_dir,
        project_dir=project_dir,
        config_path=global_dir / "config.json",
        chat_path=project_dir / "chat.json",
    )
```

规则：
- `home` 参数（测试注入用）优先于 `Path.home()`；`cwd` 参数优先于 `Path.cwd()`。
- **全局**：`~/.flyinchat/config.json`（channels / models / app_settings / mcp_servers）。
- **项目**：`<cwd>/.flyinchat/chat.json`（conversations / messages）。
- workspace 探测：**没有专门的探测逻辑**。workspace 被定义为 `project_dir.parent`（即 `Path.cwd()`），调用点 `app.py:372,854,1134,1701`。
- **项目目录不做向上查找**（不搜 `.git`、不遍历父目录）。进程的 CWD 决定一切。
- 没有 XDG / `APPDATA` / 环境变量覆盖；没有 `FLYINCHAT_HOME` 之类的开关。
- `resolve_app_paths` 只**计算**路径，**不创建目录**；创建由 `_write_json` 的 `path.parent.mkdir(parents=True, exist_ok=True)` 完成。

日志路径（`logging_config.py:53-54`）——**第三处独立路径规则**：
```python
target_path = log_path if log_path is not None else Path.cwd() / ".flyinchat" / "flyinchat.log"
```
`app.py:2434` 的 `run()` 调 `configure_logging()` 不传 `log_path`，所以日志落在 **`<cwd>/.flyinchat/flyinchat.log`（项目内，不是全局）**。
- `mode="w"`（**每次启动覆盖**，不追加）。
- 每次调用会 `close()` 并 `clear()` `logger("flyinchat")` 上所有已有 handler（`logging_config.py:61-64`）。
- logger 名是 `"flyinchat"`，子 logger 用 `get_logger(name)` → `logging.getLogger(f"flyinchat.{name}")`（`logging_config.py:67-68`）。
- 每行是**独立 JSON 对象**（NDJSON），字段：`timestamp`(UTC ISO, 微秒, `+00:00` 后缀——**与存储层的 `Z` 后缀不同**)、`level`、`logger`、`message`，加上 27 个可选 `extra` 属性（`logging_config.py:15-44`），再加异常的 `exception` 字符串。序列化 `ensure_ascii=False`。

---

## 8. `storage.py` 全部公开 API 精确签名

所有函数都以 `config_path: Path` 或 `chat_path: Path` 为**第一个位置参数**（无全局状态、无单例）。除特别说明外，异常都是**裸 `ValueError`**（无自定义异常类，无 error code）。

### 8.1 初始化

| 签名 | 行号 | 说明 |
|---|---|---|
| `initialize_storage(paths: AppPaths \| None = None) -> AppPaths` | 44 | 解析路径（若为 None）+ 初始化两个 store；**总是重写文件** |
| `initialize_config_store(path: Path) -> None` | 51 | 存在→读+归一化+写回；不存在→试 `config.sqlite` 迁移，否则默认空 store |
| `initialize_chat_store(path: Path) -> None` | 64 | 同上，对应 `chat.sqlite` |

### 8.2 Channel / Model CRUD

| 签名 | 行号 | 异常 |
|---|---|---|
| `create_llm_channel(config_path, *, name: str, provider_type: str, api_key: str, base_url: str \| None = None) -> LLMChannel` | 77 | `ValueError("Unsupported provider_type: {x}")` / `"Channel name is required"` / `"API key is required"` |
| `create_channel_with_models(config_path, *, name, provider_type, api_key, model_names: Sequence[str], base_url=None, context_window=125_000, max_output_tokens=128_000) -> tuple[LLMChannel, list[LLMModel]]` | 102 | 同上 + `ValueError("At least one model is required")` |
| `create_preset_channel(config_path, *, preset_id: str, api_key: str) -> tuple[LLMChannel, list[LLMModel]]` | 158 | `ValueError("Unsupported provider preset: {x}")` |
| `add_llm_model(config_path, *, channel_id, name, is_default=False, context_window=125_000, max_output_tokens=128_000) -> LLMModel` | 177 | `ValueError("Model name is required")` / `"Channel not found"` / `"Model already exists for channel"` |
| `list_llm_channels(config_path) -> list[LLMChannel]` | 222 | 无（排序 `(name, created_at)` 升序） |
| `list_llm_models(config_path, *, channel_id: str \| None = None) -> list[LLMModel]` | 231 | 无（见下方排序规则） |
| `get_primary_llm_model(config_path) -> tuple[LLMChannel, LLMModel] \| None` | 249 | 无 |
| `set_primary_llm_model(config_path, *, model_id: str) -> tuple[LLMChannel, LLMModel]` | 269 | `ValueError("Model not found")`；若 channel 丢失 → `_require_channel` 抛 `ValueError("Channel not found")` |
| `set_model_thinking(config_path, *, model_id: str, enabled: bool) -> LLMModel` | 291 | `ValueError("Model not found")` |
| `set_model_reasoning_effort(config_path, *, model_id: str, effort: str) -> LLMModel` | 295 | `ValueError("Invalid reasoning effort: {x}. Must be low, medium, or high.")`，**先校验 effort 再查 model** |
| `set_model_context_window(config_path, *, model_id: str, context_window: int) -> LLMModel` | 301 | `ValueError("Model not found")` |

**排序规则（必须精确复刻，UI 顺序依赖它）**：
- `list_llm_channels`：`key=(item["name"], item["created_at"])` **升序**。
- `list_llm_models(channel_id=X)`：`key=(not item["is_default"], item["name"])` 升序 —— 即 **default 排最前**，其余按名字。
- `list_llm_models()`（无 channel_id）：`key=(channel_id, not is_default, name)` 升序。
- `get_primary_llm_model`：取**所有** `is_default=True` 的 model，与 channel join（**丢弃 channel 不存在的孤儿 model**），再按 `(channel.name, model.name)` 升序取第一个。**因此多个 default 是允许的**，只是第一个胜出。
- `create_channel_with_models` 返回的 list 排序：`key=(not is_default, name)` —— 与 `list_llm_models` 一致。
- `add_llm_model(is_default=True)` 会**先把同一 channel 下其它 model 的 `is_default` 全部置 False**（`storage.py:211-216`）——注意范围是**同 channel**，不是全局，所以跨 channel 仍可能有多个 default。
- `set_primary_llm_model` 是**全局唯一化**：把**所有** model 的 `is_default` 设为 `(id == model_id)`（`storage.py:276-283`），且**只更新目标 model 的 `updated_at`**。

**`create_channel_with_models` 的 default 逻辑**（`storage.py:127,133`）：
```python
has_primary_model = _has_primary_model(store)   # 全局 any(is_default)
"is_default": index == 0 and not has_primary_model
```
即：**只有当全局还没有任何 default 时，新 channel 的第一个 model 才成为 default**。

**`_clean_model_names`**（`storage.py:737-745`）：
```python
cleaned = tuple(dict.fromkeys(m.strip() for m in model_names if m.strip()))
if not cleaned: raise ValueError("At least one model is required")
```
用 `dict.fromkeys` **去重且保持插入顺序**（Python 3.7+ dict 保序），先去空白再去空串。

### 8.3 Conversation / Message CRUD

| 签名 | 行号 | 异常 / 返回值 |
|---|---|---|
| `create_conversation(chat_path, *, title: str) -> Conversation` | 305 | `ValueError("Conversation title is required")`；所有计数从 0、`status="active"`、`parent_conversation_id=""`、`agent_type=""` |
| `create_subagent_conversation(chat_path, *, parent_conversation_id, agent_type, title) -> Conversation` | 329 | `ValueError("Parent conversation ID is required")` / `"Agent type is required"` / `"Conversation title is required"` / `"Parent conversation not found"` |
| `list_subagent_conversations(chat_path, *, parent_conversation_id) -> list[Conversation]` | 366 | 无；过滤 `conversation.get("parent_conversation_id") == parent`（**用 `.get`，容忍缺键**）；排序 `(updated_at, created_at)` **降序** |
| `get_conversation(chat_path, *, conversation_id) -> Conversation \| None` | 379 | 无 |
| `list_conversations(chat_path) -> list[Conversation]` | 392 | 无；排序 `(updated_at, created_at)` **降序**（最新的在前） |
| `add_message(chat_path, *, conversation_id, role, content, turn_id="", subtype="normal", tool_call_id=None, meta="{}", agent_type="") -> Message` | 402 | `ValueError("Unsupported message role: {x}")` / `"Message content is required"`（**`if not content`，空串被拒**）/ `"Conversation not found"` |
| `update_conversation_usage(chat_path, *, conversation_id, total_output_tokens: int, last_input_tokens: int) -> None` | 451 | **无异常**（未知 id 静默 no-op，实测确认）；**覆盖写两个值** |
| `list_messages(chat_path, *, conversation_id) -> list[Message]` | 470 | 无；按 `created_at` **升序** |
| `update_message_content(chat_path, *, message_id: str, content: str) -> None` | 481 | **无异常**（未知 id 静默 no-op，实测确认）；**不更新 `updated_at`（消息没有该字段）、不更新 conversation 的 `updated_at`** |
| `add_message_with_turn(chat_path, *, conversation_id, turn_id, role, subtype="normal", content, tool_call_id=None, meta="{}", agent_type="") -> Message` | 490 | 纯 `add_message` 的转发；**注意 `turn_id` 与 `content` 是必填关键字参数，且 `content` 在 `subtype` 之后**（签名顺序刻意不同） |
| `get_turn_messages(chat_path, *, conversation_id, turn_id) -> list[Message]` | 515 | 无；按 `created_at` 升序 |
| `increment_turn(chat_path, *, conversation_id) -> int` | 528 | **无异常**；未知 conversation 返回 `0`（实测确认）且会把整个 store 重写一遍（无变化） |
| `update_conversation_compacted_count(chat_path, *, conversation_id, count: int) -> None` | 543 | 无异常；**覆盖写** |
| `list_active_messages(chat_path, *, conversation_id) -> list[Message]` | 557 | 无；见 §5.2 |

**副作用说明（复刻必须一致）**：
- `add_message` 会**同时更新该 conversation 的 `updated_at`**（`storage.py:436-441`），并且**不修改 `current_turn`**。
- `update_conversation_usage`、`update_conversation_compacted_count`、`increment_turn` **都会更新 conversation 的 `updated_at`**，即使值没变。
- `update_message_content` **不**触碰任何 `updated_at`（所以压缩截断工具结果后，会话排序不会跳到最前）。
- `increment_turn` 用 `int(conversation["current_turn"]) + 1`（容错字符串）。
- 所有"更新"操作都是**全数组 map**（未命中的元素在 Python 里若走 `else` 分支则是同一对象引用，若走 dict 展开则是新 dict）——语义上没有区别，但 `_write_json` 总是全量序列化。

### 8.4 App settings / MCP / 时间戳

| 签名 | 行号 | 说明 |
|---|---|---|
| `get_app_setting(path: Path, key: str) -> str \| None` | 591 | **注意参数名是 `path`**（不是 `config_path`）；用 `store["app_settings"].get(key)`；**返回值总是 `str`**（`str(value) if value is not None else None`） |
| `set_app_setting(path: Path, key: str, value: str) -> None` | 597 | 值必须是 `str`；**立即写盘** |
| `load_mcp_config(paths: AppPaths) -> MCPConfig` | 603 | **唯一接收 `AppPaths` 而非 `Path` 的公开函数**；内部走 `MCPConfig.from_dict(store)`，容忍 `mcp_servers` 缺失 |

**时间戳** — `_now_iso()`，`storage.py:781-782`（**全文抄录**）：
```python
def _now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
```
产物形如 `"2026-09-13T17:46:49.102Z"`：
- **UTC**（`datetime.UTC`，Python 3.11+ 别名）；
- `timespec="milliseconds"` → **恰好 3 位小数**；
- `+00:00` 被替换为 `Z`；
- **排序可用字符串比较**（固定宽度、字典序 = 时间序）——这是 `created_at` 能直接当排序键的原因。**复刻时必须保证同一格式**，否则消息顺序会乱。

**ID 生成**：全部 `str(uuid4())`（36 字符，带连字符的小写十六进制）。临时文件用 `uuid4().hex`（32 字符，无连字符）。

### 8.5 内部辅助函数（复刻需要照抄的转换器）

| 函数 | 行号 | 说明 |
|---|---|---|
| `_load_config_store(path) -> dict` | 609 | 归一化后的 config store（含 `mcp_servers`） |
| `_load_chat_store(path) -> dict` | 620 | 归一化后的 chat store |
| `_load_json(path, default_factory) -> dict` | 632 | 见 §4.2 |
| `_write_json(path, store) -> None` | 644 | 见 §4.1 |
| `_default_config_store()` | 654 | 见 §4.3 |
| `_default_chat_store()` | 663 | 见 §4.4 |
| `_migrate_config_store(sqlite_path)` | 671 | 见 §4.10 |
| `_migrate_chat_store(sqlite_path)` | 694 | 见 §4.10 |
| `_connect_sqlite(path)` | 711 | `sqlite3.connect` + `row_factory = sqlite3.Row` |
| `_fetch_sqlite_rows(connection, table)` | 717 | 表不存在返回 `[]` |
| `_validate_channel_fields(*, name, provider_type, api_key)` | 728 | 校验顺序：**provider_type → name → api_key** |
| `_clean_model_names(model_names)` | 737 | 见 §8.2 |
| `_has_primary_model(store)` | 748 | `any(model["is_default"] for ...)`（**下标，缺键 KeyError**） |
| `_update_model(config_path, model_id, updates)` | 752 | 通用 update；`{**model, **updates, "updated_at": now}`；未找到抛 `ValueError("Model not found")` |
| `_require_channel(store, channel_id)` | 771 | 未找到抛 `ValueError("Channel not found")` |
| `_now_iso()` | 781 | 见 §8.4 |
| `_normalize_*_dict(row)` × 4 | 785/798/814/831 | 见 §4.9 |
| `_channel_from_dict(row)` | 847 | 纯字段拷贝，无 `.get` 兜底（**依赖归一化已补齐**） |
| `_model_from_dict(row)` | 859 | `max_output_tokens=int(row.get("max_output_tokens", 384_000))` ← **唯一的 `.get`** |
| `_conversation_from_dict(row)` | 874 | 纯字段拷贝 |
| `_message_from_dict(row)` | 890 | 纯字段拷贝 |

`_validate_channel_fields` 校验**顺序**（`storage.py:728-734`）——测试 `test_invalid_provider_type_is_rejected` 依赖它：
```python
if provider_type not in _PROVIDER_TYPES:  # 先查 provider_type
    raise ValueError(f"Unsupported provider_type: {provider_type}")
if not name.strip():                      # 再查 name
    raise ValueError("Channel name is required")
if not api_key.strip():                   # 最后查 api_key
    raise ValueError("API key is required")
```

---

## 9. 关键不变量、边界条件、易错点

### 9.1 `max_output_tokens` 默认值不一致（**真实 bug 级坑**）

| 位置 | 默认值 |
|---|---|
| `models.py:24` `LLMModel.max_output_tokens` | `384_000` |
| `storage.py:28` `ProviderPreset.max_output_tokens` | `128_000` |
| `storage.py:111,184` `create_*` 函数参数默认 | `128_000` |
| `storage.py:808` `_normalize_model_dict` | `128_000` |
| `storage.py:868` `_model_from_dict` 的 `.get` 兜底 | `384_000` |

因为 `_normalize_model_dict` 总会填 `128_000`，`_model_from_dict` 的 `384_000` 兜底**不可达**。实际磁盘上永远是 `128000`（本机实测确认）。
**复刻建议**：统一为 `128_000`，并在规格里记录这个不一致。

### 9.2 compact boundary 的 `subtype` 与文档不符（**文档/代码不一致**）

`compact.py:281-297` 调 `add_message(..., role="system", content=json.dumps({...}))` —— **没有传 `subtype`**，所以落盘 `subtype` 是默认的 `"normal"`，**不是 `"compact_boundary"`**。
- `list_active_messages` 因此**永远走 JSON `type` 分支**（`storage.py:564-569`），`subtype` 分支（`storage.py:561-563`）只在**测试/手工构造**的数据里生效（`tests/test_storage.py:285-289` 明确写入 `subtype="compact_boundary"`）。
- 同理 `compact_summary` 也落盘为 `subtype="normal"`，所以 `list_active_messages` 的 `prev.subtype == "compact_summary"` 分支也是死代码，永远走 JSON 分支。
- `message_to_api_format` 写用 `parsed.get("type")`，与落盘一致，所以**功能正常**；只是 `subtype` 双分支是防御性冗余。

### 9.3 未知顶层键会被静默丢弃

`_load_config_store` / `_load_chat_store` 返回的是**白名单 dict**。`initialize_storage` 在启动时把归一化结果写回，因此**用户在 config.json 里加的任意自定义顶层键会在下次启动时消失**。`mcp_servers` 之所以能存活，只因为它在白名单里。
**复刻决策点**：要不要保留未知键？原实现不保留。

### 9.4 `mcp_servers` 元素完全不校验（可导致崩溃）

`_load_config_store` 只做 `list(store.get("mcp_servers", []))`——若用户写成 `"mcp_servers": {"a": 1}`（dict），`list()` 得到 `["a"]`（键列表）；随后 `MCPConfig.from_dict` 对字符串调 `.get` → `AttributeError`。若元素是 `null`，同样崩溃。**复刻时应加类型校验，或至少明确记录此行为。**

### 9.5 并发写入无任何保护（**最严重的架构约束**）

- 无文件锁（无 `flock`/`fcntl`/lockfile）。
- 读-改-写非原子：`_load_chat_store` → 修改 → `_write_json` 之间没有任何互斥。
- **丢失更新窗口**：两个进程（或同一进程的两个 async 任务）同时 `add_message` 会有一个的写入被完全覆盖。
- 由于 `_write_json` 是**全量重写**（不是追加），丢失更新会**丢掉整条消息**，而不只是冲突字段。
- 实际风险来源：TUI 是单进程异步，但 `subagents/executor.py` 与主 `query_engine.py` **共享同一个 `chat_path`**，若子代理与主代理并发写（例如并行子代理），就会撞车。
- **复刻建议**：加进程级文件锁 + 读-改-写临界区；或改用真正的数据库。若追求完全等价，就照抄并文档化风险。

### 9.6 `total_output_tokens` 的累加语义分散在调用方

`storage.update_conversation_usage` 只是**覆盖**。累加逻辑在 `query_engine.py:600-604`：
```python
if channel.provider_type == "anthropic":
    total_output_tokens += usage_info.get("output_tokens", 0)
    total_input_tokens = usage_info.get("input_tokens", 0)      # ← 赋值，非累加
else:
    total_output_tokens += usage_info.get("completion_tokens", 0)
    total_input_tokens = usage_info.get("prompt_tokens", 0)     # ← 赋值，非累加
```
- `total_output_tokens` 是**跨所有 LLM 往返累加**的（局部变量，每 turn 从 0 开始 → 每次写盘覆盖为"本 turn 累计"，所以实际上是**每 turn 覆盖**，不是跨 turn 累加！）。
- `last_input_tokens` 是**最后一次往返**的值。
- 有 fallback（`query_engine.py:608-609`）：若 `total_input_tokens == 0` 且有 api_messages → 用 `TokenEstimator().estimate_api_messages()` 估算。
- **TUI 侧**再自己累加（`app.py:517-518`：`self._total_output_tokens += event.data.get("output_tokens", 0)`）。

### 9.7 子代理与主代理共享 `chat.json`

`subagents/executor.py` 用同一个 `chat_path`，靠 `Conversation.parent_conversation_id` + `Message.agent_type` 区分。
- 子代理**不做压缩**（不调 `CompactionEngine`）。
- 子代理的 `turn_id` 前缀是 `subagent_turn_`（`executor.py:79`），主代理是 `turn_`（`query_engine.py:108`）——**前缀可用于区分**。
- `Message.agent_type` 在子代理写消息时总是显式赋值（`executor.py:90,99,152,178,198,351`），主代理写消息时总是 `""`。
- `list_active_messages` 按 `conversation_id` 过滤，所以不会串台。

### 9.8 `add_message` 的 `if not content` 会拒绝空串，但空**空白**串能通过

```python
if not content: raise ValueError("Message content is required")
```
- `""` → 拒绝。
- `"   "`（纯空白）→ **接受**（真值）。
- `"0"`、`"[]"`、`"{}"` → 接受（真值字符串）。

### 9.9 `list_active_messages` 只看**第一个** boundary（已在 §5.2 详述）

多次压缩时，活跃窗口的起点永远是**第一次**压缩的位置 → 窗口只增不减。这是**有意**的（保留压缩后新增的所有消息），但意味着 `compacted_message_count` 与活跃窗口大小**不成反比**。

### 9.10 `Message.meta` 永远是字符串

即使内容是 JSON，也以 `str` 存储（`_normalize_message_dict` 用 `str(row.get("meta") or "{}")`）。
- 若某处传入了 dict 给 `add_message(meta=...)`，`_write_json` 会把它序列化成 JSON object（**磁盘上是 object 而非 string**），但下次 `_normalize_message_dict` 的 `str({...})` 会把它变成 **Python repr 字符串**（`"{'a': 1}"`，单引号！）——**再也不能被 `json.loads` 解析**。这是潜在的静默数据损坏。
- 现状：所有调用方都传 `json.dumps(...)` 或默认 `"{}"`，所以不会触发。

### 9.11 JSON 序列化细节

- `ensure_ascii=False`：中文原样写入（TUI 支持 zh，所以必要）。
- `indent=2`：文件会很大（每条消息 ~10 行），但没有性能优化。
- `sort_keys` **未启用** → 键顺序 = 插入顺序（依赖 dict 保序）。
- **没有自定义 encoder**：`frozenset`、`set`、`datetime`、`Path`、enum 都无法序列化会抛 `TypeError`。所以所有值在入 store 前必须已经是 **str/int/bool/None/list/dict**。
- `bool` 在 JSON 里是 `true`/`false`（不是 `1`/`0`）——从 SQLite 迁移进来的 int 会在归一化时被 `bool()` 转成真正的 Python bool。
- `None` → `null`（只有 `base_url`、`tool_call_id`、`error_code`、`data` 的某些键会出现）。

### 9.12 时间戳与排序

- 同毫秒内的消息 `created_at` **完全相同** → `sorted()` 是**稳定排序**，所以插入顺序被保留（因为 `store["messages"]` 的物理顺序就是插入顺序）。**复刻时若用了非稳定排序，多条同毫秒消息的顺序会乱。**
- `turn_id` **不参与排序**。
- `list_conversations` / `list_subagent_conversations` 是 `reverse=True` 的降序（最新在前）。

### 9.13 重复 ID 无检测

`str(uuid4())` 理论上无碰撞，代码里**没有任何唯一性检查**。
- 若手工编辑 JSON 造成重复 `id`：`get_conversation` 返回**第一个**；`update_message_content` 会**修改所有**匹配行（列表推导无 break）；`set_primary_llm_model` 会**把所有**匹配行设为 default；`_update_model` 会更新所有匹配行并在最后 `next(...)` 取第一个。
- **重复的 model name（同 channel）** 只在 `add_llm_model` 被拒绝；`create_channel_with_models` 用 `dict.fromkeys` 去重。

### 9.14 空会话 / 空 store

- 空 `conversations` / `messages` 数组：所有 list 函数返回 `[]`，所有 get 返回 `None`。
- `get_primary_llm_model` 在没有 default model 时返回 `None` → `query_engine.py:134-149` 走 "No model configured. Add one with /api, then /model." 错误路径。
- `add_message` 对不存在的 conversation 抛 `ValueError("Conversation not found")`，但 `update_conversation_usage` / `increment_turn` / `update_message_content` / `update_conversation_compacted_count` 对未知 ID **静默 no-op**（不一致！复刻时须照做，因为测试/调用方依赖某些行为）。

### 9.15 `initialize_storage` 是幂等的，但**不是**无副作用的

测试 `test_migration_idempotent`（`tests/test_storage.py:300-308`）断言重复调用不失败。但每次调用都会：
1. 重写两个文件（mtime 变化）；
2. 把 falsy 的 `created_at`/`updated_at` 填成**当前时间**（所以 `created_at` 会"漂移"！——仅当该字段原本是 falsy）；
3. 丢弃未知顶层键。

### 9.16 `_model_from_dict` 与 `_normalize_model_dict` 的字段完备性依赖

`_channel_from_dict` / `_conversation_from_dict` / `_message_from_dict` **全部用下标访问**（`row["id"]` 等），不做 `.get` 兜底。它们的安全性**完全依赖**调用方先经过对应的 `_normalize_*_dict`。唯一的例外是 `_model_from_dict` 的 `max_output_tokens`。
**复刻时必须保持这个分层**（归一化 → 转换器），否则 `create_*` 路径（直接构造 dict 后转换）会漏字段。

### 9.17 `os.replace` 在 Windows 的行为

`os.replace` 在 Windows 上也能覆盖已存在文件（不同于 `os.rename`），但若目标被另一进程打开（如杀毒软件扫描）会抛 `PermissionError`。原代码**不重试**。

### 9.18 `.flyinchat/` 在 `.gitignore` 里

`.gitignore` 含 `.flyinchat/`（项目级），所以 `<workspace>/.flyinchat/chat.json` 不会被提交。**全局 `~/.flyinchat/config.json` 含明文 API key**，且不在任何仓库里（但也没有加密/权限收紧）。

### 9.19 `observability/client.py:371` 的硬编码路径（已提，重复强调）

```python
config = ObservabilityConfig.from_config_store(Path("~/.flyinchat/config.json").expanduser())
```
只在 `config is None and config_path is None` 时触发。`app.py:351-353` 总会传 `config_path`，所以生产路径不触发；但**测试或 SDK 用法**若直接调 `create_observability_client()` 会绕过注入的 home。复刻时建议统一走 `resolve_app_paths`。

### 9.20 `__init__.py` 的重导入代价

`src/flyinchat/__init__.py`:
```python
__all__ = ["FlyinChatApp"]
from .app import FlyinChatApp
```
`import flyinchat` 会**立刻导入 Textual 与整个 TUI**。数据层的模块（`models`/`storage`/`paths`/`message_utils`）**不依赖** `__init__.py`，可以独立导入（`from flyinchat.storage import ...` 会先执行 `__init__.py`！——所以**实际上任何 `from flyinchat.x import y` 都会拉起 TUI**）。
**复刻建议**：如果目标语言要求数据层可独立使用，把 `from .app import ...` 改成惰性（`__getattr__`）或干脆不重导出。

---

## 10. 复刻检查清单（Checklist）

### A. 模型层

- [ ] 定义全部 6 个不可变模型：`LLMChannel`、`LLMModel`、`Conversation`、`Message`、`TurnResult`、`SessionConfigSnapshot`（+ `ProviderPreset`、`AppPaths`）。
- [ ] 字段名、顺序、类型、默认值逐字段与 §2 一致（尤其 `LLMModel.max_output_tokens` 的取值决策见 §9.1）。
- [ ] 所有模型值相等 + 可哈希（frozen / `@dataclass(frozen=True)` 等价物）。
- [ ] `Message.meta` 是 **string**，不是 object。
- [ ] `LLMChannel.base_url` 与 `Message.tool_call_id` 是**唯一**可为空的字段。
- [ ] 不实现 `Todo`/`Turn` dataclass（不存在）；如需 todo 存内存即可。

### B. 路径层

- [ ] `resolve_app_paths(home=None, cwd=None)`：`home ?? Path.home()`，`cwd ?? Path.cwd()`。
- [ ] `global_dir = home/".flyinchat"`，`project_dir = cwd/".flyinchat"`。
- [ ] `config_path = global_dir/"config.json"`，`chat_path = project_dir/"chat.json"`。
- [ ] 不创建目录、不做向上查找、不支持环境变量覆盖。
- [ ] workspace = `project_dir.parent`（在调用方计算）。
- [ ] 日志路径独立：`cwd/".flyinchat"/"flyinchat.log"`，`mode="w"`，NDJSON。

### C. 读 / 写 / 原子性

- [ ] 读：不存在 → 默认 store；空白 → 默认 store；根非 object → 抛错（`Invalid storage file: <path>`）；非法 JSON → 抛错。
- [ ] 写：`mkdir -p` 父目录 → 写同目录临时文件 `.<name>.<hex32>.tmp` → `os.replace`。
- [ ] 序列化：`ensure_ascii=False`、`indent=2`、**末尾 `\n`**、UTF-8。
- [ ] **每次操作全量读 + 全量写**（不实现增量/追加）。
- [ ] 明确记录：无锁、无 fsync、无重试、孤儿 `.tmp` 会残留。
- [ ] 决定是否加锁（见 §9.5）；若加锁须保证语义等价。

### D. 归一化与默认值

- [ ] 实现 4 个 `_normalize_*_dict`，用 `or` 语义（falsy → 默认）。
- [ ] 默认值精确：`is_default=False`、`thinking_enabled=True`、`reasoning_effort="high"`、`context_window=125_000`、`max_output_tokens=128_000`、`status="active"`、`subtype="normal"`、`meta="{}"`、`turn_id=""`、`parent_conversation_id=""`、`agent_type=""`、`compacted_message_count=0`、`current_turn=0`、token 计数 `0`。
- [ ] `created_at`/`updated_at` 为 falsy 时填**当前时间**。
- [ ] 必需键缺失时**抛错**（不要静默跳过该行）。
- [ ] 丢弃未知顶层键（或明确决定保留并文档化）。
- [ ] 转换器（`*_from_dict`）用**下标**访问，只依赖归一化后的输入。
- [ ] `initialize_storage` 每次启动都重写两个文件。

### E. 时间戳与 ID

- [ ] `_now_iso()` = UTC + 毫秒精度 + `Z` 后缀（`isoformat(timespec="milliseconds")` + 把 `+00:00` 换 `Z`）。
- [ ] 固定宽度 → 字符串排序 == 时间排序。
- [ ] ID = 小写 UUID4 带连字符（36 字符）；临时文件名用 `hex`（32 字符）。
- [ ] 依赖**稳定排序**保证同毫秒消息顺序。

### F. Channel / Model

- [ ] `_PROVIDER_TYPES = {"openai_compatible","anthropic"}`；校验顺序 provider_type → name → api_key。
- [ ] `PROVIDER_PRESETS` 精确含 deepseek 一项（含 `deepseek-v4-pro`/`deepseek-v4-flash`、1M context、anthropic 类型、`https://api.deepseek.com/anthropic`）。
- [ ] `_clean_model_names`：strip → 去空 → `dict.fromkeys` 去重保序 → 空则抛 `At least one model is required`。
- [ ] `create_channel_with_models`：`is_default = (index == 0 and 全局无 default)`。
- [ ] `add_llm_model(is_default=True)`：只把**同 channel** 的其它 model 置 False。
- [ ] `set_primary_llm_model`：全局唯一化，只更新目标的 `updated_at`。
- [ ] 排序规则 4 组全部照抄（§8.2）。
- [ ] `get_primary_llm_model` 丢弃 channel 不存在的孤儿 model，按 `(channel.name, model.name)` 取第一。
- [ ] `set_model_reasoning_effort` 先校验 `("low","medium","high")` 再查 model。
- [ ] 错误消息字符串逐字一致（UI 会展示）。

### G. Conversation / Message

- [ ] `add_message` 校验顺序：role → content → conversation 存在。
- [ ] `add_message` 更新 conversation 的 `updated_at`。
- [ ] `update_message_content` **不**更新任何 `updated_at`。
- [ ] 未知 ID：`add_message`/`create_subagent_conversation` 抛错；`update_*`/`increment_turn` 静默（`increment_turn` 返回 0）。
- [ ] `list_messages` 按 `created_at` **升序**；`list_conversations` 按 `(updated_at, created_at)` **降序**。
- [ ] `create_subagent_conversation` 校验父会话存在。
- [ ] `list_subagent_conversations` 用 `.get("parent_conversation_id")` 容错。

### H. Compaction boundary

- [ ] 实现 `list_active_messages` 的**完整双条件扫描 + 首个命中 break + 前一条 summary 回退**逻辑。
- [ ] boundary 是**普通 system 消息**，不是独立存储。
- [ ] 被压缩消息**仍在 `messages` 里**、仍在 TUI 显示（`list_messages` 不裁剪）。
- [ ] `list_active_messages` 与 `message_to_api_format` 的 boundary 判定**不一致**（前者认 subtype 或 JSON type，后者只认 JSON type）——决定是否照抄或修正。
- [ ] 多次压缩只看第一个 boundary。
- [ ] 孤儿 summary（无 boundary）不裁剪任何消息。
- [ ] `update_conversation_compacted_count` 是**覆盖**写。

### I. message_utils

- [ ] `message_to_api_format` 8 条分支按序实现（§6.1），含 `role` 强制改写与 `None` 丢弃。
- [ ] 丢弃集合精确为 `{"permission_event","skill_event"}`。
- [ ] `sanitize_api_messages` 只修"连续 user"，插入 `"[Interrupted]"`。
- [ ] `message_to_display` 7 条分支按序实现（§6.3），**不丢弃任何消息**。
- [ ] 6 个工具专属渲染 + 通用 `_format_result_content`。
- [ ] `file_read` 渲染**故意不显示文件内容**。
- [ ] 常量 `_MAX_RESULT_CHARS=8000`、`_MAX_RESULT_LINES=15`。
- [ ] 所有 emoji 与 markdown 模板逐字一致（`💭`/`🔧`/`📦`/`📋`/`✅`/`❌`/`🧩`/`🔐`/`⏰`/`⚠️`）。
- [ ] `json.loads` 失败时静默回退到原文。

### J. SQLite 迁移

- [ ] 仅当目标 JSON **不存在**时触发；同名 `.sqlite` 存在才执行。
- [ ] 4 张表：`llm_channels`、`llm_models`、`app_settings`（config）；`conversations`、`messages`（chat）。
- [ ] 表不存在 → `[]`（不报错）。
- [ ] `app_settings` 迁移：`{str(row["key"]): str(row["value"]) if key is not None}`。
- [ ] 迁移结果按 §4.9 归一化补默认值。
- [ ] 迁移后**不删除** `.sqlite`。
- [ ] JSON 存在时完全忽略 SQLite。

### K. app_settings / MCP / Langfuse

- [ ] `app_settings` 是 `dict[str,str]`；`get_app_setting` 返回 `str | None`。
- [ ] 布尔解析：`strip().lower() ∈ {"1","true","yes","on","y"}`。
- [ ] Langfuse 三段短路 + 两种不同的 `disabled_reason` 文案。
- [ ] `langfuse_host` 默认 `https://cloud.langfuse.com`；`agent_env` 默认 `development`；`agent_version` 默认 `local`。
- [ ] `mcp_servers` 元素：缺 name/command 跳过；transport 非 `stdio` 跳过；默认 `args=[]`、`env={}`、`timeout_seconds=30`。
- [ ] `load_mcp_config` 接收 `AppPaths`（唯一例外）。

### L. 验证（照抄原测试即可）

- [ ] `tests/test_storage.py`（23 个测试）全绿——覆盖路径解析、默认值、排序、default 迁移、SQLite 迁移、boundary 双分支、幂等初始化。
- [ ] `tests/test_message_utils.py`（4 个测试）全绿——覆盖 file_read 隐藏内容、非 read 工具显示全文、skill_event 显示、skill_event 不发给模型。
- [ ] `tests/test_compact.py:163-206`（boundary 裁剪）与 `test_update_message_content` 全绿。
- [ ] 手工验证：全新启动后 config.json 与 chat.json 的**键顺序**与 §4.3/§4.4 完全一致。

---

## 11. 文档 vs 代码 不一致清单（汇总）

| # | 不一致 | 证据 |
|---|---|---|
| 1 | `CLAUDE.md` 说 `<workspace>/.flyinchat/chat.json` 存 "turns" | 磁盘上**没有** `turns` 键（§4.8）；只有 `Conversation.current_turn` 与 `Message.turn_id` |
| 2 | 任务书提到的 `Todo` dataclass | **不存在**；todo 只在 `ToolContext.turn_state["todos"]` 内存里（`plan_tools.py:66`），不落盘 |
| 3 | 任务书提到的 `Settings` 类 | **不存在** `Settings` dataclass；只有自由形式的 `app_settings: dict[str,str]` |
| 4 | `compact_boundary` 消息的 `subtype` | 落盘是 `"normal"`（`compact.py:281-297` 未传 subtype），但 `list_active_messages:561` 与 `tests/test_storage.py:285-289` 都假定/构造 `subtype="compact_boundary"` |
| 5 | `LLMModel.max_output_tokens` 默认 | `models.py:24`=384_000 vs `storage.py:808`=128_000 vs `storage.py:868`=384_000 |
| 6 | `schema_version` | 名为"版本"，实为常量 `1`；无迁移器，高版本被静默降级（§4.9） |
| 7 | `SessionConfigSnapshot` | 定义了但零引用（§2.6） |
| 8 | 日志时间戳格式 | `logging_config.py:10` 用 `+00:00`（微秒）；`storage._now_iso` 用 `Z`（毫秒） |
| 9 | Langfuse 配置路径 | `observability/client.py:371` 硬编码 `~/.flyinchat/config.json`，绕过 `AppPaths` |
| 10 | `mcp_servers` 是否在默认 store 里 | 新建文件不含（`_default_config_store`），但归一化后含（`_load_config_store`）——导致"刚启动"和"启动两次"的文件结构不同 |
| 11 | `query_engine.py:1264-1272` 的 `_extract_compact_summary` 收集**所有** system 消息 | 与 `message_to_api_format` 的 summary→system 映射叠加后，多次压缩会产生多条 system 内容被拼接 |
