# FlyinChat 复刻规格（REWRITE_SPEC）

> **本文档的读者**：在**新的语言 / 新的仓库**中从零复刻 FlyinChat 的人或 AI agent。
>
> **本文档的目标**：让读者在**不读旧代码**的前提下，能够还原旧项目的**架构、实现细节与行为契约**，并用新语言的标准写法实现出一个行为等价的系统。
>
> **代码基线**：`main` @ `9fc43b3`（feat: sub agent）。源码规模约 17,300 行 Python（`src/` + `tests/`）。

---

## 0. 如何使用本文档

### 0.1 四层阅读路径

| 层 | 文件 | 内容 | 什么时候读 |
|----|------|------|-----------|
| **总纲**（本文） | `docs/REWRITE_SPEC.md` | 项目定位、模块依赖图、核心数据模型、端到端时序、权限矩阵、跨切面不变量、复刻路线图 | **先读，必读**。读完能画出整个系统 |
| **子系统规格** | `docs/rewrite-spec/parts/01..08-*.md` | 逐模块的精确规格：类/函数签名、字段定义、算法、常量、JSON schema、错误处理 | 动手实现某个子系统时**逐字读** |
| **历史设计文档** | `docs/tui-to-queryengine/`、`docs/skills-system-implementation.md` 等 | 设计意图、取舍、演进史、已知限制 | 想知道"为什么这么设计"、判断某个细节能否改动时读 |

| **跨实现规范** | `docs/rewrite-spec/parts/09-typescript-agent-standard.md` | 面向 TypeScript、不同客户端和不同模型的实现标准；规定状态机、协议、幂等、权限、压缩和 Sub-agent 契约 | **新实现必须阅读**；它优先于本文中仅用于 Python 行为复刻的偶然细节 |

子系统规格的提炼结论汇总在 `docs/rewrite-spec/parts/08-design-rationale.md`。

### 0.2 权威性顺序（冲突时以谁为准）

```
1. 旧项目源码（src/flyinchat/**）        ← 绝对权威，行为以它为准
2. 本文档 + parts/01..07                 ← 从源码逐行提炼，若与源码冲突以源码为准
3. docs/ 下的历史设计文档                 ← 设计意图权威，但实现细节可能已过时
4. README.md / CLAUDE.md                 ← 面向用户的概览，可能滞后
```

**注意**：`src/flyinchat/query_engine.py:42` 的 `TurnEvent.event_type` 注释是**过时的**（只列了 9 种，实际有 13 种）。以 §4.2 的事件表和 `app.py:486-537` 的消费代码为准。

### 0.2.1 文档与代码冲突清单（**一律以代码为准**）

旧项目的文档质量参差：历史设计文档描述的是**当时的设计意图**，其中一部分从未落地，或后来又改了。以下是已核实的冲突项。复刻时按"代码"列实现，**不要**按"文档"列。

| # | 主题 | 文档怎么说 | 代码实际是什么 | 状态 |
|---|------|-----------|--------------|------|
| 1 | **Skill 文件加载** | `CLAUDE.md:101`：加载 `.flyinchat/skills/*.md` 和 `*.skill.md` | `skills/registry.py:56`：`root.glob("**/SKILL.md")` —— **只认文件名恰为 `SKILL.md`**，递归子目录 | **[已核实]** 文档错、代码对 |
| 2 | **Skill 扫描根目录** | `CLAUDE.md:101`：`<workspace>/.flyinchat/skills/` | `registry.py:25-28`：`<cwd>/skills`（source=`"project"`）+ `~/.flyinchat/skills`（source=`"user-local"`）。**注意不在 `.flyinchat/` 下** | **[已核实]** 文档错、代码对 |
| 3 | **Skill 优先级** | 未提及 | `registry.py:37-39`：project 先于 user-local，**先到先得**（`if name not in loaded_by_name`），即同名时 project 胜 | **[已核实]** |
| 4 | **压缩阈值** | 三份文档分别写 0.85 / 90% | 代码 `compact.py:83`：`soft_limit_ratio = 0.70`，`hard_limit = context_window`（满窗口），reactive 由 API 报错触发 | **[已核实]** 以代码为准 |
| 5 | **压缩阶段数** | `compact_design.md`：6 阶段（budget / snip / microcompact / collapse / autocompact / reactive） | 只实现 3 条路径：`budget`（软截断）、`autocompact`、`reactive`。**snip / microcompact / collapse 无独立实现** | **[待核实]** |
| 6 | **Auto-edit 的备份回滚** | 设计文档把 `.bak` 备份 + 验证失败自动回滚列为**验收硬指标** | 代码中**完全不存在**备份层 | **[待核实]** |
| 7 | **Langfuse 配置方式** | `langfuse-observability-methodology.md`：环境变量（`.env`） | 实际读 `config.json` 的 `app_settings`（`langfuse_enabled` / `langfuse_public_key` / …）。`langfuse-setup.md` 已更新说明，`.env.example` 也注明"Most settings are now stored in config.json" | **[已核实]** 方法论文档已过时 |
| 8 | **`TurnEvent` 类型数** | `query_engine.py:42` 注释：9 种 | 实际 **13** 种（含 `skill_resolved` / `auto_continue` / `permission_required` / `user_input_required`） | **[已核实]** |
| 9 | **Task 系列工具** | `docs/claude-code-tools-capabilities/` 调研文档提到 TaskCreate/TaskList 等 | **本项目未实现**。该目录是对 Claude Code 的调研资料，不是本项目设计 | **[已核实]** 不要因调研文档而补实现 |
| 10 | **`tool.progress` / `ToolMeta` / bash `background` / 写入原子性** | 工具系统设计文档提及 | 均**未实现** | **[待核实]** |
| 11 | **`compact_boundary` 字段名** | 三份文档给了**三套不同命名**：`summary_ref`+`preserved_segment_anchor` / `summary_msg_id`+`preserved_segment{head_msg_ids,tail_msg_id}` / `summary_message_id`+`preserved_tail_ids` | `compact.py:271-287` 实际写入 `boundary_id` / `strategy` / `source_range_from` / `source_range_to` / `preserved_head_ids` / `preserved_tail_id` / `summary_msg_id` / `tokens_before` / `tokens_after` | **[已核实]** 以代码的第四套为准 |
| 12 | **Skill 来源优先级** | `skills-system-implementation.md`：4 层（session > 项目 > 用户本地 > 插件） | 只有 2 层（project + user-local），先到先得 | **[已核实]** MVP 裁剪 |
| 13 | **Skill 语义检索** | 文档列为 P1：混合召回 + 向量检索 | 纯关键词/标签打分（`resolver.py`），无向量 | **[已核实]** **不要为复刻引入向量库** |
| 14 | **Skill 正文 section 参与检索** | 文档说 section 结构化解析用于检索 | 解析出了 `sections`，但打分**只用** name/description/tags/triggers（+ when_to_use/workflow 两段，见 §4.6.1） | **[已核实]** 部分参与 |
| 15 | **Sub-agent 高级特性** | `subagent-engineering-design.md`：`run_mode`（foreground/background/parallel）、`continuation_handle`、5 档 `context_policy`、`result_contract`、`working_directory_policy` | 均**未实现**或只落默认值；`sub_agent` 的 input schema 里**没有** `run_mode`/`priority` | **[待核实]** |
| 16 | **PlanDoc schema 校验 + 重试** | 设计文档有 | 未实现 | **[待核实]** |
| 17 | **权限对话框默认焦点在 Deny + 高风险二次确认** | `PERMISSION_REQUEST_STATE_MACHINE.md` 要求 | 需与 `app.py` 权限对话框核对 | **[待核实]** |

> **完整清单**：`parts/08-design-rationale.md` §6 列了 **22 条**文档/代码不一致，逐条给出"文档说法 / 代码实际 / 判断"三列，并解释多数差异的根因是**"文档写了完整愿景、代码只落了 MVP"**。实现每个子系统前建议扫一遍对应条目。

> **给复刻者的经验法则**：当 `CLAUDE.md` 或 `docs/` 与本规格冲突时，**本规格优先**（它逐行取自源码）；本规格未覆盖时再查 `docs/` 了解意图。若你发现本规格与源码不符，**以源码为准**并回来修正本规格。
>
> **另一条更重要的法则**：`docs/` 里大量内容是**设计愿景**而非**实现说明**。看到文档描述某个特性时，**先去代码里确认它是否真的存在**——已知至少 12 项文档描述的功能从未落地（见上表与 parts/08 §6）。**不要照着文档补实现**，那会超出旧项目的实际能力边界，反而破坏等价性。

### 0.3 复刻的定义

"复刻"在这里意味着一份**行为等价**的实现，具体包括：

1. **数据兼容**：能读旧项目写的 `<config.json>` 和 `<workspace>/chat.json`，字段名与语义一致。

   > **本实现的有意偏离（2026-09-14）**：目录名改用 `.deepcode` 而非 `.flyinchat`，
   > 即 `~/.deepcode/config.json` 与 `<workspace>/.deepcode/chat.json`。
   > 本项约束的是**文件内部结构**（字段名、语义、schema version），不是目录名——
   > 那部分仍逐字兼容。把旧文件整体复制到 `.deepcode/` 即可直接读取。
   > 理由与验收影响见 `docs/adr/0001-engineering-stack.md` 决策 7。
   > 下文所有 `~/.flyinchat/...` 形式的路径均应理解为 `.deepcode` 下的对应文件。
2. **协议兼容**：对 provider 的请求/响应处理产生相同的归一化事件流。
3. **提示词一致**：送给模型的 system prompt、工具 description、工具 input schema 文本一致（这些直接决定模型行为）。
4. **权限语义一致**：四种模式下每个工具的 auto-allow / ask / deny 判定完全一致。
5. **闭环语义一致**：turn 的终止条件（completed / cancelled / error / max_rounds）与触发原因一致。

**不要求**：UI 布局像素级一致、Textual 特定 API 的等价物、内部类名一致。

---

## 1. 项目定位

### 1.1 一句话

FlyinChat 是一个**终端里的 AI 编程助手**：一个 Textual TUI 前端 + 一个 Claude Code 式的 **agent 主循环**（流式 LLM 响应 → 工具调用 → 权限审批 → 循环），加上 MCP 工具接入、Skill 技能系统、Sub-agent 子代理、上下文自动压缩和可观测性。

### 1.2 对标物

明确对标 **Claude Code** 的交互模型与工具语义。多处设计（工具划分、模式权限、系统提示词结构）是刻意向 Claude Code 对齐的。`docs/claude-code-tools-capabilities/` 是对 Claude Code 工具能力的调研资料，**不是本项目实现**。

### 1.3 Scope 边界

**做**：
- 单机、单用户的终端 TUI 应用
- 多 provider（统一使用 Anthropic Messages API 格式；每个 provider 可配置多个模型）
- 多会话（每个 workspace 一份 `chat.json`）
- 完整的工具/权限/压缩/子代理闭环

**不做**（复刻时不必实现，实现了也不算等价性的一部分）：
- 服务端 / 多用户 / 鉴权
- 远程会话、云同步
- 默认不启动图形界面；可选提供 `--web-ui` 浏览器界面（规范见 `parts/09-typescript-agent-standard.md`）
- 插件市场

### 1.4 技术栈与依赖

| 依赖 | 用途 | 复刻时可替代 |
|------|------|-------------|
| `textual` >= 0.86 | TUI 框架 | 用目标语言的 TUI 库（如 Bubble Tea / ratatui / Ink） |
| `httpx` >= 0.28 | HTTP + 流式 SSE | 目标语言的 HTTP 客户端 |
| `mcp` >= 1.0 | MCP 协议客户端 SDK | MCP 官方 SDK 的对应语言实现 |
| `langfuse` >= 3.0 | 可观测性（可选） | 可省略，或对接目标语言的等价物 |
| Python `>= 3.11` | `asyncio` + dataclass | 目标语言的并发原语 |

**关键**：除 TUI 与可选的可观测性外，**核心逻辑（QueryEngine、工具、权限、压缩、子代理、MCP）不依赖 Textual**。QueryEngine 通过回调 `on_event(TurnEvent)` 向 UI 单向推送，UI 通过 `resolve_permission()` / `resolve_user_input()` 回灌。这是复刻时必须保持的**单向数据流 + 显式回灌**边界。

---

## 2. 系统全景

### 2.1 分层图

