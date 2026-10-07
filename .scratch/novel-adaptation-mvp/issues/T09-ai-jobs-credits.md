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

## 增量：只读证据验证与投影

createVerifiedSettlementEvidenceReader注入可信EvidenceMaterialSource及服务授权，核验工作室/任务/单元/原文/上游、执行记录、唯一原始结果及报价版本，输出严格九字段。明确失败需关闭执行路径，unknown不得由读取故障伪造；超报价保留金额，错误分类脱敏。只用测试夹具与内存账本，不接数据库证据源、现有任务或真实扣费；来源真实性/一致性/不可变性及已批准质量/价格规则仍由未来source保证。下一步不可变资料仓储边界。

## 增量：不可变证据内存仓储

EvidenceMaterialRepository及内存实现支持append/get/read，工作室+证据ID隔离；规范化指纹确保同内容幂等、冲突不覆盖，复制输入和输出。补证追加并绑定同工作室既存前序，固定快照/执行ID一致。公开接口测试覆盖并发重放及保存→读取→投影链路。schema验证不证明来源，尚无持久化、写权限或生产接线。下一步受限PostgreSQL仓储设计。

## 增量：受限PostgreSQL证据仓储

PostgresEvidenceMaterialRepository与0002迁移提供workspace+ID唯一不可变资料、并发重放/冲突、前序FK及绑定/快照/执行守卫；forced RLS、novel_evidence只读/追加、历史改删触发器。读取重验规范化指纹与资料，错误脱敏。隔离测试库验证持久化重启、双池并发、补证回滚、RLS/权限及投影链路；不自动迁移业务库、不接收费。单资料2MB，总容量/留存未定；来源真实性与写授权未交付。下一步只读启动预检。

## 增量：证据数据库只读预检

assertEvidenceMaterialDatabase/createCheckedEvidenceMaterialRepository检查login/effective role危险属性/成员资格、最小表列权限、强制RLS/单一scope策略、列/主键/约束及guard函数定义。失败EVIDENCE_DATABASE_NOT_READY，不返回仓储，不授权/修复/写资料。隔离PG16漂移测试逐项恢复，不修改业务库。指纹绑定0002/PG16，TLS/真实性/生产装配仍延期；下一步受检仓储与投影受控装配。

## 增量：只读证据服务受控装配

createServerSettlementEvidenceReader校验复制内部授权策略并执行数据库预检，固定serviceId，仅返回冻结read(workspaceId,evidenceId)投影；无原始资料/仓储或追加接口暴露。读取使用settle权限，缺失/拒绝/异常保留净化错误。Pool宿主管理，隔离测试验证启动期间修改外部配置/连接方法仍不改变身份和连接。无HTTP/生产挂载/真实收费；下一步写服务授权与来源核验契约。

## 增量：写服务授权与来源契约（仅文档）

EVIDENCE_WRITE_AUTHORITY定义未来publish/supplement专用服务权限、来源引用请求、可信来源重读及一致性/唯一性核验、请求幂等和原子审计前置，附15项未来验收。客户端不能提交金额/成功结论；来源缺失/冲突/异常拒绝写入，不伪造失败或未知。清理证据契约/README中过时进度。未实现写服务/迁移/真实扣费；下一步测试夹具驱动的专用授权与来源端口。

## 增量：写入前来源核验

createEvidenceWritePreflight固定服务/工作室publish与supplement专用权限，严格引用请求，复用资料判据，核验实际引用、完整结果和token一致性，补证检查前序绑定/快照/执行ID。只返回资料草稿，不append；配置/依赖/调用副本及错误脱敏已测试。source真实性/来源身份版本由未来受控提供者保证，当前仅夹具。请求映射、审计和发布原子性/生产收费未交付。下一步请求身份与审计原子保存契约。

## 增量：请求幂等与证据原子发布契约（仅文档）

EVIDENCE_ATOMIC_PUBLICATION定义workspace+requestId共享命名空间、规范化指纹、确定性最终ID、授权重放与四项原子保存（请求/资料/审计/回执），含14项未来验收。来源必须有事务屏障或不可变封存证明，点时isCurrent不够；裸资料不自动published，生产读取门禁需后续升级。未改代码/DB，不启用收费。下一步协议基础/原子仓储接口及内存规则夹具。

## 增量：发布协议与内存原子规则

evidencePublicationId/指纹、EvidencePublicationRepository及内存复合记录、EvidencePublicationService支持固定服务专用授权、同请求重放/冲突、补证关联、最终ID重验与四项一次保存。非法资料/审计无残留，权限撤销拒绝重放查询，输出副本隔离；明确prepare为封存来源测试夹具。无真实屏障/Postgres发布/生产门禁/收费。下一步来源屏障与事务接口设计。

## 增量：来源封存接口与内存规则

用户确认registerSource/sealCollection/requireCurrentSeal/readSeal。内存夹具预置固定集合，版本幂等/冲突、observation新代、旧代当前断言拒绝、历史读取及final异常隔离有测试；有界容量且超限不截断。final仅保守结论子集，输入是来源测试声明，隔离无持久化或裁决；点时断言不组成发布事务。未接真实任务/模型/数据库/收费，下一步可信来源与共同事务适配接口设计。

## 增量：同数据库封存设计（仅文档）

用户选择A，EVIDENCE_SOURCE_SEAL/ADR0004明确集合头/不可变来源清单、observation与final、迟到结果新代或异常隔离、所有Writer共同屏障、四项发布事务及关联读取门禁，附14项未来验收。未写代码/迁移，不接真实来源收费。下一步来源封存接口与内存规则。

## 增量：可信来源与共同事务契约（仅文档）

EVIDENCE_TRUSTED_SOURCE_TRANSACTION及设计分解补齐可信来源完整字段、受控发送/入集合关闭证明、共同事务publishFromSeal与发布关联读取语义，含15项未来验收。现有任务终态/租约不证明执行关闭；v2含期望封存身份的请求指纹方案待确认，v1历史不改写。本轮仅文档，未接真实来源/数据库/收费；下一步确认新协议版本与接口测试边界。

## 增量：v2协议与公开测试边界（仅文档）

用户确认独立evidence-publication-v2、期望封存纳入指纹、v1历史不改写、跨版本共用请求键并冲突拒绝；ADR0005/EVIDENCE_PUBLICATION_V2明确算法向量、四测试边界与受控授权/前序/重放行为。尚无v2运行时/共同登记/事务仓储，V01～V10未来验收未执行。下一步协议基础与完整来源包规则TDD，不接数据库或收费。

## 增量：v2协议身份准备

用户确认prepareV2PublicationIdentity(serviceId,command)，严格验证身份/封存期望/嵌套引用及前序，注入宿主身份、返回规范指纹与evidenceId/auditId，固定向量/乱序/副本及拒绝测试。v1源码不变。尚无来源包校验、发布回执/共享键/共同事务/HTTP/数据库/收费；下一步完整来源包校验夹具。

## Acceptance criteria (original scope, unchanged)

- Jobs expose queued, running, partial-success, failed, restricted, awaiting-user, and completed states.
- Closing the page does not interrupt jobs; completion and required action create in-app notifications.
- Submission freezes estimated credits; successful units settle and failed units refund automatically and idempotently.
- Retries target failed units only and cannot double-charge or overwrite locked content.
- Default model routing and provider failover remain behind a domain-neutral adapter.
- BYOK secrets are encrypted, never logged, scoped per tenant, and calls do not consume platform model credits.
- One chapter per stage normally completes within the five-minute service target under documented test conditions.
