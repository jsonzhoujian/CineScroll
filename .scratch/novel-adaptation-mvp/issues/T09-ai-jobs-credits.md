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

## 增量：v2来源包规则夹具

用户确认validateV2SourceBundle，固定binding/报价、来源前序、全成员清单、关闭资料/栅栏、原始结果/校验/计价及BYOK零额度规则有测试；复制前严格JSON校验、有界容量、净化错误。历史validation/pricing/closure逐版本核验，不能用新版隐藏旧非法引用/金额/关闭关系；固定报价下矛盾计价拒绝。返回准备结果，不认证来源/查业务行/核验当前头或前序存在性，不接DB/发布/收费。下一步共同事务规则与共享请求登记。

## 增量：v2共同事务内存夹具

增量共同事务夹具：用户确认publishFromSeal/lookupPublished，内存共享登记纳入v1预置占用，专用授权、v2同键冲突/并发重放、来源等待后最终同步核验、前序/历史成员和四对象一次Map保存有测试。组装失败无残留，保存后响应故障可原请求恢复；固定seal身份不可变，有界容量。原v1写路径未接，未提供真实DB/来源/Writer/生产读取门禁/收费；下一步已发布证据读取门禁。

## 增量：v2已发布证据内存读取门禁

用户确认readPublishedEvidence(workspaceId,evidenceId)，独立settlementAccess/settle权限默认拒绝，读取历史来源包并核验四对象、规范指纹/ID及封存关联后输出既有九字段。同步存储故障夹具覆盖裸资料/残缺/篡改、跨工作室、授权撤销、异常净化和历史副本；未升级v1读取、生产门禁、数据库或收费。下一步明确数据库共同事务与所有Writer屏障的实施切片，须独立批准。

## 增量：数据库来源存储与屏障实施设计（仅文档）

用户确认第一步设计：8类逻辑存储对象、受控业务写/发送/关闭/封存入口、同头锁与不可变历史、隔离可靠保存、最小权限/RLS/预检、容量/时限候选及DB01～DB16未来验收。D1隔离库存储→D2全部Writer→D3共同发布/读取分期；参数和具体SQL/角色方案待批准，没有迁移/数据库连接/收费。下一步确认D1a的迁移草稿与只读启动预检范围及参数，不能直接跳生产。

## 增量：D1a封闭SQL草稿与只读目录预检

用户确认独立SQL草稿（不进入migrations、不执行）及assertEvidenceSourceDatabase(pool)模拟测试。四类基础表默认拒绝RLS，无数据grant/写函数；预检拒绝角色/结构/约束/索引/函数/触发器漂移，绑定依赖、严格true、错误净化与失败会话销毁，不返回仓储。累计限额/完整包/真实业务身份与写入口仍未实现；PG16目录及SQL实际验收待独立批准，不能算已部署屏障/生产收费。下一步仅隔离库核实草稿/目录期望，不接业务库。

## 增量：D1a仅隔离PG16实库验收

用户批准新建无TCP临时PG16.14实例执行草稿和漂移测试。健康目录先失败再修复connoinherit类型判据；33项实库测试（28类漂移、禁止数据访问、封闭保护及Unicode结构边界）通过，恢复后健康再次通过；全量342通过/18其他数据库条件跳过，类型检查通过。测试库/角色清理，实例停止；未连接业务库、未实现受控Writer/完整屏障或收费。下一步单独确认D1b最小接口及权限/真实证明方案。

## 增量：D1b最小来源登记契约（仅文档）

用户确认initializeSourceCollection/registerSourceFromBusiness/readIngestReceipt设计。契约补固定业务引用、两初始来源原子保存、共享workspace+ingest键、完整回执关联、历史重放、HEAD冲突停自动改写、固定服务/工作室/kind/生产者权限及I01～I16未来验收。首切片仅task/snapshot，执行/发送/关闭/隔离/封存及真实Writer延期；D1a仍封闭，未修改运行时代码/SQL/角色/数据库。下一步确认运行时seam、指纹向量、业务证明定位及权限/限额后实施规则切片。

## 增量：D1b登记身份与指纹纯函数

2026-10-08用户确认prepareSourceIngestIdentity(serviceId, operation, command)公开测试接口。实现initialize/register严格校验、完整身份规范化UTF8 SHA256、workspace/ingest共享键与副本隔离，根包导出；两条OpenSSL固定向量冻结于D1b契约。6项专项通过，全量315通过/19数据库条件跳过，类型检查通过；双项审查无阻断。没有认证/占键/回执/数据库写入，I01～I16及权限映射、真实业务证明仍未实现。

