# ADR-001：统一 ProjectSession 与可核验的扩展装载

- 状态：Accepted
- 日期：2026-07-23

## 背景

第一条 CLI 纵向链路曾在应用内部直接组合 Repository、History、Transaction、Evaluation、Render 和两个官方扩展。这证明了基础机制能够协作，但继续复制该组合方式会让 CLI、Studio 和渲染节点形成不同的工程语义。扩展 Manifest 同时已经声明入口与贡献，却仍由 CLI 静态包装激活函数，`exportName` 和 `contributes` 没有成为可执行契约。

## 决策

1. `@kineweave/project-session` 作为宿主无关的工程运行会话，统一持有 History、Transaction、Evaluation、Render 和 Extension Host。
2. `@kineweave/project-session-node` 负责 Node Project Repository 的打开、连续保存和 Snapshot 更新，不把文件路径或 Node API 带入核心会话。
3. 官方默认能力由 `@kineweave/official-distribution` 的 Distribution Profile 提供；工程 Manifest 表达需求，Lockfile 表达已解析结果，Distribution Profile 表达发行版默认实现。
4. 当前 TypeScript 扩展使用 `in-process` Runtime 和惰性 ESM 入口。Discover 阶段只取得 Manifest；Load 阶段才导入所选模块并解析 `exportName`；Activate 阶段才允许注册贡献。
5. 激活期间包装公开贡献注册表，核对 Document Type、Operation、Evaluator 和 Capability Provider 的实际注册与 Manifest 声明。缺失、额外或描述不一致都使会话打开失败，并触发已激活扩展的回收。
6. 写事务显式携带目标 Branch。Canonical Documents 仍物化主分支，其他分支状态保存在同一 Commit DAG 中。

## 结果

- CLI 与后续 Studio 可以共享同一工程语义、扩展计划和诊断路径。
- 长生命周期宿主可以连续保存同一工程会话，不会复用过期 Repository Snapshot。
- 官方扩展继续使用社区可见的入口和注册接口，不获得隐藏装载路径。
- `in-process` 只描述当前真实执行方式；Worker、Workbench、WASM、Native 和 External Process 在存在对应宿主实现时分别接入，不用名称伪装隔离能力。
- 开发期所有接口仍为 Experimental；设计变化时同步修改 Manifest、入口、调用方、测试与样例，不保留旧 CLI Runtime 兼容层。
