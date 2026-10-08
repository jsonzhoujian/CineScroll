# 独立积分账本领域基础

`CreditLedgerService` 的公开边界为 grant、reserve、settle 和 balance/entries/task 查询。只供可信服务器服务调用，不是成员授权API，也未绑定HTTP、当前AI任务、支付或生产扣费。

## 使用边界

- 必须注入 BillingAccess，按可信服务身份、工作室和操作决定权限。serviceId本身不是认证凭证，不得直接由HTTP请求构造Actor。`./internal-access`提供createInternalBillingAccess：由服务器装配单个serviceId与显式workspaceId/operations列表，无通配符、未知操作默认拒绝，非法配置净化失败；配置复制后外部修改不生效，更新须重新装配。不同服务分别注入适配器，禁止根据请求的serviceId选择授权器。它仅在可信同进程内提供授权，不认证调用者，不支持跨进程凭证、动态撤销或公开成员授权；实际生产装配仍未交付。
- grant固定grantId和来源；reserve固定报价、源版本、责任和最多100个唯一单元。平台单元预留正整数，BYOK单元预留0且不写零金额积分流水。
- settle只接受证据ID，通过SettlementEvidenceReader读取严格结构，校验工作室/任务/单元/源版本、结果指针及规则版本。只读证据适配与独立装配已交付，但该校验不证明外部生成结果真实或质量合格；真实来源生产与写服务尚未交付。
- 固定eventId + 字段顺序无关的规范化内容指纹用于重放。不同内容拒绝；相同grantId/taskId和不同事件不能再次授予/冻结；证据ID不得变更内容或通过新事件重复应用。每个单元最多关闭一次。
- 成功消费预留内积分并同次更新释放差额；明确失败释放；未知/超报价维持冻结并返回reconciling原因。异常通知和运营裁决尚未交付。终态冲突拒绝STATE_CONFLICT，调用方未来须接异常对账，不能当作允许自动补扣。
- 单元全部变更、流水及事件回执通过一次仓储CAS保存。流水汇总余额，无成员余额setter；查询和输入使用副本隔离。金额只用安全整数，累计超出Number.MAX_SAFE_INTEGER拒绝。

## 仓储与限制

InMemoryCreditLedgerRepository仅为规则验证与测试使用，不持久化，不保证跨进程并发。PostgresCreditLedgerRepository新增受控持久化适配器：账本变更作为不可变JSON快照保存，当前指针通过工作室行锁和revision CAS推进，版本插入/指针推进同事务；两个独立连接池共享数据库余额和幂等记录。数据库守卫拒绝历史前缀重写、固定报价变更、闭合单元重开、非法整数金额和单元/流水不一致。

服务只重读CAS冲突（最多20次），存储异常不自动重写；结果未知时调用方应保留原eventId核对/重放，不能新建事件猜测操作未生效。数据库事务设置5秒statement_timeout，不在锁内读取外部证据或调用模型。单快照最大2MB（客户端JSON字节和数据库JSON文本均受限，数据库格式化可能更早触达上限），超限整次变更拒绝，不能削掉历史继续扣费。全量快照与SQL单元核验有增长成本，既有主键支持工作室/版本定位，但不适合大规模账本；分页、规范化增量流水和容量迁移另行设计。

## PostgreSQL 运维边界

可信迁移管理员手动应用 migrations/0001_credit_ledger.sql，运行时不迁移。两个表强制RLS，独立novel_billing角色只能SELECT/INSERT及更新指针列，无版本UPDATE/DELETE、表DELETE或DDL。版本防改触发器、指针顺序及历史守卫作为数据库防线，不代替服务的授权/完整输入和证据校验。

部署必须使用单独受限非owner登录、获准承担novel_billing角色，配置校验TLS和连接池。适配器接受服务器拥有的结构化Pool接口，不自动建立连接。app.billing_workspace_id通过每次事务本地设置；该上下文由可信服务器控制，不是不可伪造的身份认证。禁止用户直连数据库、选择workspace参数或设置上下文。

