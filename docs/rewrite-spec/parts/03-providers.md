# 03 — Provider / LLM API 客户端层

> **导航**：本文件是 `docs/REWRITE_SPEC.md`（总纲）的子规格。建议先读总纲了解架构全景，再回到本文件逐条实现。
> 相关：总纲 §0.2.1（文档与代码冲突清单）、§7（已知缺陷与复刻决策）、§8（复刻路线图）。


本文件记录旧项目的 provider 行为。新实现只支持 Anthropic Messages API；不再新增 OpenAI 兼容协议分支。不同供应商必须通过 `baseUrl + apiKey` 提供 Anthropic 格式的 endpoint。

> **新实现规范**：供应商、模型、能力声明和场景档位以 `09-typescript-agent-standard.md` 的“模型接入与场景路由”为准。

涉及源文件：

| 文件 | 职责 |
|------|------|
| `src/flyinchat/api_client.py`（588 行） | 本层全部实现：分派、两种协议的请求构造与 SSE 解析、消息格式转换、工具配对校验、非流式补全 |
| `src/flyinchat/tools/convert.py`（31 行） | 内部 `Tool` → Anthropic / OpenAI 工具 schema |
| `src/flyinchat/models.py` | `LLMChannel` / `LLMModel` 输入类型 |
| `src/flyinchat/message_utils.py` | 上游把持久化的 `Message` 转成 provider 消息 dict（`message_to_api_format`、`sanitize_api_messages`） |
| `src/flyinchat/storage.py` | DeepSeek provider preset、模型默认值 |
| `tests/test_api_client.py` | 唯一样例测试（`_convert_messages_for_openai`、`_dedupe_stream_delta`） |

---

## 1. 整体抽象

### 1.1 公共接口（精确签名）

```python
# src/flyinchat/api_client.py:32-44
async def stream_chat_completion(
    channel: LLMChannel,
    model: LLMModel,
    messages: list[dict[str, Any]],
    usage_info: dict | None = None,
    tools: list[Tool] | None = None,
) -> AsyncIterator[dict[str, Any]]:
```

```python
# src/flyinchat/api_client.py:500-510
async def chat_completion(
    channel: LLMChannel,
    model: LLMModel,
    messages: list[dict[str, Any]],
    *,
    max_tokens: int = 2048,
) -> str:
    """Non-streaming chat completion for summarization."""
```

要点：

- **`usage_info` 是出参，不是入参**：调用方传入一个空 dict（`usage_info: dict = {}`），函数把用量写进去（原地 update，属于对可变对象的写入，是唯一的非不可变设计例外）。类型标注是 `dict | None`，为 `None` 时所有 usage 提取逻辑整体跳过。返回值是 `AsyncIterator[dict]`，即内部归一化事件流（见第 4 节），**不是** provider 原始事件。
- **`tools=None` 与 `tools=[]` 语义不同**：`None` → 请求体不带 `tools` 字段；`[]`（空列表）→ `if tools:` 为假，同样不带 `tools` 字段。所以两者等价，都表示"不提供工具"。query_engine 在 finalization pass 时传 `[]`（`src/flyinchat/query_engine.py:456`）。
- `chat_completion` 返回纯文本字符串（非流式，用于压缩摘要与子代理结果压缩），签名带 `*` 强制 `max_tokens` 为关键字参数。

### 1.2 按 channel 类型分派

分派依据是 `channel.provider_type` 的字符串比较，只有两个合法值（`src/flyinchat/storage.py:15` 定义 `_PROVIDER_TYPES = frozenset({"openai_compatible", "anthropic"})`，写入时由 `_validate_channel_fields` 校验，`src/flyinchat/storage.py:728-730`）：

```python
# stream_chat_completion, src/flyinchat/api_client.py:39-44
if channel.provider_type == "anthropic":
    async for event in _stream_anthropic(channel, model, messages, usage_info, tools):
        yield event
else:
    async for event in _stream_openai_compatible(channel, model, messages, usage_info, tools):
        yield event
```

```python
# chat_completion, src/flyinchat/api_client.py:508-510
if channel.provider_type == "anthropic":
    return await _anthropic_chat(channel, model, messages, max_tokens)
return await _openai_chat(channel, model, messages, max_tokens)
```

注意：**判等 `== "anthropic"` 走 Anthropic 协议，其余一切（包括空串、未知值）走 OpenAI 兼容协议**。分派是单层 `if/else`，没有 fallback 到默认 provider 的逻辑。复刻时必须保持这个"默认落在 OpenAI 兼容"的方向，否则已有的 `openai_compatible` channel 行为会变。

### 1.3 HTTP 客户端：创建、超时、复用

四个网络入口各自独立创建一个 `httpx.AsyncClient`，**没有任何连接池复用**（流式与非流式都是每次调用新建、退出 `async with` 即关闭）：

```python
async with httpx.AsyncClient(timeout=httpx.Timeout(120.0)) as client:
```

出现位置：`api_client.py:133`（OpenAI 流式）、`389`（Anthropic 流式）、`531`（OpenAI 非流式）、`570`（Anthropic 非流式）。

- 超时是 `httpx.Timeout(120.0)`，即 connect / read / write / pool **四项全部 120 秒**。read timeout 120s 同时充当流式空闲超时（两个 SSE chunk 间隔超过 120s 抛 `httpx.ReadTimeout`）。
- 流式用 `client.stream("POST", url, headers=headers, json=body)`；非流式用 `await client.post(url, headers=headers, json=body)`。
- 没有显式 `follow_redirects`，没有代理配置，没有自定义 `limits`。
- **没有重试逻辑**（既无 httpx transport retries，也无应用层重试）。见第 6 节。

### 1.4 base_url 规范化与 header

**Anthropic**（`api_client.py:364-369`，非流式为 `555-560`，二者逐字相同）：

```python
url = f"{channel.base_url.rstrip('/')}/v1/messages" if channel.base_url else "https://api.anthropic.com/v1/messages"
headers = {
    "x-api-key": channel.api_key,
    "anthropic-version": "2023-06-01",
    "Content-Type": "application/json",
}
```

- 规范化规则：`base_url` 去掉**所有**尾部 `/`（`rstrip('/')`），再拼 `/v1/messages`。
- 空/None 的 `base_url` → 回落到官方 `https://api.anthropic.com/v1/messages`。
- Header 只有三个：认证头是 `x-api-key`（**不是** `Authorization: Bearer`），协议版本是固定字面量 `"2023-06-01"`。**没有任何 `anthropic-beta` 头**——即使 `/1M` 打开了 1M 上下文窗口（`src/flyinchat/app.py:826`、`2024`），也不会发送 `context-1m-2025-08-07` 之类的 beta 头。1M 只是本地 `context_window` 数值，仅影响压缩阈值与 UI 标签，不影响任何请求字段。

**OpenAI 兼容**（`api_client.py:96-101`，非流式为 `519-524`）：

```python
base = channel.base_url.rstrip("/") if channel.base_url else ""
url = f"{base}/v1/chat/completions"
headers = {
    "Authorization": f"Bearer {channel.api_key}",
    "Content-Type": "application/json",
}
```

- 同样的 `rstrip("/")`，但**没有默认域名回退**：`base_url` 为空时 base 是空串，url 变成 `"/v1/chat/completions"`，httpx 会因无法解析相对 URL 而抛错（`httpx.UnsupportedProtocol` / `InvalidURL`）。**不变量：OpenAI 兼容 channel 必须配置 base_url。**
- 认证头是 `Authorization: Bearer <api_key>`。

**两种协议都不发送请求级 header 定制**。两处 header 都以字面量 dict 构造，没有合并任何用户自定义 header 或 User-Agent。

### 1.5 输入消息形态（上游契约）

`messages: list[dict]` 由 `message_utils.py` 生成，可能的形状（复刻本层必须能接受全部这些）：

| 形态 | 来源 | 结构 |
|------|------|------|
| 系统提示 | `message_to_api_format`（`message_utils.py:43`，compact_summary） | `{"role": "system", "content": "<str>"}` |
| 用户文本 | 同上（`message_utils.py:46`） | `{"role": "user", "content": "<str>"}` |
| 助手（含 thinking/tool_use） | 存储的 content 是 JSON 数组（`message_utils.py:31-32`） | `{"role": "assistant", "content": [ {"type":"thinking","thinking":str,"signature":str}, {"type":"text","text":str}, {"type":"tool_use","id":str,"name":str,"input":dict}, ... ]}` |
| 助手（纯文本） | `message_utils.py:46` | `{"role": "assistant", "content": "<str>"}` |
| 工具结果 | `message_utils.py:34-38` | `{"role": "tool", "tool_use_id": "<str>", "content": "<str>"}` |
| 占位助手 | `sanitize_api_messages`（`message_utils.py:21`） | `{"role": "assistant", "content": "[Interrupted]"}` |

`sanitize_api_messages` 在**连续两条 user 消息之间**插入 `{"role": "assistant", "content": "[Interrupted]"}`，用于修复崩溃/取消留下的孤儿 user 消息（保证角色交替合法）。它在调用 provider 之前由 query_engine 应用（`src/flyinchat/query_engine.py:571`），不在本层。

子系统边界：本层只消费上述 dict 形状，**不**读数据库、不构造 system prompt（`system` 消息由 prompt_assembler 以 `{"role":"system"}` 形式放进 messages 列表）。

### 1.6 输入模型类型

```python
# src/flyinchat/models.py:4-26
@dataclass(frozen=True)
class LLMChannel:
    id: str
    name: str
    provider_type: str        # "anthropic" | "openai_compatible"
    base_url: str | None
    api_key: str
    created_at: str
    updated_at: str

@dataclass(frozen=True)
class LLMModel:
    id: str
    channel_id: str
    name: str                 # 直接作为请求体的 model 字段
    is_default: bool
    thinking_enabled: bool = True
    reasoning_effort: str = "high"
    context_window: int = 125_000
    max_output_tokens: int = 384_000
    created_at: str = ""
    updated_at: str = ""
```

本层只读 `channel.provider_type`、`channel.base_url`、`channel.api_key`、`model.name`、`model.thinking_enabled`、`model.reasoning_effort`、`model.max_output_tokens`。**`context_window` 在本层完全未使用**（只被 compact 使用）。

