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
- [x] 实现 Slash Commands 与 `/workwith`（见下方 Phase 6 段）
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

当时规模：19 个测试文件、264 个测试。**当前规模见文件末尾的「测试与覆盖率」段。**

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

## Phase 6：Slash Commands 和 `/workwith`（已完成）

### 工作项

- [x] 实现独立 CommandRegistry
- [x] 实现 `/model`、`/compact`、`/sessions`、`/mcp`、`/skills`、`/init`
      （`/mcp` `/skills` 指向 Phase 8/10 的子系统，**诚实地降级**：
      返回 `COMMAND_NOT_AVAILABLE` + 具体原因，不返回假数据、不用空列表假装成功）
- [x] 实现 `/workwith provider/model instruction`
- [x] `/workwith` 只作用于下一项任务，不修改全局档位
- [x] 实现模型存在性、能力、secret 和 enabled 校验
- [x] 记录 model override、route change 和 audit events
      （`model_route_changed` 是本次新增的第 14 种 runtime 事件，见 ADR 0004 D8）
- [x] 所有命令支持参数错误、幂等和 SESSION_BUSY 处理

### 验收

以下四项已由 `tests/acceptance/phase6.test.ts` 写成可执行断言（19 条用例）：

- [x] `/workwith deepseek/v4-flash 完成计划实现` 使用指定模型
- [x] `/workwith openai/gpt-6-astra 扫描工程` 使用指定模型
- [x] 刷新客户端或重试请求不会重复执行命令
- [x] `/workwith` 不绕过权限、预算、compact 或 skill guard

### Phase 6 的收尾内容（2026-09-15 补完）

Phase 6 的主体（注册表、管线、`/workwith`、`/sessions`、`/clear`、`/compact`、
`/language`、`/init`）此前已完成。本次补完的是三块**卡在别处**的东西：

1. **`/model use` 写分支**。契约、消歧与能力校验（`resolveModelRef` /
   `checkCapability`）早已就绪，缺的是写入路径。
2. **`/thinking` `/reasoning` `/effort` `/1M`**。它们此前是"诚实降级"，
   因为 `ModelProfile.thinkingEnabled` / `reasoningEffort` **没有消费者**——
   只有 TUI 状态栏读来显示，runtime 构造 `ModelRequest` 时不填 `thinking`。
   写一个没有消费者的开关比不写更坏，所以先降级。
   本次补上 runtime 的消费（`thinkingConfigFor`），四条命令才成立。
   **顺序不能反：先让配置有效，再开放写入口。**
3. **`model_route_changed` 事件**。fallback 换候选此前是静默发生的。

决策与依据见 `docs/adr/0004-thinking-effort-and-model-commands.md`（D1–D10）。
其中三处需要单独点出：

| 项 | 性质 |
|---|---|
| `/effort xhigh` | **修正**。旧实现的 `/effort` 菜单提供 xhigh，而落盘校验只接受 low/medium/high 且抛 `ValueError`；`_set_effort` 没有 try/except，且在 `else` 分支**先写 thinking 再写 effort** → 选一次 xhigh 就把配置**半写** |
| `thinkingEnabled` 缺省解释为**关闭** | 与旧 `thinking_enabled` 默认 `True` **有意不同**。本项目 `supportsThinking` 缺省 `false`，沿用旧默认会发出模型没声明的能力请求 |
| effort → `budget_tokens` 映射表 | **新增协议，无旧来源可转录**。旧实现从不发 `budget_tokens`；`parts/03` §2.1 要求对接官方 Anthropic 时必须补上。取 4k/12k/24k/48k |

### 独立审查发现并修正的 5 处缺陷

收尾后经独立审查，又发现并修掉 5 处——**全部是本次新增代码自身的问题**，
两条被"声称做了但没做成"那一类：