`./database-readiness`提供只读`assertCreditLedgerDatabase(pool)`和受检工厂`createCheckedCreditLedgerRepository(pool)`。PostgreSQL 16下校验受限登录/角色、表和列权限、强制RLS及严格策略、列/主键/约束定义、历史守卫事件及函数源指纹；失败只返回BILLING_DATABASE_NOT_READY，不修复或写入业务数据。生产装配必须使用受检工厂；低层构造器仍未预检。指纹与当前迁移绑定，迁移变更须同步审核更新。预检仅为当时状态，不验证TLS、真实服务身份或管理员后续DDL；生产装配仍未交付，不能仅据预检宣称安全上线。

尚无任务/冻结/Outbox共同事务、真实扣费、自动恢复/运营裁决、部署备份/保留和容量迁移。这些独立快照不会使现有AI任务成为已计费任务。

暂不包含补偿退款、积分到期/月度重置、供应商成本账本、真实定价、公开账单权限或持久化对账扫描。T09的既有依赖仍保留。规范见 [AI_CREDIT_SETTLEMENT](../../docs/contracts/AI_CREDIT_SETTLEMENT.md)。

## 验证

`./v2-publication-transaction`提供InMemoryV2PublicationTransactionFixture的publishFromSeal/lookupPublished。固定服务器身份、专用授权、v1预置共享键占用、v2同键重放冲突、完整来源包核验、补证前序和复合四对象一次保存有规则测试。最终同步来源包比较至Map保存无await/回调，旧请求重放不读取变化后的来源；已发布seal不可变，历史成员不能被新包隐藏。故障模拟区分保存前无残留与保存后响应丢失可查询。

仅128项/2MiB有界内存夹具，无数据库事务/头锁/真实Writer/来源认证/生产读取门禁。同步source端口不得接异步网络；原v1仓储未接入，只模拟其请求占用，不能宣称生产跨版并发已保护。详细依赖、故障和边界见[事务夹具说明](../../docs/plans/2026-10-07-v2-publication-transaction-fixture.md)。无模型/Key/HTTP/收费接线。

`./v2-source-bundle`提供validateV2SourceBundle(serviceId,command,bundle)：规则夹具核验固定绑定、来源版本前序、完整manifest/指纹、关闭栅栏与资料、全部原始结果、校验/计价匹配，并用最终v2 ID重验资料。输出仅准备结果，无发布回执；未知、未发送失败、非法响应、校验失败和BYOK判据分别保留，BYOK计价必须0。

严格JSON副本隔离与有界容量详见[来源包夹具说明](../../docs/plans/2026-10-07-v2-source-bundle-fixture.md)。不认证生产服务、核验真实业务行/当前来源头或前序发布关联；完整清单仅在该可信测试输入范围内验证。调用者自报一致指纹不证明真实来源，不可直接串接append/commit或用于收费。所有异常净化INVALID_SOURCE_BUNDLE，无真实模型/DB/HTTP接线。

`./evidence-publication-v2`提供prepareV2PublicationIdentity(serviceId,command)及V2PublicationCommand/Identity类型，仅严格准备身份、请求指纹及evidenceId/auditId。serviceId来自宿主参数，命令夹带身份/资料/金额/未知字段拒绝；必填定位字段、嵌套引用、封存期望和前序规则校验，先拒绝非JSON对象/访问器/符号字段再复制输入。V2PublicationProtocolError仅暴露INVALID_PUBLICATION。固定向量、字段乱序、封存字段变化、输入输出副本隔离及v1旧ID有测试。

该函数不验证工作室成员/服务授权、来源真实性、seal是否当前、前序是否存在或协议版本，也不生成发布回执或登记共享请求键。不同封存指纹但相同请求得到相同ID，由未来仓储裁定冲突；不能仅凭ID/指纹宣称发布或跨版防双发。完整来源包校验、共同事务与读取门禁尚未实现。算法规范见[v2契约](../../docs/contracts/EVIDENCE_PUBLICATION_V2.md)。v1模块不改，不接HTTP/真实模型/数据库/收费。

