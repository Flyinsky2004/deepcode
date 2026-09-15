# ADR 0003：预算耗尽的收尾迁移

- **状态**：已接受
- **日期**：2026-09-15
- **阶段**：Phase 1–5 缺陷修正（运行时核心）
- **相关**：`docs/adr/0002-core-contracts.md` §五、`docs/rewrite-spec/parts/09-typescript-agent-standard.md` §2、
  `src/core/turn.ts`、`src/runtime/agent-runtime.ts`

## 背景

`AgentRuntime.runTurn()` 在预算耗尽时调用 `finish()` 收尾。`finish()` 会先做一次
阶段迁移（`transition(finalPhase, …)`），再落盘结果、发 `turn_end` 事件。

问题有**两个独立机制**，叠加后使最常见的一条路径完全失效。

### 机制一：迁移表里没有到 `budget_exceeded` 的边

`core/turn.ts` 的 `TRANSITIONS`（ADR 0002 §五）里，能直接进入
`budget_exceeded` 的只有 `calling_model` 与 `finalizing`；能进入 `finalizing`
的只有 `calling_model`。而 `finish(PARTIAL, BUDGET_EXCEEDED)` 会在**任意**活动
阶段被调用：

| 入口 | 触发时的 phase |
|---|---|
| 循环顶部发现墙钟耗尽 | `building_context` / `calling_model` |
| provider 流异常且墙钟已耗尽 | `calling_model` |
| 工具执行后发现墙钟耗尽 | `executing_tools` |
| 恢复一个预算已耗尽的 turn | `awaiting_permission` |
| 外层异常兜底 | `building_context` |

原实现只对 `executing_tools` 做了特判（`transition(calling_model)` →
`transition(finalizing)`），其余阶段一律撞上 `canTransition()` 的拒绝，
抛出 `INVALID_STATE_TRANSITION`。

**后果**：默认墙钟预算是 10 分钟，因此**任何一次 provider 流卡死**都会走到
`calling_model → budget_exceeded`——用户看到的是一个内部状态机错误，
而不是"这次超时了，结果是部分的"。

### 机制二：`return finish(...)` 没有 `await`

`finish()` 是 async 函数，而调用点普遍写成 `return finish(...)`。
`return promise` 位于 `try` 块内时，该 promise 的拒绝**不经过同层的 `catch`**
（只有 `return await promise` 才会）。于是机制一抛出的
`INVALID_STATE_TRANSITION` 直接穿透 `runTurn` 的内层 `try/catch`，
一路逃到 `submitMessage()` 的调用方。

**后果叠加**：`submitMessage()` / `resumeTurn()` **抛异常**而不是返回 `TurnResult`；
该 turn 停在原阶段、既没有 `result` 也没有终态；随后 `ChatStore.beginTurn()`
看到残留的活动阶段，以 `SESSION_BUSY` 拒绝同一会话的后续 turn ——
**会话被永久锁死**，只能手工改 `chat.json` 才能恢复。

### 为什么必须修，而不是"忠实保留"

这两条都不是旧项目的行为：旧 Python 项目没有具名状态机（ADR 0002 §五），
也就无所谓迁移边；它的收尾路径也不存在"拒绝绕过 catch"的形状。
按 `CLAUDE.md` 的缺陷处理协议，这属于**本实现的疏漏**，
不在"bug-compatible 保留"的适用范围内，**不得**标注 `// BUG-COMPAT`。

## 决策

**分两步修，互不依赖。**

### 第一步：补 `await`（已采纳）

把所有 `return finish(...)` 改为 `return await finish(...)`；三处写成
`return cond ? finish(a) : finish(b)` 的三元表达式改为 `return await (cond ? … : …)`。

这是**独立缺陷**：即便迁移边补齐，不 `await` 也会让任何从 `finish()` 逃出的拒绝
绕过同层 `catch`。改动局部、不触及契约。

### 第二步：预算耗尽统一绕行 `finalizing`（采纳方案 b）

两种候选：

- **(a) 补齐迁移边**：给 `building_context` / `compacting` /
  `awaiting_permission` / `awaiting_user_input` / `calling_model` 各加一条
  到 `budget_exceeded` 的边。
- **(b) 统一绕行 `finalizing`**：不新增任何边，用既有边组合出一条合法路径。

**选 (b)**，理由：

1. **不扩大迁移表**。迁移表是 ADR 0002 §五 冻结的契约，且规格未给出官方表；
   新增五条边会让"哪些阶段可以突然终止"这件事失去可读性。
2. **语义一致**。`finalizing` 的定义就是"预算耗尽后的一次性收尾生成"
   （`core/turn.ts`），它本来就该是 `budget_exceeded` 的**唯一**入口。
   原实现对 `executing_tools` 的特判已经在事实上承认了这一点，只是没有推广。
3. **既有边已足够**。所有活动阶段都能在至多两步内到达 `calling_model`：

   ```
   starting          → building_context → calling_model
   building_context  → calling_model
   compacting        → calling_model
   awaiting_permission / awaiting_user_input → calling_model
   executing_tools   → calling_model
   calling_model     → (自环，无需迁移)
   ```

   再从 `calling_model → finalizing → budget_exceeded`，全程合法。

**代价**：到达终态会多记 3–4 次阶段迁移（`transitions` 数组变长）。
这些迁移是**纯记账**，不会触发任何模型调用或工具执行。
**接受理由**：状态机维度的可读性与契约稳定性，比 `transitions` 数组的长度更重要；
且这些迁移恰恰是恢复时最需要的审计线索——它们说明了 turn 是被预算终止的。

**实现**（`agent-runtime.ts` 的 `finish()`）：

```ts
if (finalPhase === TurnPhase.BUDGET_EXCEEDED && phase !== TurnPhase.FINALIZING) {
  if (phase === TurnPhase.STARTING)
    await transition(TurnPhase.BUILDING_CONTEXT, 'budget checkpoint')
  if (phase !== TurnPhase.CALLING_MODEL)
    await transition(TurnPhase.CALLING_MODEL, 'budget checkpoint')
  await transition(TurnPhase.FINALIZING, 'budget exhausted')
}
await transition(finalPhase, reason ?? 'finished')
```

`transition()` 自身对 `phase === to` 直接返回，因此 `calling_model` 自环
那一步是安全的无操作；上面的 `if` 只是为了不产生一条无意义的迁移记录。

## 影响

- `submitMessage()` / `resumeTurn()` 在预算耗尽时**返回** `TurnResult`
  （`status: partial`、`terminal_reason: budget_exceeded`），而不是抛异常。
- 会话不再被 `SESSION_BUSY` 锁死：turn 必然到达终态。
- `turn_end` 事件必然发出，客户端能正确区分"超时"与"失败"。
- 恢复一条预算已耗尽的 turn（phase 为 `awaiting_permission`）同样能正常收尾。

## 未采纳的相关改动

以下问题在审查中被一并发现，但**不在本 ADR 范围内**，单独跟踪：

- `ToolExecutor` 的 `timeoutMs` 只中止传给工具的 `AbortSignal`，
  在工具返回之后才检查 `timedOut()`；完全忽略信号的工具会让执行挂住。
- `glob` 工具的 `globMatch()` 曾因替换顺序错误使所有含 `**` 的模式恒不匹配
  （已单独修正，属于新实现回归，与状态机无关）。

## 复核触发条件

若 `parts/09` 后续补充了官方的 `TurnPhase` 迁移表，**以官方为准**，
并重新评估本决策的第 2 条理由是否仍成立（ADR 0002 §五 已确立该优先级）。