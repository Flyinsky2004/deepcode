# 07｜MCP 客户端集成 + 可观测性（Langfuse）复刻规格

> **新实现注意**：MCP 生命周期、工具映射、连接隔离和本地结构化观测以 `09-typescript-agent-standard.md` 为规范；本文件中的串行连接、前缀删除等仅是旧实现行为。

> **导航**：本文件是 `docs/REWRITE_SPEC.md`（总纲）的子规格。建议先读总纲了解架构全景，再回到本文件逐条实现。
> 相关：总纲 §0.2.1（文档与代码冲突清单）、§7（已知缺陷与复刻决策）、§8（复刻路线图）。


本部分覆盖两个子系统：

- **MCP 客户端集成**：`src/flyinchat/mcp/{__init__,config,manager,adapter}.py`、`src/flyinchat/storage.py:603-607`（`load_mcp_config`）、`src/flyinchat/tools/core.py`（`_tool_allowed` / `add_auto_allow_tool`）、`src/flyinchat/app.py`（`/mcp` 命令面、后台连接 worker、状态栏、reconnect）。
- **可观测性**：`src/flyinchat/observability/` 全部 8 个文件、埋点位置（`query_engine.py` / `compact.py` / `app.py`）。

目标：用另一种语言从零复刻时，**配置键名、工具名前缀拼接、环境/配置键、span 名称、脱敏常量、评分公式、判定顺序**必须逐字对齐。凡本文出现的字符串字面量，均为源码原文抄录。

依赖（`pyproject.toml:8-14`）：`langfuse>=3.0.0`（实际代码针对 v4 SDK 编写，本机安装为 4.7.1）、`mcp>=1.0.0`、`textual>=0.86.0`、`httpx>=0.28.0`。

---

# 第一部分：MCP 客户端集成

## 0. 文件职责总览

| 文件 | 行数 | 职责 |
|---|---|---|
| `src/flyinchat/mcp/__init__.py` | 5 | 导出 `MCPConfig`、`MCPServerConfig`、`MCPManager` |
| `src/flyinchat/mcp/config.py` | 50 | `MCPServerConfig` / `MCPConfig` 两个 frozen dataclass + `from_dict` 校验 |
| `src/flyinchat/mcp/manager.py` | 192 | `MCPManager`：连接、工具列举注册、状态/错误跟踪、reconnect、shutdown |
| `src/flyinchat/mcp/adapter.py` | 174 | `MCPToolAdapter`（MCP tool → `Tool`）、风险推断、schema 归一化、结果提取/序列化 |
| `src/flyinchat/storage.py:603-607` | 5 | `load_mcp_config(paths)`：从 config.json 读取 |
| `src/flyinchat/app.py:427-443` | 17 | `_init_mcp_servers()`：后台 worker 中调用 `connect_all` |
| `src/flyinchat/app.py:948-1104` | ~157 | `/mcp` 列表、详情面板、reconnect 交互 |

---

## 1. 配置：磁盘格式、加载接口、校验

### 1.1 磁盘位置与键名

MCP 配置**不单独建文件**，而是嵌在全局 config.json 的顶层 `mcp_servers` 键下。

- 路径：`~/.flyinchat/config.json`（由 `paths.py` 中 `AppPaths.config_path = global_dir / "config.json"`、`global_dir = home / ".flyinchat"` 决定）。
- 顶层键名：**`mcp_servers`**（复数，list）。
- 注意：`app_settings`（Langfuse / language 等）是**另一个**顶层键，与之并列。

`storage.py:609-617` 的 `_load_config_store()` 白名单式地把 config.json 归一化为固定 5 个键，**未知键会被丢弃**：

```python
{
    "schema_version": int(store.get("schema_version", _SCHEMA_VERSION)),
    "llm_channels": [...],
    "llm_models": [...],
    "app_settings": dict(store.get("app_settings", {})),
    "mcp_servers": list(store.get("mcp_servers", [])),
}
```

`_default_config_store()`（`storage.py:654-660`）**不包含 `mcp_servers` 键**——新建的 config.json 里没有该字段，靠 `.get(..., [])` 兜底。复刻时这一点要保留（用户手动添加该键才会生效）。

完整的 config.json 示例：

```json
{
  "schema_version": 1,
  "llm_channels": [],
  "llm_models": [],
  "app_settings": { "langfuse_enabled": "true" },
  "mcp_servers": [
    {
      "name": "filesystem",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      "env": {"HOME": "/tmp"},
      "timeout_seconds": 60
    }
  ]
}
```

### 1.2 `MCPServerConfig`（`config.py:7-33`）

frozen dataclass，字段与默认值：

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `name` | `str` | 无（必填） | server 标识，参与工具名前缀 |
| `transport` | `str` | 无（必填，但 `from_dict` 兜底为 `"stdio"`） | 注释写明 `# "stdio" in phase 1` |
| `command` | `str` | 无（必填） | 可执行文件 |
| `args` | `list[str]` | `[]` | |
| `env` | `dict[str, str]` | `{}` | |
| `timeout_seconds` | `int` | `30` | 既用于 `StdioServerParameters` 建立，也用于**单次 tool call 超时** |

`from_dict`（`config.py:17-33`）的校验顺序（**必须逐字复刻**）：

```python
name = data.get("name")
command = data.get("command")
if not name or not command:
    return None                       # 1) name 或 command 缺失/空 → None
transport = data.get("transport", "stdio")
if transport != "stdio":
    return None                       # 2) 任何非 stdio 传输 → None（http / sse / streamable_http 全部被静默丢弃）
return cls(
    name=name, transport=transport, command=command,
    args=data.get("args", []), env=data.get("env", {}),
    timeout_seconds=data.get("timeout_seconds", 30),
)
```

要点：
- **transport 只支持 `"stdio"`**。源码注释即写明 `# "stdio" in phase 1`。SSE / HTTP / streamable-http **完全没有实现**——传入 `"http"` 的条目会被**静默丢弃**，不报错、不警告、不出现在 `/mcp` 列表里。
- 校验是「静默丢弃」语义：无异常、无日志。`MCPConfig.from_dict` 只收集非 None 项：

```python
raw_servers = data.get("mcp_servers", [])
servers = []
for item in raw_servers:
    config = MCPServerConfig.from_dict(item)
    if config is not None:
        servers.append(config)
return cls(servers=servers)
```

- `env` 的语义是**覆盖/追加**，不是替换：`env={**server.env} if server.env else None`（`manager.py:74`）——注意当 `env` 为空时传的是 `None` 而非 `{}`，MCP SDK 对 `None` 表示「继承父进程环境」，对 `{}` 表示「清空环境」。
- 不做去重：两个同名 server 会**都被保留**，后连接者覆盖前者的 `_sessions` / `_status` 条目（dict key 冲突），前者的 `AsyncExitStack` **泄漏**（不会被 shutdown 关闭，因为 `_exit_stacks[name]` 已被覆盖）。

### 1.3 加载接口

```python
# storage.py:603-607
def load_mcp_config(paths: AppPaths) -> MCPConfig:
    """Load MCP server configuration from config.json."""
    store = _load_config_store(paths.config_path)
    return MCPConfig.from_dict(store)
```

- 只有 **load**，**没有 save**。源码中不存在 `save_mcp_config` / `add_mcp_server` 之类的写入接口。复刻时如果要支持写入，需要新增。
- 该函数被调用 3 处：`app.py:432`（启动连接）、`app.py:952/956`（`/mcp` 列表）、`app.py:1009`（详情面板）。即**每次打开 `/mcp` 面板都会重新读盘**，所以手动编辑 config.json 后无需重启即可在面板看到新 server（但不会自动连接，需要重启或 reconnect）。

### 1.4 复刻检查清单（配置）

- [ ] 顶层键名是 `mcp_servers`（复数），不是 `mcp_server` / `servers`。
- [ ] 单个 server 字段名：`name` / `transport` / `command` / `args` / `env` / `timeout_seconds`。
- [ ] `transport` 缺省值 `"stdio"`；非 `"stdio"` 静默丢弃。
- [ ] `timeout_seconds` 缺省 `30`。
- [ ] config.json 归一化时未知顶层键被丢弃，`mcp_servers` 默认 `[]`。
- [ ] 无写入接口。

---

## 2. `MCPManager`：完整生命周期（`manager.py`）

### 2.1 内部状态（`manager.py:17-23`）

```python
self._sessions:     dict[str, Any] = {}   # server_name → mcp.ClientSession
self._clients:      dict[str, Any] = {}   # server_name → (read_stream, write_stream) 元组
self._exit_stacks:  dict[str, Any] = {}   # server_name → AsyncExitStack
self._status:       dict[str, str] = {}   # server_name → 状态字符串
self._errors:       dict[str, str] = {}   # server_name → 最后一次错误消息
self._server_configs: dict[str, MCPServerConfig] = {}
```

**`_status` 的取值集合（闭集，逐字）**：`"connecting"` / `"connected"` / `"error"` / `"disconnected"`。
（`"disconnected"` 只在 `shutdown()` 里写入；`/mcp` 面板对未知状态也显示为 disconnected。）

logger 名：`logging.getLogger("flyinchat.mcp.manager")`。

### 2.2 `connect_all()`（`manager.py:25-43`）——**串行，不是并发**

```python
async def connect_all(self, servers, registry, tool_context) -> None:
    for server in servers:
        self._server_configs[server.name] = server     # ① 先无条件登记所有配置
    if not servers:
        logger.info("No MCP servers configured")
        return

    for server in servers:                             # ② 串行逐个连接
        try:
            await self._connect_server(server, registry, tool_context)
        except Exception:
            logger.exception("Failed to connect to MCP server: %s", server.name)
            self._status[server.name] = "error"        # ③ 兜底再标一次 error
```

关键事实（**容易误判，必须照抄**）：
- **没有并发**：`for` 循环 + `await`，一个 server 一个 server 地连，没有 `asyncio.gather`。一个 server 卡住（例如 `npx` 首次下载包）会**阻塞后续所有 server**。
- **没有全局超时**：`connect_all` 本身不设超时。唯一的超时是 MCP SDK `stdio_client` / `ClientSession.initialize()` 内部自带的；`MCPServerConfig.timeout_seconds` **不用于连接阶段**，只用于 tool call（见 §3.3）。
- **失败不中断**：单个 server 抛异常被 `except Exception` 吞掉，循环继续下一个。`connect_all` **永不向调用方抛异常**（唯一的例外是 `_connect_server` 里的 `ModuleNotFoundError`——见下）。
- **`tool_context` 参数从未被使用**：三个方法（`connect_all` / `_connect_server` / `reconnect_server`）都接收 `tool_context`，但函数体内**一次都没引用**。它是为未来预留的形参。复刻时保留签名即可。

### 2.3 `_connect_server()`（`manager.py:45-128`）——单 server 连接

步骤（顺序敏感）：

1. **延迟导入 MCP SDK**（`manager.py:52-62`）：

```python
try:
    from mcp import ClientSession
    from mcp.client.stdio import StdioServerParameters, stdio_client
except ModuleNotFoundError as e:
    self._status[server.name] = "error"
    self._errors[server.name] = (
        f"mcp package not installed: {e}. "
        "Install it with: pip install mcp"
    )
    logger.error("mcp package not installed; cannot connect MCP server")
    raise          # ← 注意：这里 raise，会穿透 connect_all 的 except 被吞掉
```

错误消息字符串逐字抄录：`f"mcp package not installed: {e}. Install it with: pip install mcp"`。
注意 `raise` 穿透到 `connect_all` 的 `except Exception`，被第二次记录 `logger.exception`——即启动日志里这条会打两遍。

2. `self._status[server.name] = "connecting"`，再次写 `self._server_configs[server.name] = server`（与 `connect_all` 重复，无害）。
3. `logger.info("Connecting to MCP server: %s (cmd=%s, args=%s)", ...)`。
4. 新建 `AsyncExitStack()` 并**先存入** `self._exit_stacks[server.name]`——即使后面失败也能被 shutdown 清理。
5. 构造参数（`manager.py:71-75`）：

```python
params = StdioServerParameters(
    command=server.command,
    args=server.args,
    env={**server.env} if server.env else None,
)
```

6. 建立传输与会话，全部挂在同一个 exit stack 上：

```python
stdio_transport = await exit_stack.enter_async_context(stdio_client(params))
read_stream, write_stream = stdio_transport
session = await exit_stack.enter_async_context(ClientSession(read_stream, write_stream))
await session.initialize()          # ← 能力协商发生在这里（MCP SDK 内部）
tools_result = await session.list_tools()
```

**能力协商（capability negotiation）**：本代码**没有显式处理**。`session.initialize()` 是 MCP SDK 内部的握手（交换 protocolVersion / capabilities / serverInfo），FlyinChat 不读 `InitializeResult`、不做能力分支、不检查 `tools` capability 是否存在——直接假定 server 支持 tools 并调用 `list_tools()`。如果 server 不支持 tools，`list_tools()` 由 SDK 抛错，落入 catch，状态变 `error`。

7. **工具注册循环**（`manager.py:88-108`）：

```python
tool_count = 0
for tool in tools_result.tools:
    adapter = MCPToolAdapter(
        server_name=server.name,
        tool_name=tool.name,
        description=tool.description or "",           # ← None → ""
        input_schema=getattr(tool, "inputSchema", None),
        session=session,
        timeout_seconds=server.timeout_seconds,
    )
    try:
        registry.register(adapter)
        tool_count += 1
        logger.info("Registered MCP tool: %s (risk=%s)", adapter.name, adapter.risk_level)
    except ValueError:
        logger.warning("MCP tool name conflict, skipping: %s", adapter.name)
```

冲突策略：**first-wins + 跳过后者**。`ToolRegistry.register` 对重名抛 `ValueError(f"duplicate tool: {tool.name}")`（`tools/core.py:89-91`），这里捕获后**只记 warning 并跳过**，不覆盖、不加后缀。符合设计文档要求的「deterministic，不能随机覆盖」。
注意 `getattr(tool, "inputSchema", None)` 用的是 MCP SDK 的 **camelCase** 属性名（pydantic 模型上 `inputSchema` 是 alias，SDK 的 `model_fields` 只暴露 `inputSchema`，源码选择直接 getattr）。

8. 成功落库：

```python
self._sessions[server.name] = session
self._clients[server.name] = stdio_transport     # 注意存的是元组，不是单个 stream
self._status[server.name] = "connected"
self._errors.pop(server.name, None)              # ← 清掉历史错误
logger.info("MCP server %s connected: %d tools registered", server.name, tool_count)
```

9. 失败路径（`manager.py:120-128`）：

```python
except Exception as e:
    self._status[server.name] = "error"
    self._errors[server.name] = str(e)           # ← 原始异常字符串，不做包装
    logger.exception("Failed to connect to MCP server: %s", server.name)
    try:
        await exit_stack.aclose()
    except (RuntimeError, Exception):
        pass                                      # ← `except (RuntimeError, Exception)` 等价于 `except Exception`
    raise                                         # ← 再次抛给 connect_all
```

**部分成功不回滚**：如果 10 个工具里第 5 个注册成功后 SDK 抛错，前 5 个 tool 已进入 registry，但 `_sessions` 没有该 server 条目 → 这 5 个 tool 的 adapter 持有 session 引用，调用时可能仍能工作（session 未关），但 manager 认为它 `error`，且 `.aclose()` 会关掉 session。这是一个**已知不变量缺口**，复刻时建议对齐行为（照抄）或明确改进。

### 2.4 查询接口（只读）

| 方法 | 行号 | 返回 |
|---|---|---|
| `get_status()` | `manager.py:130-132` | `dict(self._status)`——**拷贝**，调用方改动不影响内部 |
| `get_error(name)` | `manager.py:134-136` | `self._errors.get(name)` → `str | None` |
| `get_server_config(name)` | `manager.py:138-140` | `MCPServerConfig | None` |

### 2.5 `reconnect_server()`（`manager.py:142-153`）

```python
async def reconnect_server(self, server, registry, tool_context) -> int:
    await self._disconnect_one(server.name, registry=registry)
    await self._connect_server(server, registry, tool_context)
    return sum(1 for tn in registry.list_tools() if tn.startswith(f"mcp_{server.name}_"))
```

- 先断开（并**注销该 server 的所有工具**），再重连，最后**数一遍** registry 里前缀匹配的工具数作为返回值。
- `_connect_server` 失败会**向上抛**（与 `connect_all` 不同）——调用方 `app.py:1096-1104` 用 `try/except Exception` 包住并显示 "Reconnect failed for {server_name}"。
- 返回值是**重新计数**而非增量，所以即使重连挂掉也不会返回错误数字（异常路径不返回）。

### 2.6 `_disconnect_one()`（`manager.py:155-172`）

```python
if registry is not None:
    prefix = f"mcp_{server_name}_"
    for tool_name in list(registry.list_tools()):    # list() 快照，避免边遍历边改
        if tool_name.startswith(prefix):
            registry.unregister(tool_name)
exit_stack = self._exit_stacks.pop(server_name, None)
if exit_stack is not None:
    try:
        await asyncio.wait_for(exit_stack.aclose(), timeout=5.0)
    except Exception:
        pass                                         # ← 5s 超时/任何异常都被吞
self._sessions.pop(server_name, None)
self._clients.pop(server_name, None)
self._status.pop(server_name, None)                  # ← 注意：pop，不是设 "disconnected"
self._errors.pop(server_name, None)
logger.info("MCP server disconnected: %s", server_name)
```

