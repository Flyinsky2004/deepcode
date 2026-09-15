# ADR 0004：思考消费与模型命令

- **状态**：已接受
- **日期**：2026-09-15
- **阶段**：Phase 6 收尾（Slash Commands 与 `/workwith`）
- **相关**：`docs/rewrite-spec/parts/09-typescript-agent-standard.md` §6.1 / §9.1–§9.5、
  `docs/rewrite-spec/parts/03-providers.md` §2.1、`docs/adr/0002-core-contracts.md` §三、
  `src/core/provider.ts`、`src/core/models.ts`、`src/core/turn.ts`、
  `src/commands/definitions/model.ts`、`src/commands/definitions/model-preferences.ts`、
  `src/runtime/agent-runtime.ts`、`src/app/command-host.ts`

## 背景

Phase 6 的清单里，`/model` 的写分支与 `/thinking` `/reasoning` `/effort` `/1M`
一直挂着未做。原因不在命令层，而在**配置没有消费者**：

- `ModelProfile.thinkingEnabled` / `reasoningEffort` 只被 TUI 状态栏读来显示
  （`src/clients/tui/status-bar.ts:118-119`）；
- `AgentRuntime` 构造 `ModelRequest`（`src/runtime/agent-runtime.ts`）时
  **从不填 `thinking` 字段**；
- 而 `src/providers/anthropic.ts` 与 `core/provider.ts` 的 `ThinkingConfig`
  **早已完整支持**它（含 `maxTokens > budgetTokens` 校验与 `budget_tokens` 发送）。

于是写这些配置等于什么都没发生。当时的处理是让四条命令返回
`COMMAND_NOT_AVAILABLE` 并说明原因——**这是对的**：写一个没有消费者的开关
比不写更坏。收尾要做的正是把消费者补上，**顺序不能反**。

同时，旧 Python 源码里有三处行为需要显式决策，见下。

## 决策

### D1 `/thinking` `/reasoning` `/effort` 转为真实现

runtime 现在从 `route.model` 折算 `thinking` 并放进 `ModelRequest`。
折算逻辑是 `core/provider.ts` 的纯函数 `thinkingConfigFor(profile, maxTokens)`，
runtime 与命令层共用一份，避免两处各算一遍而漂移。

依据是 `parts/03` §2.1 的明确要求：「对接官方 Anthropic API 时必须补
`"budget_tokens"`（官方文档要求 `budget_tokens` 为必填且 `max_tokens > budget_tokens`），
复刻时请把这个差异显式标注」。旧实现只发 `{"type": "enabled"}` 是因为它主要面向
不校验该字段的 DeepSeek 兼容端点；对接官方 endpoint 会直接失败。

### D2 effort → `budgetTokens` 的映射表（**新增协议，无旧来源**）

```ts
low: 4_000   medium: 12_000   high: 24_000   xhigh: 48_000
```

**这是一处必须标注出来的"新增"**：旧项目的 Anthropic 请求体里 `thinking` 只有
一个键（`api_client.py:383`），从不发 `budget_tokens`；`reasoning_effort` 字段
只有 OpenAI 分支读（`parts/03` §2.1）。因此这一组数字**没有可转录的来源**，
是策略选择：贴近官方常见区间（官方上限 64k），并留出足够输出空间。

换算规则：

```
budgetable   = floor(maxTokens)          // 非有限值直接放弃
reserve      = clamp(⌊budgetable/2⌋, 1, 1024)
budgetTokens = min(desired, budgetable - reserve)
可行 ⟺ 1024 <= budgetTokens < budgetable
```

#### 官方约束是**两条**，不是一条（初版写错的地方）

官方文档的原话是「Minimum of 1,024 tokens. The API rejects smaller values.」，
外加 `budget_tokens < max_tokens`。初版只保证了后者（下界取 1），于是
`maxOutputTokens ∈ [1025, 2046]` 的模型会发出 `budget_tokens: 1000` 之类的值
——**必然被 endpoint 拒绝**。这恰好把 D1 要修的问题换了个形状：旧实现因为不发
`budget_tokens` 而对接不上官方 API，压低到一个非法值等于把"缺字段"换成"字段非法"。

现在的行为是**放不下就不发**（返回 `undefined`）：宁可这一轮没有思考，也不发一个
400。与 §9.2「不能静默降级」同源。

