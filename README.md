# AI 小说动态漫改编工作台

将用户已有的小说或故事，转化为可编辑、可追溯、可继续制作 AI 动态漫的剧本、设定与分镜。

跨上游设定处理的[规则与四项任务拆分](./docs/plans/2026-11-04-t07-upstream-settings-decisions.md)已确认并发布；T07-02a 同源核对、T07-02b 跨源依据迁移和人工修订、T07-02c 待核对目标局部重生均已完成，T07-02d 已记录跨上游验收缺口，跨上游原请求恢复和原版本影响对照已接通，不可重试失败范围逐项人工裁决已接通，重导入后已可生成并确认新源故事知识，下一步接通新源拆集，详见[任务总表](./.scratch/novel-adaptation-mvp/issues/README.md)。

当前已进入实现阶段：T04 项目与章节导入、T05 故事知识、T06 拆集与剧本闭环已按任务记录完成。当前主线为 T07 设定与分镜；T07-01 已完成文字设定候选生成、显式加载及原文／正式剧本追溯，见[交付验收](./docs/plans/2026-11-03-t07-settings-candidate-delivery.md)。当前推进 T07-02：设定审核核心与数据库事务仓储已实现，审核 Session API 与浏览器单项操作已接通，局部重生核心、任务快照、未知结果恢复及结果事务仓储已实现，生产原生传输与独立Worker已接通，局部重生Session API与浏览器闭环已接通，上游影响只读展示及独立复核已补齐，同源与跨源的分批处理已接通。T07-02 整体验收暂缓，分镜生成继续等待验收结论。见[跨上游验收记录](./docs/plans/2026-11-05-t07-cross-upstream-acceptance.md)。真实模型语义发布门禁保留，完整 MVP 尚未验收。

T09 已有独立基础设施增量，整体验收仍受 T07 阻塞；隔离测试不代表生产计费已启用。2026-10-29 的全局核对依据为任务记录和代码入口；2026-11-02 的 T06-04 实现与回归见[质量确认交付记录](./docs/plans/2026-11-02-script-publication-delivery.md)。

## 当前范围

- 导入已有小说或故事
- 解析章节、人物、场景、道具、事件与世界规则
- 建立可追溯的故事知识库
- 生成并编辑影视剧本
- 建立角色、场景、道具和全局画风设定
- 生成结构化分镜
- 导出剧本、分镜和素材包

## 明确不做

- 从零生成小说或续写网文
- 小说发布与连载
- 首版自动生成完整长片
- 首版生成图片或视频
- 首版自建图片或视频基础模型

## 项目文档

- [领域词汇](./CONTEXT.md)
- [项目章程](./docs/PROJECT_CHARTER.md)
- [需求草案](./docs/REQUIREMENTS.md)
- [产品规格书](./docs/PRODUCT_SPEC.md)
- [需求思维导图](./docs/REQUIREMENTS_MINDMAP.md)
- [系统架构设计](./docs/architecture/SYSTEM_DESIGN.md)
- [架构决策记录](./docs/adr/README.md)
- [测试策略](./docs/architecture/TEST_STRATEGY.md)
- [MVP 交付计划](./docs/plans/2026-09-21-mvp-delivery.md)
- [本地任务清单](./.scratch/novel-adaptation-mvp/issues/README.md)
- [行业工作流与痛点证据](./docs/research/INDUSTRY_WORKFLOW_PAIN_POINTS.md)
- [内部探索测试与测试需求](./docs/research/INTERNAL_EXPLORATORY_TEST.md)
- [待决策事项](./docs/OPEN_QUESTIONS.md)