## 增量：方案A隔离测试来源设计（仅文档）

2026-10-08用户选择方案A。设计TaskRevision、固定计费快照、ExecutionIdentity及独立FixedQuote的精确版本关联、服务端投影/指纹区分、候选task追加白名单；三个仓储interface不接受payload/client，F01～F18为未来验收。ADR0006记录隔离实验不作生产证明。未增加代码/SQL/角色授权，不运行数据库；字段、权限锁序、回执预算及实库实施须另批。Standards/Spec审查无阻断，补齐快照/执行双向引用图；本地引用、验收编号及diff检查通过，文档-only未重跑代码测试。

## 增量：D1b独立存储与权限方案（仅文档）

用户确认2026-10-08本轮仅设计。新增类型业务/来源关联、共享回执键与成员、稳定授权/预算逻辑存储、角色/RLS边界、授权共享锁与workspace预算外层串行点；容量/时限及P01～P12均为待批准/未执行候选。不写可执行SQL、不授权、不连接数据库，不覆盖D1a；编码/profile/仓储和D2/D3仍未实现。

Standards/Spec无阻断，按建议补共享锁所需权限/helper与防授权修改前置验收；ADR0007为Proposed。本地引用、P01～P12及diff检查通过，文档-only未重跑代码/数据库测试。

## 增量：D1b独立SQL草稿

用户确认锁序/受控锁定helper/实验容量，新增docs/sql-drafts/evidence-source-d1b.sql与交付记录。包含13表、类型FK、共享回执键、范围约束及内部授权共享锁，所有数据写保持封闭，没有login/装载/写仓储。ADR0007仅草稿范围接受。预算累计、完整规范编码/跨行投影、恢复读RLS及撤权管理尚未实现；未执行SQL或数据库操作，静态检查不能替代实库验收。

Standards/Spec静态审查无阻断，检查13表/5角色/6函数/4策略、美元引号配对、文档引用及diff通过。无SQL解析器且未执行PG，列级锁权限、同值UPDATE拒绝及owner转移后ACL均留作明确实库用例；未重跑代码测试。

## 增量：D1b封闭草稿隔离PG16验证

2026-10-08继续下一步，创建无TCP新PG16.14实例验证草稿；10项创建/DDL回滚/RLS/ACL/普通login拒绝/helper无principal拒绝/管理员写门禁/Unicode测试通过。仅修正测试name[]读取和owner隐式EXECUTE期望，SQL草稿未改。全仓325通过/19条件跳过，typecheck通过；测试库及角色清理，实例停止。空授权表未证明有行锁/撤权竞态，不算完整D1b或P01～P12全通过；正向资料、写仓储/完整编码与预算仍待后续。

Standards/Spec无阻断，调整进度标题位置；本轮创建响应丢失未注入，未来测试准备阶段应按本次随机身份限定核对清理，当前独立查询已确认清理成功。

## 增量：D1b封闭目录预检

2026-10-08继续下一步，实现assertSourceIngestDraftDatabase只读接口（根包导出），固定无OID目录投影与摘要，核验受限inspector/有效权限/角色链，拒绝域/结构/索引/函数/RLS/ACL/default ACL/触发器/继承/改写规则漂移。5项mock+36项隔离PG16测试通过，25类漂移连续拒绝且人工恢复健康；全仓356通过/19条件跳过，类型检查通过。双项审查无阻断，补ACL确定排序后专项41项复验通过；临时库/角色清理、实例停止。SQL草稿未改，不读业务表/返回writer或证明正向授权/业务来源，尚未接启动装配。

## D1b 隔离授权 fixture 增量（2026-10-08）

新增独立测试 SQL：固定登录/service/workspace 映射准备、revision 校验的 workspace 授权启停、保留 session_user 的只读锁探针。真实行验证两种读取/撤权顺序；重复准备不复活已撤权行。原封闭目录预检仍拒绝此扩展，业务十一表继续关闭。详见 `docs/plans/2026-10-08-source-ingest-d1b-auth-fixture.md`。不包含生产授权 API、principal 撤权、业务资料装载或登记写入。

## D1b 业务资料纯校验增量（2026-10-08）

