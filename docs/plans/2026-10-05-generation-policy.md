# 当前生成许可门禁 Implementation Plan

**Goal:** 项目投诉/内容限制及原文版本合规状态缺失或受限时，阻止故事知识生成和候选落库。

**Architecture:** 新增持久化项目/原文许可表，应用账号只有读权限；可信数据库管理员维护状态，不开放成员写API。任务服务注入许可Reader，缺失Reader默认拒绝story_knowledge生成，读取/对账不受生成门禁影响。执行器在模型返回后复查；PostgreSQL候选事务通过固定安全函数加SHARE锁核对许可至提交，关闭检查后状态变更竞态。

**Tech Stack:** TypeScript / 现有任务服务与知识仓储 / PostgreSQL RLS / node:test。

## 范围与测试边界

- submit/resubmit/run服务公共接口；HTTP403净化；真实模拟执行器返回后禁止保存。
- 项目状态allowed/complaint_suspended/content_blocked，原文状态allowed/pending/blocked，必须均明确allowed。
- 仓储读取及候选写入公共接口实库验证：重启读、跨租户/成员隔离、成员写权限拒绝、未提交状态更新阻塞并拒绝候选。
- 存储或状态缺失fail closed，不自动从导入扫描推断当前许可，不返回投诉详情。
- 无真实审核服务、投诉工单/管理UI、已保存结果下架、计费或生产装配；管理员SQL是当前可信维护入口。

## 步骤

1. 写任务公共接口红灯，补默认关闭的generationPolicy与POLICY_RESTRICTED状态；模拟门禁允许的旧fixture明确注入。
2. 写候选实库门禁红灯；新增story-knowledge/0003策略表与固定函数、Reader，候选事务落库前调用。
3. 模型返回后复查，映射受限为暂停；补HTTP/执行器/数据库并发测试与权限测试。
4. 全回归、类型检查、Standards/Spec审查；契约与结果同步后本地提交，不推送或生产迁移。

## 验证记录

任务许可缺失默认放行红灯与投诉未提交仍保存候选红灯均确认并修复。Spec审查发现候选提交后的复查会清空结果关联，公共服务回归先红后绿，已去掉该误分类检查；最终模型返回后与候选事务内门禁保留。Standards建议收窄search_path至pg_catalog，已采用。两轴最终无阻断。

综合临时库/内存/模拟HTTP执行链路7/7通过，其中3项实库测试覆盖权限、持久化及并发；默认完整回归146通过、9个显式数据库测试跳过。API/script/story/web类型检查通过。任务受限提示不开放重提。只在临时库执行story0003及script0008，未调用真实模型/审核、未装配生产。
