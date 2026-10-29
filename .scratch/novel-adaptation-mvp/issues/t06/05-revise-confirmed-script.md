# 05 — 修改正式剧本并显示影响范围

Parent: T06

status: blocked

**Blocked by:** [04](./04-quality-confirm-lock.md)

**What to build:** 成员针对正式剧本提交建议，负责人或审核人处理后生成修订候选；旧正式版本继续可读，新候选重新评估确认后替代正式指针。

## Acceptance criteria

- [ ] 已锁定目标必须先明确解锁；直接覆盖正式快照、跨版本建议误用被拒绝。
- [ ] 建议获批派生候选且保留正式来源、建议及操作记录；拒绝建议仅记录决定。
- [ ] 新候选未确认前不成为下游生成依据；重新确认复用 04 门禁。
- [ ] 返回可消费的变更与受影响项记录；已有下游标记受影响且不自动重做。T08 负责跨阶段完整处置界面与统一影响分析，不将其反向设为此票阻塞。
- [ ] 历史读取、并发修订、确认指针与受影响范围用例通过。

## Context and boundaries

T04/T05 已按任务记录完成。拆集方案已有持久化、审核、后台任务、原生传输和默认关闭的受控生产装配；本轮不重复建设。正式剧本已有领域服务、模型端口、候选编辑、建议、确认、锁定和质量规则引擎。仍需持久化、服务装配、任务执行和用户操作闭环。

权威输入为产品规格第 3、7～9、12 节、领域词汇、canonical 契约及 T06 原验收条件。实现须先检查这些输入及现有服务，复用已有边界。用户于本轮确认编辑仅提交建议；负责人和审核人可直接编辑候选；正式修改派生候选重新确认，锁定先解锁。

Reuse existing domain services and canonical contracts. Include persistence, authorization, API, UI and relevant tests in this vertical slice. Follow the approved product specification, domain glossary, architecture decisions and original T06 acceptance criteria. No production rollout or real charging is authorized by ticket publication.