---

## 2. Anthropic 协议实现

### 2.1 请求体构造（`api_client.py:374-385`）

```python
system_prompt, anthropic_messages = _convert_messages_for_anthropic(messages)
validate_tool_pairing(anthropic_messages)

body: dict[str, Any] = {
    "model": model.name,
    "max_tokens": model.max_output_tokens,
    "messages": anthropic_messages,
    "stream": True,
}
if system_prompt:
    body["system"] = system_prompt
if model.thinking_enabled:
    body["thinking"] = {"type": "enabled"}
if tools:
    body["tools"] = tools_to_api_format(tools, "anthropic")
```

字段表（流式）：

| 字段 | 值 / 来源 | 条件 |
|------|-----------|------|
| `model` | `model.name`，原样 | 总是 |
| `max_tokens` | `model.max_output_tokens` | 总是 |
| `messages` | `_convert_messages_for_anthropic(messages)[1]` | 总是 |
| `stream` | `True`（硬编码） | 总是 |
| `system` | `"\n\n".join(system_parts)`，来自所有 `role=="system"` 消息的 content | 仅当 `system_prompt` 非空（空串/None 都不带此字段） |
| `thinking` | `{"type": "enabled"}` | 仅当 `model.thinking_enabled` |
| `tools` | `tools_to_api_format(tools, "anthropic")` | 仅当 `tools` 为真值 |

**不存在**的字段（复刻时不要凭空添加）：`temperature`、`top_p`、`top_k`、`stop_sequences`、`metadata`、`tool_choice`、`anthropic_beta`。全仓库 grep 无任何 `temperature`/`top_p`/`stop_sequences` 使用，采样参数让 provider 用默认值。

**Extended thinking 的开启条件与 budget_tokens**：开启条件唯一——`model.thinking_enabled` 为真（`LLMModel` 默认 `True`，创建 channel/model 时硬编码 `"thinking_enabled": True`，见 `storage.py:134`、`204`）。**代码不计算、也不发送任何 `budget_tokens`**：请求体里的 `thinking` 只有 `{"type": "enabled"}` 一个键（`api_client.py:383`）。这里也**没有读取 `model.reasoning_effort`**（Anthropic 分支完全忽略它，只有 OpenAI 分支用）。这是针对 DeepSeek 的 Anthropic 兼容端点做的偏离；对接官方 Anthropic API 时必须补 `"budget_tokens"`（官方文档要求 `budget_tokens` 为必填且 `max_tokens > budget_tokens`），复刻时请把这个差异显式标注。

非流式（`_anthropic_chat`，`api_client.py:561-569`）：同上，但 `"stream": False`，`max_tokens` 来自函数参数（不是 `model.max_output_tokens`），**不带 `thinking`、不带 `tools`**，只保留 `model` / `max_tokens` / `messages` / `stream` / 可选 `system`。也就是说非流式摘要路径永远不开 thinking、永远不给工具。

### 2.2 消息转换 `_convert_messages_for_anthropic`（`api_client.py:251-282`）

```python
def _convert_messages_for_anthropic(messages: list[dict[str, Any]]) -> tuple[str | None, list[dict[str, Any]]]:
    system_parts: list[str] = []
    converted: list[dict[str, Any]] = []
    tool_buffer: list[dict[str, Any]] = []

    def _flush_tools() -> None:
        if tool_buffer:
            converted.append({"role": "user", "content": list(tool_buffer)})
            tool_buffer.clear()

    for msg in messages:
        if msg["role"] == "system":
            content = msg.get("content", "")
            if content:
                system_parts.append(content)
        elif msg["role"] == "tool":
            tool_buffer.append({
                "type": "tool_result",
                "tool_use_id": msg.get("tool_use_id", ""),
                "content": msg["content"],
            })
        else:
            _flush_tools()
            content = msg.get("content", "")
            if isinstance(content, str):
                converted.append({"role": msg["role"], "content": content})
            else:
                converted.append({"role": msg["role"], "content": content})

    _flush_tools()
    system_prompt = "\n\n".join(system_parts) if system_parts else None
    return system_prompt, converted
```

算法逐条规则：

1. **system 被抽出**：所有 `role=="system"` 消息的 content 收集进 `system_parts`（**跳过空 content**），最终用 `"\n\n"` 连接成单个顶层 `system` 字符串。`system_parts` 为空时返回 `None`（不是 `""`）。这些消息**不进 `messages` 数组**。
2. **tool 被攒批**：连续的 `role=="tool"` 消息合并进 `tool_buffer`，每条变成 `{"type":"tool_result","tool_use_id":..., "content":...}` 块。`tool_use_id` 缺失时用 `""` 兜底；`content` 直接取 `msg["content"]`（KeyError 会向上抛，上游契约保证存在）。
3. **攒批刷新时机**：遇到任何非 system、非 tool 的消息时先 `_flush_tools()`；函数结束时再刷一次。因此 N 个连续 tool 结果 → **一个** `{"role":"user","content":[N 个 tool_result 块]}` 消息，严格紧跟在其前的 assistant(tool_use) 之后。这满足了 Anthropic 要求的"tool_result 必须在 user 消息里且与 tool_use 配对"。
4. **其他角色原样透传**：`if isinstance(content, str) ... else ...` 两个分支代码完全相同（冗余写法，行为无差异），即 user / assistant 的 content 不区分 str 或 list，**原样透传**。所以助手历史消息里的 `{"type":"thinking",...}`、`{"type":"tool_use",...}` 块会带着 `signature` 原封不动回到请求里。

**注意没有做的事**：不剥离 thinking 块的 `signature`、不把 `tool_use.input` 重新序列化、不合并/拆分 user 消息、不排序、不丢弃空 content 的 assistant 消息（`msg.get("content","")` 得到 `""` 会变成 `{"role":"assistant","content":""}`，Anthropic 官方 API 会拒绝空 content；这里依赖上游不会产生这种消息）。

### 2.3 工具配对校验 `validate_tool_pairing`（`api_client.py:285-354`）

```python
class ToolPairError(Exception):
    """Raised when tool_use/tool_result pairing is invalid."""
```

调用点**仅一处**：`api_client.py:372`，即 Anthropic 流式路径，在转换之后、发请求之前。非流式 Anthropic 路径与 OpenAI 路径都不校验。

算法（输入是**已转换的** Anthropic 消息数组，tool 消息已变成 `role="user"` + tool_result 块）：

1. 用 `i` 遍历，只处理 `role == "assistant"` 的消息；其他角色 `i += 1`。
2. 收集该 assistant 消息 content（必须是 list）中所有 `type=="tool_use"` 块的 `id`（跳过空 id）。无 id 则跳过该消息。
3. 从 `i+1` 往后跳过所有 `role=="system"` 消息（实际上转换后不该有 system，属防御性代码）。
4. 若跳过到末尾 → 抛 `ToolPairError(f"assistant has tool_use blocks {tool_use_ids} but no following message with tool_results")`。
5. 若下一条不是 `role=="user"` → 抛 `ToolPairError(f"assistant has tool_use blocks {tool_use_ids} but next message is role='{role}' (expected user with tool_results)")`。
6. 收集该 user 消息中所有 `type=="tool_result"` 块的 `tool_use_id`。
7. `missing = set(tool_use_ids) - set(result_ids)`：非空 → 抛 `ToolPairError(f"tool_use ids {sorted(missing)} have no matching tool_result blocks. Found tool_results for: {sorted(result_ids)}")`。
8. `extra = set(result_ids) - set(tool_use_ids)`：非空 → **只记 warning 不抛**（`logger.warning("tool_result blocks with no matching tool_use", extra={"extra_tool_result_ids": sorted(extra)})`）。
9. `i = j + 1`（跳到配对结果之后），继续。

失败后果：`ToolPairError` 从 `_stream_anthropic` 冒出，被 query_engine 的 `except Exception`（`src/flyinchat/query_engine.py:532`）捕获，除非错误串命中上下文超限的特征词（`ToolPairError` 不命中），否则整轮以 `error` 结束并把 message 发给用户。

**无任何测试覆盖此函数**（全仓库 grep 只有实现与调用，没有测试）。

### 2.4 SSE 解析（`api_client.py:408-497`）

解析循环是**行式**的，不是标准 SSE 事件框架：

```python
async for line in response.aiter_lines():
    if line.startswith("data: "):
        data_str = line[6:]
        try:
            data = json.loads(data_str)
        except json.JSONDecodeError:
            continue
        event_type = data.get("type", "")
```

关键点：

- **只认 `data: ` 前缀（注意冒号后有一个空格，共 6 个字符）**。`event:` 行、`id:` 行、注释行、空行全被忽略。因此**事件类型取自 JSON 体内的 `"type"` 字段**，而不是 SSE 的 `event:` 行——Anthropic 官方两种都有且一致，所以可用。
- 解析失败（半行/非 JSON）→ `continue`，静默跳过。
- `aiter_lines()` 按行解码：httpx 负责 UTF-8 解码与跨 chunk 的行/字符拼接（见第 8 节）。
- **没有 `[DONE]` 处理**（Anthropic 协议没有该哨兵，靠流自然结束）。
- **没有 `message_stop` 处理**，也没有 `error` 事件处理——若 provider 发 `{"type":"error","error":{...}}`，`event_type` 不匹配任何分支，被完全忽略，流正常结束，调用方会以为这轮"没有输出"。复刻时若想更健壮，应显式处理 `error` 与 `message_stop`。
- 每个分支都带 `elif`，所以**一条 SSE 数据只命中一个分支**。

**逐事件映射表**（event_type → 行为）：

| `data["type"]` | 读取字段 | 行为 |
|----------------|----------|------|
| `message_start` | `message.usage`（取不到则回退顶层 `data["usage"]`） | 提取 `input_tokens`/`output_tokens`（详见 2.5），仅在 `usage_info is not None` 时执行 |
| `message_delta` | 顶层 `usage` | 同上 |
| `content_block_start` | `content_block.type`、`content_block.id`、`content_block.name`、`index` | `thinking` → `blocks[idx] = {"type":"thinking","thinking":"","signature":""}`；`tool_use` → `blocks[idx] = {"type":"tool_use","id":...,"name":...,"json_fragments":[]}`；**`text` 类型不登记**（文本块无状态，靠 `content_block_delta` 直接 yield） |
| `content_block_delta` | `delta.type`、`delta.*`、`index` | 见下 4 个 delta 分支 |
| `content_block_stop` | `index` | 从 `blocks` 弹出该 index；`thinking` → yield thinking 事件；`tool_use` → 拼接 JSON 并 yield tool_use 事件（详见 2.6） |
| `message_stop` / `ping` / `error` / 其他 | — | 忽略 |

