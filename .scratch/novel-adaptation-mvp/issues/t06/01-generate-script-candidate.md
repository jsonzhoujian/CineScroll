# 01 — 从确认拆集生成并追溯首份剧本候选

Parent: T06

status: ready

**Blocked by:** None (T05 and existing episode-plan foundation completed)

**What to build:** 用户在确认当前拆集后提交剧本生成任务，离开页面后仍可查看状态，显式加载持久化候选并点击对白或动作查看原文依据。

## Acceptance criteria

- [ ] 服务端绑定当前原文、已确认故事知识、已确认拆集及生成参数，拒绝旧上游与未批准重大改编；不接受客户端伪造上下文。
- [ ] 通过既有任务基础和受控供应商边界执行；请求幂等，未知执行先恢复核对、不再次付费调用；断线或重启不丢失候选及任务结果关联。
- [ ] 场次和元素持久化为不可变候选；成功项和失败 scope 分开保留，显示部分成功状态。
- [ ] 显式加载校验结果归属及当前上游；对白、动作有有效原文引用或批准的改编新增，转换类型可查看。
- [ ] 跨租户隔离、并发提交、上游变化、重启恢复和浏览器演示通过；真实模型调用及生产启用仍由独立发布门禁控制。

## Context and boundaries

T04/T05 已按任务记录完成。拆集方案已有持久化、审核、后台任务、原生传输和默认关闭的受控生产装配；本轮不重复建设。正式剧本已有领域服务、模型端口、候选编辑、建议、确认、锁定和质量规则引擎。仍需持久化、服务装配、任务执行和用户操作闭环。

权威输入为产品规格第 3、7～9、12 节、领域词汇、canonical 契约及 T06 原验收条件。实现须先检查这些输入及现有服务，复用已有边界。用户于本轮确认编辑仅提交建议；负责人和审核人可直接编辑候选；正式修改派生候选重新确认，锁定先解锁。

Reuse existing domain services and canonical contracts. Include persistence, authorization, API, UI and relevant tests in this vertical slice. Follow the approved product specification, domain glossary, architecture decisions and original T06 acceptance criteria. No production rollout or real charging is authorized by ticket publication.
