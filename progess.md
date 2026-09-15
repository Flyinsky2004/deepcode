# Agent 实现进度与计划

本文是 TypeScript 本地 Agent 的实施清单。每个阶段完成后才能进入下一阶段；如果实现与旧 Python 行为冲突，兼容读取按 `docs/rewrite-spec/parts/01..08`，新协议按 `docs/rewrite-spec/parts/09-typescript-agent-standard.md`。

**已冻结的决策不在此重复**：工具链选型见 `docs/adr/0001-engineering-stack.md`，
契约层的命名约定、状态机、事件集合、规格冲突取舍见 `docs/adr/0002-core-contracts.md`。
改动这些决策前先读 ADR。

## 当前状态

- [x] 完成旧项目规格阅读和缺陷盘点
- [x] 增加跨实现 Agent 标准
- [x] 增加 Web UI 启动、监听和安全规范
- [x] 增加 Anthropic-only provider、模型档位和 `/workwith` 规范
- [x] 建立 TypeScript 工程骨架（Phase 0 完成，含 `src/core` 全部契约；见下方 Phase 0 段落）
- [x] 实现运行时核心（Phase 1–5）
- [x] 实现模型、工具、权限和持久化（Phase 1–5）
- [x] 实现 TUI / Web UI（见下方「Phase 7 已完成」段）
- [ ] 实现 Skill、Sub-agent、MCP
- [ ] 完成跨模型和恢复测试

## 设计约束

1. Agent 内核不得依赖 TUI、Web 框架、具体模型 SDK 或 Langfuse。
2. 新模型接入只支持 Anthropic Messages API 格式。
3. 所有工具都经过统一 `PermissionEngine`，不能由 UI 或模型调用直接绕过。
4. 所有 turn、tool call、权限请求和 compact boundary 都必须可恢复。
5. 所有异步操作都支持 `AbortSignal`。
6. 新增能力必须有结构化事件、稳定错误码和幂等语义。

## Phase 0：工程骨架和契约冻结

### 目标

建立可被 TUI、Web UI、测试和未来客户端共同使用的纯 TypeScript runtime。

### 工作项

- [x] 配置 TypeScript、ESM/CJS 策略、lint、format、test、build（纯 ESM + Vitest + pnpm；选型理由见 `docs/adr/0001-engineering-stack.md`）
- [x] 建立 `src/core`（其余目录按 Phase 顺序落地，见 README 目录结构说明）
- [x] 定义 ID、时间、错误码、事件、结果和 schema 工具
- [x] 定义 `ModelProvider`、`Tool`、`EventSink`、`ApprovalService`
- [x] 定义 `Session`、`Turn`、`Message`、`WorkingMemory`、`AgentBudget`
      （`Conversation` / `TurnResult` / `ContextEnvelope` 一并冻结；契约决策见 `docs/adr/0002-core-contracts.md`）
- [x] 所有外部输入使用 runtime schema 校验（Zod；读入容错策略见 `src/core/schema.ts`）

### 验收

以下三项均已由 `tests/acceptance/phase0.test.ts` 写成可执行断言（`pnpm check` 会跑）：

- [x] `npm test` 可运行（`pnpm test` 与 `npm test` 均已验证；`pnpm check` 另含 typecheck/lint/format）
- [x] 不依赖 TUI 即可 import runtime（静态扫描 import + 真实 import 双重验证；
      探针实测：注入 `node:fs` 依赖后该验收项会失败）
- [x] 所有公共协议都有单元测试和序列化测试（15/15 模块有同名测试文件；
      往返测试见 `tests/core/serialization.test.ts`）

当前规模：19 个测试文件、264 个测试；`pnpm check` 已通过。全量覆盖率命令仍低于 80% 门槛（后续质量门禁阶段继续补齐）。

### Phase 0 产出物

| 位置 | 内容 |
|---|---|
| `src/core/`（15 个模块） | 品牌类型与 ID、时间与可注入时钟、错误码与分类、Result、统一预算、事件信封与 `EventSink`、Zod 校验基础设施、CJK 感知 token 估算、领域模型、Turn 状态机与 13 种事件、工具与权限契约、Provider 契约、`ContextEnvelope` 与 `WorkingMemory`、取消传播 |
| `tests/core/`（15 个文件） | 每个模块一个同名测试文件 |
| `tests/acceptance/phase0.test.ts` | 把上述三项验收写成可执行断言 |
| `tests/core/serialization.test.ts` | 持久化实体的序列化往返（验收明列项） |
| `docs/adr/0001`、`0002` | 工具链选型；契约冻结决策与规格冲突取舍 |

