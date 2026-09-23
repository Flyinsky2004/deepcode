# deepcode

跨客户端、跨模型的本地 Agent runtime。TypeScript 实现。

> **当前状态：Phase 0–7 已实现；Skill、Sub-agent、MCP（Phase 8–10）仍按进度表排期。**
> 已具备本地存储/恢复、Anthropic 流式 provider、turn 主循环、统一权限工具链、结构化上下文压缩、
> slash command 层与三端（TUI / Web UI / CLI）共用的 `AgentApplication`。
> 真实 Anthropic endpoint 的连通验收仍需用户凭据（Phase 2 的验收项）。

## 这是什么

一个终端里的 AI 编程助手：Claude Code 式的 agent 主循环（流式模型响应 → 工具调用 → 权限审批 → 循环），
加上上下文自动压缩、Skill 技能系统、Sub-agent 子代理与 MCP 工具接入。

设计目标不是"复刻一份 Python 代码"，而是得到一个**行为等价、但可跨客户端与跨模型运行**的 runtime：

- **跨客户端**：TUI、CLI、Web UI 共用同一个 Agent 内核，内核不依赖任何 UI 框架。
- **跨模型**：只实现一种线上协议（Anthropic Messages API）。供应商是 "Anthropic-compatible endpoint"，
  核心 runtime 中不存在 OpenAI / 供应商专属分支。

## 开发

要求 Node >= 22，包管理器使用 pnpm。

```bash
pnpm install

pnpm typecheck        # 类型检查（tsc --noEmit）
pnpm test             # 运行全部测试
pnpm test:watch       # 监听模式
pnpm test:coverage    # 覆盖率（阈值 80%）
pnpm lint             # ESLint
pnpm format           # Prettier 格式化
pnpm build            # 产出 dist/
pnpm check            # typecheck + lint + format:check + test
```

启动 TUI：

```bash
pnpm dev
```

启动 Web UI（默认仅监听本机，并在终端输出一次性 bearer token）：

```bash
pnpm dev --web-ui
pnpm dev --web-ui --port 8080 --host 127.0.0.1
```

生产构建后也可使用同一套参数：

```bash
pnpm build
pnpm start -- --web-ui --listen local
```

可用参数包括 `--port`、`--listen local|lan|public`、`--host`、`--auth none|token|password`、
`--token` 和 `--cors <origin[,origin...]>`。`password` 会在启动时明确提示尚未实现；
`public` 监听必须启用认证；写操作还要求
`Origin` 校验和 `Idempotency-Key`。

运行单个测试文件：

```bash
pnpm vitest run tests/core/ids.test.ts
pnpm vitest run -t "test name"
```

提交前请确保 `pnpm check` 通过。

## 权威文档

实现前**必须**先读规格。文档顺序与冲突处理见 `CLAUDE.md`。

| 文件 | 内容 |
|---|---|
| `docs/REWRITE_SPEC.md` | 总纲：架构全景、数据模型、端到端时序、权限矩阵、20 条跨切面不变量、已知缺陷与复刻决策 |
| `docs/rewrite-spec/parts/01..08-*.md` | 子系统精确规格，逐行提炼自旧 Python 源码 |
| `docs/rewrite-spec/parts/09-typescript-agent-standard.md` | **目标行为规范**。新代码、新协议、新增数据一律以它为准 |
| `progess.md` | 实施清单与阶段验收标准 |

两条最容易踩的坑：

1. **文档描述的不等于已实现。** 旧项目的设计文档里有约 22 项功能从未落地。
   照着文档补实现会超出旧项目的能力边界，反而破坏等价性。实现前先在源码里确认。
2. **已知缺陷必须显式决策。** 完整清单约 174 条分散在各 parts 文件里。
   每条要么"修正"，要么"忠实保留（bug-compatible）"并在注释中写明 `// BUG-COMPAT:` 与原因。
   不要静默修好——那会让新旧行为无法对比。

## 目录结构

```
src/
  core/         # 契约层：领域模型、接口、事件、错误码、ID、预算、Schema
                # 不依赖任何具体实现，也不依赖 Node IO
  storage/      # 持久化、事件日志、恢复（Phase 1）
  providers/    # Anthropic Messages API 与模型路由（Phase 2）
  tools/        # 工具运行时、权限引擎与内置工具（Phase 4）
  runtime/      # Agent loop、ContextEnvelope、Compact（Phase 3/5）
  skills/       # Skill 系统（Phase 8）
  subagents/    # 子代理（Phase 9）
  mcp/          # MCP 客户端（Phase 10）
  clients/      # 表现层：TUI / CLI / Web UI（Phase 7+）
tests/          # 与 src 同构的测试
```

`src/core` 是 Phase 0 的产物，只允许包含类型、接口、纯函数与 Schema——
**不允许出现文件 IO、网络调用或对具体 Provider/SDK 的依赖**。

## 设计约束

以下六条来自 `progess.md`，任何实现都不得违反：

1. Agent 内核不得依赖 TUI、Web 框架、具体模型 SDK 或 Langfuse。
2. 新模型接入只支持 Anthropic Messages API 格式。
3. 所有工具都经过统一 `PermissionEngine`，UI 或模型调用都不能绕过。
4. 所有 turn、tool call、权限请求和 compact boundary 都必须可恢复。
5. 所有异步操作都支持 `AbortSignal`。
6. 新增能力必须有结构化事件、稳定错误码和幂等语义。

此外，`docs/REWRITE_SPEC.md` §6 列出 20 条跨切面不变量（不可变数据、原子写、工具串行执行、
权限双写同步、子代理权限求交集等），动手前通读一遍。

## 数据兼容

数据目录为本项目自有路径，**与旧项目不同**：

```
~/.deepcode/config.json              # 全局配置
<workspace>/.deepcode/chat.json      # 每项目会话
```

磁盘 JSON 的**字段名与语义**必须与旧项目逐字兼容（详见 `parts/01-data-layer.md`）——
目录名不同，但文件内部结构相同。这样既保持本项目的独立身份，
又能在需要时把旧数据整体搬到新目录后直接读取。

路径解析通过参数注入 `home` / `cwd`，不直接读取全局状态，以便测试。