由此得到确切阈值：`maxTokens >= 2047` 才可能放下合法预算（`⌈2047/2⌉ = 1024`），
`2046` 及以下一律不发。余量的**下界 1 仍必需**：少了它 `maxTokens = 1` 会算出
`budgetTokens = 1`，恰好让 `maxTokens > budgetTokens` 不成立。

`tests/core/provider.test.ts` 有边界用例与一条"对每个取得到的组合都维持两条约束"
的遍历断言。

### D3 `thinkingEnabled` 缺省（字段不存在）解释为**关闭**

**与旧实现有意不同**：旧 `LLMModel.thinking_enabled` 默认 `True`（`models.py`），
也就是旧项目**默认总是发 thinking**。

改判的理由：

1. 本项目的 `supportsThinking` 归一化默认是 `false`
   （`config-store.ts` 的 `asBool(value['supportsThinking'], false)`）。
   沿用旧的 `True` 默认，会让默认配置发出模型根本没声明的能力请求。
2. TUI 状态栏一直把缺省渲染成 `OFF`（`status-bar.ts:118`），
   存储层也刻意保留"未设置"与 `false` 的区别（`normalizeProfile` 只在字段存在时才写）。
3. `/thinking on` 现在是一条真命令，用户要开就显式开。

`false` 与"未设置"在行为上都是不发 `thinking`，但在存储里仍是两件事——
把两者抹平会让"用户明确关掉了"和"从未设置"无法区分。

### D4 `/effort xhigh`：**修正**

旧实现里这一项是坏的：

- `/effort` 的菜单提供 `low / medium / high / xhigh`
  （`_get_effort_levels`, `app.py:192-199`）；
- 而落盘校验 `set_model_reasoning_effort`（`storage.py:295-298`）只接受前三项，
  否则 `raise ValueError`；
- `_set_effort`（`app.py:1981-2007`）**没有 try/except**，且在 `else` 分支里
  **先**写 `thinking_enabled=True`、**再**写 effort。

所以选一次 `xhigh`：thinking 被打开并落盘成功，effort 的写入抛错且无人捕获，
**配置停在半途中**。

本实现两处都改：

1. `REASONING_EFFORTS` 加入 `'xhigh'`，让旧菜单里的那一项不再是死路
   （`/reasoning` 仍只提供 low/medium/high，对齐旧菜单）；
2. `/effort` 的 `medium` / `high` / `xhigh` 把 `thinkingEnabled` 与
   `reasoningEffort` **合成一次写**，不再有半写窗口。

`/effort low` 的语义照抄旧实现：**只关思考，不动强度**——强度只在思考开启时
有意义，关掉思考却顺手改强度，会让"再打开思考"时强度被无声重置。

### D4b `/reasoning` 必须一并打开思考

`reasoningEffort` 的**唯一**消费者是 `thinkingConfigFor`，而它要求
`thinkingEnabled === true`。D3 把缺省改成关闭之后，"只写 effort"就变成了空操作：
回执说「强度已设为 high（预算 24000）」，而那个 24000 永远不会出现在任何请求里
——正是本项目判定"写没有消费者的开关比不写更坏"的那种情况。

所以 `/reasoning <level>` 与 `/effort <非 low>` 一样，把 `thinkingEnabled: true`
与 `reasoningEffort` **合成一次写**。

这同时**更接近旧实现的实际行为**：旧 `thinking_enabled` 默认 `True`，
所以旧项目里 `/reasoning` 一设就生效。D3 改了缺省值，这里是那个改动的必要补偿。

`/effort low` 仍是唯一"只关思考、不动强度"的入口，两者语义不冲突。

### D5 `/thinking on` 与 `/1M` 的能力前置校验

| 命令 | 要求 |
|---|---|
| `/thinking on` | `supportsThinking === true` |
| `/1M`（开启方向） | `supports1MContext === true` |
| `/thinking off`、`/1M`（关闭方向） | 无要求 |

失败返回 `MODEL_CAPABILITY_UNAVAILABLE` 并**一个字节都不写**。

依据：`parts/09` §9.2「若开启但模型不支持，必须在保存或选择时拒绝，**不能静默降级**」。
该条虽写在 1M 一节，但 `ModelProfile` 把 `supportsThinking` 与 `thinkingEnabled`
分成能力与开关两个字段，就是为了这个区分——字段存在而不校验，等于没写。

