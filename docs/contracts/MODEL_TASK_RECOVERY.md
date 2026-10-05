# 任务崩溃恢复（内部手动对账）

queued → running 时记录 10 分钟固定租约 leaseExpiresAt。PostgreSQL 使用数据库时钟，内存夹具可注入时钟。没有续租/heartbeat、自动扫描、自动调度或公开 recovery HTTP 入口；长任务超时不等于模型请求被取消，也不能证明模型未收费。

`StoryKnowledgeTaskExecutor.recover(actor, taskId)` 只读取持久化知识，不调用模型或解密 Key。通过工作室及项目权限，再按任务 ID 查找同项目/章节、parentVersionId=null 的初次提取版本，校验固定 sourceVersionId；不依赖当前活动知识头，后续审核编辑不改变原始版本。查找出现多个结果则拒绝对账，不能任选一个。索引由故事知识 0002_extraction_recovery.sql 提供。

任务仓储在单次 revision CAS 中验证租约过期并更新终态/result：匹配候选为 succeeded，保留真实 extractionStatus；无候选为 paused/EXECUTION_UNCERTAIN、result=null。该原因不允许 resubmit，不自动创建后继或重发模型。明确的管理员人工处理流程另行实现，不能把此状态当普通失败点“重试”。旧 running 无租约按未知执行处理，同样不重发。

模型在租约过期后仍可能返回并保存候选。旧 worker 的终态更新会因 revision 冲突失败；后续人工对账可将 EXECUTION_UNCERTAIN 转为 succeeded，前提是发现同任务已持久化的候选。其他暂停状态或终态不能被恢复改写；正常执行与恢复竞争，最多一个 revision 更新成功。此处不承诺网络调用撤销或阻止在途候选写入。

任务租约与候选保存仍非同事务，但对账可以补齐“候选已落库、任务终态未更新”的缺口；无候选保持未知，不据此推断模型从未运行。自动恢复扫描、当前合规/投诉门禁、计费、任务撤销、管理员裁决与生产装配仍延期。

仅在临时测试库应用 script/0005 与 story-knowledge/0002；不自动修改业务数据库。升级应按历史迁移依次执行，禁止重复执行旧的约束替换迁移覆盖新原因集合。

验证：活租约拒绝恢复；固定时钟推进后未知暂停；已有候选关联修复且模型调用次数为零；未知执行拒绝HTTP重新提交；恢复竞争只有一个成功；旧revision worker不能覆盖；PostgreSQL持久化未知原因和关联结果，并隔离非项目成员。
