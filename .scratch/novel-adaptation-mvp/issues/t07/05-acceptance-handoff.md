# T07-05 — 验收T07并交接T08/T09

Parent: T07

status: blocked

**Blocked by:** T07-04

## What to build

逐项核对父票规格，交接版本协作和异步任务整体验收。

## Acceptance criteria

- [ ] 固定玄幻/都市/悬疑样本复现正式剧本到设定和分镜完整链，含失败恢复、建议、锁和上游影响。
- [ ] 逐项核对原T07字段、时长、三模式及追溯条件，区分模拟、隔离实库与真实语义证据。
- [ ] Standards/Spec独立审查无阻断后才关闭父票；真实语义和生产发布门禁独立保留。
- [ ] 交接精确正式版本及依赖关系给T08/T09；T09基础设施进度不等于整体验收完成。

## Context and boundaries

权威输入：docs/PRODUCT_SPEC.md（权限、7.4、7.5、8与MVP验收）、CONTEXT.md、docs/contracts/DOMAIN_MODEL.md、settings/storyboard canonical Schema；复用T06交付的正式读取、不可变版本、角色规则、后台任务、许可与未知执行恢复。参见docs/plans/2026-11-03-t06-final-acceptance.md。不得把历史读取当生成授权，不得重复建设已经具备的基础设施。

本票为纵向交付：按已确认公共API、Worker、仓储与浏览器测试边界验证并独立审查。用户要求每轮提供Git提交文案、不自动提交。不部署、不自动调用真实付费模型、不启用真实计费。依赖中完成的前置不应被反向重新设为阻塞。
