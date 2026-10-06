# 内部故事知识任务调度基础

`StoryKnowledgeTaskDispatcher.tick(workspaceId, mode, page, signal?)` 是一次有界扫描与处理，不是HTTP接口或已启动Worker。调用方须提供服务端可信工作室白名单，分别保存run/recover游标、安排周期和限速；生产尚未装配。默认关闭的内部循环见 `STORY_TASK_WORKER.md`；signal 只控制后续领取，不取消在途模型。

- `mode=run`：仅story_knowledge/queued。扫描不是抢占；逐项以持久化createdBy和workspaceId构建Actor，执行器复查项目权限、原文/参数、当前配置、订阅与区域，再使用queued→running revision CAS保证同一任务至多一个竞争者进入模型调用。
- `mode=recover`：仅过期running（含历史null租约）或paused/EXECUTION_UNCERTAIN。数据库时钟筛选与恢复CAS最终校验；不会解密Key或调用模型。未发现候选转未知暂停；后续扫到同任务持久化候选可补终态，不重发。
- 每页默认20/max50，按UTF-8/C任务ID游标排序，不代表创建时间，也不是跨页一致快照。返回nextCursor供调用方推进；到末页从null启动新一轮才能发现游标之前的新任务。状态变更不会倒退游标；两个模式独立扫，避免未知任务挤占执行页。
- 每项报告仅id、completed/raced/unavailable及完成后的state/reason；不返回模型Key、原文、候选全文或内部异常。raced表示CAS拒绝，可能是竞争，也可能是未知暂停暂未发现新候选。扫描存储故障使整次tick拒绝；单项异常仅记unavailable/继续其他项，绝不自动重试模型。

被撤权的提交人不会被替换为负责人；任务可能继续保留queued，由后续治理处理。当前权限检查不承诺管理员并发撤权的线性化。执行中原文变更、配置失效和候选竞争沿用既有执行器规则。

无定时器/后台进程启动、全局租户枚举、生产挂载、真实模型传输、计费、续租、取消或合规/投诉新门禁。10分钟固定租约过期不代表供应商取消或未收费；禁止重发未知执行。上线仍须当前政策许可、配额、可信工作室清单、运行授权和持久调度运维。

迁移script/0007新增工作室/任务ID的queued与恢复候选部分索引，只在临时数据库验证。先按顺序执行0003～0006；不自动应用业务库。

测试边界：仓储扫描/任务服务与内部tick/真实知识服务，模型为fixture。内存完整候选落库和恢复流程、临时PostgreSQL扫描/RLS/CAS分别验证，不据此宣称真实模型语义准确或完整生产Worker已运行。
