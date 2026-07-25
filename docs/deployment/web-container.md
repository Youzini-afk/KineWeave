# KineWeave Web 容器部署

KineWeave 的生产镜像同时包含 Web Studio 和 Node 云端 Host。浏览器执行 ProjectSession、求值与 Canvas2D 交互渲染；Node Host 提供静态资源、工程会话以及基于 `NodeProjectRepository` 的原子持久化。

## 直接运行

```bash
docker build -t kineweave-web .
docker run --rm \
  -p 8080:8080 \
  -v kineweave-data:/data \
  -e KINEWEAVE_ACCESS_TOKEN="replace-with-a-long-random-secret" \
  kineweave-web
```

打开 `http://localhost:8080`。首次访问受保护实例时，Studio 会显示应用内登录页。访问令牌只在登录请求中提交，不写入浏览器存储；验证成功后，Node Host 签发 12 小时有效的 `HttpOnly`、`SameSite=Strict` 会话 Cookie。生产环境必须通过 HTTPS 访问。

## 运行参数

| 环境变量 | 默认值 | 作用 |
|---|---|---|
| `PORT` | `8080` | HTTP 监听端口 |
| `KINEWEAVE_PROJECT_DIR` | `/data/project` | Canonical Project 目录 |
| `KINEWEAVE_OUTPUT_DIR` | `/data/outputs` | 云端视频 Output Job 与临时发布目录；必须与 Project 目录分离 |
| `KINEWEAVE_PROJECT_LABEL` | `Cloud workspace` | Studio 顶栏显示的位置名称 |
| `KINEWEAVE_ACCESS_TOKEN` | 未设置 | Web Studio 登录令牌；公网部署应设置高强度随机值 |
| `KINEWEAVE_FFMPEG_PATH` | `ffmpeg` | FFmpeg 可执行文件；官方镜像已安装并可直接使用 |
| `KINEWEAVE_PUBLIC_ORIGIN` | 未设置 | 可选的公开 Origin，例如 `https://studio.example.com`；用于严格校验状态变更请求和 Cookie 安全属性 |
| `KINEWEAVE_TRUST_PROXY` | `false` | 仅当唯一入口代理会覆盖 `X-Forwarded-*` 头时设为 `true` |

`/healthz` 是只表示进程存活的 liveness；`/readyz` 会在 Project/Output 目录不可读写或服务进入关闭排空时返回 `503`，容器 HEALTHCHECK 使用后者。容器以非 root 用户运行，并声明 `/data` 为数据卷。工程位于持久卷，Output 文件只在所属工程 Session 生命周期内保留；服务只会清理带 KineWeave 所有权标记的专用 Output Root，非空未标记目录会拒绝启动，避免环境变量误配造成数据删除。浏览器不能指定服务器路径。官方镜像同时安装带 H.264/libx264 与 VP9/libvpx-vp9 的 FFmpeg，供云端 Output Job 使用；自定义镜像必须提供同等编码器，服务不会静默切换 Codec。

所有 `POST`、`PUT`、`PATCH` 与 `DELETE` API 都要求请求 `Origin` 与公开 Origin 完全一致，浏览器会自动提供该头。认证后的工程 Session 同时绑定签发它的登录 Cookie；另一个登录会话即使获得不透明 Session ID 也不能保存、取消或下载它的内容。收到 `SIGINT`/`SIGTERM` 后，服务先停止 readiness 和新写入，再停止接流、等待已排队保存、取消 Output Job 并删除临时结果；默认 10 秒仍未收敛时以失败退出。

## Zeabur 与其他自动部署平台

仓库根目录的 `Dockerfile` 可以直接被 Zeabur 或其他支持 Dockerfile 的平台检测：

1. 将服务连接到仓库主分支；
2. 为服务挂载持久卷到 `/data`；
3. 设置 `KINEWEAVE_ACCESS_TOKEN`；
4. 将平台健康检查设置为 `/readyz`；
5. 若 Zeabur 的唯一入口代理会覆盖转发头，设置 `KINEWEAVE_TRUST_PROXY=true`；有固定域名时还可显式设置 `KINEWEAVE_PUBLIC_ORIGIN=https://你的域名`；
6. 让平台通过其 `PORT` 环境变量分配端口并终止 TLS。

没有持久卷时，重新部署或迁移容器会丢失工程数据。没有访问令牌时，任何能访问服务的人都可以打开和修改该工程；这只适合本机、私有网络或已经有外围认证的入口。

当前镜像是一实例一工程、单 Node 进程的部署形态。登录会话和 Output Job 保存在 Node 进程内，服务重启后需要重新登录并重新输出。它没有伪装成账号、多租户、持久任务队列或横向扩容系统；需要这些能力时，应将同一个 `StudioHostApi` 接到共享会话、对象存储和协作服务，而不是改变 Studio 的工程语义。
