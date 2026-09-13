# 02 — Agent 主循环（QueryEngine）实现规格

> **新实现注意**：旧实现的时序和事件名用于兼容；新 TypeScript 实现的状态机、取消、预算、幂等和 ContextEnvelope 以 `09-typescript-agent-standard.md` 为准。

> **导航**：本文件是 `docs/REWRITE_SPEC.md`（总纲）的子规格。建议先读总纲了解架构全景，再回到本文件逐条实现。
> 相关：总纲 §0.2.1（文档与代码冲突清单）、§7（已知缺陷与复刻决策）、§8（复刻路线图）。


本文件描述 FlyinChat 每轮用户消息的编排核心 `QueryEngine`：生命周期、一次 turn 的完整时序、
`TurnEvent` 事件表、`prompt_assembler` 分层、`compact.py` 完整算法、错误/取消处理、并发模型、
不变量与易错点。目标：**可以据此用另一种语言从零复刻**。

涉及源文件：

| 文件 | 行数 | 职责 |
|------|------|------|
| `src/flyinchat/query_engine.py` | 1278 | 本层全部实现：`TurnEvent` / `QueryEngineConfig` / `QueryEngine` |
| `src/flyinchat/prompt_assembler.py` | 110 | system prompt 分层拼装 |
| `src/flyinchat/compact.py` | 435 | `TokenEstimator` / `CompactionPolicy` / `CompactionEngine` |
| `src/flyinchat/message_utils.py` | 307 | 持久化 `Message` → provider 消息 dict；工具结果展示格式化 |
| `src/flyinchat/models.py` | 81 | `Message` / `TurnResult` / `LLMChannel` / `LLMModel` / `Conversation` |
| `src/flyinchat/storage.py` | 902 | JSON 持久化 CRUD（atomic write） |
| `src/flyinchat/api_client.py` | 588 | `stream_chat_completion` / `chat_completion`（详见 `03-providers.md`） |
| `src/flyinchat/tools/core.py` | 350 | `ToolRegistry` / `ToolExecutor` / `ToolContext` / `PermissionContext` / `ToolResult` |
| `src/flyinchat/tools/permission_request.py` | 206 | `PermissionRequest` / `PermissionRequestStore` / `sanitize_args` |
| `src/flyinchat/observability/tracing.py` | 316 | `AgentTrace` / `GenerationTrace` / `ToolTrace` |
| `src/flyinchat/skills/*` | — | skill 解析/编译/守卫（详见 skills 专章） |
| `tests/test_query_engine.py` | 866 | 16 个用例，覆盖主循环绝大多数分支 |
| `tests/test_compact.py` | 372 | 压缩层单元测试 |

参考设计文档（历史设计，与现状有偏差，仅作背景）：
- `docs/tui-to-queryengine/QUERYENGINE_IMPLEMENTATION_BRIEF.md`
- `docs/claude_like_tool_system/compact_design.md`

---

## 1. QueryEngine 生命周期

### 1.1 数据类与配置

```python
# src/flyinchat/query_engine.py:39-43
@dataclass(frozen=True)
class TurnEvent:
    turn_id: str
    event_type: str  # "thinking" | "text" | "tool_use" | "tool_result" | "turn_start" | "turn_end" | "error" | "compact_start" | "compact_end"
    data: dict[str, Any] = field(default_factory=dict)
```

> **注意**：`event_type` 的注释是**过时的**。实际发出的类型还有 `skill_resolved`、`auto_continue`、
> `permission_required`、`user_input_required`（共 13 种，见第 3 节事件表）。

```python
# src/flyinchat/query_engine.py:46-58
@dataclass(frozen=True)
class QueryEngineConfig:
    paths: AppPaths
    conversation_id: str
    max_tool_rounds: int = 10
    max_turns: int | None = None
    max_context_retries: int = 1
    enable_auto_compact: bool = True
    skill_registry: SkillRegistry | None = None
    enable_auto_continue: bool = True
    max_auto_continues: int = 3
    auto_continue_turns: int = 10
    observability_client: ObservabilityClient | None = None
```

`AppPaths`（`src/flyinchat/paths.py:5-10`）四个字段：
`global_dir`（`~/.flyinchat`）、`project_dir`（`<cwd>/.flyinchat`）、
`config_path`（`global_dir/config.json`）、`chat_path`（`project_dir/chat.json`）。

### 1.2 构造与内部状态

```python
# src/flyinchat/query_engine.py:61-74
class QueryEngine:
    def __init__(self, config: QueryEngineConfig) -> None:
        self.config = config
        self.mode: str = "normal"
        self._tool_registry: ToolRegistry | None = None
        self._tool_executor: ToolExecutor | None = None
        self._tool_context: ToolContext | None = None
        self._permission_store = PermissionRequestStore()
        self._pending_permissions: dict[str, asyncio.Future[str]] = {}
        self._pending_user_inputs: dict[str, asyncio.Future[dict]] = {}
        self._cancel_event = asyncio.Event()
        self._skill_resolver = SkillResolver()
        self._skill_compiler = SkillCompiler()
        self._active_trace: AgentTrace | None = None
```

要点：
- **依赖注入分为两批**：构造期注入的只有 `config`（其中含 `paths`、`conversation_id`、`skill_registry`、
  `observability_client`）；工具系统通过 `configure_tools()` **事后注入**。
- `mode` 是**可变公有字段**（`str`，取值 `"normal" | "auto_edit" | "yolo" | "plan"`），由 TUI 在模式切换时
  直接赋值（`src/flyinchat/app.py:456`、`2198-2199`）。构造时默认 `"normal"`。
- `asyncio.Event()` 在 `__init__` 中创建——意味着**必须在事件循环内构造**，或在无 loop 时构造后使用
  （CPython 3.10+ 允许无 loop 创建 Event）。
- `_active_trace` 是**整个 engine 共享的当前 turn trace**，`submit_message` 进入时设置、退出时置 `None`。
  压缩引擎会拿到它作为 `_observability`。

### 1.3 公开方法（精确签名）

```python
def request_cancel(self) -> None                                  # qe.py:76
@property
def is_cancelled(self) -> bool                                    # qe.py:79-81

def configure_tools(self, registry: ToolRegistry, executor: ToolExecutor,
                    context: ToolContext) -> None                 # qe.py:83-91

@property
def permission_store(self) -> PermissionRequestStore              # qe.py:93-95

async def submit_message(
    self,
    user_content: str,
    on_event: Callable[[TurnEvent], Awaitable[None]] | None = None,
    *,
    user_message_persisted: bool = False,
) -> TurnResult                                                   # qe.py:97-190

def resolve_permission(self, request_id: str, resolution: str) -> bool     # qe.py:1223-1232
def resolve_user_input(self, request_id: str, answers: dict) -> bool       # qe.py:1146-1155
def get_session_state(self) -> dict                                        # qe.py:1242-1254
```

私有（复刻时按语义等价实现）：
`_run_turn`、`_resolve_turn_skills`、`_write_skill_transcript`、`_start_tool_trace`、`_execute_tool`、
`_handle_permission_required`、`_handle_user_input_required`、`_persist_tool_result`、
`_write_permission_transcript`、`_emit`。

模块级辅助函数：
`_latest_user_content(messages) -> str`（qe.py:1257-1261，反向找第一条 `role=="user"` 的 content，无则 `""`）、
`_extract_compact_summary(api_messages) -> str | None`（qe.py:1264-1272）、
`_extract_command_pattern(parts) -> str`（qe.py:1275-1278）。

`get_session_state()` 返回：
```python
{"turn_count": conv.current_turn,
 "total_output_tokens": conv.total_output_tokens,
 "last_input_tokens": conv.last_input_tokens,
 "status": conv.status}
```
会话不存在时返回 `{}`。

### 1.4 TUI 侧装配方式（复刻 TUI 时需要）

```python
# src/flyinchat/app.py:447-463
config = QueryEngineConfig(
    paths=self.paths,
    conversation_id=self.active_conversation_id,
    skill_registry=self._skill_registry,
    observability_client=self._observability_client,
)
engine = QueryEngine(config)
engine.mode = mode_int_to_str(self._mode)          # {0:normal,1:auto_edit,2:yolo,3:plan}
engine.configure_tools(self._tool_registry, self._tool_executor, self._tool_context)
```
- engine 实例**每个会话一个**，切换会话/换 observability client 时置 `None` 重建
  （`app.py:745, 903, 930, 1194, 1655`）。
- 调用入口（`app.py:539-546`）：
  ```python
  @work
  async def _submit_via_engine(self, prompt: str) -> None:
      engine = self._ensure_query_engine()
      result = await engine.submit_message(prompt, on_event=self._handle_turn_event,
                                           user_message_persisted=True)
  ```
  **`user_message_persisted=True`**：因为 TUI 在 `on_input_submitted` / `_submit_pending` 里已经用
  `add_message(..., role="user", content=prompt)` 写过一条 user 消息——注意那条消息**没有 `turn_id`**
  （`app.py:750-755`、`572-577`）。所以 TUI 路径下 user 消息的 `turn_id == ""`；
  只有测试里走 engine 自持久化路径时 user 消息才带 `turn_id`。

---

## 2. 一次用户 turn 的完整时序

### 2.0 总览

```
submit_message(user_content, on_event, user_message_persisted)
 ├─1 increment_turn()                    → conversation.current_turn += 1
 ├─2 turn_id = f"turn_{turn_number}_{conversation_id[:8]}"
 ├─3 [未持久化时] 写 user 消息 (role=user, subtype=normal, turn_id)
 ├─4 emit turn_start {turn_number}
 ├─5 get_primary_llm_model()             → (channel, model) | None
 ├─6 AgentTrace.start(...)  → self._active_trace
 ├─7 [无模型] emit error → 直接返回 TurnResult(status="error")   ★不发 turn_end
 └─8 _run_turn(turn_id, channel, model, on_event)
      ├─ 8.1  list_active_messages()                       读取活跃消息
      ├─ 8.2  _resolve_turn_skills()                       skill 解析+编译+落盘 transcript
      ├─ 8.3  message_to_api_format + sanitize_api_messages → api_messages
      ├─ 8.4  _extract_compact_summary → 去掉 system → assemble_system_prompt → insert(0)
      ├─ 8.5  [可选] emit skill_resolved
      ├─ 8.6  tool_list = registry.tools | None
      ├─ 8.7  [enable_auto_compact] emit compact_start("preflight")
      │        compact_if_needed_async(...)  → 可能 emit compact_end
      ├─ 8.8  初始化循环变量
      └─ 8.9  while True:  ← 见 2.2
```

### 2.1 阶段 1–7：submit_message（qe.py:97-190）

**步骤 1** — `turn_number = increment_turn(chat_path, conversation_id=...)`（qe.py:105-107）。
`increment_turn` 会把 `conversations[i].current_turn` 自增 1 并写盘，返回新值（storage.py:528-540）。
**即使随后发现没有配置模型，turn 计数也已经 +1。**

**步骤 2** — `turn_id = f"turn_{turn_number}_{self.config.conversation_id[:8]}"`（qe.py:108）。
即 `turn_1_a1b2c3d4`。

**步骤 3** — 若 `user_message_persisted == False`：
```python
add_message_with_turn(chat_path, conversation_id=..., turn_id=turn_id,
                      role="user", subtype="normal", content=user_content)   # qe.py:110-118
```
`add_message` 强制校验：`role ∈ {user, assistant, tool, system}`；`content` 非空否则 `ValueError`。

**步骤 4** — `emit turn_start {"turn_number": turn_number}`（qe.py:120）。