关键点：
- **超时硬编码 5.0 秒**，且**超时后静默吞掉**（无 warning）。与 `shutdown()` 的处理不同（那里会记 warning）。
- `_status` 是 **pop**（键消失），不是置 `"disconnected"`。所以 `/mcp` 面板在 reconnect 之后、重连之前看到的状态是「未在 status_map 中」→ 显示为 Disconnected（`app.py:977` 的默认分支）。而 `shutdown()` 走的是**置 `"disconnected"`**（保留键）。
- 工具名前缀匹配用 `startswith(f"mcp_{server_name}_")`——**下划线是分隔符**。若存在 server `foo` 与 `foo_bar`，`mcp_foo_bar_read` 会被 `mcp_foo_` 前缀误伤（`"mcp_foo_bar_read".startswith("mcp_foo_")` 为 True）。这是**已知易错点**，复刻时若要保持行为一致就照抄；若要修正需改用精确分段（`name.split("_", 2)` 或存映射表）。

### 2.7 `shutdown()`（`manager.py:174-192`）

```python
async def shutdown(self) -> None:
    for name in list(self._sessions.keys()):          # ← 只遍历有 session 的 server
        try:
            exit_stack = self._exit_stacks.pop(name, None)
            if exit_stack is not None:
                await asyncio.wait_for(exit_stack.aclose(), timeout=5.0)
            self._sessions.pop(name, None)
            self._clients.pop(name, None)
            self._status[name] = "disconnected"       # ← 置值，不是 pop
            self._errors.pop(name, None)
            logger.info("MCP server disconnected: %s", name)
        except asyncio.TimeoutError:
            logger.warning("MCP shutdown timed out for server: %s", name)
            self._status[name] = "error"
        except Exception:
            logger.exception("Error shutting down MCP server: %s", name)
            self._status[name] = "error"
```

**重要缺口**：循环条件是 `self._sessions.keys()`。**连接失败的 server 不在 `_sessions` 中**（`_sessions` 只在成功路径写入），因此：
- 其 `AsyncExitStack` **不会被 shutdown 关闭**（虽然连接失败时 `_connect_server` 自己 `aclose()` 了一次）；
- 但其 `_status` 保留 `"error"`，且 `_exit_stacks` 中的条目仍在（失败路径没 pop `_exit_stacks`）。

复刻时这是**行为对齐点**：`shutdown()` 只清理「成功连接的」server。

### 2.8 生命周期时序图

```text
app.compose()
  └─ _init_tools()                         # 先注册全部 native tool
on_mount()
  ├─ _render_status_bar()
  └─ _init_mcp_servers()   [@work(exclusive=True)]     app.py:427
       ├─ self._mcp_manager = MCPManager()
       ├─ mcp_config = load_mcp_config(self.paths)
       ├─ if mcp_config.servers:  await manager.connect_all(servers, registry, tool_context)
       │      └─ for server in servers:  await _connect_server(...)   # 串行
       │             ├─ import mcp  (失败 → status=error, raise)
       │             ├─ status = "connecting"
       │             ├─ AsyncExitStack → _exit_stacks[name]
       │             ├─ stdio_client(params) → (read, write)
       │             ├─ ClientSession(read, write) → initialize()   # 能力协商
       │             ├─ list_tools() → 逐个 registry.register(adapter)  # 重名 warning+skip
       │             └─ 成功: _sessions/_clients/status="connected" / _errors.pop
       ├─ self.call_later(self._render_status_bar)      # 刷新 MCP: x/y
       └─ self._mcp_shutdown_event = asyncio.Event()
          await self._mcp_shutdown_event.wait()          # ← worker 常驻，保持 anyio cancel scope 有效

action_quit()                                        app.py:363-368
  ├─ _mcp_shutdown_event.set()                       # 唤醒常驻 worker
  ├─ await self._mcp_manager.shutdown()              # 关所有已连接 server（5s/个）
  └─ self._observability_client.shutdown()
```

`asyncio.Event` 常驻的原因源码注释写明：`# Keep the worker alive so anyio cancel scopes stay valid (Python 3.14 compat)`——Textual 的 `@work` worker 若提前结束会取消其 task group，而 MCP SDK 基于 anyio 的 cancel scope 要求创建与退出在同一个 task 中。

### 2.9 复刻检查清单（manager）

- [ ] `connect_all` **串行**，无 `gather`，无全局超时，异常全吞。
- [ ] `connect_all` 永不向调用方抛异常（除 `ModuleNotFoundError` 也被吞）。
- [ ] `tool_context` 形参保留但未使用。
- [ ] `env` 空时传 `None` 而非 `{}`。
- [ ] 工具重名策略：`ValueError` → warning + skip（first wins）。
- [ ] `_status` 状态闭集：`connecting` / `connected` / `error` / `disconnected`。
- [ ] `_disconnect_one` pop `_status`；`shutdown` 置 `"disconnected"`。
- [ ] 清理超时均为硬编码 `5.0`。
- [ ] `shutdown` 只遍历 `_sessions`（跳过连接失败的 server）。
- [ ] `reconnect_server` 返回「重连后按前缀重新计数」的工具数。

---

## 3. `MCPToolAdapter`：MCP tool → `Tool`（`adapter.py`）

logger：`logging.getLogger("flyinchat.mcp.adapter")`。

### 3.1 工具名拼接（`adapter.py:68-70`）——**精确规则**

```python
@property
def name(self) -> str:
    return f"mcp_{self._server_name}_{self._tool_name}"
```

- 前缀 `mcp_`，随后 `server_name`，再 `_`，再 `tool_name`。
- **不做任何转义/规范化**：server 名或 tool 名中的连字符、点号、空格全部原样保留。例如 server `my-server` + tool `read.file` → `mcp_my-server_read.file`。
- 这个字符串被三处独立依赖，复刻时必须完全一致：
  1. `tools/core.py:153` `if tool_name.startswith("mcp_")` — MCP 工具默认 ask；
  2. `manager.py:158/152` 与 `app.py:1052` 的 `f"mcp_{server_name}_"` 前缀匹配；
  3. `app.py:1488` `if tool_name.startswith("mcp_")` — always-approve 时按工具名加白名单。

### 3.2 其他属性

| 成员 | 行号 | 值 |
|---|---|---|
| `description` | `adapter.py:72-74` | 直接透传 MCP `tool.description or ""` |
| `version` | `adapter.py:76-78` | 常量 `"1.0.0"` |
| `risk_level` | `adapter.py:80-82` | 构造时由 `_infer_risk_level` 算定，存 `self._risk_level` |
| `input_schema()` | `adapter.py:84-85` | 返回 `self._schema`（归一化后的 dict，**同一对象引用**——调用方可变改） |

### 3.3 风险推断 `_infer_risk_level`（`adapter.py:17-30`）

```python
_WRITE_KEYWORDS = frozenset({"write", "modify", "delete", "create", "remove", "update", "edit"})
_SHELL_KEYWORDS = frozenset({"shell", "exec", "run", "command", "process"})

def _infer_risk_level(name: str, description: str) -> str:
    text = f"{name} {description}".lower()
    for kw in _SHELL_KEYWORDS:
        if kw in text:
            return "high"
    for kw in _WRITE_KEYWORDS:
        if kw in text:
            return "medium"
    return "low"
```

规则：`f"{tool_name} {description}"` 转小写后，**子串匹配**（`in`，非分词）。

- **SHELL 优先于 WRITE**：先扫 shell 集合，命中即 `high`，不再看 write。
- 默认 `low`（所有只读工具）。
- 判定是**子串**匹配，因此有大量误报，必须照抄才能对齐行为：
  - `run_tests` + `"Run the test suite"` → **high**（"run" 是子串）；
  - `update_document` → medium（"update"）；
  - `create_issue` → medium（"create"）；
  - `get_status` → low；`search_files` → low；`list_directory` → low；
  - 空 name + `"read a file"` → low；name `"update"` + 空 description → medium。
- 结论：**MCP 工具的权限行为几乎完全由名字里的英文单词决定**，而不是由 server 声明的注解（`readOnlyHint` / `destructiveHint`）决定——源码完全忽略 MCP 的 annotations。

### 3.4 schema 归一化 `_normalize_schema`（`adapter.py:33-44`）

```python
if raw is None:
    return {"type": "object", "properties": {}, "required": []}
schema = dict(raw)                 # 浅拷贝，不改原 dict
if "type" not in schema:      schema["type"] = "object"
if "properties" not in schema: schema["properties"] = {}
if "required" not in schema:   schema["required"] = []
return schema
```

- **`inputSchema` 基本透传**：只补 3 个缺失的顶层键，其余键（`$schema`、`definitions`、`additionalProperties`、`enum`、嵌套结构…）原样保留。
- 不做 `$ref` 解析、不留可解析性校验、不标记不可调用工具（尽管设计文档 §8.3 有此要求——**未实现**）。
- 浅拷贝意味着嵌套对象（如 `properties` 内的 dict）与 server 返回的是同一引用。
- 对 OpenAI 兼容 provider，该 dict 直接作为 `parameters` 发给模型（`tools/convert.py:16-24`）；对 Anthropic 作为 `input_schema`（`tools/convert.py:8-13`）。**中间没有再转换**（见 `tools/convert.py`，MCP dict 与 native tool 的 schema 走同一条路）。
- `self._raw_schema` 保存原始值但**从未被使用**（死字段）。

### 3.5 `requires_permission`（`adapter.py:87-94`）——**默认策略**

```python
if self._risk_level == "high":
    return PermissionDecision(False, "MCP tool requires approval (high risk)", ask_user=True)
if self._risk_level == "medium":
    return PermissionDecision(False, "MCP tool requires approval (medium risk)", ask_user=True)
return PermissionDecision(True, "")
```

- `low` → **允许**（`allowed=True, reason=""`），不弹框。
- `medium` / `high` → `ask_user=True`，reason 字符串逐字为 `"MCP tool requires approval (high risk)"` / `"MCP tool requires approval (medium risk)"`。
- **这不是最终裁决**。它只是门控链的**第 3 层**；真正的顺序见 §5.1。

### 3.6 执行 `run()`（`adapter.py:96-139`）

```python
t0 = time.time()
try:
    import asyncio
    result = await asyncio.wait_for(
        self._session.call_tool(self._tool_name, arguments=tool_input),
        timeout=self._timeout_seconds,
    )
except asyncio.TimeoutError:    → error_code="PROVIDER_TIMEOUT",   content=f"MCP tool call timed out after {self._timeout_seconds}s"
except ConnectionError:         → error_code="TRANSPORT_UNAVAILABLE", content=f"MCP connection error: {e}"
except Exception:               → error_code="SERVER_EXEC_ERROR",   content=f"MCP server error: {e}"
```

- `timeout_seconds` 来自 server 配置（默认 30），**`asyncio.wait_for` 包在 `call_tool` 外层**。
- `except ConnectionError` 在 `except Exception` **之前** —— 顺序不可调换。
- 三个失败分支的 `meta`：
  - timeout：`{"elapsed_ms": elapsed_ms, "timeout_seconds": self._timeout_seconds}`
  - connection：`{"elapsed_ms": elapsed_ms}`
  - server error：`{"elapsed_ms": elapsed_ms}`
- **失败时 `data` 为 `None`**（未设置），`ok=False`。
- 成功路径：

```python
elapsed_ms = int((time.time() - t0) * 1000)
content = _extract_content(result)
return ToolResult(
    ok=True,
    content=content,
    data={"raw": _serialize_result(result)},
    meta={"elapsed_ms": elapsed_ms, "server": self._server_name},
)
```

- **`ok=True` 是硬编码的**：即使 MCP 返回 `isError=True`，只要没抛异常，`ok` 依然为 `True`。`isError` 的信息只在 `content` 文本上体现（见 §4）。复刻时必须照抄这个语义。
- `meta["server"]` 是 MCP 独有的字段（native tool 无）。
- `elapsed_ms` 会被 `ToolExecutor._run_tool` **覆盖**（`tools/core.py:270`：`result.meta["elapsed_ms"] = elapsed_ms`），所以 adapter 里算的 `elapsed_ms` 在正常工具链路上会被替换为「含权限门控在内的执行时长」。但在 `run()` 被直接调用（如测试）时保留本值。

### 3.7 复刻检查清单（adapter）

- [ ] 工具名格式 `f"mcp_{server_name}_{tool_name}"`，无转义。
- [ ] `version` 恒为 `"1.0.0"`。
- [ ] 风险推断：先 SHELL（high）后 WRITE（medium），子串匹配，默认 low。
- [ ] 忽略 MCP annotations。
- [ ] schema 只补 `type` / `properties` / `required`，浅拷贝。
- [ ] `requires_permission` 仅 high/medium 才 ask；low 直接放行。
- [ ] 三个错误码字符串逐字：`PROVIDER_TIMEOUT` / `TRANSPORT_UNAVAILABLE` / `SERVER_EXEC_ERROR`。
- [ ] `except ConnectionError` 在 `except Exception` 之前。
- [ ] 成功 `ok=True` 硬编码，忽略 `isError`。
- [ ] `data = {"raw": ...}`，`meta` 含 `server`。

---

## 4. 工具调用参数 / 结果的序列化

### 4.1 参数（入参）

- **无转换**：`tool_input` dict 直接作为 `arguments=tool_input` 传给 `session.call_tool`（`adapter.py:104`）。
- 参数仅用于：schema 校验（由模型侧负责，客户端不校验）、脱敏预览（`tools/permission_request.py:198-205` 的 `sanitize_args`，每值截断 80 字符）、可观测性脱敏（`sanitize.sanitize_tool_args`）。
- 客户端**不做参数级策略**（设计文档 §6.1 提到的 path/url/sql 参数策略未实现）。

### 4.2 结果提取 `_extract_content`（`adapter.py:142-156`）——**content block 转换规则**

```python
def _extract_content(result: Any) -> str:
    if hasattr(result, "content") and result.content:
        parts = []
        for item in result.content:
            if hasattr(item, "text"):       # ① TextContent
                parts.append(item.text)
            elif hasattr(item, "data"):     # ② ImageContent / AudioContent / BlobResourceContents
                parts.append(str(item.data))
            else:                           # ③ 其他
                parts.append(str(item))
        return "\n".join(parts) if parts else "(empty result)"
    if hasattr(result, "isError") and result.isError:
        return "(tool returned error)"
    return str(result) if result else "(empty result)"
```

**关键：判定基于 `hasattr`，不是 `item.type`**。用 MCP SDK 真实类型验证后的实际行为：

| content block 类型 | SDK 字段 | 走哪个分支 | 结果 |
|---|---|---|---|
| `TextContent` | `text` | ① | 原文 `item.text` |
| `ImageContent` | `data`（base64 str）、`mimeType` | ② | **裸 base64 字符串**，丢失 mimeType |
| `AudioContent` | `data`、`mimeType` | ② | 裸 base64，丢失 mimeType |
| `EmbeddedResource`（文本资源） | `resource`（无 `text`/`data` 顶层属性） | ③ | **pydantic repr**，如 `type='resource' resource=TextResourceContents(uri=AnyUrl('file:///tmp/x.txt'), ...)` |
| `ResourceLink` | `name`/`uri`/…（无 `text`/`data`） | ③ | pydantic repr |
| `EmbeddedResource`（二进制 blob） | 同上（`resource` 而非顶层 `data`） | ③ | pydantic repr |

多个 block 用 **`\n`** 连接（`"\n".join(parts)`）。

**实测样例**（`mcp.types` 真实对象）：

```python
CallToolResult(content=[
  TextContent(type='text', text='hello text'),
  ImageContent(type='image', data='aGVsbG8=', mimeType='image/png'),
  EmbeddedResource(type='resource', resource={'uri':'file:///tmp/x.txt','text':'inner file','mimeType':'text/plain'}),
])
# → "hello text\naGVsbG8=\ntype='resource' resource=TextResourceContents(uri=AnyUrl('file:///tmp/x.txt'), mimeType='text/plain', meta=None, text='inner file') annotations=None meta=None"
```

**即：image / resource 没有被结构化转换，`resource`（含内嵌文件文本）退化为 Python repr，内嵌文本虽在 repr 中但格式对模型极不友好。这是本实现的重大缺陷点，复刻时要么照抄（行为对齐），要么作为改进点显式标注。**

**`isError` 的处理顺序陷阱**：`isError` 分支只在 `content` **为空**时才可能到达：

```python
CallToolResult(content=[TextContent(text='a'), TextContent(text='b')], isError=True)
# → "a\nb"     ← 不是 "(tool returned error)"！
CallToolResult(content=[], isError=True)
# → "(tool returned error)"
```

即**只要 server 带了 content，`isError` 就被忽略**，错误信息只能靠文本内容传递。

其他空值路径（实测）：
- `CallToolResult(content=[])` → `str(result)`，即 pydantic repr `"meta=None content=[] structuredContent=None isError=False"`；
- `result = None` → `"(empty result)"`；
- `content` 全为空字符串列表（`parts` 为空列表）——不可能发生，因为 `result.content` 为 truthy 时列表非空。

### 4.3 结果序列化 `_serialize_result`（`adapter.py:159-173`）

```python
if result is None: return None
if hasattr(result, "model_dump"):
    try: return result.model_dump()
    except Exception: pass
if hasattr(result, "dict"):
    try: return result.dict()
    except Exception: pass
return str(result)
```

- 优先 pydantic v2 `model_dump()`，失败退 `dict()`，再失败退 `str()`。
- **`str(result)` 分支实际上不可达**（`CallToolResult` 必有 `model_dump`）。
- **致命易错点（实测确认）**：`model_dump()` 返回的 dict 里 `uri` 是 `pydantic.AnyUrl` 实例（`pydantic_core._pydantic_core.Url`），**不是 `str`**。因此 `json.dumps({"data": dumped})` 会抛：