### Phase 0 的三处有意偏离（务必先读再动手）

1. **数据目录为 `.deepcode`**，不与旧项目 `.flyinchat` 共用（ADR 0001 决策 7）。
   文件内部结构仍逐字兼容，但路径不同——`parts/01` 里写的 `~/.flyinchat/...`
   应理解为 `.deepcode` 下的对应文件。
2. **`TurnPhase` 迁移表是本实现推导的**，规格全文未给迁移边（ADR 0002 §5）。
   若 `parts/09` 后续补充官方迁移表，以官方为准并更新。
3. **已移除 `reasoning` 与 `incomplete_tool_call` 事件**（ADR 0002 §3）。
   连带后果：`incomplete_tool_call_limit_reached` 终止路径不可达。
   若将来重新支持 OpenAI 兼容端点，需一并加回。

## Phase 1：存储、事件和恢复（已实现）

> 基础存储、原子写入、跨进程锁、事件去重和本地恢复扫描已落地。

### 工作项

- [x] 实现 provider/model/tier 全局配置文件
- [x] 实现 workspace session 和 transcript 存储
- [x] 使用临时文件、fsync、rename 实现原子写入
- [x] 实现 append-only runtime event log
- [x] 实现 schema version 和迁移入口
- [x] 实现 active messages、compact boundary、tool execution record 查询
- [x] 记录 `sessionId`、`turnId`、`toolCallId`、`principalId`、`subagentSessionId`

### 验收

- 写入过程中进程退出不会损坏配置或 transcript
- 重启后可以恢复未完成 turn、pending permission 和 unknown tool execution
- 重复写入相同 event/request 不产生重复状态

## Phase 2：Provider、模型和档位（已实现）

> Anthropic SSE、SecretRef、路由、能力校验和暂时性故障 fallback 已落地；真实官方 endpoint 验收仍需用户凭据。

### 工作项

- [x] 只实现 Anthropic Messages API 请求和 SSE 流
- [x] 实现 provider 配置：name、baseUrl、secret reference
- [x] 实现一个 provider 多模型
- [x] 实现 `provider/model` canonical reference 和展示名
- [x] 实现模型能力声明：tools、thinking、vision、1M context、token limits
- [x] 实现连接测试和 secret 校验
- [x] 实现 exploration、planning、implementation、writing、review、fast 档位
- [x] 实现 capability check、预算和 fallback
- [x] 每个 turn 固定 model snapshot

### 验收

- [ ] 至少通过一个 Anthropic 官方 endpoint 和一个 Anthropic-compatible endpoint（需要真实凭据；当前有本地 HTTP/SSE 夹具测试）
- 同一模型可以被多个档位引用
- 1M 不支持时不能静默降级
- fallback 只对网络、429、暂时性 5xx 和 capability failure 生效

## Phase 3：Turn 状态机和 Agent Loop（已实现）

> 本地模型→工具循环、预算、取消、审批等待恢复、持久化 pending/unknown 执行和 fallback 已落地。

### 工作项

- [x] 实现 `starting → building_context → calling_model → ...` 状态迁移
- [x] 实现 user message、assistant text、thinking、tool call/result 的持久化
- [x] 实现统一 provider event normalization
- [x] 实现工具循环、最大调用次数、wall time、token 和 cost budget
- [x] 实现 AbortSignal 取消传播
- [x] 实现模型重试、跨 provider fallback 与工具执行重放保护
- [x] 实现 `TurnResult`：completed、partial、cancelled、failed、budget_exceeded、context_exceeded

### 验收

- user → model → tool call → permission → tool result → final 的完整链路可恢复
- cancel 后不再自动续跑
- provider 重试不会重复执行不可幂等工具
- 同一 session 同时提交第二个 turn 返回 `SESSION_BUSY`

## Phase 4：工具协议和权限（已实现）

> 内置工具、统一五层门控、路径真实路径检查、write-ahead 执行记录和进程组清理已落地。

### 工作项

