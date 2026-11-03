# T07-01 — 生成并追溯文字设定候选

Parent: T07

status: done

**Blocked by:** T06 completed

## What to build

基于当前有效已确认剧本生成角色、场景、道具和全局画风文字设定。

## Acceptance criteria

- [x] 复用ConfirmedScriptHandoff冻结正式剧本、原文和上游身份；生成前后及保存事务均复验，不允许候选或旧上游生成。
- [x] 按settings.schema.json校验完整响应和逐项引用，部分失败保留成功；不把Schema样例当成生产资产。
- [x] 不可变版本、任务结果恢复、租户隔离及CAS；保存资产时同事务登记实际剧本元素依赖。
- [x] 后台任务、受控大陆原生传输、Session API、桌面明确加载和原文/剧本追溯闭环；默认关闭、无真实计费。
- [x] 公开API/Worker/仓储/浏览器回归覆盖未知结果不重发、上游变化、错误引用和权限。

## Context and boundaries

权威输入：docs/PRODUCT_SPEC.md（权限、7.4、7.5、8与MVP验收）、CONTEXT.md、docs/contracts/DOMAIN_MODEL.md、settings/storyboard canonical Schema；复用T06交付的正式读取、不可变版本、角色规则、后台任务、许可与未知执行恢复。参见docs/plans/2026-11-03-t06-final-acceptance.md。不得把历史读取当生成授权，不得重复建设已经具备的基础设施。

本票为纵向交付：按已确认公共API、Worker、仓储与浏览器测试边界验证并独立审查。用户要求每轮提供Git提交文案、不自动提交。不部署、不自动调用真实付费模型、不启用真实计费。依赖中完成的前置不应被反向重新设为阻塞。

验收：2026-11-03，见 [文字设定候选交付记录](../../../../docs/plans/2026-11-03-t07-settings-candidate-delivery.md)。四个公开边界与Standards/Spec整票复核通过；浏览器57项、Node409项通过，条件数据库跳过另计。未执行真实模型语义验收或部署。
