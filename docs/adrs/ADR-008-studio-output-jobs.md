# ADR-008：Studio Output Job 与宿主交付边界

- 状态：Accepted
- 日期：2026-07-26

## 背景

确定性 SVG/PNG 帧序列与 MP4/WebM 已在 Node 侧贯通，但 Studio 不能把浏览器中的帧逐个传回宿主，也不能让 Renderer 获得本地路径、Node API 或云端文件系统权限。输出可能持续数秒到数分钟；它必须允许创作继续进行，同时明确处理重复启动、取消、切换工程、窗口关闭和下载授权。

## 决策

1. Studio 在启动输出前完成当前工程保存。Desktop Main 或 Web Node Host 在各自的保存队列之后捕获已保存 Bundle，并为该 Bundle 打开独立的 `render-node` ProjectSession。Output Job 固定 Bundle、Commit、帧计划与求值参数；之后的编辑不会改变运行中的结果。
2. Output Job 是 Node 宿主拥有的具体状态机：`running → succeeded | failed | cancelled`，取消期间可以暴露 `cancelling`。Job ID 与 Owner ID 都是不可解释的随机标识，所有查询、取消、打开和下载必须同时通过 Owner 校验。当前单进程只允许一个活动 Job，避免多个 Resvg/FFmpeg 管线争抢 CPU 与内存；有真实吞吐需求时再引入有界队列或独立 Worker。
3. Renderer 通过同一 `StudioHostApi` 启动、查询、取消和打开结果，每 250 ms 轮询状态。轮询只传递小型元数据，不增加另一套 IPC 事件或 SSE 协议。启动中的请求也被视为互斥状态，防止系统文件对话框、保存和异步 Host 请求被重复触发。
4. 编辑可以在 Job 启动后继续。切换工程和 Desktop 关闭握手会先等待正在启动的请求，再取消并收敛活动 Job；Main Process 同时按 `webContents` 绑定工程会话，并在窗口异常销毁时清理其 Job，Renderer 无法操作其他窗口的会话或结果。
5. Desktop 暴露 SVG/PNG 序列、MP4 与 WebM，目标由 Main Process 的原生保存对话框选择。Renderer 永远看不到绝对路径；完成后只能请求 Main Process 打开目录或在文件管理器中定位文件。发布器继续拒绝覆盖已有目标。
6. Web 当前只暴露 MP4 与 WebM。服务器在独立 Output Root 下生成不可由请求指定的路径，成功后通过已认证、Owner 受限的 HTTP 端点流式下载；浏览器不缓冲整个视频 Blob。序列压缩包、对象存储与断点续传在出现真实交付需求前不引入。
7. Web Output Root 必须与 Canonical Project Root 分离。Session 关闭或过期时取消其 Job 并删除服务器侧结果；Project 文件和 Output 临时文件不共享 Repository 事务语义。开发期不保留旧 Job/API 兼容层。

## 结果

- CLI、Desktop 和 Web 共用一条高层 Node 输出函数，ProjectSession 求值、Renderer 选择、Resvg、FFmpeg 与原子发布语义不再由各宿主复制。
- Studio 有可访问的格式、区间、精确帧率、尺寸、Pixel Ratio、质量、进度、取消和结果操作界面；Desktop 与 Web 只在最终交付能力上不同。
- Browser Renderer 不获得文件系统或媒体进程权限，HTTP 客户端也不能提交输出路径。
- Job 与结果目前是单进程、单实例、非恢复状态。Web Host 已在启动时清理孤儿结果，并在 readiness/draining 中取消当前 Job；跨重启恢复和跨实例执行仍等到真实需求后再引入持久队列与对象存储。

## 重新评审条件

- 单 Job 限制成为可测的用户吞吐瓶颈；
- 需要序列归档、对象存储、断点续传、可恢复队列或跨实例 Worker；
- 需要音频、长任务后台通知、Job 历史或结果保留策略；
- 轮询流量或状态延迟达到需要 SSE/WebSocket 的量级。
