# ADR 0002：契约冻结（Phase 0 核心类型）

- **状态**：已接受
- **日期**：2026-09-14
- **阶段**：Phase 0（工程骨架与契约冻结）
- **相关**：`docs/rewrite-spec/parts/09-typescript-agent-standard.md`、`docs/REWRITE_SPEC.md` §6/§7

## 背景

Phase 0 要求"冻结契约"。冻结的含义不只是"把规格里的字段抄成 TS 类型"——
`parts/09`（目标规范）与 `parts/01..08`（旧实现行为记录）在若干处冲突，
而 `09` 还有几处**定义了名字却没给形状**，旧实现又存在**文档未记录的缺陷**。

本 ADR 记录三类决策：**命名约定**、**规格空缺的填补**、**旧缺陷的处理**。
每条决策都给出理由，以便后续 Phase 实现时不必重新推导。

---

## 一、命名约定：领域模型使用 snake_case

`Message` / `Conversation` / `TurnResult` 等持久化实体的字段名使用 **snake_case**
（`tool_call_id`、`created_at`、`parent_conversation_id`），与磁盘 JSON 逐字一致；
其余（接口方法、非持久化结构）使用 camelCase。

**理由**：

1. **消除映射层**。持久化就是 `JSON.stringify(record)`，读取是校验后直接使用。
   旧项目虽然也主要用 snake_case，但 TUI 与 API 层各自做了局部转换，
   这是字段漏传与默认值不一致的来源。
2. **与规格可逐行对照**。`parts/01-data-layer.md` 用 snake_case 逐字段描述结构，
   字段名一致意味着评审时可对照规格而非在脑中做翻译。

**代价**：不符合 TS 惯例，与 camelCase 的接口并存会有割裂感。
**接受理由**：本项目最大的风险是**恢复语义出错**，不是代码风格。

## 二、`turn_id` 有两套前缀

```
主代理： turn_<序号>_<会话 id 前 8 位>
子代理： subagent_turn_<序号>_<会话 id 前 8 位>
```

**这是实测发现，不是规格明文**。`parts/01` 与 `parts/07` 记录了 `subagent_turn_`
前缀（观测性的 `task_id` 也用它），但主规格的手册只举了 `turn_3_9fc43b3a`。

**为什么必须保留**：前缀是**唯一**的磁盘级标记，用于区分消息来自主代理还是子代理。
遗漏它会导致恢复时把子代理的 turn 误归属给主代理。

`createTurnId` 通过 `{ isSubAgent: true }` 参数产出子代理格式；
`parseTurnId` 返回 `isSubAgent` 供恢复逻辑使用。

## 三、供应商流式事件只有 4 种（移除 2 种）

`parts/09` §9.1 规定只支持 Anthropic Messages API。旧实现的 5 种事件中：

| 事件 | 处理 | 理由 |
|---|---|---|
| `thinking` | 保留 | Anthropic 原生 |
| `text` | 保留 | 通用 |
| `tool_use` | 保留 | 通用 |
| `reasoning` | **移除** | OpenAI 兼容分支专有（字段名也不同：`content` vs `thinking`） |
| `incomplete_tool_call` | **移除** | 仅 OpenAI 分支产生（工具调用 JSON 被流式截断） |

**连带后果（已知并接受）**：`incomplete_tool_call` 是旧实现
`incomplete_tool_call_limit_reached` 终止路径的**唯一触发器**。移除该事件意味着
这条恢复路径不再可达。Anthropic 以完整 content block 下发工具调用，
不存在这个中间态——**保留一个永不触发的恢复路径只会增加状态机复杂度**。

**同时确认"不存在"的东西**（旧实现也没有，不要凭空增加）：
没有 `start`/`stop`/`done` 事件，**没有 `usage` 事件**（用量经 `TokenUsage` 独立返回），
**没有 `error` 事件**（错误以异常抛出）。

## 四、`TurnPhase` 补上 `awaiting_user_input`

`parts/09` §2 的 `TurnPhase` 联合有 10 个成员，**没有**覆盖 `ask_user_question`
的等待状态。而旧实现存在第二个阻塞等待（用户回答问题，最长 120 秒），
与权限等待**并行但语义不同**：

- `awaiting_permission` 等的是**授权决定**，超时按拒绝处理，且必须已持久化请求。
- `awaiting_user_input` 等的是**答案内容**，超时返回 `{"_timeout": true}`。

**决策**：补上第 11 个成员 `awaiting_user_input`，而不是复用一个"等待"状态。
把两者合并会让恢复逻辑无法判断该重新弹审批还是重新提问。

## 五、`TurnPhase` 迁移表是本实现自行推导的

**规格空缺**：`parts/09` §2 要求「所有迁移必须校验 `from -> to`」，
但**全文没有给出任何一条迁移边**；旧 Python 项目根本没有具名状态
（它只有循环位置），因此也无从转录。

**决策**：在 `src/core/turn.ts` 中显式定义迁移表，并遵守三条不变量：