`content_block_delta` 的 4 个子类型：

| `delta.type` | 读取 | 行为 |
|--------------|------|------|
| `text_delta` | `delta.text` | **立即** `yield {"type": "text", "content": delta.get("text", "")}` —— 无去重、无缓冲、无空值保护（`""` 也会 yield 一个空文本事件） |
| `thinking_delta` | `delta.thinking` | 若 `idx in blocks`：`blocks[idx]["thinking"] += ...`（累积，不 yield） |
| `signature_delta` | `delta.signature` | 若 `idx in blocks`：`blocks[idx]["signature"] = ...`（**赋值，不是累加**——取最后一个 delta） |
| `input_json_delta` | `delta.partial_json` | 若 `idx in blocks`：`blocks[idx]["json_fragments"].append(...)` |

若 `idx not in blocks`（例如 text 块发了 `input_json_delta`，或没收到 `content_block_start`），这些 delta 被**静默丢弃**。

### 2.5 usage 提取（Anthropic）

两处结构相同（`api_client.py:418-434` 与 `436-444`）：

```python
inp = usage.get("input_tokens") or usage.get("prompt_tokens", 0)
if inp:
    usage_info["input_tokens"] = inp
out = usage.get("output_tokens") or usage.get("completion_tokens", 0)
if out:
    usage_info["output_tokens"] = out
```

- 写入的 key 是**归一化后的** `"input_tokens"` / `"output_tokens"`（不是 provider 原生 key）。
- 兼容回退：也接受 `prompt_tokens` / `completion_tokens`（OpenAI 风格命名），说明该分支同时兼容某些"伪 Anthropic"端点。
- `if inp:` / `if out:` 意味着 **0 值不会被写入**（`0` 是 falsy），已有值不会被 0 覆盖——这正好避免 `message_delta` 里常见的 `output_tokens` 覆盖问题。
- `message_start` 分支：`msg_data = data.get("message", {})`，`usage = msg_data.get("usage", {})`；取不到时回退 `data.get("usage", {})`；两处都空则什么都不做。若两个 key 都没提取到，记 debug 日志 `"message_start usage keys not recognized"` + `{"usage_keys": list(usage.keys())}`。
- **不提取任何 cache 相关字段**（`cache_creation_input_tokens`、`cache_read_input_tokens`）——没有出现在代码中。也不提取 `message_delta` 的 `stop_reason`。

下游怎么用（**必须复刻，否则 token 统计错**）：

```python
# src/flyinchat/query_engine.py:599-604
if channel.provider_type == "anthropic":
    total_output_tokens += usage_info.get("output_tokens", 0)
    total_input_tokens = usage_info.get("input_tokens", 0)
else:
    total_output_tokens += usage_info.get("completion_tokens", 0)
    total_input_tokens = usage_info.get("prompt_tokens", 0)
```

- Anthropic 分支累加 `output_tokens`，**覆盖式**赋值 `input_tokens`（每轮取最后一次调用的输入）。
- OpenAI 分支读**原生** `completion_tokens` / `prompt_tokens`（因为 OpenAI 路径直接 `update` 原始 usage dict）。
- `output_tokens` 是累加（多轮工具循环累加），`input_tokens` 是"最后一次"。
- **回退**：`if total_input_tokens == 0 and api_messages:` → 用 `TokenEstimator().estimate_api_messages(api_messages)` 本地估算（`query_engine.py:605-609`）。注释明确写着是因为 DeepSeek 的 Anthropic 兼容 SSE 可能不上报 input_tokens，避免 UI 显示 "↑0"。
- `estimate_api_messages` = `sum(self.estimate(json.dumps(m, ensure_ascii=False)) for m in api_messages)`（`src/flyinchat/compact.py:75-76`），注意 `ensure_ascii=False`（CJK 按字符计）。
- 子代理另有口径：`_usage_tokens` 把 4 个 key **相加**（`src/flyinchat/subagents/executor.py:415-420`）：
  ```python
  usage_info.get("input_tokens", 0) + usage_info.get("output_tokens", 0)
  + usage_info.get("prompt_tokens", 0) + usage_info.get("completion_tokens", 0)
  ```
  因为两种协议的 key 不会同时出现，相加是安全的。

### 2.6 tool_use 块的流式增量拼接算法（Anthropic）

状态容器：`blocks: dict[int, dict]`（`api_client.py:387`），key 是 SSE 的 `index`。

生命周期：

1. **`content_block_start`（type=`tool_use`）** → 登记
   ```python
   blocks[idx] = {"type": "tool_use", "id": block.get("id", ""), "name": block.get("name", ""), "json_fragments": []}
   ```
   注意 `id` 与 `name` 在 start 事件里就已经完整给出（Anthropic 协议如此），**不需要增量拼接**；只有 `input` 需要。
2. **`content_block_delta`（type=`input_json_delta`）** → `blocks[idx]["json_fragments"].append(delta.get("partial_json", ""))`。**只 append，不解析、不去重**。分片可以任意切割（Anthropic 常按 1-N 字符切），包括把 `中` 这样的转义序列切断——但因为是纯字符串拼接，最后整体 `json.loads` 一次，不会出错。
3. **`content_block_stop`** → 判定完成
   ```python
   idx = data.get("index", 0)
   if idx in blocks:
       block = blocks.pop(idx)
       ...
       elif block["type"] == "tool_use":
           json_str = "".join(block["json_fragments"])
           try:
               parsed = json.loads(json_str)
               yield {"type": "tool_use", "id": block["id"], "name": block["name"], "input": parsed}
           except json.JSONDecodeError:
               pass
   ```
   **完成判定的唯一信号是 `content_block_stop`**，不是 JSON 可解析性（与 OpenAI 路径相反，见 3.4）。
4. `blocks.pop(idx)` 保证同一 index 不会被处理两次。

**易错点/复刻注意**：

- `json.loads` 失败时 **`pass` 静默丢弃**：不会 yield 任何事件，**不会** yield `incomplete_tool_call`（该事件只有 OpenAI 路径产生）。也就是说 Anthropic 路径上一个被截断的 tool call 会**完全消失**，调用方看不到、不会触发自动续写。这是与 OpenAI 路径的行为不对称，复刻时需明确取舍（若要更健壮，应在这里也 yield `incomplete_tool_call`）。
- 空 `json_fragments`（stop 前没有任何 delta）→ `json_str == ""` → `json.loads("")` 抛 `JSONDecodeError` → 静默丢弃。**无参数的工具调用会丢失**，而 Anthropic 对无参工具通常发送 `partial_json="{}"`，所以实践中不触发；但复刻时应把 `""` 特判为 `{}` 更安全。
- `signature_delta` 用赋值而非累加：若 provider 分多次发 signature，只会保留最后一片。
- thinking 块的完成事件**在 `content_block_stop` 才 yield**，即 thinking 是"全量一次性"事件，不是增量。`{"type":"thinking","thinking":<全文>,"signature":<签名>}`。**thinking 的 yield 与文本 yield 的时序**：Anthropic 路径下，`thinking` 事件（在 block stop 时）**晚于**同一响应中先到的 `text_delta` 的 text 事件——如果模型先输出 thought 再输出 text（正常情况 thinking block 在前，其 stop 也先到），顺序仍然正确；但如果 provider 把多个 block 交错，顺序会由 stop 事件的到达顺序决定。

### 2.7 错误响应与异常

Anthropic 流式（`api_client.py:391-407`）：

```python
if response.status_code >= 400:
    error_body = await response.aread()
    error_text = error_body.decode(errors="replace")[:2000]
    logger.error("anthropic stream request failed", extra={
        "url": url, "status_code": response.status_code,
        "model": body["model"], "error_body": error_text,
    })
    raise httpx.HTTPStatusError(
        f"HTTP {response.status_code} {response.reason_phrase}\nURL: {url}\n{error_text}",
        request=response.request,
        response=response,
    )
```

- 阈值是 `>= 400`（含 4xx 与 5xx）。
- 先 `await response.aread()` 把整个 body 读回来（流式响应下列必须读完才能安全重用连接）。
- `decode(errors="replace")`：**绝不因非法 UTF-8 抛错**，非法字节替换为 U+FFFD；截断到前 **2000** 字符。
- 抛 `httpx.HTTPStatusError`，message 是 `f"HTTP {status} {reason_phrase}\nURL: {url}\n{error_text}"`。
- **没有 `from None`**，所以原始异常链保留（OpenAI 路径不同，见 3.5）。

非流式（`api_client.py:572-583`）：同样 `>= 400` 记 error 日志，然后 `response.raise_for_status()` 抛 httpx 标准异常（message 里**不含** body）。

其他异常：超时（`httpx.ReadTimeout`/`ConnectTimeout`）、网络错误、`httpx.RemoteProtocolError`（流中断）都**不捕获**，原样冒到 query_engine。冒到那里后：

- `except Exception as error`（`query_engine.py:532`）→ `error_str = str(error)`；
- 若还留有 `compact_retry_remaining > 0` 且错误串包含 `"context_length_exceeded"` / `"413"` / `"too long"`(lower) / `"maximum context length"`(lower) 之一 → 触发反应式压缩并 `continue` 重试该轮（`query_engine.py:535-584`，这是**唯一的**"重试"路径，且只针对上下文超限）；
- 否则 yield `TurnEvent(turn_id, "error", {"message": error_str})` 并 `return await finish("error", "error", error=error_str)`，整轮终止。

非流式（`_anthropic_chat` 返回值，`api_client.py:585-588`）：

```python
for block in data.get("content", []):
    if block.get("type") == "text":
        return block["text"]
return ""
```

返回**第一个** text 块的内容；没有 text 块返回 `""`（不抛错）。thinking 块被跳过。

---

## 3. OpenAI 兼容协议实现

### 3.1 请求体构造（`api_client.py:102-114`）