- [x] 实现 ToolDescriptor、input validation、ToolResult、结构化错误码
- [x] 实现 ToolRegistry 版本号和动态 catalog
- [x] 实现统一 PermissionEngine
- [x] 实现 tool、parameter、workspace、session、risk 五层决策
- [x] 实现持久化 permission request、allow scope、过期和恢复
- [x] 实现 AbortSignal、timeout、output limit、unknown execution
- [x] 实现 file read/write/edit、glob、grep、bash、todo、ask user
- [x] 文件写入实现 hash 检查、备份、原子替换和回滚

### 验收

- plan 模式阻止写入和危险执行
- 高风险动作默认 ask/deny，并支持二次确认
- path traversal、外部修改、shell redirect 均不能绕过策略
- 权限拒绝、超时、取消和运行时错误可区分

## Phase 5：Context 和 Compact（已实现）

> ContextEnvelope、摘要边界、工具配对保护和 WorkingMemory 迁移已落地；全量覆盖率门槛仍需继续补齐。

### 工作项

- [x] 实现结构化 ContextEnvelope
- [x] 实现 provider/model 可替换的 token estimator
- [x] 实现 tool result budget 和输出截断
- [x] 实现 WorkingMemory
- [x] 实现 compact summary 和 versioned boundary
- [x] 实现 preflight、manual、reactive 三种 compact
- [x] compact 后重新生成 system、tools、runtime 和 skill guard
- [x] 保留未完成 tool call、权限决定、文件变更和用户约束

### 验收

- 压缩前后 mode、skill、权限和 pending work 不丢
- 断电恢复后能识别 boundary 并继续工作
- context overflow 可压缩并最多按策略重试一次

## Phase 6：Slash Commands 和 `/workwith`

### 工作项

- [ ] 实现独立 CommandRegistry
- [ ] 实现 `/model`、`/compact`、`/sessions`、`/mcp`、`/skills`、`/init`
- [ ] 实现 `/workwith provider/model instruction`
- [ ] `/workwith` 只作用于下一项任务，不修改全局档位
- [ ] 实现模型存在性、能力、secret 和 enabled 校验
- [ ] 记录 model override、route change 和 audit events
- [ ] 所有命令支持参数错误、幂等和 SESSION_BUSY 处理

### 验收

- `/workwith deepseek/v4-flash 完成计划实现` 使用指定模型
- `/workwith openai/gpt-6-astra 扫描工程` 使用指定模型
- 刷新客户端或重试请求不会重复执行命令
- `/workwith` 不绕过权限、预算、compact 或 skill guard

## Phase 7：TUI 和 Web UI

### TUI

- [ ] 只消费 runtime event，不直接改 runtime state
- [ ] 展示模型档位、provider/model、token、成本和权限请求
- [ ] 支持 cancel、permission resolution、`/workwith`

### Web UI

- [ ] 实现 `--web-ui`
- [ ] 实现 `--port`、`--listen local|lan|public`、`--host`
- [ ] 默认 `127.0.0.1` / `::1`，默认 token
- [ ] 实现 HTTP API 和 WebSocket event stream
- [ ] 实现 bearer token、Origin/CORS/CSRF、rate limit
- [ ] 实现 principal/session authorization
- [ ] 实现 `lastEventId` 补发和 Idempotency-Key
- [ ] 实现优雅关闭和 active turn cancel

### 验收

- local 不接受局域网连接
- public 禁止无认证启动
- Web UI 与 TUI 同时连接时事件、权限和 cancel 语义一致
- WebSocket 断线重连不会丢失或重复 turn

## Phase 7 已完成

**TUI**（`src/clients/tui/`，Ink）、**Web UI**（`src/clients/web/`，`node:http` + `ws` + Tailwind 编译的静态页）
与**组合根**（`src/app/`）均已落地，三端共用同一个 `AgentApplication`。
验收（`tests/acceptance/phase7.test.ts`）：两端收到**同一** `sequence` 序列、任一方批准双方都收到
`permission_resolved`、任一方取消双方都收到 `turn_end{cancelled:true}`、补发锚点失效时返回
`EVENT_RESYNC_REQUIRED` 而非静默补发全量。

### 实现前先修的三条不成立契约（都是**显式决策**，不是"顺手修好"）

1. **装上审批/提问服务后事件消失。** `AgentRuntime` 只在 `error_code === PERMISSION_REQUIRED`
   时发 `permission_required`，而 `ToolExecutor` **只在没有 `approvalService` 时**才返回该错误码
   ——UI 一接上真实服务，事件就永远不再出现。现改由审批 broker 发出，并经 `EventLog` 持久化
   （重连补发因此自动覆盖审批项）。