用户批准方案 A：先严格资料校验，再接数据库原子装载。本轮新增 `prepareSourceBusinessFixture`，验证四类精确资料、完整固定引用、报价一致性与任务链，输出独立业务文档、规范内容和指纹。详见 `docs/plans/2026-10-08-source-business-fixture-validation.md`。仅证明内部一致性；装载授权、已存冲突、不可变持久化和预算累计尚未实现。

## D1b 业务资料隔离装载增量（2026-10-08）

用户确认方案 A 的独立测试装载器。新增 test/support 入口与独立 SQL 权限扩展，工作室预算串行后共同保存四类不可变资料；规范内容/全部投影重放比较、固定实体冲突、部分写入失败回滚、并发收敛和独立连接在途观察均实库验收。详见 `docs/plans/2026-10-08-source-business-fixture-loader.md`。不开放运行登记权限；扩展目录尚无独立冻结验收，不能生产装配。

## D1b 完整扩展目录门禁增量（2026-10-08）

方案 A 固定两个 guard 的稳定归属、撤回临时 probe/schema 授权，新增 test/support 受限 inspector 门禁与固定完整目录摘要（非运行时学习），包括扩展角色及 global 默认 ACL。13 类漂移拒绝并恢复，原闭合门禁不放宽。详见 `docs/plans/2026-10-08-source-business-fixture-readiness.md`；不读取业务行、不自动修复或提供生产许可，持久化完整性读取留下一切片。

## D1b 已存资料完整性读取增量（2026-10-08）

用户方案 A：test/support 管理员读取精确 task/snapshot/execution 引用及依赖报价/任务链，在 REPEATABLE READ READ ONLY 事务重算规范内容/指纹并比较完整投影，不回退最新、不修复。运行角色无新授权；普通登录、范围外、错误命令、损坏投影和非规范字节实库验收。详见 `docs/plans/2026-10-08-source-business-fixture-reader.md`。目录门禁独立装配、运行服务读取授权及来源初始化仍未实现。

## D1b 管理员只读装配增量（2026-10-08）

用户方案 A：单一临时 URI 创建自有 inspector/管理员池，每次读取先重新验收冻结目录，再调用精确完整性读取；门禁失败不进入读取。不接受双 Pool/第二地址，配置及引用同步固定，close 幂等。详见 `docs/plans/2026-10-08-source-business-fixture-assembly.md`。仅地址级绑定，不声明检查/读取之间原子 DDL 防护或生产许可；来源初始化与运行服务授权仍待后续。

## D1b 运行 initialize 事务设计增量（2026-10-08）

用户方案 A 仅文档：普通 LOGIN/受控 SQL 入口，同连接 READ COMMITTED 锁真实授权→预算→unit/head→核验业务→共同来源/关联/回执；管理员只读副本不作写权限权威。新增 `docs/plans/2026-10-08-source-initialize-runtime-design.md`、Proposed ADR0008、R01～R12未来验收，明确编码/回执预算/权限矩阵需分段冻结。本轮不改代码、不执行 SQL/GRANT/数据库，不开放运行仓储。

## D1b initialize 入口权限细化增量（2026-10-08）

继续既定文档切片：新增 `docs/plans/2026-10-08-source-initialize-entry-permissions.md`，细化普通 LOGIN/initializer/locker 权限、非递归 RLS、历史重放与新业务范围分支、行锁列权限和不可变/延迟完整性 guards，并列出 E01～E12 未来验收。ADR0008保持 Proposed；编码、回执/预算公式及独立运行 profile 尚未冻结。本轮不改可执行 SQL/代码、不授权、不执行数据库或代码测试。

Standards/Spec各发现同一外键顺序问题，已修正并复核无残留阻断；引用、验收编号及 diff 检查通过。

## D1b initialize 编码与预算候选增量（2026-10-08）

新增 `docs/plans/2026-10-08-source-initialize-encoding-budget.md`：不改既有命令指纹，明确完整身份存储、13键回执、两有序引用，以及不自引用的全列逻辑字节预算与三种增量分支。C01～C08仍待验收，新增完整黄金向量/规则版本字符串仍待对齐，不能宣称已全面冻结。本轮仅文档，无代码/SQL/授权/数据库执行。

Standards/Spec审查无阻断；引用、C01～C08编号及diff检查通过。下一切片补离线固定黄金向量和完整列/规则版本对齐，不提前开放执行权限。

## D1b initialize 离线黄金向量增量（2026-10-09）