| # | 缺陷 | 性质 |
|---|---|---|
| **B1** | fallback 用 `candidates[candidateIndex]` 当"变更前的模型"。`resolve()` 返回的是**第一个通过校验的候选**，不是 `candidates[0]`（配置层不可用的候选会被跳过，而 `implementation` 档位 `requiresTools` 恒真，所以这是常态）。下标错位导致：事件 `from` 报出**一个从未运行过的模型**，且 fallback **重新请求刚失败的那个** | 交付物（D8 事件）自身不正确。修法：`ResolvedModelRoute` 增加 `resolvedIndex`，fallback 改为沿候选链往后找**第一个真的可用**者（`#nextUsableCandidate`），`from` 取当前 route |
| **B2** | `budget_tokens` 的官方约束是**两条**（最小 1024 **且**小于 `max_tokens`），初版只保证了后者。`maxOutputTokens ∈ [1025, 2046]` 的模型会发出 `budget_tokens: 1000` —— **必然被 endpoint 拒绝**，等于把"缺字段"换成"字段非法" | 与 D1 的目标直接冲突。现在放不下就不发（`maxTokens >= 2047` 才可能合法） |
| **B3** | `/reasoning <level>` 只写 effort 是**空操作**：`reasoningEffort` 的唯一消费者要求 `thinkingEnabled === true`，而 D3 把缺省改成了关闭。回执里的"预算 24000"永远不会出现在请求里 | 见 ADR 0004 D4b。修正为与 `/effort` 一样合成一次写 |
| **B4** | `AgentApplication.#updateActiveProfile` 在档位不存在/悬空分配时 `return`，写入被**无声丢弃**而调用方拿到"成功" | 与 D9 同族。改为抛 `MODEL_NOT_FOUND`（推翻了此前一条固化该行为的测试） |
| **B5** | `/model use` 写后回读不到分配时返回 `ok: true` + 「档位 X → 未设置」——同时声称了成功和没写进去；且 `data` 一半入参回显、一半回读结果 | 改为 `FAILED` + `INVALID_STATE_TRANSITION`，`data` 全部取自回读 |

### 已知限制

以下为审查中发现、经评估后**刻意不在本次修**的项，逐条理由见 ADR 0004「已知限制」：

- **`model_route_changed` 的未知事件兜底** —— TUI 与 Web 对未来新增事件仍是"原样忽略"；
  当前已实现的 `model_route_changed` 则会在 TUI 状态栏和 Web 消息区显示路由切换提示，
  同时继续保留在事件日志与 WS 流中。未知事件的通用可视化仍归后续演进。
- **Web 路径下 `local-principal` 等价于"已认证"** —— `AuthService` 固定用
  `app.localPrincipalId`，所以那五个会写全局配置的命令可以从浏览器调用，
  包括 `--listen lan --auth none`。不是本次新引入的（`/language` 早已如此），
  但本次扩大了暴露面。归 Phase 7/11。
- **`--auth password` 保留显式未实现失败** —— 当前 Web UI 完成 token/none 两条认证路径；
  password 需要独立登录表单、凭据存储和限流策略，启动时会返回稳定错误码，不会静默当成 token。
- **思考预算可能超出 provider 请求超时**（`xhigh` = 48k > 官方提示的 32k 线），
  触发时裸 `AbortError` 会变成 `INTERNAL_ERROR` 而非可识别的"超时"
  ——违反设计约束 6。归 Phase 11。
- **`/api` 仍为诚实降级**，且理由变了：不是"还没排到"，而是刻意的推迟
  ——旧语法 `/api add deepseek <明文 API key>` 与 `parts/09` §9.1
  「密钥不得出现在日志、事件、URL 或前端响应」冲突，且需要一套独立的
  SecretRef 输入设计。见 ADR 0004 D10。
- **`/workwith` 的回执在 turn 结束后才返回**：`AgentApplication.submitTurn`
  会等到 turn 收尾（与 Web 的 `POST /api/turns` 同语义）。要做到事前提示需要
  一条非阻塞提交路径，属 Phase 7 层面的决策。
- `TaskIntent.requiresThinking` 仍硬编码 `false`：本次只让用户显式开关生效。

## Phase 7：TUI 和 Web UI

### TUI

- [x] 只消费 runtime event，不直接改 runtime state
- [x] 展示模型档位、provider/model、token、成本和权限请求
- [x] 支持 cancel、permission resolution、`/workwith`

