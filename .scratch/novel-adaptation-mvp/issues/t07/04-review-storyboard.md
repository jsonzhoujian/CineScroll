# T07-04 — 审核分镜与逐集时长门禁

Parent: T07

status: blocked

**Blocked by:** T07-03

## What to build

逐镜审核确认分镜并执行时长与权限门禁。

## Acceptance criteria

- [ ] 统一编辑仅建议、负责人/审核人编辑候选与裁决，正式修改派生候选，锁定先解锁。
- [ ] 逐集总时长与目标偏差不超过10%，失败、缺项、待决建议或旧上游阻止确认。
- [ ] 资产/剧本/原文引用、正式指针、版本审计和局部重生保持一致。
- [ ] 三模式游标和确认状态一致，移动端写限制遵循既有工作台规则，浏览器和实库负向回归通过。

## Context and boundaries

权威输入：docs/PRODUCT_SPEC.md（权限、7.4、7.5、8与MVP验收）、CONTEXT.md、docs/contracts/DOMAIN_MODEL.md、settings/storyboard canonical Schema；复用T06交付的正式读取、不可变版本、角色规则、后台任务、许可与未知执行恢复。参见docs/plans/2026-11-03-t06-final-acceptance.md。不得把历史读取当生成授权，不得重复建设已经具备的基础设施。

本票为纵向交付：按已确认公共API、Worker、仓储与浏览器测试边界验证并独立审查。用户要求每轮提供Git提交文案、不自动提交。不部署、不自动调用真实付费模型、不启用真实计费。依赖中完成的前置不应被反向重新设为阻塞。
