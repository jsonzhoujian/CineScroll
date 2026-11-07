# T07-03 — 生成并追溯分镜候选

Parent: T07

status: in_progress

**Prerequisite:** T07-02 completed

## What to build

从当前有效正式剧本及设定生成可审核的镜头。

## Acceptance criteria

- [ ] 冻结并复验正式剧本/设定/原文身份；不得回退候选或旧上游。
- [ ] 按storyboard.schema.json校验全部镜头字段，scene/episode/asset/scriptElement/provenance引用有效且归属正确。
- [ ] 后台任务、部分失败与精确范围恢复、持久化和依赖登记；只保存真实引用，不自动重做已有下游。
- [ ] 分镜模式明确加载与逐镜剧本/原文追溯，API/Worker/仓储/浏览器闭环通过。

## Context and boundaries

权威输入：docs/PRODUCT_SPEC.md（权限、7.4、7.5、8与MVP验收）、CONTEXT.md、docs/contracts/DOMAIN_MODEL.md、settings/storyboard canonical Schema；复用T06交付的正式读取、不可变版本、角色规则、后台任务、许可与未知执行恢复。参见docs/plans/2026-11-03-t06-final-acceptance.md。不得把历史读取当生成授权，不得重复建设已经具备的基础设施。

本票为纵向交付：按已确认公共API、Worker、仓储与浏览器测试边界验证并独立审查。用户要求每轮提供Git提交文案、不自动提交。不部署、不自动调用真实付费模型、不启用真实计费。依赖中完成的前置不应被反向重新设为阻塞。

[设定验收与交接记录](../../../../docs/plans/2026-11-05-t07-cross-upstream-acceptance.md)

## 实施进度

1. 已完成逐镜字段与引用校验，使用 canonical 样例验证合法镜头和越界引用。
2. 已完成正式上游读取与响应校验。响应绑定任务及有序版本身份，保留有效镜头并记录失败范围。新增依据仅接受正式剧本已引用的获批新增。
3. 接通 Worker、事务保存及原请求恢复，原子登记依赖。
4. 接通 Session API 与浏览器显式载入，验证逐镜剧本和原文追溯。

执行器切片已完成。已验证上游过期时拒绝启动、模型返回期间上游变化时拒绝保存，以及复用已保存的原任务结果。事务仓储与生产 Worker 接入仍属于第 3 步。
