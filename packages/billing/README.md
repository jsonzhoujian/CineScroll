# 独立积分账本领域基础

`CreditLedgerService` 的公开边界为 grant、reserve、settle 和 balance/entries/task 查询。只供可信服务器服务调用，不是成员授权API，也未绑定HTTP、当前AI任务、支付或生产扣费。

## 使用边界

- 必须注入 BillingAccess，按可信服务身份、工作室和操作决定权限。serviceId本身不是认证凭证，不得直接由HTTP请求构造Actor；真实身份/权限适配器尚未交付。
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

`node --test packages/billing/test/*.test.ts`，`pnpm --filter @novel-adaptation/billing typecheck`。测试固定积分示例不代表产品价格；授权与证据读取器使用测试夹具，不冒充生产身份/证据验证。

实库测试使用 TEST_BILLING_DATABASE_URL（仅可丢弃管理员测试库）：`node --test packages/billing/test/postgres-ledger.test.ts`。未配置时显式跳过；隔离运行并要求临时测试库允许随机受限登录无密码连接，绝不能把此测试策略应用于部署。测试手动应用迁移，创建/删除随机登录角色，保留随机工作室夹具，模型/真实Key/业务库完全不参与。验证包含关闭并重建连接池后读回、双池并发、RLS/最小权限、回滚、历史保护及SQL非法单元拒绝。

预检实库测试使用TEST_BILLING_READINESS_DATABASE_URL，仅限相同可丢弃管理员测试库。它临时改变并恢复DDL/权限，必须单独运行，或全套使用`--test-concurrency=1`，不能与其他DDL测试并行。