```python
body: dict[str, Any] = {
    "model": model.name,
    "messages": _convert_messages_for_openai(messages),
    "stream": True,
    "stream_options": {"include_usage": True},
    "max_tokens": model.max_output_tokens,
    "max_completion_tokens": model.max_output_tokens,
}
if model.thinking_enabled:
    body["reasoning_effort"] = model.reasoning_effort
    body["thinking"] = {"type": "enabled"}
if tools:
    body["tools"] = tools_to_api_format(tools, "openai_compatible")
```

| 字段 | 值 / 来源 | 条件 |
|------|-----------|------|
| `model` | `model.name` | 总是 |
| `messages` | `_convert_messages_for_openai(messages)` | 总是 |
| `stream` | `True` | 总是 |
| `stream_options` | `{"include_usage": True}` | 总是（这是能拿到 usage 的前提：让 provider 在末尾发一个 `choices: []` 的纯 usage chunk） |
| `max_tokens` | `model.max_output_tokens` | 总是 |
| `max_completion_tokens` | `model.max_output_tokens`（**与上一个同值，两个都发**） | 总是 |
| `reasoning_effort` | `model.reasoning_effort`（默认 `"high"`） | 仅当 `model.thinking_enabled` |
| `thinking` | `{"type": "enabled"}`（非 OpenAI 官方字段，为 DeepSeek 风格端点保留） | 仅当 `model.thinking_enabled` |
| `tools` | `tools_to_api_format(tools, "openai_compatible")` | 仅当 `tools` 为真值 |

**双 `max_tokens` + `max_completion_tokens` 的原因**：不同后端对这两个字段的支持不一（新 OpenAI 模型只认 `max_completion_tokens`，很多兼容后端只认 `max_tokens`），代码两个都发，由服务端忽略不认识的。复刻时保留这个"双发"策略，否则切模型会 400。

**不存在**的字段：`temperature`、`top_p`、`frequency_penalty`、`presence_penalty`、`stop`、`seed`、`response_format`、`tool_choice`、`parallel_tool_calls`、`n`、`user`。

`thinking_enabled` 置假时：**不发** `reasoning_effort`，也**不发** `thinking`——即"关思考"的实现方式是省略这两个字段（而不是发 `thinking: {"type":"disabled"}`）。注意 `reasoning_effort` 的值没有做枚举校验，`model.reasoning_effort` 是什么就发什么（storage 写入默认 `"high"`）。

请求日志（`api_client.py:116-126`）：`logger.debug("openai request", extra={model, message_count, has_tools, thinking, reasoning_effort, max_tokens})`。**不记录 api_key、不记录消息体**。（Anthropic 路径**没有**对应的请求日志。）

非流式（`_openai_chat`，`api_client.py:525-530`）：`{"model", "messages", "stream": False, "max_tokens": max_tokens}`——**不带** `stream_options`、`max_completion_tokens`、`thinking`、`reasoning_effort`、`tools`。

### 3.2 消息格式转换 `_convert_messages_for_openai`（`api_client.py:47-86`）

```python
def _convert_messages_for_openai(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    converted: list[dict[str, Any]] = []
    for msg in messages:
        if msg["role"] == "tool":
            converted.append({
                "role": "tool",
                "tool_call_id": msg.get("tool_use_id", ""),
                "content": msg["content"],
            })
        elif msg["role"] == "assistant" and isinstance(msg.get("content"), list):
            text_parts: list[str] = []
            reasoning_parts: list[str] = []
            tool_calls: list[dict[str, Any]] = []
            for block in msg["content"]:
                if block["type"] == "thinking":
                    reasoning = block.get("thinking", "")
                    if reasoning:
                        reasoning_parts.append(reasoning)
                elif block["type"] == "text":
                    text_parts.append(block["text"])
                elif block["type"] == "tool_use":
                    tool_calls.append({
                        "id": block["id"],
                        "type": "function",
                        "function": {
                            "name": block["name"],
                            "arguments": json.dumps(block["input"]),
                        },
                    })
            text_content = "\n".join(text_parts) if text_parts else ""
            converted_msg: dict[str, Any] = {"role": "assistant"}
            if reasoning_parts:
                converted_msg["reasoning_content"] = "\n".join(reasoning_parts)
            if tool_calls:
                converted_msg["tool_calls"] = tool_calls
            converted_msg["content"] = text_content or ""
            converted.append(converted_msg)
        else:
            converted.append(msg)
    return converted
```

规则：

1. **system 消息的位置**：**不移动、不入 system 字段、原样保留在数组里**（走最后的 `else`）。OpenAI 兼容协议支持数组中间的 `role: "system"`（或 provider 自行处理）。这与 Anthropic 路径把 system 抽到顶层成 `system` 字符串的行为形成对比——**复刻时这是最容易搞错的地方**。
2. **`role: "tool"`** → `{"role": "tool", "tool_call_id": <msg["tool_use_id"]>, "content": <msg["content"]>}`。注意 key 名从内部的 `tool_use_id` 改成 OpenAI 的 `tool_call_id`；`tool_use_id` 缺失时用 `""`。**不**发 `name` 字段（旧 OpenAI 规范可选）。每条 tool 结果都是**独立一条消息**（不合并），顺序保持。
3. **assistant 且 content 是 list** → 折叠为单条 assistant 消息：
   - `thinking` 块 → 若 `thinking` 非空，收进 `reasoning_parts`，最后用 `"\n"` 连接写入 **`reasoning_content`** 字段（**仅当至少有一个非空 thinking**）。`signature` 被**丢弃**（OpenAI 兼容协议没有签名概念）。空 thinking 被跳过。
   - `text` 块 → 收进 `text_parts`，用 `"\n"` 连接（多个 text 块合并成一个 `content` 字符串，块间是**一个换行**，不是空行）。空 `text_parts` → `content = ""`。
   - `tool_use` 块 → `{"id": block["id"], "type": "function", "function": {"name": block["name"], "arguments": json.dumps(block["input"])}}`。`json.dumps` 用默认参数（`ensure_ascii=True`，分隔符 `", "` 和 `": "`），所以中文参数会被转义成 `\uXXXX`，且形如 `{"path": "a.py"}`（冒号后有空格）——测试 `tests/test_api_client.py:58` 断言了这个精确字符串。
   - **key 插入顺序**：`role` → `reasoning_content`（可选）→ `tool_calls`（可选）→ `content`（总是，**最后**）。JSON 序列化顺序即此顺序，对 prompt caching 有影响，复刻时保持一致。
   - **`content` 总是存在**，即使为空串。带 tool_calls 的 assistant 消息 `content` 是 `""`（而非省略）。
   - 未知 `block["type"]`（如未来新增类型）被**静默忽略**——不报错，也不透传。
   - 注意取 `block["text"]` 用的是**下标**（缺 key 会 KeyError），而 thinking 用 `.get("thinking","")`。
4. **assistant 且 content 是 str，或其他任何角色** → **原样透传**（同一个 dict 对象，未拷贝）。所以纯文本 assistant 历史不带 `reasoning_content`。
5. **不校验角色合法性、不合并连续同角色消息、不注入占位**（占位由 `sanitize_api_messages` 在更上游做）。

测试覆盖（`tests/test_api_client.py:39-158`，4 个用例）：
- `test_convert_messages_for_openai_preserves_reasoning_for_tool_calls`：thinking + tool_use → 断言 `{"role":"assistant","reasoning_content":"need to inspect files","tool_calls":[{"id":"call_1","type":"function","function":{"name":"file_read","arguments":'{"path": "a.py"}'}}],"content":""}`，且 tool 消息断言 `{"role":"tool","tool_call_id":"call_1","content":"1|print('hi')"}`。
- `test_convert_messages_for_openai_preserves_reasoning_for_normal_assistant`：thinking + text → `{"role":"assistant","reasoning_content":"answer directly","content":"hello"}`（无 `tool_calls` key）。
- `test_convert_multi_round_tool_call_with_reasoning`：完整两轮 user/assistant/tool/assistant 序列，验证顺序与每步形态。
- `test_reasoning_content_always_preserved_from_history`：明确 `reasoning_content` 是历史消息的一部分，**总是**回传（不复位、不剥离）。

### 3.3 SSE 解析（`api_client.py:155-231`）

```python
async for line in response.aiter_lines():
        if line.startswith("data: "):
            data_str = line[6:]
            if data_str.strip() == "[DONE]":
                break
            try:
                data = json.loads(data_str)
            except json.JSONDecodeError:
                continue

            if "usage" in data and data["usage"] is not None and usage_info is not None:
                usage_info.update(data["usage"])

            choices = data.get("choices", [])
            if not choices:
                continue

            finish_reason = choices[0].get("finish_reason")
            ...
            delta = choices[0].get("delta", {})
            ...
```

（源码缩进比 `async for` 多一层，是无害的格式问题，`async for` 块体整体缩进更深，语义不变。复刻时正常缩进即可。）

关键点：

- 前缀同样是 `data: `（6 字符）。`event:` 行忽略。
- **`[DONE]` 哨兵**：`data_str.strip() == "[DONE]"` 时 `break` 退出整个流循环（**不是** `continue`）。这是 OpenAI 协议的标准结束标记。
- 顺序：**先处理 usage，再判断 choices**——因为 `stream_options.include_usage` 产生的最后一个 chunk 是 `{"choices": [], "usage": {...}}`，`choices` 为空必须 `continue`，但 usage 必须先被捕获。复刻时这个顺序不能反。
- usage 提取是 **`usage_info.update(data["usage"])`——整包浅合并原始 key**，不做归一化。因此 key 名取决于 provider：标准的 `prompt_tokens` / `completion_tokens` / `total_tokens`，以及可能的 `prompt_tokens_details`、`completion_tokens_details`（这两个是 dict 值，`update` 会原样放进 `usage_info`；下游 `tracing.py:232` 用 `isinstance(value, int | float)` 过滤后再上报，所以 dict 不会污染 trace 指标）。**注意 `update` 是覆盖：后到的 chunk 会覆盖先到的**。若某个 provider 在中途 chunk 里发了部分 usage，最终值以最后一个为准。
- `finish_reason`：只用于**日志**，不驱动任何状态（`api_client.py:172-182`）：
  - 非空时 `logger.info("stream chunk finish_reason", extra={"finish_reason": ...})`；
  - 等于 `"length"` 时追加 `logger.warning("model output truncated by token limit (finish_reason=length)", extra={"output_tokens_so_far": usage_info.get("completion_tokens", 0) if usage_info else 0})`。
  - **`finish_reason == "tool_calls"` 不触发任何 finalize**；finalize 完全由 JSON 可解析性驱动（见 3.4）。