```text
TypeError: Object of type AnyUrl is not JSON serializable
```

  该 dict 被存进 `ToolResult.data["raw"]`，随后在 `query_engine.py:1180` 被 `json.dumps` 写进 chat.json 的 `meta`。

  **好消息**：`query_engine.py:1180` 的 `json.dumps` **只在 `_persist_tool_result` 里对 `result.data` 做序列化**，而 `data` 只在 content 含 `EmbeddedResource` / `ResourceLink`（即带 `uri` 的块）时才会触发该错误。纯 `TextContent` 结果的 `data` 是 `{"raw": {"content": [{"type":"text","text":"..."}], ...}}`，`json.dumps` 正常。

  **坏消息**：一旦触发，`_persist_tool_result` 的 `json.dumps(meta)` 抛 `TypeError`，该异常**没有任何 catch**，会穿透到 `QueryEngine._execute_tool` → `_run_turn` → `submit_message` 的 `except Exception`（`query_engine.py:158-166`），整轮 status 变 `error`。

  **复刻建议**：照抄时至少加 `default=str`；若要严格对齐行为则在文档中标注为已知缺陷。

### 4.4 完整调用数据流

```text
模型 tool_use {id, name: "mcp_fs_read_file", input: {...}}
  └─ QueryEngine._execute_tool(turn_id, name, input, tool_use_id)
       ├─ _start_tool_trace(...)                 # 可观测性：name=f"tool.mcp_fs_read_file"
       ├─ ToolExecutor.execute(name, input, ctx)
       │    ├─ layer0: evaluate_skill_guards      # skills/guards.py
       │    ├─ layer1: _tool_allowed(name, ctx)   # 见 §5.1
       │    ├─ layer2: _is_tool_auto_allowed      # 自动放行白名单
       │    └─ layer3: tool.requires_permission() # adapter 的风险判定
       ├─ （若 PERMISSION_REQUIRED）→ 权限弹框 → execute_approved() → _run_tool()
       └─ MCPToolAdapter.run(input, ctx)
            ├─ asyncio.wait_for(session.call_tool(tool_name, arguments=input), timeout)
            ├─ _extract_content(result) → content: str
            └─ _serialize_result(result) → data["raw"]
```

---

## 5. 与权限系统、TUI 的接口

### 5.1 权限门控：MCP 工具实际走 4 层（`tools/core.py:159-223`）

MCP 工具**永远**以 `mcp_` 开头，因此会命中 `tools/core.py:152-154` 的显式分支：

```python
# MCP tools default to "ask" — gate them through the permission dialog
if tool_name.startswith("mcp_"):
    return PermissionDecision(False, f"MCP tool requires approval: {tool_name}", ask_user=True)
```

`_tool_allowed` 的**完整判定顺序**（`tools/core.py:144-157`，逐字）：

```python
p = context.permission
if tool_name in p.denied_tools:                                    # ① deny 最优先
    return PermissionDecision(False, f"tool denied: {tool_name}")
if p.allowed_tools is not None and tool_name in p.allowed_tools:   # ② 显式 allowed
    return PermissionDecision(True, "")
if tool_name in p.ask_tools:                                       # ③ 显式 ask
    return PermissionDecision(False, f"requires user approval: {tool_name}", ask_user=True)
if tool_name.startswith("mcp_"):                                   # ④ MCP 兜底 ask
    return PermissionDecision(False, f"MCP tool requires approval: {tool_name}", ask_user=True)
if p.allowed_tools is None:                                        # ⑤ Yolo 模式
    return PermissionDecision(True, "")
return PermissionDecision(False, f"tool not in allow list: {tool_name}")   # ⑥ 其余硬拒
```

由于 MCP 工具名不在 `allowed_tools` / `ask_tools`（native 工具名的硬编码集合）里，实际落到 ④，**结论：MCP 工具默认一律弹权限框，与 adapter 推断的 risk_level 无关**。

**这是关键不变量**：`MCPToolAdapter.requires_permission()` 的 low/medium/high 判定在第 3 层，而第 1 层（`_tool_allowed`）已经对**所有** MCP 工具返回 `ask_user=True`。所以：
- adapter 的 low → 仍然 ask（被第 1 层拦）；
- `@work` 顺序上，`ToolExecutor.execute` 在 `gate.ask_user` 为真时才检查 `_is_tool_auto_allowed`（`tools/core.py:190-196`），命中则**跳过权限直接 `_run_tool`**。

### 5.2 auto-allow 如何生效

两个独立入口，都写入 `ToolExecutor._auto_allow_tools: set[str]`：

1. **`ToolExecutor.add_auto_allow_tool(tool_name)`**（`tools/core.py:118-120`）：

```python
def add_auto_allow_tool(self, tool_name: str) -> None:
    """Auto-allow a specific tool by name (e.g. MCP tools)."""
    self._auto_allow_tools.add(tool_name)
```

   检查函数（`tools/core.py:122-125`）：

```python
def _is_tool_auto_allowed(self, tool_name: str, tool_input: dict[str, Any]) -> bool:
    if tool_name in self._auto_allow_tools:
        return True
    return self._is_command_auto_allowed(tool_name, tool_input)
```

   注意：`_is_command_auto_allowed` 对非 `bash` 工具**立即返回 False**（`tools/core.py:127-129`），所以 MCP 工具只靠「按名精确匹配」生效。

2. **TUI 的「always_approve」**（`app.py:1481-1505`，`_resolve_pending_permission`）：

```python
if resolution == "always_approve":
    tool_name = getattr(self, "_pending_permission_tool_name", "")
    tool_input = getattr(self, "_pending_permission_tool_input", {})
    if self._tool_executor is not None:
        if tool_name.startswith("mcp_"):
            # MCP tool: auto-allow by tool name
            self._tool_executor.add_auto_allow_tool(tool_name)
        else:
            # Bash / native tools: extract command prefix
            cmd = tool_input.get("command", "").strip()
            ...
            self._tool_executor.add_command_to_allowlist(pattern)
```

**粒度差异（重要易错点）**：
- native 工具（bash）：always-approve 记住的是**命令前缀**（如 `git status`），后续任何同前缀命令都放行；
- **MCP 工具：always-approve 记住的是整个工具名**（如 `mcp_fs_write_file`），此后该工具的**任意参数**都被放行。

`_auto_allow_tools` 是**进程内内存状态**，不持久化——重启后失效。TUI 的「approve」（单次）不会写入该集合。

另一个入口：`_handle_permission_required` 里 `resolution == "always_approve"` 分支（`query_engine.py:1019-1047`）只对 bash 提取命令前缀加白名单，**不处理 `mcp_` 前缀**——它依赖 `app.py` 那一侧已经加过了。两条路径同时存在，`app.py` 侧处理 MCP，`query_engine` 侧处理命令。

### 5.3 risk_level 到 TUI 的传递

`query_engine.py:925` 读取 tool 的 risk_level 传给权限请求：

```python
tool = self._tool_registry.get(tool_name)
risk_level = getattr(tool, "risk_level", "medium")
```

→ `PermissionRequest.create(..., risk_level=risk_level, ...)` → `TurnEvent(turn_id, "permission_required", {..., "risk_level": risk_level, ...})`（`query_engine.py:947-966`）→ `app.py:1234-1246` 渲染徽章（`RISK_LOW` / `RISK_MEDIUM` / `RISK_HIGH`，未知值回退 `risk_level.upper()`）。

对 MCP 工具，这个 `risk_level` 就是 §3.3 推断出的 `low` / `medium` / `high`。

### 5.4 TUI 接口清单

| 位置 | 行号 | 行为 |
|---|---|---|
| `/mcp` 命令 | `app.py:838-839` | `self._show_mcp_servers()` |
| 列表 | `app.py:948-998` | 重新 `load_mcp_config`；每项 `SelectionItem(server.name, f"{name} {status_label}", f"command: {cmd} {' '.join(args)}")`；空列表显示 `PANEL_MCP_NO_SERVERS` |
| 详情 | `app.py:1002-1083` | Markdown 面板：Server / Status / Transport / Command / Args / Env / Timeout / Error / Tools（按 `mcp_{server}_` 前缀列出 `- \`{tool_name}\` — {description[:60]}`） |
| 操作菜单 | `app.py:1070-1083` | `reconnect` / `back` 两项，`context="mcp_action"` |
| reconnect | `app.py:1085-1104` | `@work`，`await manager.reconnect_server(...)`，成功显示 `PANEL_MCP_RECONNECT_OK(count=...)` |
| 选择分发 | `app.py:1201-1207` | `mcp_select` → 详情；`mcp_action` → reconnect / 返回列表 |
| 状态栏 | `app.py:2293-2300` | `MCP: {connected}/{total}`；有 error 时 `MCP: {c}/{t} [red]{errors} err[/]` |

状态标签映射（`app.py:970-977` / `1023-1029`）：`"connected"` → PANEL_MCP_STATUS_CONNECTED，`"error"` → …ERROR，`"connecting"` → …CONNECTING，其他（含键不存在）→ …DISCONNECTED。

i18n keys（`i18n/keys.py:152-163`）：`PANEL_MCP_DETAIL` / `PANEL_MCP_NO_SERVERS` / `PANEL_MCP_STATUS_{CONNECTED,ERROR,CONNECTING,DISCONNECTED}` / `PANEL_MCP_RECONNECT` / `PANEL_MCP_RECONNECTING` / `PANEL_MCP_RECONNECT_OK` / `PANEL_MCP_BACK` / `PANEL_MCP_ACTION_TITLE`；另有 `CMD_MCP` / `CMD_MCP_DESC` / `SEL_MCP_TITLE` / `SEL_MCP_FOOTER`。

`PANEL_MCP_RECONNECT_OK` 的 en 文本：`"Reconnected successfully, {count} tools registered"`；zh：`"重新连接成功，{count} 个工具已注册"`。
`PANEL_MCP_NO_SERVERS` 的 en 文本：`"No MCP servers configured.\n\nAdd servers to the `mcp_servers` field in `~/.flyinchat/config.json`."`

### 5.5 MCP 工具是否进入系统提示词

`prompt_assembler.py` **不引用 MCP**。MCP 工具与 native 工具走同一条路：`query_engine.py:235-238` 取 `list(self._tool_registry.tools)` → `tools_to_api_format(...)` → 作为 provider 的 `tools` 参数。因此**不存在独立的 MCP 提示注入**，也没有设计文档 §5.2 描述的「精简 catalog + 按需展开」——全部工具 schema 每次都全量下发。

### 5.6 复刻检查清单（权限 / TUI）

- [ ] `_tool_allowed` 六步顺序：deny → allowed → ask → `mcp_` 前缀 → `allowed_tools is None` → 硬拒。
- [ ] `mcp_` 分支的 reason 字符串：`f"MCP tool requires approval: {tool_name}"`。
- [ ] `add_auto_allow_tool` 按**全名**放行（不是命令前缀）。
- [ ] MCP 的 always-approve 走 `app.py:1488-1490`，命令前缀走 `else` 分支。
- [ ] auto-allow 不持久化。
- [ ] 状态栏格式 `MCP: c/t`，有错加 ` [red]{n} err[/]`。
- [ ] 详情面板工具行格式 `- \`{name}\` — {description[:60]}`。
- [ ] 前缀匹配统一用 `f"mcp_{server_name}_"`。

---

## 6. 配置校验与错误信息

### 6.1 配置层（静默）

| 情形 | 行为 |
|---|---|
| `mcp_servers` 缺失 / 非 list | `.get(..., [])` → 空列表（非 list 时 `list()` 会抛，若给了 dict 则取 keys，未做类型防护） |
| server 项非 dict | `MCPServerConfig.from_dict(item)` 里 `data.get` 抛 `AttributeError`——**未捕获**，会穿透 `connect_all` 的 except 吗？不会：`MCPConfig.from_dict` 在 `connect_all` **之前**调用（`app.py:432`），所以它抛到 `_init_mcp_servers` worker，**整个 MCP 初始化中止**（Textual `@work` 记录异常）。这是配置层唯一的硬失败点。 |
| `name` 缺失或空串 | `None` → 丢弃 |
| `command` 缺失或空串 | `None` → 丢弃 |
| `transport` 非 `"stdio"` | `None` → 丢弃 |

### 6.2 连接层错误信息（逐字）

| 来源 | 字符串 |
|---|---|
| mcp 包缺失 | `f"mcp package not installed: {e}. Install it with: pip install mcp"` （存入 `_errors`） |
| 连接/初始化失败 | `str(e)` 原样（存入 `_errors`），面板中以 ``` ```{err_msg}``` ``` 代码块展示 |
| 未配置任何 server | 日志 `"No MCP servers configured"`（info） |
| 工具重名 | 日志 `"MCP tool name conflict, skipping: %s"`（warning） |
| shutdown 超时 | 日志 `"MCP shutdown timed out for server: %s"`（warning），status → `"error"` |

### 6.3 运行时错误码（`ToolResult.error_code`，逐字）

| 错误码 | 触发条件 | 内容模板 |
|---|---|---|
| `PROVIDER_TIMEOUT` | `asyncio.wait_for` 超时 | `f"MCP tool call timed out after {timeout_seconds}s"` |
| `TRANSPORT_UNAVAILABLE` | 抛 `ConnectionError` | `f"MCP connection error: {e}"` |
| `SERVER_EXEC_ERROR` | 其他任何异常 | `f"MCP server error: {e}"` |
| `PERMISSION_REQUIRED` | 权限未决（来自 executor，非 adapter） | — |
| `PERMISSION_DENIED` | 用户拒绝 / 超时（executor 层） | `f"User denied permission for {tool_name}"` / `f"Permission request timed out for {tool_name}"` |
| `TOOL_NOT_FOUND` | registry 无该名 | `str(KeyError)` |
| `TOOL_RUNTIME_ERROR` | `run()` 抛未捕获异常 | `f"{type(e).__name__}: {e}"` |

设计文档 §9.1 列举的 `VALIDATION_ERROR` / `RESULT_TOO_LARGE` / `RATE_LIMITED` / `UNKNOWN` **未实现**；`mcp.connection_state`、`tool.start`/`tool.complete` 结构化日志（文档 §10.2）中，`ToolExecutor._emit` 只发 `tool.start` / `tool.error` / `tool.complete` 到 `context.emit_event`（且 `ToolContext.emit_event` 在主链路中**为 None**，即不会被消费）。

### 6.4 重试

**没有任何重试**。设计文档 §9.2 要求「仅对可重试错误重试 + 指数退避」——**未实现**。单次 `call_tool` 失败即返回失败结果给模型，由模型自己决定是否再调一次。

---

# 第二部分：可观测性（Langfuse）

## 0. 文件职责总览

| 文件 | 行数 | 职责 |
|---|---|---|
| `observability/__init__.py` | 24 | 导出 9 个公共符号 |
| `observability/config.py` | 87 | `ObservabilityConfig`（frozen）+ 从 config.json 的 `app_settings` 读取 |
| `observability/client.py` | 406 | `ObservabilityClient` 协议、`NoopObservabilityClient`、`LangfuseObservabilityClient`（v4 SDK 适配）、`create_observability_client` |
| `observability/tracing.py` | 317 | `AgentTrace` / `GenerationTrace` / `ToolTrace`——层次结构与生命周期 |
| `observability/sanitize.py` | 197 | 脱敏、截断、hash、敏感路径识别 |
| `observability/metrics.py` | 179 | `ToolCallMetric` / `AgentRunMetrics`（immutable，`with_*` 累积） |
| `observability/scoring.py` | 139 | `build_scores` / `classify_failure` / `_progress_rate` |
| `observability/git_metadata.py` | 86 | `GitMetadata` / `GitDiffSummary` / 3 个 git 子进程调用 |

logger 名：`logging.getLogger("flyinchat.observability")`（client.py）。

`__init__.py:13-23` 的 `__all__`（复刻时保持同名集合）：`AgentRunMetrics`, `AgentTrace`, `GenerationTrace`, `LangfuseObservabilityClient`, `NoopObservabilityClient`, `ObservabilityClient`, `ObservabilityConfig`, `ToolTrace`, `create_observability_client`。

---

## 1. `config`：启用条件与字段默认值

### 1.1 字段与默认值（`config.py:8-17`）

frozen dataclass：

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | `bool` | 无默认（必填） | 最终是否启用 |
| `public_key` | `str` | 无默认 | |
| `secret_key` | `str` | 无默认 | |
| `host` | `str` | 无默认 | |
| `debug` | `bool` | `False` | |
| `agent_env` | `str` | `"development"` | |
| `agent_version` | `str` | `"local"` | |
| `disabled_reason` | `str` | `""` | 禁用原因（仅日志用） |

派生属性：`has_credentials` = `bool(public_key and secret_key)`（`config.py:19-21`）——**注意这个属性在代码里从未被使用**。

### 1.2 **没有环境变量**——配置全部来自 config.json（`config.py:23-67`）

**必须强调**：`docs/langfuse/langfuse-observability-methodology.md` 通篇要求 `.env` + `LANGFUSE_PUBLIC_KEY` 等环境变量，但**最终实现完全放弃了 .env 方案**。`docs/langfuse/langfuse-setup.md:5` 明确写道：

> 所有 Langfuse 配置均存储于 `~/.flyinchat/config.json` 的 `app_settings` 字段中，无需 `.env` 文件。

代码中**不存在** `os.environ` / `os.getenv` / `dotenv` 的任何引用，`pyproject.toml` 也未引入 `python-dotenv`。

仓库根有 `.env.example`（**已被 git 跟踪**），但它**没有任何实际变量赋值**，全文只是注释，内容逐字如下：

```text
# Example environment variables for FlyinChat (optional).
# Most settings are now stored in ~/.flyinchat/config.json.
#
# Langfuse observability settings are configured in config.json "app_settings":
#   "langfuse_enabled": "true",
#   "langfuse_public_key": "pk-lf-...",
#   "langfuse_secret_key": "sk-lf-...",
#   "langfuse_host": "https://cloud.langfuse.com",
#   "langfuse_debug": "false",
#   "agent_env": "development",
#   "agent_version": "local"
```

