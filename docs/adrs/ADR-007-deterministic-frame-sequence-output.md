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
5. `svg-sequence` 与 `png-sequence` 都使用 `manifest.json` 和 `frames/frame_XXXXXX.*`。PNG 不是另一条 Renderer：它逐帧消费同一 SVG Output Artifact，由 `@resvg/resvg-js` 栅格化。栅格器关闭系统字体，只加载 Fontsource 的 Noto Sans SC Variable；根据 Presentation Graph 中实际文本选择所需 Unicode 分片，拉丁文与中文在不同宿主上使用相同字体字节。Pixel Ratio 进入栅格尺寸，默认安全上限为 67,108,864 像素；PNG 保留透明度。Manifest 记录栅格器、字体包及其版本、实际尺寸和每帧内容哈希。
6. `mp4` 与 `webm` 继续消费同一 PNG 帧流，通过带背压的标准输入交给 FFmpeg。MP4 固定使用 H.264/libx264，WebM 固定使用 VP9/libvpx-vp9，质量只暴露 `high`、`balanced`、`compact` 三档，不允许调用方注入任意 Codec 参数。当前视频没有音频和 Alpha；透明区域在栅格阶段合成为黑色，奇数尺寸在编码阶段向右/下补齐到偶数，输出统一为 `yuv420p`。编码单线程并移除动态容器元数据，同一 FFmpeg/Codec 构建应可复现；不同 FFmpeg 版本、CPU 或发行版不承诺字节完全一致，因此结果会记录 FFmpeg 版本和最终文件哈希。
7. FFmpeg 是宿主明确管理的运行时工具，默认从 `PATH` 查找，也可用 `KINEWEAVE_FFMPEG_PATH` 指定；不在 npm 依赖中私藏平台二进制。官方 Docker 镜像明确安装 FFmpeg，CI 同时验证 `libx264` 与 `libvpx-vp9`。视频先写入目标文件同级的随机 Staging Directory，完成编码和哈希后用排他硬链接发布；已存在目标不覆盖，失败或取消会清理 Staging。
8. Raster 与 Codec 先保留在 Node 宿主边界，不预造 Native ABI 或仓库内 Rust 框架。只有帧吞吐、内存、取消或传输数据证明现有边界不足时再替换具体执行层；ProjectSession 的精确帧与 Output Renderer 语义不因此分叉。
9. 开发期 Manifest 与 API 只认仓库当前版本，设计变化直接修改实现、测试和文档，不保留兼容层。公开格式基线发布后再定义升级与兼容责任。

## 结果

- 单帧 `render` 与动画 `export` 共享同一求值和 Renderer 选择语义，Output Profile ID 也会进入求值请求，不会出现“按一个 Profile 求值、按另一个 Profile 输出”的分裂。
- SVG/PNG 序列在时间、工程状态和求值参数上可复现；Manifest 能追溯 Project、Document、Commit、时间范围、帧率、Viewport、Profile、Provider、Raster/字体版本与每帧内容哈希。
- CLI 可以直接交付 SVG/PNG 序列、H.264 MP4 和 VP9 WebM。视频结果同时报告源尺寸、补齐后的编码尺寸、Codec、质量档、FFmpeg 版本和文件哈希；FFmpeg 缺失或不支持选定 Codec 时明确失败，不回退到另一个格式。
- ProjectSession 不接触文件系统，Node 发布器也不解释工程模型；Desktop Main Process 与 Web Node Host 可以复用发布器，而 Browser Renderer 不获得 Node 或目录权限。
- 最终目录只有完整产物。普通异常和取消会清理临时目录；操作系统或进程被强制终止时可能遗留隐藏的 Staging Directory，但不会被误认为已发布序列。

## 重新评审条件

- 支持非 Seconds Domain、变帧率、音频采样同步、Drop-frame Timecode 或区间尾帧的其他产品语义；
- 颜色管理、项目字体、字体子集缓存、音频、Alpha Video 或硬件 Codec 引入新的确定性约束；
- Desktop / Web Job 需要排队、恢复、并发预算、分块下载或跨进程执行；
- 大型序列的 Manifest、逐帧哈希、单进程求值或文件系统发布超过性能与内存预算；
- Rust/Native Runtime 的真实实现改变帧所有权、取消、背压或传输边界。