`./evidence-source-seal`提供EvidenceSourceSealRepository四个接口及InMemoryEvidenceSourceSealRepository规则夹具。集合通过构造器预置固定绑定，不从空查询隐式创建。登记版本幂等，observation后新资料推进代；旧清单不可变可历史读取，requireCurrentSeal拒绝用于新请求的旧代。final仅接受关闭无结果失败或唯一结果且有效校验/计价齐全的成功；新事实进入独立内存隔离集合，同版本异内容也保留，不加入原final或改账本。隔离重放保持原代，无裁决/读取/持久化接口。

每实例最多64个集合，每集合来源与隔离资料共256项，超限拒绝而非截断；调用方须保留未登记资料。登记/封存同步变更后返回Promise，测试仅证明同进程调用顺序，不证明数据库锁或跨进程并发。来源与关闭状态是测试调用方声明，无生产身份/真实性/关闭证明。requireCurrentSeal不跨调用持锁，绝不能直接串接现有发布作为事务屏障；生产接口/Writer/发布与读取门禁尚待实施，S01～S14不视为全部验收。细节见[内存规则实施计划](../../docs/plans/2026-10-07-evidence-source-seal-memory.md)。

`./evidence-publication`提供协议ID/指纹函数、EvidencePublicationRepository接口及内存复合记录实现，EvidencePublicationService固定服务身份并在发布/补证/查询/重放前检查专用权限。请求映射、最终ID重验资料、审计和回执一次Map.set共同保存；并发同内容返回原回执，引用/操作/服务冲突拒绝，补证前序同工作室/快照/执行。输入/返回副本隔离，异常脱敏。低层仓储只供可信服务器夹具，不提供成员授权。

这只是内存规则实现，不持久化、不跨进程、不支持生产来源屏障/发布读取门禁/Outbox或扣费。prepare端口是明确的已封存来源测试夹具，不能接收HTTP资料或直接接点时preflight草稿；sourceSealId字符串不证明真实封存。服务授权端口仍由宿主提供，跨进程身份/授权策略装配未交付。lookup仅允许同固定serviceId和指定操作的记录；生产审计留存/总容量/来源证明仍待实现。

未来请求幂等与原子发布规则见[EVIDENCE_ATOMIC_PUBLICATION](../../docs/contracts/EVIDENCE_ATOMIC_PUBLICATION.md)：工作室+请求身份、固定指纹/最终证据ID、请求映射/资料/审计/回执共同事务及来源一致性屏障。仅契约，当前预核验草稿/append/只读资料服务不提供该发布能力或生产读取门禁。

`./evidence-write-preflight`提供createEvidenceWritePreflight：固定服务器身份和工作室publish/supplement专用权限，verifyPublish/verifySupplement仅接受requestId及版本化来源引用（补证含predecessorId）。返回核验资料草稿，不append、分配持久化发布身份或提供回执。读取来源前拒绝越权/夹带资料和金额；校验实际引用、complete=true、任务/执行/结果/计价标识、既有判据及前序快照，末尾isCurrent复查snapshotToken。配置/依赖方法固定，输入和输出副本隔离，错误脱敏。

EvidenceWriteSource.load必须来自可信宿主：负责验证来源服务身份/记录版本、全量原始结果、固定规则与资料关联，返回一致不可变资料包；complete和token只是此受控端口的证明约定，不接受客户端/模型自报。当前只交付接口和测试夹具，不证明真实来源。草稿不是可直接公开写入的凭证，未来发布仍须原子核验/保存请求映射与审计；核验后到发布间的来源变化不能用本层点时检查替代事务保证。无生产写服务、HTTP、DB迁移或收费。