```
┌──────────────────────────────────────────────────────────────────────┐
│  表现层  TUI / Web UI adapters                                         │
│    TUI：compose / 事件循环 / 斜杠命令 / 权限对话框 / 状态栏 / i18n      │
│    Web：HTTP/WebSocket / auth / session events（`--web-ui`）           │
│    chat_message.py  file_mentions.py  i18n/                          │
└───────────────────────────┬──────────────────────────────────────────┘
                            │ on_event(TurnEvent)  ↑↓  resolve_*()
┌───────────────────────────▼──────────────────────────────────────────┐
│  编排层  query_engine.py (1278 行)                                    │
│    QueryEngine.submit_message → _run_turn                            │
│    + prompt_assembler.py（system prompt 分层）                        │
│    + compact.py（token 估算 / 软截断 / 硬摘要 / 自动续跑）             │
└──┬────────────┬─────────────┬──────────────┬──────────────┬──────────┘
   │            │             │              │              │
┌──▼──────┐ ┌───▼──────┐ ┌────▼─────┐ ┌──────▼──────┐ ┌─────▼────────┐
│工具运行时│ │Provider  │ │Skill     │ │Sub-agent    │ │可观测性      │
│tools/    │ │api_client│ │skills/   │ │subagents/   │ │observability/│
│core.py   │ │.py       │ │          │ │             │ │              │
└──┬───────┘ └──────────┘ └──────────┘ └─────────────┘ └──────────────┘
   │
┌──▼───────────────────────────────────────────────────────────────────┐
│  接入层  mcp/（MCP 服务 → 原生工具）                                   │
└──────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│  数据层  models.py（不可变 dataclass） / storage.py（JSON 原子读写）    │
│          paths.py（路径解析） / message_utils.py（消息 ↔ API 格式）    │
└──────────────────────────────────────────────────────────────────────┘
```

### 2.2 模块依赖图（由 import 扫描得出，精确）

```
models.py          ← 零内部依赖（只有 dataclasses）
paths.py           ← 零内部依赖
logging_config.py  ← 零内部依赖
i18n/keys.py       ← 零内部依赖

models.py     ← 被几乎所有模块依赖

storage.py    → models, paths, mcp.config
message_utils → models
api_client    → models, tools.convert, tools.core
prompt_assembler → （无内部依赖）
compact       → api_client, i18n, models, observability.tracing, storage
skills/*      → .models 内部为主；parser → validator
tools/core    → skills.guards        ★ 注意：工具层反向依赖 skill 层（用于运行时守护）
tools/*       → tools.core
tools/sub_agent_tool → storage, subagents.definition_loader, tools.core
mcp/adapter   → tools.core
mcp/manager   → mcp.adapter, mcp.config
subagents/executor → models, storage, tools.core, compact, api_client, .result_compressor
subagents/result_compressor → api_client, compact, models
observability/tracing → observability.{client,config,git_metadata,metrics,sanitize,scoring}, models
query_engine  → api_client, compact, message_utils, models, observability, paths,
                prompt_assembler, skills, storage, tools.core, tools.permission_request
app.py        → 以上全部 + chat_message, file_mentions, i18n, mcp, subagents, paths
```

**唯一的循环依赖点**：`tools/core.py` → `skills/guards.py`。这是刻意的：工具执行器要在门控的第一道关卡评估 skill 运行时守护。复刻时若避免循环依赖，可把守护评估抽成接口注入。

### 2.3 目录 → 职责

| 路径 | 职责 | 详见 |
|------|------|------|
| `src/flyinchat/models.py` | 领域模型（不可变 dataclass） | §3.1 |
| `src/flyinchat/paths.py` | 全局/项目路径解析 | §3.3 |
| `src/flyinchat/storage.py` | JSON 持久化 CRUD + 原子写 + 旧 SQLite 迁移 | parts/01 |
| `src/flyinchat/message_utils.py` | 内部 Message ↔ provider 消息字典 | parts/01 |
| `src/flyinchat/api_client.py` | Anthropic / OpenAI 兼容流式适配 | parts/03 |
| `src/flyinchat/query_engine.py` | **agent 主循环** | parts/02 |
| `src/flyinchat/prompt_assembler.py` | system prompt 分层拼装 | parts/02 |
| `src/flyinchat/compact.py` | token 估算 / 压缩 / 自动续跑 | parts/02 |
| `src/flyinchat/tools/core.py` | Tool 协议 / Registry / Executor / 权限 | parts/04 |
| `src/flyinchat/tools/*_tool.py` | 13 个内置工具（12 个核心 + `sub_agent`） | parts/04 |
| `src/flyinchat/skills/` | 技能加载 / 匹配 / 编译 / 守护 | parts/06 |
| `src/flyinchat/subagents/` | 子代理定义 / 隔离执行 / 结果压缩 | parts/06 |
| `src/flyinchat/mcp/` | MCP 配置 / 生命周期 / 工具适配 | parts/07 |
| `src/flyinchat/observability/` | Langfuse trace 建模 / 脱敏 / 评分 | parts/07 |
| `src/flyinchat/app.py` | Textual TUI 全部 | parts/05 |
| `src/flyinchat/i18n/` | 中英双语字符串 | parts/05 |

---

## 3. 核心数据模型

### 3.1 领域模型（`models.py`，全部 frozen dataclass）

这是**整个系统的词汇表**。复刻时第一步就应该原样重建这些类型。

```python
@dataclass(frozen=True)
class LLMChannel:            # 一个 provider 连接（"渠道"）
    id: str
    name: str
    provider_type: str       # "anthropic" | "openai_compatible"（决定走哪个协议分支）
    base_url: str | None
    api_key: str
    created_at: str
    updated_at: str

@dataclass(frozen=True)
class LLMModel:              # 渠道下的一个具体模型 + 该模型的生成参数
    id: str
    channel_id: str
    name: str
    is_default: bool
    thinking_enabled: bool = True
    reasoning_effort: str = "high"
    context_window: int = 125_000
    max_output_tokens: int = 384_000
    created_at: str = ""
    updated_at: str = ""

@dataclass(frozen=True)
class Conversation:          # 一个会话（一个对话线程）
    id: str
    title: str
    total_output_tokens: int = 0
    last_input_tokens: int = 0
    compacted_message_count: int = 0   # 压缩边界：此序号之前的消息已被摘要
    current_turn: int = 0              # turn 自增计数，用于生成 turn_id
    status: str = "active"
    parent_conversation_id: str = ""   # 非空 = 这是子代理的隔离会话
    agent_type: str = ""               # 子代理角色名
    created_at: str = ""
    updated_at: str = ""

@dataclass(frozen=True)
class Message:
    id: str
    conversation_id: str
    role: str                # "user" | "assistant" | "tool" | "system"
    content: str             # 纯文本，或 JSON 序列化的 content block 数组
    created_at: str
    turn_id: str = ""
    subtype: str = "normal"  # "normal" | "tool_call" | "tool_result" | "interrupted" | ...
    tool_call_id: str | None = None
    meta: str = "{}"         # JSON 字符串
    agent_type: str = ""

@dataclass(frozen=True)
class TurnResult:            # 一次 turn 的最终产物，也是可观测性的输入
    turn_id: str
    status: str              # "completed" | "error" | "cancelled" | "max_rounds"
    final_text: str = ""
    tool_rounds: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    error: str | None = None
    num_turns: int = 0
    max_turns: int = 0
    terminal_reason: str | None = None
    last_tool_error: str | None = None

@dataclass(frozen=True)
class SessionConfigSnapshot: # 会话配置快照（用于展示/审计）
    model_name: str
    channel_name: str
    provider_type: str
    thinking_enabled: bool = True
    reasoning_effort: str = "high"
    context_window: int = 125_000
    max_tool_rounds: int = 10
```

**关键设计点（复刻必须理解）**：

1. **全部 `frozen=True`（不可变）**。状态变更一律是"构造新对象 + 替换引用"，见 `PermissionRequest.with_status()` 的实现模式（`tools/permission_request.py:91-126`：手动 rebuild dataclass）。这是项目的全局编码约束，不是偶然。
2. **`Message.content` 是多态的**：可能是一段纯文本；也可能是 JSON 字符串形式的 content block 数组（`[{"type":"thinking",...},{"type":"text",...},{"type":"tool_use",...}]`）。判定依据是 `subtype`。见 §4.2 的持久化规则。
3. **压缩边界是消息流里的一条标记消息**，不是删除历史。压缩时在流尾部追加两条 `role="system"` 消息：`compact_summary`（摘要正文）+ `compact_boundary`（元数据）。`storage.list_active_messages()` 扫描到第一条 `compact_boundary` 就从那里（或前一条 `compact_summary`）开始返回。`Conversation.compacted_message_count` 只是**记账字段**，不参与边界解析。详见 §4.5.1。
4. **`parent_conversation_id` 就是子代理的挂载点**：子代理跑在自己的 Conversation 里，通过这个字段关联父会话。

### 3.2 磁盘持久化

两份 JSON 文件，**两个作用域**。顶层键名是**兼容性契约**，必须逐字一致（`storage.py:654-668`）：

```jsonc
// ~/.flyinchat/config.json  — 全局（跨项目）
{
  "schema_version": 1,        // _SCHEMA_VERSION = 1
  "llm_channels": [],         // ★ 不是 "channels"
  "llm_models": [],           // ★ 不是 "models"
  "app_settings": {}          // 语言、模式、Langfuse 配置等都塞在这里（扁平 string → string）
  // "mcp_servers": []        // MCP server 列表（默认 store 里不预置该键，按需写入）
}

// <workspace>/.flyinchat/chat.json  — 每项目
{
  "schema_version": 1,
  "conversations": [],        // Conversation 数组；子代理会话也在其中（靠 parent_conversation_id 关联）
  "messages": []              // Message 数组，全局扁平；靠 conversation_id 归属
}
```

注意两个设计点：

1. **`messages` 是扁平的全局数组**，不嵌套在 conversation 里——归属靠每条消息的 `conversation_id` 字段。turns 不是独立集合，而是消息上的 `turn_id` 字段。
2. **`app_settings` 是扁平的 `string → string` 映射**，没有嵌套结构。布尔值也存成字符串（如 `"langfuse_enabled": "true"`），读取时靠 `str(value)` 归一。

**写入契约**：所有写操作必须**原子**——写临时文件后 `os.replace()`。复刻时同样要求：任何时刻崩溃都不能留下半个 JSON。

**读入契约**：所有反序列化必须**对缺失字段容错**（用默认值填充），因为旧版本写的文件会被新版本读。未知字段应被忽略而非报错。`_normalize_*_dict()` 系列函数负责逐字段归一（`storage.py:610-629`）。

**旧 SQLite 迁移是纯历史包袱**：`initialize_config_store` / `initialize_chat_store` 会检查同目录下是否有 `config.sqlite` / `chat.sqlite`，有则迁移（`storage.py:671-720`）。**新项目不需要实现**——除非你要支持从旧版本原地升级。

**实测锚点**（对旧项目自身工作区的一份真实 `chat.json` 做结构抽查，只统计键名与计数，未读取内容）：

```
顶层键:  ['schema_version', 'conversations', 'messages']     ← 与上面的 schema 一致
conversation 字段: agent_type, compacted_message_count, created_at, current_turn, id,
                   last_input_tokens, parent_conversation_id, status, title,
                   total_output_tokens, updated_at        ← 与 Conversation dataclass 完全一致
message 字段:      agent_type, content, conversation_id, created_at, id, meta,
                   role, subtype, tool_call_id, turn_id    ← 与 Message dataclass 完全一致

该文件样本：conversations=5, messages=29
  subtype 分布: permission_event=9, normal=8, skill_event=4, tool_call=4, tool_result=4
  role    分布: system=13, assistant=8, user=4, tool=4
```

两个可直接验证的推论：

1. **`permission_event` + `skill_event` 共 13 条，恰好等于 `role="system"` 的 13 条**——证实这两类 transcript 以 `role="system"` 落盘，并靠 `message_to_api_format` 返回 `None` 被挡在 API 之外（见 §4.5.1）。
2. **`subtype` 全集**超出了 JSON 默认值：实际出现 `permission_event` / `skill_event` / `tool_call` / `tool_result`，加上代码里的 `normal` / `interrupted` / `compact_summary` / `compact_boundary`，构成完整枚举。复刻时 `subtype` 不是自由字符串，应按此枚举建模。

> 完整的 JSON schema、迁移逻辑、`list_active_messages()` 的精确语义见 **parts/01-data-layer.md**。

### 3.3 路径解析（`paths.py`，全文）

