# ADR-002：拆分输出/交互渲染并升级 Standard Motion v2

- 状态：Accepted
- 日期：2026-07-23

## 背景

最初的 Renderer 契约只接收一张 Presentation Graph 并返回 UTF-8 文本。它足以验证 SVG 导出，却无法诚实表达二进制产物、Output Profile 的目标语义，也无法承载 Stage 的 Surface 生命周期、连续帧、Resize 和命中测试。Standard Motion v1 同时只有 group/text，无法用第二种异构 Renderer 检验形状、可见性和几何命中的一致性。

## 决策

1. 删除实验性的单一 Presentation Renderer Capability，直接建立 Output Renderer 与 Interactive Renderer 两个 Capability，不保留旧方法或 Capability ID 别名。
2. Output 请求必须携带 qualified `target`，并把 Graph Feature、Output Profile Feature 与 Target 合并参与 Provider 解析。产物以 `kind` 区分文本和 `Uint8Array` 二进制，宿主不得自行猜测或转码。
3. Interactive Provider 在宿主拥有的 qualified Surface 上打开会话；Render Engine 统一校验 Graph/Surface、包装 Provider 失败、检查后续帧 Feature，并管理 Update、Resize、Hit Test、幂等 Dispose 与 ProjectSession 级回收。
4. Standard Motion 当前格式直接升级为 Composition/Node Schema v2。标准节点加入 rectangle、ellipse、path；公共属性加入 visible；形状加入 size/path/fill/stroke/strokeWidth/cornerRadius；值系统加入 boolean；关键帧加入确定性 cubic-bezier x 曲线求解。开发期不读取 v1。
5. Presentation Graph v1 增加对应标准 Primitive 及严格载荷校验。版本号暂不变化，因为 Graph 的既有扩展模型允许新增由 Feature 协商约束的 Primitive，且当前没有已发布兼容承诺。
6. SVG Output Renderer 覆盖全部当前标准 Primitive。Canvas2D Interactive Renderer 使用宿主适配的 Canvas 2D 子集，执行设备像素比、contain 布局、层级仿射变换与反向绘制顺序命中；核心包不依赖 DOM 类型或原生 Canvas 包。

## 结果

- CLI 文件导出和 Studio 即时预览不再共享错误的生命周期抽象。
- Output Profile 的 `target` 与 `requiredFeatures` 成为真实的能力选择输入。
- ProjectSession 在释放扩展前先关闭活动渲染会话，避免 Provider 生命周期倒置。
- Standard Motion、示例工程、History Root、Manifest、Lockfile 和测试只保留当前 v2 语义。
- Canvas2D Surface 的具体 DOM/桌面适配由宿主负责；下一阶段 Studio 将提供首个真实适配并持续检验接口。