**delta 字段逐个解析**：

| delta 字段 | 处理 |
|------------|------|
| `reasoning_content` | `_dedupe_stream_delta(reasoning_text, rc)` → 追加到 `reasoning_text`。**不立即 yield**（见下） |
| `content` | `_dedupe_stream_delta(text_content, content)` → 若非空：先补发一次 `reasoning` 事件（若还没发过且 `reasoning_text` 非空），累加 `text_content`，然后 yield `{"type":"text","content":<delta>}` |
| `tool_calls` | 见 3.4 |
| `role`、`refusal`、`function_call`（legacy）、其他 | **忽略** |

**reasoning 的"延迟一次性"发射**（这是本层最反直觉的设计）：

```python
content = delta.get("content", "")
if content:
    content_delta = _dedupe_stream_delta(text_content, content)
    if content_delta:
        if not reasoning_done and reasoning_text:
            reasoning_done = True
            yield {"type": "reasoning", "content": reasoning_text}
        text_content += content_delta
        yield {"type": "text", "content": content_delta}
```

- `reasoning_content` 的**所有分片被累积到 `reasoning_text`，从不增量 yield**。
- 只有在"**即将发出第一个非空 text delta**"时，才把**完整累积的 reasoning 文本**作为**一个** `{"type":"reasoning","content":<全文>}` 事件吐出，并置 `reasoning_done = True`。
- 若整个流**没有任何文本**（例如模型只思考然后直接调工具），则在流结束后补发一次（`api_client.py:233-235`）：
  ```python
  if reasoning_text and not reasoning_done:
      yield {"type": "reasoning", "content": reasoning_text}
  ```
- 因此：**每次流最多产生 1 个 `reasoning` 事件，且内容是全文**。下游必须把它当"整段替换"而非"增量追加"（query_engine 把它当一条 thinking block append，所以语义正确）。复刻时务必保留这个"一次全量"语义，否则 TUI 会重复显示思考内容。
- `reasoning_done` 一旦置真就不再重置，即使后续还有 `reasoning_content` 分片——那些分片会累加进 `reasoning_text` 但**永远不会被 yield**（丢弃）。实践中 reasoning 段在文本段之前结束，所以不影响；但这是已知的行为边界。

### 3.4 tool_calls 增量聚合（`api_client.py:128-131, 201-248`）

状态：`tool_calls_by_index: dict[int, dict[str, Any]] = {}`，每个条目形如 `{"name": "", "id": "", "arguments": ""}`。

**聚合规则**（`api_client.py:201-213`）：

```python
tc_list = delta.get("tool_calls", [])
for tc in tc_list:
    idx = tc.get("index", 0)
    if idx not in tool_calls_by_index:
        tool_calls_by_index[idx] = {"name": "", "id": "", "arguments": ""}
    entry = tool_calls_by_index[idx]
    if tc.get("id"):
        entry["id"] = tc["id"]
    if tc.get("function", {}).get("name"):
        entry["name"] = tc["function"]["name"]
    if tc.get("function", {}).get("arguments"):
        arguments = tc["function"]["arguments"]
        entry["arguments"] += _dedupe_stream_delta(entry["arguments"], arguments)
```

- **按 `index` 聚合**，`index` 缺失时默认 `0`。
- `id` 与 `function.name` 是**赋值**（只在非空时），因为 OpenAI 协议在第一个分片里给完整 id 和 name，后续分片只有 arguments。
- `arguments` 是**字符串拼接**，拼接前先过 `_dedupe_stream_delta` —— 用于容忍某些 provider 重复发送"到目前为止的完整 arguments"而不是纯增量（同 3.6 的快照去重）。**这是对 OpenAI 官方增量语义的超集兼容。**
- `index` 乱序到达是安全的：字典按 index 归位，各 index 独立累加。**并行多 tool_call 完全支持**（不同 index 互不干扰），同一 chunk 里可以有多个 `tc`。
- `arguments` 里的 JSON **分片切割可以在任意位置**（含字符串中间、转义序列中间），因为是纯拼接，最终一次 `json.loads`。但注意：如果一个 `"` 被切在两个分片之间，去重逻辑可能误判（见第 8 节）。

**完成判定与发射**（`api_client.py:215-231`，在每个 chunk 处理完后执行）：

```python
finished_indices = []
for idx, entry in tool_calls_by_index.items():
    if entry["arguments"]:
        try:
            parsed = json.loads(entry["arguments"])
            yield {"type": "tool_use", "id": entry["id"], "name": entry["name"], "input": parsed}
            finished_indices.append(idx)
        except json.JSONDecodeError:
            pass
for idx in finished_indices:
    del tool_calls_by_index[idx]
```

- 判定条件是"**累积的 arguments 字符串当前能被 `json.loads` 解析**"——**不是** `finish_reason == "tool_calls"`，也不是流结束。
- 一旦解析成功就**立即 yield `tool_use` 并删除该 index 的条目**（注意 `finished_indices` 两阶段删除，避免遍历时改字典）。
- 条目 `arguments` 为空串时完全不尝试（避免 `json.loads("")` 抛错）。

**流结束后的 flush**（`api_client.py:237-248`）：

```python
for entry in tool_calls_by_index.values():
    if entry["name"] and entry["arguments"]:
        try:
            parsed = json.loads(entry["arguments"])
            yield {"type": "tool_use", "id": entry["id"], "name": entry["name"], "input": parsed}
        except json.JSONDecodeError:
            logger.warning("stream ended with incomplete tool call, model output may have been truncated",
                           extra={"tool_name": entry["name"], "partial_args": entry["arguments"][:200]})
            yield {"type": "incomplete_tool_call", "name": entry["name"]}
```

- 条件更严：`name` **且** `arguments` 都非空才处理。**`arguments` 为空但 `name` 存在的条目被静默丢弃**（无参工具调用在流末尾会丢失——这是真实缺陷，复刻时建议对 `name` 非空且 arguments 为空的情况补 `input = {}` 后发射）。
- 解析失败 → 记 warning（`partial_args` 截断到 200 字符）+ yield `{"type": "incomplete_tool_call", "name": <name>}`（**事件里只有 name，没有 id、没有部分参数**）。
- 遍历顺序是 dict 插入顺序，即 index 的首次出现顺序。

**已知竞态/缺陷（复刻时需决策）**：由于"可解析即发射"，如果一个 tool_call 的 arguments 被拆成 `{"a":1}` 之后又来 `,"b":2}`，那么第一片就解析成功并被发射、条目被删除；后续分片到达时 `idx not in dict` → 新建空条目 → 只有 arguments、没有 name → 流尾 flush 时因 `name` 为空被丢弃。结果是**参数被静默截断成 `{"a":1}`**。官方 OpenAI 分片通常不会在 JSON 完整之前出现可解析前缀，但嵌套对象场景（如 `{"path":"a"}` 后接更多 key）确实可能。更稳妥的做法是：仅在 `finish_reason` 非空或流结束时统一解析（或至少要求 name 已到齐）。

### 3.5 错误处理（OpenAI）

流式（`api_client.py:135-154`）：

```python
if response.status_code >= 400:
    error_body = await response.aread()
    error_text = error_body.decode(errors="replace")[:2000]
    logger.error("openai compatible request failed", extra={
        "url": url, "status_code": response.status_code,
        "model": body["model"], "error_body": error_text,
    })
    try:
        response.raise_for_status()
    except httpx.HTTPStatusError as e:
        raise httpx.HTTPStatusError(
            f"{e}\nAPI response: {error_text}",
            request=e.request,
            response=e.response,
        ) from None
```

- 与 Anthropic 同样的 `>= 400`、同样的 `aread()` + `decode(errors="replace")[:2000]`、同样的 error 日志。
- 差别：**复用 `raise_for_status()` 的异常**，把 body 追加到 message（`f"{e}\nAPI response: {error_text}"`），并用 **`from None` 抑制异常链**。所以最终 message 是 httpx 默认文案（`Client error '401 Unauthorized' for url '...'`）加上 `\nAPI response: <body>`。

> query_engine 的上下文超限重试依赖错误串内容：`"413"` 会出现在 httpx 的 `Client error '413 ...'` 文案里，所以 OpenAI 路径的 413 能被识别；Anthropic 路径（message 是 `HTTP 413 Request Entity Too Large\nURL: ...`）同样包含 `413`。两条路径都能命中。

非流式（`api_client.py:533-545`）：`>= 400` 记 error 日志（`"openai chat request failed"`）后**无条件** `response.raise_for_status()`（不在 try 里），然后 `data = response.json()`，返回 `data["choices"][0]["message"]["content"]`。

- **没有 KeyError/IndexError 保护**：provider 返回非预期结构（如 `choices` 为空、`message` 无 `content`、`content` 为 `null` 用于 reasoning 模型）会直接抛 `KeyError`/`IndexError`/返回 `None`。调用方 `compact.py` 与 `result_compressor.py` 都用 `except Exception` 兜底（`result_compressor.py:151` 的 `except Exception: return None`），但 `compact.py:416-425` 是 re-raise。
- 返回类型标注是 `str`，但 reasoning 模型的 `message.content` 可能是 `None` → 实际返回 `None`，类型标注被违反。复刻时应显式 `or ""`。

### 3.6 `_dedupe_stream_delta`（`api_client.py:17-29`）

```python
def _dedupe_stream_delta(emitted: str, chunk: str) -> str:
    if not chunk:
        return ""
    if not emitted:
        return chunk
    if chunk.startswith(emitted):
        return chunk[len(emitted):]

    max_overlap = min(len(emitted), len(chunk))
    for size in range(max_overlap, 0, -1):
        if emitted.endswith(chunk[:size]):
            return chunk[size:]
    return chunk
```