关闭方向不设卡：回到标准窗口、关掉思考都不需要任何能力。

### D6 `/1M` 切换 `ModelProfile.contextWindow`

双向切换 `125_000 ↔ 1_000_000`，判据照抄旧实现
（`app.py:2020`：`125_000 if model.context_window >= 1_000_000 else 1_000_000`）。

旧实现里 1M 只是**本地的 `context_window` 数值**，只影响压缩阈值与 UI 标签
（`parts/03` §2.1：它不改变任何请求字段）。本实现沿用这一语义；`parts/09` §9.2
只是在此之上加了"能力声明 + 拒绝静默降级"的要求（即 D5）。

### D7 `/model use <tier> <provider/model>`

**不用旧实现的 1-based 下标形式**（`/model use <ch> <mo>`, `app.py:1606-1627`）。

旧项目只有"唯一主模型"（`is_default` 的那个），下标是它唯一可能的寻址方式。
本项目有六个档位（`parts/09` §9.3），下标语义在这里没有对应物，而且**会漂移**
——配置里增删一个模型，历史下标就指向别的东西。

引用解析复用 `/workwith` 的 `resolveModelRef`：同一个输入在两个命令里必须给出
同一个结果，否则用户得记两套规则。写入前的校验按 `parts/09` §9.3
「保存配置时必须校验模型存在、已启用且能力满足该档位要求」；其中能力要求只取
规格明说的那一条——`implementation` 必须 `supportsTools`
（`src/commands/model-ref.ts` 的 `TIER_REQUIRES_TOOLS`）。其余档位规格未规定，
**不发明**约束：注定跑不起来的组合由 `ModelRouter.resolveCandidate` 在每个 turn
上按 `TaskIntent.requiresTools` 拒绝。

### D8 `model_route_changed` 进入 core 事件集（**修订 ADR 0002 §三**）

`RuntimeEventType` 由 13 种增至 **14** 种。

依据：`parts/09` §6.1 要求「模型引用、路由决策、能力校验和最终使用的模型写入审计事件」，
§9.5 要求「切换模型后必须重新构建请求并写 `model_route_changed` 事件」。
两种触发情形：

1. **`reason: 'override'`**——`/workwith` 指定的模型覆盖了档位分配；
2. **`reason: 'fallback'`**——首选模型连接失败 / 429 / 暂时性 5xx，路由滑到候选列表下一个。

`from` 取 `ResolvedModelRoute.tierRef`（**新增字段**：档位自己分配的模型；档位
未配置或未启用时为 `undefined`，此时事件的 `from` 留空串并**仍然发出**——
"从空路由换成 B"本身就是必须留痕的事实）。
**不能从 `candidates` 反推**：候选列表被去重过，override 与档位模型相同时会合并成
一条，于是 `candidates[1]` 变成回退链首项，"从哪来"就答错了——
这个 bug 在第一版实现里真实存在，由验收测试捕获。

该事件是**通知类**，不是终止信号：`isTerminalEvent()` 不认它，
`tests/core/turn.test.ts` 有一条用例固定这一点。

#### 下标必须来自 `resolvedIndex`，不能靠自增推（初版写错的第二处）

`ModelRouter.resolve()` 返回的是**第一个能通过校验的候选**，不是 `candidates[0]`
——配置层就不可用的候选（模型被禁用、不支持工具、窗口太小）会被它跳过。而
`implementation` 档位的 `TaskIntent.requiresTools` 恒为 `true`，所以"档位模型
不支持工具、实际从回退链起步"是**常态而非边角**。

初版假设"我从下标 0 开始、每次 fallback 加一"，于是下标与实际运行的模型错位，
两个后果同时出现：

1. `model_route_changed` 的 `from` 报出**一个从未运行过的模型**；
2. fallback **重新请求刚失败的那个模型**（还把 `providerRetries` 归零）。

修法两处：`ResolvedModelRoute` 增加 `resolvedIndex`（`resolve()` 与
`resolveCandidate()` 都如实计算），runtime 用它对齐 `candidateIndex`；fallback
改为沿候选链往后找**第一个真的可用**的模型（`#nextUsableCandidate`），
`from` 直接取当前 `route` 的 provider/model——它就是刚失败的那个。

`tests/runtime/agent-runtime.test.ts` 的「fallback 的下标与实际运行的模型对齐」段
专门构造"首个候选不可用"的配置；把这两处改回旧写法，其中两条用例会失败。

