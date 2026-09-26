# 09 — 跨实现 Agent 建设标准

本文是面向新实现的**规范层**。`01..08` 主要记录旧 Python 项目的实际行为，其中包含硬编码、历史兼容和已知缺陷；本文件规定 TypeScript Agent 的目标行为。二者冲突时：为了旧会话兼容，读取旧数据按 `01..08`；新代码、协议和新增数据按本文件。

目标是：更换客户端（TUI、CLI、Web）、更换模型（Anthropic、OpenAI 兼容、本地模型）后，仍能得到相同的状态迁移、权限语义、工具结果和恢复行为。

## 1. 必须遵守的运行时边界

Agent 内核不得依赖 TUI、具体 SDK 或 Langfuse。所有外部能力通过接口注入：

```ts
interface ModelProvider { stream(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>; }
interface Tool { descriptor: ToolDescriptor; validate(input: unknown): ValidationResult; execute(ctx: ToolContext, input: unknown): Promise<ToolResult>; }
interface EventSink { append(event: RuntimeEvent): Promise<void>; }
interface ApprovalService { request(req: PermissionRequest): Promise<PermissionDecision>; }
```

UI 只能发送 `UserMessage`、`CommandRequest`、`PermissionResolution`、`CancelRequest`，只能消费事件流。不得直接修改会话、权限或工具状态。

## 1.1 Web UI 运行模式

Web UI 是与 TUI 并列的表现层，不得复制 QueryEngine、ToolExecutor 或 PermissionEngine。启动入口统一为：

```text
agent [options] --web-ui
  --port <1-65535>                 默认 3210
  --listen <local|lan|public>      默认 local
  --host <address>                 可选；必须符合 listen 策略
  --auth <none|token|password>     local 默认 none；lan/public 默认 token
  --token <value>                  可选；未提供时启动时生成并只显示一次
  --cors <origin[,origin...]>      默认仅同源
```

`--web-ui` 只改变展示和传输层，不改变模型、工具、权限、skill、compact 或 sub-agent 语义。无 `--web-ui` 时保持 TUI/CLI 默认行为。

### 监听范围和安全默认值

| 模式 | 默认绑定地址 | 允许地址 | 认证要求 | 适用范围 |
|---|---|---|---|---|
| `local` | `127.0.0.1`（IPv4）和 `::1`（IPv6） | 仅 loopback | 默认 none；可显式启用 token | 本机浏览器 |
| `lan` | `0.0.0.0` / `::` | 局域网网卡；拒绝公网接口 | token | 同一局域网 |
| `public` | `0.0.0.0` / `::` | 所有接口 | token 或 password，禁止 none | 明确承担公网暴露责任 |

默认必须是 `local`。`--host` 不能扩大 `--listen` 权限：local 只允许 loopback；lan 只允许内网 RFC1918、RFC4193 和本机网卡地址；public 才允许任意可用地址。解析 DNS 名称后必须校验最终 IP，防止通过名称绕过限制。监听失败、地址不符合策略或端口被占用时应直接退出并给出原因，不能自动降级到更宽松地址。

`--port 0` 默认禁止；如果实现支持随机端口，必须显式使用 `--port 0`，并在终端打印最终端口。Web server 应设置请求体上限、WebSocket 消息上限、连接数上限、空闲超时和优雅关闭超时。

### HTTP/WebSocket 协议

浏览器只通过 HTTP API 和 WebSocket 访问运行时：

```text
GET  /                         静态 Web UI
GET  /api/health               不泄露配置、密钥或文件路径
GET  /api/sessions             当前用户可见会话
POST /api/sessions/:id/turns  提交用户消息
POST /api/commands             执行 slash command
POST /api/permissions/:id      提交 allow/deny
POST /api/turns/:id/cancel     取消 turn
GET  /api/events               SSE 可选实现
WS   /api/stream               实时事件流
```

所有写操作都需要 `Idempotency-Key`；服务器以 `requestId`、`sessionId`、`turnId` 和 `eventId` 返回结果。WebSocket 重连必须支持 `lastEventId`，服务器从持久化事件日志补发，不能只依赖内存队列。事件顺序按 session 保证；不同 session 可以并发。

Web UI 不得接收完整 API key、MCP 环境变量、绝对路径 secrets 或未经脱敏的工具参数。错误消息应返回稳定的错误码和用户可读信息，服务端日志再记录详细诊断。

### 认证、授权和浏览器安全