**步骤 5/6** — `primary = get_primary_llm_model(config_path)`（qe.py:122）。
返回值 `(LLMChannel, LLMModel)` 或 `None`。选取规则（storage.py:249-266）：取所有 `is_default == True`
的模型，按 `(channel.name, model.name)` 排序取第一个；无默认模型或 channel 缺失 → `None`。
随后立即 `AgentTrace.start(observability_client, turn_id, conversation_id, user_input, workspace=paths.project_dir.parent,
agent_mode=self.mode, permission_mode=self.mode, model_name=primary[1].name if ... else "unknown")`（qe.py:123-132），
写入 `self._active_trace`。

**步骤 7（无模型分支，qe.py:134-149）** — emit `error {"message": "No model configured. Add one with /api, then /model."}`，
`trace.finish(TurnResult(turn_id, status="error", error=err_msg), task_latency_ms=...)`，
`self._active_trace = None`，返回。**此分支不发 `turn_end`**（TUI 靠 `error` 事件停 spinner）。

**步骤 8** — `trace.update_model(model)`；`result = await self._run_turn(turn_id, channel, model, on_event)`（qe.py:152-154）。
异常兜底（qe.py:155-170）：`logger.exception` + emit `error {"message": str(exc)}` +
返回 `TurnResult(status="error", error=str(exc), tool_rounds=0)`，**不发 `turn_end`**，`self._active_trace=None`。

**收尾（qe.py:172-190）** — `elapsed_ms = int((time.time()-t_start)*1000)`；
`trace.finish(result, task_latency_ms=elapsed_ms)`；`self._active_trace = None`；
打一条 `logger.info("turn complete", extra={turn_id,status,tool_rounds,num_turns,max_turns,
terminal_reason,last_tool_error,elapsed_ms,input_tokens,output_tokens})`；返回 `TurnResult`。

`TurnResult` 字段（models.py:58-70）：
```python
turn_id: str
status: str          # "completed" | "error" | "cancelled" | "max_rounds"
final_text: str = ""
tool_rounds: int = 0
input_tokens: int = 0
output_tokens: int = 0
error: str | None = None
num_turns: int = 0
max_turns: int = 0
terminal_reason: str | None = None
last_tool_error: str | None = None
```

### 2.2 阶段 8：`_run_turn` 前置准备

**8.1 读取活跃消息**（qe.py:199-201）
```python
active_messages = list_active_messages(chat_path, conversation_id=...)
```
`list_active_messages`（storage.py:557-588）：从全部消息中找到**第一条** `subtype == "compact_boundary"`
或 content 里 `{"type": "compact_boundary"}` 的消息，返回它（若前一条是 compaction summary 则连同它一起）
以及之后的全部消息；找不到 boundary 就返回全部。排序按 `created_at`（字符串 ISO）。

**8.2 skill 解析**（qe.py:202 → qe.py:765-791）
```python
compiled_skill = self._resolve_turn_skills(turn_id, active_messages)
```
逻辑：
1. `registry = self.config.skill_registry`；若为 `None` → 把 `tool_context.turn_state` 里的
   `runtime_guards` / `skill_runtime_state` 两个 key **删除**，返回 `None`。
2. `query = _latest_user_content(active_messages)`（最后一条 user 消息的 content）。
3. `catalog = registry.refresh()`（每次 turn 重新扫描 `<project_root>/skills/**/SKILL.md` 与
   `<user_root>/skills/**/SKILL.md`）。
4. `decision = self._skill_resolver.resolve(query, catalog)`（确定性关键词打分，`top_k=3`，
   打分：name×4、description×3、tags×4、triggers×5、when_to_use×2、workflow×1，再加 `priority`；
   `confidence = min(1.0, best_score / 12)`）。
5. `compiled = self._skill_compiler.compile(decision)`。
6. `tool_context.turn_state = {**turn_state, "runtime_guards": compiled.runtime_guards,
   "skill_runtime_state": compiled.runtime_state}`（工具守卫的执行依据）。
7. `_write_skill_transcript(turn_id, decision, compiled)` — **无条件落盘**一条
   `role="system", subtype="skill_event"` 消息，content 为：
   ```json
   {"event": "skill.resolve.complete",
    "applied_skills": [...], "rejected": [{"name","reason","score"}...],
    "confidence": 0.0, "skill_decision_reason": "...",
    "active_phase": "discover",
    "guards_applied": [{"guard_id","skill_name","guard_type","action","reason"}...]}
   ```
   （`ensure_ascii=False`）并打 `logger.info("skill resolved", ...)`。
8. 返回 `compiled if decision.selected else None` —— **注意：即使没有选中 skill 也返回 `None`，
   但 transcript 与 turn_state 已经写入**。

**8.3 转 API 消息**（qe.py:203-208）
```python
api_messages = [formatted for msg in active_messages
                if (formatted := message_to_api_format(msg)) is not None]
api_messages = sanitize_api_messages(api_messages)
```
`message_to_api_format`（message_utils.py:26-46）规则：
| 持久化消息 | 返回值 |
|---|---|
| `subtype ∈ {permission_event, skill_event}` | `None`（丢弃，不发给模型） |
| content 解析为 **JSON list**（assistant 块数组） | `{"role": msg.role, "content": parsed}` |
| content 解析为 dict 且含 `tool_use_id` | `{"role": "tool", "tool_use_id": ..., "content": ...}` |
| content 解析为 dict 且 `type == "compact_boundary"` | `None` |
| content 解析为 dict 且 `type == "compact_summary"` | `{"role": "system", "content": summary}` |
| 解析失败 / 其它 | `{"role": msg.role, "content": msg.content}` |

`sanitize_api_messages`（message_utils.py:10-23）：扫描列表，若当前消息 `role=="user"` 且前一条也是
`role=="user"`，在其前插入 `{"role": "assistant", "content": "[Interrupted]"}`。用于修复崩溃/取消留下的
孤立 user 消息，保证 API 的 role 交替合法性。

**8.4 system prompt 组装**（qe.py:210-218）——顺序非常关键：
```python
compact_text = _extract_compact_summary(api_messages)        # 把所有 role=="system" 的 content 用 "\n\n" 连接
api_messages = [m for m in api_messages if m.get("role") != "system"]   # 全部剔除
system_prompt = assemble_system_prompt(
    mode=self.mode,
    compact_summary=compact_text,
    skill_injection=compiled_skill.planning_injection if compiled_skill else None,
)
api_messages.insert(0, {"role": "system", "content": system_prompt})
```
即：**压缩摘要不是单独一条 system 消息，而是被抽取出来嵌进统一 system prompt 的最后一层**。
（Anthropic provider 端会再把所有 `role=="system"` 合并进 `body["system"]`；见 `03-providers.md`。）

**8.5 skill 事件**（qe.py:219-231）— 仅当 `compiled_skill` 非 None 且
`compiled_skill.runtime_state.applied_skills` 非空时：
```python
emit skill_resolved {"applied_skills": [...], "active_phase": "...",
                     "guards_applied": <int, len(runtime_guards)>}
```

**8.6 工具列表**（qe.py:233-235）
```python
tool_list = list(self._tool_registry.tools) if self._tool_registry else None
```
`registry.tools` 返回内部 dict 的 `list(values())`，顺序 = 注册顺序（`app.py:_init_tools` 的注册顺序：
file_read, file_write, file_edit, glob, grep, bash, web_fetch, web_search, ask_user_question, todo_write,
enter_plan_mode, exit_plan_mode, 之后 sub_agent, 再之后动态注册的 `mcp_*`）。
`None` 与 `[]` 对 provider 等价（都不带 `tools` 字段）。

**8.7 预检压缩（preflight）**（qe.py:237-279）— 仅当 `config.enable_auto_compact`：
```python
policy = CompactionPolicy.from_model(model)             # context_window = model.context_window
engine = CompactionEngine(chat_path, conversation_id, _observability=self._active_trace)
emit compact_start {"strategy": "preflight"}
compact_result = await engine.compact_if_needed_async(
    active_messages, api_messages, policy, force=False, model=model, channel=channel)
if compact_result.applied:
    active_messages = list(compact_result.messages)
    api_messages = sanitize_api_messages([... message_to_api_format ...])   # 重建，注意 system prompt 丢失重加？→ 见易错点 E1
    self._active_trace.mark_compaction(tokens_before=..., tokens_after=...)
    logger.info("preflight compact applied", extra={turn_id,strategy,tokens_before,tokens_after})
emit compact_end {"applied": bool, "strategy": str}
```
**触发时机：只在每轮 turn 的第一次 LLM 调用之前**；多轮工具调用之间**不再做预检压缩**，
只能靠错误兜底的 reactive compact。

**8.8 循环变量初始化**（qe.py:281-293）
```python
base_max_turns = max(1, self.config.max_turns or self.config.max_tool_rounds)
current_max_turns = base_max_turns
compact_retry_remaining = self.config.max_context_retries        # 默认 1
total_input_tokens = 0
total_output_tokens = 0
num_turns = 0
tool_rounds = 0
auto_continue_count = 0
incomplete_continue_count = 0
max_incomplete_continues = 3                                     # ★局部硬编码常量
pending_tool_results = False
finalization_pass = False
last_tool_error: str | None = None
```

两个闭包：

```python
# qe.py:295-306
def assistant_blocks(thinking_blocks: list[dict], text_content: str) -> list[dict]:
    blocks = [{"type": "thinking", "thinking": th["thinking"],
               "signature": th.get("signature", "")} for th in thinking_blocks]
    if text_content:
        blocks.append({"type": "text", "text": text_content})
    return blocks
```

```python
# qe.py:308-323
def persist_normal_message(thinking_blocks, text_content) -> None:
    if not thinking_blocks and not text_content:
        return                                       # ★ 空消息不写盘（add_message 会 ValueError）
    content = (json.dumps(assistant_blocks(thinking_blocks, text_content))
               if thinking_blocks else text_content)
    add_message_with_turn(chat_path, conversation_id=..., turn_id=turn_id,
                          role="assistant", subtype="normal", content=content)
```
> **不变量**：有 thinking 时 assistant 消息 content 是 **JSON list 字符串**；无 thinking 时是**纯文本**。

```python
# qe.py:325-362
async def finish(status, terminal_reason, *, final_text="", error=None, cancelled=False) -> TurnResult:
    data = {"status": status, "terminal_reason": terminal_reason, "final_text": final_text,
            "tool_rounds": tool_rounds, "num_turns": num_turns,
            "base_max_turns": base_max_turns, "max_turns": current_max_turns,
            "current_max_turns": current_max_turns, "auto_continue_count": auto_continue_count,
            "last_tool_error": last_tool_error,
            "input_tokens": total_input_tokens, "output_tokens": total_output_tokens}
    if cancelled: data["cancelled"] = True
    emit turn_end data
    return TurnResult(turn_id, status=status, final_text=final_text, tool_rounds=tool_rounds,
                      input_tokens=total_input_tokens, output_tokens=total_output_tokens,
                      error=error, num_turns=num_turns, max_turns=current_max_turns,
                      terminal_reason=terminal_reason, last_tool_error=last_tool_error)
```

### 2.3 阶段 8.9：主循环 `while True:`（qe.py:364-763）

#### (A) 循环顶部：取消检查（qe.py:365-375）

```python
if self._cancel_event.is_set():
    if num_turns == 0:
        add_message_with_turn(..., role="assistant", subtype="interrupted", content="[Interrupted]")
    return await finish("cancelled", "cancelled", cancelled=True)
```
`num_turns == 0` 时补一条 `[Interrupted]` 占位消息（保证消息链中 user 之后有 assistant，
配合 `sanitize_api_messages`）。`num_turns > 0` 时不补。