用户选择A：保留统一ruleVersion、独立projectionRuleVersion。新增固定17份规范字节JSON及测试专用合成构造器、5项离线复验，含两payload手写对照、OpenSSL摘要、全列静态核对及三种预算样例。详见 `docs/plans/2026-10-09-source-initialize-golden-vectors.md`。预期首次由构造器固定，不宣称全量手写或SQL独立实现证明；统一规则生产归属待D2。

类型检查通过；billing140通过/10条件跳过，全仓347通过/20条件跳过。未改运行代码/SQL/权限，未连接数据库。C01～C08未整体通过，容量/SQL/原子性仍待批准隔离切片。

Standards与Spec本轮审查均无阻断；OpenSSL仅证明摘要，完整语义仍需固定材料审阅/SQL对照，已明确落档。

## D1b SQL 编码/投影边界设计增量（2026-10-09）

新增 `docs/plans/2026-10-09-source-initialize-sql-codec-design.md`：独立封闭SECURITY INVOKER纯计算schema、类型封套/有界编码/严格业务投影与UTC/hex预算，S01～S08未来验收。旧摘要不改，不把新schema天然纳入旧门禁拒绝范围；新增完整四类业务向量及遍历上界仍待草稿前确定。本轮仅文档，不交付/执行SQL、不授权或连接数据库。

Standards无硬性阻断；Spec的时间原偏移和统一报价规则断言已澄清，复核无残留阻断。引用/编号/diff检查通过，未运行代码/数据库测试。

## D1b 独立纯计算SQL草稿增量（2026-10-09）

用户确认遍历上界及草稿实施：新增 `docs/sql-drafts/evidence-source-d1b-codec.sql`，独立schema/8个INVОKER函数，深度8/值节点50000/输入2MiB工作量口径/输出16MiB，固定封套编码、有限task/snapshot投影与逻辑预算。无新角色/运行GRANT/业务表访问/writer；仅文件交付，不执行数据库。

详见 `docs/plans/2026-10-09-source-initialize-sql-codec-draft.md`。封套及部分值域不等于完整业务guard，SQL/Node三方对照与实际ACL仍未验收。双轴审查数字词法问题已修复，加入后续1.0等价向量；静态检查不能替代PG解析/执行。

## D1b 纯计算草稿隔离PG16增量（2026-10-09）

用户确认无TCP临时实例验证：安装独立纯schema，新增条件测试，38项通过，17份黄金字节/摘要、原命令指纹、业务编码/投影/预算样例、有限拒绝及普通LOGIN实际42501验证。详见 `docs/plans/2026-10-09-source-codec-postgres-validation.md`。SQL草稿/运行代码/旧profile未改，没有writer授权；全部等值容量/DDL漂移/写原子性仍未验证。

独立确认测试schema及临时probe角色已清空，实例停止，目录/log保留；全仓类型检查通过。

全仓347通过/21条件跳过，不混算独立实库38项。Standards/Spec无阻断，引用/diff检查通过；fixture环境options强化仍为后续建议。

## D1b codec 容量等值与冻结目录增量（2026-10-09）

用户明确补容量等值/拒绝再冻结配置。新增test/support只读codec门禁及静态无OID目录资料；边界深度/50000节点/2MiB输入/16MiB输出/包2MiB/回执16KiB等值与+1覆盖。16MiB测试先超10s，quote_string改为固定扫描后约0.3s，原黄金字节不变。13类目录漂移拒绝/明确恢复，含空default ACL先红后补行头投影，旧两个profile不改、无writer或业务授权。

详见 `docs/plans/2026-10-09-source-codec-boundaries-readiness.md`；冻结指纹固定在代码/资料，不运行时学习。codec_admin仍为隔离管理员owner，不是生产owner；纯函数证明不代完整业务guard/原子写入。68项实库、3项门禁单元通过；全仓351通过/21条件跳过、类型检查通过，双轴审查无阻断。独立核对schema/测试角色/default ACL均清空，实例停止，目录/log留存。旧业务两profile同库组合复验留下一切片。

## D1b 组合目录与同事务业务核验推进（2026-10-09）

用户确认独立组合profile：复用两静态目录/摘要，单连接REPEATABLE READ READ ONLY检验随机d1b库业务inspector及两目录，不放宽独立codec postgres库限制。新增组合实库子项，原D1b与组合67项通过；codec/业务两侧漂移拒绝/明确恢复。详见 `docs/plans/2026-10-09-source-combined-readiness-verification.md`。