`local` 默认无需 token，浏览器可直接进入；同源 Origin 校验仍须阻止其它网页跨端口调用。显式 `--auth token` 或 `--token` 可启用本机认证。token 使用高熵随机值，终端只显示一次；不允许把 token 放在 URL、日志、Referer 或 HTML 中。优先使用 `Authorization: Bearer`，WebSocket 通过受保护的握手或短期 ticket 认证。

默认 CORS 仅允许同源，禁止 `*` 与 credentials 同时使用。启用局域网或公网模式时必须设置严格的 `Origin` 校验、CSRF token、`SameSite` cookie（如使用 cookie）、安全响应头和速率限制。公网模式启动时打印明确警告，并拒绝 `--auth none`；生产部署仍应放在 TLS 反向代理之后。

认证只解决“谁能连接”，权限仍由 Agent 的 `PermissionEngine` 决定。每个 Web 用户映射到独立 `principalId`；会话、权限请求和事件都必须校验该 principal，不能只凭 URL 中的 session id 访问。

### 生命周期和并发

Web server 启动顺序为：加载配置 → 初始化 storage/event log → 初始化 provider/tools/skills/MCP → 绑定监听 → 输出访问地址。任何必需组件初始化失败都不能启动一个“半可用”服务。

同一 session 默认只允许一个 active turn；第二个请求返回 `SESSION_BUSY`，除非显式启用并发会话。多个浏览器标签页可以订阅同一个事件流，但只有拥有该 session 权限的 principal 可以提交消息或解决审批。服务关闭时先拒绝新请求，再向活动 turn 发送 cancel，等待有限时间后持久化恢复信息并退出。

### CLI 示例和验收

```bash
agent --web-ui                         # 本机 loopback:3210，无需 token
agent --web-ui --port 8080             # 仍仅本地可访问
agent --web-ui --listen lan --port 8080
agent --web-ui --listen public --auth password --port 443
```

至少验证：默认端口和 loopback 绑定；lan/public 地址策略；不允许 public + `--auth none`；端口冲突和非法 host 直接失败；HTTP 与 WebSocket 重连补事件；权限请求可在浏览器解决；刷新页面不会重复提交 turn；Web UI 与 TUI 同时连接时事件、权限和取消语义一致。

## 2. Turn 状态机和幂等

每个 turn 必须有持久化的状态机：

```ts
type TurnPhase = "starting" | "building_context" | "calling_model" |
  "awaiting_permission" | "executing_tools" | "compacting" |
  "finalizing" | "completed" | "cancelled" | "failed";
```

所有迁移必须校验 `from -> to`，记录 `turnId`、`reason`、时间和 `eventId`。`TurnResult` 必须区分 `completed`、`partial`、`cancelled`、`failed`、`budget_exceeded`、`context_exceeded`。

工具调用必须有持久化执行记录，使用 `toolCallId + inputHash` 去重。provider 超时后只能重试模型请求；工具状态为 `unknown` 时不得自动重放不可幂等操作。批准、执行、结果写入都必须是幂等操作。

所有异步边界使用 `AbortSignal`。取消必须中断 provider 流、子进程、MCP 请求和等待审批，并写入 `cancelled` 事件；取消后的 turn 不得自动续跑。

## 3. 统一预算

所有模型调用、工具调用、子代理和压缩共享一份预算：

```ts
interface AgentBudget {
  maxModelCalls: number; maxToolCalls: number; maxWallTimeMs: number;
  maxInputTokens: number; maxOutputTokens: number; maxCost?: number;
}
```

每次消耗都写事件。局部硬编码的 `3`、`10`、`8000` 等必须移入配置，并在父子代理之间明确传递和扣减。

## 4. Context 和 Compact

模型请求必须使用结构化 `ContextEnvelope`，不能通过扫描 system message 重建状态：

```ts
interface ContextEnvelope {
  system: SystemPrompt; conversation: ApiMessage[];
  compact?: CompactSummary; tools: ToolDescriptor[]; runtime: RuntimeState;
}
```

`CompactBoundary` 使用版本化 schema，至少包含 `boundaryId`、被摘要 message ids、保留 message ids、summary id、压缩前后 token 数和策略。压缩必须保护用户约束、未完成任务、待执行工具、权限决定、文件变更和已应用 skill；这些内容进入不可压缩的 `WorkingMemory`。

Token 预算必须预留输出 token、工具 schema 和 system prompt；估算器按 provider/model 可替换，并记录估算误差。压缩后必须重新生成完整 system、tools 和 runtime，不得丢失 mode、skill guard 或权限状态。

