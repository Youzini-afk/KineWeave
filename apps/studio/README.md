# KineWeave Studio

Studio 是 KineWeave 当前的 Electron 桌面创作宿主。它不是独立的工程实现：编辑、历史、求值和渲染全部通过仓库共享的领域服务完成。

## 运行

在仓库根目录执行：

```bash
pnpm install
pnpm studio --project ./examples/hello-kineweave
```

不传 `--project` 时从欢迎页或 File 菜单选择包含 `kineweave.project.json` 的目录。

## 进程边界

- `src/main.ts`：窗口、菜单、目录选择、Repository Host Session 和原子保存；
- `src/preload.cts` / `src/bridge.ts`：context-isolated 类型桥；
- `src/renderer/studio-project.ts`：唯一 ProjectSession 与编辑/求值入口；
- `src/renderer/studio-controller.ts`：工作区状态、事务/求值/保存协调；
- `src/renderer/stage-controller.ts`：Canvas2D Surface、Interactive Render Session、选择与拖动；
- `src/renderer/app.ts`：可访问的 DOM 工作台和命令绑定。

窗口关闭不是直接销毁：Main 先要求 Renderer 等待进行中的编辑、求值和保存，持久化成功后再关闭。Schema Validator 在仓库构建阶段生成，Renderer 的 CSP 不允许 `unsafe-eval`。
