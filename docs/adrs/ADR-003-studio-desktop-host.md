# ADR-003：Studio 桌面宿主边界与工程会话所有权

- 状态：Accepted
- 日期：2026-07-23

## 背景

Studio 需要同时使用原生目录选择、Journal/原子替换、扩展运行时、浏览器 Canvas、连续帧和编辑器 UI。把工程运行时复制到 Main 与 Renderer，或让每个面板各自装配服务，都会形成多份历史 Head、Capability 绑定和求值状态；把 Node 文件系统直接暴露给页面则会破坏隔离边界。严格 CSP 下，AJV 默认的运行时代码生成也不能出现在 Renderer。

## 决策

1. Electron Main Process 只拥有窗口、菜单、原生目录选择和 `NodeProjectRepository`。它为每次打开返回一个不透明 Host Session ID，并将同一 Session 的保存请求串行化。
2. Context-isolated、sandboxed Preload 暴露窄而有类型的 IPC API；Renderer 不获得 Node 集成、任意 IPC 或文件系统对象。导航和新窗口默认拒绝。
3. 一个打开的 Studio 工程只对应 Renderer 中一个 `ProjectSession`。Stage、图层、Inspector、Timeline、历史、Undo/Redo 和保存都读取或修改这同一会话，不建立 UI 专用文档副本或第二套命令模型。
4. 打开另一个工程采用候选会话：完成格式读取、扩展激活、初次求值和 Stage Present 后才替换当前工程；失败时释放候选并恢复原 Stage。
5. UI 修改进入串行事务队列，提交后刷新当前文档并合并求值请求；Stage 自己串行管理 Interactive Render Session、Resize、Graph 更新和释放。播放头、选择、布局等本地派生状态不写入 Canonical Project State。
6. 保存经 Main Process 回到 Repository，继续使用与 CLI 相同的 Journal 和原子多文件事务。自动保存只做调度；窗口关闭使用显式握手，Renderer 先停止播放、等待编辑/求值队列并完成持久化，Main 收到成功响应后才真正关闭窗口。保存失败则取消关闭并保留诊断。
7. Renderer 保持不含 `unsafe-eval` 的 Content Security Policy。Project Format 与 Standard Motion 的 JSON Schema Validator 在构建时生成独立 ESM 代码并检查是否过期，运行时不执行动态代码生成。
8. 当前 Workbench 使用直接 TypeScript、DOM 与 CSS 实现。它是宿主内部选择，不进入工程格式或 Kernel 契约；交互规模、可访问性或性能数据需要时可以直接重构，不保留开发期 UI 兼容层。

## 结果

- Native I/O 与创作运行时各有一个明确所有者，Main/Renderer 之间传递的是版本化 Bundle 和不透明会话标识，而不是可变服务实例。
- Studio 与 CLI 共享 ProjectSession、Operation、History、Evaluation、Render 和 Repository 语义；UI 不会成为隐藏的第二个领域实现。
- Canvas2D Surface 和 ProjectSession 同处 Renderer，当前连续帧不支付跨进程逐帧传输成本。
- Renderer 崩溃会丢失尚未进入 Repository 的短暂编辑，这是自动保存间隔与隔离带来的当前取舍；窗口的正常关闭路径不接受该损失。
- 当实测表明求值、扩展或媒体任务需要隔离/并行时，可以把具体 Runtime 移入 Worker/Utility Process，但工程会话所有权和提交顺序必须保持单一。

## 重新评审条件

- 大型工程的 Bundle IPC 或主线程求值超过性能预算；
- 第三方扩展需要比 Renderer sandbox 更强的故障隔离；
- 多窗口同时编辑同一工程；
- 媒体解码、GPU 或协作引入新的进程所有权要求。