## 5. 权限和安全

所有工具只能经过一个 `PermissionEngine.decide()`：

```ts
interface PermissionDecision {
  action: "allow" | "ask" | "deny"; reason: string; policyId: string;
  risk: "low" | "medium" | "high" | "critical"; scope?: GrantScope;
}
```

决策顺序固定为：工具策略 → 参数策略 → workspace/session 策略 → skill guard → 风险策略。`ask` 必须先创建可恢复的持久化请求；超时、取消和 UI 不可用均按 deny 处理。allow-once、tool、server、workspace、session 授权必须有明确 scope 和过期时间。

文件操作使用 realpath、允许根目录和原子替换；写入前保存 hash，检测外部修改后拒绝覆盖。Shell 命令应解析为结构化命令和重定向，不能只依赖字符串黑名单。高风险操作默认 Deny，并显示脱敏参数和二次确认。

## 6. Slash command

Slash command 是独立的 `CommandRegistry`，与 TUI 无关。每个命令声明参数 schema、是否打断当前 turn、权限、审计事件和幂等策略。命令执行结果进入 transcript；修改项目文件的命令必须支持预览、原子写和失败回滚。

### 6.1 `/workwith`：显式指定模型继续工作

`/workwith` 用于让用户为下一项任务显式选择某个模型：

```text
/workwith <provider-name>/<model-id> <instruction>
```

示例：

```text
/workwith deepseek/v4-flash 接下来完成计划里的实现
/workwith openai/gpt-6-astra 扫描目前工程设计并优化缺陷
```

解析规则：

1. 命令名大小写不敏感，但 provider name 和 model id 按配置中的规范值匹配；
2. 第一个空白分隔的参数必须是完整的 `provider/model` 引用；
3. provider 名称中允许短横线、下划线和空格，展示名有空格时使用引号或配置生成的 canonical slug；
4. 指令部分保留原始文本，不经过 shell 解析；
5. 缺少模型引用或指令为空时返回 `INVALID_COMMAND_ARGUMENTS`，不得提交模型请求。

模型解析使用稳定的 `providerId + modelId`，展示名称只用于输入和 UI。若存在多个相同展示名称，必须提示用户使用唯一 canonical 引用；不能随机选择。

`/workwith` 的作用域是**当前会话的下一项任务**：命令创建一个 `ModelOverride`，绑定到紧随其后的 user instruction，并写入同一 turn 的 `TaskIntent`。该 override 不会永久修改全局档位，也不会影响其他会话。若用户想继续使用同一模型，必须再次使用 `/workwith`，或者在 UI 中显式设置会话级 override。

```ts
interface ModelOverride {
  overrideId: string;
  scope: "next-turn" | "session";
  providerId: string;
  modelId: string;
  requestedBy: string;
  instruction: string;
  createdAt: string;
  expiresAfterTurnId?: string;
}
```

执行前必须检查：模型存在、provider enabled、secret 可用、模型 enabled，以及任务所需能力（例如需要工具时 `supportsTools=true`）。检查失败返回明确错误码，不得静默回退到全局档位。连接失败或暂时性 5xx 可以依照该模型配置的 fallback 策略重试，但必须记录 `model_route_changed`；用户明确指定的模型不能因为成本或默认档位被替换。

`/workwith` 本身不绕过权限、skill guard、预算、compact 或子代理限制。指令仍然作为普通用户任务进入 transcript；模型引用、路由决策、能力校验和最终使用的模型写入审计事件。若当前 turn 正在运行，命令默认返回 `SESSION_BUSY`；只有先取消当前 turn，或命令声明 `interrupt=true` 并经用户确认后，才能建立 override。

推荐事件：`command_received`、`model_override_created`、`model_capability_checked`、`model_route_changed`、`workwith_turn_started`。前端应显示“本次任务使用 provider/model”，避免用户误以为全局档位已被修改。

## 7. Sub-agent 标准（重点）

### 7.1 数据模型

```ts
interface SubAgentDefinition {
  type: string; version: string; description: string;
  allowedTools: string[]; deniedTools: string[];
  contextPolicy: "minimal" | "project-aware" | "file-focused" |
    "conversation-aware" | "full-parent-summary";
  runMode: "foreground" | "background" | "parallel";
  resultContract: ResultContract;
  workingDirectoryPolicy: "parent" | "isolated" | "readonly";
  budget: Partial<AgentBudget>;
}

interface SubAgentSession {
  sessionId: string; parentSessionId: string; parentTurnId: string;
  agentType: string; definitionVersion: string; status: string;
  visibility: "private" | "summary" | "full";
  contextSnapshotHash: string; continuationHandle?: string;
}
```