`.gitignore` 已包含 `.env`、`.env.*`、`!.env.example` 三条（另有 `.flyinchat/`、`.omc`、`.venv/` 等）：

```text
.omc
__pycache__/
*.py[cod]
.pytest_cache/
.ruff_cache/
.mypy_cache/
.coverage
htmlcov/
dist/
build/
.venv/
.env
.env.*
!.env.example
.flyinchat/
.DS_Store
TestWorkspace
```

复刻时**不要实现环境变量读取**（除非有意改进），`.env.example` 保留为纯注释存根即可；`.gitignore` 的三条 env 规则要保留。

**实际配置键名（位于 config.json 的 `app_settings` 下，全部为字符串值）**：

| app_settings 键 | 默认值 | 解析方式 |
|---|---|---|
| `langfuse_enabled` | `False` | `_bool_setting` |
| `langfuse_public_key` | `""` | `.strip()` |
| `langfuse_secret_key` | `""` | `.strip()` |
| `langfuse_host` | `"https://cloud.langfuse.com"` | `.strip() or "https://cloud.langfuse.com"` |
| `langfuse_debug` | `False` | `_bool_setting` |
| `agent_env` | `"development"` | `.strip() or "development"` |
| `agent_version` | `"local"` | `.strip() or "local"` |

布尔解析（`config.py:83-87`）——**原样抄录**：

```python
def _bool_setting(settings, key, *, default: bool) -> bool:
    raw = settings.get(key)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on", "y"}
```

即 truthy 集合为 `{"1", "true", "yes", "on", "y"}`（大小写不敏感，strip 后）。`"false"` / `"0"` / `"no"` / 任意其他值 → `False`。**键不存在时用 default，键存在但值非法时返回 False（而不是 default）**。

### 1.3 读取路径（`config.py:70-80`）

```python
def _load_app_settings(config_path: Path) -> dict[str, str]:
    if not config_path.exists():
        return {}
    try:
        data = json.loads(config_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}
    raw = data.get("app_settings", {})
    if not isinstance(raw, dict):
        return {}
    return {str(k): str(v) for k, v in raw.items()}
```

- 文件不存在 / JSON 损坏 / `app_settings` 非 dict → `{}`（**全部静默**，无日志）。
- **所有值被 `str()` 强转**：config.json 里写 `"langfuse_enabled": true`（JSON bool）会变成 Python 字符串 `"True"` → `"true"` in 集合 → `True` ✓。写 `1`（数字）→ `"1"` → `True` ✓。写 `false` → `"False"` → `"false"` 不在集合 → `False` ✓。所以 JSON 原生类型也能工作。
- **未知键被保留**（`str(k): str(v)` 全量转换），但只按上表 7 个键取值。

### 1.4 三级判定（`config.py:35-67`）——**顺序不可换**

```python
if not enabled:
    return cls(enabled=False, ..., disabled_reason="langfuse_enabled is false")
if not public_key or not secret_key:
    return cls(enabled=False, public_key="", secret_key="", ...,
               disabled_reason="Langfuse keys are missing")
return cls(enabled=True, ...)      # disabled_reason 保持默认 ""
```

- `disabled_reason` 的两个字面量逐字：**`"langfuse_enabled is false"`** 和 **`"Langfuse keys are missing"`**。
- 第二个分支把 `public_key` / `secret_key` **强制清空为 `""`**（防止半配置状态泄漏到日志）。
- `host` / `debug` / `agent_env` / `agent_version` 在**所有**分支都保留原值。

对应测试（`tests/test_observability_config.py`）：默认（空 app_settings）→ `disabled_reason == "langfuse_enabled is false"`；`langfuse_enabled=true` 无 key → `"Langfuse keys are missing"`；配置文件不存在 → `"langfuse_enabled is false"`。

### 1.5 未配置时的 no-op 行为

`create_observability_client`（`client.py:363-383`）：

```python
if config is None:
    if config_path is not None:
        config = ObservabilityConfig.from_config_store(config_path)
    else:
        config = ObservabilityConfig.from_config_store(Path("~/.flyinchat/config.json").expanduser())
if not config.enabled:
    if config.disabled_reason:
        logger.info("Langfuse disabled", extra={"event_type": config.disabled_reason})
    return NoopObservabilityClient()
try:
    return LangfuseObservabilityClient(config)
except Exception as exc:
    logger.warning(
        "Langfuse client initialization failed; observability disabled",
        extra={"event_type": "langfuse_init_failed", "error_body": str(exc)[:500]},
    )
    return NoopObservabilityClient()
```

**降级保证**：任何路径失败都返回 `NoopObservabilityClient`（`enabled` 属性为 `False`，9 个方法全部 `return None`）。**可观测性永远不能让主流程失败**——这是硬性不变量。

`config_path=None` 时的兜底路径是 `Path("~/.flyinchat/config.json").expanduser()`（硬编码字面量，未走 `paths.py`）。

`NoopObservabilityClient`（`client.py:92-168`）：`enabled` → `False`；`start_trace`/`start_span`/`start_generation` 返回 `None`；`update_trace`/`end_span`/`end_generation`/`score_trace`/`flush`/`shutdown` 返回 `None`。

---

## 2. `client`：Langfuse SDK 封装与失败降级

### 2.1 `ObservabilityClient` 协议（`client.py:13-89`）

9 个方法（`Protocol`，结构化类型，不需要继承）：

```python
@property
def enabled(self) -> bool: ...
def start_trace(self, *, name, input, metadata, session_id, user_id=None) -> Any: ...
def update_trace(self, trace_ref, *, output=None, metadata=None, status_message=None) -> None: ...
def start_span(self, trace_ref, *, name, input, metadata) -> Any: ...
def end_span(self, span_ref, *, output=None, metadata=None, status_message=None) -> None: ...
def start_generation(self, trace_ref, *, name, model, input, metadata, model_parameters) -> Any: ...
def end_generation(self, generation_ref, *, output=None, usage=None, metadata=None, status_message=None) -> None: ...
def score_trace(self, trace_ref, *, name, value, comment="") -> None: ...
def flush(self) -> None: ...
def shutdown(self) -> None: ...
```

**全部为 keyword-only**（除 `trace_ref` / `span_ref` 等位置参数）。业务代码只依赖这个协议，不 import Langfuse SDK——这是设计文档 §7.6 要求的核心原则。

### 2.2 SDK 版本适配声明（`client.py:171-176`）

类 docstring 逐字：

```text
Langfuse v4 SDK adapter.

v4 uses start_observation() with as_type instead of trace()/span()/generation().
Observations are nested: root_span.start_observation() creates child spans.
```

本机安装版本：`langfuse 4.7.1`（`pyproject.toml` 声明 `langfuse>=3.0.0`，但代码只对 v4 API 有效）。`Langfuse` 对象上使用到的方法：`start_observation` / `flush` / `shutdown`；observation 对象上使用到：`update` / `end` / `start_observation` / `score_trace`。

### 2.3 初始化（`client.py:339-350`）

```python
@staticmethod
def _create_client(config: ObservabilityConfig) -> Any:
    try:
        from langfuse import Langfuse
    except Exception as exc:
        raise RuntimeError("Langfuse SDK is not installed") from exc
    return Langfuse(
        public_key=config.public_key,
        secret_key=config.secret_key,
        host=config.host,
        debug=config.debug,
    )
```

- 延迟 import（模块顶层不 import langfuse）——保证未安装 SDK 时模块本身可导入。
- `RuntimeError("Langfuse SDK is not installed")` 由 `create_observability_client` 捕获 → Noop。
- 构造在 `__init__` 中立即执行（`client.py:178-180`）。

### 2.4 `_safe_call`：唯一失败防线（`client.py:352-360`）

```python
def _safe_call(self, action: str, call: Any) -> Any:
    try:
        return call()
    except Exception as exc:
        logger.warning(
            "Langfuse observability action failed",
            extra={"event_type": action, "error_body": str(exc)[:500]},
        )
        return None
```

- **每个** SDK 交互都被包在 `_safe_call` 里（`start_trace` / `update_trace` / `start_span` / `end_span` / `start_generation` / `end_generation` / `score_trace` / `flush` / `shutdown`）。
- 异常被降级为 warning 日志（`error_body` 截断 500 字符），返回 `None`。
- **后果：一个失败的动作会返回 `None`，而 `None` 在后续调用中会被当作「无 ref」静默跳过**（所有方法开头都有 `if trace_ref is None: return None`）。这构成天然的失败链断裂。
- 注意：`_safe_call` 记录的是 `event_type=action`（如 `"start_span"`），而 `create_observability_client` 记录的是 `event_type="langfuse_init_failed"`。

### 2.5 Trace / Span / Generation 的 v4 映射

| 我们的概念 | v4 SDK 调用 | 备注 |
|---|---|---|
| Trace（root） | `client.start_observation(name=..., as_type="agent", input=..., metadata=...)` | **`as_type="agent"`**，不是 `"trace"` |
| Span（child） | `trace_ref.start_observation(name=..., as_type="span", input=..., metadata=...)` | 挂在 root 或其他 span 下 |
| Generation | `trace_ref.start_observation(name=..., as_type="generation", model=..., input=..., metadata=..., model_parameters=...)` | |
| 结束 span/generation | `ref.update(output=..., metadata=..., status_message=..., usage_details=...)` 然后 `ref.end()` | 见 `_end_observation` |
| 结束 trace | 先 `trace_ref.update(...)`，再 `client.end_span(self.trace_ref)` | **复用 `end_span`** |
| Score | `trace_ref.score_trace(name=..., value=..., comment=comment or None)` | |

**注意**：`end_span` 在 `AgentTrace.finish` 中被用于结束 **root trace observation 本身**（`tracing.py:203`：`self.client.end_span(self.trace_ref)`）。命名上有点混乱但行为正确（root 也是一个 observation）。

`_end_observation`（`client.py:386-406`）——**只传非 None 的 kwargs 再 `end()`**：

```python
update_kwargs: dict[str, Any] = {}
if output is not None:        update_kwargs["output"] = output
if metadata is not None:      update_kwargs["metadata"] = metadata
if status_message is not None: update_kwargs["status_message"] = status_message
if usage_details is not None: update_kwargs["usage_details"] = usage_details
if update_kwargs:
    ref.update(**update_kwargs)
ref.end()
```

### 2.6 每处数据的脱敏位置（**重要**）

`LangfuseObservabilityClient` 的**每个**入参都过 `sanitize_value`：

| 方法 | 被 sanitize 的字段 |
|---|---|
| `start_trace` | `metadata`（先合并 `session_id`，再整体 sanitize）、`input`；`user_id` 合并进 metadata 但**不 sanitize**（是明文 str，仅当传入时） |
| `update_trace` | `output`、`metadata`（`status_message` **不 sanitize**） |
| `start_span` | `input`、`metadata` |
| `end_span` | `output`、`metadata` |
| `start_generation` | `input`、`metadata`、`model_parameters`（`model` 名 **不 sanitize**） |
| `end_generation` | `output`、`metadata`（`usage` **不 sanitize**，直接作 `usage_details`） |
| `score_trace` | **都不 sanitize**（`name` / `value` / `comment` 原样） |

`start_trace` 的 metadata 组装顺序（`client.py:197-199`）：

```python
merged_meta = sanitize_value({**metadata, "session_id": session_id})
if user_id:
    merged_meta["user_id"] = user_id
```

`session_id` 是被**注入**到 metadata 的（调用方 `AgentTrace.start` 传的 metadata 里已经有 `session_id`，此处覆盖一次，值相同）。

**结论：`user_id`（若传入）与 `status_message` 不走脱敏。** 当前代码 `AgentTrace.start` 传 `user_id=None`，所以实际不触发。

### 2.7 复刻检查清单（client）

- [ ] 无环境变量；配置来自 `app_settings`。
- [ ] `_bool_setting` 的 truthy 集合 `{"1","true","yes","on","y"}`。
- [ ] 两个 `disabled_reason` 字面量。
- [ ] 任何初始化失败 → Noop（不抛）。
- [ ] 所有 SDK 调用走 `_safe_call`（不抛、warning 日志、返回 None）。
- [ ] root observation `as_type="agent"`；child span `as_type="span"`；LLM `as_type="generation"`。
- [ ] `_end_observation` 只传非 None kwargs 再 `end()`。
- [ ] `enabled` 属性：Noop=False，Langfuse=True（不受 config 影响）。

---

## 3. `tracing`：层次结构（**核心**）

### 3.1 模型：「一次用户任务 = 一个 trace」

设计文档 §1.1 的映射，实际实现：

```text
TUI session_id / conversation_id      = Langfuse trace 的 session_id
一次用户请求（一次 submit_message）    = 一个 Langfuse trace（observation as_type="agent"）
  agent 主循环                        = 一个 span "agent.loop"（trace 的直接子）
    每次 LLM 调用                     = 一个 generation（"llm.agent_turn" / "llm.compaction_summary"）
    每次工具调用                      = 一个 span "tool.<tool_name>"
  trace 结束                          = scores 写入 trace
```

**层次图（实际嵌套关系）**：

```text
[TRACE / root observation]  name="flyinchat.user_task"   as_type="agent"
│   input  = 用户原始输入字符串
│   metadata = 见 §3.3（trace metadata 全量）
│   session_id → 注入 metadata
│
└── [SPAN]  name="agent.loop"                            as_type="span"
    │   input = {"user_input": <str>}
    │   metadata = 与 trace 完全相同的 dict（同一对象）
    │   output（finish 时）= final_answer / status / error_message / total_steps /
    │                        total_tool_calls / total_llm_calls / total_latency_ms
    │   status_message = result.error
    │
    ├── [GENERATION]  name="llm.agent_turn"              as_type="generation"
    │     model = model.name
    │     input = {"messages": [...sanitized...], "preview": "<截断后的 JSON>"}
    │     metadata = {message_count, input_hash, input_sanitized_hash,
    │                 input_truncated, input_original_length}
    │     model_parameters = {provider_type, max_tokens, thinking_enabled,
    │                         reasoning_effort, tools_count}
    │     output = [thinking block, text block, tool_use blocks...]
    │     usage_details = {input_tokens, output_tokens, total_tokens, <usage_info 中的数值>}
    │     metadata(end) = {latency_ms, finish_reason, error}
    │
    ├── [GENERATION]  name="llm.compaction_summary"      as_type="generation"
    │     （由 CompactionEngine 发起，挂在 trace 上——注意**不是**挂在 agent.loop 上）
    │
    └── [SPAN] name="tool.<tool_name>"    ×N            as_type="span"
          （由 start_tool 发起，挂在 trace 上，**不是嵌套在某个 generation 里**）
          input = 脱敏后的 tool_args
          metadata(start) = {tool_call_id, tool_name, risk_level,
                             requires_approval: False, approval_status: "not_required"}
          output(end) = {"tool_result_preview": "<truncated preview>"}
          metadata(end) = {tool_call_id, tool_name, status, error_type, error_message,
                           latency_ms, risk_level, requires_approval, approval_status,
                           tool_result_hash, tool_result_truncated,
                           tool_result_original_length, tool_result_redacted, data}
```

**关键结构事实（与设计文档的偏差，复刻必须明确）**：

1. **`tool.*` span 与 `llm.agent_turn` generation 是兄弟，不是父子**。`start_tool` 用 `self.trace_ref` 作为父（`tracing.py:143-144`），`start_generation` 也用 `self.trace_ref`（`tracing.py:121-122`）。所以 Langfuse 里看到的是一棵**扁平的二级树**：`agent.loop` 与所有 `tool.*` / `llm.*` 平级挂在 trace 下。**没有**「generation 产生 tool_use → tool span 作为其子」的因果嵌套。

2. **`agent.loop` 是唯一直接挂在 trace 下的长期 span**，但它**只包含 user_input 与最终 output**，不包含子节点（子节点是它的兄弟）。它是一个「任务级 summary span」。

3. **压缩产生的 `llm.compaction_summary` 挂在 trace 上**（compaction engine 持有的是 `AgentTrace`，调 `start_generation` 用 `self.trace_ref`），不是挂在 `agent.loop` 下。

4. **没有 permission span**。权限信息只作为 tool span 的 metadata 字段（`requires_approval` / `approval_status`）与 trace 的一个计数（`permission_request_count`）。设计文档 §2.4 要求 permission 作为独立记录——**未实现为独立 span**。

5. **没有独立的 `tools_count` / prompt 版本 span**。`prompt_version` 恒为 `"default"`，`tool_version` 恒为 `"default"`（`tracing.py:51-52`）。

### 3.2 `AgentTrace`（`tracing.py:18-204`）

dataclass 字段（`tracing.py:18-27`）：

```python
client: ObservabilityClient = field(default_factory=NoopObservabilityClient)
trace_ref: Any = None
span_ref: Any = None
workspace: Path = field(default_factory=Path.cwd)
turn_id: str = ""
started_at: float = field(default_factory=time.time)     # 注意：start() 里不重置
config: ObservabilityConfig | None = None
metrics: AgentRunMetrics = field(default_factory=AgentRunMetrics)
```

**易错点**：`AgentTrace.start(...)` 返回时**没有传 `started_at`**（`tracing.py:75-82`），所以 `started_at` 是 dataclass 默认工厂在**构造那一刻**取的时间——即 `start()` 执行到 return 时。它与 metadata 里写入的 `"started_at": time.time()`（`tracing.py:58`）**是两个不同的时间戳**（相差约几毫秒），且 `started_at` 字段本身**在代码中从未被读取**（死字段）。真正用于计算 `task_latency_ms` 的是 `query_engine.py` 里的 `t_start`。

