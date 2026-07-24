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
| `KINEWEAVE_PROJECT_LABEL` | `Cloud workspace` | Studio 顶栏显示的位置名称 |
| `KINEWEAVE_ACCESS_TOKEN` | 未设置 | Web Studio 登录令牌；公网部署应设置高强度随机值 |

健康检查位于 `/healthz`。容器以非 root 用户运行，并声明 `/data` 为数据卷。

## Zeabur 与其他自动部署平台

仓库根目录的 `Dockerfile` 可以直接被 Zeabur 或其他支持 Dockerfile 的平台检测：

1. 将服务连接到仓库主分支；
2. 为服务挂载持久卷到 `/data`；
3. 设置 `KINEWEAVE_ACCESS_TOKEN`；
4. 将平台健康检查设置为 `/healthz`；
5. 让平台通过其 `PORT` 环境变量分配端口并终止 TLS，同时覆盖转发 `X-Forwarded-Proto` 与 `X-Forwarded-For`（或 `X-Real-IP`）。

没有持久卷时，重新部署或迁移容器会丢失工程数据。没有访问令牌时，任何能访问服务的人都可以打开和修改该工程；这只适合本机、私有网络或已经有外围认证的入口。

当前镜像是一实例一工程、单 Node 进程的部署形态。登录会话保存在 Node 进程内，服务重启后需要重新登录。它没有伪装成账号、多租户或横向扩容系统；需要这些能力时，应将同一个 `StudioHostApi` 接到共享会话、对象存储和协作服务，而不是改变 Studio 的工程语义。
