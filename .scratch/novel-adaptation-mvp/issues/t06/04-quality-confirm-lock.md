# 04 — 查看质量报告并确认、锁定剧本

Parent: T06

status: blocked

**Blocked by:** [02](./02-review-edit-suggestions.md), [03](./03-retry-failed-scopes.md)

**What to build:** 负责人和审核人查看绑定精确候选的质量报告，处理阻断后明确确认正式版本，可锁定元素，刷新后状态一致。

## Acceptance criteria

- [ ] 装配已有质量评估规则和受控语义适配，报告持久化并绑定上游、候选及规则版本；模型失败、未知或不完整报告阻止确认。
- [ ] 核心事件覆盖率至少 90%，无未经批准的核心事实变更，各集估算时长偏差不超过 10%；失败项和待处理建议阻止确认。
- [ ] 确认使用事务与版本检查，记录不可变审计；旧报告、上游变化及并发变更不能确认当前版本。
- [ ] 编辑成员不能确认或锁定；锁定保持正式版本及证据可读，重复操作幂等。
- [ ] 三类合成固定样本、阈值边界和浏览器闭环通过；合成测试不宣称真实模型语义准确率已验证。

## Context and boundaries

T04/T05 已按任务记录完成。拆集方案已有持久化、审核、后台任务、原生传输和默认关闭的受控生产装配；本轮不重复建设。正式剧本已有领域服务、模型端口、候选编辑、建议、确认、锁定和质量规则引擎。仍需持久化、服务装配、任务执行和用户操作闭环。

权威输入为产品规格第 3、7～9、12 节、领域词汇、canonical 契约及 T06 原验收条件。实现须先检查这些输入及现有服务，复用已有边界。用户于本轮确认编辑仅提交建议；负责人和审核人可直接编辑候选；正式修改派生候选重新确认，锁定先解锁。

Reuse existing domain services and canonical contracts. Include persistence, authorization, API, UI and relevant tests in this vertical slice. Follow the approved product specification, domain glossary, architecture decisions and original T06 acceptance criteria. No production rollout or real charging is authorized by ticket publication.
