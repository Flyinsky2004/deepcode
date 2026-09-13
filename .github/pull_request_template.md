## 变更内容

<!-- 简要说明这个 PR 做了什么、为什么需要 -->

## 规格依据

<!-- 指向实现所依据的规格章节，例如 docs/REWRITE_SPEC.md §4.2、parts/04-5 -->

- 规格章节：
- 对应 Phase（progess.md）：

## 缺陷决策

<!--
REWRITE_SPEC.md §7 要求对每条已知缺陷显式决策，不得静默修好。
若本 PR 触及某条缺陷，请填写；没有则写"无"。
-->

| 缺陷编号 | 决策 | 理由 |
|---|---|---|
| | 修正 / BUG-COMPAT | |

- [ ] 保留旧行为的代码处已标注 `// BUG-COMPAT: <原因>`
- [ ] 相应行为已在测试中固化

## 不变量自查

<!-- 见 REWRITE_SPEC.md §6。只勾选本 PR 实际涉及的 -->

- [ ] 不可变数据：状态更新为构造新对象，无原地修改
- [ ] 原子写：持久化经临时文件 + rename
- [ ] 工具串行执行：同一轮的多个 tool call 顺序 await
- [ ] 权限双写同步：执行层权限表与 prompt 层描述一致
- [ ] 所有异步操作支持 `AbortSignal`
- [ ] 子代理权限为交集，未放大父权限
- [ ] 新增错误码已登记分类（`ERROR_CATEGORY`）
- [ ] 路径逃逸防护：文件操作经统一的路径校验

## 测试

- [ ] `pnpm check` 通过（typecheck + lint + format + test）
- [ ] 覆盖率达标（80%）
- [ ] 新增/修改的行为有测试覆盖

<!-- 测试计划：说明如何验证，尤其是需要手动验证的部分 -->

## 备注

<!-- 遗留问题、后续工作、需要 reviewer 特别关注的地方 -->

🤖 Generated with [Claude Code](https://claude.com/claude-code)