```python
@dataclass(frozen=True)
class AppPaths:
    global_dir: Path      # ~/.flyinchat
    project_dir: Path     # <cwd>/.flyinchat
    config_path: Path     # ~/.flyinchat/config.json
    chat_path: Path       # <cwd>/.flyinchat/chat.json

def resolve_app_paths(home=None, cwd=None) -> AppPaths:
    global_dir  = (home or Path.home()) / ".flyinchat"
    project_dir = (cwd  or Path.cwd())  / ".flyinchat"
    return AppPaths(global_dir, project_dir,
                    global_dir / "config.json", project_dir / "chat.json")
```

注意 `resolve_app_paths` 接受注入的 `home` / `cwd`——这是全项目**依赖注入与可测试性**的样板：不直接读全局状态。

**workspace 根目录** = `project_dir.parent`（即 `<cwd>`）。`ToolContext.workspace_root` 与 `PermissionContext.allowed_read_roots/allowed_write_roots` 都锚定在这里。

---

## 4. 端到端数据流

### 4.1 启动序列（`app.py`）

⚠️ **初始化不在 `on_mount()` 里，而在 `compose()` 的开头**——这是一个反常规写法（Textual 的 `compose()` 本该是纯声明式的），复刻时需注意副作用顺序。

```
run()  →  FlyinChatApp(...).run()
  │
  ├─ compose()                        ← app.py:317-336
  │   1. self.paths = initialize_storage(self.paths)   ★ 建目录、建 config.json/chat.json
  │   2. _load_language()              读 app_settings["language"]，初始化 I18nStore；
  │                                    值非法时静默忽略（ValueError → pass）
  │   3. _init_observability()         读 Langfuse 配置 → create_observability_client()；
  │                                    未配置返回 NoopObservabilityClient（enabled=False）
  │   4. _init_tools()                 ★ 注册表初始化，顺序敏感，见下
  │   5. yield 出全部 widget（Header / chat-area / composer / Footer）
  │
  └─ on_mount()                       ← app.py:358-362，只有三件事
      1. query_one("#prompt-input").focus()
      2. _render_status_bar()
      3. _init_mcp_servers()          @work(exclusive=True)，后台异步，不阻塞启动
```

**`initialize_storage()`** 负责创建 `~/.flyinchat/` 与 `<cwd>/.flyinchat/` 目录，并在缺失时写入带默认值的 `config.json` / `chat.json`（含 `app_settings`、空 `channels` / `conversations` 等）。它同时是旧 SQLite 迁移的入口。

**`_init_tools()` 的精确顺序**（`app.py:371-424`）——顺序敏感，复刻必须一致：

```
1. 构造 PermissionContext（初始 = normal 模式的集合）
2. 构造 ToolContext(session_id="flyinchat", user_id="user",
                   workspace_root=<cwd>, permission=<上面那个>)
3. SkillRegistry(workspace).refresh()
4. SubAgentRegistry(workspace).refresh()
5. ToolRegistry() 并按序注册 12 个核心工具：
     FileReadTool, FileWriteTool, FileEditTool, BashTool,
     GlobTool, GrepTool, WebFetchTool, WebSearchTool,
     AskUserQuestionTool, TodoWriteTool,
     EnterPlanModeTool, ExitPlanModeTool
6. ToolExecutor(registry)
7. 注册 SubAgentTool —— ★ 必须在核心工具之后，因为它捕获 registry+executor，
   子代理拿到的是"同一注册表的受限副本"，需要核心工具已就位
8. _apply_mode_permissions()     按当前模式覆盖 PermissionContext
9. query_engine.configure_tools(registry, executor, context)
```

**为什么第 7 步顺序重要**：`SubAgentTool` 构造时接收 `tool_registry` 和 `tool_executor`，子代理执行时按定义裁剪这个注册表。若在核心工具注册前构造，子代理会看不到任何工具。

### 4.2 一次 turn 的完整时序

入口：`QueryEngine.submit_message(user_content, on_event, *, user_message_persisted=False)`。

#### 阶段 A：前置（`submit_message`，`query_engine.py:97-190`）

```
A1. turn_number = storage.increment_turn(chat_path, conversation_id)
A2. turn_id = f"turn_{turn_number}_{conversation_id[:8]}"
A3. 若 user_message_persisted == False：
      持久化 user 消息（role="user", subtype="normal"）
    ★ 这个 flag 的意义：某些调用方（如压缩后重放）已经写过了，避免重复写
A4. emit TurnEvent(turn_id, "turn_start", {turn_number})
A5. primary = storage.get_primary_llm_model(config_path) → (channel, model) | None
A6. trace = AgentTrace.start(...)   ← 可观测性：一个 turn = 一个 trace
A7. 若 primary is None：
      emit "error"，trace.finish(...)，return TurnResult(status="error")
A8. result = await self._run_turn(turn_id, channel, model, on_event)
    任何未捕获异常 → emit "error" + return TurnResult(status="error")
A9. trace.finish(result, task_latency_ms=elapsed_ms)
```

#### 阶段 B：准备上下文（`_run_turn` 开头，`query_engine.py:199-279`）

```
B1. active_messages = storage.list_active_messages(chat_path, conversation_id)
      ★ 只返回压缩边界之后的"活跃"消息
B2. compiled_skill = self._resolve_turn_skills(turn_id, active_messages)
      解析本轮命中的 skill，编译出 planning_injection + runtime_guards
B3. api_messages = [message_to_api_format(m) for m in active_messages if 可转换]
B4. api_messages = sanitize_api_messages(api_messages)
      收敛为合法序列（角色交替、tool_use/tool_result 配对等）
B5. compact_text = _extract_compact_summary(api_messages)
      从历史里取出上一次压缩写入的摘要
B6. api_messages 移除所有 role=="system" 的消息
B7. system_prompt = assemble_system_prompt(mode, compact_summary, skill_injection)
B8. api_messages.insert(0, {"role":"system", "content": system_prompt})
      ★ system prompt 永远是第 0 条，且每轮重新组装（不落盘为 Message）
B9. 若 skill 命中 → emit "skill_resolved"
B10. tool_list = registry.tools
B11. 若 enable_auto_compact：
       policy = CompactionPolicy.from_model(model)
       emit "compact_start" {strategy:"preflight"}
       compact_if_needed_async(active_messages, api_messages, policy, force=False, ...)
       若 applied：用压缩结果重建 active_messages 与 api_messages，
                   trace.mark_compaction(...)
       emit "compact_end" {applied, strategy}
```

#### 阶段 C：主循环（`query_engine.py:364-763`）

循环不变量（一轮开始时的局部状态）：

```
num_turns=0  tool_rounds=0
total_input_tokens=0  total_output_tokens=0
auto_continue_count=0  incomplete_continue_count=0  max_incomplete_continues=3
pending_tool_results=False  finalization_pass=False  last_tool_error=None
base_max_turns = max(1, config.max_turns or config.max_tool_rounds)   # 默认 10
current_max_turns = base_max_turns
compact_retry_remaining = config.max_context_retries                  # 默认 1
```

每一轮的步骤：

```
C1. 【取消检查】若 cancel_event 已置位：
      若 num_turns == 0 → 写一条 assistant/"interrupted"/"[Interrupted]" 消息
      → finish("cancelled", "cancelled", cancelled=True)

C2. 【预算检查】若 num_turns >= current_max_turns：
    C2a. 满足全部条件时自动续跑：
           enable_auto_continue
           and auto_continue_count < max_auto_continues (3)
           and 无 pending 权限请求
           and 无 pending 用户输入
           and 未取消
         → auto_continue_count += 1
         → current_max_turns += max(1, auto_continue_turns)   # +10
         → 向 api_messages 追加一条 user 消息（原文见下）
         → emit "auto_continue"
         → continue（回到 C1）
    C2b. 否则若 pending_tool_results and not finalization_pass：
           finalization_pass = True
           追加一条 user 消息要求"不要再调工具，总结现状"（原文见下）
           ★ 只做一次：它让模型做最后一次不带工具的生成
         否则 → finish("max_rounds", "max_turns")

C3. 每轮重置：text_content="", thinking_blocks=[], tool_uses=[], usage_info={},
             had_incomplete_tool_call=False
    tools_for_call = [] if finalization_pass else tool_list   ★ finalization 传空工具表
    generation = trace.start_generation(name="llm.agent_turn", ...)

C4. 【流式消费】for event in stream_chat_completion(channel, model, api_messages,
                                                    usage_info, tools_for_call):
      if cancel_event: break
      "thinking"            → thinking_blocks.append(event)
                              emit "thinking" {content, preview(前 200 字符 + "...")}
      "reasoning"           → 归一化为 {"thinking": content, "signature": ""} 后 append
                              emit "thinking"（同格式）
      "text"                → text_content += content; emit "text" {content}
      "tool_use"            → tool_uses.append(event); emit "tool_use" {name,id,input}
      "incomplete_tool_call"→ had_incomplete_tool_call = True
    ★ 注意：thinking 与 reasoning 两种 provider 事件在内部被统一成同一个
      thinking_blocks 结构，对 UI 也发同一个 "thinking" 事件

C5. 【异常处理】流式调用抛异常时：
      若 compact_retry_remaining > 0 且 错误文本命中上下文超限特征
        （"context_length_exceeded" / "413" / "too long" / "maximum context length"）：
          compact_retry_remaining -= 1
          emit "compact_start" {strategy:"reactive"}
          reactive_compact(all_messages, api_messages, policy, model, channel, reason=error)
          若 applied → trace.mark_compaction(...)，用结果重建 api_messages
                       → emit "compact_end" {applied:True}
                       → continue（重试本轮）
          否则 emit "compact_end" {applied:False}
      emit "error" {message}
      → finish("error", "error", error=...)

C6. 【finally 块，每轮必执行】—— 记账，无论成功失败
      anthropic:  total_output_tokens += usage_info["output_tokens"]
                  total_input_tokens  = usage_info["input_tokens"]      ← 赋值非累加
      else（含 openai_compatible）: total_output_tokens += usage_info["completion_tokens"]
                  total_input_tokens  = usage_info["prompt_tokens"]     ← 赋值非累加
      ★ 语义：input_tokens 是"最近一次请求的输入量"（快照），
             output_tokens 是"本 turn 累计输出量"（累加）。不是笔误。
      【兜底】若 total_input_tokens == 0 且 api_messages 非空：
              total_input_tokens = TokenEstimator().estimate_api_messages(api_messages)
              ★ 因为 DeepSeek 等 provider 的 Anthropic 兼容 SSE 可能不报 input_tokens
      storage.update_conversation_usage(...)
      generation.finish(output=..., usage_info=..., input_tokens=..., output_tokens=...,
                        error=generation_error)

C7. num_turns += 1; pending_tool_results = False

C8. 【取消复查】若已取消：persist_normal_message(...) → finish("cancelled",...)

C9. 【finalization 越界】若 finalization_pass and tool_uses 非空：
      ★ 模型在被要求"不要调工具"后仍调了工具 → 放弃
      reason = "auto_continue_limit_reached" 或 "max_turns"
      → finish("max_rounds", reason)

C10. 【无工具调用分支】if not tool_uses:
     C10a. had_incomplete_tool_call and incomplete_continue_count < 3：
             incomplete_continue_count += 1
             persist_normal_message(...)
             追加 assistant 消息（本轮产出）+ user 消息（要求续跑，原文见下）
             → continue
     C10b. had_incomplete_tool_call（次数用尽）：
             persist_normal_message(...) → finish("max_rounds",
                                                 "incomplete_tool_call_limit_reached",
                                                 final_text=text_content)
     C10c. persist_normal_message(...)
           若 finalization_pass → finish("max_rounds", reason, final_text=text_content)
           否则                → finish("completed", "completed", final_text=text_content)
     ★ 终止的真正条件是"模型这一轮没有请求任何工具"

C11.【有工具调用 → 持久化助手消息】
     assistant_content = thinking_blocks（规范化为 {"type":"thinking","thinking","signature"}）
                       + [{"type":"text","text":...}]（若有文本）
                       + [{"type":"tool_use","id","name","input"} for each tool_use]
     持久化 assistant 消息（subtype="tool_call"，content=json.dumps(assistant_content)）
     api_messages.append({"role":"assistant", "content": assistant_content})
     tool_rounds += 1

C12.【串行执行工具】for tu in tool_uses:      ← 顺序执行，非并发
       tool_result = await _execute_tool(turn_id, tu.name, tu.input, tu.id, on_event)
       ok  → last_tool_error = None
       !ok → last_tool_error = error_code or "TOOL_ERROR"
       api_messages.append({"role":"tool", "tool_use_id": tu.id,
                            "content": tool_result["content"]})
       emit "tool_result" {tool_use_id, name, ok, content, error_code}

C13. pending_tool_results = True；回到 C1
```

