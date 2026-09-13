# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 仓库现状

**本仓库目前只有文档，没有任何代码。** 没有 `package.json` / `tsconfig.json`，因此**当前没有可运行的构建、lint 或测试命令**——不要假装它们存在，也不要凭空发明命令。

工作内容是：在 TypeScript 中把旧的 Python 项目 FlyinChat 复刻为一个可跨客户端、跨模型运行的本地 Agent。

- 规格：`docs/REWRITE_SPEC.md`（总纲）+ `docs/rewrite-spec/parts/01..09-*.md`（子系统）
- 实施清单：`progess.md`（注意：文件名拼写少一个 `r`，不是 `progress.md`）
- `.omc/` 是 oh-my-claudecode 工具的会话状态，**不是本项目内容**，不要编辑或提交它。
- 工程骨架属于 Phase 0 的第一项工作；其验收标准是 `npm test` 可运行、`import` runtime 不依赖 TUI。在那之前不要写依赖具体构建链的代码。

## 文档权威顺序（冲突时以此为准）

| 优先级 | 来源 | 说明 |
|---|---|---|
| 1 | 旧 Python 源码（`src/flyinchat/**`，另有独立仓库） | 行为绝对权威 |
| 2 | `docs/REWRITE_SPEC.md` + `parts/01..08` | 从源码逐行提炼；与源码冲突以源码为准 |
| 3 | `docs/` 历史设计文档 | 设计意图权威，实现细节可能已过时 |
| 4 | README / CLAUDE.md | 面向用户的概览，可能滞后 |
| ★ | `parts/09-typescript-agent-standard.md` | 目标行为规范。**新代码、新协议、新增数据一律以它为准**；只有"读取旧数据以保持兼容"时才退回 `01..08` 的偶然细节 |

## 最重要的一条规则：文档 ≠ 实现

`docs/` 里大量内容是**设计愿景**，不是实现说明。已知至少 12 项文档描述的功能从未落地（`REWRITE_SPEC.md` §0.2.1 与 `parts/08` §6 合计列出 22 条文档/代码不一致）。

**实现任何特性前，先在旧源码里确认它真的存在。** 照着文档补实现会超出旧项目的实际能力边界，反而破坏等价性。典型例子：Skill 语义检索 / 向量库（未实现，不要引入）、`TaskCreate/TaskList`（那是 Claude Code 调研资料，不是本项目设计）、Sub-agent 的 `run_mode` / `continuation_handle`（旧项目只有默认值）。

## 缺陷处理协议（`REWRITE_SPEC.md` §7）

§7 只收录了 19 条精选缺陷，**完整清单约 174 条分散在各 parts 文件里**（覆盖度对照表见 §7.10）。实现某个子系统前必须先读该 part 的缺陷段。

对每一条必须**显式决策**，二选一：

- **修正** → 按 §7 的"复刻决策建议"改，并在测试中固化新行为。
- **忠实保留（bug-compatible）** → 在代码注释写明 `// BUG-COMPAT: 保留旧实现行为，原因：<...>`，并在测试中固化旧行为。

**不要静默地"顺手修好"**——静默修正会让新旧行为无法对比，也会破坏以旧项目为基准的回归测试。

## 系统概览

一句话：Terminal 里的 AI 编程助手 = Claude Code 式的 agent 主循环（流式模型响应 → 工具调用 → 权限审批 → 循环）+ 上下文压缩 + Skill + Sub-agent + MCP。

分层（**内核不得依赖 TUI、具体模型 SDK、Langfuse**）：

```
表现层   TUI / Web UI（--web-ui）
   ↕  on_event(event) 单向推送 ／ resolve_permission() 显式回灌  ← 唯一双向交互
编排层   Agent 主循环 + prompt 组装 + context/compact
运行时   工具与权限 ／ Provider ／ Skill ／ Sub-agent ／ MCP
数据层   不可变领域模型 ／ JSON 原子读写 ／ 路径解析 ／ 消息格式转换
```