#### (B) 循环顶部：轮次预算（qe.py:377-449）

```python
if num_turns >= current_max_turns:
    can_auto_continue = (
        self.config.enable_auto_continue
        and auto_continue_count < self.config.max_auto_continues
        and not self._pending_permissions
        and not self._pending_user_inputs
        and not self._cancel_event.is_set()
    )
```
- **B1 自动续跑（can_auto_continue）**（qe.py:385-424）：
  ```python
  auto_continue_count += 1
  additional_turns = max(1, self.config.auto_continue_turns)      # 默认 10
  current_max_turns += additional_turns
  api_messages.append({"role": "user", "content": (
      "Continue the user's original task from the latest tool results. "
      "Do not repeat completed work. If you have enough information, "
      "provide the final answer. Use more tools only when necessary and "
      "continue to follow the existing permission requirements.")})
  logger.info("auto-continuing after turn budget reached", extra={...})
  emit auto_continue {"count": auto_continue_count, "additional_turns": additional_turns,
                      "num_turns": num_turns, "base_max_turns": base_max_turns,
                      "max_turns": current_max_turns, "current_max_turns": current_max_turns}
  continue
  ```
  **提示词原文（完整，含换行折叠为空格后的单行）**：
  > `Continue the user's original task from the latest tool results. Do not repeat completed work. If you have enough information, provide the final answer. Use more tools only when necessary and continue to follow the existing permission requirements.`

- **B2 收尾 pass（finalization）**（qe.py:426-435）：若 `pending_tool_results and not finalization_pass`：
  ```python
  finalization_pass = True
  api_messages.append({"role": "user", "content": (
      "The automatic turn budget is exhausted. Do not call tools. "
      "Summarize what has been completed, explain the latest tool result, "
      "name any blocker, and list the remaining work clearly.")})
  ```
  之后**不 continue**，直接落入本轮生成——本轮 `tools_for_call = []`（禁用工具）。
  > 提示词原文：
  > `The automatic turn budget is exhausted. Do not call tools. Summarize what has been completed, explain the latest tool result, name any blocker, and list the remaining work clearly.`

- **B3 真正耗尽**（qe.py:436-449）：`logger.warning("max turns reached", extra={...,"terminal_reason":"max_turns"})`
  → `return await finish("max_rounds", "max_turns")`。

#### (C) 单轮生成（qe.py:451-637）

每轮重置的局部变量（qe.py:451-458）：
```python
text_content = ""
thinking_blocks: list[dict] = []
tool_uses: list[dict] = []
usage_info: dict = {}                       # ★每轮新建；由 stream_chat_completion 原地写入
had_incomplete_tool_call = False
tools_for_call = [] if finalization_pass else tool_list
generation = None
generation_error: str | None = None
```

可观测性 generation（qe.py:459-466）：
```python
if self._active_trace is not None:
    generation = self._active_trace.start_generation(
        name="llm.agent_turn", channel=channel, model=model,
        messages=api_messages, tools_count=len(tools_for_call or []))
```

流式消费（qe.py:468-531）：`async for event in stream_chat_completion(channel, model, api_messages, usage_info, tools_for_call)`，
每轮先 `if self._cancel_event.is_set(): break`。归一化事件类型见 `03-providers.md`；此处按类型分发：

| 归一化事件 | 处理 | 发出的 TurnEvent |
|---|---|---|
| `thinking`（含 `thinking`/`signature` 字段） | `thinking_blocks.append(event)`（原文 dict 整体入列）；`preview = thinking[:200] + "..."`（>200 时） | `thinking {"content": event["thinking"], "preview": preview}` |
| `reasoning`（含 `content` 字段，OpenAI 系） | `thinking_blocks.append({"thinking": event["content"], "signature": ""})`；同样截 200 预览 | `thinking {"content": ..., "preview": ...}` |
| `text` | `text_content += event["content"]` | `text {"content": event["content"]}` |
| `tool_use` | `tool_uses.append(event)` | `tool_use {"name","id","input"}` |
| `incomplete_tool_call` | `had_incomplete_tool_call = True`；`logger.info("detected incomplete tool call, will auto-continue", extra={turn_id, tool_name})` | **不发事件** |

> `thinking_blocks` 的元素有两种形状：Anthropic 路径是 `{"type":"thinking","thinking":...,"signature":...}`，
> OpenAI 路径是 `{"thinking":...,"signature":""}`。`assistant_blocks()` 只读 `thinking`/`signature` 两个键，
> 所以两种都能用（并会统一重建成 `type=="thinking"` 的块）。`signature` 原样透传回 Anthropic 请求体。

异常处理与 reactive compact（qe.py:532-597）：见第 6 节。

`finally` 块（qe.py:598-637）——**每轮生成结束（含异常）都会执行**：
```python
if channel.provider_type == "anthropic":
    total_output_tokens += usage_info.get("output_tokens", 0)
    total_input_tokens = usage_info.get("input_tokens", 0)          # ★赋值而非累加
else:
    total_output_tokens += usage_info.get("completion_tokens", 0)
    total_input_tokens = usage_info.get("prompt_tokens", 0)         # ★赋值而非累加
if total_input_tokens == 0 and api_messages:
    total_input_tokens = TokenEstimator().estimate_api_messages(api_messages)   # DeepSeek 等不回 input 时兜底
update_conversation_usage(chat_path, conversation_id=..., total_output_tokens=total_output_tokens,
                          last_input_tokens=total_input_tokens)
if generation is not None:
    generation_output = assistant_blocks(thinking_blocks, text_content)
    generation_output.extend({"type":"tool_use","id":tu["id"],"name":tu["name"],"input":tu["input"]}
                             for tu in tool_uses)
    generation.finish(output=generation_output, usage_info=usage_info,
                      input_tokens=total_input_tokens,
                      output_tokens=usage_info.get("output_tokens")
                                   or usage_info.get("completion_tokens") or 0,
                      error=generation_error)
```
**usage 语义**：`output_tokens` 在轮内**累加**（跨轮累加，写入会话 `total_output_tokens`）；
`input_tokens` 每轮**覆盖**（最终值是最后一轮请求的输入量，写入会话 `last_input_tokens`）。

> **时序坑**：`except:` 分支里的 `return await finish(...)` 会**先执行完 `finish`（发出 turn_end）**，
> `finally` 才运行。所以**错误路径下 `turn_end` 携带的 token 数不含本轮失败请求的 usage**。

#### (D) 轮次计数（qe.py:639-640）
```python
num_turns += 1
pending_tool_results = False
```
注意：**只有成功完成一次生成（或产生异常）才会执行到这里**；`continue`（reactive compact 重试、
auto-continue、incomplete 重试）都跳过了这一行——即**失败重试与续跑不消耗轮次**。

#### (E) 取消复检（qe.py:642-644）
```python
if self._cancel_event.is_set():
    persist_normal_message(thinking_blocks, text_content)
    return await finish("cancelled", "cancelled", cancelled=True)
```

#### (F) finalization 轮中若模型仍产出工具调用（qe.py:646-653）
```python
if finalization_pass and tool_uses:
    reason = ("auto_continue_limit_reached"
              if self.config.enable_auto_continue
                 and auto_continue_count >= self.config.max_auto_continues
              else "max_turns")
    return await finish("max_rounds", reason)
```
**此时 assistant 的 tool_call 消息不落盘、工具不执行**（直接 return）。

#### (G) 无工具调用 → 结束分支（qe.py:655-711）

1. **incomplete tool call 重试**（qe.py:656-684）：`had_incomplete_tool_call and incomplete_continue_count < 3`
   ```python
   incomplete_continue_count += 1
   logger.info("auto-continuing after incomplete tool call",
               extra={turn_id, round: num_turns, auto_continue_count: incomplete_continue_count,
                      tool_name: "unknown"})
   persist_normal_message(thinking_blocks, text_content)
   api_messages.append({"role": "assistant",
                        "content": assistant_blocks(...) if thinking_blocks else text_content})
   api_messages.append({"role": "user", "content": (
       "Your last response was cut off mid-stream — the tool call JSON was incomplete. "
       "Please continue exactly where you left off and complete the tool call you started.")})
   continue
   ```
   > 提示词原文（注意其中的 em dash `—`）：
   > `Your last response was cut off mid-stream — the tool call JSON was incomplete. Please continue exactly where you left off and complete the tool call you started.`

   **注意**：这里的 assistant 消息是**直接 append 到 api_messages**（不落盘），而 `persist_normal_message`
   已另写了一份到 storage；下一轮重建 api_messages 时会从 storage 重新读入，因此内存追加只影响当前 turn。
   `incomplete_continue_count` 与 `auto_continue_count` 是**独立计数**。

2. **重试耗尽**（qe.py:686-692）：`return await finish("max_rounds", "incomplete_tool_call_limit_reached", final_text=text_content)`
   （先 `persist_normal_message`）。

3. **finalization 轮正常收尾**（qe.py:694-706）：
   ```python
   persist_normal_message(thinking_blocks, text_content)
   if finalization_pass:
       return await finish("max_rounds", reason, final_text=text_content)   # reason 同 (F)
   return await finish("completed", "completed", final_text=text_content)
   ```

#### (H) 有工具调用 → 执行分支（qe.py:713-763）

```python
assistant_content = assistant_blocks(thinking_blocks, text_content)
assistant_content.extend({"type":"tool_use","id":tu["id"],"name":tu["name"],"input":tu["input"]}
                         for tu in tool_uses)
add_message_with_turn(..., role="assistant", subtype="tool_call",
                      content=json.dumps(assistant_content))          # qe.py:724-731
api_messages.append({"role": "assistant", "content": assistant_content})
tool_rounds += 1

for tu in tool_uses:
    tool_result = await self._execute_tool(turn_id, tu["name"], tu["input"], tu["id"], on_event)
    if tool_result.get("ok", False):
        last_tool_error = None
    else:
        last_tool_error = tool_result.get("error_code") or "TOOL_ERROR"
    api_messages.append({"role": "tool", "tool_use_id": tu["id"], "content": tool_result["content"]})
    emit tool_result {"tool_use_id": tu["id"], "name": tu["name"], "ok": bool,
                      "content": str, "error_code": str | None}

pending_tool_results = True
```
**多工具调用是串行执行**（`for` + `await`），无并发、无批量。
`tool_rounds` 统计的是**含 tool_use 的 assistant 消息数**，不是工具调用次数。
`last_tool_error` 语义：最后一个工具的结果决定——成功则清 `None`，失败则记 `error_code`（缺省 `"TOOL_ERROR"`）。

执行完落回 `while True` 顶部，进入下一轮模型调用。

### 2.4 循环退出条件汇总

| 条件 | status | terminal_reason | 触发位置 |
|---|---|---|---|
| 取消（loop 顶或轮后） | `cancelled` | `cancelled` | qe.py:365, 642 |
| 预算耗尽且无法续跑 | `max_rounds` | `max_turns` | qe.py:449 |
| finalization 轮无 tool_use | `max_rounds` | `max_turns` / `auto_continue_limit_reached` | qe.py:702-706 |
| finalization 轮仍产 tool_use | `max_rounds` | 同上 | qe.py:653 |
| incomplete 重试耗尽 | `max_rounds` | `incomplete_tool_call_limit_reached` | qe.py:688-692 |
| 正常完成 | `completed` | `completed` | qe.py:707-711 |
| provider 异常（不可重试/重试失败） | `error` | `error` | qe.py:597 |
| 无模型 / 未捕获异常 | `error` | `None` | qe.py:141-149, 161-166 |

