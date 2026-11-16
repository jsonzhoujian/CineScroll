# Authenticated project import API

This NestJS module exposes the T04 project-import application seam without accepting an actor from request bodies. `SessionGuard` verifies the bearer token and resolves the actor's current workspace membership on every request through `SessionVerifier`.

Implemented endpoints:

- `POST /auth/device`
- `POST /auth/phone/challenges`
- `POST /auth/phone/verify`
- `POST /auth/wechat/start`
- `GET /auth/wechat/callback`
- `POST /auth/wechat/bind/start`
- `POST /projects`
- `POST /projects/:projectId/imports/inspect`
- `POST /projects/:projectId/chapters/import`
- `POST /projects/:projectId/chapters/:chapterId/reimport`
- `GET /projects/:projectId/chapters/:chapterId`

Paste requests carry text directly. TXT and DOCX requests carry strict canonical Base64 in `contentBase64`; decoding failures return `MALFORMED_DOCUMENT`. Domain errors retain stable machine-readable codes, and cross-workspace project access uses the same `PROJECT_NOT_FOUND` response.

微信登录和账号绑定使用同一个已登记回调地址，服务端根据一次性 state 的用途完成登录或绑定，避免回调串线。手机号接口从受信代理解析器获取客户端 IP，并要求服务端签名的设备 token；手机号、IP、设备三维限流仍由 identity 模块统一执行。

`createProductionApi` composes the PostgreSQL repositories, HTTPS SMS/WeChat/compliance providers, DOCX worker and session verification. Production configuration requires a database CA with certificate verification, independent session/device secrets and an explicit trusted-proxy hop count.

For browser WeChat login, `wechatRedirectUri` must be the public HTTPS web callback at `/auth/wechat/callback` and must exactly match the URI registered with WeChat Open Platform. The callback page exchanges `code` and `state` through this API, then returns the in-memory bearer session to its same-origin opener. Deployments that place the web app and API on different origins must explicitly allow the web origin with CORS; a same-origin reverse proxy is preferred.

分镜 Worker 通过 `createProductionApi` 的 `storyboardTasks` 独立启用，提供 `workspaceIds` 白名单和可选的 `intervalMs`。启用需要同库 TLS 的 BYOK 配置、DeepSeek 大陆路由、工作室任务配额和已应用的分镜迁移 0037、0038。服务端使用 `STORYBOARD_TASK_SERVICE` 提交原任务及指定失败范围的重试。

启用分镜 Worker 时，Session API 在 `/projects/:projectId/chapters/:chapterId/storyboard-tasks` 下提供提交、任务列表、状态和候选读取。`POST /retries` 接受基准候选和选中的失败范围。候选读取按已保存的剧本与原文版本返回镜头证据。

部署分镜审核入口需应用迁移 0039。创建者通过 `POST /:id/review` 提交已完成的候选。同章节成员通过 `GET /reviews` 和 `GET /reviews/:id` 读取共享候选，审核编号独立于任务编号。

分镜镜头审核需应用迁移 0040。项目成员可从 `GET /reviews/:id` 读取当前审核修订和建议状态。通过 `POST /reviews/:id/operations` 提交画面或时长修改、建议及裁决，附原请求编号和预期修订号。

正式分镜需应用迁移 0041。审核操作支持 `lock`、`unlock` 与 `confirm`。确认携带上一正式发布编号或 `null`，逐集允许的实际时长偏差为 ±10%。`GET /reviews/confirmed` 读取章节当前正式内容。