复刻必须保持的边界：**UI 只能发 `UserMessage` / `CommandRequest` / `PermissionResolution` / `CancelRequest`，只能消费事件流，不得直接改会话、权限或工具状态**（`parts/09` §1）。

计划中的目录结构（`progess.md` Phase 0）：`src/core`、`src/storage`、`src/providers`、`src/tools`、`src/skills`、`src/subagents`、`src/mcp`、`src/clients`。

## 实施顺序与约束

按 `progess.md` 的 Phase 0 → 11 推进，**每个阶段验收通过才进入下一阶段**。六条设计约束（同文件）：

1. Agent 内核不得依赖 TUI、Web 框架、具体模型 SDK 或 Langfuse。
2. 新模型接入**只支持 Anthropic Messages API 格式**——供应商是 "Anthropic-compatible endpoint"，不是协议类型；核心 runtime 里不得出现 OpenAI Chat Completions / Responses 或供应商专属分支。
3. 所有工具都经过统一 `PermissionEngine`，UI 和模型调用都不能绕过。
4. 所有 turn、tool call、权限请求和 compact boundary 都必须可恢复。
5. 所有异步操作都支持 `AbortSignal`。
6. 新增能力必须有结构化事件、稳定错误码和幂等语义。

## 硬性约定

- **提示词逐字一致**：system prompt 各段、工具 description、自动续跑注入文本直接决定模型行为，改写即导致行为不等价。
- **权限双写同步**：执行层的模式权限表与 prompt 层的模式描述必须一致，否则模型会尝试被拒绝的操作。
- **阈值常量原样保留**：超时、截断长度、重试次数、token 预算等，并且不得硬编码在局部——按 `parts/09` §3 收进配置，在父子代理之间显式传递与扣减。
- **磁盘 JSON 字段名与语义必须与旧项目兼容**。数据目录为本项目自有路径
  （`~/.deepcode/config.json`、`<workspace>/.deepcode/chat.json`），
  与旧项目的 `~/.flyinchat/` **不同**——目录名是新的，文件内部结构逐字兼容。
- **不可变数据**：状态更新 = 构造新对象，绝不原地修改；**原子写**：临时文件 + rename。
- **工具串行执行**：同一轮的多个 tool call 顺序 await，不并发。
- **子代理权限是交集**：`childPermission = parentPermission ∩ definitionPermission ∩ runtimePolicy`，且 `sub_agent` 永远从子注册表剔除——委派不能提升权限，子代理不能递归。
- 文档、注释与 git 提交信息统一用**中文**。

`REWRITE_SPEC.md` §6 列了 20 条跨切面不变量，动手前通读一遍。

## 常用命令

查询某个子系统的缺陷清单与收敛情况（以数据层为例，`§7.10` 提供的方法）：

```bash
grep -n "^### 9\.\|^| [0-9]" docs/rewrite-spec/parts/01-data-layer.md   # 该 part 的缺陷标题
grep -n "§7\." docs/REWRITE_SPEC.md                                      # 总纲已收录哪几条
```

定位规格：总纲是导航与决策框架，子系统细节一律在 `parts/`。规模参考——`01` 数据层 1546 行、`02` 主循环 1564、`03` Provider 1118、`04` 工具 1833、`05` TUI 1779、`06` Skill+Sub-agent 2656、`07` MCP+可观测性 2393、`08` 设计意图 1498、`09` TS 标准 369。

## 给新任务的起点

```text
1. 读 docs/REWRITE_SPEC.md 全文 → 画出整体形状
2. 读当前任务对应的 parts/0X 全文（逐字，不要跳读）
3. 读 REWRITE_SPEC §7 + 该 part 的缺陷段 → 逐条决策
4. 读 parts/09 对应章节 → 确认目标行为（与 01..08 冲突时以 09 为准）
5. 按 progess.md 的阶段顺序实现
```

规格未覆盖的细节：先查对应 part → 再查 `docs/` 历史设计文档了解意图 → 仍不明确则按"最小惊讶原则"实现，**并在代码注释里标注这是推测**。