用途：把"已发出的全文 + 新 chunk"这种**快照式**流（部分兼容端点/网关会重复发送累计内容）折算成纯增量。被用在三处：OpenAI 的 `reasoning_content`（`api_client.py:188`）、`content`（`193`）、`tool_calls[].function.arguments`（`213`）。**Anthropic 路径不用它**。

算法：

1. `chunk` 为空 → 返回 `""`（空 delta，丢弃）。
2. `emitted` 为空（首个 chunk）→ 原样返回 `chunk`。
3. `chunk.startswith(emitted)` → **快照式**：新 chunk 是"已发出全文 + 新内容"，返回 `chunk[len(emitted):]`（去掉已发前缀）。
4. 否则：从大到小找最大重叠 `size`，若 `emitted` 的**结尾等于 `chunk` 的开头 `size` 个字符**，返回 `chunk[size:]`。这样能处理"重叠若干字符的增量"（例如 provider 重发了上一个 chunk 的尾部）。
5. 完全无重叠 → 原样返回 `chunk`（纯增量，正常情况走这里）。

**正确性证据来自测试**（`tests/test_api_client.py:4-36`）：

```
输入 chunk 序列: "你好", "你好！", "很高兴", "很高兴见到", "你", "你。",
                "我是 ** Cl", "Claude", "aude**，由 Anthrop", "Anthropic 开发"
拼接结果必须是: "你好！很高兴见到你。我是 ** Claude**，由 Anthropic 开发"
```

```
输入: "a", "and", " another"  →  拼接结果必须是 "and another"
```

第二例体现"单字符重叠"：`emitted="a"`, `chunk="and"` → `startswith` 不成立，最大重叠 `size=1`（`"a".endswith("a")`）→ 返回 `"nd"`，累积成 `"and"`；再 `chunk=" another"` 无重叠 → 追加，得 `"and another"`。

**注意截断的 `max_overlap = min(len(emitted), len(chunk))`**：只在较短的范围内找重叠，避免 O(n²) 退化得太厉害。该函数是 **O(min(len)·len)** 的最坏情形开销（每个分片都要做后缀比较），对长文本流是潜在热点；实践中因为第 3 步（`startswith`）命中就返回，正常纯增量走第 5 步不比较，所以只在可疑情况下才付出代价。

---

## 4. 归一化事件模型

`stream_chat_completion` yield 的 dict 共有 **5 种 `type`**：

| `type` | 字段 | 产生者 | 产生条件 | 语义 |
|--------|------|--------|----------|------|
| `"thinking"` | `thinking: str`（全文）、`signature: str` | **仅 Anthropic** | `content_block_stop` 且该 block 是 thinking 块 | 全量、一次性。`signature` 可能是 `""`（若 provider 未发 `signature_delta`） |
| `"reasoning"` | `content: str`（全文） | **仅 OpenAI 兼容** | 首个非空 text delta 之前，或流结束时兜底；每次流最多 1 个；要求 `reasoning_text` 非空 | 全量、一次性 |
| `"text"` | `content: str`（**增量**） | 两者 | Anthropic：每个 `text_delta`（含空串）。OpenAI：去重后非空的 `content` | 增量，调用方必须累加 |
| `"tool_use"` | `id: str`、`name: str`、`input: dict` | 两者 | Anthropic：`content_block_stop` 且 JSON 解析成功（失败静默丢弃）。OpenAI：arguments 可解析时立即发，或流尾 flush | `input` 已是解析后的 dict（不是 JSON 字符串） |
| `"incomplete_tool_call"` | `name: str`（**无 id、无部分参数**） | **仅 OpenAI 兼容** | 流结束时该 index 的 `name` 非空、`arguments` 非空、但 `json.loads` 失败 | 提示"输出被截断"，触发自动续写 |

对比两种协议的 `thinking` vs `reasoning`：**字段名不同**（`thinking`+`signature` vs `content`），下游在 query_engine 里显式分支处理（`query_engine.py:474-505`），并统一转成内部 thinking block：

- `thinking` 事件 → `thinking_blocks.append(event)`（直接复用事件 dict，因为它就是 `{"type","thinking","signature"}` 形状）；
- `reasoning` 事件 → `thinking_blocks.append({"thinking": event["content"], "signature": ""})`（补一个空 signature）。

两者都再 emit 一个 `TurnEvent(turn_id, "thinking", {"content": <全文>, "preview": <前200字符或全文>+...>})`，preview 规则：`文本[:200] + "..."` 当长度 > 200，否则原文（`query_engine.py:476-480`、`493-497`）。

**没有产生的事件（复刻时不要凭空加）**：没有 `start`/`stop`/`done` 事件，没有 `usage` 事件（usage 只通过 `usage_info` 出参传递），没有 `error` 事件（错误用异常抛出），没有 `stop_reason` 事件，没有 `tool_call_delta` 这种中间态事件。

**事件消费方**（复刻时必须同时实现这些语义）：

- `src/flyinchat/query_engine.py:469-531`（主循环）：`thinking`/`reasoning` → 累积 thinking blocks + emit；`text` → 累加 `text_content` + emit；`tool_use` → append 到 `tool_uses` + emit；`incomplete_tool_call` → 置 `had_incomplete_tool_call = True`（并 `logger.info`）。
- `src/flyinchat/subagents/executor.py:128-140`（子代理）：只认 4 种，**忽略 `incomplete_tool_call`**（`elif` 链没有该分支）。
- 结束状态转换由 query_engine 决定，不属于本层：
  - `tool_uses` 非空 → 执行工具并把 `{"type":"tool_use",...}` 与 tool 结果追加进 `api_messages`，进入下一轮（`query_engine.py:713+`）。
  - `tool_uses` 为空且 `had_incomplete_tool_call` 且 `incomplete_continue_count < max_incomplete_continues` → 追加 assistant 消息 + 一条 user 消息 `"Your last response was cut off mid-stream — the tool call JSON was incomplete. Please continue exactly where you left off and complete the tool call you started."`，然后 `continue` 自动续写（`query_engine.py:655-684`）。
  - `had_incomplete_tool_call` 但次数超限 → `finish("max_rounds", "incomplete_tool_call_limit_reached")`。

---

## 5. 工具 schema 转换

源：`src/flyinchat/tools/convert.py`（全文 31 行，逐字）：

```python
from __future__ import annotations

from typing import Any

from flyinchat.tools.core import Tool


def to_anthropic_tool(tool: Tool) -> dict[str, Any]:
    return {
        "name": tool.name,
        "description": tool.description,
        "input_schema": tool.input_schema(),
    }


def to_openai_tool(tool: Tool) -> dict[str, Any]:
    return {
        "type": "function",
        "function": {
            "name": tool.name,
            "description": tool.description,
            "parameters": tool.input_schema(),
        },
    }


def tools_to_api_format(tools: list[Tool], provider_type: str) -> list[dict[str, Any]]:
    if provider_type == "anthropic":
        return [to_anthropic_tool(t) for t in tools]
    return [to_openai_tool(t) for t in tools]
```

内部 `Tool` Protocol（`src/flyinchat/tools/core.py:67-80`）要求：`name: str`、`description: str`、`version: str`、`risk_level: str`、`input_schema() -> Dict[str, Any]`、`requires_permission(...)`、`async run(...)`。**转换只用到 `name` / `description` / `input_schema()` 三项**；`version` 与 `risk_level` **不发送给 provider**（它们只服务权限系统）。

逐字段映射：

| 内部 | Anthropic 请求体 `tools[i]` | OpenAI 请求体 `tools[i]` |
|------|------------------------------|---------------------------|
| `tool.name` | `name`（原样，无前缀/无改写） | `function.name` |
| `tool.description` | `description` | `function.description` |
| `tool.input_schema()` | `input_schema`（JSON Schema） | `function.parameters`（同一份 JSON Schema） |
| （无） | — | `type: "function"`（硬编码） |
| `version`、`risk_level` | 不发送 | 不发送 |

要点与不变量：

- **两个 provider 共用同一份 JSON Schema**，只是外层 key 名不同（`input_schema` vs `parameters`）。schema 由每个工具类自己实现 `input_schema()` 静态返回，形如：
  ```python
  # src/flyinchat/tools/file_tools.py:22-31
  {"type": "object",
   "properties": {
       "path": {"type": "string", "description": "File path under workspace root"},
       "offset": {"type": "integer", "minimum": 1, "default": 1},
       "limit": {"type": "integer", "minimum": 1, "maximum": 2000, "default": 200}},
   "required": ["path"]}
  ```
  即：手写 JSON Schema，**没有**从 Python 类型注解自动生成，没有 pydantic/dataclass 反射。参数级 `description`、`default`、`minimum`/`maximum` 由工具作者手写并原样透传。**必填项**用 JSON Schema 的 `required` 数组表达（不是 OpenAI 的 `strict`/`required` 布尔）。
- **不做名称净化**：`tool.name` 直接作为 provider 函数名。MCP 工具在注册时就带 `mcp_` 前缀（见 CLAUDE.md 的 MCP 说明），所以名字里的非法字符问题在更上层解决。
- **不排序**：`tools` 列表顺序 = `registry.tools` 的顺序。顺序影响 prompt caching 命中，复刻时保持稳定顺序（Python dict 保序）。
- **不做能力过滤**：本层不检查权限模式、不裁剪工具；权限在 `ToolExecutor` 里（属于另一子系统）。但也有例外路径：`provider_type` 不匹配时 Open 侧兜底（`else` 分支返回 OpenAI 格式），所以传 `"openai_compatible"`、`""`、`"foo"` 都得到 OpenAI 格式。
- 无测试覆盖 `convert.py`（全仓库无相关测试）。

---

## 6. 重试 / 超时 / 流中断

**本层完全没有任何重试。** 具体地：

| 场景 | 行为 |
|------|------|
| HTTP 4xx/5xx | 立即抛 `httpx.HTTPStatusError`（含 body 文本），不重试 |
| 连接/读取超时 | `httpx.Timeout(120.0)`（四项全 120s）到点抛 `TimeoutException`，不重试 |
| 流中途断开（`RemoteProtocolError`、`ReadError`、连接重置） | 异常从 `aiter_lines()` 冒出，不捕获、不重试。**已经 yield 的事件不会回滚**——调用方已累积的 text/tool_use 保留，但不会有 `incomplete_tool_call` 事件（因为该事件只在流正常结束后的 flush 里产生，异常路径不会走到那里）。这是"流中断时可能丢掉半个 tool call 且不触发自动续写"的根因 |
| Redis/网络瞬时抖动 | 无退避、无 jitter |
| 429 限流 | 不识别、不等待，直接当错误抛给用户 |