定义加载顺序为 workspace > user > builtin；同名必须报冲突并拒绝启动，不能静默覆盖。启动时固定 definition 和 skill snapshot，后续文件变化只影响新 session。

### 7.2 权限、上下文和目录

子代理权限必须是父权限与定义权限的交集：

```text
childPermission = parentPermission ∩ definitionPermission ∩ runtimePolicy
```

子代理不得获得父代理没有的 workspace root、写权限、网络权限、MCP 工具或预算；默认禁止递归 `sub_agent`，除非 definition 明确允许且仍受深度上限约束。

`minimal` 只传任务和必要约束；`project-aware` 增加项目元数据；`file-focused` 增加指定文件；`conversation-aware` 增加父 turn 摘要；`full-parent-summary` 增加结构化 working memory。不得把父 transcript 全量注入模型。

`isolated` 工作目录必须由 runtime 创建并在结束时记录变更；`readonly` 在操作系统权限和 Tool Gate 两层禁止写入；`parent` 必须启用外部修改检测。

### 7.3 执行、并发和恢复

foreground 阻塞父 turn；background 返回 `subagent_session_id`，通过事件更新；parallel 必须有并发上限、独立预算和取消传播。父 turn 取消时默认取消全部子代理，除非明确声明 detached。

每个子代理都复用同一套 Turn 状态机和 Tool Executor，但使用独立 session/transcript。`continuationHandle` 必须能恢复子代理状态、definition version、working directory、working memory 和剩余预算；不能只保存一段文本。

### 7.4 结果契约

```ts
interface SubAgentResult {
  status: "completed" | "partial" | "failed" | "cancelled";
  summary: string; findings: Finding[]; changes: FileChange[];
  evidence: Evidence[]; unresolved: string[];
  sessionId: string; continuationHandle?: string;
}
```

`partial` 是正常结果，不得伪装成失败。父上下文只接收该结构化摘要和必要证据；子代理内部 tool call 默认 `visibility=private`，不得污染父 transcript。结果压缩不得删除文件路径、验证命令、失败原因和未解决事项。

## 8. MCP 和可观测性

每个 MCP server 有独立连接、超时、重连、熔断和工具映射；禁止同名 server。工具到 server 使用显式 map，不能通过 `startswith` 删除。连接应并发但相互隔离，能力协商失败只影响当前 server。

本地结构化事件日志是必需的，Langfuse 只是 exporter。每个事件至少关联 `sessionId`、`turnId`、`toolCallId`、`subagentSessionId`、`policyId` 和耗时；敏感参数默认脱敏。

## 9. 模型接入与场景路由

### 9.1 只支持 Anthropic Messages API

新实现只实现一种线上协议：Anthropic Messages API 的请求、流式事件、tool use、thinking、usage 和错误归一化。供应商不是协议类型，而是一个 Anthropic-compatible endpoint。不得在核心 runtime 中加入 OpenAI Chat Completions、Responses 或供应商专属分支；需要兼容其他模型时由供应商负责提供 Anthropic 格式转换。

添加供应商时必须填写：

```ts
interface Provider {
  id: string;                 // 稳定 UUID，不使用名称作为主键
  name: string;               // 用户可读名称
  baseUrl: string;            // Anthropic API 根地址
  apiKeyRef: SecretRef;       // 默认保存 secret store 引用；value 是显式本地明文模式
  createdAt: string; updatedAt: string;
}
```

`baseUrl` 必须规范化，客户端在其上拼接 `/v1/messages`；不能把完整 endpoint 和 base URL 混用。
`SecretRef.source = "value"` 允许用户明确选择把明文保存在全局 `config.json`，但该值不得复制到
`chat.json`。无论来源如何，API key 都不得出现在日志、事件、导出文件、URL 或前端响应中。
连接测试必须验证鉴权、流式响应、tool use 和 usage，而不是只发一个普通文本请求。

一个 provider 可以添加多个模型：

```ts
interface ModelProfile {
  id: string;                 // provider 内模型标识，如 claude-sonnet-...
  providerId: string;
  displayName?: string;
  contextWindow: number;
  maxOutputTokens: number;
  supportsThinking: boolean;
  supportsTools: boolean;
  supportsVision: boolean;
  supports1MContext: boolean;
  inputCostPerMillion?: number;
  outputCostPerMillion?: number;
  enabled: boolean;
}
```