#### `AgentTrace.start()`（`tracing.py:29-82`）

```python
client = client or NoopObservabilityClient()
git = collect_git_metadata(workspace)
agent_version = _agent_version(config, git.commit)
metadata = {
    "trace_id": "managed_by_langfuse",     # ← 字面量占位符，不是真实 id
    "session_id": conversation_id,
    "task_id": turn_id,
    "agent_version": agent_version,
    "model_name": model_name,
    "prompt_version": "default",
    "tool_version": "default",
    "workspace": str(workspace),
    "git_branch": git.branch,
    "git_commit_before": git.commit,
    "agent_mode": agent_mode,
    "permission_mode": permission_mode,
    "started_at": time.time(),
    "agent_env": config.agent_env if config else "development",
}
trace_ref = client.start_trace(
    name="flyinchat.user_task", input=user_input,
    metadata=metadata, session_id=conversation_id, user_id=None,
)
span_ref = client.start_span(
    trace_ref, name="agent.loop",
    input={"user_input": user_input}, metadata=metadata,
)
```

- **trace 名逐字：`"flyinchat.user_task"`**（`/langfuse` 文档与 setup.md 里让用户按此名搜索）。
- **span 名逐字：`"agent.loop"`**。
- `"trace_id": "managed_by_langfuse"` 是**占位字符串**——真实 id 由 Langfuse 生成，metadata 里这个键只是告诉查看者「去 Langfuse 看」。
- **`metadata` 是同一个 dict 对象被传两次**（trace 与 span 共用引用），但因为 `client.start_trace` / `start_span` 内部各自 `sanitize_value`（会**新建** dict），实际不会串改。
- `user_id=None` **硬编码**——注释与参数保留但永远不传值。
- `agent_version` 兜底链（`tracing.py:313-316`）：

```python
def _agent_version(config, git_commit: str) -> str:
    if config and config.agent_version:
        return config.agent_version
    return git_commit if git_commit != "unknown" else "local"
```

即：config 有 `agent_version` 就用它（默认 `"local"`）；否则用 git commit；git 拿不到则 `"local"`。**注意：因为 `agent_version` 默认值是 `"local"`（truthy），只要传了 config，就永远返回 `"local"`，git commit 分支实际不可达。**

调用方传入的实参（`query_engine.py:123-132`）：

```python
trace = AgentTrace.start(
    self.config.observability_client,
    turn_id=turn_id,
    conversation_id=self.config.conversation_id,
    user_input=user_content,
    workspace=self.config.paths.project_dir.parent,     # ← 注意是 project_dir 的 parent
    agent_mode=self.mode,
    permission_mode=self.mode,                          # ← 同一个值传两次
    model_name=primary[1].name if primary is not None else "unknown",
)
```

- **`workspace` 是 `paths.project_dir.parent`**，即 workspace 根的上一级（`project_dir = cwd / ".flyinchat"`，parent 即 `cwd`）。实际等于「当前工作目录」。
- **`agent_mode` 与 `permission_mode` 传入同一个 `self.mode`**（值为 `"normal"` / `"auto_edit"` / `"yolo"` / `"plan"`）。它们不是独立的两个概念。
- `config` **不传**（`None`）→ 所以 `agent_env` 恒为 `"development"`，`_agent_version` 走 `git.commit != "unknown"` 分支 → 返回 git commit。**这是唯一让 git commit 生效的路径。**

#### 其他方法

| 方法 | 行号 | 行为 |
|---|---|---|
| `update_model(model)` | `tracing.py:84-88` | `client.update_trace(trace_ref, metadata={"model_name": model.name, "model_id": model.id})` |
| `mark_compaction(*, tokens_before, tokens_after)` | `tracing.py:90-94` | `self.metrics = self.metrics.with_compaction(...)`——**只改本地 metrics，不调 SDK** |
| `start_generation(...)` | `tracing.py:96-132` | 见下 |
| `start_tool(...)` | `tracing.py:134-163` | 见下 |
| `finish(result, *, task_latency_ms)` | `tracing.py:165-204` | 见下 |

`start_generation` 细节（`tracing.py:96-132`）：

```python
sanitized_messages = sanitize_messages(messages)
model_parameters = {
    "provider_type": channel.provider_type,
    "max_tokens": max_tokens or model.max_output_tokens,
    "thinking_enabled": model.thinking_enabled,
    "reasoning_effort": model.reasoning_effort,
    "tools_count": tools_count,
}
metadata = {
    "message_count": len(messages),
    "input_hash": sanitized_messages["hash"],
    "input_sanitized_hash": sanitized_messages["sanitized_hash"],
    "input_truncated": sanitized_messages["truncated"],
    "input_original_length": sanitized_messages["original_length"],
}
ref = self.client.start_generation(
    self.trace_ref, name=name, model=model.name,
    input={"messages": sanitized_messages["messages"], "preview": sanitized_messages["preview"]},
    metadata=metadata, model_parameters=model_parameters,
)
return GenerationTrace(parent=self, ref=ref, started_at=time.time())
```

- **`max_tokens` 兜底：`max_tokens or model.max_output_tokens`**——显式传的优先，否则模型的 `max_output_tokens`（`0` 也会走兜底）。
- **`name` 由调用方给定**，两个实际取值：`"llm.agent_turn"`（`query_engine.py:461`）与 `"llm.compaction_summary"`（`compact.py:408`）。
- **metadata 键名逐字**：`message_count` / `input_hash` / `input_sanitized_hash` / `input_truncated` / `input_original_length`。
- **model_parameters 键名逐字**：`provider_type` / `max_tokens` / `thinking_enabled` / `reasoning_effort` / `tools_count`。
- **脱敏陷阱（实测确认）**：`max_tokens` 与 `tools_count` 经过 `sanitize_value` 后，`max_tokens` 被 `is_sensitive_key` 判为敏感（含子串 `token`）→ 变成 **`"[REDACTED]"`**！`tools_count` 正常。实测：

```text
sanitize_value({'provider_type':'anthropic','max_tokens':8192,'thinking_enabled':True,
                'reasoning_effort':'high','tools_count':14})
# → {'provider_type': 'anthropic', 'max_tokens': '[REDACTED]', 'thinking_enabled': True,
#    'reasoning_effort': 'high', 'tools_count': 14}
```

  **这是必须复刻的行为**（或作为改进点标注）：`max_tokens` 在 Langfuse 里看不到真实值。同理见 §4.3 的 `input_tokens` / `total_tokens`。

`start_tool` 细节（`tracing.py:134-163`）：

```python
sanitized_args = sanitize_tool_args(tool_args)
ref = self.client.start_span(
    self.trace_ref,
    name=f"tool.{tool_name}",                       # ← span 名格式：tool.<工具名>
    input=sanitized_args,
    metadata={
        "tool_call_id": tool_call_id,
        "tool_name": tool_name,
        "risk_level": risk_level,
        "requires_approval": False,                 # ← 初始 False
        "approval_status": "not_required",          # ← 初始 "not_required"
    },
)
```

**span 名格式逐字：`f"tool.{tool_name}"`**。对 MCP 工具，`tool_name` 是 `mcp_fs_read_file` → span 名 `tool.mcp_fs_read_file`。

`finish()` 细节（`tracing.py:165-204`）——**结束顺序不可换**：

```python
diff = collect_git_diff_summary(self.workspace)
scores = build_scores(result, self.metrics, task_latency_ms=task_latency_ms)
metadata = {
    **self.metrics.as_metadata(),
    **diff.as_dict(),
    **scores.metadata,
    "status": result.status,
    "terminal_reason": result.terminal_reason,
    "last_tool_error": result.last_tool_error,
    "ended_at": time.time(),
}
output_data = {
    "final_answer": result.final_text,
    "status": result.status,
    "error_message": result.error,
    "total_steps": self.metrics.total_steps,
    "total_tool_calls": self.metrics.tool_call_count,
    "total_llm_calls": self.metrics.llm_call_count,
    "total_latency_ms": task_latency_ms,
}
# ① 结束 agent.loop span
self.client.end_span(self.span_ref, output=output_data, metadata=metadata, status_message=result.error)
# ② 写 scores
for name, value in scores.scores.items():
    self.client.score_trace(self.trace_ref, name=name, value=value)
# ③ 结束 root trace observation
self.client.update_trace(self.trace_ref,
    output=result.final_text or result.error or result.status,
    metadata=metadata, status_message=result.error)
self.client.end_span(self.trace_ref)
# ④ 强制 flush
self.client.flush()
```

- **`git diff summary` 在 `finish()` 里采集**（每个 turn 结束跑 3 个 git 子进程）。
- **scores 在 `flush()` 之前写入**。
- trace 的 `output` 三级兜底：`final_text or error or status`。
- `status_message` 在 trace 与 span 上都设成 `result.error`（**可能是 `None`**，此时 `_end_observation` 不传该 kwarg）。

### 3.3 `GenerationTrace`（`tracing.py:207-245`）

```python
@dataclass
class GenerationTrace:
    parent: AgentTrace
    ref: Any
    started_at: float

    def finish(self, *, output, usage_info, input_tokens, output_tokens, error=None) -> None:
        elapsed_ms = int((time.time() - self.started_at) * 1000)
        metadata = {
            "latency_ms": elapsed_ms,
            "finish_reason": "error" if error else "stop",     # ← 只有两态
            "error": error,
        }
        usage = {
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "total_tokens": input_tokens + output_tokens,
            **{k: v for k, v in usage_info.items() if isinstance(v, int | float)},
        }
        self.parent.client.end_generation(
            self.ref, output=sanitize_value(output), usage=usage,
            metadata=metadata, status_message=error,
        )
        self.parent.metrics = self.parent.metrics.with_llm_call(
            input_tokens=input_tokens, output_tokens=output_tokens, latency_ms=elapsed_ms,
        )
```

- **`finish_reason` 是二值**：有 error → `"error"`，否则 → `"stop"`。**不读 provider 的真实 finish_reason**（如 `"tool_use"` / `"length"`）。这是与设计文档 §2.3 的偏差。
- `usage` 的展开会把 `usage_info` 里的数值键**覆盖**前三个键（若 provider 返回了 `input_tokens` 等）——实际上 `usage_info` 的值通常与传入的 `input_tokens` 相同。
- **`input_tokens` 的累积语义有 bug（实测确认）**：`AgentRunMetrics.with_llm_call` 里 `input_tokens=input_tokens`（`metrics.py:104`）是**覆盖**而非累加（`output_tokens=self.output_tokens + output_tokens` 才是累加）。实测两次调用（100, 200）后 `input_tokens == 200` 而 `output_tokens == 30`。复刻时若要对齐行为就照抄；若要修正应为 `self.input_tokens + input_tokens`。
- `usage` 与 `ref` 直接传给 `end_generation` → 内部 `usage` **不 sanitize**（见 §2.6），所以 token 数在 `usage_details` 里是**真实值**，而在 metadata 里被 REDACTED（§3.2）。

`GenerationTrace` 的 `finish` 调用点 2 处：`query_engine.py:627`（agent turn，含 `error=generation_error`）与 `compact.py:426/437`（compaction）。

### 3.4 `ToolTrace`（`tracing.py:248-310`）

```python
@dataclass
class ToolTrace:
    parent: AgentTrace
    ref: Any
    started_at: float
    tool_call_id: str
    tool_name: str
    tool_args: dict[str, Any]
    risk_level: str
    requires_approval: bool = False
    approval_status: str = "not_required"
```

三个可变方法（**这是唯一的可变状态**，其余是 frozen dataclass）：

| 方法 | 行号 | 行为 |
|---|---|---|
| `with_approval_required()` | `260-267` | `requires_approval=True`；`approval_status="pending"`；并调 `client.update_trace(trace_ref, metadata={"permission_request_count": metrics.permission_request_count + 1})`——**在 trace 上直接写计数（预增量）**，返回 self |
| `set_approval_status(status)` | `269-271` | `requires_approval=True`；`approval_status=status`（**不调 SDK**） |
| `finish(result)` | `273-310` | 见下 |

`approval_status` 的取值集合（来自调用点，逐字）：
- `"not_required"`（初始，无审批）
- `"pending"`（`with_approval_required()`）
- `"executed"`（批准且执行成功，`query_engine.py:999/1049`）
- `"failed_after_approval"`（批准但执行失败，`query_engine.py:1010/1060`）
- `"denied"`（拒绝，`query_engine.py:1083`）
- `"timeout"`（超时，`query_engine.py:1100`）

`finish()` 细节（`tracing.py:273-310`）：

```python
elapsed_ms = int(result.meta.get("elapsed_ms") or int((time.time() - self.started_at) * 1000))
content = str(getattr(result, "content", ""))
result_preview = preview_tool_result(self.tool_name, self.tool_args, content)
metadata = {
    "tool_call_id": self.tool_call_id,
    "tool_name": self.tool_name,
    "status": "success" if result.ok else "error",       # ← 二值
    "error_type": result.error_code,
    "error_message": None if result.ok else result.content,
    "latency_ms": elapsed_ms,
    "risk_level": self.risk_level,
    "requires_approval": self.requires_approval,
    "approval_status": self.approval_status,
    "tool_result_hash": result_preview["hash"],
    "tool_result_truncated": result_preview["truncated"],
    "tool_result_original_length": result_preview["original_length"],
    "tool_result_redacted": result_preview.get("redacted", False),
    "data": sanitize_value(getattr(result, "data", None)),
}
self.parent.client.end_span(
    self.ref,
    output={"tool_result_preview": result_preview["preview"]},
    metadata=metadata,
    status_message=None if result.ok else str(result.error_code or result.content),
)
metric = ToolCallMetric(
    tool_name=self.tool_name, ok=bool(result.ok), error_code=result.error_code,
    requires_approval=self.requires_approval, approval_status=self.approval_status,
    risk_level=self.risk_level, elapsed_ms=elapsed_ms,
    command=str(self.tool_args.get("command", "")),
    exit_code=(result.data or {}).get("exit_code") if getattr(result, "data", None) else None,
)
self.parent.metrics = self.parent.metrics.with_tool_call(metric)
```

- `elapsed_ms` 优先取 `result.meta["elapsed_ms"]`（executor 覆盖过的值），否则自算。
- `command` 只从 `tool_args["command"]` 取（**仅 bash 有**），MCP 工具恒为空字符串 → `is_test_command` / `unsafe` 等判定对 MCP 工具无效。
- `exit_code` 从 `result.data["exit_code"]` 取（仅 bash 有，`bash_tool.py:135`）。
- `result_preview` 的 `path` 键（仅在敏感文件被命中时存在，`sanitize.py:158`）**不写进 metadata**——即敏感文件路径不会上传（只上传 `redacted=True`）。等等，实际检查：metadata 里没有 `path` 键，`result_preview` 的 `path` 被丢弃。**复刻时注意这一点是有意的隐私保护。**

`_start_tool_trace`（`query_engine.py:839-855`）——**risk_level 的来源**：

```python
risk_level = "medium"
if self._tool_registry is not None:
    try:
        risk_level = getattr(self._tool_registry.get(tool_name), "risk_level", "medium")
    except KeyError:
        risk_level = "medium"
```

默认 `"medium"`；`registry.get` 抛 `KeyError` 时也回落 `"medium"`。

### 3.5 `start_tool` 的调用时机

`_execute_tool`（`query_engine.py:865`）**第一行**就开 trace：

```python
tool_trace = self._start_tool_trace(tool_name, tool_input, tool_use_id)
```

即**无论**权限结果如何，每个 `tool_use` 都有一个 `tool.*` span（包括被拒绝的、超时的、工具系统未初始化的）。`tool_use_id` 直接用模型给的 `tu["id"]`（provider 生成的 id），不另生成。

### 3.6 层次结构图（含生命周期标注）

```text
时间轴 ─────────────────────────────────────────────────────────────────►

AgentTrace.start()                                                    AgentTrace.finish()
  │                                                                        │
  ├─ trace_ref = start_observation("flyinchat.user_task", as_type="agent")  │
  │     input = user_content                                                │
  │     metadata = {trace_id:"managed_by_langfuse", session_id, task_id,    │
  │                 agent_version, model_name, prompt_version:"default",    │
  │                 tool_version:"default", workspace, git_branch,          │
  │                 git_commit_before, agent_mode, permission_mode,         │
  │                 started_at, agent_env}                                  │
  │                                                                         │
  └─ span_ref = start_span("agent.loop")   ────────────────────────────────┤
        input = {"user_input": user_content}                               │
        metadata = （与 trace 同一 dict）                                   │
                                                                            │
        ┌── 每轮 agent loop ──────────────────────────────────┐            │
        │                                                      │            │
        │  start_generation(name="llm.agent_turn")  ──┐        │            │
        │      挂在 trace_ref 上（非 agent.loop 下）   │        │            │
        │      model / input / metadata /              │        │            │
        │      model_parameters                        │        │            │
        │      ... 流式返回 ...                         │        │            │
        │      generation.finish(output=[blocks],      │        │            │
        │          usage_info, input_tokens,           │        │            │
        │          output_tokens, error)  ◄────────────┘        │            │
        │                                                       │            │
        │  for each tool_use:                                   │            │
        │    start_tool(name=f"tool.{tool_name}")  ──┐          │            │
        │        挂在 trace_ref 上                   │          │            │
        │        input = sanitized_args             │          │            │
        │        ├─ [权限] with_approval_required() │          │            │
        │        │     → update_trace(permission_request_count) │            │
        │        ├─ [权限] set_approval_status(s)   │          │            │
        │        └─ tool_trace.finish(result)  ◄────┘          │            │
        │              → end_span(output={tool_result_preview}, │            │
        │                          metadata={...13 键...})      │            │
        └───────────────────────────────────────────────────────┘            │
                                                                            │
        （压缩时额外：start_generation("llm.compaction_summary")）          │
                                                                            │
  finish():                                                                 │
    ① end_span(span_ref, output=output_data, metadata=合并后的全部指标) ◄───┘
    ② for (name, value) in scores: score_trace(trace_ref, name, value)
    ③ update_trace(trace_ref, output=..., metadata=同上, status_message=error)
    ④ end_span(trace_ref)     ← 结束 root observation
    ⑤ flush()
```

