# ADR 0005：项目运行数据集中存放

## 决策

全局配置仍放在 `~/.deepcode/config.json`。项目会话、事件与观测日志放在
`~/.deepcode/projects/<项目路径哈希>/`。哈希输入为项目目录的规范化绝对路径；
目录内的 `project.json` 保存路径、名称与最近打开时间，供 Web 选择项目。

TUI 根据启动时的工作目录解析项目，Web 可以浏览本机目录并打开。两种客户端
使用同一套 `AppPaths` 和 `ChatStore`，因此同项目的对话历史共享。

首次打开旧项目时，若集中目录还没有 `chat.json`，复制
`<workspace>/.deepcode/chat.json` 及其事件、观测日志。保留旧文件；已有集中历史
绝不被旧快照覆盖。

## 取代的旧决策

本决策取代 ADR 0001 第 7 节中“项目会话放在工作区 `.deepcode`”的路径约定。
独立于旧 FlyinChat 数据目录的产品边界保持不变。