**三条自动注入的 user 提示词**（原文，复刻必须逐字一致——它们直接改变模型行为）：

1. **turn 预算耗尽自动续跑**（C2a）：
   ```
   Continue the user's original task from the latest tool results. Do not repeat
   completed work. If you have enough information, provide the final answer. Use
   more tools only when necessary and continue to follow the existing permission
   requirements.
   ```
2. **finalization pass**（C2b）：
   ```
   The automatic turn budget is exhausted. Do not call tools. Summarize what has
   been completed, explain the latest tool result, name any blocker, and list the
   remaining work clearly.
   ```
3. **工具调用被截断后重试**（C10a）：
   ```
   Your last response was cut off mid-stream — the tool call JSON was incomplete.
   Please continue exactly where you left off and complete the tool call you started.
   ```

**`persist_normal_message` 的持久化规则**（`query_engine.py:308-323`）：

```
若 thinking_blocks 和 text_content 都为空 → 不写任何消息
若 thinking_blocks 非空 → content = json.dumps([thinking..., text...])   ← JSON 数组
否则                    → content = text_content                          ← 纯文本
subtype = "normal", role = "assistant"
```

#### 阶段 D：TurnEvent 完整事件表

**恰好 13 种**（对 `query_engine.py` 全量解析 `TurnEvent(turn_id, "<type>")` 得到的完备集合）：

```
auto_continue, compact_end, compact_start, error, permission_required,
skill_resolved, text, thinking, tool_result, tool_use,
turn_end, turn_start, user_input_required
```

下表按**发出时机**排列（非字典序）。

| event_type | 发出者 | data 字段 | TUI 反应（`app.py:486-537`） |
|-----------|--------|-----------|---------------------------|
| `turn_start` | submit_message | `turn_number` | 清空流式缓冲、清空 todo、隐藏空状态、重绘 todo 面板 |
| `thinking` | _run_turn C4 | `content`, `preview` | **`pass`（不渲染）** |
| `text` | _run_turn C4 | `content` | 追加到 `_streaming_assistant_text`，估算 output tokens（`len//4`），重绘流式区与状态栏 |
| `tool_use` | _run_turn C4 | `name`, `id`, `input` | **`pass`** |
| `tool_result` | _run_turn C12 | `tool_use_id`, `name`, `ok`, `content`, `error_code` | 仅当 `name == "todo_write"` 时刷新 todo 面板 |
| `skill_resolved` | _run_turn B9 | `applied_skills`, `active_phase`, `guards_applied` | 重绘历史 + 状态栏 |
| `compact_start` | _run_turn B11 / C5 | `strategy`（`"preflight"` \| `"reactive"`） | `_compacting = True`，重绘状态栏 |
| `compact_end` | _run_turn B11 / C5 | `applied`, `strategy` | `_compacting = False`，重绘状态栏 |
| `auto_continue` | _run_turn C2a | `count`, `additional_turns`, `num_turns`, `base_max_turns`, `max_turns`, `current_max_turns` | **未处理**（落到 match 的默认分支） |
| `permission_required` | _handle_permission_required | 见 §4.4 | 弹出权限对话框 |
| `user_input_required` | _handle_user_input_required | ask_user_question 的题目 | 弹出表单 |
| `turn_end` | `finish()` | `status`, `terminal_reason`, `final_text`, `tool_rounds`, `num_turns`, `base_max_turns`, `max_turns`, `current_max_turns`, `auto_continue_count`, `last_tool_error`, `input_tokens`, `output_tokens`, （`cancelled` 条件存在） | 记录 token、停 spinner、重绘历史与状态栏；若 `cancelled` 且有排队 prompt 则继续提交 |
| `error` | submit_message / C5 | `message` | 停 spinner；若有排队 prompt 则继续提交 |

> ⚠️ `thinking` 与 `tool_use` 被 TUI 显式忽略（`pass`）——因为历史消息重绘时会从 storage 读出完整的 content blocks 渲染，流式阶段不重复渲染。复刻时这是一个**可以改进但不应误判为 bug** 的点。

**`finish()` 是一个闭包**（`query_engine.py:325-362`），它统一负责：发出 `turn_end` 事件 + 构造 `TurnResult`。所有终止路径都必须经过它。

### 4.3 工具执行的三级门控流水线

`ToolExecutor.execute()`（`tools/core.py:159-223`）是**唯一**的入口。判定顺序：

```
① 查表：registry.get(tool_name) → KeyError 则返回 TOOL_NOT_FOUND（并 emit tool.error）

② 【第一级】Skill 运行时守护
   skill_gate = evaluate_skill_guards(guards_from_turn_state(context.turn_state),
                                      tool_name, tool_input, context)
   若 !allowed：
     error_code = PERMISSION_REQUIRED（若 guard.ask_user）或 "SKILL_GUARD_DENIED"
     把 guard_id / skill_name / guard_type / guard_reason 写进 result.meta
     → 直接返回，不进入第 ③④ 级

③ 【第二级】模式权限策略 _tool_allowed(tool_name, context)：
     if tool_name in permission.denied_tools        → 拒绝（PERMISSION_DENIED）
     if permission.allowed_tools is not None
        and tool_name in permission.allowed_tools   → 放行
     if tool_name in permission.ask_tools           → ask_user
     if tool_name.startswith("mcp_")                → ask_user   ★ MCP 工具默认需审批
     if permission.allowed_tools is None            → 放行（yolo 模式：None = 全允许）
     否则                                            → 拒绝（"tool not in allow list"）

    若判定为 ask_user：
      再查 _is_tool_auto_allowed(tool_name, tool_input)：
        - tool_name 在 _auto_allow_tools（MCP 显式 auto-allow）
        - 或 command 命中白名单（仅 bash，见下）
      命中 → 跳过审批直接执行
      未命中 → 返回 ToolResult(ok=False, error_code=PERMISSION_REQUIRED)
               result.meta["tool_name"] / ["tool_input"]  ← 权限系统需要它们

④ 【第三级】工具自检 tool.requires_permission(tool_input, context)
   同样区分 ask_user（→ PERMISSION_REQUIRED）与直接拒绝（→ PERMISSION_DENIED）

⑤ 执 tool.run(tool_input, context)
   异常 → ToolResult(ok=False, error_code="TOOL_RUNTIME_ERROR",
                     content=f"{type(e).__name__}: {e}")
   成功/失败都要：result.meta["elapsed_ms"] = elapsed_ms，emit "tool.complete"
```

**`execute_approved()`（`tools/core.py:225-281`）的差异**：跳过第 ③④ 级（人工已批准），但**仍然执行第 ② 级 skill 守护**——只是把"ask_user 型守护"视为通过（`if not skill_gate.allowed and not skill_gate.ask_user`）。

**bash 命令白名单有两层，语义不同，不要混淆**（复刻时两层都要实现）：

**第一层：`ToolExecutor.command_auto_allowlist`**（`tools/core.py:127-138`）——决定**"本来要审批的命令能否免审批"**：

```
仅对 tool_name == "bash" 生效
cmd = tool_input["command"].strip()   （空则不放行）
对白名单中每个 pattern：
    命中 ⟺ cmd == pattern  或  cmd.startswith(pattern + " ")
```

即**前缀 + 空格边界**匹配，不是子串、不是正则。因此 `git status` 命中，`git statusfoo` 不命中。种子白名单 `SEED_AUTO_ALLOW_PATTERNS`（`tools/core.py:17-27`）：

```
ls, cat, head, tail, wc, grep, rg, find,
echo, date, pwd, which, file, stat, sort, uniq,
du, df, ps, env, printenv, tree,
basename, dirname, realpath, readlink,
cut, tr, diff, jq,
md5sum, sha1sum, sha256sum,
git status, git log, git diff, git show, git branch,
git stash list, git remote, git ls-files, git tag,
git rev-parse, git config --get
```

**第二层：`BashTool` 自检**（`tools/bash_tool.py:20-47, 67-98`）——决定**这项操作本身是否安全**，位于门控第 ④ 级：

```
DENIED_PATTERNS 是**子串包含**检查（pattern in cmd），命中即硬拒：
    "rm -rf /", "rm -rf ~", "rm -rf .", "sudo ", "su ", "chown", "mkfs",
    "dd if=", ">:", "| sh", "$(", "`", "/etc/passwd", "/etc/shadow", "~/.ssh"
  ★ 子串匹配会误伤：echo "rm -rf /" 也会被拒（已知取舍）

然后按分隔符正则 _CMD_SEPARATOR = r'\s*(?:&&|\|\||[;&|\n])\s*' 拆段，
逐段 shlex.split，检查首段基名 base：
    base ∈ ALLOWED_COMMANDS  或  base.startswith("./") / startswith("/")
      → 该段通过
    否则 → PermissionDecision(False, "command not in allowlist: {base}", ask_user=True)
  shlex.split 抛 ValueError（如未闭合引号）→ 硬拒
```

`BashTool.ALLOWED_COMMANDS`（注意与第一层不同，这里含 `rm`、`python`、`npm` 等）：

```
ls, cat, head, tail, find, grep, wc, sort, uniq, echo, pwd, date, env,
git, python, python3, pip, npm, npx,
mkdir, cp, mv, rm, touch, chmod,
diff, patch, tar, zip, unzip, curl, wget,
make, cargo, go, node, tsc,
cd, gcc, g++, clang, clang++, cmake,
./a.out, ./vector_demo, ./demo, ./test
```

**两层协同的实际效果**（以 normal 模式为例，bash 在 `ask_tools`）：

| 命令 | 第①层（免审批？） | 第④层（安全？） | 最终 |
|------|------------------|----------------|------|
| `ls -la` | 命中 `ls` → 免审批 | `ls` 白名单 → 通过 | **直接执行** |
| `git status` | 命中 → 免审批 | `git` 在白名单 → 通过 | **直接执行** |
| `rm -rf /tmp/x` | 无 `rm` 前缀 → **不**免审批 | — | **弹权限框** |
| `sudo ls` | 无前缀命中 | `sudo ` 子串 → 硬拒 | **拒绝** |
| `echo x > /etc/passwd` | 命中 `echo` → 免审批 | 重定向不在分隔符内，基名仍是 `echo` → 通过 | **直接执行** ⚠️ 已知缺口 |
| `cmd \| bash` | 无前缀命中 | `\| sh` 不匹配；拆段后 `bash` 不在白名单 → ask_user | **弹权限框** |

> ⚠️ 第三行值得注意：`rm` 在 `BashTool.ALLOWED_COMMANDS` 里，所以第④层认为安全；但第①层没有 `rm` 前缀，因此仍需人工审批。**两层结论不一致时，第①层（更严格）说了算**——这正是"纵深防御"的体现，复刻时必须保留两层而不要合并。

**路径逃逸防护**（`tools/core.py:336-350`，两个自由函数，供所有文件类工具复用）：

```python
def normalize_path(path_str, workspace_root) -> Path:
    p = (workspace_root / path_str).resolve() if 相对 else Path(path_str).resolve()
    ws = workspace_root.resolve()
    if p != ws and ws not in p.parents:
        raise PermissionError(f"path escapes workspace: {p}")
    return p

def path_allowed(path, roots) -> bool:      # 用于 allowed_read_roots / allowed_write_roots
    rp = path.resolve()
    return any(rp == rr or rr in rp.parents for rr in roots)
```

### 4.4 权限往返（异步 Future 桥）

这是**引擎与 UI 之间唯一的双向交互**，复刻时必须精确还原。

```
引擎侧（_handle_permission_required, query_engine.py:914+）：
  1. 从 registry 取 tool，读 risk_level（缺失则 "medium"）
  2. args_preview = sanitize_args(tool_input, max_value_len=80)
       → "k1=v1, k2=v2"，每个值超过 80 字符截断加 "..."
  3. request = PermissionRequest.create(session_id=conversation_id, turn_id,
                    tool_call_id, tool_name, args_preview, risk_level,
                    reason=execute_result.content, timeout_seconds=120.0)
  4. request = request.with_status(PENDING_USER_APPROVAL)   ← 状态机校验转换合法性
  5. permission_store.save(request)
  6. 写权限 transcript 消息（"permission_request_created"）
  7. future = loop.create_future(); self._pending_permissions[request.request_id] = future
  8. emit TurnEvent("permission_required", {...})     ← UI 弹窗
  9. await future                                       ← 挂起整个 turn

UI 侧（app.py）：
  收到 "permission_required" → _show_permission_request(data) 弹对话框
  用户选择 → _resolve_pending_permission(resolution)
           → 调 query_engine.resolve_permission(request_id, resolution)

