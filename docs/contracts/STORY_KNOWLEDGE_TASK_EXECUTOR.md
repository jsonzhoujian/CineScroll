# 故事知识任务执行器（初次提取）

`StoryKnowledgeTaskExecutor.run(actor, taskId)` 是内部可信入口，不暴露 HTTP run 路由，也没有自动调度。生产未装配；测试使用模拟模型。

任务服务用 CAS 抢占 queued 任务，检查输入及当前模型配置，解密凭据只传入可信 `CredentialedStoryKnowledgeModel`。执行器按固定原文版本读取片段，构造 canonical storyKnowledge 请求，复用 ExtractionRunner 校验响应结构、任务身份与原文证据。模型输出中的错误证据转为条目失败，合法条目保存为可审核候选，绝不自动确认。

首片仅支持初次提取。已有活动知识结果时不调用模型；写入使用 expectedActiveVersionId=null 的 CAS，防止并行执行覆盖候选或已确认内容。任务级 CAS 拒绝同一任务再次执行。局部重试及已有内容的明确重生成另行实现。

生成前及模型返回后重查项目权限和当前原文版本；发现变化不保存结果。版本引用对应不可变原文。recordExtraction 要求持久化仓储校验当前原文：PostgreSQL 在候选写事务中先对章节加 SHARE 行锁、比较 active_source_version_id，再执行知识头 CAS 和候选写入，锁保持至提交，关闭检查后重导入的竞态。模型调用不在事务内；人工历史知识编辑不启用此门禁。提交之后的原文更新仍需后续失效标记机制。内存仓储仅用于测试，不提供跨原文仓储的原子保证。

当前合规/投诉状态门禁仍未实现；项目权限采用数据库 RLS，不承诺与管理员并发撤权的线性化。凭据检查后的订阅变更同样不保证即时取消在途调用。

执行器通过受控 TaskExecutionError 保留原因：原文变化为 paused/UPSTREAM_CHANGED；无效响应为 failed/INVALID_RESPONSE；已有候选或竞争知识头 CAS 失败为 failed/CANDIDATE_EXISTS；未知错误为 failed/PROVIDER_UNAVAILABLE。原文持久化门禁使用内部 StoryKnowledgeSourceChangedError 区分知识头冲突，既有故事知识 API 仍返回 VERSION_CONFLICT。

成功终态携带 result={candidateVersionId, extractionStatus}，与终态同次 revision CAS 持久化；succeeded 表示候选处理与落库完成，不代表所有条目成功或质量验收通过。partially_succeeded 表示局部成功，failed 表示所有条目失败但失败候选已保存。任务状态接口返回这些字段，尚未新增前端展示。旧任务及其他未返回候选的执行器 result=null；不补造历史关联。指针只用于同一项目/章节已有鉴权读取，不是独立访问授权。

候选保存与任务终态更新不是同一事务，崩溃仍可能留下已落库候选和 running 任务；禁止自动重发可能收费的调用。租约、恢复、计费、当前合规/投诉门禁与真实模型传输均未交付。任务仓储升级需管理员先应用 0004_model_task_results.sql；本次仅在临时测试库执行，不自动升级业务库。

验证入口为任务执行服务及故事知识 getActive：覆盖部分成功候选、凭据边界、重复任务拒绝、已有候选不覆盖、错配响应拒绝、生成期间原文变化不落库。临时 PostgreSQL 测试通过未提交重导入阻塞候选写入，确认其等待提交后拒绝旧原文，并允许当前原文写入。不证明实际模型语义准确率。
