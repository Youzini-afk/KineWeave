# KineWeave 持续质量策略

- 状态：Working Practice
- 日期：2026-07-23

质量门禁的目标不是证明当前架构永久正确，而是让跨工程格式、求值、渲染和宿主的语义变化立即可见，并为后续直接重构提供可信反馈。开发期仍只支持仓库当前协议版本；改变语义时同步修改实现、Fixture 和调用方，不维护旧草稿兼容链。

## 1. 门禁分层

| 层级 | 主要入口 | 覆盖内容 | 失败意味着什么 |
| --- | --- | --- | --- |
| 格式与静态质量 | `pnpm quality` | Biome 格式、导入、可疑代码和基础规则 | 源码或配置未达到仓库统一规范 |
| Schema 代码生成 | `pnpm check:schema-validators` | CSP-safe AJV Standalone 产物与 Schema 同步 | 运行时 Validator 已过期 |
| 单元与契约 | `vitest run` | Protocol、Repository、History、Extension、Transaction、Evaluation、Renderer、Studio Model | 一个局部契约或失败路径回归 |
| Golden Project | `pnpm check:goldens` | 完整工程、History、五个采样 Graph 与 SVG | 工程语义、确定性求值或输出发生未确认变化 |
| Renderer Conformance | Vitest 中的 `renderer-conformance.test.ts` | 同一 Graph 的 SVG 字节和 Canvas2D 绘制/命中语义 | Renderer 对 Presentation Graph 的解释分叉 |
| Studio E2E | `pnpm test:e2e` | 真实 Electron 打开、编辑、历史、播放、保存和关闭握手 | 宿主边界或用户关键工作流断裂 |
| 性能预算 | `pnpm perf` | Repository、Session、120 帧求值、120 次 SVG 输出 | 当前工作负载出现数量级回归 |

`pnpm test` 会先构建，再校验 Golden，最后执行单元和 Conformance。`pnpm check` 是本地完整入口；GitHub CI 将质量、Node 22/24 单元、性能与桌面 E2E 分成独立 Job，使失败归因和反馈更清楚。

## 2. Golden Projects

Golden 位于 `examples/golden/`，都是完整工程：

- `core-static-scene`：全部标准 Primitive、层级、通用变换、透明度、Stroke 和 XML 特殊字符；
- `animated-signals`：vector2 cubic-bezier、number hold/linear、color linear、boolean hold、External Signal 默认值与覆盖值，采样 0、2.5、5 秒；
- `transforms-visibility`：嵌套 Group、Anchor、非均匀 Scale、Rotation、父级 Opacity、`visible=false` 与 `opacity=0`。

`scripts/generate-golden-projects.mjs` 是唯一生成入口。它以官方 Template 构造当前模型，重建 History 根状态，用 desktop ProjectSession 激活官方 Distribution，执行确定性求值，再通过正式 Output Capability 生成 SVG。检查模式还会由 NodeProjectRepository 重读磁盘工程，并对 Bundle、Graph 和 SVG 做完整比较。

有意改变模型或渲染语义时：

1. 修改实现和生成器中的场景意图；
2. 运行 `pnpm generate:goldens`；
3. 审查工程 JSON、Graph 和 SVG Diff，确认变化来自预期语义；
4. 提交生成器与全部生成文件，不单独接受某一个快照。

## 3. Renderer Conformance

SVG 是纯文本确定性 Renderer，因此期望产物按字节比较。Canvas2D 是长生命周期 Interactive Renderer，Conformance 使用实现公开的 `Canvas2DContextLike` 和 `createPath2D` 接缝，在 Node 中记录绘制调用，无需浏览器 DOM。

共同断言包括全部标准 Primitive、层级顺序、变换、透明度、来源 URI 和样式；后端特有断言包括：

- SVG 对特殊文本/属性正确转义，并为隐藏节点保留 `display="none"` 或 `opacity="0"`；
- Canvas2D 跳过不可见节点，不为它们建立命中记录，并按逆绘制顺序返回 topmost/all 命中；
- 文本像素与字体 Metrics 不作跨 Renderer 等价断言，Canvas 测试只使用固定 Fake Metrics 验证自身契约。

## 4. Studio E2E 隔离

E2E 使用系统临时目录和官方 Template 创建工程，启动已构建的 Studio 并通过 `--project` 打开。测试只依赖产品语义 Hook，例如 `data-phase`、`data-dirty`、`data-node-id`、ARIA 状态和保存状态；不增加测试专用领域分支。

关闭路径必须通过原生 BrowserWindow close 触发 Main/Renderer 握手。测试等待 Electron 退出后，用独立 NodeProjectRepository 重开临时工程，确认未显式保存的最后一次重命名也已持久化。无论成功失败都清理临时目录；`examples/` 不可作为可写测试目录。

## 5. 性能预算

版本化工作负载位于 `benchmarks/foundation-baseline.json`，执行器是 `scripts/benchmark-foundation.mjs`。Baseline 保留首个全绿 GitHub Actions 运行的环境、实测值与来源 Run ID；每次新报告同时包含该参考、当前 Node/平台/架构、各阶段 total/p50/p95/max 和 SVG 字节数。

当前预算刻意高于正常 CI 耗时，用来发现死循环、意外 I/O、重复装配和数量级退化，而不是拒绝几个毫秒的噪声。调整预算必须同时说明工作负载是否改变，并查看多次 `foundation-performance` Artifact；不能因为单次失败直接放宽阈值。

## 6. CI 与故障处理

GitHub CI 包含四类 Job：

- `Quality`：Node 22 上执行 Biome；
- `Unit and Golden`：Node 22/24 上构建并执行 Golden、单元和 Conformance；
- `Foundation performance`：Node 22 上生成并上传 JSON 报告；
- `Studio desktop E2E`：在 Ubuntu Xvfb 中执行真实 Electron 工作流。

失败时先按 Job 确定层级，再看结构化 Diagnostic、Golden Diff、E2E 页面错误或性能报告。修复应针对最先破坏的契约；不要通过删除断言、更新所有快照或放宽预算掩盖原因。
