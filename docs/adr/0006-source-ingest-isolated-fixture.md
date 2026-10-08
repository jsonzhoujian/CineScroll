# 先以隔离测试业务记录验证来源登记，不借用ModelTask作生产证明

Status: Accepted（用户2026-10-08选择方案A，仅批准文档设计方向；字段、接口、SQL、运行时与数据库执行仍需后续确认）。

## Context

已冻结登记命令指纹，但现有ModelTask不包含固定计费单元、报价及独立执行证明。旧资料夹具只做一致性校验，自造businessRecordId不能证明真实业务记录关联。直接接线会把D1实验误称D2可信生产来源。

## Decision

先设计同一隔离实验中的独立不可变TaskRevision、FixedBillingSnapshot、ExecutionIdentity和FixedQuote测试资料；登记仓储读取精确版本和关联，构造task/snapshot来源。执行资料只绑定身份，不登记执行结论。命令和发布协议不改，生产装配保持禁用。延续ADR0004同库事务，不新增跨服务签名协议。

## Consequences

可独立检验定位、交叉关联、共同提交与恢复规则；但必须维护测试资料与未来生产业务映射的差异。实验不能证明D2真实性、关闭栅栏或收费，不能成为真实业务缺失时的回退。字段/白名单、权限、预算及SQL尚待确认。

## Alternatives

- 直接改造真实任务/报价：更接近生产，但提前扩张到D2，延期。
- 直接复用旧payload夹具：准备成本低，但无法核验独立业务行，拒绝作为持久化真实性依据。

详见[隔离测试来源设计](../plans/2026-10-08-source-ingest-fixture-design.md)、[D1b契约](../contracts/EVIDENCE_SOURCE_D1B_INGEST.md)。