2. **`ask_user_question` 不可达。** `user_input_required` 永不发出、`AWAITING_USER_INPUT` 永不进入，
   `requiresResolution()` 的契约与实现不符。现由提问 broker 发事件，`ToolExecutor` 消化提问并
   产出正常工具结果（回灌答案或 `{"_timeout": true}`）；runtime 侧的 `finish(PARTIAL, ERROR)`
   分支已删除。
3. **`EventLog` 成为事件的唯一持久化权威**（移除 `chat.json` 中无人读取、且每次流式增量都触发
   全文件重写的副本）。`emit` 泛型化后暴露出 `turn_end` 漏发 token 等字段。

### Phase 6 部分完成（`src/commands/`）

契约层（`CommandDefinition` / `CommandHost` 端口 / 执行管线）、`/workwith` 与 model-ref 消歧
已落地。内置 15 条命令中：**6 条真实现**（`/workwith` `/sessions` `/clear` `/compact`
`/language` `/model` 只读分支）、**9 条诚实降级**（返回 `COMMAND_NOT_AVAILABLE` + 具体原因，
不返回假数据、不用空列表假装成功）。

**待补**：`/model use` 写分支；`/thinking` `/reasoning` `/effort` 需要在 runtime 里补
`ModelRequest.thinking` 的消费（当前只改配置不产生行为变化，故明确报不可用）；
`/init` 需从旧 Python 源码逐字转录初始化指令全文。

### 已知限制

- **覆盖率分支项未达 80% 门槛**（约 69%）。缺口全在既有代码（`providers/anthropic.ts` 60%、
  `runtime/agent-runtime.ts` 等）；Phase 6/7 新增代码四项均高于阈值。**阈值未下调**。
- `chat.json` 仍是全量重写（写放大），需独立 ADR 与迁移工具才能改为 append-only。

## 覆盖率达标时发现的 8 个缺陷（已修）

补测试到 80% 门槛的过程中撞见并逐条做了**显式决策**。全部判为**修正**，无一条标
`// BUG-COMPAT`——因为旧项目里都不存在这些行为（新实现回归 / 笔误 / 实现疏漏），
标成"保留旧行为"会误导后来人以为是为了兼容旧数据。

| # | 缺陷 | 性质 |
|---|---|---|
| A1 | `globMatch()` 的四次 `replaceAll` 让 `**` 恒不匹配（`**/*.ts` 匹配不到任何路径），而 `glob` 的 description 自己就举了 `**/*.py` | **新实现回归**——`parts/04` §5.5 记明旧实现用 Python `Path.glob()`（双星递归）。改为单次遍历生成正则，从结构上消除"后一步重写前一步插入片段"的成因 |
| A2 | 预算收尾抛穿并把 session 锁死：`finish()` 只给 `executing_tools` 特判了绕行，其余阶段 `transition()` 抛 `INVALID_STATE_TRANSITION`；且 `return finish(...)` 缺 `await`，拒绝绕过同层 `catch` → `submitMessage` 抛异常、turn 无 `result`、session 被 `SESSION_BUSY` 永久锁死 | 见 `docs/adr/0003-turn-budget-transitions.md` |
| A3 | `recover()` 的 `\|\|` 优先级让 `PENDING_USER_APPROVAL` 逃过过期检查，快照与刚落盘的磁盘状态自相矛盾 | 括号笔误 |
| A4 | `path-sandbox` 的悬空软链逃出工作区：`realpath` 抛的 `ENOENT` 被"叶子不存在→上溯父目录"的 catch 吞掉，写操作跟随链接在**工作区外**创建文件 | **路径逃逸（安全）** |
| A5 | `validateProvider()` 对无法解析的 URL 兜底成 `new URL('http://invalid')`，使后续协议/用户名/查询串检查**全部落空** | 新增校验里的缺口：加了检查却没让它生效 |
| A6 | 两个 broker 的 `#wait` 在 `signal.aborted` 时直接 resolve，不走 `#settle`、不广播，而 `onAbort` 路径是完整的 → 幽灵条目占着队列名额；已取消时还会先发 `resolved` 后发 `required`（顺序颠倒） | 同一条语义两份实现，其中一份漏了收尾 |
| A7 | `mcp_*` 在 NORMAL/AUTO_EDIT 下被模式白名单先拒，风险段的 `mcp.risk-approval` **永远不可达** | 规则不可达——留一条永不触发的规则比没有更坏（同 ADR 0002 §三） |
| A8 | `ToolExecutor` 的超时不会真正中断工具：`await tool.execute(...)` 是普通 await，`timedOut()` 在其后才检查 → 工具不理会 signal 就无限等待 | 超时形同虚设。改用 `abortable()` 保证**等待本身**在超时时结束 |

