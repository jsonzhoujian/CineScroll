# 03 — 仅重试剧本失败范围

Parent: T06

status: ready

**Blocked by:** [01](./01-generate-script-candidate.md)

**What to build:** 用户选择可重试失败项重新生成，成功元素继续保留，界面明确本次成功与剩余失败范围。

## Acceptance criteria

- [ ] 服务端限制 scope 为当前可重试失败项；冻结有效上下文，不夹带成功、确认或锁定条目。
- [ ] 重试结果原子合并且记录版本与任务来源；过时结果不能覆盖新版本。
- [ ] 重放、未知提交与恢复不会重复生成或写入；不将技术失败直接当作积分退款证据。
- [ ] 部分成功、非重试项拒绝、并发编辑冲突、刷新恢复通过。

## Context and boundaries

T04/T05 已按任务记录完成。拆集方案已有持久化、审核、后台任务、原生传输和默认关闭的受控生产装配；本轮不重复建设。正式剧本已有领域服务、模型端口、候选编辑、建议、确认、锁定和质量规则引擎。仍需持久化、服务装配、任务执行和用户操作闭环。

权威输入为产品规格第 3、7～9、12 节、领域词汇、canonical 契约及 T06 原验收条件。实现须先检查这些输入及现有服务，复用已有边界。用户于本轮确认编辑仅提交建议；负责人和审核人可直接编辑候选；正式修改派生候选重新确认，锁定先解锁。

Reuse existing domain services and canonical contracts. Include persistence, authorization, API, UI and relevant tests in this vertical slice. Follow the approved product specification, domain glossary, architecture decisions and original T06 acceptance criteria. No production rollout or real charging is authorized by ticket publication.
