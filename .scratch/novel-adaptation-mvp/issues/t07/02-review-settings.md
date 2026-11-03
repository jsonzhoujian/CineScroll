# T07-02 — 审核确认与局部重生设定

Parent: T07

status: blocked

**Blocked by:** T07-01

## What to build

审核并确认设定资产，支持锁定及局部重新生成。

## Acceptance criteria

- [ ] 负责人/审核人编辑候选、处理建议并确认；编辑成员仅建议，理由与请求身份进入不可变审计。
- [ ] 失败/未决建议阻止确认，独立正式指针；正式修改派生候选重新确认，锁定先明确解锁。
- [ ] 局部重生只修改明确未锁定目标，保留其他资产及证据；模型和存储未知结果恢复不重复付费调用。
- [ ] UI/API/实库回归覆盖单项操作、锁、并发、旧上游及受影响标记。

## Context and boundaries

权威输入：docs/PRODUCT_SPEC.md（权限、7.4、7.5、8与MVP验收）、CONTEXT.md、docs/contracts/DOMAIN_MODEL.md、settings/storyboard canonical Schema；复用T06交付的正式读取、不可变版本、角色规则、后台任务、许可与未知执行恢复。参见docs/plans/2026-11-03-t06-final-acceptance.md。不得把历史读取当生成授权，不得重复建设已经具备的基础设施。

本票为纵向交付：按已确认公共API、Worker、仓储与浏览器测试边界验证并独立审查。用户要求每轮提供Git提交文案、不自动提交。不部署、不自动调用真实付费模型、不启用真实计费。依赖中完成的前置不应被反向重新设为阻塞。