同事务精确四类业务核验仅推进候选/V01～V05，尚未实施或授权；组合目录不代真实行核验、DDL锁或writer许可。组合单元2项通过；全仓354通过/21条件跳过、类型检查通过。Standards/Spec无阻断，引用/diff通过；随机测试库/角色独立核对0，专属实例停止，目录/log保留。

## D1b 完整业务核验清单与私有SQL（2026-10-09）

用户要求清单后实施私有核验SQL。新增 `docs/plans/2026-10-09-source-private-verification.md`（B01～B12）及独立 `docs/sql-drafts/evidence-source-d1b-verify.sql`，两个默认封闭INVОKER函数：真实session_user授权锁→精确四记录producer过滤→全列/完整规范字节/指纹及双向引用/报价核验→两来源待写资料。无writer/来源或预算写入/内部COMMIT、无新GRANT/运行owner或RLS。

本轮文件交付，不安装/执行数据库；旧目录/组合gate不自动覆盖新verify schema，需后续独立profile及实库验收。SQL解析与B01～B12/V01～V05尚未执行。

Standards/Spec静态审查发现并修复bytea_output会话展示差异：四类实际typed bytea显式转小写hex，再与独立重建的规范字节比较。双轴复审无残留静态阻断；后续须补escape/hex实库回归。本轮引用、范围及diff检查通过，未运行数据库或应用测试。

## D1b 私有核验独立配置与隔离验收（2026-10-09）

用户确认独立门禁与私有主函数两个测试边界。新增test-only私有目录gate、无OID静态资料及主函数实库子项；旧业务/codec摘要与查询、私有SQL原稿均不改。新摘要1cd45fa2d0f30621cbc8a9cd5bc3fb8edbc32095b3ef5d8e83fc833d9ebfa536，门禁单元红→绿2项，8类目录漂移拒绝/显式恢复；实库111项通过含旧业务/组合回归。

四类已存行字节/时间/binding/producer损坏与专属投影拒绝、黄金payload/摘要、真实授权/撤权、外层事务锁保持均验收；追加4个同步document/字节/列的自洽跨行冲突。普通LOGIN直接调用拒绝，临时管理员wrapper仅证明SQL语义，不作生产owner/RLS权限证明。完整B01～B12逐列/关联、byok/容量主函数边界及共同写入仍未完成。详见docs/plans/2026-10-09-source-private-verification-acceptance.md。

全仓358通过/21数据库条件跳过（共379），类型检查通过。Standards清理风险修复、Spec关联覆盖缺口补齐部分向量且明确余项，双轴复审无残留阻断。独立连接核对测试库/角色均0，临时实例停止，目录/log保留；无生产GRANT/RLS/运行装配/writer，无push。

## D1b 逐列/逐关联/主函数边界与写入前置（2026-10-09）

用户批准补齐测试再推进同事务写入。新增71列显式manifest并对齐实库列/装载投影，18精确引用、28binding、8计价、自洽v2与7主函数输入/上界向量；实库244项通过（增133），manifest单元1项通过。全仓360通过/21条件跳过，共381，类型检查通过。原SQL及三个冻结目录不改，无生产权限或writer。

严格业务封套合法上界各<512KiB/四份<2MiB；单份2MiB/累计16MiB硬拒绝分支当前不可达，保留防御，不造合法等值测试。验证100个256单位Unicode ID与BYOK0正例，101项/257单位/畸形2MiB字符串拒绝；主函数不得截断。详见docs/plans/2026-10-09-source-private-verification-complete-vectors.md。锚点ID向量可能被binding比较拒绝，不声称逐分支命中。

Standards/Spec静态复审均无阻断；独立检查测试库/角色均0，实例停止，目录/log保留。已列同事务initialize入口和新NOLOGIN owner/真实LOGIN最小权限/RLS/guard差异；按TDD新seam须确认后实施，不将管理员wrapper当运行仓储。共同写入、历史重放与未知提交恢复尚未实施。

## Acceptance criteria (original scope, unchanged)




- Jobs expose queued, running, partial-success, failed, restricted, awaiting-user, and completed states.
- Closing the page does not interrupt jobs; completion and required action create in-app notifications.
- Submission freezes estimated credits; successful units settle and failed units refund automatically and idempotently.
- Retries target failed units only and cannot double-charge or overwrite locked content.
- Default model routing and provider failover remain behind a domain-neutral adapter.
- BYOK secrets are encrypted, never logged, scoped per tenant, and calls do not consume platform model credits.
- One chapter per stage normally completes within the five-minute service target under documented test conditions.
