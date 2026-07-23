# ADR-005：运动创作、时间编辑与舞台变换语义

- 状态：Accepted
- 日期：2026-07-23

## 背景

KineWeave 已经用同一个 ProjectSession 贯通工程、事务、历史、求值、输出和 Studio，但“能够求值一条 Track”不等于“能够可靠地创作运动”。时间线、Inspector 和 Stage 如果分别修改文档对象、各自解释当前值，或在每次 Pointer Move 时提交事务，就会形成互相冲突的编辑语义、碎裂的撤销历史和播放期间的竞态。嵌套变换还要求明确区分 Stage、父节点与节点局部坐标；当前 TRS 模型也不能精确表达非均匀父变换下的任意世界空间旋转。

## 决策

1. Standard Motion 扩展正式拥有时长、Track 创建/删除、Keyframe Upsert/移动/删除和 Easing 修改操作。属性绑定到 Track 后，通用 Set Property 不得绕过 Track 写回 Constant。Keyframe 使用与 Composition Duration 相同的精确时间域，规范化后时间唯一，并限制在 `[0, duration]`；Easing 属于该 Keyframe 到下一 Keyframe 的 outgoing 区间。
2. Studio 的时间编辑以当前 Playhead 的求值结果为基线。Constant 或缺省属性第一次打关键帧时转为 Track；Track 属性在当前时刻 Upsert；Signal 属性保持只读。Inspector 编辑 Track 属性时写当前时刻的 Keyframe，不把整条动画降回 Constant。删除最后一个 Keyframe 会显式删除 Track，并把删除时刻的已求值属性冻结为 Constant。
3. 一个用户意图对应一个 TransactionProposal。一次 Stage 移动、缩放、旋转、Anchor 调整、对齐或一次时间线关键帧操作只产生一个可撤销提交；Pointer Move 和拖拽预览只更新临时 Overlay，不写 Canonical Project State。操作失败整体回滚，不保留半完成属性更新。
4. 时间线展示可编辑属性的 Binding 状态、全部关键帧和 outgoing Easing。拖拽与键盘移动先按交互粒度量化，再写为精确 Rational；目标时刻冲突直接拒绝，不自动挤压、合并或重排其他关键帧。Composition Duration 缩短到已有关键帧之前时同样拒绝，由用户先处理超界关键帧。
5. Stage 选择集合不同时包含祖先和后代，避免同一可见内容被重复变换。移动和对齐把 Surface Delta 通过父节点 World Transform 的线性逆映射到 Position；Anchor 调整同时补偿 Position 以保持画面不跳；多选等比缩放和旋转围绕统一 Pivot，在一个事务中更新全部节点。吸附只影响手势结果，Alt 可临时关闭，Shift 提供轴锁定或角度量化。
6. 世界空间旋转柄只在每个选中节点的父级 World Linear Transform 是相似变换（等比缩放、旋转和可选反射）时开放；反射会修正局部角度方向。非均匀父变换下继续允许 Inspector 编辑局部 Rotation，但不伪装成可以由当前 TRS 精确提交的世界空间旋转。若以后引入完整 Affine/Skew 表达，再重新评估这一限制。
7. Stage 手势开始时暂停播放并完成当前 Playhead 求值，随后固定该 Presentation Graph；手势期间的新求值只保留最新结果，结束或取消后再 Present。异步 Hit Test 使用 Pending Pointer Token，Reset、关闭和切换工程会使旧 Token 失效。工程切换先取消 Stage 手势、排空旧工程编辑/求值队列并核对工程实例，旧闭包不得落到新工程。
8. 验证按风险分层：Operation/Studio 单元测试验证事务与边界，Golden Project 验证序列化、精确求值和 Renderer 结果，真实 Electron E2E 验证关键帧、Easing、多选对齐、保存关闭与重新打开，Foundation Benchmark 额外测量重复 Authoring Transaction。大型完整门禁以 GitHub CI 为权威运行环境。

## 结果

- Timeline、Inspector 和 Stage 共享 Operation、Transaction、Evaluation 与 History 语义，没有形成 UI 专用动画模型或开发期兼容层。
- 当前值、关键帧值和画面预览来自同一求值时刻；播放、异步命中与项目切换不会把一个手势拆到不同 Presentation Graph 或不同工程。
- 多属性和多节点编辑保持单次撤销；拖拽频率不会线性放大 Commit 数量或持久化写入。
- 当前 TRS 可表达范围被明确暴露。复杂父变换下宁可暂时隐藏不精确的世界旋转操作，也不提交与预览不一致的结果。
- 这些规则是当前创作场景的施工基线；新增媒体时间、曲线编辑、约束布局或更一般变换时可以直接修订实现、Schema、Fixture 和本 ADR，不把它解释为终局架构。

## 重新评审条件

- Transform 模型加入 Skew、完整 Affine Matrix、3D 或约束求解；
- 时间线加入 Ripple、磁性时间、区间/Clip、批量曲线编辑或跨 Track 冲突策略；
- Signal 需要可写、烘焙或与 Keyframe 混合；
- 多窗口、协作编辑或后台 Runtime 改变工程队列和手势所有权；
- 大型选择或长时间线使当前事务粒度、Overlay 预览或求值冻结超过性能预算。