### 3.7 复刻检查清单（tracing / 层次）

- [ ] trace 名 `"flyinchat.user_task"`，`as_type="agent"`。
- [ ] agent span 名 `"agent.loop"`，`as_type="span"`，input `{"user_input": ...}`，metadata 与 trace 相同。
- [ ] LLM generation 名 `"llm.agent_turn"` 与 `"llm.compaction_summary"`。
- [ ] tool span 名 `f"tool.{tool_name}"`。
- [ ] **所有 tool/generation span 直接挂在 trace 上（扁平，非嵌套）**。
- [ ] trace metadata 的 15 个键逐字，含 `"trace_id": "managed_by_langfuse"`。
- [ ] `agent_mode` 与 `permission_mode` 传同一个 `self.mode`。
- [ ] `workspace = paths.project_dir.parent`。
- [ ] finish 顺序：agent span → scores → trace update → trace end → flush。
- [ ] `finish_reason` 只有 `"error"` / `"stop"`。
- [ ] `approval_status` 六值集合。
- [ ] `tool.*` span 在权限判定**之前**创建（被拒也有 span）。
- [ ] 没有独立的 permission span。

---

## 4. `sanitize`：脱敏 / 截断 / hash

### 4.1 常量（`sanitize.py:10-13`）——**原样抄录**

```python
REDACTED = "[REDACTED]"
DEFAULT_PREVIEW_CHARS = 8_000
TEST_OUTPUT_PREVIEW_CHARS = 20_000
GIT_DIFF_PREVIEW_CHARS = 12_000
```

### 4.2 敏感 key（`sanitize.py:15-28`）

```python
_SENSITIVE_KEY_PARTS = (
    "password", "passwd", "secret", "token", "api_key", "apikey",
    "authorization", "cookie", "private_key", "access_key",
    "refresh_token", "client_secret",
)
```

匹配算法（`sanitize.py:64-66`）——**子串 + 大小写不敏感 + 连字符转下划线**：

```python
def is_sensitive_key(key: str) -> bool:
    normalized = key.lower().replace("-", "_")
    return any(part in normalized for part in _SENSITIVE_KEY_PARTS)
```

实测：`api_key`/`API-KEY`/`apikey`/`Authorization`/`cookie`/`private_key`/`access_key`/`refresh_token`/`client_secret`/`password`/`passwd`/`secret`/`token` → `True`；`safe_key`/`key`/`monkey`/`keywords` → `False`。

**重大副作用（必须复刻或显式修正）**：因为是子串匹配，**任何含 `token` 的键都会被 REDACTED**，实测：

```python
is_sensitive_key("total_tokens")  → True
is_sensitive_key("input_tokens")  → True
is_sensitive_key("tokens")        → True
sanitize_value({"total_tokens": 100, "model": "x", "output_tokens": 5})
# → {'total_tokens': '[REDACTED]', 'model': 'x', 'output_tokens': '[REDACTED]'}
```

结合 §3.2 的 `AgentRunMetrics.as_metadata()` → `AgentTrace.finish` 中 `metadata` 传给 `end_span` → `sanitize_value`。实测 end-span metadata 的实际结果：

```text
input_tokens: '[REDACTED]'
output_tokens: '[REDACTED]'
total_tokens: '[REDACTED]'
context_tokens_before: '[REDACTED]'
context_tokens_after: '[REDACTED]'
```

**因此 Langfuse trace metadata 里的 token 计数全部是不可见的 `[REDACTED]`。真实 token 数只在 generation 的 `usage_details` 里可见（那条路径不 sanitize，见 §2.6）。** 这是本实现最反直觉的行为，复刻时必须显式决定：照抄（一致）或加入白名单豁免（`input_tokens` / `output_tokens` / `total_tokens` / `max_tokens` / `context_tokens_*`）。

同样地 `sanitize_value({"max_tokens": 8192, ...})` → `'[REDACTED]'`（§3.2）。

### 4.3 敏感文件路径（`sanitize.py:30-39, 69-71`）

```python
_SENSITIVE_PATH_PATTERNS = (
    ".env", ".env.*", "*.pem", "*.key", "id_rsa", "id_ed25519",
    "credentials.json", "secrets.yaml",
)

def is_sensitive_path(path) -> bool:
    name = Path(str(path)).name                    # ← 只看 basename
    return any(fnmatch.fnmatch(name, pattern) for pattern in _SENSITIVE_PATH_PATTERNS)
```

- 用 `fnmatch` 通配；**只看文件名**（`src/.env` 与 `.env` 都命中；`myenv` 不命中）。
- 实测：`.env` ✓、`.env.local` ✓、`private.pem` ✓、`id_ed25519` ✓、`src/app.py` ✗。
- **注意 `*.key` 会命中 `my.key`**，但 `key` 本身不命中（无通配则精确匹配）。

### 4.4 `sanitize_value(value, *, parent_key="")`（`sanitize.py:101-120`）

```python
def sanitize_value(value: Any, *, parent_key: str = "") -> Any:
    if parent_key and is_sensitive_key(parent_key):
        return REDACTED                                  # ① key 敏感 → 整个值替换

    if isinstance(value, dict):
        return {str(key): sanitize_value(item, parent_key=str(key)) for key, item in value.items()}
    if isinstance(value, list):
        return [sanitize_value(item) for item in value]  # ② 注意：不传 parent_key
    if isinstance(value, tuple):
        return [sanitize_value(item) for item in value]  # ③ tuple → list
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, str):
        if _looks_like_env_content(value):
            return REDACTED                              # ④ 内容像 .env → 整体替换
        return value
    return value                                         # ⑤ int/float/bool/None 原样
```

要点：
- 只处理 `dict` / `list` / `tuple` / `Path` / `str`，其他类型原样返回（包括自定义对象、`AnyUrl`——注意这会让 `AnyUrl` 通过，Langfuse SDK 侧再处理；**不会**转成 str）。
- dict 的键被 `str()` 强转（`{1: 'x'}` → `{'1': 'x'}`）。
- **list 内部的 dict 元素不继承父 key**（`sanitize_value(item)` 无 `parent_key`）——这是正确的（list 元素无键名）。
- `tuple` → `list`（**类型改变**，注意与 JSON 兼容）。

### 4.5 `_looks_like_env_content`（`sanitize.py:183-196`）

```python
def _looks_like_env_content(value: str) -> bool:
    if len(value) > 20_000:
        return False                                  # ① 超长直接放弃检测
    lines = [l.strip() for l in value.splitlines() if l.strip() and not l.strip().startswith("#")]
    if len(lines) < 2:
        return False                                  # ② 有效行 < 2
    assignments = 0
    for line in lines[:20]:                           # ③ 只看前 20 行
        if "=" not in line: continue
        key = line.split("=", 1)[0].strip()
        if key and key.replace("_", "").replace("-", "").isalnum():
            assignments += 1
    return assignments >= 2 and any(
        is_sensitive_key(line.split("=", 1)[0]) for line in lines if "=" in line
    )
```

判定条件：**≥2 个 `KEY=VALUE` 形式的赋值行（键为字母数字+下划线+连字符）且至少一个键是敏感 key**。
实测：
- `"ANTHROPIC_API_KEY=abc\nLANGFUSE_SECRET_KEY=def\n# comment\nOTHER=1"` → `REDACTED`
- `"a=b\nc=d\ne=f"` → 原样（无敏感 key）
- 超长字符串（>20_000）→ 原样

**注意**：这个检测只在**字符串值**上触发。所以一个 `bash` 命令的输出如果形似 .env，会整体变成 `[REDACTED]`（此时 `preview_tool_result` 的 hash/original_length 仍基于原文计算）。

### 4.6 `preview_text` / `TextPreview`（`sanitize.py:42-98`）

```python
@dataclass(frozen=True)
class TextPreview:
    preview: str
    hash: str
    truncated: bool
    original_length: int
    redacted: bool = False

    def as_dict(self) -> dict[str, Any]:
        return {"preview": ..., "hash": ..., "truncated": ...,
                "original_length": ..., "redacted": ...}
```

`preview_text(text, *, max_chars=DEFAULT_PREVIEW_CHARS, redacted=False)`：

- **`redacted=True` 时**：`preview=REDACTED`、`hash=sha256(原文)`、`truncated=False`、`original_length=len(原文)`、`redacted=True`。
- 否则：`truncated = len(text) > max_chars`；`preview = text[:max_chars]`；若截断则追加：

```python
preview = f"{preview}\n... [truncated {len(text) - max_chars} chars]"
```

  即截断后缀逐字为 `\n... [truncated N chars]`（N = 被丢弃的字符数）。所以 `preview` 的最终长度是 `max_chars + len(后缀)`（不是精确 max_chars）。

`sha256_text`（`sanitize.py:60-61`）：

```python
return hashlib.sha256(text.encode("utf-8", errors="replace")).hexdigest()
```

64 位小写十六进制；编码失败用 `errors="replace"`（不抛）。

### 4.7 截断阈值选择 `_preview_limit_for_tool`（`sanitize.py:165-172`）

```python
def _preview_limit_for_tool(tool_name: str, tool_args: dict) -> int:
    if tool_name == "bash":
        command = str(tool_args.get("command", "")).lower()
        if "pytest" in command or "test" in command:
            return TEST_OUTPUT_PREVIEW_CHARS       # 20_000
        if command.startswith("git diff"):
            return GIT_DIFF_PREVIEW_CHARS          # 12_000
    return DEFAULT_PREVIEW_CHARS                   # 8_000
```

- **仅对 `tool_name == "bash"` 生效**。
- 判定顺序：先 test（`"pytest" in cmd or "test" in cmd`——**注意 `"test"` 是子串，`"latest"`、`"contest"` 都会命中 20k 分支**），再 `startswith("git diff")`，最后默认 8k。
- 实测：`pytest -q` + 25000 字符 → `truncated=True`；`git diff` + 20000 字符 → preview 长度 12027（12000 + 后缀）、`truncated=True`。
- **MCP 工具名不是 `"bash"`**，所以 MCP 结果恒为 8_000 阈值。

### 4.8 `preview_tool_result`（`sanitize.py:145-162`）——**敏感文件优先**

```python
path = _extract_path(tool_args)                    # 依次找 "path"、"file_path"
if path and is_sensitive_path(path):
    return {
        "preview": "[REDACTED sensitive file content]",
        "hash": sha256_text(str(content)),
        "truncated": False,
        "original_length": len(str(content)),
        "redacted": True,
        "path": str(path),                         # ← 只在 redacted 分支有 path 键
    }
max_chars = _preview_limit_for_tool(tool_name, tool_args)
return preview_text(str(content), max_chars=max_chars).as_dict()
```

- 敏感文件命中时 preview 逐字为 `"[REDACTED sensitive file content]"`，**并额外带 `path` 键**（非 redacted 路径没有该键，故调用方用 `result_preview.get("redacted", False)` 安全取值）。
- `_extract_path`（`sanitize.py:175-180`）只查 `"path"` 与 `"file_path"` 两个键（**不含 `"filePath"`**）。
- 内容 hash 仍基于原文（可用于「内容是否变过」的比对），但内容不上传。
- 对应测试 `test_sensitive_file_tool_result_is_redacted`：`preview_tool_result("file_read", {"path": ".env"}, "LANGFUSE_SECRET_KEY=sk\n")` → `redacted=True`，`path == ".env"`，preview 里不含 `"SECRET"`。

### 4.9 `sanitize_messages`（`sanitize.py:123-135`）

```python
raw = json.dumps(messages, ensure_ascii=False, default=str)
sanitized = sanitize_value(messages)
sanitized_raw = json.dumps(sanitized, ensure_ascii=False, default=str)
preview = preview_text(sanitized_raw)
return {
    "messages": sanitized,
    "preview": preview.preview,
    "hash": sha256_text(raw),                 # ← 原始（未脱敏）JSON 的 hash
    "sanitized_hash": preview.hash,           # ← 脱敏后 JSON 的 hash
    "truncated": preview.truncated,
    "original_length": preview.original_length,
}
```

- **`hash` 基于原始 messages**（含密钥），`sanitized_hash` 基于脱敏后。两者都是 sha256，**不可逆，所以上传 hash 不泄漏密钥**。
- `json.dumps` 用 `ensure_ascii=False, default=str`（`default=str` 兜底不可序列化对象）。
- `preview` 的 `max_chars` 用**默认 8000**（LLM 输入没有专用阈值）。
- 实测（`messages` 含 `api_key: "x"*100`）：`original_length=110`，`truncated=False`，两个 hash 不同。

### 4.10 `sanitize_tool_args`（`sanitize.py:138-142`）

```python
sanitized = sanitize_value(tool_args)
if not isinstance(sanitized, dict):
    return {}
return sanitized
```

非 dict（理论上不会）→ 空 dict。

### 4.11 复刻检查清单（sanitize）

- [ ] 4 个常量：`[REDACTED]` / 8000 / 20000 / 12000。
- [ ] 12 个敏感 key 片段，子串匹配，`-`→`_`，小写。
- [ ] 8 个敏感路径 pattern，`fnmatch` 只匹配 basename。
- [ ] `sanitize_value` 递归 dict/list/tuple/Path/str；tuple→list；键 `str()` 强转。
- [ ] `_looks_like_env_content`：>20000 放弃、<2 行放弃、前 20 行、≥2 赋值且 ≥1 敏感 key。
- [ ] `preview_text` 截断后缀 `\n... [truncated N chars]`。
- [ ] `_preview_limit_for_tool` 只对 `tool_name == "bash"`；`"test"` 子串优先于 `"git diff"` 前缀。
- [ ] 敏感文件 preview 字面量 `"[REDACTED sensitive file content]"` + 额外 `path` 键。
- [ ] `sanitize_messages` 返回 6 键，`hash` 用原文、`sanitized_hash` 用脱敏文。
- [ ] 知道 token 类键会被 REDACTED（或显式豁免）。

---

## 5. `metrics`：指标定义与计算

### 5.1 `ToolCallMetric`（`metrics.py:29-69`）

frozen dataclass，字段：

| 字段 | 默认 | 来源 |
|---|---|---|
| `tool_name` | 必填 | |
| `ok` | 必填 | `result.ok` |
| `error_code` | `None` | `result.error_code` |
| `requires_approval` | `False` | `ToolTrace.requires_approval` |
| `approval_status` | `"not_required"` | |
| `risk_level` | `"medium"` | registry 查出 |
| `elapsed_ms` | `0` | |
| `command` | `""` | `str(tool_args.get("command", ""))` |
| `exit_code` | `None` | `result.data["exit_code"]`（仅 bash） |

派生属性（7 个）：

```python
_GROUNDING_ERROR_CODES = {
    "TOOL_NOT_FOUND", "INVALID_INPUT", "FILE_NOT_FOUND", "STRING_NOT_FOUND",
    "AMBIGUOUS_MATCH", "FILE_NOT_READ", "PERMISSION_DENIED", "SKILL_GUARD_DENIED",
}

_DANGEROUS_COMMAND_PATTERNS = (
    "rm -rf /", "rm -rf ~", "sudo ", "su ", "mkfs", "dd if=", "/etc/shadow", "~/.ssh",
)
```

| 属性 | 行号 | 定义 |
|---|---|---|
| `grounding_ok` | 41-43 | `error_code not in _GROUNDING_ERROR_CODES` |
| `tool_choice_ok` | 45-47 | `error_code not in {"TOOL_NOT_FOUND", "INVALID_INPUT"}` |
| `unsafe` | 49-54 | `(approval_status in {"denied","timeout"} and risk_level == "high")` **或** `any(p in command.lower() for p in _DANGEROUS_COMMAND_PATTERNS)` |
| `is_test_command` | 56-59 | `"pytest" in cmd or " test" in cmd or cmd.endswith("test")` |
| `is_lint_command` | 61-64 | `"ruff" in cmd or "flake8" in cmd or "pylint" in cmd` |
| `is_typecheck_command` | 66-69 | `"mypy" in cmd or "pyright" in cmd or "tsc" in cmd` |

要点：
- **`grounding_ok` 的语义是「不是那 8 类错误码」**。注意 `error_code=None`（成功）也 `not in` 集合 → `True`。
- `is_test_command` 的 `" test"` 带前导空格（匹配 `"npm test"`、`"go test"`），`endswith("test")` 匹配 `"pytest"` 结尾。
- 所有 `command` 判定对小写后字符串做子串匹配。**MCP 工具的 `command` 恒为 `""`** → 四个属性中 `is_test/lint/typecheck` 全 `False`，`unsafe` 只可能由「high risk + denied/timeout」触发。

### 5.2 `AgentRunMetrics`（`metrics.py:72-178`）

frozen dataclass，**18 个字段 + 1 个 `tool_calls` 元组**：

