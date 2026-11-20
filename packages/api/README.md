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

分镜历史发布可通过 `GET /projects/:projectId/chapters/:chapterId/storyboard-tasks/publications/:id` 按正式发布编号只读查询。返回内容和锁定状态重建到该次确认修订。

同一路径的 `GET /publications` 按发布编号倒序返回每页最多 20 条，使用 `nextCursor` 继续读取。

## 本地飞书告警 Worker

从仓库根目录运行 `pnpm worker:feishu:local`。该命令以前台进程运行，只投递已有的拆集对账告警。使用 Ctrl+C 退出，送达记录保留在 PostgreSQL 中。

使用持久的本地测试数据库。启动前应用计费迁移 `0001_credit_ledger.sql`、`0006_episode_reconciliation.sql` 和 `0008_episode_alert_delivery.sql`，并给专用登录授予 `novel_episode_alert_delivery`。启动入口会检查迁移和登录权限。数据库地址支持本机回环 TCP 和通过 `?host=/path/to/socket` 指定的 Unix socket。

| 环境变量 | 用途 |
| --- | --- |
| `EPISODE_FEISHU_DATABASE_URL` | 专用登录的本地 PostgreSQL 连接串 |
| `EPISODE_FEISHU_WORKSPACE_ID` | 单个本地测试工作室 ID |
| `EPISODE_FEISHU_WEBHOOK` | 从本地密钥配置注入的飞书机器人地址 |

Worker 会领取该工作室已经存在的待投递告警。请使用测试工作室。若数据库中暂无该工作室的告警，Worker 会等待写入。需要绕过包管理器时可运行 `node packages/api/src/local-feishu-worker.ts`。

### 本地验收与排查

在 `local-feishu-test` 提交测试拆集任务并模拟执行结果未知后，对账流程生成了 `EXECUTION_UNKNOWN`。飞书群已确认收到同一任务的告警，PostgreSQL 记录为 `delivered`，`attempts = 1`。

出现新告警时，用有权读取该测试工作室记录的本地数据库账号查询。将示例任务 ID 替换为待核对的任务 ID。

```sql
SELECT a.task_id, a.code, d.status, d.attempts, d.retry_at
FROM episode_reconciliation_alerts AS a
LEFT JOIN episode_alert_deliveries AS d
  ON d.workspace_id = a.workspace_id
  AND d.task_id = a.task_id
  AND d.code = a.code
  AND d.channel = 'feishu'
WHERE a.workspace_id = 'local-feishu-test'
  AND a.task_id = '<任务 ID>';
```

- 无查询结果时，先核对工作室与任务 ID，再检查对账流程是否已生成告警。有告警且 `status` 为空时，检查飞书 Worker 是否运行、工作室配置是否匹配。
- `delivered` 表示飞书接口确认送达，可按任务 ID 在群里核对。`retryable` 会在 `retry_at` 到期后重试，最多尝试 5 次。
- `unknown` 表示投递结果未确认。先查群消息，Worker 不会自动重试。`rejected` 或 `exhausted` 时，检查 Webhook 配置和飞书机器人返回结果。
