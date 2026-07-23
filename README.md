# KineWeave / 织时

KineWeave 是一个本地优先、模型无关、可编程的时间视觉创作环境。它以开放工程、统一事务、精确时间、可替换扩展和渲染无关的求值体系为基础，面向视频、动态图形、数据视觉、交互动画和实时视觉。

当前仓库从空目录开始建设。我们采用“愿景约束下的演进式设计”：不做抛弃式 MVP，也不假设现在就能设计出永久正确的架构。每一阶段根据已有场景做出足够支撑施工的判断，在实现和验证中继续修正。开发期代码接口、持久化数据和消息协议都只认仓库当前版本；设计变化时直接修改 Schema、实现和全部调用方，并重建 Fixture、样例与开发工程，不建立兼容垫片或草稿迁移链。第一次公开格式基线发布后才开始承担真实兼容责任。

## 当前施工状态

工程内核、两条渲染链路、首个桌面创作宿主和持续质量基线已经贯通，但各子系统仍会随真实编辑场景继续扩展：

1. 身份、资源 URI、Rational、开放工程格式和当前版本校验；
2. Schema、未知字段往返和带 Journal 的原子 Project Repository；
3. 宿主/Runtime 感知的扩展生命周期、惰性 ESM 入口、Manifest/注册贡献核验、全局回溯 Capability Planning、Distribution Profile、确定性绑定和 Lockfile；
4. 宿主无关的 ProjectSession、Node 持久化会话、Operation、事务、Patch、持久化 Commit DAG、Branch、Undo/Redo；
5. Standard Motion v2、精确时间求值和 Presentation Graph，当前覆盖 group、text、rectangle、ellipse、path、可见性与 cubic-bezier 关键帧；
6. 相互独立的 Output/Interactive Renderer Capability：SVG 负责持久化输出，Canvas2D 负责高 DPI 即时绘制、帧更新和命中测试；
7. CLI 参考宿主贯通工程编辑、历史、求值和文件渲染；
8. Electron Studio 以隔离 Renderer 中唯一的 ProjectSession 驱动播放、图层、Inspector、历史和 Timeline；当前支持时长、Track/Keyframe/Easing 编辑，以及 Stage 多选、框选、吸附、对齐、等比缩放、旋转和 Anchor 调整，Main Process 只负责原生目录选择与 Repository 原子持久化；
9. 四个可直接打开的 Golden Projects、九个确定性求值采样、SVG 字节回归、无 DOM Canvas2D Conformance、覆盖运动创作与重新打开的临时工程桌面 E2E、包含创作事务的版本化性能预算、Biome 质量门禁和 GitHub CI。

Foundation 1–4 和第一轮运动创作闭环已经建立。下一施工焦点会继续扩展曲线与时间组织、媒体和更丰富的创作工作流，并用 Golden、Conformance、E2E 和性能数据反推现有边界；这是一条可持续演进的基线，不是终局架构。

总体施工蓝图见 [foundation-blueprint.md](docs/architecture/foundation-blueprint.md)，质量策略见 [quality-strategy.md](docs/testing/quality-strategy.md)，兼容政策见 [RFC-000](docs/rfcs/RFC-000-compatibility-and-evolution.md)。

## 技术基线

- TypeScript：协议、Kernel、SDK、编辑器与 CLI；
- Rust：后续媒体、帧传输、原生桥接和性能敏感模块；
- pnpm workspace；
- Node.js 22+ 作为首个 CLI/桌面宿主基线。

仓库当前仍处于基础设施施工期；README 只描述已经确定的方向，不宣称尚未实现的产品能力。

## 当前可运行入口

```bash
pnpm install
pnpm quality
pnpm test
pnpm test:e2e
pnpm perf
pnpm example:validate

pnpm studio --project ./playground-projects/hello

pnpm cli init ./playground-projects/hello --name "Hello KineWeave"
pnpm cli validate ./playground-projects/hello
pnpm cli inspect ./playground-projects/hello
pnpm cli evaluate ./playground-projects/hello document_main 1/2 --json
pnpm cli render ./playground-projects/hello document_main 1/2 ./playground-projects/frame.svg --json
pnpm cli history ./playground-projects/hello
pnpm cli set-property ./playground-projects/hello document_main node_headline content '"你好，织时"'
pnpm cli insert-text ./playground-projects/hello document_main node_subtitle "Subtitle" --index 1
pnpm cli branch create ./playground-projects/hello proposal/alternate
pnpm cli set-property ./playground-projects/hello document_main node_headline content '"备选标题"' --branch proposal/alternate
pnpm cli undo ./playground-projects/hello
pnpm cli redo ./playground-projects/hello
```

`pnpm test` 会构建全部工作区、校验生成的 Schema Validator 与 Golden Projects，再执行单元和 Conformance 测试。`pnpm check` 还会追加 Biome 与性能预算；`pnpm generate:goldens` 只在有意改变工程语义或渲染结果时重建 Golden。桌面 E2E 和性能基准由 GitHub CI 提供权威运行环境，日常开发可以先执行针对性测试与 `pnpm quality`。

CLI 通过共享的 ProjectSession、Node Project Session 和官方 Distribution Profile 使用 Project Repository、Extension Host、Transaction Engine、Evaluation Engine 与 Render Engine，不维护独立的文件修改或求值逻辑。文档与 `.kineweave/history/history.json` 中的 Commit DAG/Branch Ref 在同一个文件事务中保存；写操作可以显式提交到非主分支，而磁盘上的物化文档始终对应主分支。`evaluate` 可读取当前 Branch 或指定 Commit，`render` 通过 Output Profile 的 `target`、附加 Feature、Capability 与 Lockfile 选择兼容输出 Renderer，并按文本或二进制产物原样写入。Studio 在同一个工程会话上使用 Interactive Renderer；它的 Main/Preload/Renderer 边界、关闭保存握手和 CSP 约束见 [ADR-003](docs/adrs/ADR-003-studio-desktop-host.md)，运动创作、时间编辑与舞台变换语义见 [ADR-005](docs/adrs/ADR-005-motion-authoring-semantics.md)。Primitive、Custom Packet、Color Space、输出目标与 Surface Type 都进入 Feature 协商，缺失能力、Manifest 声明与实际注册不一致或扩展输出结构错误时都会被明确拒绝。
