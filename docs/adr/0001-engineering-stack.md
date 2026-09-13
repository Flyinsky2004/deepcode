# ADR 0001：工程骨架与工具链选型

- **状态**：已接受
- **日期**：2026-09-14
- **阶段**：Phase 0（工程骨架与契约冻结）
- **相关**：`progess.md` Phase 0、`docs/rewrite-spec/parts/09-typescript-agent-standard.md` §1

## 背景

`progess.md` Phase 0 的第一项工作是「配置 TypeScript、ESM/CJS 策略、lint、format、test、build」。
这是一次性且**代价高昂的不可逆决策**——模块系统与构建产物的形状一旦被下游依赖，
后期更换会波及每一个文件。因此把选型与理由记录下来，而不是让它们隐式地散落在配置里。

## 决策

### 1. 纯 ESM，不产出 CJS

`"type": "module"`，`module` / `moduleResolution` 均为 `NodeNext`，`target: ES2023`，
`engines.node >= 22`。

**理由**：本项目是**应用**而非需要被旧工具链消费的库。`parts/09` §1 的接口定义与
`AsyncIterable` 流式消费都建立在现代语法上。双构建会引入
"dual package hazard"——同一个类在 ESM 与 CJS 下是两个不同的对象，
`instanceof AgentError` 会随机失败。这对一个把"结构化错误码"当作契约的项目是不可接受的。

**代价**：依赖必须提供 ESM 入口。当前依赖（zod）满足。

### 2. 导入路径必须带 `.js` 后缀

`NodeNext` 要求显式扩展名。这是 ESM 的硬约束，不是风格偏好。

### 3. TypeScript 6.x，而非 7.x

`typescript-eslint` 的 peer 范围是 `>=4.8.4 <6.1.0`，而 npm 的 `latest` 已是 7.0.2。
安装最新版会产生 unmet peer 警告，且 lint 规则可能因 AST 变化而静默失效。

**选择**：装 `typescript@^6.0.3`，版本对齐 lint 工具链。
**复审时机**：`typescript-eslint` 支持 ≥7 后升级。升级时应先确认类型化规则仍实际生效
（见下文的验证方法）。

### 4. 严格性开关：全开

`strict` 之外还开启了几个对本项目契约有直接作用的开关：

| 开关 | 作用 |
|---|---|
| `exactOptionalPropertyTypes` | 区分"字段不存在"与"字段为 undefined"。与 `parts/09` §4 的可选字段序列化契约直接相关——`maxCost?: number` 缺失时不得被当成 `0` |
| `noUncheckedIndexedAccess` | 索引访问返回 `T \| undefined`。旧项目有 `parsed["content"]` 下标访问导致 `KeyError` 冒泡的缺陷（`E-DL-1`），此开关在编译期拦截同类问题 |
| `verbatimModuleSyntax` | 类型导入必须显式 `import type`。避免类型被误当值导入而产生运行期副作用 |
| `useUnknownInCatchVariables` | `catch` 变量为 `unknown`，强制经 `toAgentError()` 归一化 |
| `noPropertyAccessFromIndexSignature` | 索引签名必须用 `obj['k']` 访问，让"这里是动态键"显式可见 |

### 5. 测试：Vitest

原生 TS 支持（无需预编译步骤）、内置覆盖率与快照、与 ESM 兼容良好。
覆盖率阈值设为 80%（`~/.claude/rules/common/testing.md` 的要求）。

E2E 按 `~/.claude/rules/typescript/testing.md` 使用 Playwright，属于 Phase 7（Web UI）。

### 6. 包管理器：pnpm

依赖隔离严格，避免幽灵依赖。本项目分层清晰（内核不得依赖 UI/Provider SDK），
幽灵依赖会让"某个模块偷偷用了未声明的依赖"无法被发现，直接侵蚀架构约束。

### 7. 数据目录改用 `.deepcode`，与旧项目不共用

数据目录为 `~/.deepcode/config.json` 与 `<workspace>/.deepcode/chat.json`，
**不复用**旧项目的 `~/.flyinchat/`。

**理由**：本项目是独立产品，不是旧项目的就地升级版。共用目录有两个实际问题：
两套实现并发写同一个 `chat.json` 会互相覆盖（旧项目本身就是全量重写，
REWRITE_SPEC §7.6 记录了这个竞态），以及用户无法分辨某个会话是哪个实现写的。

**兼容性如何保持**：`REWRITE_SPEC.md` §0.3 把"数据兼容"定义为
「能读旧项目写的 config.json 和 chat.json，**字段名与语义一致**」——
它约束的是**文件内部结构**，不是目录名。因此：
- 文件内的全部字段名、字段语义、schema version 保持逐字兼容；
- 目录名是新的；
- 把旧数据整体复制到 `.deepcode/` 后应能直接读取。

**需要注意的偏离**：`REWRITE_SPEC.md` §0.3 的字面表述点名了 `~/.flyinchat/` 路径。
本决策是对它的**有意偏离**，仅限目录名。若后续要支持"直接读取旧目录"，
应实现为显式的导入命令（`deepcode import --from ~/.flyinchat`），
而不是让两套实现共享可写目录。

**验收影响**：`REWRITE_SPEC.md` §8 阶段 1 的验收项
「能用旧项目的 config.json + chat.json 完成全部 CRUD 往返」**依然成立**——
把两个文件放进 `.deepcode/` 即可，不需要改文件内容。

## 后果

**正面**
- 单一模块格式，无 dual-package hazard。
- 严格性开关在编译期拦截旧项目已知的几类缺陷（下标访问、可选字段语义、未归一化的 catch）。
- `pnpm check` 一条命令覆盖 typecheck / lint / format / test。

**负面 / 待偿付**
- 不能直接 `require()`，若未来需要 CJS 消费方需引入构建期转换。
- TypeScript 落后 `latest` 一个大版本，需关注 `typescript-eslint` 的跟进。
- 覆盖率当前由 `src/core` 承担（94%）。Phase 1 引入文件 IO 后，
  覆盖率会下降，需要为新模块补测试而不是下调阈值。

## 验证方法

类型化 lint 规则**必须实测确认生效**，不能只看配置是否正确。
`typescript-eslint` 在 TypeScript 版本不匹配时会静默退化为非类型化规则，
表现为"lint 通过但什么都没检查"。

```bash
# 写入一个故意违规的探针，确认规则确实报错
cat > src/__lintprobe.ts <<'EOF'
export async function probe(): Promise<void> {
  const p = Promise.resolve(1)
  p
  try { throw new Error('x') } catch (e) {}
}
EOF
pnpm lint        # 应报 no-floating-promises / require-await / no-unused-vars / no-empty
rm src/__lintprobe.ts
```

升级 TypeScript 或 `typescript-eslint` 后必须重跑此验证。