唯一的"重试"在**上层**（`query_engine.py:535-584`）：捕获异常后，若错误串命中上下文超限特征词且 `compact_retry_remaining > 0`（默认 `QueryEngineConfig.max_context_retries = 1`），则触发反应式压缩（`CompactionEngine.reactive_compact`），重建 `api_messages` 后 `continue` 重试该轮。特征词（任一命中，大小写敏感度不一，注意）：

```python
"context_length_exceeded" in error_str
or "413" in error_str
or "too long" in error_str.lower()
or "maximum context length" in error_str.lower()
```

`max_turns`/`max_tool_rounds` 层的"续写"（`incomplete_tool_call` 自动续写、auto-continue）不是网络重试，是模型输出层面的补偿，见第 4 节。

其他超时相关：**没有 SSE 级别的 keepalive / 心跳检测**，也没有 `ping` 事件处理（Anthropic 的 `{"type":"ping"}` 被忽略，靠 `aiter_lines` 的 read timeout 兜底）。

---

## 7. DeepSeek 预设的完整配置

`src/flyinchat/storage.py:20-41` 原文：

```python
@dataclass(frozen=True)
class ProviderPreset:
    id: str
    name: str
    provider_type: str
    base_url: str | None
    model_names: tuple[str, ...]
    context_window: int = 125_000
    max_output_tokens: int = 128_000


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

`create_preset_channel`（`storage.py:158-174`）把这些值喂给 `create_channel_with_models`（`storage.py:102-155`），生成的 channel/model 记录里：

- `provider_type="anthropic"` → 走 `_stream_anthropic`，认证头 `x-api-key`，URL = `https://api.deepseek.com/anthropic/v1/messages`。
- `base_url` 注意**不带尾部 `/`**，`rstrip('/')` 后仍是 `"https://api.deepseek.com/anthropic"`。
- `model_names` 顺序即 `is_default` 判定（`index == 0 and not has_primary_model`，`storage.py:133`）——**只有当前没有主模型时，第一个模型（`deepseek-v4-pro`）才成为默认**；已有主模型时两个新模型都是 `is_default=False`。
- 每个模型记录的固定字段（`storage.py:128-142`）：
  ```python
  "thinking_enabled": True,
  "reasoning_effort": "high",
  "context_window": 1_000_000,
  "max_output_tokens": 128_000,
  ```
  所以 DeepSeek 预设的默认行为是：**thinking 开启**（→ 请求体带 `{"type": "enabled"}`，但**不带** `budget_tokens`，因为 Anthropic 分支不读 `reasoning_effort`，也不计算 budget）；`reasoning_effort="high"` 被记录但**在 Anthropic 分支被忽略**（只有 OpenAI 分支会把它发出去）。
- 生成的模型列表返回前按 `(not is_default, name)` 排序（`storage.py:149-152`）。

**`max_output_tokens` / `context_window` 默认值的三处分歧（复刻时必须对齐，否则行为不同）**：

| 位置 | `context_window` | `max_output_tokens` |
|------|------------------|---------------------|
| `models.LLMModel` 数据类默认（`models.py:23-24`） | `125_000` | **`384_000`** |
| `storage.ProviderPreset` 默认（`storage.py:27-28`） | `125_000` | `128_000` |
| `storage.create_channel_with_models` / `add_llm_model` 参数默认（`storage.py:110-111`、`183-184`） | `125_000` | `128_000` |
| DeepSeek preset 显式值 | `1_000_000` | `128_000` |
| 旧 SQLite 行迁移回退（`storage.py:806-808`） | `125_000` | `128_000` |
| JSON 行读入时的兜底（`storage.py:868`） | `int(row["context_window"])`（必填） | `int(row.get("max_output_tokens", 384_000))` ← **384_000** |

注意最后一行：从 JSON 读行时 `max_output_tokens` 缺失会回退到 **384_000**，与写默认 128_000 不一致。复刻时要么统一，要么逐字保留。

`.env.example` 内容（`/Users/flyinsky/Documents/Coding/Python/FlyinChat/.env.example`，全文 11 行）：**没有**任何 LLM API key 环境变量。注释明确说明大多数设置存在 `~/.flyinchat/config.json`，并列出 Langfuse 的 `app_settings` key（`langfuse_enabled` / `langfuse_public_key` / `langfuse_secret_key` / `langfuse_host` / `langfuse_debug` / `agent_env` / `agent_version`）。也就是说：**api_key 只从 config.json 的 channel 记录读取，不从环境变量读**。配置文件路径由 `src/flyinchat/paths.py` 解析（`~/.flyinchat/config.json`）。

---

## 8. 关键不变量与易错点

### 8.1 编码与 UTF-8 分片

- **两种协议的流都用 `response.aiter_lines()`**：httpx 负责增量 UTF-8 解码与跨 TCP chunk 的字符/行拼接，并会剥离行尾 `\n`/`\r\n`。所以**本层不需要处理"多字节字符被切断"**——不要自己再套一层 `codecs.getincrementaldecoder`，否则会双重解码。
- 但 **`aiter_lines` 不会剥离 `\r` 在极老实现上的差异**，本层也没做 `line.rstrip()`，只用 `startswith("data: ")` 与 `line[6:]`。若 provider 用 CRLF 换行，httpx 的 lines 迭代器会把 `\r\n` 归一处理（`aiter_lines` 会去掉末尾换行）；`data_str` 里若残留 `\r`，`json.loads` 会因尾部空白失败吗？不会——JSON 允许尾部空白（`\r` 是合法空白），所以安全。
- **错误响应的解码**显式用 `errors="replace"`（`api_client.py:137`、`393`）：非法字节变 U+FFFD，绝不因解码失败掩盖原始的 HTTP 错误。
- `json.dumps(block["input"])` 走 `ensure_ascii=True`（默认），所以工具参数里的中文在请求体里是 `\uXXXX` 转义；而本地估算 token 用 `ensure_ascii=False`（`compact.py:76`）。两处口径不一致，但都各自正确（一处给 provider，一处给估算器）。

### 8.2 空 delta / 空值

| 场景 | 行为 | 风险 |
|------|------|------|
| Anthropic `text_delta` 且 `text == ""` | **仍 yield** `{"type":"text","content":""}` | 下游会 emit 空的 TurnEvent，TUI 可能多一次无意义刷新 |
| OpenAI `content == ""` | 被 `if content:` 拦住，不发 | 与 Anthropic 不一致 |
| OpenAI `content == "已发出的全文"`（快照式重复） | 去重后为 `""` → `if content_delta:` 拦住，不发 | 正确 |
| OpenAI `reasoning_content` 为空 | 不进 `reasoning_text` | 正确 |
| OpenAI chunk 只有 `role` 字段 | 被忽略 | 正确（首个 chunk 常见） |
| OpenAI `choices == []`（usage chunk 或 keepalive） | usage 先被捕获，然后 `continue` | 正确，但顺序不能反 |
| Anthropic `content_block_stop` 时 `json_fragments == []` | `json.loads("")` 失败 → **静默丢弃该 tool_use** | 无参工具调用会丢失（Anthropic 通常发 `"{}"`，所以少触发） |
| Anthropic tool_use 的 JSON 非法 | 静默 `pass`，**不产生 `incomplete_tool_call`** | 截断的 tool call 完全消失，不触发自动续写 |
| OpenAI 流尾条目 `arguments == ""` | **静默丢弃**（flush 条件要求两者都非空） | 无参工具调用在流尾丢失 |
| `usage_info` 为 `None` | 所有 usage 提取分支被跳过，Anthropic 分支的 `data["usage"]` 完全不读 | 无崩溃 |
| Anthropic usage 值为 `0` | `if inp:` / `if out:` 为假 → **不写入** | 不会用 0 覆盖已有值（有意为之） |

### 8.3 多 tool_call 并行与 index 乱序

- **OpenAI**：按 `index` 聚合，天然支持并行多工具与乱序到达；同一 chunk 的 `tool_calls` 列表可含多个条目，循环逐个归位。完成发射是"每 chunk 扫全表"，所以先完成的 index 先发射，**发射顺序可能不是 index 顺序**（取决于各自 JSON 何时变完整）。同 index 重复出现（乱序重发）会走 `entry["arguments"] += _dedupe_stream_delta(...)`。
- **Anthropic**：按 `index` 建块，`content_block_stop` 到达即完成并 `pop`；不同 index 独立累加，也支持并行。发射顺序 = stop 到达顺序（通常 = index 顺序）。**同一 index 重复 `content_block_start` 会覆盖**（`blocks[idx] = {...}` 是赋值），前面积累的 fragments 丢失。
- **共有的顺序不变量**：两种协议都**不重排、不后处理**，发射顺序即 provider 事件顺序。

### 8.4 协议间的行为不对称（复刻时最容易踩）

| 维度 | Anthropic | OpenAI 兼容 |
|------|-----------|-------------|
| system 处理 | 抽出到顶层 `system` 字段，`"\n\n"` 连接；空则不带 | 原样留在 messages 数组里 |
| 工具结果消息 | 攒批合并为一个 user 消息的 tool_result 块数组 | 每条独立 `role:"tool"` 消息 |
| 认证头 | `x-api-key` + `anthropic-version: 2023-06-01` | `Authorization: Bearer` |
| base_url 空 | 回落官方域名 | 拼出非法相对 URL，报错 |
| thinking 事件 | `{"type":"thinking","thinking","signature"}`，在 block stop 时全量 | `{"type":"reasoning","content"}`，在首个 text 前全量 |
| thinking 请求 | `{"type":"enabled"}`（**无 budget_tokens**） | `reasoning_effort` + `{"type":"enabled"}` |
| 工具完成判定 | `content_block_stop` 到达 | 累积 arguments 可被 `json.loads` |
| 解析失败 | 静默丢弃 | 流尾 yield `incomplete_tool_call` + warning |
| 去重 `_dedupe_stream_delta` | 不用 | 用于 content / reasoning_content / arguments |
| 4xx/5xx 异常链 | 保留（无 `from None`） | 抑制（`from None`），message 追加 body |
| usage key | 归一化成 `input_tokens`/`output_tokens` | 原样 `update`（`prompt_tokens`/`completion_tokens`/...） |
| 消息配对校验 | 有（`validate_tool_pairing`，会抛错） | 无 |
| 非流式 thinking/tools | 都不带 | 都不带（但 OpenAI 非流式**带** `max_tokens` 参数） |

