# 06 — 验收 T06 用户闭环并交接 T07

Parent: T06

status: blocked

**Blocked by:** [05](./05-revise-confirmed-script.md)

**What to build:** 以固定玄幻、都市、悬疑夹具，从确认拆集到正式剧本追溯完成可重复演示，核对 T06 全部原始验收条件。

## Acceptance criteria

- [ ] 端到端覆盖生成、部分失败重试、建议处理、质量门禁、确认、锁定、修订及三模式定位一致性。
- [ ] 回归检验环境/心理描写转换、重大改编裁决、全部对白/动作出处和版本归属。
- [ ] 测试报告区分模拟传输、隔离实库及真实模型证据；缺少实库或语义质量证明的部分明确保留发布门禁。
- [ ] T07 可读取当前已确认剧本及其精确版本、场次、元素、原文引用；候选及旧上游不能作为新生成权威。
- [ ] Standards/Spec 审查与原 T06 验收逐项核对后，才更新父项完成状态。

## Context and boundaries

T04/T05 已按任务记录完成。拆集方案已有持久化、审核、后台任务、原生传输和默认关闭的受控生产装配；本轮不重复建设。正式剧本已有领域服务、模型端口、候选编辑、建议、确认、锁定和质量规则引擎。仍需持久化、服务装配、任务执行和用户操作闭环。

权威输入为产品规格第 3、7～9、12 节、领域词汇、canonical 契约及 T06 原验收条件。实现须先检查这些输入及现有服务，复用已有边界。用户于本轮确认编辑仅提交建议；负责人和审核人可直接编辑候选；正式修改派生候选重新确认，锁定先解锁。

Reuse existing domain services and canonical contracts. Include persistence, authorization, API, UI and relevant tests in this vertical slice. Follow the approved product specification, domain glossary, architecture decisions and original T06 acceptance criteria. No production rollout or real charging is authorized by ticket publication.