### D9 「让我改东西，什么也没改，还不告诉我」：**修正**（两处，同一族）

**其一：`CommandHostAdapter.updateConfig` 丢字段。**
`updateConfig` 回写 `tier_assignments` 时按视图字段**重建**整条 assignment，
只显式捞回了 `fallbackModelRefs`——`maxCostPerTurn` 每次都被静默清掉。
这不是新代码的问题：`/language` 写一个设置项也会走这条回写路径，
所以**用户每切一次语言就丢一次成本上限**。改为在既有 assignment 上合并。

**其二：`AgentApplication.#updateActiveProfile` 吞掉整次写入。**
它原本 `if (!assignment) return`：档位不存在、或档位指向的 profile 已不在配置里
（悬空分配）时，写入被**无声丢弃**，调用方照样拿到一个"成功"。
现在两种情形都抛 `MODEL_NOT_FOUND`，且检查在写之前——**不会误改别的模型**。

命令层本来就用 `findPrimaryModel` 挡了一道，所以正常路径看不到这个错误；
它挡住的是并发删除档位与悬空分配。**这条改动推翻了此前一条测试**
（`agent-application-extra.test.ts` 的「未分配的档位直接跳过，不抛错」）——
那条测试固化的正是这里要修的行为，已改写为断言抛错且不误改。

两处都有回归用例：`tests/app/command-host.test.ts` 的
「updateConfig 保留视图里看不见的 maxCostPerTurn」、
`tests/app/agent-application-extra.test.ts` 的两条 `MODEL_NOT_FOUND` 断言。

同族的第三处：`/model use` 写后回读不到分配时，原本会返回
`ok: true` + 「档位 X → 未设置」——同时声称了成功和没写进去。
现在返回 `FAILED` + `INVALID_STATE_TRANSITION`，且 `data` 全部取自回读结果，
不掺入参（否则并发下会出现 `data.modelId = A` 而 `data.tiers[...] = B` 的
同一条响应内部矛盾）。

### D10 `/api` **不纳入** Phase 6 范围

`/api` 继续返回 `COMMAND_NOT_AVAILABLE`，但**理由变了**——不是"还没排到"，
而是刻意的推迟：

- 旧语法 `/api add deepseek <明文 API key>` 把密钥放进命令行参数，
  与 `parts/09` §9.1「API key 不得出现在日志、事件、导出文件、URL 或前端响应中」
  直接冲突（`CommandRegistry` 的审计事件虽只记 `inputHash`，但参数本身会经过
  TUI 输入历史与 Web 的 `POST /api/commands` 请求体）；
- 给 provider 管理设计一套安全的输入路径（SecretRef 表单、连接测试、
  脱敏展示、重复名称拒绝）是独立的一项工作。

在此之前，用户通过编辑 `~/.deepcode/config.json` 添加 provider。
`ConfigStore.upsertProvider` / `upsertModelProfile` / `setTierAssignment`
已经具备（含 `baseUrl` 校验与 provider 存在性检查），只是还没有安全的上层入口。

## 影响

- `/thinking` `/reasoning` `/effort` `/1M` 从"诚实降级"变为真实现；
  `/model use` 写分支可用。
- 请求体在开启思考后带上 `budget_tokens`，**可以对接官方 Anthropic endpoint**
  （此前发出去的是缺 `budget_tokens` 的 `thinking`，官方会拒绝）。
- 事件集 +1。任何按 `RuntimeEventType` 穷举的消费方需要处理新类型；
  它是通知类，忽略它不影响正确性，但会失去"这次实际用了哪个模型"的可见性。
- `/effort xhigh` 的旧配置（半写状态：`thinking_enabled=true` + 旧 effort）
  读进来仍然合法——`xhigh` 现在是合法值，不会有迁移问题。

## 已知限制

以下几条是**独立审查**中发现、经评估后**刻意不在本次修**的项。
它们不是遗漏，各自都有明确的理由或后续归属。

### 1. `model_route_changed` 目前没有任何客户端消费

TUI 的 `applyEvent` 与 Web 的 `app.js` 对未知事件都是"原样忽略"，所以本事件
**只进事件日志与 WebSocket 流**，用户在已交付的界面上看不到。
D8 的可观测性目标因此**尚未兑现**——把事件发出来是必要条件，不是充分条件。