`./evidence-reader-assembly`提供createServerSettlementEvidenceReader，服务器注入Pool和InternalBillingPolicy。先复制/校验策略，再用受检工厂初始化仓储，返回冻结的`read(workspaceId,evidenceId)`九字段投影接口，服务身份固定，不暴露原始资料/仓储/追加入口。证据读取沿用settle权限，只有read权限不放行。Pool由宿主管理；未知工作室拒绝，缺失证据NOT_FOUND，源异常净化。独立装配不是HTTP、成员认证或生产接线，数据库通过预检也不证明来源真实性。后续写服务认证及真实资料生产仍待实现。

`./evidence-database-readiness`提供assertEvidenceMaterialDatabase及createCheckedEvidenceMaterialRepository。PG16只读事务检查实际登录/novel_evidence角色及继承、表/列权限与schema创建权、非owner、强制RLS/单一严格策略、五列及有效主键/必要约束定义、guard事件/函数源/语言/搜索路径/执行权。失败统一EVIDENCE_DATABASE_NOT_READY，不返回受检仓储，不迁移/授权/修复/写业务资料。受检工厂先绑定Pool.connect，Pool仍由宿主管理；低层构造器不预检，未来受控装配须使用受检入口。指纹与0002迁移/PG16绑定，更新迁移须同步审核预检常量；仅检查当时状态，不证明TLS、真实性、写服务身份或管理员后续DDL。

预检测试使用TEST_EVIDENCE_READINESS_DATABASE_URL，仅可丢弃管理员测试库；独立运行或全套`--test-concurrency=1`，不与DDL测试并行。暂时漂移均由测试管理员恢复，应用预检不修复。

`./postgres-evidence`提供PostgresEvidenceMaterialRepository：工作室+ID唯一键下并发幂等保存不可变JSON资料，读取再次核验结构及规范化指纹。同工作室前序FK及触发器核验绑定/固定快照/执行ID，forced RLS及独立novel_evidence角色只允许SELECT/INSERT，触发器拒绝UPDATE/DELETE。应用和数据库单资料上限2MB，数据库JSON格式化可能更早触达；超限拒绝。每次事务5秒语句超时，固定pg_catalog搜索路径和本地app.evidence_workspace_id上下文，Pool生命周期归宿主。错误脱敏为INVALID_MATERIAL/CONFLICT/PREDECESSOR_NOT_FOUND/STORAGE_UNAVAILABLE。

可信管理员手动应用0002_evidence_material.sql，运行时不迁移。角色上下文不是身份认证；禁止用户直连、控制上下文或仓储写入。专门只读启动预检已交付，部署仍需受限非owner登录、校验TLS/池配置并使用受检装配。数据库不重现全部资料/质量/价格校验或来源真实性；合法形状的SQL资料仍不当然可信。真实写服务、跨证据原始结果唯一性、生产接线、恢复扫描、备份/留存和总容量策略均未交付。

实库证据验证使用TEST_EVIDENCE_DATABASE_URL，只能指向可丢弃管理员测试库：`node --test packages/billing/test/postgres-evidence.test.ts`。创建/删除随机受限登录，临时DDL/授权仅测试用途，不用于部署。与其他DDL测试一起运行须`--test-concurrency=1`。验证持久化重启、双池并发、冲突回滚、补证及RLS/只追加权限/历史触发器和投影。

`./evidence-material-repository`定义可信服务器低层EvidenceMaterialRepository与内存实现。append/get/read按工作室+证据ID保存资料副本和SHA256规范化指纹（对象键顺序忽略、数组顺序保留、前序关系参与）；同内容幂等，不同内容冲突。补证必须指向同工作室既存记录，保持绑定、计费快照和执行ID，不自引用、不覆盖历史。append复用只读适配器检查结构/判据，内部放行只用于schema验证，绝非来源认证或写权限授权。禁止客户端直连。没有持久化、跨进程并发、跨证据结果唯一性、写权限、容量/留存策略或生产接线；不能作为已可信的生产来源。