**A2/A6 的连带发现**：A6 修复过程中一度让"已取消"路径先广播 `permission_resolved` 再广播
`permission_required`（因为 `request()` 里 `#wait` 在 `publish` 之前执行）。最终修法是
**已取消时干脆不发 `permission_required`**——UI 不该为一个已经结束的请求弹框。

**A8 的已知限制**：`abortable` 只保证等待结束，**不代表工具停了**。不响应 abort 的工具可能
仍在后台产生副作用，此时"副作用是否发生"不可知——按 ADR 0002 §六 该用 `UNKNOWN`，但那条
路径目前只覆盖"进程中断"（`recover()` 把 `RUNNING` 改判 `UNKNOWN`）。当前仍记为 `FAILURE`，
因为已向模型返回失败结果。**未静默改状态语义**，留待后续决策。

## Phase 8：Skills

- [ ] 实现 `SKILL.md` schema、version、content hash
- [ ] 实现 project > user > builtin 冲突处理
- [ ] 实现 deterministic resolver 和 rejected reason
- [ ] 实现 planning injection、runtime guard、phase state
- [ ] turn 开始时固定 skill snapshot
- [ ] guard 在 provider call 和 tool execution 前都生效
- [ ] compact/resume 后恢复 skill runtime state

## Phase 9：Sub-agent

- [ ] 实现 SubAgentDefinition、SubAgentSession、SubAgentResult
- [ ] 实现 foreground、background、parallel
- [ ] 实现父权限与 definition 权限交集
- [ ] 实现 minimal、project-aware、file-focused、conversation-aware、full-parent-summary
- [ ] 实现 parent/isolated/readonly working directory
- [ ] 实现独立 transcript、visibility、预算和取消传播
- [ ] 实现 continuationHandle 和进程重启恢复
- [ ] 实现 partial result、findings、changes、evidence、unresolved
- [ ] 默认禁止递归 sub-agent

### 验收

- 子代理内部 tool call 不污染父 transcript
- 子代理不能获得父代理没有的权限和预算
- max budget 时返回 partial，而不是伪装成 failed
- background/parallel 子代理能被查询、取消和恢复
- 父 turn 取消时子代理按策略取消

## Phase 10：MCP

- [ ] 实现 server 配置校验和重复名称拒绝
- [ ] 实现独立连接、能力协商、timeout、reconnect、circuit breaker
- [ ] 实现显式 tool-to-server mapping
- [ ] MCP tool 进入统一 ToolRegistry、PermissionEngine 和 execution record
- [ ] MCP tool catalog 支持版本和动态更新
- [ ] MCP 失败不会破坏父 turn；unknown execution 必须显式处理

## Phase 11：可观测性和质量门禁

- [ ] 本地结构化日志先于 Langfuse
- [ ] 记录 model route、tool execution、permission、compact、sub-agent、MCP 生命周期
- [ ] 实现 token、cost、latency、retry、fallback、failure stage 指标
- [ ] 默认脱敏 API key、环境变量、路径 secrets 和工具参数
- [ ] 建立跨 provider、跨模型、跨客户端的回归测试

## 发布前检查

- [ ] 默认启动不会监听公网
- [ ] 没有任何路径可以绕过 PermissionEngine
- [ ] 文件写入支持原子替换和外部修改检测
- [ ] 进程重启后 session、turn、权限、compact、tool execution 和 sub-agent 可恢复
- [ ] `/workwith`、模型档位和 fallback 行为有测试
- [ ] Anthropic-only 协议在流式文本、thinking、tool use、usage、错误和取消场景下通过测试
- [ ] TUI、CLI、Web UI 使用同一 Agent runtime
- [ ] README、配置示例和本文件中的参数名称一致

## 实施原则

先冻结协议，再实现 provider 和工具；先实现安全边界，再扩展能力；先实现持久化和恢复，再实现 UI；先用本地事件日志定位问题，再接入远程观测。每个阶段结束都必须回答：哪一个 session、哪一个 turn、哪一个模型、哪一个工具、哪一条策略导致了当前结果。