### Web UI

- [x] 实现 `--web-ui`
- [x] 实现 `--port`、`--listen local|lan|public`、`--host`
- [x] 默认 `127.0.0.1` / `::1`，默认 token
- [x] 实现 HTTP API 和 WebSocket event stream
- [x] 实现 bearer token、Origin/CORS/CSRF、rate limit
- [x] 实现 principal/session authorization
- [x] 实现 `lastEventId` 补发和 Idempotency-Key
- [x] 实现优雅关闭和 active turn cancel

### 验收

- [x] local 不接受局域网连接
- [x] public 禁止无认证启动
- [x] Web UI 与 TUI 同时连接时事件、权限和 cancel 语义一致
- [x] WebSocket 断线重连不会丢失或重复 turn

## Phase 7 已完成

**TUI**（`src/clients/tui/`，Ink）、**Web UI**（`src/clients/web/`，`node:http` + `ws` + Tailwind 编译的静态页）
与**组合根**（`src/app/`）均已落地，三端共用同一个 `AgentApplication`。
正式入口为 `src/cli.ts`（构建后为 `dist/cli.js`），支持 `--web-ui`、端口/监听范围、显式 host、认证和 CORS 参数；
`pnpm dev` 与构建后的 `pnpm start` 使用同一套参数解析器。
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

### Phase 6 已完成（`src/commands/`）

> 本节曾记为「部分完成」，2026-09-15 补完后更新。当时的待补三项
> （`/model use`、`/thinking` 等的 runtime 消费、`/init` 转录）**已全部落地**。

契约层（`CommandDefinition` / `CommandHost` 端口 / 执行管线）、`/workwith` 与 model-ref 消歧
已落地。内置 **15 条命令**：**11 条真实现**（`/workwith` `/init` `/sessions` `/clear`
`/compact` `/language` `/model` 含写分支 `/thinking` `/reasoning` `/effort` `/1M`）、
**4 条诚实降级**（`/skills` `/mcp` `/langfuse` `/api`，返回 `COMMAND_NOT_AVAILABLE` +
具体原因，不返回假数据、不用空列表假装成功）。

前三条降级指向确实尚未实现的子系统（Phase 8/10/11）；`/api` 是**刻意推迟**，
理由见 ADR 0004 D10。

### 已知限制

- 覆盖率四项均高于阈值（语句 95.31 / 分支 91.22 / 函数 96.44 / 行 96.8，阈值 80）。
- `chat.json` 仍是全量重写（写放大），需独立 ADR 与迁移工具才能改为 append-only。
- `/workwith` 的回执在 turn 结束后才返回（见「Phase 6 的收尾内容」段的已知限制）。

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
- [x] `/workwith`、模型档位和 fallback 行为有测试
      （`tests/acceptance/phase6.test.ts`、`tests/commands/model*.test.ts`、
      `tests/runtime/agent-runtime.test.ts` 的 `model_route_changed 事件` 段）
- [ ] Anthropic-only 协议在流式文本、thinking、tool use、usage、错误和取消场景下通过测试
- [x] TUI、CLI、Web UI 使用同一 Agent runtime
- [x] README、配置示例和本文件中的参数名称一致

## 测试与覆盖率

最近一次全量数据（Phase 7 收尾后，`pnpm check` 与 `pnpm test:coverage` 均 exit 0）：

| 项 | 值 | 阈值 |
|---|---|---|
| 测试文件 / 用例 | 80 / 1709 | — |
| 语句 | 94.48% | 80% |
| 分支 | 90.76% | 80% |
| 函数 | 95.93% | 80% |
| 行 | 95.95% | 80% |

阶段验收：`tests/acceptance/phase0.test.ts`、`phase1-5.test.ts`、
`phase6.test.ts`、`phase7.test.ts`。

## 实施原则

先冻结协议，再实现 provider 和工具；先实现安全边界，再扩展能力；先实现持久化和恢复，再实现 UI；先用本地事件日志定位问题，再接入远程观测。每个阶段结束都必须回答：哪一个 session、哪一个 turn、哪一个模型、哪一个工具、哪一条策略导致了当前结果。