`terminal_reason` 的全部取值：`cancelled`、`max_turns`、`auto_continue_limit_reached`、
`incomplete_tool_call_limit_reached`、`completed`、`error`。

---

## 3. TurnEvent 事件表

所有事件由 `QueryEngine._emit(on_event, event)`（qe.py:1234-1240）投递；`on_event is None` 时静默丢弃。
唯一消费者是 TUI 的 `FlyinChatApp._handle_turn_event`（`app.py:486-537`）。

| # | event_type | data 字段 | 发出条件 | 发出点 | TUI 消费 |
|---|---|---|---|---|---|
| 1 | `turn_start` | `turn_number: int` | 每轮用户消息一开始 | qe.py:120 | 清空流式文本/渲染状态、隐藏 empty-state、渲染 todo 面板 |
| 2 | `error` | `message: str` | 无模型配置；`_run_turn` 未捕获异常；provider 异常且不可重试/重试未成功 | qe.py:136-139, 157-160, 593-596 | 停 spinner；若有 pending prompt 则重提交 |
| 3 | `skill_resolved` | `applied_skills: list[str]`、`active_phase: str`、`guards_applied: int` | `compiled_skill` 非空且 `applied_skills` 非空 | qe.py:220-231 | 重渲染历史 + 状态栏 |
| 4 | `compact_start` | `strategy: "preflight" \| "reactive"` | 预检压缩开始前 / reactive 重试前 | qe.py:244-246, 546-549 | `self._compacting = True` + 状态栏 |
| 5 | `compact_end` | `applied: bool`、`strategy: str` | 压缩结束（成功或未生效都发） | qe.py:272-279, 576-583, 585-592 | `self._compacting = False` |
| 6 | `thinking` | `content: str`、`preview: str`（>200 字符截断加 `...`） | 收到 `thinking` / `reasoning` 归一化事件 | qe.py:481-488, 498-505 | 忽略（`pass`） |
| 7 | `text` | `content: str`（增量片段） | 收到 `text` 归一化事件 | qe.py:508-511 | 追加到 `_streaming_assistant_text`；估算 output tokens = `max(1, len//4)`；重渲染 |
| 8 | `tool_use` | `name: str`、`id: str`、`input: dict` | 收到 `tool_use` 归一化事件 | qe.py:514-525 | 忽略（`pass`） |
| 9 | `tool_result` | `tool_use_id: str`、`name: str`、`ok: bool`、`content: str`、`error_code: str \| None` | 每个工具执行完成后 | qe.py:748-761 | 仅当 `name == "todo_write"` 时刷新 todo 面板 |
| 10 | `auto_continue` | `count: int`、`additional_turns: int`、`num_turns: int`、`base_max_turns: int`、`max_turns: int`、`current_max_turns: int` | 轮次预算耗尽但允许自动续跑 | qe.py:409-423 | **未处理**（match 里无分支，静默忽略） |
| 11 | `permission_required` | `request_id: str`、`tool_name: str`、`tool_call_id: str`、`tool_input: dict`、`args_preview: str`、`risk_level: str`、`reason: str`、`expires_at: float` | 工具返回 `PERMISSION_REQUIRED` | qe.py:952-968 | `_show_permission_request(data)`，等用户按键 |
| 12 | `user_input_required` | `request_id: str`、`tool_name: str`、`tool_call_id: str`、`questions: list` | 工具返回 `USER_INPUT_REQUIRED` | qe.py:1119-1131 | `_show_user_input_form(data)` |
| 13 | `turn_end` | `status`、`terminal_reason`、`final_text`、`tool_rounds`、`num_turns`、`base_max_turns`、`max_turns`、`current_max_turns`、`auto_continue_count`、`last_tool_error`、`input_tokens`、`output_tokens`，取消时额外 `cancelled: True` | `finish()` 里，任何正常路径结束 | qe.py:349 | 更新 token 计数、停 spinner、重渲染；若 `cancelled` 且有 pending prompt 则重提交 |

**注意**：
- `turn_end` **不会**在「无模型配置」和「未捕获异常」两条路径发出（只有 `error`）。复刻 UI 时必须同时
  以 `error` 作为终止信号。
- `permission_required` / `user_input_required` 是**阻塞式**的：`_handle_permission_required` 会
  `await asyncio.wait_for(future, timeout=...)`，直到 TUI 调 `resolve_permission()` / `resolve_user_input()`
  或超时。
- 事件全部是 `frozen dataclass`，`data` 是可变的 dict（发射后调用方不应修改）。

---

## 4. prompt_assembler 分层结构

`assemble_system_prompt(mode="normal", compact_summary=None, skill_injection=None) -> str`
（prompt_assembler.py:71-103）。

拼装顺序（`"\n\n".join(sections)`，每段先 `.strip()`）：

| 层 | 内容 | 可选 |
|---|---|---|
| 1 | `BASE_SYSTEM` | 必选 |
| 2 | mode 段：`MODE_NORMAL` / `MODE_PLAN` / `MODE_AUTO_EDIT` / `MODE_YOLO`（未知 mode 回落 `MODE_NORMAL`） | 必选 |
| 3 | `SAFETY_POLICY` | 必选 |
| 4 | `SUBAGENT_AWARENESS` | 必选 |
| 5 | `f"Skill planning guidance:\n{skill_injection.strip()}"` | 仅当 `skill_injection` 为真 |
| 6 | `f"Historical summary (compacted conversation):\n{compact_summary.strip()}"` | 仅当 `compact_summary` 为真 |

> **文档偏差**：函数的 docstring 写的是 `BASE_SYSTEM → mode section → SAFETY_POLICY → skills → compact summary`，
> 漏掉了第 4 层 `SUBAGENT_AWARENESS`。以代码为准。

`mode_int_to_str(mode_int) -> str`：`{0: "normal", 1: "auto_edit", 2: "yolo", 3: "plan"}`，未知返回 `"normal"`。

### 4.1 各层原文（逐字）

**第 1 层 `BASE_SYSTEM`**（prompt_assembler.py:8-15）：
```
You are FlyinChat's engineering task agent. Your primary goal is to complete user tasks while ensuring safety, verifiability, and rollback capability.

Behavioral principles:
1. Understand the goal before acting; state assumptions when uncertain.
2. Prefer minimal changes — do not refactor unrelated code.
3. Before any side-effect operation, check whether the current mode allows it.
4. Prefer dedicated tools over arbitrary shell commands.
5. Output must be executable, verifiable, and traceable.
```

**第 2 层 `MODE_NORMAL`**（17-20）：
```
Current mode: NORMAL
- You may analyze and execute normally.
- Evaluate risk and necessity before each action; prefer minimal changes.
- If an operation is potentially destructive, give a brief risk note and rollback plan first.
```

`MODE_PLAN`（22-30）：
```
Current mode: PLAN
Hard constraints:
- ONLY analysis, planning, and information gathering are allowed.
- Permitted: file_read, and read-only bash commands (ls, cat, head, tail, find, grep, git status/log/diff, etc.).
- Each bash command requires user approval; prefer file_read when possible.
- Forbidden: file_write and any command that modifies files or system state.
Output requirements:
- Explore the codebase to understand the architecture before proposing a plan.
- Produce a structured plan: goal, assumptions, steps, affected files, verification, risks, rollback.
```

`MODE_AUTO_EDIT`（32-37）：
```
Current mode: AUTO_EDIT
Execution strategy:
- Modify step by step according to plan.
- Each step must: generate patch → apply → verify → record result.
- If verification fails, immediately rollback and report the failure reason.
- High-risk changes require explicit confirmation or follow the approval policy.
```

`MODE_YOLO`（39-42）：
```
Current mode: YOLO
- Higher automation level is permitted, but underlying safety gates still apply.
- After each step, output: what was changed, verification result, failure/rollback status.
- Even in YOLO mode, do not skip critical verification and audit records.
```

**第 3 层 `SAFETY_POLICY`**（44-53）：
```
Tool usage policy:
1. Use dedicated tools first, then consider general shell commands.
2. Read/search tools take priority over write/execute tools.
3. If the current mode forbids an operation, do NOT attempt to call that tool.
4. If you receive a permission denial, adjust your approach immediately — do not repeat similar forbidden calls.
5. CRITICAL: When you state you will take an action (e.g. "Let me use Python to fix this"), you MUST immediately call the tool in the same turn. Never end a response with just a description of what you plan to do.

Output format:
- For each execution step: "purpose → action → result → next step".
- For each failure step: "cause → rollback status → alternative plan".
```

**第 4 层 `SUBAGENT_AWARENESS`**（55-61）：
```
Sub-agent delegation:
- Use the sub_agent tool when a sub-task would produce large search/log/tool output, needs independent investigation, or benefits from a specialized role.
- Available built-in roles: general-purpose, code-reviewer, debugger, test-runner.
- The sub-agent task must be self-contained; do not assume it has the full parent conversation.
- Pass only selected context that is necessary for the delegated task.
- Sub-agent results are summaries, not ground truth. Verify important findings before acting on them.
- Do not use sub_agent for trivial single-file reads, small direct edits, or questions that need immediate user clarification.
```

**第 5 层（skill 注入）** —— 由 `SkillCompiler._planning_injection(decision)` 生成（skills/compiler.py:32-50），
外层包一行 `Skill planning guidance:`。内文模板：
```
Active Skills:
- Selection reason: {decision.reason}
- Phase model: discover -> validate -> apply -> verify
- {manifest.ref}: {manifest.description}
  Workflow: {workflow 压成单行}
  Verification: {verification_checklist 压成单行}
Follow the active skill workflow and satisfy its verification checklist before finalizing.
```
- `_PHASE_MODEL = ("discover", "validate", "apply", "verify")`，用 `" -> "` 连接。
- `manifest.ref = f"{name}@{version}"`（默认 version `0.1.0`）。
- `Workflow:` 行取自 skill 的 `## Workflow` 段，`Verification:` 取自 `## Verification Checklist` 段，
  都经 `_single_line()` 把换行折叠为空格。
- `decision.reason` 固定为 `"selected by deterministic keyword, tag, and workflow matching"`（选中时）。
- 无选中 skill 时返回 `""`（falsy → 不追加该层）。

**第 6 层（compact 历史注入）** —— 内容来自 `_extract_compact_summary()`，来自存储中
`{"type": "compact_summary", "summary": "..."}` 消息经 `message_to_api_format` 变成的
`{"role": "system", "content": summary}`。外层包一行 `Historical summary (compacted conversation):`。

### 4.2 与权限模式的关系

**注意 system prompt 里的 mode 段与 TUI 的 `PermissionContext` 是两套独立机制**：prompt 段是
「前置告知」，实际拦截靠 `ToolExecutor`（`PERMISSION_REQUIRED` → 弹窗）。TUI 在
`_apply_mode_permissions()`（`app.py:2160-2199`）里按 mode 设置 `allowed_tools` / `ask_tools` / `denied_tools`：

| mode | allowed_tools | ask_tools | denied_tools |
|---|---|---|---|
| 0 normal | file_read, glob, grep, todo_write, ask_user_question, sub_agent | file_write, file_edit, bash, web_fetch, web_search, enter_plan_mode, exit_plan_mode | ∅ |
| 1 auto_edit | file_read, file_write, file_edit, glob, grep, todo_write, ask_user_question, sub_agent | bash, web_fetch, web_search, enter_plan_mode, exit_plan_mode | ∅ |
| 2 yolo | `None`（= 全部允许） | ∅ | ∅ |
| 3 plan | file_read, glob, grep, todo_write, ask_user_question, sub_agent, enter_plan_mode, exit_plan_mode | bash, web_fetch, web_search | file_write, file_edit |

