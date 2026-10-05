# 故事知识任务入口（可选模块）

`StoryKnowledgeTaskApiModule` 使用会话认证，需注入使用 `StoryKnowledgeTaskContext` 的任务服务。尚未挂载生产；没有自动 Worker、真实 AI或计费。列表与首次创建UI分别见 CHAPTER_TASK_LIST.md、INITIAL_STORY_TASK_ENTRY.md。

- POST `/projects/:projectId/chapters/:chapterId/story-knowledge-tasks`：创建 queued 任务，201。
- GET 同路径：仅本章节故事知识任务分页列表，200；详见 CHAPTER_TASK_LIST.md。
- GET `/story-knowledge-tasks/:id`：读取已授权故事知识任务，200。
- POST `/story-knowledge-tasks/:id/resubmit`：暂停任务创建唯一后继，201；重复或输入变化为409。

两个 POST 仅接受 `configurationVersionId` 与 `modelId`，禁止客户端指定原文版本、身份、阶段或生成参数。所有响应 no-store；模型 Key 不返回。跨项目访问或错误阶段任务为404；未认证401；模型访问拒绝403；存储失败503。

Reader 显式检查项目成员权限与工作室，读取当前章节的有效原文（最多20,000字、有追溯片段）和项目时长、比例、叙事形式，生成 stage=story_knowledge、空上游确认版本。执行前重新读取并校验版本。读取不是跨仓储原子事务；最终候选写入仍须版本校验与幂等，不能自动确认或覆盖阶段成果。

原文导入已执行合规扫描，但原文版本没有持久化的当前投诉/合规状态；该 Reader 不能证明当前政策许可。正式挂载之前必须补当前合规/投诉门禁、任务配额计费、调度和崩溃恢复。旧的无 stage 任务不能直接复用，部署已有任务数据时需制定迁移策略。

验证：真实本机 HTTP 集成覆盖认证、越权、伪造参数、无Key响应、旧Key暂停与显式重提交；领域测试覆盖输入变更和并发CAS。无供应商调用。
