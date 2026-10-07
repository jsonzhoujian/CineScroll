# T09 — Background AI jobs, model routing, and credits

status: blocked  
blocked_by: [T07]  
unlocks: [T10]

## Goal

Operate every AI stage reliably with resumable background work, transparent credit settlement, and optional BYOK.

## Design increment — credit ledger and settlement boundary (2026-10-07)

- User-approved documentation-only delivery: `docs/contracts/AI_CREDIT_SETTLEMENT.md` defines workspace ledger, immutable billing responsibility, unit reservations/settlements/releases, idempotency, evidence and reconciliation, plus C01–C18 future acceptance cases.
- Platform submission/task/reservation/Outbox must be atomic; BYOK has no platform-model reservation or consumption. Unknown execution retains reservations and reconciles without regenerating.
- Existing runtime has neither ledger nor platform billing and candidate/task completion is not atomic. This design does not enable charging, implement payment or clear T09's T07 dependency. Unit pricing, expiry/entitlements, over-quote handling, compensation permissions and retention remain decisions before real charging.

## Incremental delivery — independent ledger foundation (2026-10-07)

- New billing domain package exposes trusted grant/reserve/settle and balance/entries/task queries, fixed event identities and canonical content fingerprints, immutable snapshots/entries, workspace-scoped authorization and in-memory revision CAS.
- Successful units consume and release remaining reservation in one update; failures release, unknown/over-quote stays reconciling, BYOK stays exempt without zero-value credit entries. Grant/task/evidence identity guards prevent repeated writes with new event IDs. Runtime validation rejects extra fields and unsafe integer sums; explicit true authorization is required.
- This is independent domain infrastructure, not PostgreSQL storage, task/reservation/Outbox coupling, authenticated service identity, actual evidence/quote validation, compensation, expiry, payment or production charging. Shared-memory concurrency is tested; cross-process guarantees and real balance service remain undelivered. T09 keeps its blocked dependency.
- Plan: docs/plans/2026-10-07-credit-ledger-foundation.md. Package README defines trusted-port and persistence limitations. Verification: billing package 13 tests pass; full Node regression 211 pass and 10 skip; full workspace typecheck passes. Standards/Spec reviews have no remaining blockers; strict-true authorization and sanitized actor-clone failure regressions pass.

## Incremental delivery — PostgreSQL ledger snapshots (2026-10-07)

- Added PostgresCreditLedgerRepository plus trusted-owner migration for immutable workspace/revision snapshots and CAS heads. One transaction locks the workspace head, checks revision, inserts the snapshot and advances the pointer; failures roll back without partial ledger changes.
- Dedicated novel_billing role, forced RLS and column-level head update permission isolate access. Database guards enforce append-only history, fixed task quotes, closed-unit protection, safe integer amounts, and consistency between all units and ledger entries. New snapshot maximum is 2MB with documented growth/SQL-validation limits; this is not a scalable normalized production ledger.
- Verification: 5 real isolated PostgreSQL tests pass, including restricted-login separate pools, no overdraft/double settlement, connection-pool restart, history rejection/rollback, partial/unknown/BYOK and invalid new/existing SQL unit rejection. Full suite with TEST_BILLING_DATABASE_URL has 216 pass and 10 skip; full workspace typecheck passes. Standards P2 fixed with red-green regression and re-reviewed; no remaining Standards/Spec blockers. Test database stopped after verification.
- No deployed migration, production assembly, task/ledger/Outbox common transaction, payment or real charging. Trusted authentication/evidence, billing startup preflight and capacity/retention remain outstanding. T09 original dependency stays blocked. Plan: docs/plans/2026-10-07-credit-ledger-postgres.md.

## 增量：数据库只读启动预检

已交付assertCreditLedgerDatabase与createCheckedCreditLedgerRepository：受限登录/角色、表列权限、强制RLS/策略、列/主键/约束指纹和历史守卫检查，失败统一BILLING_DATABASE_NOT_READY且不返回仓储。仅只读，不迁移、不授权、不扣费。隔离PG16验证健康初始化、缺表、权限/RLS/策略/约束/索引/守卫漂移，失败不自修复。低层构造器仍未预检；生产装配须走受检工厂。下一增量为可信服务身份授权，TLS/部署与真实计费仍未交付。

## 增量：服务器内部授权

用户批准方案A，createInternalBillingAccess绑定单个可信服务器配置serviceId，以明确工作室/操作列表默认拒绝。配置严格校验和复制，错误净化；公开授权边界及账本集成测试验证冒充其他服务、越权操作不会变更余额/流水。不新增HTTP、远程凭证或真实扣费。同进程装配是信任根，不得由请求选择授权器；跨进程认证仍未交付。下一步受控装配受检仓储与内部授权。

## 增量：受控服务器装配

createServerCreditLedger组合内部授权、受检PostgreSQL仓储及账本服务。配置失败/预检失败不返回服务，固定服务身份，仅提供工作室+命令/查询接口；Pool.connect/证据read在异步前绑定。隔离PG16验证重放、冻结、权限隔离及配置/依赖方法修改。宿主管理Pool；无HTTP、生产挂载或真实扣费。下一步明确可信结算证据适配边界，任务共同事务仍待交付。

## 增量：可信结算证据契约（仅文档）

SETTLEMENT_EVIDENCE.md定义可信任务/计费快照/执行记录/原始结果/版本化校验与计价来源，明确成功、失败、未知依据及18项未来验收。现有SettlementEvidenceReader仍为严格九字段投影，不把额外审计资料直接传给账本。unknown补证追加新证据/事件，终态冲突不改流水；客户端状态、供应商成本、超时或缺候选均不能直接用于消费/释放。未实现证据适配器、迁移或真实扣费；计价/质量/单元规则仍需批准。

## Acceptance criteria (original scope, unchanged)

- Jobs expose queued, running, partial-success, failed, restricted, awaiting-user, and completed states.
- Closing the page does not interrupt jobs; completion and required action create in-app notifications.
- Submission freezes estimated credits; successful units settle and failed units refund automatically and idempotently.
- Retries target failed units only and cannot double-charge or overwrite locked content.
- Default model routing and provider failover remain behind a domain-neutral adapter.
- BYOK secrets are encrypted, never logged, scoped per tenant, and calls do not consume platform model credits.
- One chapter per stage normally completes within the five-minute service target under documented test conditions.
