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

InMemoryCreditLedgerRepository仅为规则验证与测试使用。两个服务共享同一实例可验证并发不透支；不持久化，不保证跨进程并发。没有PostgreSQL迁移、RLS、任务/冻结/Outbox原子提交或真实扣费；不能作为可上线账本。

仓储未来必须为workspaceId提供原子revision CAS，正确实现整次变更事务和错误净化。服务只重读CAS冲突（最多20次），存储异常不自动重写；结果未知时调用方应保留原eventId核对/重放，不能新建事件猜测操作未生效。聚合全量读取暂不适合大规模流水，持久化阶段需设计有界查询及索引。

暂不包含补偿退款、积分到期/月度重置、供应商成本账本、真实定价、公开账单权限或持久化对账扫描。T09的既有依赖仍保留。规范见 [AI_CREDIT_SETTLEMENT](../../docs/contracts/AI_CREDIT_SETTLEMENT.md)。

## 验证

`node --test packages/billing/test/*.test.ts`，`pnpm --filter @novel-adaptation/billing typecheck`。测试固定积分示例不代表产品价格；授权与证据读取器使用测试夹具，不冒充生产身份/证据验证。
