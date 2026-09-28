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
