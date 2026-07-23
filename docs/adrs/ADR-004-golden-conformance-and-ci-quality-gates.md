# ADR-004：Golden、Conformance 与 CI 质量门禁

- 状态：Accepted
- 日期：2026-07-23

## 背景

KineWeave 已经由同一 ProjectSession 驱动 CLI、SVG 输出、Canvas2D Stage 和 Electron Studio。只有各模块自己的单元测试，仍不足以发现工程格式、求值、Feature 协商、Renderer 语义、桌面保存与性能之间的跨层漂移。截图和像素级比较又会把字体、图形驱动与平台差异误当成领域语义，形成脆弱门禁。

## 决策

1. Golden Fixture 是可被 Repository、CLI 和 Studio 直接打开的完整工程目录，不是只存在于测试代码中的对象。确定性生成器同时负责工程内容、History 根状态、采样 Graph 和 SVG 期望产物；生成内容不得手工局部修改。
2. 当前 Golden 语义矩阵覆盖全部标准 Primitive、特殊字符、嵌套变换、透明度、可见性、number/vector2/color/boolean Track、linear/hold/cubic-bezier、External Signal 默认值和覆盖值，以及多属性运动创作后的端点与区间采样。语义改变时显式运行生成器，并把工程与期望结果作为同一个评审单元。
3. SVG 作为确定性文本输出，按完整字节做回归。Canvas2D 通过公开的无 DOM Surface Adapter 记录结构化绘制调用、Path、变换与命中结果；不把跨平台截图或字体像素作为当前语义 Oracle。
4. Studio E2E 每次创建独立的系统临时工程，通过真实 Electron Main/Preload/Renderer、ProjectSession 和 Repository 执行打开、插入、关键帧/Easing/时间移动、多选对齐、Undo/Redo、播放、显式保存与关闭保存握手；退出后同时由 Repository 和再次启动的 Studio 重开核验。仓库示例绝不作为可写 E2E Fixture。
5. 性能门禁使用版本化 Golden 工作负载，分别测量 Repository Read、ProjectSession Open、确定性求值、SVG 输出和重复 Authoring Transaction。预算是用于发现数量级回归的宽松上限，CI 同时保存原始报告；微小波动不作为失败依据。
6. Biome 是当前 TypeScript、JavaScript、JSON 和 CSS 的唯一格式与静态质量工具。Schema Validator、Golden 和性能工作负载都提供“生成”与“过期检查”两条明确路径。
7. GitHub CI 是完整门禁的权威环境：Node 22/24 执行构建、Golden、单元和 Conformance；Node 22 执行性能预算；Linux Xvfb 执行 Electron E2E。工作站可运行针对性校验，不要求为得到可信结果重复承担全部重负载。

## 结果

- 工程格式、求值 Graph 和 SVG 的有意变化会产生可审查 Diff；未重建的期望产物会被拒绝。
- Canvas2D 与 SVG 共享 Graph 语义，同时允许输出媒介本身的合理差异，例如 SVG 保留隐藏节点、Canvas2D 跳过不可见绘制。
- 桌面测试覆盖正常关闭时最重要的数据安全路径，且不会污染仓库工程。
- 性能报告具有固定工作负载和环境信息；预算可以依据多次 CI 数据调整，而不是伪装成跨硬件绝对常数。
- 当前策略不会阻止以后增加图像差异、平台矩阵、长序列或媒体基准；它们应在出现相应语义和风险后加入。

## 重新评审条件

- SVG 不再是确定性文本产物，或输出引入外部字体/资源解析；
- Canvas2D 结构化 Trace 无法代表新增 Blend、Filter、Mask、GPU 或视频语义；
- CI 性能分布频繁接近预算，或真实大型工程暴露不同热点；
- Studio 引入多窗口、多工程并发、Utility Process 或平台专属行为；
- Golden 规模使完整校验超过可接受的 CI 反馈时间。
