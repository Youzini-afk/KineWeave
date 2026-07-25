# ADR-007：确定性帧计划与帧序列交付

- 状态：Accepted
- 日期：2026-07-26

## 背景

KineWeave 已能在指定时刻求值并通过 Output Renderer 写出单个 SVG，但运动创作只有在一段时间能够稳定变成可核验、可继续编码的产物时才形成交付闭环。逐次启动 CLI、用浮点数累加时间或在导出期间持续跟随 Branch Head，都会使长序列产生时间漂移、跨帧状态撕裂或无法复现的结果。帧文件直接写入最终目录还会在求值、Renderer 或进程失败时留下看似完成的残缺产物。

## 决策

1. 帧计划使用精确 Rational 表示开始时间、结束时间和帧率。当前动画导出明确使用 Seconds Domain，区间为 `[startTime, endTimeExclusive)`；第 `i` 帧时间是 `startTime + i / framesPerSecond`，帧数是区间长度乘帧率后的精确向上取整。帧索引使用安全整数，负开始时间、非正区间、非正帧率和超出安全整数的帧数直接拒绝。
2. 一次帧序列在开始时把缺省状态或 Branch Ref 解析为固定 Commit。求值参数和输出参数同时快照，全部帧强制使用 Deterministic Mode；Branch 后续移动、调用方修改参数对象或编辑器继续创作都不得改变正在运行的序列。
3. ProjectSession 层提供宿主无关的帧计划和异步逐帧求值/输出迭代器，继续经过现有 Evaluation Engine、Output Profile、Capability Resolution、Lockfile 与 Output Renderer，不建立第二套动画求值或 SVG 生成逻辑。标准 `AbortSignal` 在求值、输出和交付边界之间检查，宿主可以取消而不再发布后续帧。
4. Node 宿主负责文件系统交付。帧先写入最终目录同级的随机 Staging Directory；发布器逐帧核对连续索引、精确时间、固定 Commit、媒体类型、扩展名、Artifact Kind 和 Renderer Provider，并记录每帧内容哈希。只有帧数完整且 `manifest.json` 已写入后才把 Staging Directory 原子改名为最终目录；任一步失败都会清理 Staging，已存在的最终目录默认拒绝覆盖。
5. 首个格式是 `svg-sequence`，目录包含 `manifest.json` 与 `frames/frame_XXXXXX.svg`。它既是可直接检查的动画产物，也是后续确定性 Raster 和视频编码的输入边界；PNG、MP4、WebM 和云端 Job 生命周期在各自真实实现进入时扩展同一条管线。当前不预造 Native ABI 或 Rust 框架，只有实际 Raster、Codec、帧传输或性能数据证明 TypeScript/Node 边界不足时再引入。
6. 开发期 Manifest 与 API 只认仓库当前版本，设计变化直接修改实现、测试和文档，不保留兼容层。公开格式基线发布后再定义升级与兼容责任。

## 结果

- 单帧 `render` 与动画 `export` 共享同一求值和 Renderer 选择语义，Output Profile ID 也会进入求值请求，不会出现“按一个 Profile 求值、按另一个 Profile 输出”的分裂。
- SVG 序列在时间、工程状态和求值参数上可复现；Manifest 能追溯 Project、Document、Commit、时间范围、帧率、Viewport、Profile、Provider 与每帧内容哈希。
- ProjectSession 不接触文件系统，Node 发布器也不解释工程模型；Desktop Main Process 与 Web Node Host 可以复用发布器，而 Browser Renderer 不获得 Node 或目录权限。
- 最终目录只有完整产物。普通异常和取消会清理临时目录；操作系统或进程被强制终止时可能遗留隐藏的 Staging Directory，但不会被误认为已发布序列。

## 重新评审条件

- 支持非 Seconds Domain、变帧率、音频采样同步、Drop-frame Timecode 或区间尾帧的其他产品语义；
- Raster、颜色管理、字体打包或 Codec 引入新的确定性约束；
- Desktop / Web Job 需要排队、恢复、并发预算、分块下载或跨进程执行；
- 大型序列的 Manifest、逐帧哈希、单进程求值或文件系统发布超过性能与内存预算；
- Rust/Native Runtime 的真实实现改变帧所有权、取消、背压或传输边界。