模型展示名称统一为 `providerName/modelId`；同名模型也必须通过 provider 前缀区分。模型配置变更不能修改已有会话的行为：每个 turn 开始时保存 `providerId`、模型 id、能力快照、context window、max output 和路由档位。

### 9.2 1M 上下文能力

“支持 1M 上下文”是模型能力声明，不是简单的 UI 开关。只有同时满足以下条件才可标记 `supports1MContext=true`：供应商 endpoint、模型、账户权限和当前 API 版本均确认支持；连接测试或官方配置提供最大 context window；请求时实际发送的 `context_window` 不超过该值。

若用户关闭 1M，模型使用标准 context window；若开启但模型不支持，必须在保存或选择时拒绝，不能静默降级。实际 context budget 还要扣除 system prompt、tool schema、输出预留和 provider 限制。1M 模式下必须启用 compact 预检和 tool result 截断，不能因为窗口变大而取消压缩。

### 9.3 全局模型档位

系统提供固定的工作场景档位，用户只为档位选择具体模型，不在代码中预设模型品牌：

```ts
type ModelTier = "exploration" | "planning" | "implementation" |
  "writing" | "review" | "fast";

interface TierAssignment {
  tier: ModelTier;
  modelRef: { providerId: string; modelId: string };
  enabled: boolean;
  fallbackModelRefs: Array<{ providerId: string; modelId: string }>;
  maxCostPerTurn?: number;
}
```

推荐语义如下：

| 档位 | 用途 | 默认倾向 |
|---|---|---|
| `exploration` | 读取代码、搜索、收集事实、快速试探 | 低成本、低延迟 |
| `planning` | 分析约束、拆解任务、制定方案和风险判断 | 高能力、允许 thinking |
| `implementation` | 修改代码、调用工具、执行验证 | 中高能力、稳定 tool use |
| `writing` | 文档、注释、提交信息、长文本整理 | 语言质量和成本平衡 |
| `review` | 审查 diff、寻找缺陷、安全检查 | 高准确度、只读优先 |
| `fast` | 标题、分类、简单改写、UI 辅助 | 最低延迟和成本 |

档位只是策略名称，不能在代码里绑定具体模型。用户可以让 `planning` 使用高智商模型、`exploration` 使用廉价模型、`implementation` 使用中等模型；保存配置时必须校验模型存在、已启用且能力满足该档位要求（例如 implementation 必须 supportsTools）。

### 9.4 路由决策

每次模型调用都带有不可变 `TaskIntent`：

```ts
interface TaskIntent {
  tier: ModelTier;
  purpose: "explore" | "plan" | "implement" | "write" | "review" | "fast";
  requiresTools: boolean; requiresThinking: boolean;
  estimatedInputTokens?: number;
}
```

路由顺序固定为：显式 turn override → 子代理 definition → skill policy → 当前任务 intent → 全局 tier assignment → fallback。模型调用前必须验证能力；不满足时按 fallback 顺序选择，全部不可用则返回明确的 `MODEL_CAPABILITY_UNAVAILABLE`，不能悄悄改用另一档。

一次用户任务可以分阶段使用不同档位。例如：exploration 收集事实，planning 生成结构化计划，implementation 执行修改和测试，review 做只读审查。阶段切换必须写入 transcript，保留每阶段的 model snapshot；不能在同一个 provider 请求中隐式切换模型。

### 9.5 成本、失败和 fallback

fallback 只在连接失败、429、暂时性 5xx、模型能力不足时触发；不得在工具执行失败、权限拒绝或模型输出质量不足时自动换模型重放。切换模型后必须重新构建请求并写 `model_route_changed` 事件。

每个 turn 记录 provider、模型、档位、输入/输出 token、估算成本、重试和 fallback 原因。用户禁用某模型后，已有会话仍可恢复其历史 snapshot，但新 turn 必须重新路由；secret 失效时要在 UI 中显示 provider 级错误。

## 10. 跨模型验收标准

实现必须用至少一个 Anthropic 风格 provider、一个 OpenAI 兼容 provider 和一个不支持 thinking 的模型验证：同一 transcript 产生等价的 tool call/result、权限决策、compact boundary 和最终状态。必须覆盖取消、断电恢复、provider 重试、工具超时、权限超时、子代理 partial、MCP 重连和文件外部修改检测。