同时把 `query_engine.mode = mode_int_to_str(self._mode)`，使 prompt 的 mode 段与之对应。

---

## 5. compact.py 完整算法

### 5.1 TokenEstimator（compact.py:52-76）

```python
@dataclass(frozen=True)
class TokenEstimator:
    cjk_weight: float = 1.5
    other_weight: float = 0.3

    def estimate(self, text: str) -> int:
        if not text:
            return 0
        cjk_count = len(_CJK_RE.findall(text))
        other_count = len(text) - cjk_count
        return max(1, int(cjk_count * self.cjk_weight + other_count * self.other_weight))
```
CJK 正则（compact.py:46-49，覆盖 CJK 统一表意文字及扩展、兼容区、CJK 标点/全角符号/假名补充）：
```python
_CJK_RE = re.compile(
    r"[⺀-⻿　-〿㇀-㇯㐀-䶿"
    r"一-鿿豈-﫿︰-﹏＀-￯]"
)
```
- `estimate("") == 0`；任何非空文本至少返回 1。
- `estimate("hello world") == 3`（11 × 0.3 = 3.3 → int → 3）。
- `estimate("a"*100) == 30`。
- `estimate_messages(messages)` = `sum(estimate(msg.content))`。
- `estimate_api_messages(api_messages)` = `sum(estimate(json.dumps(m, ensure_ascii=False)))`——
  这条路径会把 JSON 结构字符也算进去，**通常显著高于** `estimate_messages`。

### 5.2 CompactionPolicy（compact.py:79-96）

```python
@dataclass(frozen=True)
class CompactionPolicy:
    context_window: int
    tool_result_budget_chars: int = 8_000
    soft_limit_ratio: float = 0.70
    preserve_turns: int = 4

    @property
    def soft_limit(self) -> int:  return int(self.context_window * self.soft_limit_ratio)
    @property
    def hard_limit(self) -> int:  return self.context_window

    @classmethod
    def from_model(cls, model: LLMModel) -> CompactionPolicy:
        return cls(context_window=model.context_window)
```

**关于「context window 与 output 预留」**：**本实现没有任何 output token 预留**。
`hard_limit` 就是 `context_window` 原值；`model.max_output_tokens`（默认 384_000）**完全不参与**压缩策略计算，
只被 provider 层当作请求体的 `max_tokens`。复刻时如要做输出预留，需自行引入（会偏离原行为）。

`LLMModel.context_window` 默认 `125_000`（models.py:23）。所以默认
`soft_limit = int(125000 × 0.70) = 87500`，`hard_limit = 125000`（`test_compaction_policy_thresholds` 断言）。
DeepSeek preset 会写入 1M context（`storage.py` 的 preset）。

### 5.3 CompactionEngine 与 CompactionOutput

```python
# compact.py:22-29
@dataclass(frozen=True)
class CompactionOutput:
    applied: bool
    messages: tuple[Message, ...]
    boundary_message: Message | None = None
    tokens_before: int = 0
    tokens_after: int = 0
    strategy: str = ""

# compact.py:32-42
@dataclass(frozen=True)
class CompactMetadata:
    boundary_id: str
    strategy: str
    source_range_from: str
    source_range_to: str
    preserved_head_ids: tuple[str, ...]
    preserved_tail_id: str
    summary_msg_id: str
    tokens_before: int
    tokens_after: int

# compact.py:99-105
@dataclass
class CompactionEngine:
    _chat_path: Path
    _conversation_id: str
    _estimator: TokenEstimator = field(default_factory=TokenEstimator)
    _i18n: I18nStore = field(default_factory=I18nStore)
    _observability: AgentTrace | None = None
```

方法签名：
```python
def compact_if_needed(self, messages, api_messages, policy, *, force=False,
                      model=None, channel=None) -> CompactionOutput                       # :107
async def compact_if_needed_async(self, messages, api_messages, policy, *, force=False,
                                  model=None, channel=None) -> CompactionOutput           # :131
def _autocompact_sync(self, messages, api_messages, policy, model, channel, tokens_before) # :156
def _apply_tool_result_budget(self, messages, api_messages, policy, tokens_before)         # :187
async def _autocompact(self, messages, api_messages, policy, model, channel, tokens_before) # :239
async def reactive_compact(self, messages, api_messages, policy, model, channel, reason)   # :317
@staticmethod
def _find_split_index(messages, preserve_turns) -> int                                     # :338
async def _generate_summary(self, messages, model, channel) -> str                         # :348
```
- `compact_if_needed_async` 是 QueryEngine 唯一使用的入口（注释说明是「给 @work 方法在事件循环上用」）。
- `_autocompact_sync` 只在非 async 上下文使用；若无运行中的 loop 就新建 loop 跑 `run_until_complete`，
  若同线程已有运行中的 loop 就 `asyncio.run_coroutine_threadsafe(...).result()`——**在同一线程的
  运行中 loop 上调用会死锁**，这是危险路径，QueryEngine 不走它。

### 5.4 触发判定（compact_if_needed_async，compact.py:131-154）

```python
estimated = self._estimator.estimate_messages(messages)

if force or estimated > policy.soft_limit:
    result = self._apply_tool_result_budget(messages, api_messages, policy, estimated)
    if result.applied:
        return result                                   # strategy = "tool_result_budget"

if estimated > policy.hard_limit or (force and model is not None and channel is not None):
    if model is None or channel is None:
        return CompactionOutput(applied=False, messages=tuple(messages))
    return await self._autocompact(messages, api_messages, policy, model, channel, estimated)

return CompactionOutput(applied=False, messages=tuple(messages), tokens_before=estimated)
```
要点：
- **软限制**（`estimated > soft_limit = 0.70 × context_window`）只触发「工具结果截断」；
  截断生效就直接返回，**不会再做摘要**（即便已超硬限制）。
- **硬限制**（`estimated > context_window`）触发 LLM 摘要（`_autocompact`）。
- `force=True` 且给了 `model`/`channel` 时会跳过阈值直接走摘要分支（`/compact` 命令用它）。
- `estimated` 用的是 `estimate_messages`（基于持久化 `Message.content`），**不含 system prompt**
  （system prompt 是每轮临时组装的，不在存储里）。

### 5.5 软限制：工具结果截断 `_apply_tool_result_budget`（compact.py:187-237）

```python
truncated = 0
for i, msg in enumerate(messages):
    try:
        parsed = json.loads(msg.content)
    except (json.JSONDecodeError, TypeError):
        continue
    if not (isinstance(parsed, dict) and "tool_use_id" in parsed):
        continue
    content = parsed.get("content", "")
    if not isinstance(content, str) or len(content) <= policy.tool_result_budget_chars:
        continue
    head = content[:2000]
    tail = content[-500:]
    truncated_chars = len(content) - 2000 - 500
    truncated_content = f"{head}\n...[truncated {truncated_chars} chars]...\n{tail}"
    parsed["content"] = truncated_content
    new_content = json.dumps(parsed)
    update_message_content(self._chat_path, message_id=msg.id, content=new_content)
    if i < len(api_messages):
        api_messages[i]["content"] = truncated_content
    truncated += 1

if truncated == 0:
    return CompactionOutput(applied=False, messages=tuple(messages), tokens_before=tokens_before)

updated = list_messages(self._chat_path, conversation_id=self._conversation_id)
tokens_after = self._estimator.estimate_messages(updated)
return CompactionOutput(applied=True, messages=tuple(updated), tokens_before=tokens_before,
                        tokens_after=tokens_after, strategy="tool_result_budget")
```
- 阈值：`len(content) > policy.tool_result_budget_chars`（默认 **8000** 字符）。
- 截断算法：保留**头 2000 字符 + 尾 500 字符**，中间替换为
  `\n...[truncated {N} chars]...\n`（`N = len(content) - 2500`）。
- **只处理 content 是 JSON dict 且含 `tool_use_id` 键的消息**（即 tool 结果消息）；user/assistant
  消息无论多长都不截断（`test_tool_result_budget_skips_non_tool_messages`）。
- 截断**写回存储**（`update_message_content`，按 `message_id` 覆盖 content）。
- 返回值 `messages` 是 `list_messages(...)` 的**全量会话消息**（不是活跃消息）。

### 5.6 硬限制：LLM 摘要 `_autocompact`（compact.py:239-315）

```python
split_idx = self._find_split_index(messages, policy.preserve_turns)
if split_idx <= 0:
    return CompactionOutput(applied=False, messages=tuple(messages), tokens_before=tokens_before)

summarize_msgs = messages[:split_idx]
preserved_msgs = messages[split_idx:]
summary_text = await self._generate_summary(summarize_msgs, model, channel)

summary_msg = add_message(self._chat_path, conversation_id=self._conversation_id,
    role="system", content=json.dumps({"type": "compact_summary", "summary": summary_text,
                                       "summarized_count": len(summarize_msgs)}))

metadata = CompactMetadata(
    boundary_id=str(uuid4()), strategy="autocompact_v1",
    source_range_from=summarize_msgs[0].id, source_range_to=summarize_msgs[-1].id,
    preserved_head_ids=tuple(m.id for m in preserved_msgs),
    preserved_tail_id=preserved_msgs[-1].id if preserved_msgs else "",
    summary_msg_id=summary_msg.id, tokens_before=tokens_before, tokens_after=0)

boundary_msg = add_message(self._chat_path, conversation_id=self._conversation_id,
    role="system", content=json.dumps({
        "type": "compact_boundary", "boundary_id": ..., "strategy": "autocompact_v1",
        "source_range_from": ..., "source_range_to": ...,
        "preserved_head_ids": [...], "preserved_tail_id": ...,
        "summary_msg_id": ..., "tokens_before": ..., "tokens_after": 0}))

update_conversation_compacted_count(self._chat_path, conversation_id=..., count=len(summarize_msgs))
updated = list_messages(self._chat_path, conversation_id=self._conversation_id)
tokens_after = self._estimator.estimate_messages(updated)
return CompactionOutput(applied=True, messages=tuple(updated), boundary_message=boundary_msg,
                        tokens_before=tokens_before, tokens_after=tokens_after,
                        strategy="autocompact_v1")
```

`_find_split_index(messages, preserve_turns)`（compact.py:338-346）：
```python
turn_count = 0
for i in range(len(messages) - 1, -1, -1):
    if messages[i].role == "user":
        turn_count += 1
        if turn_count >= preserve_turns:
            return i
return 0
```
即从尾部往回数 `preserve_turns` 条 user 消息，返回该 user 消息的下标；保留段 = `messages[split_idx:]`
（**从那条 user 消息开始**，含它）。默认 `preserve_turns=4`。
若总 user 消息数 < `preserve_turns` → 返回 0 → **不压缩**（安全阀）。

**落盘顺序**（重要，影响 `list_active_messages` 的 boundary 定位）：
`summary(system, subtype="normal")` → `boundary(system, subtype="normal")` → 之后追加新消息。
两条都是 `add_message`（`subtype` 用默认 `"normal"`，**没有** `subtype="compact_boundary"`），
识别靠 content 里的 `"type"` 字段。两者 `turn_id` 均为 `""`。
`tokens_after` 在 boundary 的 JSON 里**恒为 0**（写入时 metadata 未填），真实值只在
`CompactionOutput.tokens_after` 里（供 `mark_compaction` 与 TUI 面板用）。
`update_conversation_compacted_count` 写入的是 `len(summarize_msgs)`（**覆盖式赋值**，不是累加）。

