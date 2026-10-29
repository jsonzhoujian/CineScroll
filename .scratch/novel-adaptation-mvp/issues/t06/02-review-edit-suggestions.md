# 02 — 审阅候选、编辑文本并处理修改建议

Parent: T06

status: ready

**Blocked by:** [01](./01-generate-script-candidate.md)

**What to build:** 用户刷新后仍能继续审阅同一候选；负责人和审核人直接编辑候选，编辑成员提交替换内容与理由，获授权者接受或拒绝。

## Acceptance criteria

- [ ] 建议及处理结果持久化，界面与 API 共同执行统一权限，越权请求不改变内容。
- [ ] 修改创建新版本并保留证据、转换类型、场次及失败项；记录操作者、时间、理由和请求身份。
- [ ] 建议处理幂等；旧版本或目标文本变化返回冲突，不覆盖他人工作。
- [ ] 追溯与审核切换保留章节、集、场次、元素和原文定位，内容版本不因切换而改变。
- [ ] 重启恢复、三角色正反例、并发冲突及浏览器操作通过。

## Context and boundaries

T04/T05 已按任务记录完成。拆集方案已有持久化、审核、后台任务、原生传输和默认关闭的受控生产装配；本轮不重复建设。正式剧本已有领域服务、模型端口、候选编辑、建议、确认、锁定和质量规则引擎。仍需持久化、服务装配、任务执行和用户操作闭环。

权威输入为产品规格第 3、7～9、12 节、领域词汇、canonical 契约及 T06 原验收条件。实现须先检查这些输入及现有服务，复用已有边界。用户于本轮确认编辑仅提交建议；负责人和审核人可直接编辑候选；正式修改派生候选重新确认，锁定先解锁。

Reuse existing domain services and canonical contracts. Include persistence, authorization, API, UI and relevant tests in this vertical slice. Follow the approved product specification, domain glossary, architecture decisions and original T06 acceptance criteria. No production rollout or real charging is authorized by ticket publication.
