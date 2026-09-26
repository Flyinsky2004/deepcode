# deepcode

跨客户端、跨模型的本地 Agent runtime。TypeScript 实现。

> **当前状态：Phase 0–11 主流程与自动质量门禁已实现；`readonly` OS 沙箱与真实 endpoint 验收仍待完成。**
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
pnpm test:quality     # Phase 11 定向质量回归（无需真实密钥）
pnpm test:watch       # 监听模式
pnpm test:coverage    # 覆盖率（阈值 80%）
pnpm lint             # ESLint
pnpm format           # Prettier 格式化
pnpm build            # 产出 dist/
pnpm check            # typecheck + lint + format:check + test
pnpm quality          # 完整检查 + 覆盖率门禁
```

启动 TUI：

```bash
pnpm dev
```

启动 Web UI（默认仅监听本机，无需 token，浏览器可直接进入）：

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
`--token` 和 `--cors <origin[,origin...]>`。`local` 默认不鉴权；使用 `--auth token`
或 `--token <value>` 可为本机访问开启 token。`lan` 和 `public` 默认启用 token；
`password` 会在启动时明确提示尚未实现；
`public` 监听必须启用认证；写操作还要求
`Origin` 校验和 `Idempotency-Key`。

Web 工作台提供 `/projects` 项目列表、`/projects/:id` 项目概览、
`/projects/:id/chats/:sessionId` 对话、`/commands` 命令目录和 `/settings` 配置页面；
这些地址可直接打开或刷新。页面左侧可切换项目，也可通过「打开文件夹」浏览本机目录。
同一项目的 TUI 与 Web 会话共用历史；对话输入框键入 `/` 会列出可用命令，支持方向键、
Tab 和鼠标选择。历史消息和流式回复支持 Markdown（包括代码块、列表和表格）。
右上角可切换浅色与暗色主题，选择保存在本机浏览器。
设置页面可管理供应商、模型档位、MCP 服务、TUI 语言及运行阈值；MCP 和运行阈值更改在重启后生效。

运行单个测试文件：

```bash
pnpm vitest run tests/core/ids.test.ts
pnpm vitest run -t "test name"
```

提交前请确保 `pnpm check` 通过。

## Provider 配置

在 TUI 或 Web 命令入口运行 `/api` 查看当前 provider。新增 Anthropic-compatible
endpoint 时只填写非敏感信息：

```text
/api add <名称> <base-url> <模型ID[,模型ID...]> [context-window] [max-output-tokens]
```

例如：

```text
/api add "My Provider" https://example.com/anthropic model-a,model-b 128000 8192
```

`/api` **不接收明文 API key**。命令会原子写入 provider、模型与尚未配置的
`implementation` 档位，并返回一个环境变量名，例如
`DEEPCODE_MY_PROVIDER_API_KEY`。请通过操作系统环境或自己的 secret manager 设置该变量，
然后重启 deepcode。默认不要把明文 key 写入 slash command 或 `config.json`；如果明确接受
本地明文落盘风险，才使用下方的 `value` 模式。

如明确接受明文落盘风险，也可以停止 deepcode 后编辑 `~/.deepcode/config.json`，把对应
provider 改为：

```json
"apiKeyRef": {
  "source": "value",
  "key": "实际 API key"
}
```

`source: "value"` 只允许从本地配置读取，`/api` 仍不会接收或回显明文。请至少执行
`chmod 600 ~/.deepcode/config.json`，并确保该文件不进入 Git、云同步、备份或问题报告。

模型能力使用保守缺省：工具调用开启，thinking、vision 与 1M 上下文关闭；确认 endpoint
支持后可在 `~/.deepcode/config.json` 的对应 model profile 中显式调整。`/api` 面板只显示
“密钥就绪/等待环境变量”，不会读取或回显密钥内容。

## Skills

在工作区 `skills/<名称>/SKILL.md` 或用户目录 `~/.deepcode/skills/<名称>/SKILL.md`
放置技能文件；子目录可继续嵌套，文件名必须是 `SKILL.md`。同名时工作区版本优先。
启动后可用 `/skills` 查看已加载和无效的文件，文件修改会在下一个 turn 生效。

```markdown
---
name: safe-edit
description: Use when editing files safely
version: 1.0.0
triggers: [edit]
constraints:
  - type: require_read_before_write
    reason: Read the file first
---
## Workflow
Read the target file before editing.

## Verification Checklist
Check the resulting content.
```

匹配使用旧实现的确定性关键词规则，当前只识别小写 ASCII；纯中文请求不会命中 skill。
建议在请求中加入对应的英文触发词（示例为 `edit`）。

## Sub-agent

内置 `general-purpose`、`code-reviewer`、`debugger`、`test-runner` 四个角色。模型通过
`sub_agent` 工具发起前台、后台或并行任务；子会话使用独立 transcript，可查询、取消，并可用
`continuation_handle` 在重启后恢复。自定义定义放在工作区
`.deepcode/subagents/**/*.md` 或 `~/.deepcode/subagents/**/*.md`：

```markdown
---
type: dependency-auditor
version: 1.0.0
description: Audit dependency usage without editing files
allowed_tools: [file_read, glob, grep]
denied_tools: [file_write, file_edit, sub_agent]
context_policy: project-aware
run_mode: background
working_directory_policy: readonly
visibility: summary
budget:
  max_model_calls: 6
  max_tool_calls: 12
---
Audit only the delegated scope. Cite file evidence and list unresolved questions.
```

同名定义会在启动时明确报错。子代理权限、路径、skill guard 和预算只能从父 turn 继续收窄。

## MCP

在 `~/.deepcode/config.json` 顶层配置 `mcp_servers`。支持独立的 `stdio`、
`streamable-http` 和兼容期 `sse` 连接：

```json
{
  "mcp_servers": [
    {
      "name": "local-tools",
      "transport": "stdio",
      "command": "/absolute/path/to/your-mcp-server",
      "args": [],
      "env": {},
      "timeout_ms": 30000
    },
    {
      "name": "remote-data",
      "transport": "streamable-http",
      "url": "https://example.com/mcp",
      "headers": {}
    }
  ]
}
```

远端工具以 `mcp_<server>_<tool>` 注册，并始终经过统一权限审批和执行审计。
用 `/mcp` 查看连接状态，用 `/mcp reconnect <server>` 手动重连。单个 server 故障不会阻断其它
server 或父 turn；无法确认副作用是否发生的调用会明确标记为 unknown，不会自动重放。
`readonly` 子代理只开放只读工具，并在权限层拒绝写入；当前尚未提供独立的操作系统级沙箱，
不要用它运行不受信任的本地可执行代码。

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
  observability/# 本地结构化日志、脱敏与指标聚合（Phase 11）
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
~/.deepcode/projects/<项目路径哈希>/chat.json  # 每项目会话
~/.deepcode/projects/<项目路径哈希>/events/    # 每项目事件
~/.deepcode/projects/<项目路径哈希>/project.json # 项目路径索引
```

项目 ID 由规范化绝对路径计算，同名目录不会混用历史。首次打开旧项目时，
DeepCode 会把 `<workspace>/.deepcode/chat.json`、事件和观测日志复制到新目录；
旧文件保留，新目录已有历史时不会覆盖。磁盘 JSON 的字段名与语义保持兼容。

路径解析通过参数注入 `home` / `cwd`，不直接读取全局状态，以便测试。
