# ADR-006：Web Studio、云端 Host 与容器边界

- 状态：Accepted
- 日期：2026-07-25

## 背景

Studio 的界面和交互渲染本来运行在 Chromium Renderer 中，但桌面入口依赖 Electron Preload 提供目录选择与 Node Project Repository。仅把 Renderer 构建成静态站会得到一个不能可靠打开、保存工程的展示页面，也无法形成后续云端形态的真实宿主。另一方面，把 Electron 桌面壳或另一套工程运行时搬进容器，会复制会话、历史和求值语义。

## 决策

1. Web 是与 Desktop、CLI 并列的一等 Host，不是 Studio 的只读预览页。桌面和 Web 复用同一个 Studio Renderer、ProjectSession、Standard Motion、Evaluation、Render 与 Canvas2D 链路。
2. `StudioHostApi` 使用 Host-neutral project locator 和展示位置，不向 Renderer 泄漏文件路径假设。Host 明确声明 `desktop` 或 `web`，ProjectSession 以真实 HostKind 完成扩展与 Capability 选择。
3. Web 容器同时交付浏览器客户端和 Node 云端 Host。浏览器拥有唯一 ProjectSession、工作台状态和 Interactive Render Session；Node Host 拥有 Project Repository、文件事务、云会话和静态资源服务。双方只传递版本化 LoadedProjectBundle 和不透明 Host Session ID。
4. 当前云端 Host 管理一个 Canonical Project 目录。保存继续经过 `NodeProjectRepository` 的校验、内容哈希、Journal 和原子文件事务，不在 Web 服务中实现第二套 JSON 写入逻辑。
5. 容器使用普通 `PORT`、`KINEWEAVE_PROJECT_DIR` 和持久卷，不写入 Zeabur、GitHub Pages 或其他平台专属运行协议。任何能构建 Dockerfile、挂载卷并转发 HTTP 的平台都可运行。
6. 公网部署可以设置 `KINEWEAVE_ACCESS_TOKEN`。令牌只由 Node Host 校验，不进入客户端构建产物，也不写入浏览器存储。应用内登录成功后，Host 签发 12 小时有效的 `HttpOnly`、`SameSite=Strict` 进程内会话 Cookie；失败登录按连接地址限流。未设置令牌只适用于本地或已有外围访问控制的网络。
7. 当前进程内云会话服务于单容器部署。多实例、账号、多租户、协作与对象存储需要真实产品场景后再引入共享会话和存储服务，不在首个 Web Host 中伪装实现。
8. Docker 的构建与运行烟测进入 GitHub CI；部署仍由用户选择的平台根据主分支和 Dockerfile 自动完成，仓库不包含平台专属发布工作流。
9. 所有改变状态的 Web API 都校验 `Origin`。公开 Origin 可由 `KINEWEAVE_PUBLIC_ORIGIN` 固定；否则从直连请求推导。只有显式启用 `KINEWEAVE_TRUST_PROXY` 时才读取 `X-Forwarded-Proto`、`X-Forwarded-Host` 和客户端地址转发头，部署边缘必须覆盖而不是追加这些头。
10. 登录会话 ID 同时是云端工程 Session 的 Owner。打开、保存、关闭、Output 查询/取消与下载都校验 Owner，不把“随机 ID 难以猜中”当作授权。登出或认证过期会等待其保存队列并清理所属 Output Job。
11. `/healthz` 只表示进程存活，`/readyz` 额外检查服务未进入 draining 且 Project/Output 目录可读写。收到终止信号后先拒绝新登录、打开、保存和输出，再停止接流、等待已排队保存、取消输出并清理结果；超出有界期限时强制断开并以失败退出。
12. Output Job 不能在进程重启后恢复，专用 Output Root 因此在启动时完成路径/真实路径隔离与所有权标记校验后清空。非空且没有有效 KineWeave 标记的目录拒绝启动，Canonical Project Root 从不进入该清理范围；需要跨重启结果或任务恢复时改用持久任务队列与对象存储，而不是保留失去 Owner/状态的孤儿文件。

## 结果

- 推送后的云实例运行的是可编辑、可保存的完整 Web Studio，而不是脱离工程语义的静态演示。
- Desktop Main 与 Web Node Host 对 Renderer 提供同一宿主契约，但各自保留合适的持久化所有权。
- 浏览器崩溃不会破坏已提交工程；服务端并发保存继续由 Repository Snapshot 和文件哈希检测冲突。
- 未挂载持久卷时，容器重建会丢失工程目录；部署文档必须明确这一运维边界。
- 当前登录令牌和进程内会话是单部署访问边界，不等同于用户账号或权限模型；服务重启会使现有登录会话失效。
- Cookie 的 `SameSite=Strict`、同源状态变更校验和 Owner 绑定分别覆盖浏览器请求、CSRF 与会话间越权；反向代理信任必须由部署者显式开启。
- 编排平台可以用 readiness 在终止前停止导流；Repository 保存仍优先保证完成，媒体 Job 则可安全取消，不会把半成品发布为结果。

## 重新评审条件

- 需要在一个实例中管理多个用户或多个工程；
- 需要横向扩容、共享会话、对象存储或协作编辑；
- Project Bundle 传输超过当前 JSON 请求预算，需要文档和资源流式协议；
- 服务端 Output Job 需要跨进程恢复、持久结果或远程 Worker 调度；
- Web 与 Desktop 工作台出现不能由同一公开 Host 接缝表达的真实差异。