### 5.7 摘要提示词与历史序列化 `_generate_summary`（compact.py:348-434）

角色标签（i18n，en 值）：
| TKey | en | zh（`i18n/zh.py` 同键） |
|---|---|---|
| `COMPACT_ROLE_USER` | `User` | 用户 |
| `COMPACT_ROLE_ASSISTANT` | `Assistant` | 助手 |
| `COMPACT_ROLE_TOOL` | `Tool` | 工具 |
| `COMPACT_ROLE_SYSTEM` | `System` | 系统 |
| `COMPACT_CONVERSATION_HISTORY` | `Conversation history:` | 对话历史： |
| `COMPACT_OUTPUT_SUMMARY` | `Please output the summary:` | 请输出摘要： |

`COMPACT_SUMMARY_PROMPT` 原文（`i18n/en.py:242-248`）：
```
Please summarize the following conversation history into a concise summary. Preserve:
- The user's main requests and goals
- The tools used by the assistant and their key results
- Important decisions and conclusions
The summary should be concise but should not lose key information.
```
zh 版本（`i18n/zh.py:239-245`，含 `\n` 换行）：
```
请将以下对话历史总结成简洁的摘要。保留：
- 用户的主要请求和目标
- 助手使用的工具及其关键结果
- 重要的决策和结论
摘要应该用中文，尽量简洁但不要丢失关键信息。
```

> **语言实际恒为英文**：`I18nStore.__init__(lang=Language.EN)`（`i18n/store.py:24`），
> `CompactionEngine._i18n: I18nStore = field(default_factory=I18nStore)`（compact.py:104）。
> QueryEngine 构造压缩引擎时（qe.py:239-243、554-558）**不传 `_i18n`** → 始终用英文提示词与英文角色标签，
> 即使 App 设置为中文。只有 TUI 的 `/compact` 命令显式传了 `_i18n=self.i18n`（`app.py:1710`），
> 那条路径才会本地化。复刻时注意这个不一致。

最终 prompt 组装（compact.py:394-399）：
```python
summary_prompt = f"""{t(TKey.COMPACT_SUMMARY_PROMPT)}

{t(TKey.COMPACT_CONVERSATION_HISTORY)}
{history_text}

{t(TKey.COMPACT_OUTPUT_SUMMARY)}"""
summary_messages: list[dict] = [{"role": "user", "content": summary_prompt}]
```
即：`摘要指令 + "\n\n" + "Conversation history:" + "\n" + 历史正文 + "\n\n" + "Please output the summary:"`。

历史逐条序列化规则（compact.py:361-390）：先 `json.loads(msg.content)`：
| content 形状 | 产生的一行 |
|---|---|
| JSON **list**（assistant 块数组） | 各块拼 `" "`：`tool_use` 块 → `[调用工具 {name}：{json input}]`（**中文字面量，硬编码**）；`text` 块 → `block["text"]`；其他块忽略。然后 `f"{role_label}: {joined}"` |
| dict 且 `event == "skill.resolve.complete"` | `f"{role_label}: [Skills applied: {applied}; phase: {phase}; guards: {len(guards)}]"`（`applied` 用 `", "` 连接，空则 `none`） |
| dict 且含 `"tool_use_id"` | `content` 取前 500 字符（超出加 `...`），`f"{role_label}: {preview}"` |
| 其他 dict | `f"{role_label}: {msg.content}"` |
| JSON 解析失败 / TypeError | `f"{role_label}: {msg.content}"` |

`history_text = "\n".join(history_parts)`。

调用与可观测性（compact.py:401-434）：
```python
generation = self._observability.start_generation(       # 仅当 _observability 非 None
    name="llm.compaction_summary", channel=channel, model=model,
    messages=summary_messages, tools_count=0, max_tokens=2048)
summary = await chat_completion(channel, model, summary_messages, max_tokens=2048)
# 异常：generation.finish(output="", usage_info={},
#         input_tokens=self._estimator.estimate_api_messages(summary_messages),
#         output_tokens=0, error=str(exc)) 然后 raise
# 成功：generation.finish(output=summary, usage_info={},
#         input_tokens=estimate_api_messages(summary_messages),
#         output_tokens=self._estimator.estimate(summary))
```
- 摘要调用是**非流式**、`max_tokens=2048`、单条 user 消息、**不传 tools**。
- 摘要失败的异常会向上抛：`compact_if_needed_async` 不捕获 → 冒泡到 `_run_turn` 的 preflight 调用点
  → `submit_message` 的 `except Exception` → emit `error` + `TurnResult(status="error")`。
  **即：预检摘要失败会直接终止整轮 turn。**

### 5.8 Reactive compact（compact.py:317-336）

```python
aggressive_policy = CompactionPolicy(
    context_window=policy.context_window,
    tool_result_budget_chars=2_000,      # 8000 → 2000
    preserve_turns=1,                    # 4 → 1
)                                        # soft_limit_ratio 保持默认 0.70
_ = self._apply_tool_result_budget(messages, api_messages, aggressive_policy, 0)
updated = list_messages(self._chat_path, conversation_id=self._conversation_id)
tokens_before = self._estimator.estimate_messages(updated)
return await self._autocompact(updated, api_messages, aggressive_policy, model, channel, tokens_before)
```
- `reason` 参数被接收但**未使用**（只作为文档性入参）。
- 无论截断是否生效都继续做摘要；若 `_find_split_index` 返回 0 则整体 `applied=False`。
- 成功后写新的 summary + boundary，因此一次会话可能有**多条 boundary**；
  `list_active_messages` 取**第一条**（最早）的 boundary → 这是下一节的坑。

### 5.9 所有阈值常量一览（照抄）

| 常量 | 值 | 位置 |
|---|---|---|
| `QueryEngineConfig.max_tool_rounds` | `10` | qe.py:50 |
| `QueryEngineConfig.max_turns` | `None`（回落 `max_tool_rounds`，且 `max(1, ...)`） | qe.py:51, 281 |
| `QueryEngineConfig.max_context_retries` | `1` | qe.py:52 |
| `QueryEngineConfig.enable_auto_compact` | `True` | qe.py:53 |
| `QueryEngineConfig.enable_auto_continue` | `True` | qe.py:55 |
| `QueryEngineConfig.max_auto_continues` | `3` | qe.py:56 |
| `QueryEngineConfig.auto_continue_turns` | `10` | qe.py:57 |
| `max_incomplete_continues` | `3`（局部硬编码） | qe.py:290 |
| `CompactionPolicy.tool_result_budget_chars` | `8_000` | compact.py:82 |
| `CompactionPolicy.soft_limit_ratio` | `0.70` | compact.py:83 |
| `CompactionPolicy.preserve_turns` | `4` | compact.py:84 |
| reactive `tool_result_budget_chars` | `2_000` | compact.py:328 |
| reactive `preserve_turns` | `1` | compact.py:329 |
| 工具结果截断 head / tail | `2000` / `500` 字符 | compact.py:208-210 |
| 摘要里 tool 结果预览 | `500` 字符 | compact.py:385 |
| 摘要 `max_tokens` | `2048` | compact.py:413, 416 |
| thinking 事件 preview | `200` 字符 | qe.py:476-480 |
| `TokenEstimator.cjk_weight` | `1.5` | compact.py:62 |
| `TokenEstimator.other_weight` | `0.3` | compact.py:63 |
| 权限请求超时 | `120.0` 秒 | qe.py:936, 970 |
| 用户问答超时 | `120.0` 秒 | qe.py:1134 |
| `sanitize_args` 单值长度上限 | `80` | tools/permission_request.py:198 |
| httpx 超时（provider） | `120.0` 秒 | api_client.py:133, 389, 531, 570 |
| `LLMModel.context_window` | `125_000` | models.py:23 |
| `LLMModel.max_output_tokens` | `384_000` | models.py:24 |
| `LLMModel.thinking_enabled` / `reasoning_effort` | `True` / `"high"` | models.py:21-22 |
| `SEED_AUTO_ALLOW_PATTERNS`（bash 免批准命令种子集） | 见 tools/core.py:17-27 | tools/core.py |

---

## 6. 错误处理、重试与取消

### 6.1 Provider 流式异常与 reactive compact（qe.py:532-597）

```python
except Exception as error:
    error_str = str(error)
    generation_error = error_str
    if compact_retry_remaining > 0 and (
        "context_length_exceeded" in error_str
        or "413" in error_str
        or "too long" in error_str.lower()
        or "maximum context length" in error_str.lower()
    ):
        compact_retry_remaining -= 1
        logger.warning("context length exceeded, retrying with reactive compact",
                       extra={"turn_id": turn_id, "round": num_turns, "error": error_str})
        emit compact_start {"strategy": "reactive"}
        all_messages = list_messages(chat_path, conversation_id=...)       # ★全量，非活跃
        reactive_engine = CompactionEngine(chat_path, conversation_id,
                                           _observability=self._active_trace)
        policy = CompactionPolicy.from_model(model)
        reactive_result = await reactive_engine.reactive_compact(
            all_messages, api_messages, policy, model, channel, reason=error_str)
        if reactive_result.applied:
            self._active_trace.mark_compaction(...)                        # 若非 None
            active_messages = list(reactive_result.messages)
            api_messages[:] = sanitize_api_messages([... rebuild ...])      # ★原地替换
            emit compact_end {"applied": True, "strategy": "reactive"}
            continue                                                       # ★重试本轮（不消耗 num_turns）
        emit compact_end {"applied": False, "strategy": "reactive"}
    emit error {"message": error_str}
    return await finish("error", "error", error=error_str)
```
- 匹配是**朴素子串匹配**，大小写敏感性不一致：前两个条件原样匹配，后两个先 `.lower()`。
- 只重试 `max_context_retries`（默认 1）次；`compact_retry_remaining` 是**整个 turn 共享**的。
- `continue` 会先跑 `finally`（usage 落盘 + generation.finish(error=...)），再回到 `while` 顶部；
  **`num_turns` 不增加**。
- reactive 失败（未 applied）→ 落回 emit `error` + `finish("error","error")`。

### 6.2 工具错误

工具层**永不抛异常到 `_run_turn`**（`ToolExecutor._run_tool` / `execute_approved` 都 try/except →
`ToolResult(ok=False, error_code="TOOL_RUNTIME_ERROR", content=f"{type(e).__name__}: {e}")`）。
因此工具失败只是：
1. `_persist_tool_result` 落盘一条 `role="tool"` 消息（带 `meta.error_code`）；
2. `last_tool_error = error_code or "TOOL_ERROR"`；
3. 结果作为普通 `tool` 消息回灌给模型，由模型决定如何恢复。

`ToolExecutor.execute` 的判定链（tools/core.py:159-223）：
1. `registry.get(tool_name)` → 缺失 → `TOOL_NOT_FOUND`；
2. skill 运行时守卫 `evaluate_skill_guards(guards_from_turn_state(context.turn_state), ...)`
   → 拒绝：`ask_user` 时 `PERMISSION_REQUIRED`，否则 `SKILL_GUARD_DENIED`（meta 里带 guard 信息）；
3. `_tool_allowed(tool_name, context)`（denied → `PERMISSION_DENIED`；allowed → 通过；
   ask → 若命中 `_is_tool_auto_allowed`（按名字 auto-allow 或 bash 命中 `command_auto_allowlist` 前缀）
   则直接执行，否则 `PERMISSION_REQUIRED`；`allowed_tools is None` → 全部通过）；
4. `tool.requires_permission(input, context)` → 不允许则 `PERMISSION_DENIED` / `PERMISSION_REQUIRED`；
5. `tool.run(...)` 包 try/except。