引擎侧（resolve_permission, query_engine.py:1223）：
  从 _pending_permissions 取 future，set_result(resolution)，从字典移除

引擎侧恢复：
  按 resolution 分支：
    - 批准 → executor.execute_approved(...) → _persist_tool_result(...)
    - 拒绝 → 写一条 tool 结果消息（内容为拒绝说明）返回给模型，让模型自行调整
```

**`PermissionRequest` 状态机**（`tools/permission_request.py:13-44`）——转换表是**强校验**的，非法转换抛 `ValueError`：

```
CREATED ──→ PENDING_USER_APPROVAL
PENDING_USER_APPROVAL ──→ APPROVED | DENIED | EXPIRED | CANCELLED
APPROVED ──→ EXECUTED | FAILED_AFTER_APPROVAL

终态集合 _TERMINAL_STATES = {DENIED, EXPIRED, CANCELLED, EXECUTED, FAILED_AFTER_APPROVAL}
```

`with_status()` 会自动填充：APPROVED/DENIED → `resolved_at=now, resolved_by="user", resolution=status.name.lower()`；EXPIRED → `resolved_by="system", resolution="timeout"`；CANCELLED → `resolved_by="system", resolution="cancel"`。

Store 还提供 `list_pending()` / `cancel_all_pending()` / `expire_stale()`。

> 完整的 UI 侧状态机（对话框状态、多请求排队、always-allow 记忆）见 **parts/05-tui.md**；完整的引擎侧分支见 **parts/02-agent-loop.md**。

### 4.5 上下文压缩

两套机制，**同一套策略对象** `CompactionPolicy.from_model(model)` 派生阈值：

| 机制 | 触发 | 策略标记 | 行为 |
|------|------|---------|------|
| **preflight** | 每轮开始前，若 `enable_auto_compact` | `"preflight"` | `compact_if_needed_async(..., force=False)` —— 预判超预算才压 |
| **reactive** | 流式调用抛异常且错误文本命中上下文超限 | `"reactive"` | `reactive_compact(..., reason=error)` —— 已经炸了，被迫压 |
| **manual** | 用户执行 `/compact` | — | `force=True` |

**核心策略对象**（`compact.py:79-96`，全部阈值原样保留）：

```python
@dataclass(frozen=True)
class CompactionPolicy:
    context_window: int
    tool_result_budget_chars: int = 8_000     # 单条工具结果字符预算
    soft_limit_ratio: float = 0.70
    preserve_turns: int = 4                   # 压缩时保留的最近 turn 数

    @property
    def soft_limit(self) -> int: return int(self.context_window * self.soft_limit_ratio)
    @property
    def hard_limit(self) -> int: return self.context_window

    @classmethod
    def from_model(cls, model): return cls(context_window=model.context_window)
```

**Token 估算器是 CJK 感知的**（`compact.py:45-76`）——这是中文场景的关键，复刻时不能简单用 `len/4`：

```python
# 正则覆盖 CJK 统一表意文字、扩展区、兼容区、符号标点区
_CJK_RE = re.compile(r"[⺀-⻿　-〿㇀-㇯㐀-䶿一-鿿豈-﫿︰-﹏＀-￯]")

@dataclass(frozen=True)
class TokenEstimator:
    cjk_weight: float = 1.5      # CJK 字符 ≈ 1.5 token
    other_weight: float = 0.3    # 非 CJK 字符 ≈ 0.3 token（保守偏高，因为 JSON 结构符单独成 token）

    def estimate(self, text: str) -> int:
        if not text: return 0
        cjk_count = len(_CJK_RE.findall(text))
        other_count = len(text) - cjk_count
        return max(1, int(cjk_count * self.cjk_weight + other_count * self.other_weight))
```

三个入口：`estimate(text)` / `estimate_messages(messages)`（对 `content` 求和）/ `estimate_api_messages(api_messages)`（对 `json.dumps(m, ensure_ascii=False)` 求和）。§4.2 的 C6 兜底用的是 `estimate_api_messages`。

**压缩是级联的两级策略**（`compact.py:131-154`，async 版与 sync 版逻辑完全一致）：

```
estimated = estimate_messages(messages)

① 若 force 或 estimated > soft_limit（= 0.7 × context_window）：
     执行 _apply_tool_result_budget —— 软截断：按 8000 字符预算裁剪超长工具结果
     若 applied → 直接返回（★ 一级就够了，不进 LLM 摘要）
   ★ 注意：软截断优先，且只要它生效就不再往下走

② 若 estimated > hard_limit（= context_window）
   或（force 且 model 与 channel 均非空）：
     执行 _autocompact —— 硬压缩：调 LLM 生成历史摘要，
       写入 compact 记录，推进 compacted_message_count 边界
     若 model 或 channel 缺失 → 返回 applied=False（无法摘要，放弃）

③ 否则：applied=False，原样返回
```

**两级的分工**：软限制**不改消息数量**，只裁长内容，便宜；硬限制才真正调用 LLM 生成摘要并移动边界，昂贵。因此日常超预算是软截断兜住，只有逼近硬上限才付摘要成本。

**摘要提示词是多语言的**：`CompactionEngine` 持有一个 `_i18n: I18nStore`（`compact.py:104`），硬压缩的摘要提示词来自 i18n 而不是硬编码字符串——所以摘要语言跟随用户的语言设置。复刻时不要把摘要提示词写死成英文。

#### 4.5.1 压缩边界的精确机制

**边界是数据，不是删除。** 硬压缩成功后向消息流尾部追加两条 `role="system"` 的消息（`compact.py:262-297`）：

```jsonc
// 消息 1：摘要正文（compact.py:262-271）
{"id": "...", "conversation_id": "...", "role": "system",
 "content": "{\"type\":\"compact_summary\",\"summary\":\"<LLM 生成的摘要>\",\"summarized_count\":<被摘要的消息数>}"}

// 消息 2：边界元数据（compact.py:285-297），紧跟在摘要之后
{"role": "system",
 "content": "{\"type\":\"compact_boundary\",\"boundary_id\":\"<uuid4>\",\"strategy\":\"autocompact_v1\",
             \"source_range_from\":\"<被摘要首条消息 id>\",\"source_range_to\":\"<被摘要末条消息 id>\",
             \"preserved_head_ids\":[...],\"preserved_tail_id\":\"...\",\"summary_msg_id\":\"<摘要消息 id>\",
             \"tokens_before\":N,\"tokens_after\":N}"}
```

**`list_active_messages()` 的解析算法**（`storage.py:557-588`）：

```
1. all_msgs = list_messages(chat_path, conversation_id)
2. 线性扫描 all_msgs，找**第一条**边界消息：
     命中条件（二者之一）：
       msg.subtype == "compact_boundary"                    ← ★ 实际永不命中，见下
       json.loads(msg.content) 是 dict 且 parsed["type"] == "compact_boundary"   ← 真正生效的分支
     解析失败（JSONDecodeError/TypeError）→ 跳过，继续扫
     找到第一条即 break        ★ 注意是 first，不是 last
3. 若未找到边界 → 返回全部消息
4. start = boundary_idx
   若 start > 0 且前一条是 compact_summary
      （同样有 subtype 与 content.type 两套判定，同样只有后者生效）
       → start = boundary_idx - 1        ★ 把摘要本身也纳入活跃区
5. 返回 all_msgs[start:]
```

> ⚠️ **`subtype` 分支是死代码**：`compact.py:262-297` 调 `add_message()` 写这两条消息时**没有传 `subtype`**，于是取默认值 `"normal"`（`storage.py:409`）。因此磁盘上 `compact_summary` 与 `compact_boundary` 两条消息的 `subtype` **都是 `"normal"`**，检测**完全依赖 `content` 里的 `type` 字段**。
>
> 复刻时两种做法都可以（按 `content.type` 判、或补上正确的 `subtype` 并两边都判），但**必须保证写入方与读取方一致**——旧项目的现状是"读写不一致但恰好能工作"。若你只实现了 `subtype` 分支而沿用旧的写入逻辑，压缩边界将**完全失效**。

**为什么摘要要纳入活跃区**：摘要必须是"活跃"的，否则它不会出现在 API 请求里，模型就彻底丢失了历史。

**完整链路**（每一跳都在 `message_utils.py:26-46`）：

```
storage 里的 compact_summary 消息（role="system"）
  → message_to_api_format(msg)
       role="system" 且 content.type=="compact_summary"
       → {"role": "system", "content": parsed["summary"]}          ← 提取出纯摘要文本
  → _extract_compact_summary(api_messages)                           ← 拼接所有 system 消息
  → assemble_system_prompt(mode, compact_summary=...)                ← 变成一个段落
  → api_messages.insert(0, {"role":"system", "content": system_prompt})
```

**同一函数里的两条排除规则**（复刻时必须一致，否则会污染 API 请求）：

| 输入 | 返回 | 原因 |
|------|------|------|
| `subtype ∈ {"permission_event", "skill_event"}` | `None` | 这些是**纯 UI 记录**（权限往返、skill 命中的 transcript），不送给模型 |
| `content.type == "compact_boundary"` | `None` | 边界是元数据，不是模型输入（但 `compact_summary` 要送，见上） |

`query_engine.py:203-207` 用 `if (formatted := ...) is not None` 过滤掉这些 `None`——所以 transcript 类消息不会进入 `api_messages`。

**摘要如何进入 system prompt**（`query_engine.py:211-218` + `1264-1272`）：

```
compact_text = _extract_compact_summary(api_messages)
  → 遍历 api_messages，拼接**所有** role=="system" 消息的 content，用 "\n\n" 连接
api_messages = [m for m in api_messages if m.get("role") != "system"]   ★ 抽干
system_prompt = assemble_system_prompt(mode, compact_summary=compact_text, ...)
api_messages.insert(0, {"role":"system", "content": system_prompt})     ★ 放回第 0 条
```

所以压缩摘要的最终形态是 system prompt 里的一个段落（标题 `Historical summary (compacted conversation):`，见 §4.2 的分层结构）。

> ⚠️ **需要验证的边界行为**：`list_active_messages()` 只找**第一条**边界。多次压缩后流里会有多条 `compact_boundary` / `compact_summary`，此时返回的活跃区**包含后续所有边界与摘要**，而 `_extract_compact_summary()` 又会拼接**所有** system 消息——即多次压缩后 system prompt 里会累积多段历史摘要。这可能是有意的"分层摘要"，也可能是缺陷。**复刻前建议先在旧项目上跑一次双重压缩实测**（`/compact` 两次后观察第 0 条 system 消息），再决定按累积还是只取最新实现。

**`compacted_message_count`** 由 `storage.update_conversation_compacted_count(chat_path, conversation_id, count)`（`storage.py:542-554`）写入，仅供 UI/审计展示，**不参与任何边界判定**。复刻时不要误用它来做裁剪。

**压缩产物记录**：`CompactionOutput`（`applied` / `messages` / `boundary_message` / `tokens_before` / `tokens_after` / `strategy`）与 `CompactMetadata`（`boundary_id` / `strategy` / `source_range_from` / `source_range_to` / `preserved_head_ids` / `preserved_tail_id` / `summary_msg_id` / `tokens_before` / `tokens_after`）。`_find_split_index(messages, preserve_turns)` 决定切分点。

**reactive 路径的关键细节**（`query_engine.py:550-584`）：它读的是 `list_messages()`（**全部**消息，含已被压缩的），而 preflight 读的是 `active_messages`。压缩成功后用 **切片赋值** `api_messages[:] = [...]` 就地替换（因为 `api_messages` 已被闭包捕获），然后 `continue` 重试本轮——**`num_turns` 不递增**，所以重试不消耗 turn 预算。

**自动续跑的三个独立计数器**（容易混淆，务必分清）：

| 计数器 | 上限 | 触发条件 | 递增后行为 |
|--------|------|---------|-----------|
| `auto_continue_count` | `max_auto_continues` = 3 | `num_turns >= current_max_turns` | `current_max_turns += auto_continue_turns`（默认 +10），追加提示词 1 |
| `incomplete_continue_count` | 硬编码 `max_incomplete_continues` = 3 | 流中检测到 `incomplete_tool_call` 且本轮无完整工具调用 | 追加提示词 3，continue（**不增加 turn 预算**） |
| `compact_retry_remaining` | `max_context_retries` = 1 | 上下文超限异常 | reactive 压缩后 continue |

> 完整的 token 估算公式、截断算法、摘要提示词原文、阈值常量见 **parts/02-agent-loop.md**。

### 4.6 Skill 与 Sub-agent

#### 4.6.0 子代理执行概览

`sub_agent` 工具 → `SubAgentTool` → `subagents/executor.py`：

```
1. 按 definition 从 SubAgentRegistry 取定义（名称、描述、允许工具、system prompt、模型）
2. 建立隔离的 Conversation（parent_conversation_id = 父会话 id，agent_type = 角色名）
3. 从父注册表裁出受限子注册表（见下）
4. 用独立的消息序列跑自己的 agent 循环（复用 api_client.stream_chat_completion）
5. 结果经 SubAgentResultCompressor 压缩后，作为 sub_agent 工具的结果返回给父 turn
```

**受限工具注册表**（`subagents/executor.py:294-301`）：

```python
allowed = set(definition.allowed_tools) - set(definition.disallowed_tools)
allowed.discard("sub_agent")          # ★ 永远移除，防止子代理无限递归派生子代理
registry = ToolRegistry()
for tool in self.tool_registry.tools:
    if tool.name in allowed:
        registry.register(tool)