| 字段 | 默认 | 更新方法 |
|---|---|---|
| `llm_call_count` | `0` | `with_llm_call` (+1) |
| `tool_call_count` | `0` | `with_tool_call` (+1) |
| `agent_loop_iterations` | `0` | `with_llm_call` (+1) |
| `input_tokens` | `0` | `with_llm_call`（**覆盖**，见下） |
| `output_tokens` | `0` | `with_llm_call`（累加） |
| `total_llm_latency_ms` | `0` | `with_llm_call`（累加） |
| `total_tool_latency_ms` | `0` | `with_tool_call`（累加） |
| `permission_request_count` | `0` | `with_tool_call`（+`int(metric.requires_approval)`） |
| `permission_denied_count` | `0` | `with_tool_call`（+`int(approval_status in {"denied","timeout"})`） |
| `unsafe_action_count` | `0` | `with_tool_call`（+`int(metric.unsafe)`） |
| `rule_violation_count` | `0` | **没有任何写入点**（恒 0） |
| `compact_triggered` | `False` | `with_compaction` |
| `context_tokens_before` | `0` | `with_compaction` |
| `context_tokens_after` | `0` | `with_compaction` |
| `tests_run` | `False` | `with_tool_call`（or 累积） |
| `tests_pass` | `None` | `with_tool_call` |
| `test_command` | `""` | `with_tool_call` |
| `test_exit_code` | `None` | `with_tool_call` |
| `lint_pass` | `None` | `with_tool_call` |
| `typecheck_pass` | `None` | `with_tool_call` |
| `tool_calls` | `()` | `with_tool_call`（追加） |

派生：`total_steps = llm_call_count + tool_call_count`（`metrics.py:96-98`）。

**不可变累积**：每个 `with_*` 用 `dataclasses.replace` 返回**新实例**；`AgentTrace.metrics` 被整体替换（`tracing.py:241/310`）。这是 `rules/common/coding-style.md` 的 immutability 原则的体现。

`with_llm_call`（`metrics.py:100-108`）：

```python
return replace(self,
    llm_call_count=self.llm_call_count + 1,
    agent_loop_iterations=self.agent_loop_iterations + 1,
    input_tokens=input_tokens,                          # ← 覆盖！bug
    output_tokens=self.output_tokens + output_tokens,   # ← 累加
    total_llm_latency_ms=self.total_llm_latency_ms + latency_ms,
)
```

**实测**：两次 `with_llm_call(100, 10, 1)` 与 `(200, 20, 1)` → `llm_call_count=2`、`input_tokens=200`（**最后一次的值，不是 300**）、`output_tokens=30`。
**后果**：`as_metadata()["input_tokens"]` 是最后一次 LLM 调用的输入 token（这实际上与 `query_engine.py:604-608` 里 `total_input_tokens = usage_info.get("input_tokens", 0)` 的**覆盖语义一致**——那里也是覆盖而非累加）。复刻时照抄以保持一致。

`with_tool_call`（`metrics.py:110-144`）的**条件更新逻辑**：

```python
permission_request_count = self.permission_request_count + int(metric.requires_approval)
permission_denied_count  = self.permission_denied_count + int(metric.approval_status in {"denied","timeout"})
unsafe_action_count      = self.unsafe_action_count + int(metric.unsafe)
tests_run = self.tests_run or metric.is_test_command

if metric.is_test_command:
    tests_pass = metric.ok            # ← 覆盖（最后一个 test 命令的结果）
    test_command = metric.command
    test_exit_code = metric.exit_code
if metric.is_lint_command:       lint_pass = metric.ok
if metric.is_typecheck_command:  typecheck_pass = metric.ok
```

- 三个 `*_pass` 都是**最后一次该类型命令的结果覆盖**。
- `tests_run` 是 OR 累积（一旦跑过测试就永远 True）。
- 注意 `permission_request_count` 在 `with_tool_call` 里**又加了一次**，而 `ToolTrace.with_approval_required()`（`tracing.py:263-266`）也往 trace metadata 里写了一个**预增量**的计数。两者是**不同通道**：前者进 metrics（最终 `as_metadata`），后者直接写 Langfuse trace metadata（`update_trace`）。**所以在 Langfuse trace 上会看到 `permission_request_count` 被 `update_trace` 写了一次预增量、又被 `finish()` 的 metadata 覆盖成 metrics 的值。**

`with_compaction`（`metrics.py:146-152`）：`compact_triggered=True`、记录 before/after。

`as_metadata()`（`metrics.py:154-178`）——**21 个键**（逐字，顺序固定）：

```text
llm_call_count, tool_call_count, agent_loop_iterations, total_steps,
input_tokens, output_tokens, total_tokens,
llm_latency_ms, tool_latency_ms,
permission_request_count, permission_denied_count, unsafe_action_count, rule_violation_count,
compact_triggered, context_tokens_before, context_tokens_after,
tests_run, tests_pass, test_command, test_exit_code, lint_pass, typecheck_pass
```

（原始字段名是 `total_llm_latency_ms` / `total_tool_latency_ms`，输出时**改名为** `llm_latency_ms` / `tool_latency_ms`。`total_tokens = input_tokens + output_tokens` 是派生键。）

### 5.3 `tool_calls` 元组

**只在内存中累积，不上传 Langfuse**——`as_metadata()` 不包含 `tool_calls`。它只被 `build_scores` 用于计算 `grounding_accuracy` / `tool_call_accuracy`。

### 5.4 复刻检查清单（metrics）

- [ ] 8 个 grounding error code 集合逐字。
- [ ] 8 个危险命令 pattern 逐字（注意 `"sudo "` / `"su "` 带尾空格）。
- [ ] `unsafe` 的双条件（权限被拒的 high risk **或** 危险命令）。
- [ ] `is_test_command` 的 `" test"` 带前导空格 + `endswith("test")`。
- [ ] `with_llm_call` 的 `input_tokens` 是**覆盖**语义。
- [ ] `with_tool_call` 的 `*_pass` 覆盖、`tests_run` OR。
- [ ] `rule_violation_count` 恒 0。
- [ ] `as_metadata` 的 21 个键名逐字（含改名）。
- [ ] `tool_calls` 不上传。

---

## 6. `scoring`：评分逻辑与阈值

### 6.1 `build_scores`（`scoring.py:17-52`）

**8 个 scores + 5 个 failure metadata**。

```python
task_success       = 1.0 if result.status == "completed" and result.last_tool_error is None else 0.0
grounding_accuracy = _ratio(Σ grounding_ok, tool_call_count, default=1.0)
tool_call_accuracy = _ratio(Σ tool_choice_ok, tool_call_count, default=1.0)
rule_compliance    = 0.0 if (rule_violation_count or unsafe_action_count) else 1.0
progress_rate      = _progress_rate(result, metrics)
decision_accuracy  = 1.0 if result.status in {"completed", "cancelled", "error", "max_rounds"} else 0.0
task_latency_ms    = float(task_latency_ms)
total_steps        = float(metrics.total_steps)
```

**阈值/边界**：
- `task_success`：**双条件**——status 必须 `"completed"` **且** `last_tool_error is None`。任何未恢复的工具错误都会让它为 0。
- `grounding_accuracy` / `tool_call_accuracy`：分母为 0 时返回 **`1.0`**（不是 0）——即「没调工具 = 完全准确」。
- `rule_compliance`：**二值 0.0 / 1.0**（不是比例）。任一 `rule_violation_count` 或 `unsafe_action_count` 非 0 → 0.0。因 `rule_violation_count` 恒 0，实际只由 `unsafe_action_count` 决定。
- `decision_accuracy`：**只要 status 是四个合法值之一就 1.0**——而 `TurnResult.status` 的取值域就是 `{"completed","error","cancelled","max_rounds"}`（`models.py:61` 注释），所以**这个 score 恒为 1.0**。这是**无效指标**（与设计文档 §3.5 的意图不符）。复刻时照抄或标注。
- `task_latency_ms` / `total_steps` 作为 score 上传（不是 0-1 区间，是原始值）。

`_ratio`（`scoring.py:135-138`）：

```python
def _ratio(numerator: int, denominator: int, *, default: float) -> float:
    if denominator == 0:
        return default
    return numerator / denominator
```

### 6.2 `_progress_rate`（`scoring.py:119-132`）——**固定 8 步权重**

```python
completed = 1                    # 理解用户请求（进入 QueryEngine 即得）
total = 8
if metrics.llm_call_count:   completed += 2     # 组装 prompt + 模型决策
if metrics.tool_call_count:  completed += 2     # 选择并执行工具
if metrics.tests_run:        completed += 1
if result.final_text:        completed += 1
if result.status == "completed": completed += 1
return min(1.0, completed / total)
```

**这是手写的启发式，不是文档 §3.2 描述的 8 个语义子目标。** 实测取值：

| 场景 | progress_rate |
|---|---|
| 无 LLM、无工具、无 final_text、status=error | `1/8 = 0.125` |
| + 有 LLM 调用 | `3/8 = 0.375` |
| + 有工具调用 | `5/8 = 0.625` |
| + 有 final_text | `6/8 = 0.75` |
| + status=completed（且有 tests_run） | `8/8 = 1.0` |

注意 `completed` 最多 `1+2+2+1+1+1 = 8`，`min(1.0, ...)` 是防御性写法（无实际作用）。

### 6.3 `classify_failure`（`scoring.py:55-116`）——**判定顺序不可换**

返回 5 键 dict：`failure_stage` / `failure_reason` / `root_cause` / `recoverable` / `suggested_fix`。

按顺序（**首个命中即返回**）：

| # | 条件 | failure_stage | failure_reason | root_cause | recoverable | suggested_fix 字面量 |
|---|---|---|---|---|---|---|
| 1 | `status=="completed" and last_tool_error is None` | `"none"` | `"none"` | `"none"` | `False` | `"none"` |
| 2 | `status == "cancelled"` | `"user_interaction"` | `"cancelled"` | `"User cancelled the task"` | `True` | `"Resume or resubmit the task if needed"` |
| 3 | `metrics.permission_denied_count`（非 0） | `"permission_error"` | `"permission_denied"` | `"A required tool permission was denied or timed out"` | `True` | `"Approve the required safe action or choose a lower-risk alternative"` |
| 4 | `result.last_tool_error`（非 None/空） | `"tool_execution_error"` | `result.last_tool_error` | `"The latest tool call failed and was not recovered before the turn ended"` | `True` | `"Inspect the tool error and retry with corrected arguments or an alternate tool"` |
| 5 | `status == "max_rounds"` | `"timeout"` | `result.terminal_reason or "max_rounds"` | `"The agent reached its configured turn budget"` | `True` | `"Increase max turns or split the task into smaller steps"` |
| 6 | `result.error`（非空） | `"environment_error"` | `result.error` | `result.error` | `True` | `"Check model/API/tool environment and retry"` |
| 7 | 兜底 | `"unknown"` | `result.status` | `"The task did not complete successfully"` | `True` | `"Review trace events and retry with more context"` |

**关键优先级**：「权限被拒」**优先于**「工具错误」。所以一个因权限被拒而结束的任务，`failure_stage` 是 `permission_error`（即使 `last_tool_error` 也有值）。
设计文档 §3.9 列出 13 个枚举值（`intent_understanding_error` / `planning_error` / …），实际只用其中 4 个（`permission_error` / `tool_execution_error` / `environment_error` / `timeout`）+ 3 个非文档值（`none` / `user_interaction` / `unknown`）。**这是必须记录的偏差。**

对应测试 `test_permission_denied_classifies_permission_error`：`ToolCallMetric(ok=False, error_code="PERMISSION_DENIED", requires_approval=True, approval_status="denied", risk_level="high")` + `TurnResult(status="error", error="denied")` → `failure_stage == "permission_error"` 且 `rule_compliance == 0.0`（因为 `unsafe_action_count` 被 `unsafe` 属性（high + denied）置 1）。

### 6.4 scores 写入 Langfuse

`AgentTrace.finish`（`tracing.py:193-195`）：

```python
for name, value in scores.scores.items():
    self.client.score_trace(self.trace_ref, name=name, value=value)
```

- `comment` 用默认 `""` → SDK 侧 `comment or None` → `None`。
- 8 个 score **全部用同一个 trace_ref**。
- `scores.metadata` 的 5 个 failure 键被**合并进 metadata**（不是 score）——所以 `failure_stage` / `failure_reason` / `root_cause` / `recoverable` / `suggested_fix` 出现在 trace/span metadata 中（但 `failure_stage` / `failure_reason` 设计文档要求作为 score，实际是 metadata）。**这是偏差，需记录。**

### 6.5 复刻检查清单（scoring）

- [ ] `task_success` 的双条件（completed + 无 last_tool_error）。
- [ ] `_ratio` 默认值 `1.0`（分母 0 时）。
- [ ] `rule_compliance` 二值。
- [ ] `decision_accuracy` 恒 1.0（无效指标）。
- [ ] `_progress_rate` 的 1+2+2+1+1+1 / 8 权重。
- [ ] `classify_failure` 的 7 级顺序（权限优先于工具错误）。
- [ ] 7 组 `failure_stage` 值与对应 `suggested_fix` 字面量。
- [ ] 8 个 score 名逐字；failure 5 键走 metadata。

---

## 7. `git_metadata`：采集与容错

### 7.1 两个 dataclass

`GitMetadata`（`git_metadata.py:10-13`）：`branch: str = "unknown"`、`commit: str = "unknown"`。

`GitDiffSummary`（`git_metadata.py:16-33`）：`files_changed: int = 0`、`lines_added: int = 0`、`lines_deleted: int = 0`、`git_diff_hash: str = ""`、`git_diff_summary: str = ""`、`unexpected_files_changed: int = 0`。
`as_dict()` 输出 6 键（**顺序**：files_changed / lines_added / lines_deleted / git_diff_hash / git_diff_summary / unexpected_files_changed）。

**`unexpected_files_changed` 恒为 0**——没有任何计算逻辑（与设计文档 §4.1 不符，未实现）。

### 7.2 `collect_git_metadata(workspace)`（`git_metadata.py:36-40`）

```python
GitMetadata(
    branch=_run_git(workspace, "rev-parse", "--abbrev-ref", "HEAD") or "unknown",
    commit=_run_git(workspace, "rev-parse", "HEAD") or "unknown",
)
```

2 个子进程调用。**在 `AgentTrace.start()` 同步执行**（`tracing.py:44`），即每次用户提交都跑 2 个 git 命令——可观测性带来的**同步阻塞**。

### 7.3 `collect_git_diff_summary(workspace)`（`git_metadata.py:43-68`）

3 个子进程：

```python
stat    = _run_git(workspace, "diff", "--stat") or ""
numstat = _run_git(workspace, "diff", "--numstat") or ""
diff    = _run_git(workspace, "diff", "--no-ext-diff") or ""
```

解析 `--numstat`（tab 分隔）：每行 ≥3 段时 `files_changed += 1`，第 1 段是 added，第 2 段是 deleted，**仅当 `str.isdigit()` 时才累加**（二进制文件会输出 `-\t-\tfile`，被跳过行数但仍计文件数）。

返回：

```python
files_changed       = 计数
lines_added         = Σ added（isdigit 才加）
lines_deleted       = Σ deleted（isdigit 才加）
git_diff_hash       = sha256_text(diff) if diff else ""
git_diff_summary    = stat[:12_000]                # ← 硬编码 12_000，与 sanitize.GIT_DIFF_PREVIEW_CHARS 独立
unexpected_files_changed = 0                        # ← 恒 0
```

**注意**：`git diff` 不带 `HEAD`，所以**只反映工作区相对 index 的未暂存改动**——已 `git add` 的改动不计入。这是采集口径的重要事实。

### 7.4 `_run_git`（`git_metadata.py:71-85`）——**全容错**

```python
try:
    result = subprocess.run(
        ["git", *args], cwd=str(workspace),
        capture_output=True, text=True, timeout=2, check=False,
    )
except Exception:
    return None                          # ← 任何异常（含 TimeoutExpired、FileNotFoundError）
if result.returncode != 0:
    return None                          # ← 非 0 退出（非 git 仓库、无 HEAD 等）
return result.stdout.strip()
```

- **超时硬编码 2 秒**；`check=False` 不抛。
- 所有失败 → `None` → 上层 `or "unknown"` / `or ""` 兜底。
- **无日志**（静默）。
- 非 git 仓库：`rev-parse` 返回非 0 → `branch`/`commit` 都是 `"unknown"`，diff 全 0/空。**可观测性不因此失败。**
- `cwd=str(workspace)`——`workspace` 是 `paths.project_dir.parent`（§3.2），即 cwd。

### 7.5 调用点

| 函数 | 调用点 | 时机 |
|---|---|---|
| `collect_git_metadata` | `tracing.py:44`（`AgentTrace.start`） | 每次用户任务开始（2 个 git 子进程） |
| `collect_git_diff_summary` | `tracing.py:166`（`AgentTrace.finish`） | 每次用户任务结束（3 个 git 子进程） |

**总计每个用户任务 5 次同步 `git` 子进程调用的开销**（可观测性开启时；关闭时是 Noop 但 `AgentTrace.start` **仍然调用** `collect_git_metadata`——见 §8.1 的不变量说明）。

### 7.6 复刻检查清单（git_metadata）

- [ ] `_run_git` 超时 2 秒、`check=False`、全异常 → None、无日志。
- [ ] `rev-parse --abbrev-ref HEAD` 取 branch，`rev-parse HEAD` 取 commit。
- [ ] diff 用 `git diff`（**不带 HEAD**）、`--stat`、`--numstat`、`--no-ext-diff`。
- [ ] `--numstat` 解析用 `isdigit()` 过滤二进制。
- [ ] `git_diff_summary` 截断 12_000（独立常量）。
- [ ] `unexpected_files_changed` 恒 0。
- [ ] 默认值 `"unknown"` / `0` / `""`。

---

## 8. 与 QueryEngine / tools 的埋点接口（精确到函数名）

### 8.1 埋点全表

