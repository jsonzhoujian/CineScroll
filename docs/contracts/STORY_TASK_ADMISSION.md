# 故事知识任务提交门禁

任务服务的 storyAdmission 是服务端工作室/厂商快照，不接收用户声明。story_knowledge 未提供策略默认关闭；submit/resubmit 在项目鉴权、生成许可及当前模型配置检查后，写仓储前检查准入。工作室缺失返回 WORKSPACE_TASK_DISABLED（403），厂商未支持返回 TASK_PROVIDER_UNSUPPORTED（400），不生成任务ID或写排队记录。生产与Worker使用同一白名单，当前支持DeepSeek。script阶段保持原规则。

GET projects/:projectId/chapters/:chapterId/story-knowledge-tasks/availability 必须登录、通过章节项目鉴权，query只接受configurationVersionId/modelId。返回{available,reason}，不返回全部工作室或厂商白名单，Cache-Control:no-store。仅回答当前工作室/当前已测试模型的准入情况，不承诺政策、权限、配额或上游在提交时仍有效；写接口仍执行最终检查。无权访问统一返回TASK_NOT_FOUND，不透露功能开启状态。

get/list/recover不因准入策略关闭而禁止，仍遵守原项目/工作室权限；历史任务不删除、不自动取消，也不新增恢复或重发机制。旧配置的queued任务沿用既有执行器约束；本门禁针对新提交与显式重提交。

前端首次创建和重提交共享选择相关的可用性查询，未选择、正在查询、失败、关闭或不支持时禁用按钮并显示稳定原因。请求切换时清理旧响应，查询结果绑定project/chapter/config/model，不把晚到旧选择的结果用于新选择。UI不是授权边界；服务端拒绝后提示对应原因。保留查看任务与候选入口，移动端仍仅查看。

验证使用真实任务服务/鉴权API与模拟浏览器API；覆盖关闭/不支持不写新任务、重提交拒绝、历史读取、无Session/无项目权限、前端禁用及可用时正常提交。未调用真实模型，不提升数据库权限、不修改迁移。