`QueryEngine._execute_tool` 特殊分支：
```python
if self._tool_executor is None or self._tool_context is None:
    result_text = "Tool system not initialized"
    # 落盘 role="tool" 消息，meta={"error_code": "TOOL_NOT_INITIALIZED"}
    return {"ok": False, "content": result_text, "tool_use_id": ..., "tool_name": ...,
            "error_code": "TOOL_NOT_INITIALIZED"}
```

### 6.3 权限请求（qe.py:914-1101）

```python
request = PermissionRequest.create(
    session_id=self.config.conversation_id, turn_id=turn_id, tool_call_id=tool_use_id,
    tool_name=tool_name, args_preview=sanitize_args(tool_input), risk_level=risk_level,
    reason=execute_result.content, timeout_seconds=120.0)
request = request.with_status(RequestStatus.PENDING_USER_APPROVAL)
self._permission_store.save(request)
self._write_permission_transcript(turn_id, "permission_request_created",
    request_id=..., tool_name=..., args_preview=..., risk_level=...)
future = asyncio.get_running_loop().create_future()
self._pending_permissions[request.request_id] = future
emit permission_required {...}
remaining = max(request.expires_at - time.time(), 1.0)
try: resolution = await asyncio.wait_for(future, timeout=remaining)
except asyncio.TimeoutError: resolution = "timeout"
del self._pending_permissions[request.request_id]
```
`risk_level = getattr(self._tool_registry.get(tool_name), "risk_level", "medium")`
——**若工具未注册会抛 `KeyError`（未捕获）**，冒泡到 `submit_message` 变成 `status="error"`。

四种 resolution 的结果：

| resolution | store 状态链 | 执行 | 落盘 ToolResult | trace |
|---|---|---|---|---|
| `"approve"` | APPROVED → EXECUTED / FAILED_AFTER_APPROVAL | `execute_approved(...)` | 真实结果 | `"executed"` / `"failed_after_approval"` |
| `"always_approve"` | 同 approve，**额外**把命令前缀加入 `ToolExecutor.command_auto_allowlist` | `execute_approved(...)` | 真实结果 | 同上 |
| `"deny"` | DENIED | 不执行 | `ok=False, content=f"User denied permission for {tool_name}", error_code="PERMISSION_DENIED"` | `"denied"` |
| `"timeout"`（其它值同） | EXPIRED | 不执行 | `ok=False, content=f"Permission request timed out for {tool_name}", error_code="PERMISSION_DENIED"` | `"timeout"` |

`always_approve` 的 allowlist 提取：
```python
cmd = tool_input.get("command", "").strip()
parts = shlex.split(cmd)  # ValueError 时退化为 cmd.split()
pattern = _extract_command_pattern(parts)   # git 开头 → "git {subcommand}"，否则 parts[0]
self._tool_executor.add_command_to_allowlist(pattern)
```
（TUI 侧 `app.py:1481-1505` 对 `always_approve` 会**再做一次**同样的提取，且对 `mcp_` 前缀工具走
`add_auto_allow_tool`。）

每次状态流转都写一条 transcript：`_write_permission_transcript(turn_id, event_type, **kwargs)`
→ `add_message_with_turn(role="system", subtype="permission_event", content=json.dumps({"event": event_type, **kwargs}))`。
事件名：`permission_request_created`、`permission_request_resolved`（带 `resolution`）、
`permission_effect_applied`（带 `outcome` / `error`）。这些消息**不发给模型**（`message_to_api_format` 返回 None）。

`resolve_permission(request_id, resolution) -> bool`：future 不存在或已 done 时打 warning 返回 `False`，
否则 `set_result(resolution)` 返回 `True`。

### 6.4 用户问答（qe.py:1103-1144）

```python
questions = execute_result.meta.get("questions", [])
user_input_id = str(uuid4())
future = asyncio.get_running_loop().create_future()
self._pending_user_inputs[user_input_id] = future
emit user_input_required {"request_id": user_input_id, "tool_name": ..., "tool_call_id": ..., "questions": questions}
try: answers = await asyncio.wait_for(future, timeout=120.0)
except asyncio.TimeoutError: answers = {"_timeout": True}
del self._pending_user_inputs[user_input_id]
result = ToolResult(ok=True, content=json.dumps(answers, ensure_ascii=False))
return self._persist_tool_result(turn_id, tool_name, tool_use_id, result, tool_trace)
```
注意：**问答结果恒为 `ok=True`**，超时以 `{"_timeout": true}` 形式交给模型。
不走 `PermissionRequest`，无 transcript，也不做状态机。

### 6.5 取消（cancellation）

- `request_cancel()` 只做 `self._cancel_event.set()`，**没有** `asyncio.CancelledError` 传播、
  没有 task 取消、没有 httpx 流关闭的显式处理。
- 检查点共 4 处：loop 顶部（qe.py:365）、`can_auto_continue` 条件（qe.py:383）、
  流式循环每事件（qe.py:472，`break` 退出 async-for）、单轮结束后（qe.py:642）。
- 取消结果的落盘：
  - `num_turns == 0` 时（loop 顶部）写 `role="assistant", subtype="interrupted", content="[Interrupted]"`；
  - 其余情况只写本轮已生成的 assistant 内容（`persist_normal_message`），不写 `[Interrupted]`。
- 取消时 `finish("cancelled", "cancelled", cancelled=True)` → `turn_end` 带 `"cancelled": True`。
- 状态回滚：**没有回滚**。已落盘的 user 消息、已执行的工具副作用、已写的 tool 结果全部保留。
  TUI 依赖 `sanitize_api_messages` 在下次请求时补 `{"role":"assistant","content":"[Interrupted]"}` 占位。
- **`_cancel_event` 从不被清除**（全仓仅 4 处引用，无 `clear()`）。见易错点 E4。

---

## 7. 并发 / 异步模型

- 全链路 `async/await`，单事件循环，**单个 QueryEngine 实例同一时刻只跑一个 turn**
  （TUI 用 `@work` + `_is_streaming` 标志互斥；流式中再提交会把 prompt 暂存到 `_pending_prompt`
  并触发 cancel，见 `app.py:727-731`）。
- 阻塞点（会挂起整个 turn）：
  - `await engine.submit_message(...)`（TUI worker 里）
  - `await self._tool_executor.execute(...)`（工具自身可能是 async IO）
  - `await asyncio.wait_for(future, timeout=...)`（**权限/问答等待**，最长 120s）
  - `await stream_chat_completion(...)` 的 SSE 读取
- **跨层唤醒机制**：`_pending_permissions` / `_pending_user_inputs` 是 `dict[str, asyncio.Future]`。
  TUI 在按键回调（同步的 `_resolve_pending_permission` / `_resolve_user_input`）里调用
  `engine.resolve_permission(...)` / `engine.resolve_user_input(...)` → `future.set_result(...)` →
  唤醒引擎协程。这意味着复刻时必须保证「UI 事件处理」与「引擎协程」在同一事件循环内。
- **Textual 集成**：`_submit_via_engine` 是 `@work`（非 exclusive）装饰的异步方法；`_init_mcp_servers`
  是 `@work(exclusive=True)`。引擎本身对 Textual **零依赖**（不 import textual），只通过
  `on_event` 回调和两个 `resolve_*` 方法交互——这是复刻时可替换 UI 的关键边界。
- **无并发工具执行**：一轮内多个 tool_use 串行 `await`。
- **无超时保护**：工具执行、单次 LLM 调用除 httpx 的 120s 读超时外没有额外超时。

---

## 8. 关键不变量与易错点

### 不变量

1. **消息链完整性**：每个 `role="tool"` 消息的 `tool_use_id` 必须能对应到前一条 assistant 消息中
   某个 `tool_use` 块的 `id`（Anthropic 路径由 `validate_tool_pairing` 强校验，不合法直接抛
   `ToolPairError`，见 `03-providers.md`）。
2. **assistant 消息的双形态**：content 要么是纯文本，要么是 JSON 块数组字符串；块数组只在
   `thinking_blocks` 非空时使用。`type` 取值 `thinking` / `text` / `tool_use`。
3. **tool 消息形态固定**：content = `json.dumps({"tool_use_id": ..., "content": ...})`，
   `role="tool"`，`subtype="tool_result"`，`tool_call_id` = tool_use id，
   `meta` = `json.dumps({"tool_name","ok","error_code","elapsed_ms","data", "skill_guard_id","skill_name","guard_type","guard_reason"})`。
4. **api_messages[0] 恒为 system**（预检压缩重建后会丢失，见 E1）。
5. **`num_turns` 只统计成功的模型生成**；重试/续跑不计。
6. **`tool_rounds` 只统计含 tool_use 的 assistant 消息数**。
7. **压缩 boundary 的两条 system 消息顺序固定**：先 summary 后 boundary；
   `list_active_messages` 依赖「boundary 的前一条是 summary」这一前提（当 boundary 是列表首元素时）。
8. **skill transcript 无条件（有 registry 时）落盘**，即使没有选中任何 skill。
9. **取消后 `_cancel_event` 保持 set**（见 E4）。
10. **`ToolResult.meta["elapsed_ms"]`** 由 `ToolExecutor` 在工具返回后写入（tools/core.py:270, 322），
    未初始化分支没有该字段。

### 易错点（按严重度排序）

**E1 — 预检压缩后 `api_messages` 会重建，system prompt 丢失（本轮内）**
`qe.py:251-257`：压缩 applied 时
```python
active_messages = list(compact_result.messages)
api_messages = sanitize_api_messages([formatted for msg in active_messages ...])
```
这次重建**不再 insert system prompt**。所以压缩生效的那一轮，发给 provider 的消息里**第一条 system
是压缩 summary 转换来的 system 消息**（若有），而 `assemble_system_prompt` 组装的完整 system prompt
**丢失**（Anthropic 端会退化为只有 compact summary 的 system）。更严重的是 `_apply_tool_result_budget`
路径把 `active_messages` 设成 **全量会话消息**（含 boundary 之前的历史），而 `_autocompact` 路径返回的
也是 `list_messages(...)` 全量——**同一 turn 内压缩等于没压缩**（旧历史仍在请求里）。下一轮重新
`list_active_messages` 才恢复正确。复刻时应决定：照抄（保持行为一致）还是修掉（推荐修）。

**E2 — `_apply_tool_result_budget` 用 `messages` 的下标去写 `api_messages`**
`compact.py:220-221`：`if i < len(api_messages): api_messages[i]["content"] = truncated_content`。
`messages` 与 `api_messages` 长度/顺序并不对齐（`api_messages` 过滤掉了 permission_event / skill_event /
compact_boundary，且 query_engine 在 index 0 插了 system）。因此内存里的原位替换**大概率错位**。
在当前调用点上因为调用方随后会用 `list_messages` 重建 `api_messages`，错位被掩盖；但复刻时不要依赖
这个「巧合」。

**E3 — 工具调用串行且无并发上限**
一轮里模型给 10 个 tool_use 就串行 10 次执行；`max_tool_rounds` 限制的是轮次而不是工具数。若工具慢，
turn 会长时间挂起（只有 UI 上的 ESC 能取消）。

**E4 — `_cancel_event` 永不清除 → 取消后同一 engine 实例的下一轮立即被取消**
`qe.py:71,77,81,365,383,472,642`（全仓无 `clear()`）。TUI 在取消后会用**同一个** engine 实例
重提交 `_pending_prompt`（`app.py:524-527`）→ 新 turn 在 loop 顶部立刻判定取消，写一条 `[Interrupted]`
后返回 `cancelled`，用户排队的新 prompt 被吞掉。复刻时应（a）每轮开始前 `clear()`，
或（b）取消时重建 engine。`_cancel_event` 只在 engine 被重建（切会话/换 client）时归零。