`./verified-evidence`提供createVerifiedSettlementEvidenceReader，注入BillingAccess及EvidenceMaterialSource。source必须是服务器拥有的一致、唯一、不可变资料源，不是客户端或模型响应；适配器核验formatVersion=1资料包的固定绑定、执行关闭/未知、原始持久化结果和版本化校验/计价，再输出严格九字段。FORBIDDEN/NOT_FOUND/UNAVAILABLE/CONFLICT不泄露源错误；账本调用仍统一INVALID_EVIDENCE。支持成功/明确失败/未知，不截断超报价金额。资料仓储的幂等/指纹及持久化已交付，但资料源真实性、质量/计价规则批准、写请求身份/审计及生产可信来源仍未实现。验证使用测试夹具，不冒充真实业务证据。

写服务专用授权及来源核验的未来契约见[EVIDENCE_WRITE_AUTHORITY](../../docs/contracts/EVIDENCE_WRITE_AUTHORITY.md)，仅文档，尚无公开或生产写服务。

`./server-assembly`提供createServerCreditLedger：先校验内部授权和依赖，再以受检工厂初始化PostgreSQL仓储，返回固定serviceId的冻结窄接口（工作室+领域命令/查询），不暴露仓储或授权器。策略在异步前复制，Pool.connect及证据read方法绑定固定，但依赖自身内部状态仍由可信宿主管理。失败不返回服务，Pool生命周期归宿主。独立装配不代表已经挂载生产入口，不验证成员身份/TLS，不迁移、不读取环境变量、不接真实扣费。

`node --test packages/billing/test/*.test.ts`，`pnpm --filter @novel-adaptation/billing typecheck`。测试固定积分示例不代表产品价格；授权与证据读取器使用测试夹具，不冒充生产身份/证据验证。

实库测试使用 TEST_BILLING_DATABASE_URL（仅可丢弃管理员测试库）：`node --test packages/billing/test/postgres-ledger.test.ts`。未配置时显式跳过；隔离运行并要求临时测试库允许随机受限登录无密码连接，绝不能把此测试策略应用于部署。测试手动应用迁移，创建/删除随机登录角色，保留随机工作室夹具，模型/真实Key/业务库完全不参与。验证包含关闭并重建连接池后读回、双池并发、RLS/最小权限、回滚、历史保护及SQL非法单元拒绝。

预检实库测试使用TEST_BILLING_READINESS_DATABASE_URL，仅限相同可丢弃管理员测试库。它临时改变并恢复DDL/权限，必须单独运行，或全套使用`--test-concurrency=1`，不能与其他DDL测试并行。
## v2发布读取增量

`InMemoryV2PublicationTransactionFixture.readPublishedEvidence(workspaceId,evidenceId)` 经独立 `settlementAccess` 的 `settle` 权限返回既有九字段证据，缺省拒绝。读取保存的历史完整来源包，重验请求、资料、审计、回执及封存关联；不读取当前来源头。`storedPublicationFixture` 是仅测试的同步故障注入存储端口，不能作为真实来源证明或生产仓储。未升级v1读取、数据库接线或真实收费。详见[读取设计](../../docs/plans/2026-10-08-v2-published-evidence-reader.md)。

## D1a只读来源目录预检

`./evidence-source-database-readiness` 导出 `assertEvidenceSourceDatabase(pool)`，返回void或净化的 `EVIDENCE_SOURCE_DATABASE_NOT_READY`。仅PG16封闭草稿目录：角色/权限、四表精确形状、RLS默认拒绝、约束/索引、保护函数/触发器。不会返回读写仓储、检查业务资料或运行迁移。宿主须提供pg兼容Pool，失败调用绑定的`release(true)`销毁会话；宿主管理池/TLS/登录生命周期。目录查询使用只读事务、5秒语句时限，未实现整体/池等待期限。

独立[SQL草稿](../../docs/sql-drafts/evidence-source-d1a.sql)不在migrations目录，未执行；无数据读写授权/写函数/业务身份映射。模拟目录结果仅验证拒绝流程，真实SQL/目录表达式/权限需另批隔离库核实。[边界说明](../../docs/plans/2026-10-08-evidence-source-d1a.md)。
