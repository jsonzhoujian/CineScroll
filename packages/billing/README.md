# 独立积分账本领域基础

`CreditLedgerService` 的公开边界为 grant、reserve、settle 和 balance/entries/task 查询。只供可信服务器服务调用，不是成员授权API，也未绑定HTTP、当前AI任务、支付或生产扣费。

## 使用边界

- 必须注入 BillingAccess，按可信服务身份、工作室和操作决定权限。serviceId本身不是认证凭证，不得直接由HTTP请求构造Actor。`./internal-access`提供createInternalBillingAccess：由服务器装配单个serviceId与显式workspaceId/operations列表，无通配符、未知操作默认拒绝，非法配置净化失败；配置复制后外部修改不生效，更新须重新装配。不同服务分别注入适配器，禁止根据请求的serviceId选择授权器。它仅在可信同进程内提供授权，不认证调用者，不支持跨进程凭证、动态撤销或公开成员授权；实际生产装配仍未交付。
- grant固定grantId和来源；reserve固定报价、源版本、责任和最多100个唯一单元。平台单元预留正整数，BYOK单元预留0且不写零金额积分流水。
- settle只接受证据ID，通过可信SettlementEvidenceReader读取严格结构，校验工作室/任务/单元/源版本、结果指针及规则版本。这个校验不证明外部生成结果真实或质量合格；实际证据服务尚未交付。
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

`./evidence-reader-assembly`提供createServerSettlementEvidenceReader，服务器注入Pool和InternalBillingPolicy。先复制/校验策略，再用受检工厂初始化仓储，返回冻结的`read(workspaceId,evidenceId)`九字段投影接口，服务身份固定，不暴露原始资料/仓储/追加入口。证据读取沿用settle权限，只有read权限不放行。Pool由宿主管理；未知工作室拒绝，缺失证据NOT_FOUND，源异常净化。独立装配不是HTTP、成员认证或生产接线，数据库通过预检也不证明来源真实性。后续写服务认证及真实资料生产仍待实现。

`./evidence-database-readiness`提供assertEvidenceMaterialDatabase及createCheckedEvidenceMaterialRepository。PG16只读事务检查实际登录/novel_evidence角色及继承、表/列权限与schema创建权、非owner、强制RLS/单一严格策略、五列及有效主键/必要约束定义、guard事件/函数源/语言/搜索路径/执行权。失败统一EVIDENCE_DATABASE_NOT_READY，不返回受检仓储，不迁移/授权/修复/写业务资料。受检工厂先绑定Pool.connect，Pool仍由宿主管理；低层构造器不预检，未来受控装配须使用受检入口。指纹与0002迁移/PG16绑定，更新迁移须同步审核预检常量；仅检查当时状态，不证明TLS、真实性、写服务身份或管理员后续DDL。

预检测试使用TEST_EVIDENCE_READINESS_DATABASE_URL，仅可丢弃管理员测试库；独立运行或全套`--test-concurrency=1`，不与DDL测试并行。暂时漂移均由测试管理员恢复，应用预检不修复。

`./postgres-evidence`提供PostgresEvidenceMaterialRepository：工作室+ID唯一键下并发幂等保存不可变JSON资料，读取再次核验结构及规范化指纹。同工作室前序FK及触发器核验绑定/固定快照/执行ID，forced RLS及独立novel_evidence角色只允许SELECT/INSERT，触发器拒绝UPDATE/DELETE。应用和数据库单资料上限2MB，数据库JSON格式化可能更早触达；超限拒绝。每次事务5秒语句超时，固定pg_catalog搜索路径和本地app.evidence_workspace_id上下文，Pool生命周期归宿主。错误脱敏为INVALID_MATERIAL/CONFLICT/PREDECESSOR_NOT_FOUND/STORAGE_UNAVAILABLE。

可信管理员手动应用0002_evidence_material.sql，运行时不迁移。角色上下文不是身份认证；禁止用户直连、控制上下文或仓储写入。部署仍需受限非owner登录、校验TLS/池配置与专门启动预检。数据库不重现全部资料/质量/价格校验或来源真实性；合法形状的SQL资料仍不当然可信。真实写服务、跨证据原始结果唯一性、生产接线、恢复扫描、备份/留存和总容量策略均未交付。

实库证据验证使用TEST_EVIDENCE_DATABASE_URL，只能指向可丢弃管理员测试库：`node --test packages/billing/test/postgres-evidence.test.ts`。创建/删除随机受限登录，临时DDL/授权仅测试用途，不用于部署。与其他DDL测试一起运行须`--test-concurrency=1`。验证持久化重启、双池并发、冲突回滚、补证及RLS/只追加权限/历史触发器和投影。

`./evidence-material-repository`定义可信服务器低层EvidenceMaterialRepository与内存实现。append/get/read按工作室+证据ID保存资料副本和SHA256规范化指纹（对象键顺序忽略、数组顺序保留、前序关系参与）；同内容幂等，不同内容冲突。补证必须指向同工作室既存记录，保持绑定、计费快照和执行ID，不自引用、不覆盖历史。append复用只读适配器检查结构/判据，内部放行只用于schema验证，绝非来源认证或写权限授权。禁止客户端直连。没有持久化、跨进程并发、跨证据结果唯一性、写权限、容量/留存策略或生产接线；不能作为已可信的生产来源。

`./verified-evidence`提供createVerifiedSettlementEvidenceReader，注入BillingAccess及EvidenceMaterialSource。source必须是服务器拥有的一致、唯一、不可变资料源，不是客户端或模型响应；适配器核验formatVersion=1资料包的固定绑定、执行关闭/未知、原始持久化结果和版本化校验/计价，再输出严格九字段。FORBIDDEN/NOT_FOUND/UNAVAILABLE/CONFLICT不泄露源错误；账本调用仍统一INVALID_EVIDENCE。支持成功/明确失败/未知，不截断超报价金额。资料源真实性、质量/计价规则批准、证据写入幂等/指纹及持久化仍未实现；不存在生产默认可信来源。本轮仅授权测试夹具与内存账本验证。

`./server-assembly`提供createServerCreditLedger：先校验内部授权和依赖，再以受检工厂初始化PostgreSQL仓储，返回固定serviceId的冻结窄接口（工作室+领域命令/查询），不暴露仓储或授权器。策略在异步前复制，Pool.connect及证据read方法绑定固定，但依赖自身内部状态仍由可信宿主管理。失败不返回服务，Pool生命周期归宿主。独立装配不代表已经挂载生产入口，不验证成员身份/TLS，不迁移、不读取环境变量、不接真实扣费。

`node --test packages/billing/test/*.test.ts`，`pnpm --filter @novel-adaptation/billing typecheck`。测试固定积分示例不代表产品价格；授权与证据读取器使用测试夹具，不冒充生产身份/证据验证。

实库测试使用 TEST_BILLING_DATABASE_URL（仅可丢弃管理员测试库）：`node --test packages/billing/test/postgres-ledger.test.ts`。未配置时显式跳过；隔离运行并要求临时测试库允许随机受限登录无密码连接，绝不能把此测试策略应用于部署。测试手动应用迁移，创建/删除随机登录角色，保留随机工作室夹具，模型/真实Key/业务库完全不参与。验证包含关闭并重建连接池后读回、双池并发、RLS/最小权限、回滚、历史保护及SQL非法单元拒绝。

预检实库测试使用TEST_BILLING_READINESS_DATABASE_URL，仅限相同可丢弃管理员测试库。它临时改变并恢复DDL/权限，必须单独运行，或全套使用`--test-concurrency=1`，不能与其他DDL测试并行。