⚠️ 本 ADR 的初版「已知限制」曾写"UI 侧仍可通过 `turn_start` 的模型快照
与 `model_route_changed` 事件实时得到同一信息"。**那句话是错的**：
`TurnStartEvent.data` 只有 `{ turn_number }`，没有模型快照（全仓可验）。
UI 的真正兜底是 `TurnModelSnapshot`——它由 runtime 在 fallback 时一并更新
（`agent-runtime.ts` 的 `updateTurn`），落在 `chat.json` 里，**事后**可读。

后果：用户看到状态栏显示的仍是**配置里档位绑定的模型**，
而本次 turn 实际可能跑在回退模型上。要兑现 D8，最小改动是让 TUI 加一条
`model_route_changed` 分支（写进 `notice`），或让状态栏改读 turn 快照。
**归 Phase 7**。

### 2. `/workwith` 的响应在 turn 结束后才返回

`AgentApplication.submitTurn` 会一直等到 turn 收尾（与 Web 的
`POST /api/turns` 同一语义，见 `src/app/agent-application.ts` 的 `submitTurn`）。
于是"本次任务使用 provider/model"这句回执是**事后**的。要做到事前提示，需要一条
非阻塞的提交路径，那会改动 HTTP 的幂等语义（现在的 `state: 'running'` 回放依赖阻塞），
属于 Phase 7 层面的决策。见 §1 的兜底路径说明。

### 3. Web 路径下 `local-principal` 等价于"已认证"

`AuthService` 固定用 `app.localPrincipalId`（`src/clients/web/server.ts`），
所以 `CommandRegistry` 里 `permission: { kind: 'local-principal' }` 的那道门
在 Web 上**恒为真**。`/model use` `/thinking` `/reasoning` `/effort` `/1M`
五个会写全局配置的命令因此可以从浏览器调用，包括
`--listen lan --auth none`（listen 策略只拒绝 `public + none`）。

这不是本次新引入的（`/language` 早就走同一条回写路径），但本次把
"改档位 → 换模型"这个更有后果的动作从 `NOT_AVAILABLE` 变成了可用，**扩大了暴露面**。

命令源码里五处「会写全局配置 —— 只允许本机 principal」的注释在 Web 语境下会
误导下一个维护者以为有隔离。**归 Phase 7/11**（选项：要求 `--auth token`、
或引入 `policy.allow_remote_config_write` 默认 false、或至少在 Web 文档里写明）。

### 4. 思考预算可能超出 provider 请求超时，且错误码不稳定

`policy.toolTimeoutMs`（默认 120 秒）被直接当作 provider 的请求超时。
`budget_tokens > 32k`（即 `xhigh`）会产生长请求，官方文档明确提示
"can hit system timeouts"。触发时 `withTimeout` 只 abort 内层 signal，
`runSignal.aborted` 仍为 false，于是裸 `AbortError` 经 `toAgentError` 变成
**`INTERNAL_ERROR`** —— 既没有"超时"这一可识别状态，也违反
`progess.md` 设计约束 6（稳定错误码）。**归 Phase 11**。

### 5. 空 `signature` 会被原样回传（低置信，需真实 endpoint 确认）

`providers/anthropic.ts` 对缺失的 `signature` 兜底成 `''`，
`storage/message-converter.ts` 只校验 `typeof signature === 'string'`，
因此 `''` 会通过并被回传。官方 endpoint 每个 thinking 块都会给
`signature_delta`，所以官方路径不会触发；但 Anthropic-compatible endpoint
若不发签名，回传的 `signature: ""` 可能被拒。**需要真实/兼容 endpoint 验证。**

### 6. `TaskIntent.requiresThinking` 仍硬编码为 `false`

本次只让用户显式开关生效；"按任务意图自动要求 thinking"属于 Phase 8/9 的路由工作。

## 复核触发条件

- 若 `parts/09` 后续给出 effort → `budget_tokens` 的官方换算表，
  **以官方为准**并替换 D2 的取值。
- 若 `parts/09` 后续给出各档位的能力要求表，替换 `TIER_REQUIRES_TOOLS`
  的单条规则。
- 若将来重新支持 OpenAI 兼容端点，`reasoning_effort` 会重新获得一条
  独立于 `budget_tokens` 的消费路径（ADR 0002 §三 已记录该分支的移除），
  届时 D2 需要重新评估。