### 8.5 其他

- **`usage_info` 是共享可变对象**，Anthropic 用覆盖式赋值、OpenAI 用 `update` 覆盖。多轮工具循环里 query_engine 每轮新建 `usage_info = {}`（`query_engine.py:454`），所以不会跨轮污染。
- **`response.aread()` 必须在流式错误路径调用**：不读干 body 会导致连接泄漏/httpx 报"response not read"。
- **`blocks.pop(idx)` 与 `tool_calls_by_index` 的删除必须发生在遍历之后**（两阶段），否则 `RuntimeError: dictionary changed size during iteration`。
- **`async for` 中的 `yield` 让本层成为真正的 async generator**：调用方 `break`（如取消，`query_engine.py:472-473`）会触发 generator 的 `aclose()`，`async with` 上下文随之退出并关闭连接。复刻时不要用同步生成器或把请求体整体读进内存。
- **无 `tools` 时绝不发送空 `tools: []`**：`if tools:` 守卫。某些 provider 对空数组会报错。
- **非流式的两条路径都不发 `tools`**：摘要调用不可能触发工具。
- **`max_tokens` 在非流式是函数参数（2048）**，在流式是 `model.max_output_tokens`——两个数字语义完全不同，别混。
- **本层不发 `stream_options`（Anthropic）**，Anthropic 协议的 usage 天然在 `message_start`/`message_delta` 里。
- **没有 prompt caching 的显式 `cache_control` 断点**：不发送任何 `cache_control` 字段。缓存完全依赖 provider 自动前缀缓存（DeepSeek 支持），这也是为什么**消息序列化的字节稳定性**（key 顺序、`ensure_ascii`、工具顺序）很重要。

---

## 9. 复刻检查清单

**接口层**
- [ ] `stream_chat_completion(channel, model, messages, usage_info=None, tools=None) -> AsyncIterator[dict]`，`usage_info` 是出参
- [ ] `chat_completion(channel, model, messages, *, max_tokens=2048) -> str`
- [ ] 分派用 `provider_type == "anthropic"`，其余落 OpenAI 兼容
- [ ] `tools=None` 与 `tools=[]` 都不发送 `tools` 字段

**HTTP 层**
- [ ] 每次调用新建 `httpx.AsyncClient(timeout=httpx.Timeout(120.0))`（四项 120s），无连接复用、无重试
- [ ] Anthropic：`x-api-key` + `anthropic-version: 2023-06-01` + `Content-Type`，`base_url.rstrip('/') + "/v1/messages"`，空 base_url 回落 `https://api.anthropic.com/v1/messages`
- [ ] OpenAI：`Authorization: Bearer`，`rstrip('/') + "/v1/chat/completions"`，空 base_url 不回落（会报错，需在配置层拦住）
- [ ] `>= 400` 时 `aread()` + `decode(errors="replace")[:2000]`，记 error 日志（含 url/status/model/error_body），抛 `httpx.HTTPStatusError`
- [ ] Anthropic 异常 message = `HTTP {status} {reason}\nURL: {url}\n{body}`；OpenAI = httpx 原文 + `\nAPI response: {body}` 且 `from None`

**Anthropic 请求体**
- [ ] `model` / `max_tokens=model.max_output_tokens` / `messages` / `stream: True`
- [ ] `system` 仅在非空时附带（`"\n\n".join` 所有 system 消息）
- [ ] `thinking: {"type": "enabled"}` 仅在 `model.thinking_enabled`，**无 `budget_tokens`**（对接官方 API 时需补，且需 `max_tokens > budget_tokens`）
- [ ] `tools: [{name, description, input_schema}]` 仅在 tools 非空
- [ ] 不发 temperature / top_p / top_k / stop_sequences / metadata / tool_choice / anthropic-beta

**Anthropic 转换与校验**
- [ ] system 抽出、空 content 跳过、`"\n\n"` 连接、无 system 时返回 `None`
- [ ] 连续 tool 结果攒批成一个 user 消息的 tool_result 数组，`tool_use_id` 从 `msg["tool_use_id"]` 取、缺失用 `""`
- [ ] user/assistant 的 str 与 list content 都原样透传（thinking 块带 signature 回传）
- [ ] `validate_tool_pairing` 在请求前调用，仅在 Anthropic 流式路径
- [ ] 缺 tool_result → 抛 `ToolPairError`；多余 tool_result → 只 warning
- [ ] 跳过中间 system 消息找配对（防御性）

**Anthropic SSE**
- [ ] 只认 `line.startswith("data: ")`，取 `line[6:]`，JSON 解析失败 `continue`，事件类型取 JSON 的 `type`
- [ ] `message_start`：usage 从 `message.usage`，回退 `data["usage"]`，归一化成 `input_tokens`/`output_tokens`（也接受 `prompt_tokens`/`completion_tokens`），falsy 值不写入
- [ ] `message_delta`：同上（顶层 `usage`）
- [ ] `content_block_start`：登记 thinking（`thinking`/`signature`）与 tool_use（`id`/`name`/`json_fragments`），text 不登记
- [ ] `content_block_delta`：`text_delta` 立即 yield（含空串）；`thinking_delta` 累加；`signature_delta` 赋值；`input_json_delta` append；index 不在 blocks 时静默丢弃
- [ ] `content_block_stop`：`pop(idx)`；thinking → yield 全量 thinking；tool_use → join 后 `json.loads`，成功 yield tool_use，失败**静默丢弃**（建议改为 yield `incomplete_tool_call`）
- [ ] 忽略 `message_stop` / `ping` / `error`（建议显式处理 `error`）
- [ ] 不提取 cache 相关字段（除非有意扩展）

**OpenAI 请求体**
- [ ] `model` / `messages` / `stream: True` / `stream_options: {"include_usage": True}` / `max_tokens` **和** `max_completion_tokens`（同值）
- [ ] `reasoning_effort` + `thinking: {"type":"enabled"}` 仅在 `thinking_enabled`
- [ ] `tools: [{type: "function", function: {name, description, parameters}}]` 仅在非空
- [ ] debug 日志字段：model / message_count / has_tools / thinking / reasoning_effort / max_tokens，不记消息体与密钥

**OpenAI 转换**
- [ ] system 原样留在数组
- [ ] tool → `{"role":"tool","tool_call_id":..., "content":...}`，每条独立
- [ ] assistant + list：thinking→`reasoning_content`（`"\n"` 连接，跳过空，丢 signature）；text→`content`（`"\n"` 连接，可为 `""`）；tool_use→`tool_calls[].function.arguments = json.dumps(input)`（默认 `ensure_ascii=True`）
- [ ] key 顺序：role, reasoning_content?, tool_calls?, content（content 永远存在且最后）
- [ ] assistant + str / 其他角色：原样透传

**OpenAI SSE**
- [ ] `data: ` 前缀；`data_str.strip() == "[DONE]"` → break
- [ ] **先** `usage_info.update(data["usage"])`（要判 `is not None`），**再** 判 `choices` 空则 continue
- [ ] `finish_reason` 只用于日志（`length` 加 warning）
- [ ] `reasoning_content` 累积 + 去重，**不增量 yield**；在首个非空 text delta 前一次性 yield 全量 `reasoning`；流结束兜底补发
- [ ] `content` 去重后非空才累加与 yield
- [ ] `tool_calls` 按 `index` 聚合，`id`/`name` 赋值（非空才覆盖），`arguments` 去重后拼接
- [ ] 每 chunk 扫描全表，arguments 可 `json.loads` 即 yield `tool_use` 并删除该 index（两阶段删除）
- [ ] 流尾 flush：`name` 且 `arguments` 非空 → 解析成功 yield tool_use；失败 warning（`partial_args` 截 200 字）+ yield `incomplete_tool_call`（仅含 name）
- [ ] 考虑修复：arguments 为空但 name 非空 → 发 `input: {}`；以及"过早发射导致参数截断"的竞态

**去重函数**
- [ ] `_dedupe_stream_delta(emitted, chunk)`：空 chunk → `""`；空 emitted → chunk；`chunk.startswith(emitted)` → 去前缀；否则从 `min(len(emitted), len(chunk))` 递减找 `emitted.endswith(chunk[:size])`；无重叠 → 原 chunk
- [ ] 通过两个测试向量：10 个中文快照分片 → `"你好！很高兴见到你。我是 ** Claude**，由 Anthropic 开发"；`"a","and"," another"` → `"and another"`

**事件模型**
- [ ] 恰好 5 种 type：`thinking`(Anthropic) / `reasoning`(OpenAI) / `text` / `tool_use` / `incomplete_tool_call`(OpenAI)
- [ ] `tool_use.input` 是 dict 而非 JSON 字符串；`id`/`name` 可能为空串（Anthropic 无参调用场景除外）
- [ ] 无 usage 事件（走出参）、无 start/stop/done 事件、无 error 事件
- [ ] `text` 是增量、`thinking`/`reasoning` 是全量一次性

**非流式**
- [ ] `_openai_chat`：`stream: False` + `max_tokens`（参数），无 stream_options / thinking / tools；`raise_for_status()` 后取 `data["choices"][0]["message"]["content"]`（建议 `or ""`）
- [ ] `_anthropic_chat`：`stream: False` + `max_tokens`（参数）+ 可选 system，无 thinking/tools；返回**第一个** text 块，无 text 块返回 `""`

**配置**
- [ ] DeepSeek preset 逐字：`provider_type="anthropic"`、`base_url="https://api.deepseek.com/anthropic"`、模型 `("deepseek-v4-pro", "deepseek-v4-flash")`、`context_window=1_000_000`、`max_output_tokens=128_000`
- [ ] 新建模型固定 `thinking_enabled=True`、`reasoning_effort="high"`，`is_default` 仅给第一个且仅在无主模型时
- [ ] api_key 只来自 config.json，不读环境变量
