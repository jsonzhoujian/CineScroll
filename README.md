# AI 小说动态漫改编工作台

将用户已有的小说或故事，转化为可编辑、可追溯、可继续制作 AI 动态漫的剧本、设定与分镜。

当前已进入实现阶段：T04 项目与章节导入、T05 故事知识已按任务记录完成；主线为 T06 拆集、剧本与原文追溯。拆集已有受控装配，正式剧本闭环仍在推进，完整 MVP 尚未验收。

T09 已有独立基础设施增量，整体验收仍受 T07 阻塞；隔离测试不代表生产计费已启用。2026-10-29 核对依据为任务记录和代码入口，未重新执行功能验收。

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