```

**受限权限上下文**（`_build_restricted_permission`，`subagents/executor.py:359-398`）——这里有一条**关键安全属性**：

```python
parent_available = set(definition.allowed_tools)
if parent.allowed_tools is not None:
    parent_available &= set(parent.allowed_tools) | set(parent.ask_tools)   # ★ 与父模式求交

effective_denied  = set(parent.denied_tools) | set(definition.disallowed_tools) | {"sub_agent"}
effective_allowed = (set(definition.allowed_tools) & parent_available) - effective_denied
```

| 属性 | 实现方式 | 为什么重要 |
|------|---------|-----------|
| **子代理永不越权** | `allowed_tools` 与父模式的可用集合**求交集** | 父会话处于 plan 模式（禁写）时，子代理即使定义里允许 `file_write` 也拿不到——**委派不能提升权限**。复刻时若漏掉这个交集，就是一个提权漏洞 |
| **子代理不弹权限框** | `ask_tools=set()`（空集） | 子代理无人值守运行，无法交互审批；不在 `allowed_tools` 里的工具直接以 `PERMISSION_DENIED` 失败，由子代理自行调整策略 |
| **只读模式** | `permission_mode == "readonly"` 时把 `allowed_write_roots` 设为一个**不存在的哨兵路径** `<ws>/.flyinchat/__subagent_write_denied__` | 借 `path_allowed()` 自然返回 False 来拒绝一切写入，无需额外分支判断 |
| **路径收窄** | `_resolve_allowed_roots()` 把 `allowed_paths` 解析后**再次校验不逃逸 workspace**，非法则忽略；结果为空则回落 `[workspace]` | 子代理的 `allowed_paths` 参数来自模型，属不可信输入 |

#### 4.6.1 Skill 匹配算法（`skills/resolver.py`）

**完全确定性，无 LLM 参与**。分词 → 加权计分 → 排序取前 K：

```python
_TOKEN_RE = re.compile(r"[a-z0-9_\-/]+")      # ★ 纯 ASCII，见下方警告

def resolve(query, catalog, *, top_k=3) -> SkillDecision:
    scored = [(skill, _score_skill(query, skill)) for skill in catalog.loaded_skills]
    scored.sort(key=lambda i: (-i[1], -i[0].manifest.priority, i[0].manifest.name))
    selected = tuple(s for s, score in scored if score > 0)[:top_k]
    confidence = min(1.0, scored[0][1] / 12)   # 满分 12 视为置信度 1.0