| # | 埋点位置（文件:行号） | 调用 | 说明 |
|---|---|---|---|
| 1 | `app.py:348-357` `FlyinChatApp._init_observability()` | `create_observability_client(config_path=self.paths.config_path)` | `compose()` 中调用（`app.py:320`）；若构造时注入了 client 则跳过 |
| 2 | `app.py:1696-1712` `_run_compact()`（`/compact` 命令） | `AgentTrace.start(self._observability_client, turn_id=f"compact_{conv[:8]}", user_input="/compact", ...)` | **手动压缩也建一个独立 trace**，turn_id 形如 `compact_ab12cd34` |
| 3 | `app.py:1717` | `CompactionEngine(..., _observability=trace)` | 把 trace 交给压缩引擎 |
| 4 | `app.py:1728-1735` | `trace.mark_compaction(...)` + `trace.finish(TurnResult(status="completed", final_text=f"compact applied={result.applied} strategy={result.strategy}"), task_latency_ms=...)` | |
| 5 | `query_engine.py:123-132` `QueryEngine.submit_message()` | `AgentTrace.start(self.config.observability_client, ...)` | **每个用户 turn 一个 trace**；`config` 不传（`None`） |
| 6 | `query_engine.py:133` | `self._active_trace = trace` | 供后续 `_start_tool_trace` 使用 |
| 7 | `query_engine.py:147` | `trace.finish(result, task_latency_ms=elapsed_ms)`（无模型分支） | |
| 8 | `query_engine.py:152` | `trace.update_model(model)` | 拿到 primary model 后更新 trace metadata |
| 9 | `query_engine.py:168` | `trace.finish(result, task_latency_ms=elapsed_ms)`（异常分支） | |
| 10 | `query_engine.py:173-174` | `trace.finish(...)` + `self._active_trace = None` | 正常结束 |
| 11 | `query_engine.py:242` `_run_turn` | `CompactionEngine(..., _observability=self._active_trace)` | 预检压缩 |
| 12 | `query_engine.py:258-262` | `self._active_trace.mark_compaction(tokens_before, tokens_after)` | 预检压缩生效时 |
| 13 | `query_engine.py:459-466` | `self._active_trace.start_generation(name="llm.agent_turn", channel=channel, model=model, messages=api_messages, tools_count=len(tools_for_call or []))` | **每次 LLM 调用** |
| 14 | `query_engine.py:557` `_run_turn` 异常路径 | `CompactionEngine(..., _observability=self._active_trace)` | 反应式压缩 |
| 15 | `query_engine.py:565-569` | `self._active_trace.mark_compaction(...)` | 反应式压缩生效时 |
| 16 | `query_engine.py:627-636` | `generation.finish(output=..., usage_info=usage_info, input_tokens=total_input_tokens, output_tokens=..., error=generation_error)` | `finally` 块中，**保证异常时也 finish** |
| 17 | `query_engine.py:839-855` `_start_tool_trace()` | `self._active_trace.start_tool(tool_call_id=..., tool_name=..., tool_args=..., risk_level=...)` | |
| 18 | `query_engine.py:865-869` `_execute_tool()` | `tool_trace.finish(ToolResult(ok=False, error_code="TOOL_NOT_INITIALIZED"))` | 工具系统未初始化分支 |
| 19 | `query_engine.py:900-902` | `tool_trace.with_approval_required()` | `error_code == PERMISSION_REQUIRED` 时 |
| 20 | `query_engine.py:998-999` / `1048-1049` | `tool_trace.set_approval_status("executed")` | approve / always_approve 且执行成功 |
| 21 | `query_engine.py:1009-1010` / `1059-1060` | `tool_trace.set_approval_status("failed_after_approval")` | 批准但执行失败 |
| 22 | `query_engine.py:1082-1083` | `tool_trace.set_approval_status("denied")` | 用户拒绝 |
| 23 | `query_engine.py:1099-1100` | `tool_trace.set_approval_status("timeout")` | 权限超时 |
| 24 | `query_engine.py:1165-1166` `_persist_tool_result()` | `tool_trace.finish(result)` | **所有工具路径的唯一出口**（含 user_input 分支） |
| 25 | `compact.py:406-413` `CompactionEngine._summarize` | `self._observability.start_generation(name="llm.compaction_summary", channel, model, messages=summary_messages, tools_count=0, max_tokens=2048)` | 压缩摘要 LLM 调用 |
| 26 | `compact.py:418-426` | `generation.finish(output="", usage_info={}, input_tokens=<estimate>, output_tokens=0, error=str(exc))` | 摘要调用异常 |
| 27 | `compact.py:427-437` | `generation.finish(output=summary, usage_info={}, input_tokens=<estimate_api_messages>, output_tokens=<estimate(summary)>)` | 摘要成功 |
| 28 | `app.py:364-368` `action_quit()` | `self._observability_client.shutdown()` | 退出时 |
| 29 | `app.py:890-907` `_toggle_langfuse()` | `set_app_setting(config_path, "langfuse_enabled", new_value)` → `ObservabilityConfig.from_config_store(...)` → `create_observability_client(new_config)` → `self._query_engine = None` | `/langfuse` 命令；**重建 client 并丢弃 QueryEngine**（下次 `_ensure_query_engine` 重建以拿到新 client） |
| 30 | `app.py:2304-2305` `_render_status_bar()` | `TKey.STATUS_LANGFUSE_ON/OFF` 依据 `self._observability_client.enabled` | 状态栏 `Langfuse: ON` / `Langfuse: OFF` |

### 8.2 未埋点的位置（与设计文档的差距）

- **sub-agent 内部不建 trace/span**：`subagents/executor.py` 全文无 observability 引用。子 agent 的 LLM 调用与工具调用**完全不可观测**（父 trace 里只看到一个 `tool.sub_agent` span）。
- **权限事件不建独立 span**：只有 tool span 的 metadata 字段。
- **`TurnEvent` 流不写 Langfuse**：TUI 的 think/text/tool_use/tool_result 事件流与可观测性完全解耦。
- **用户追问（`_handle_user_input_required`）不建 span**（`query_engine.py:1104-1144`）。
- **skills 不埋点**。
- **MCP 连接事件不埋点**（设计文档 §10.2 的 `mcp.connection_state` 未实现）。

### 8.3 关键不变量与易错点

**可观测性侧**：

1. **绝不阻塞/失败主流程**。三层防线：`create_observability_client` 的 try/except → Noop；`_safe_call` 逐调用捕获；所有 `ref is None` 早退。**但有两个例外**：
   - `collect_git_metadata` / `collect_git_diff_summary` 是**同步 subprocess**（5 次/任务，各 2s 超时上限 → 最坏 10 秒同步阻塞），且**在 Noop client 下也照样执行**（`AgentTrace.start` 第一行就调 `collect_git_metadata`，不看 `client.enabled`）。**这是真实的性能/健壮性缺口。**
   - `AgentTrace.finish` 的 `collect_git_diff_summary` 同理。
2. **`AgentTrace` 在 `observability_client=None` 时也创建**（`AgentTrace.start` 里 `client = client or NoopObservabilityClient()`）。所以 metrics 累积、git 采集、scoring 在关闭 Langfuse 时**依然全跑**，只是不上传。这是有意的（本地 metrics 可用），但要意识到开销。
3. **token 类键被 REDACTED**（`input_tokens` / `output_tokens` / `total_tokens` / `max_tokens` / `context_tokens_before` / `context_tokens_after`）。真实值只在 generation 的 `usage_details` 里。
4. **`tool_calls` 元组不上传**，只用于算分。
5. **`decision_accuracy` 恒 1.0**；`rule_violation_count` 恒 0；`unexpected_files_changed` 恒 0；`has_credentials` 未被使用；`AgentTrace.started_at` 未被读取；`_raw_schema` 未被读取；`user_id` 恒 None。
6. **`AgentTrace.start` 的 `config` 参数在主链路中不传（None）**——所以 `agent_env` 恒 `"development"`，`agent_version` 走 git commit 分支。
7. **`/langfuse` 切换会丢弃 `self._query_engine`**（`app.py:904`），下一次提交时用新 client 重建。进行中的 turn 会受影响（引擎被换成 None）。
8. **trace 的 `finish()` 是同步的**，`flush()` 也在其中——大 trace 会阻塞 UI 线程（Textual worker 中，但仍是同步调用）。
9. **`start_generation` 与 `start_tool` 都用 `self.trace_ref` 作父**——层次是平的，不是设计文档暗示的嵌套。
10. **`AgentTrace.finish` 用 `end_span` 结束 root trace**（命名混淆但正确）。

**MCP 侧**：

1. **工具名拼接 `mcp_{server}_{tool}` 是全系统契约**，三处独立依赖（权限、前缀卸载、前缀计数），不可单方面改格式。
2. **前缀匹配的 server 名冲突**：server `foo` 与 `foo_bar` 会互相误伤。
3. **`transport` 只支持 `"stdio"`**，其他静默丢弃。
4. **`connect_all` 串行 + 无全局超时**，一个卡住的 server 阻塞所有。
5. **工具重名 first-wins + skip**（非覆盖、非加后缀）。
6. **MCP 工具默认一律 ask**（`_tool_allowed` 的 `mcp_` 分支先于 `requires_permission`），adapter 的 risk 分级对「是否弹框」无影响，只影响弹框里显示的 risk 徽章。
7. **always-approve 对 MCP 是按全工具名**（任意参数都放行），对 bash 是按命令前缀。
8. **auto-allow 不持久化**。
9. **`ok=True` 硬编码**，MCP 的 `isError` 只要带 content 就被忽略。
10. **EmbeddedResource / ResourceLink 退化为 Python repr**（含 `AnyUrl`），且其 `model_dump()` 结果**无法 `json.dumps`**，会引发 `_persist_tool_result` 未捕获的 TypeError → 整轮 error。
11. **`shutdown` 只清 `_sessions`**（连接失败的 server 的 exit stack 残留）。
12. **`_disconnect_one` pop `_status`，`shutdown` 置 `"disconnected"`**——reconnect 后面板短暂显示 Disconnected。
13. **`tool_context` 形参全链路未使用**。
14. **`timeout_seconds` 只作用于单次 tool call**，不作用于连接（连接超时依赖 SDK）。
15. **无重试**。
16. **`inputSchema` 基本透传**，只补 3 个顶层键，不做 `$ref` 解析。
17. **MCP 的 annotations（readOnlyHint/destructiveHint）被完全忽略**，风险全靠名字子串。

---

## 9. 复刻验收清单

### 9.1 MCP

- [ ] config.json 顶层 `mcp_servers` 数组，6 个字段名与默认值正确。
- [ ] 非 `"stdio"` 事务静默丢弃；`name`/`command` 缺失静默丢弃。
- [ ] `load_mcp_config(paths)` 只读不写；每次 `/mcp` 打开重新读盘。
- [ ] `MCPManager.connect_all` 串行、无全局超时、异常吞、`tool_context` 未用。
- [ ] `_connect_server` 的 `env` 空时传 `None`；`getattr(tool, "inputSchema", None)` 用 camelCase。
- [ ] 重名工具 → warning + skip。
- [ ] `_status` 四值闭集；`_disconnect_one` pop vs `shutdown` 置 `"disconnected"`。
- [ ] 清理超时 5.0s。
- [ ] `shutdown` 只遍历 `_sessions`。
- [ ] 工具名 `f"mcp_{server}_{tool}"`，`version="1.0.0"`。
- [ ] `_infer_risk_level`：SHELL 先于 WRITE，子串匹配，默认 low。
- [ ] `_normalize_schema` 只补 3 键。
- [ ] `requires_permission`：high/medium ask，low allow；两条 reason 字符串。
- [ ] 三个错误码 `PROVIDER_TIMEOUT` / `TRANSPORT_UNAVAILABLE` / `SERVER_EXEC_ERROR` 与内容模板。
- [ ] `except ConnectionError` 在 `except Exception` 前。
- [ ] `_extract_content` 的 hasattr 分支顺序：`text` → `data` → `str()`。
- [ ] `ok=True` 硬编码；`data={"raw": ...}`；`meta` 含 `server` 与 `elapsed_ms`。
- [ ] `_tool_allowed` 的 `mcp_` 分支在 `allowed_tools is None` 之前。
- [ ] `add_auto_allow_tool` 按全名；MCP 的 always-approve 在 `app.py` 侧按工具名。
- [ ] 状态栏 `MCP: c/t`，有错加 `err` 段。
- [ ] `/mcp` 详情面板字段与工具行格式。
- [ ] 无重试、无参数级策略、无 MCP 能力协商分支、无提示词注入差异。

### 9.2 可观测性

- [ ] config 来自 `app_settings`（**无环境变量**），7 个键名与默认值正确。
- [ ] `_bool_setting` 的 truthy 集合。
- [ ] 两个 `disabled_reason` 字面量；keys 缺失时清空 key。
- [ ] 任何失败 → Noop；9 个方法都是 no-op。
- [ ] `_safe_call` 包住所有 SDK 调用。
- [ ] `as_type` 三值：`"agent"` / `"span"` / `"generation"`；root 用 `"agent"`。
- [ ] trace 名 `flyinchat.user_task`、span 名 `agent.loop`、generation 名 `llm.agent_turn` / `llm.compaction_summary`、tool span 名 `tool.<name>`。
- [ ] 层次是**扁平**的（tool/generation 挂 trace，不挂 agent.loop）。
- [ ] trace metadata 15 键，含 `"trace_id": "managed_by_langfuse"`。
- [ ] `agent_mode == permission_mode == self.mode`；`workspace = project_dir.parent`。
- [ ] `finish()` 五步顺序：agent span → scores → trace update → trace end → flush。
- [ ] `GenerationTrace.finish` 的 `finish_reason` 只有 `"error"`/`"stop"`。
- [ ] `ToolTrace` 六种 `approval_status`；`with_approval_required` 写 trace metadata 计数。
- [ ] sanitize 四个常量、12 敏感 key、8 敏感路径、`\n... [truncated N chars]` 后缀。
- [ ] `_preview_limit_for_tool` 只对 bash；`"test"` 优先于 `"git diff"`。
- [ ] 敏感文件 preview 字面量 + 额外 `path` 键（且 metadata 中不含 path）。
- [ ] metrics 8 个 grounding code、8 个危险 pattern、21 键 `as_metadata`（含改名）。
- [ ] `with_llm_call` 的 `input_tokens` 覆盖语义。
- [ ] scores 8 个（含 `task_latency_ms` / `total_steps` 为非 0-1 值）；`_ratio` 默认 1.0。
- [ ] `classify_failure` 7 级顺序（权限优先于工具错误）+ 5 键字面量。
- [ ] git：2 秒超时、`git diff` 不带 HEAD、`isdigit` 过滤、12_000 截断、`unexpected_files_changed` 恒 0。
- [ ] 埋点 30 处的函数名与调用点对齐（尤其 `query_engine.py:627` 的 `finally` 中 finish generation）。
- [ ] 已知恒量：`decision_accuracy=1.0`、`rule_violation_count=0`、`unexpected_files_changed=0`、`user_id=None`、`prompt_version="default"`、`tool_version="default"`。

---

## 10. 与既有设计文档的偏差汇总（复刻时需决定对齐哪一边）

| 设计文档要求 | 实际实现 | 位置 |
|---|---|---|
| `.env` + `LANGFUSE_*` 环境变量 | **完全未实现**，改为 config.json 的 `app_settings` | `observability/config.py` |
| SSE / HTTP 传输 | **未实现**，仅 stdio，其他静默丢弃 | `mcp/config.py:24-25` |
| MCP 能力协商处理 | 未显式处理，直接 `initialize()` + `list_tools()` | `mcp/manager.py:83-85` |
| 工具重试 + 指数退避 | **未实现** | `mcp/adapter.py` |
| 参数级权限策略（path/url/sql） | **未实现** | `mcp/adapter.py:87` |
| MCP annotations（readOnlyHint 等） | **被忽略**，风险靠名字子串 | `mcp/adapter.py:21-30` |
| schema `$ref` 解析 / 不可调用标记 | **未实现**，只补 3 个顶层键 | `mcp/adapter.py:33-44` |
| 精简 catalog + 按需展开 schema | **未实现**，全量下发 | `query_engine.py:235-238` |
| 结构化日志 `mcp.connection_state` / `tool.start` 等 | 部分：`ToolExecutor._emit` 存在但 `emit_event` 主链路为 None | `tools/core.py:140` |
| 独立 permission span / decision event | **未实现**，仅 tool span metadata | `observability/tracing.py` |
| `failure_stage` 13 个枚举 | 只用 4 个 + 3 个自定义 | `observability/scoring.py:55-116` |
| `failure_stage` 作为 score | 实际作为 metadata | `observability/tracing.py:170` |
| `progress_rate` 8 个语义子目标 | 手写 1+2+2+1+1+1/8 启发式 | `observability/scoring.py:119-132` |
| sub-agent 可观测 | **完全未埋点** | `subagents/` |
| `unexpected_files_changed` | 恒 0 | `observability/git_metadata.py:23` |
| `decision_accuracy` 有意义 | 恒 1.0 | `observability/scoring.py:31` |
| `rule_violation_count` | 恒 0（无写入点） | `observability/metrics.py:84` |
| python-dotenv 依赖 | 未引入 | `pyproject.toml` |
| `.env.example` 含 5 个 `LANGFUSE_*` 占位变量 | `.env.example` **存在但只是注释存根**：全文无任何实际变量赋值，只说明「Most settings are now stored in ~/.flyinchat/config.json」并列出 config.json 的 7 个 `app_settings` 键 | `.env.example`（Git 已跟踪） |
| `.gitignore` 忽略 `.env` / `.env.*` / `!.env.example` | **已实现**：`.gitignore` 含 `.env`、`.env.*`、`!.env.example` 三条（另含 `.flyinchat/`、`.omc`、`.venv/` 等） | `.gitignore` |