**E5 — 无模型 / 未捕获异常路径不发 `turn_end`**
`qe.py:134-149` 与 `155-170`。任何以 `turn_end` 为唯一终止信号的 UI 逻辑都会卡住。
复刻时必须同时处理 `error`。

**E6 — 错误路径的 usage 少一轮**
`finally` 在 `except` 的 `return await finish(...)` **之后**执行，导致 `turn_end` 里的 token 数
不含失败那一轮的 usage。同时 `update_conversation_usage` 仍会在 finally 里写盘（用的还是上一轮的估算）。

**E7 — `num_turns` 与 `tool_rounds` 的语义容易搞混**
`test_max_tool_rounds_enforced_without_auto_continue` 断言 `tool_rounds == 3, num_turns == 4`：
第 4 轮是 finalization 轮（tools=[]），产出 tool_use 后直接 return（不落盘该 assistant 消息）。

**E8 — finalization 轮丢弃 assistant 的 tool_call**
`qe.py:646-653` 在 `finalization_pass and tool_uses` 时直接 `finish`，**不落盘**、**不执行**工具。
模型在禁用工具的情况下仍可能生成 tool_use（见测试里的 mock），这条内容会永久丢失。

**E9 — `_handle_permission_required` 里 `self._tool_registry.get(tool_name)` 可能 KeyError**
`qe.py:924`。若某工具在 `_tool_registry` 里没注册但 `ToolExecutor` 能拿到（例如动态注册/注销竞态），
会抛 KeyError → 整轮 `status="error"`。

**E10 — compact summary 的 `tokens_after` 落盘为 0**
`compact.py:279`：`CompactMetadata(... tokens_after=0)`，真正值在 `CompactionOutput`。
所以 UI 侧展示 boundary 时 `tokens_after` 恒显示 0（`message_utils._format_compact_boundary` 用它做
`{after_k}K → ...`）。

**E11 — 压缩摘要里的 `[调用工具 ...]` 是中文字面量**
`compact.py:371`，不受 i18n 控制；英文界面下摘要提示词正文里也会出现中文
（`planning_injection` 的 `Workflow:` / `Verification:` 行同理不受控）。

**E11b — QueryEngine 侧压缩提示词恒为英文**
`CompactionEngine` 的 `_i18n` 默认 `I18nStore(Language.EN)`，QueryEngine 从不传它
（qe.py:239-243、554-558），所以主循环的摘要提示词、角色标签恒为英文，与用户选择的
`/language` 设置无关。`test_autocompact_summary_preserves_skill_state`（tests/test_compact.py:368）
正是断言英文串 `"Skills applied: safe-edit@0.1.0"` / `"phase: validate"`。

**E12 — `incomplete_tool_call` 重试把 assistant 消息只追加到内存**
`qe.py:671-683`：`api_messages.append({"role":"assistant", ...})` 未落盘，同时
`persist_normal_message` 已写了一份到 storage。若该轮之后再压缩/重建 `api_messages`（reactive compact 的
`api_messages[:] = ...`），这条内存消息会消失。

**E13 — TUI 路径下 user 消息没有 `turn_id`**
`app.py:750-755` / `572-577` 用 `add_message(...)`（无 turn_id），随后
`submit_message(..., user_message_persisted=True)`。所以 storage 里 user 消息的 `turn_id == ""`，
而 `get_turn_messages(conversation_id, turn_id)` 无法用它反查本轮 user 输入。测试路径（不走 TUI）
则带 turn_id（`test_submit_message_persists_user_message` 断言 `messages[0].turn_id != ""`）。

**E14 — 没有输出 token 预留**
`hard_limit == context_window`。若 provider 的实际上限包含输出预算，会出现「压缩判定未超但请求仍 413」
的情况，只能靠 reactive compact 兜底一次（`max_context_retries=1`）。

**E15 — 预检压缩只在 turn 开头**
长工具链中途不会压缩（除非 provider 报错）。`auto_continue_turns=10` 会持续放大上下文，
而 `api_messages` 是**内存中不断 append 的**，不受 `list_active_messages` 约束。

**E16 — `add_message` 的硬约束**
`content` 为空会 `ValueError`；`role` 必须属于 `{user, assistant, tool, system}`；conversation 必须存在。
`persist_normal_message` 已做空保护，其他写入点都保证非空。

**E17 — `_extract_compact_summary` 会把「所有」system 消息拼进 system prompt**
其中包含 provider 消息里所有 `role=="system"` 的项（当前只有 compact_summary 会变成 system）。
多处 summary（多次 autocompact）会以 `\n\n` 连接后**一起**注入第 6 层。

---

## 9. 复刻检查清单

按依赖顺序逐项验证（每项都可写成一个断言）：

**构造与依赖**
- [ ] `QueryEngineConfig` 11 个字段与默认值完全一致（含 `max_incomplete_continues=3` 的硬编码位置）。
- [ ] `QueryEngine.__init__` 只接收 config；`mode` 是可变字段；工具系统经 `configure_tools` 注入。
- [ ] `TurnEvent` 是 frozen dataclass，`data` 为普通 dict。

**一轮 turn 的基本闭环**
- [ ] `increment_turn` 在写 user 消息之前执行，且**无模型时也已自增**。
- [ ] `turn_id` 格式 = `turn_{n}_{conversation_id[:8]}`。
- [ ] 事件顺序：`turn_start` →（`skill_resolved`）→（`compact_start`,`compact_end`）→
      `thinking`/`text`/`tool_use`* →（`auto_continue`）→ `tool_result`* → … → `turn_end`。
- [ ] 无模型路径：只发 `error`，不发 `turn_end`，返回 `status="error"`。
- [ ] user → assistant(tool_call) → tool(tool_result) → assistant(normal) 四条消息落盘，
      subtype 分别为 `normal` / `tool_call` / `tool_result` / `normal`。
- [ ] 有 thinking 时 assistant content 是 JSON 数组 `[{"type":"thinking","thinking":...,"signature":...}, {"type":"text",...}]`。

**轮次与预算**
- [ ] `base_max_turns = max(1, max_turns or max_tool_rounds)`。
- [ ] 自动续跑条件 5 个全部满足才触发，且 `current_max_turns += max(1, auto_continue_turns)`。
- [ ] 续跑上限 `max_auto_continues=3`，提示词逐字一致。
- [ ] finalization pass：`pending_tool_results and not finalization_pass` 时注入禁用工具提示词，
      本轮 `tools_for_call == []`，提示词逐字一致。
- [ ] `test_max_tool_rounds_enforced_without_auto_continue` 的数值关系（tool_rounds=3, num_turns=4）。
- [ ] `test_finalization_consumes_last_tool_result_after_budget` 的数值关系（num_turns=2, tool_rounds=1,
      terminal_reason="max_turns"）。
- [ ] incomplete tool call：最多重试 3 次，耗尽后 `terminal_reason="incomplete_tool_call_limit_reached"`。

**usage**
- [ ] anthropic 读 `input_tokens`/`output_tokens`；其它读 `prompt_tokens`/`completion_tokens`。
- [ ] input 每轮覆盖、output 跨轮累加；最终写回会话 `last_input_tokens` / `total_output_tokens`。
- [ ] `input_tokens == 0` 时用 `TokenEstimator().estimate_api_messages(api_messages)` 兜底。

**skill**
- [ ] 无 registry 时清空 `turn_state` 的 `runtime_guards` / `skill_runtime_state` 并返回 None。
- [ ] 有 registry 时**无条件**写 `skill_event` transcript，并把 guards/state 写进 `turn_state`。
- [ ] `planning_injection` 的格式与 `Active Skills:` / `Phase model:` / `Workflow:` / `Verification:` 逐字一致。
- [ ] system prompt 里出现 `safe-edit@0.1.0`（ref 格式 `name@version`）。

**prompt**
- [ ] 六层顺序与 `"\n\n".join` 连接方式。
- [ ] 第 5、6 层的前缀字符串逐字一致（`Skill planning guidance:` / `Historical summary (compacted conversation):`）。
- [ ] 四个 mode 段、`SAFETY_POLICY`、`SUBAGENT_AWARENESS` 文本逐字一致。
- [ ] `mode_int_to_str` 映射 `{0:normal,1:auto_edit,2:yolo,3:plan}`。

**compact**
- [ ] `estimate("hello world") == 3`、`estimate("a"*100) == 30`、`estimate("") == 0`、
      CJK 权重 1.5 / 其它 0.3、`max(1, ...)` 下限。
- [ ] `context_window=125000` → `soft_limit==87500`、`hard_limit==125000`。
- [ ] 软限制只截工具结果；截断为 head 2000 + tail 500 + `\n...[truncated N chars]...\n`，
      且**写回 storage**（`update_message_content`）。
- [ ] 硬限制才做 LLM 摘要；`_find_split_index` 保留最近 `preserve_turns` 条 user 消息（含该条）。
- [ ] 落盘顺序 summary → boundary，`strategy="autocompact_v1"`，boundary JSON 字段名逐字一致。
- [ ] 摘要 prompt 三段拼接格式与 `COMPACT_SUMMARY_PROMPT` 原文一致；`max_tokens=2048`；非流式。
- [ ] `list_active_messages`：找第一条 boundary，若前一条是 summary 则一并从它开始截取。
- [ ] reactive compact 的 aggressive policy（2000 / preserve_turns=1）与「先截断再摘要」顺序。
- [ ] provider 错误关键字匹配集（`context_length_exceeded` / `413` / `too long` / `maximum context length`）
      与重试上限 1。

**权限与用户问答**
- [ ] `PermissionRequest.create` 的 120s 超时、状态机流转（CREATED→PENDING→APPROVED→EXECUTED/FAILED）。
- [ ] 四种 resolution 的结果文本与 error_code 逐字一致（`User denied permission for {tool}` /
      `Permission request timed out for {tool}`，都是 `PERMISSION_DENIED`）。
- [ ] `always_approve` 的命令前缀提取（`git xxx` → `"git xxx"`，否则首 token）。
- [ ] 三类 transcript 事件落盘，且 `subtype="permission_event"` 的消息**不发给模型**。
- [ ] 用户问答超时返回 `{"_timeout": true}` 且 `ok=True`。

**取消与错误**
- [ ] `num_turns == 0` 取消时写 `[Interrupted]`。
- [ ] 取消返回 `status="cancelled"`、`turn_end` 带 `cancelled: True`。
- [ ] 工具异常被 `ToolExecutor` 吞成 `TOOL_RUNTIME_ERROR`，不冒泡。
- [ ] `_execute_tool` 在 executor/context 为 None 时返回 `TOOL_NOT_INITIALIZED`。
- [ ] 决定是否复刻 E4（粘性 cancel event）——建议不要复刻，改为每轮清空。

**持久化格式**
- [ ] `Message` 字段顺序/默认值：`id, conversation_id, role, content, created_at, turn_id="", subtype="normal",
      tool_call_id=None, meta="{}", agent_type=""`。
- [ ] `TurnResult` 字段：`turn_id, status, final_text, tool_rounds, input_tokens, output_tokens, error,
      num_turns, max_turns, terminal_reason, last_tool_error`。
- [ ] 写盘为 atomic（临时文件 + `os.replace`）。
- [ ] `list_messages` 按 `created_at` 字符串排序；`list_active_messages` 的 boundary 截取规则。