```

计分权重（`_score_skill`，`resolver.py:51-63`）——**在 `manifest.priority` 上叠加**：

| 匹配来源 | 权重 |
|---------|------|
| `triggers` | **5**（最高） |
| `name` tokens | 4 |
| `tags` | 4 |
| `description` tokens | 3 |
| `when_to_use` 段落 | 2 |
| `workflow` 段落 | 1 |
| `priority` | 直接相加（可正可负） |

命中条件是**集合成员判定**（`token in query_tokens`），不是子串、不是正则；同一 token 出现多次只算一次。

> ⚠️ **ASCII-only 分词是一个实际限制**：`_TOKEN_RE` 只匹配 `[a-z0-9_\-/]`，**完全不匹配中文字符**。因此中文 query 几乎产生不了 token，只能靠 query 里夹杂的 ASCII（文件路径、命令名、英文技术词）命中 skill。对一个中英双语界面的应用来说这是明显缺口。复刻时若目标用户含中文，建议扩展为正则包含 CJK 区间（可参考 §4.5 的 `_CJK_RE`），但要注意这会**改变 skill 命中行为**，需同步更新回归测试。

`top_k` 默认 3，被 `QueryEngine._resolve_turn_skills()` 调用；未被选中的 skill 会以 `RejectedSkill(name, score, reason)` 记录原因（`"lower ranked candidate"` 或 `"no trigger matched"`）。

#### 4.6.2 深入阅读

`sub_agent` 工具的输入 schema、内置 4 个角色的定义与 system prompt、结果压缩算法，以及 skill 的 frontmatter 规范、编译与运行时守护规则，见 **parts/06-skills-subagents.md**。

**系统提示词里对模型的委派指导**（`prompt_assembler.py:55-61`，原文）：

```
Sub-agent delegation:
- Use the sub_agent tool when a sub-task would produce large search/log/tool output, needs independent investigation, or benefits from a specialized role.
- Available built-in roles: general-purpose, code-reviewer, debugger, test-runner.
- The sub-agent task must be self-contained; do not assume it has the full parent conversation.
- Pass only selected context that is necessary for the delegated task.
- Sub-agent results are summaries, not ground truth. Verify important findings before acting on them.
- Do not use sub_agent for trivial single-file reads, small direct edits, or questions that need immediate user clarification.
```

内置 4 个角色定义在 `src/flyinchat/subagents/builtin/*.md`。

> 详见 **parts/06-skills-subagents.md**。

---

## 5. 权限矩阵（精确表）

`app.py:2160-2199` 的 `_apply_mode_permissions()` 是**唯一权威**。三种集合语义：

- **auto-allow**：在 `allowed_tools` 集合中 → 直接执行
- **ask**：在 `ask_tools` 集合中 → 弹权限对话框
- **deny**：在 `denied_tools` 集合中 → 直接拒绝（优先级最高）
- **特例**：`allowed_tools = None` → 全放行（仅 yolo）

| 工具 | normal (0) | auto_edit (1) | yolo (2) | plan (3) |
|------|-----------|---------------|----------|----------|
| `file_read` | allow | allow | allow | allow |
| `glob` | allow | allow | allow | allow |
| `grep` | allow | allow | allow | allow |
| `todo_write` | allow | allow | allow | allow |
| `ask_user_question` | allow | allow | allow | allow |
| `sub_agent` | allow | allow | allow | allow |
| `file_write` | **ask** | allow | allow | **deny** |
| `file_edit` | **ask** | allow | allow | **deny** |
| `bash` | **ask** | **ask** | allow | **ask** |
| `web_fetch` | **ask** | **ask** | allow | **ask** |
| `web_search` | **ask** | **ask** | allow | **ask** |
| `enter_plan_mode` | **ask** | **ask** | allow | allow |
| `exit_plan_mode` | **ask** | **ask** | allow | allow |
| 任意 `mcp_*` | ask | ask | allow¹ | ask |

¹ yolo 模式下 `allowed_tools=None` 会先于 `mcp_` 前缀检查放行（`tools/core.py:148` 的 allow 判定在 `:153` 的 mcp_ 判定之前），所以 MCP 工具在 yolo 下自动放行。

**模式显示**（`app.py:2141-2158`）：`0`→normal/`#7dd3fc`，`1`→auto_edit/`#fbbf24`，`2`→yolo/`bold #dc2626`，`3`→plan/`#60a5fa`。

**模式切换与生命周期**（`app.py:591-597`）：

```python
if event.key == "shift+tab":
    event.prevent_default()
    self._mode = (self._mode + 1) % 4      # 循环 0→1→2→3→0
    self._apply_mode_permissions()          # 立即重建权限集合
    self._render_status_bar()
```

⚠️ **模式是会话级内存状态，不持久化**：`self._mode: int = 0`（`app.py:155`）只是构造时初始化为 `0`，**既不从 `app_settings` 读取、也不写回**。因此每次重启应用都回到 **normal** 模式。复刻时若"顺手"把它持久化，会改变用户实际体验——这不是改进而是行为变更，需明确决策。

**模式字符串映射**（`prompt_assembler.py:106-109`）：`{0:"normal", 1:"auto_edit", 2:"yolo", 3:"plan"}`，未知值回落 `"normal"`。

> ⚠️ **双写风险点**：权限同时存在于两处——`app.py::_apply_mode_permissions()`（执行层）和 `prompt_assembler.py` 的模式段落（提示层）。**两者必须保持一致**，否则模型会尝试被拒绝的操作，或不敢做被允许的操作。这是项目反复强调的设计约束。

---

## 6. 跨切面不变量（复刻必须保持）

| # | 不变量 | 出处 | 违反后果 |
|---|--------|------|---------|
| 1 | **不可变数据**：所有领域模型 `frozen=True`，更新 = 构造新对象 | `models.py` 全文 | 隐蔽的共享状态 bug |
| 2 | **原子写**：JSON 落盘必须 临时文件 + `os.replace()` | `storage.py` | 崩溃留下损坏文件 |
| 3 | **读入容错**：反序列化必须对缺失/未知字段宽容 | `storage.py` | 版本升级后旧数据读不出来 |
| 4 | **权限双层一致**：prompt 层与执行层的模式权限表必须同步 | `prompt_assembler.py` ↔ `app.py` | 模型行为与网关行为分裂 |
| 5 | **system prompt 每轮重建**，不落盘为 Message | `query_engine.py:213-218` | 历史污染、重复注入 |
| 6 | **压缩是追加标记，不是删数据**：历史消息全部保留，压缩只在流尾追加 `compact_summary` + `compact_boundary`，由 `list_active_messages()` 据此裁剪 | `storage.py:557`、`compact.py:262` | 丢失历史、无法审计；误用 `compacted_message_count` 做裁剪会失效 |
| 7 | **工具串行执行**：同一轮的多个 tool_use 顺序 await，不并发 | `query_engine.py:735-761` | 权限对话框竞态、写冲突 |
| 8 | **终止条件是"本轮无工具调用"**，不是"模型说了结束语" | `query_engine.py:655` | 提前结束或死循环 |
| 9 | **`input_tokens` 是快照、`output_tokens` 是累加** | `query_engine.py:598-615` | 用量统计错乱 |
| 10 | **UI 与引擎单向流 + 显式回灌**：引擎只通过 `on_event` 推、通过 `resolve_*` 收 | `query_engine.py` ↔ `app.py` | 引擎被 UI 框架绑架，无法复用 |
| 11 | **所有 turn 终止路径都经过 `finish()` 闭包** | `query_engine.py:325` | 缺少 `turn_end` 事件，UI 卡在流式态 |
| 12 | **可观测性失败必须降级不影响主流程**（未配置时注入 Noop client） | `observability/` | 观测系统拖垮主链路 |
| 13 | **路径逃逸防护**：所有文件操作经 `normalize_path()` | `tools/core.py:336` | 越权读写工作区外文件 |
| 14 | **工具注册顺序**：`SubAgentTool` 必须在核心工具之后注册 | `app.py:397-419` | 子代理看不到任何工具 |
| 15 | **依赖注入而非全局状态**：`resolve_app_paths(home, cwd)` 等接受注入参数 | `paths.py` | 不可测试 |
| 16 | **bash 白名单保持两层且不合并**：免审批层（前缀匹配）与安全层（子串+分词）语义不同、结论可能相反，合并会改变安全边界 | `tools/core.py:127`、`tools/bash_tool.py:67` | 放宽审批或放过危险命令 |
| 17 | **子代理权限与父模式求交集**：`effective_allowed = definition.allowed_tools ∩ parent.available - denied`；且 `sub_agent` 永远从子注册表剔除 | `subagents/executor.py:294,359` | **提权漏洞**、子代理无限递归 |
| 18 | **skill 守护必须随 `turn_state` 传递到子代理**（旧实现**没有**传，见 §7.7.1） | `subagents/executor.py:323` | 绕过 skill 守护的路径 |
| 19 | **`runtime_guards` 类型必须是 `tuple`**，否则被静默丢弃（旧实现的严格 `isinstance` 检查，见 §7.7.2） | `skills/guards.py:35` | skill 守护静默全开 |
| 20 | **存储写入必须串行化**：`chat.json` 由主代理与所有子代理共享，全量重写 + 读改写无锁会互相覆盖（见 §7.6） | `storage.py` | 静默丢失整份会话数据 |

---

## 7. 已知缺陷与复刻决策

**这一节是最容易出事的地方。** 旧项目里有若干**行为偏差与缺陷**，它们既不是文档记载的设计，也不是无伤大雅的笔误——其中几条会实质改变运行时行为。复刻者必须**逐条显式决策：忠实保留（bug-compatible）还是修正**，并把决定写进新项目的注释/ADR。

标记说明：**[已核实]** = 我逐行读过源码确认；**[待核实]** = 由子系统分析提出、逻辑可信但未逐行复核，实现前请自行验证。

### 7.1 压缩路径的复合缺陷 **[已核实]** — 影响最大

**缺陷 A：压缩后丢掉 system prompt。**
`query_engine.py:251-257`，preflight 压缩生效时：

```python
if compact_result.applied:
    active_messages = list(compact_result.messages)
    api_messages = sanitize_api_messages([        # ← 整体替换
        formatted for msg in active_messages
        if (formatted := message_to_api_format(msg)) is not None
    ])
```

此时 `api_messages` 是**从 active_messages 重建**的，而 system prompt 只在 `:218` 插入过一次。重建后它**不在**新列表里 → 本轮请求**没有 system prompt**（没有模式约束、没有安全策略、没有 skill 指导）。

**缺陷 B：压缩当轮等于没压缩。**
`compact.py:305` `_autocompact` 的返回是：

```python
updated = list_messages(self._chat_path, conversation_id=self._conversation_id)
return CompactionOutput(applied=True, messages=tuple(updated), ...)
```

`list_messages()` 返回**全部**消息（含边界之前的），不是 `list_active_messages()` 的活跃子集。于是 `active_messages = list(compact_result.messages)` 把刚压掉的完整历史又装了回去 → **本轮仍然发送超长上下文**。下一轮走 `list_active_messages()` 才真正生效。

**A + B 的净效果**：压缩生效的那一轮，模型收到的是"完整历史 + 无 system prompt"——恰好是最糟的组合。

**复刻决策建议**：**修正**。改成压缩后重新执行 B5–B8（重新抽取摘要、重新组装并 `insert(0, system_prompt)`），并让 `_autocompact` 返回 `list_active_messages()` 的结果。忠实保留这两条会让压缩功能在关键路径上失效。

### 7.2 取消状态是粘性的 **[已核实]**

`_cancel_event` 全仓只有 `set()` 与 `is_set()`，**没有任何 `clear()`**（`query_engine.py:71,77,81`）。一旦用户按 Esc 取消，同一个 `QueryEngine` 实例的**后续所有 turn 会立即被判为取消**。

而 TUI 恰好复用同一实例：`_submit_pending()` 在取消后会自动提交排队的 prompt（`app.py:524-527`）→ 该 prompt 立刻又被取消。

**复刻决策建议**：**修正**。在 `submit_message()` 入口处 `clear()`，或每轮新建 Event。

### 7.3 主循环的摘要提示词恒为英文 **[已核实]**

`query_engine.py:239` 与 `:554` 构造 `CompactionEngine` 时**没有传 `_i18n`**，于是它用默认的 `I18nStore()`；而 TUI 的 `/compact` 路径（`app.py:1707-1711`）**传了** `_i18n=self.i18n`。

后果：自动压缩（preflight / reactive）生成的摘要恒为英文，与 `/language` 设置无关；手动 `/compact` 才跟随语言。

补充：摘要历史里的工具调用文本 `[调用工具 {name}：{json}]`（`compact.py:372`）是**中文字面量硬编码**——即使英文环境下也会出现中文。

**复刻决策建议**：**修正**（统一注入 i18n），但把硬编码串收进 i18n 表。

### 7.4 错误路径不发 `turn_end` **[已核实]**

`submit_message` 的两条错误路径（`:134-149` 无模型、`:155-170` 未捕获异常）只发 `"error"`，**不发 `"turn_end"`**。而 TUI 的 `turn_end` 分支负责 `_stop_spinner()`、`_render_history()`、`_render_status_bar()`。

TUI 在 `error` 分支里自己补了 `_stop_spinner()`，所以不至于卡死——但这意味着**引擎的事件契约不完整**：不能假定"每个 turn_start 必有配对的 turn_end"。

**复刻决策建议**：**修正**，让所有终止路径都经过 `finish()`（与 §6 不变量 11 一致）。

### 7.5 错误路径的 token 统计滞后一轮 **[已核实]**

流式 `try` 的 `finally` 块（`:598-637`）负责累加 token 并写 store。但 `except` 分支里的 `return await finish("error", ...)` 会在**返回之前**调用 `finish()`——而 `finally` 虽在 `return` 前执行，却在 `finish()` **之后**才更新计数。

结果：错误路径的 `turn_end` 事件携带的是**上一轮**的 token 数。

**复刻决策建议**：**修正**，把 token 记账移到 `finish()` 之前，或让 `finish()` 主动读取最新计数。

### 7.6 并发写入零保护 **[已核实]** — 架构级决策点

`storage.py` 的每一次写都是**全量重写**：`_load_chat_store()` 读全文件 → 改内存 dict → `_write_json()` 原子替换整个文件。**没有文件锁、没有版本号、没有 fsync**。

而 `chat.json` 是**主代理与所有子代理共享**的同一个文件（子代理会话就是 `conversations` 数组里的行，消息都进同一个扁平的 `messages` 数组）。

后果：主 turn 正在写消息的同时，一个子代理也在写自己的消息 → 典型的 **read-modify-write 竞态**，晚写的一方会**静默覆盖**先写方的整份 store。

在实际使用中这个窗口较窄（主循环在 `await` 子代理时会挂起，子代理完成前主 turn 通常不写），所以它更像"随时可能发生但难以复现"的隐患，而不是必然发生的 bug。

**复刻决策建议**：**修正**。目标语言的并发模型下，建议至少做到其一：
- 进程内加一把 `asyncio.Lock` / mutex 串行化所有 store 写；
- 或改为**追加日志 + 定期压实**（append-only + compaction）的存储模型；
- 或给 store 加单调递增的 `revision`，写入时校验读到的版本未变（乐观并发）。

**注意**：这条会影响存储层的整体设计，**应在阶段 1（数据层）就决策**，而不是等到后期发现竞态再改。

### 7.7 跨系统安全缺陷

#### 7.7.1 skill 运行时守护在子代理内**完全失效** **[已核实]**

`ToolExecutor.execute()` 的第一级门控是从 `context.turn_state["runtime_guards"]` 取守护规则（§4.3 第 ② 级）。但子代理执行器构造自己的 `ToolContext` 时**重建了这个字段**（`subagents/executor.py:323`）：

```python
turn_state={"deny_sensitive_reads": True},     # ← 父会话的 runtime_guards 被丢弃
```

因此**父会话命中的 skill 守护不会传递到子代理**。子代理派生的每一个工具调用，其第一级门控都拿不到父 turn 的 skill 约束。

**影响**：若某个 skill 声明了 `deny_tool` 或 `path_scope` 守护来限制敏感操作，主代理自己受约束，但**它派出去的子代理不受约束**——构成一条绕过 skill 守护的路径。

**复刻决策建议**：**修正**。把父 `turn_state` 里的 `runtime_guards` 显式传入子代理的 `ToolContext`（可再做一次"与子代理定义求交"的收窄）。

#### 7.7.2 `runtime_guards` 必须是 `tuple`，传 `list` 会被静默丢弃 **[已核实]**

`guards_from_turn_state()`（`skills/guards.py:35-39`）的类型检查是**严格**的：

```python
raw_guards = turn_state.get("runtime_guards")
if not isinstance(raw_guards, tuple):
    return ()                       # ← list / 其它可迭代类型一律返回空
return tuple(guard for guard in raw_guards if isinstance(guard, RuntimeGuard))
```

传入 `list` 不会报错，而是**静默返回空元组**——所有 skill 守护随之失效，且**没有任何日志或异常**。

**复刻决策建议**：**修正**（改为 `Sequence` 判定，或至少对非 tuple 输入告警）。若选择保留，必须在代码注释里写明这是刻意的严格性。这是一个典型的"静默失效"陷阱：看起来在工作，实际门控全开。

### 7.8 其余已核实项

| 编号 | 问题 | 位置 | 建议 |
|------|------|------|------|
| E-MCP-1 | MCP 结果提取对非 text/data 的 content 项退化为 `str(item)`（pydantic repr）；其 `model_dump()` 含 `AnyUrl`，`json.dumps` 抛 **TypeError** 且该处未捕获 → **整个 turn 变 error** | `mcp/adapter.py:142-173`、`query_engine.py:1180` | 修正（序列化前先转纯字符串） |
| E-MCP-2 | MCP 工具结果的 `ok=True` 是**硬编码**；`isError` 分支只在 `content` 为空时才可能到达 → 带 content 的 MCP 错误被当作成功 | `mcp/adapter.py:96-140` | 修正（先判 `isError`） |
| E-MCP-3 | MCP 只支持 `stdio` 传输，其它 transport **静默丢弃**（不报错、不告警） | `mcp/config.py:23-28` | 保留（phase-1 范围），但建议加一条告警 |
| E-OBS-1 | `is_sensitive_key` 用**子串**匹配，`"token"` 在敏感词表中 → `input_tokens` / `output_tokens` / `total_tokens` / `max_tokens` / `context_tokens_*` 全部被脱敏为 `[REDACTED]` | `observability/sanitize.py:15-30,64-66` | 修正（token 类键应加白名单豁免） |
| E-OBS-2 | 四个恒量指标：`decision_accuracy` 恒 `1.0`、`rule_violation_count` 恒 `0`、`unexpected_files_changed` 恒 `0`；`progress_rate` 是手写启发式 | `observability/scoring.py` | 保留（占位指标），但别在报表里当真值用 |
| E-SA-1 | 子代理执行器**不复用 `QueryEngine`**：手写 `while` 循环，**无压缩、无自动续跑、无取消、无超时** | `subagents/executor.py:121` | 保留（隔离是刻意的），但要知道子代理没有上下文压缩保护 |
| E-SA-2 | `SubAgentDefinition.model` 与 `context_policy` 是**死字段**；`SubAgentSession`、`result_to_json` 是死代码 | `subagents/models.py` | 不必实现 |
| E-DL-1 | `message_to_api_format` 处理 tool 结果时用 `parsed["content"]` **下标**访问，若该键缺失则 `KeyError` 冒泡（`except` 只捕 `JSONDecodeError`/`TypeError`） | `message_utils.py:34-39` | 修正（`except` 补 `KeyError`，或用 `.get()`） |
| E-DL-2 | `Message.meta` 若被写成 `dict`，下次启动经 `_normalize_message_dict` 的 `str(row.get("meta"))` 变成 **Python repr（单引号）**，JSON 静默损坏 | `storage.py:842` | 修正（`json.dumps` 而非 `str`） |
| E-DL-3 | `schema_version` **无迁移器**：读到 >1 会被静默降为 `1`；且每次启动 `initialize_storage` 全量重写，**丢弃未知顶层键** | `storage.py:610-629` | 修正（保留未知键，或至少告警） |
| E-DL-4 | `SessionConfigSnapshot` 零引用（**死代码**，全仓只有定义） | `models.py:74` | 不必实现 |
| E-DL-5 | `add_message` 拒绝**空串**但接受**纯空白**；未知 conversation ID 在 `update_*`/`increment_turn` 中**静默 no-op**，而 `add_message` 抛错——同一模块内错误契约不一致 | `storage.py` | 修正（统一为抛错或统一为 no-op） |

### 7.9 其余已记录项 **[待核实]**

以下由子系统规格提出，未逐行复核，实现到对应模块时请对照 `parts/` 中的详细描述验证：

| 编号 | 问题 | 位置 | 建议 |
|------|------|------|------|
| E2 | `_apply_tool_result_budget` 用 `messages` 下标写 `api_messages`，两者长度/顺序不对齐 | `compact.py:187-237` | 修正（当前靠调用方重建掩盖） |
| E8 | finalization 轮丢弃 assistant 的 tool_call 块 | `query_engine.py:646` | 保留（该轮本就要求不调工具） |
| E10 | `compact_boundary` 落盘的 `tokens_after` 恒为 `0` | `compact.py:285-297` | 修正（写真实值） |
| E15 | 预检压缩只在 turn 开头做，长工具链中途不压缩 | `query_engine.py:237` | 保留（行为可接受） |
| E11b | 见 §7.3 | — | — |
| T-1 | `escape` 单次拒绝权限的分支**不可达**（被提前 `return` 屏蔽） | `app.py:591-615` | 修正或删除死代码 |
| T-2 | 权限请求无队列（单槽位），并发请求会互相覆盖 | `app.py:1232` | 修正（引擎侧本就串行，风险低） |
| T-3 | `GlobTool` 截断提示恒显示 `0 more` | `tools/glob_tool.py` | 修正 |
| T-4 | bash 用同步 `subprocess.run` **阻塞事件循环** | `tools/bash_tool.py:99+` | 修正（改 async） |
| T-5 | MCP 的 always-allow 只跳过第 2 层，仍会弹框 | `tools/core.py` + MCP 路径 | 修正 |
| T-6 | `enter_plan_mode` 只写 `turn_state`，**权限切换必须由 TUI 实现** | `tools/plan_tools.py` | 保留（分层如此设计，但复刻时别漏 UI 侧的联动） |
| T-7 | 设计文档提及但**未实现**：`tool.progress` 事件、`ToolMeta`、bash `background` 参数、写入原子性 | `docs/claude-like-tools-docs/` | 不必实现（除非要超出旧项目） |

### 7.10 缺陷总索引（**覆盖度自查表**）

§7.1–§7.9 是**精选**：只收录了我亲自逐行核实的条目，以及影响架构决策的条目（共 19 条）。**完整清单在各 parts 文件里**，总计约 **175 条**（含少量跨文件重叠）。

只读本文档会漏掉绝大部分——实现某个子系统前，**必须**去读对应 part 的缺陷段。

| 子系统 | 缺陷清单位置 | 条目数 | 本文档已收录 |
|--------|------------|--------|------------|
| 数据层 | `parts/01-data-layer.md` **§9**（关键不变量、边界条件、易错点，9.1–9.20）<br>`parts/01-data-layer.md` **§11**（文档 vs 代码不一致清单） | 20<br>11 | §7.6 并发写、§7.8 E-DL-1..5 |
| Agent 主循环 | `parts/02-agent-loop.md` **§8 易错点**（E1–E17，按严重度排序） | 17 | §7.1 E1、§7.2 E4、§7.3 E11、§7.4 E5、§7.5 E6 |
| Provider | `parts/03-providers.md` **§8.4**（协议间 14 项行为不对称）<br>同文件 §2.7 / §3.4 / §8.2（4 处建议修复缺陷） | 14<br>4 | — |
| 工具运行时 | `parts/04-tools.md` **§10.2**（已知缺口 / 反直觉行为）<br>同文件 §10.1（必须保持的不变量） | 22 | §7.9 T-3/T-4/T-5、§7.8 E-MCP-1/2 |
| TUI | `parts/05-tui.md` **§12.2**（已知缺陷 / 死代码）<br>同文件 §12.1（关键不变量） | 15 | §7.9 T-1/T-2 |
| Skill + Sub-agent | `parts/06-skills-subagents.md` **§17.3**（高频陷阱表，30 条）<br>同文件 §17.1（12 条不变量）、§17.2（14 条不变量） | 30 | §7.7.1、§7.7.2、§7.8 E-SA-1/2 |
| MCP + 可观测性 | `parts/07-mcp-observability.md` **§10**（与设计文档的偏差汇总）<br>同文件 §8.3（关键不变量与易错点） | 20 | §7.8 E-MCP-1/2/3、E-OBS-1/2 |
| 设计意图 | `parts/08-design-rationale.md` **§6**（文档与代码可能不一致，22 条） | 22 | §0.2.1 收了 10 条 |
| **合计** | | **≈174** | **19** |

**覆盖度自查方法**（复刻到任一阶段时执行）：

```bash
# 1. 列出该子系统 part 的全部缺陷标题
grep -n "^### 9\.\|^| [0-9]" docs/rewrite-spec/parts/01-data-layer.md   # 以数据层为例

# 2. 与本表核对：本文档 §7 收录了哪几条
grep -n "§7\." docs/REWRITE_SPEC.md

# 3. 逐条决策：修正 / 保留（bug-compatible）/ 无需处理
```

**为什么不全收进 §7**：parts 里的清单带完整上下文（代码片段、行号、影响面、测试建议），抽取到总纲会丢信息。总纲的职责是**导航与决策框架**，不是穷举。

### 7.11 使用方法

给复刻 agent 的指令应包含：

```text
实现前先读 REWRITE_SPEC §7。对每一条缺陷：
- 标 [已核实] 的，按"复刻决策建议"执行；若选择保留，必须在代码注释里写明
  "// BUG-COMPAT: 保留旧实现行为，原因：<...>"，并在测试中固化该行为。
- 标 [待核实] 的，先自己读源码确认，再决策。
不要静默地"顺手修好"——静默修正会让新旧行为无法对比，也会破坏
后续以旧项目为基准的回归测试。
```

---

## 8. 复刻路线图

按依赖顺序分 7 个阶段。**每个阶段都以"该阶段的验收测试通过"为结束条件**。

### 阶段 1：数据层（无依赖）
实现 `models` / `paths` / `storage` / `message_utils`。
**验收**：能用旧项目的 `config.json` + `chat.json` 完成全部 CRUD 往返；原子写；旧 SQLite 迁移；缺失字段容错。
→ parts/01

### 阶段 2：Provider 层（依赖阶段 1）
实现 `api_client` 的两种协议适配与归一化流式事件。
**验收**：对 Anthropic 与任一 OpenAI 兼容端点，产生与旧项目一致的归一化事件序列（thinking / reasoning / text / tool_use / usage / incomplete_tool_call）。
→ parts/03

### 阶段 3：工具运行时（依赖阶段 1；守护部分可后置）
实现 Tool 协议、Registry、Executor 三级门控、权限状态机、13 个内置工具（12 核心 + `sub_agent`）、路径防护。
**验收**：§5 权限矩阵逐格验证；bash 白名单前缀匹配；`normalize_path` 逃逸拦截。
→ parts/04

### 阶段 4：Agent 主循环（依赖阶段 1-3）
实现 `prompt_assembler` + `QueryEngine.submit_message/_run_turn` + `TurnEvent` 全事件表。
**验收**：§4.2 的 C1-C13 每条分支都能触发；12 种事件按序发出；终止原因正确。
→ parts/02

### 阶段 5：压缩与续跑（依赖阶段 4）
实现 `compact`：token 估算、软截断、硬摘要、preflight/reactive/manual 三条路径、三个计数器。
**验收**：构造超预算历史触发 preflight；构造 provider 报 413 触发 reactive 且 `num_turns` 不递增；触发三种自动续跑提示词。
→ parts/02

### 阶段 6：扩展层（依赖阶段 4）
Skill 系统（解析/校验/注册/匹配/编译/守护）、Sub-agent（定义/隔离执行/结果压缩）、MCP 客户端（配置/生命周期/工具适配）。
**验收**：skill trigger 匹配与守护拦截；子代理隔离会话与工具裁剪；MCP 工具前缀注册与默认 ask。
→ parts/06、parts/07

### 阶段 7：表现层与可观测性（依赖以上全部）
TUI（布局/事件消费/斜杠命令/权限对话框/@文件引用/i18n）+ Langfuse 埋点。
**验收**：§4.2 事件表的 UI 反应列逐行验证；基础斜杠命令可用（`/api` `/model` `/thinking` `/reasoning` `/effort` `/1M` `/sessions` `/clear` `/compact` `/language` `/mcp` `/skills` `/langfuse` `/init`），并按 `09-typescript-agent-standard.md` 实现 `/workwith provider/model instruction`；权限对话框往返闭环。
→ parts/05、parts/07

---

## 9. 章节索引

| 文件 | 内容 | 规模 |
|------|------|------|
| `docs/REWRITE_SPEC.md`（本文） | 总纲：定位、依赖图、数据模型、端到端时序、权限矩阵、20 条不变量、已知缺陷与复刻决策、路线图 | 1,436 行 |
| `docs/rewrite-spec/parts/01-data-layer.md` | 数据层：模型、JSON schema、原子写、迁移、`subtype` 全集、message_utils 转换规则 | 1542 行 |
| `docs/rewrite-spec/parts/02-agent-loop.md` | Agent 主循环：QueryEngine 全流程、13 种 TurnEvent、prompt 六层、压缩算法、32 项阈值 | 1558 行 |
| `docs/rewrite-spec/parts/03-providers.md` | Provider 层：Anthropic / OpenAI 协议适配、SSE 逐事件解析、工具 schema 双映射 | 1112 行 |
| `docs/rewrite-spec/parts/04-tools.md` | 工具运行时：Tool 契约、三级门控、权限矩阵、13 个内置工具逐个规格、22 条已知缺口 | 1827 行 |
| `docs/rewrite-spec/parts/05-tui.md` | TUI：布局树、14 步按键判定、14 条斜杠命令、@文件引用、权限状态机、i18n | 1773 行 |
| `docs/rewrite-spec/parts/06-skills-subagents.md` | Skill 系统（格式/解析/校验/匹配/编译/守护）+ Sub-agent 系统（定义/隔离执行/结果压缩） | 2650 行 |
| `docs/rewrite-spec/parts/07-mcp-observability.md` | MCP 客户端集成 + Langfuse 可观测性（trace 层次、脱敏、指标、评分） | 2387 行 |
| `docs/rewrite-spec/parts/08-design-rationale.md` | 设计意图、演进史、14 份文档决策摘要、15 条架构原则、79 条必须一致行为、22 条文档代码不一致 | 1494 行 |

**合计约 15,800 行**（总纲 1,436 + 子系统 14,343）。

---

## 附录 A：给复刻 agent 的工作指令模板

把下面这段直接交给新项目里的 agent：

```text
你要在 <新语言> 中复刻 FlyinChat。

第一步：读 docs/REWRITE_SPEC.md 全文。这是旧项目的架构总纲。
第二步：读 docs/rewrite-spec/parts/ 下与当前任务相关的子系统规格（逐字读，不要跳读）。
第三步：读 REWRITE_SPEC §7（已知缺陷与复刻决策），逐条决策。
第四步：按 REWRITE_SPEC §8 的阶段顺序实现，不要跳阶段。

硬性要求：
- 提示词原文（system prompt 各段、工具 description、自动续跑注入文本）必须逐字一致。
  这些文本直接决定模型行为，改写会导致行为不等价。
- 权限矩阵（REWRITE_SPEC §5）逐格实现，且执行层与 prompt 层必须同步。
- 所有阈值常量（超时、截断长度、重试次数、token 预算）原样保留。
- 磁盘 JSON 的字段名与语义必须与旧项目兼容。
- 遵循 REWRITE_SPEC §6 的全部 20 条不变量。

遇到规格未覆盖的细节时：
1. 先查 docs/rewrite-spec/parts/ 对应子系统；
2. 再查 docs/ 下的历史设计文档（了解意图）；
3. 仍不明确时，按"最小惊讶原则"实现，并在代码注释里标注这是推测。
```

## 附录 B：术语表

| 术语 | 含义 |
|------|------|
| **channel（渠道）** | 一个 provider 连接配置，含 base_url + api_key + provider_type |
| **model（模型）** | 渠道下的具体模型名 + 该模型的生成参数（thinking / effort / context_window / max_output_tokens） |
| **turn** | 一次用户提交到最终答复的完整过程，可能包含多轮 LLM 调用与工具调用；`turn_id` 形如 `turn_3_9fc43b3a` |
| **tool round（工具轮）** | turn 内一次"模型请求工具 → 执行 → 结果回灌"的循环 |
| **compaction boundary（压缩边界）** | 消息流里的标记消息（`subtype`/`content.type == "compact_boundary"`），其之前的消息已被摘要、不再进入 API 请求。注意：**不是** `Conversation.compacted_message_count`（那只是记账字段） |
| **compact_summary** | 紧邻边界之前的那条 `role="system"` 消息，承载 LLM 生成的历史摘要正文 |
| **preflight compact** | 每轮开始前的**预判式**压缩 |
| **reactive compact** | provider 报上下文超限后的**被动式**压缩 |
| **finalization pass** | 预算耗尽后的最后一次生成，**不提供工具**，要求模型总结 |
| **auto-continue** | 预算耗尽时自动追加 turn 预算 + 注入续跑提示词 |
| **skill guard** | skill 声明的运行时工具守护，在门控第一级生效 |
| **MCP** | Model Context Protocol，外部工具服务；其工具以 `mcp_` 前缀注册并默认需审批 |