1. 终态无出边。
2. 每个进行中阶段都能被取消、也能失败（异常可在任意点抛出）。
3. `calling_model` 可自环（多轮工具循环）。

迁移表被视为**本实现的约定**并在注释中标注来源，而非声称来自规格。
若后续 `parts/09` 补充了官方迁移表，应以官方为准并更新。

## 六、权限请求状态从 8 个收敛为 5 个

旧实现有 8 个状态，其中 `APPROVED` / `EXECUTED` / `FAILED_AFTER_APPROVAL`
描述的是**执行**的进展，不是审批请求自身的状态。混在一个枚举里会导致
"已批准但尚未执行"与"批准后执行成功"无法区分——恢复时无法判断该重新执行
还是只补写结果。

**决策**：
- `PermissionRequestStatus` 保留 5 个（`CREATED` / `PENDING_USER_APPROVAL` /
  `APPROVED` / `DENIED` / `EXPIRED` / `CANCELLED`）。
- 执行进展由独立的 `ToolExecutionStatus` 表达，其中包含 `UNKNOWN`——
  进程中断时副作用是否发生无法确定，**该状态的操作不得自动重放**（`parts/09` §2）。
- `APPROVED` **不是终态**：它必须继续走向执行。这实现了"批准后只能执行一次"的防重放要求。

## 七、风险等级 4 档

`parts/08` 与 `parts/04` 用 3 档（`low`/`medium`/`high`），
`parts/09` §5 用 4 档（多一个 `critical`）。**以 09 为准**。

另外，旧实现里 `risk_level` **不参与任何门控判定**，只用于审批界面的徽标；
本实现让它成为风险策略阶段的真实输入。

## 八、决策顺序按 09，与旧实现相反

```
09（本实现）： 工具策略 → 参数策略 → workspace/session 策略 → skill guard → 风险策略
旧实现：       skill guard → 模式权限 → 工具自检
```

skill guard 在旧实现是第一道，在 09 是第 4 道。**按 09 实现**。
本 ADR 特别标注，因为顺序颠倒不会导致编译错误或测试失败，
只会在特定 skill + 特定工具组合下产生不同的授权结果。

## 九、`ContextEnvelope` 取代 system 消息扫描

`parts/09` §4 要求「模型请求必须使用结构化 `ContextEnvelope`，
**不能通过扫描 system message 重建状态**」。

这条约束修正的是旧实现的具体缺陷（`REWRITE_SPEC` §7.1 缺陷 A）：
preflight 压缩会重建 `api_messages`，重建后 system prompt 不在新列表里，
**那一轮请求完全没有 system prompt**——没有模式约束、没有安全策略、没有 skill 指导。

**实现要点**：
- `SystemPrompt` 保留**分层结构**（base / mode / safety / subagent / skill / compact），
  而不是提前拼成一个字符串。分层让压缩后能重新组装、让审计能回答"带了哪几层"。
- `ContextEnvelope.conversation` **不含** system 消息。系统提示只存在于 `system` 字段，
  从类型上杜绝"抽干 system 再放回第 0 条"这类操作。
- `WorkingMemory` 显式建模压缩时**不得丢弃**的六类信息（用户约束、未完成任务、
  待执行工具、权限决定、文件变更、已应用 skill）。

## 十、`Message.subtype` 写入正确的 compact 值

旧实现写入 `compact_summary` / `compact_boundary` 消息时**漏传 `subtype`**，
导致磁盘上落成 `"normal"`，检测完全依赖 `content` 里的 `type` 字段
（`REWRITE_SPEC` §7.1 记录的"读写不一致但恰好能工作"）。

**决策**：本实现**写入正确的 subtype**，同时读取侧两套判定都认。
这样新数据自描述，而旧格式仍能被识别——不需要在"自描述"与"兼容"之间二选一。

---

## 后果

**正面**
- 契约完整冻结，Phase 1..11 可以直接引用而无需重新推导。
- 三处规格冲突（风险档位、决策顺序、compact subtype）已显式决策并留档。
- 纠正了两处会静默出错的问题：子代理 turn 前缀、`awaiting_user_input` 缺失。

**负面 / 待偿付**
- snake_case 域模型与 camelCase 接口并存，风格上不统一。
- `TurnPhase` 迁移表是推导的，若 `parts/09` 后续给出官方表需同步。
- 移除 `incomplete_tool_call` 使一条恢复路径不可达；若将来重新支持
  OpenAI 兼容端点，需要重新引入该事件与对应终止原因。

## 验证

```bash
pnpm check              # typecheck + lint + format + 209 tests
pnpm test:coverage      # 95.8% stmts / 91.1% branch（阈值 80%）
pnpm build && node --input-type=module -e "import * as d from './dist/index.js'; ..."
```

契约关键点均有测试固化：迁移表不变量、子代理 turn 前缀往返、
13 种事件名逐字、`partial ≠ failed`、`UNKNOWN ≠ FAILURE`、`APPROVED` 非终态、
压缩摘要必须可见而审计记录不可见。
