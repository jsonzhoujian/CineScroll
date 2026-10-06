# 拆集方案持久化与审核 API

可选 `EpisodePlanApiModule.register({sessionVerifier,script,projects,knowledge})` 提供：

- GET `/projects/:projectId/chapters/:chapterId/episode-plan`：活动方案、当前性、审核权限、精确原文片段及已接受事件。
- GET 同路径 `/versions/:versionId`：精确版本及证据；非活动版本不可裁决或确认。
- POST 同路径 `/proposals/:proposalId/decision`：仅 expectedActiveVersionId、decision(approved/rejected)、reason(1～2000字)。
- POST 同路径 `/confirm`：仅 expectedActiveVersionId。

全部使用会话和项目成员鉴权；跨项目及不存在统一404；无会话401；编辑裁决/确认403；未确认当前故事知识、版本/上游冲突、重大改编未决409；非法输入400；存储异常脱敏503。响应 no-store，不提供客户端写入 AI 候选的接口。

方案必须引用当前原文及已确认故事知识版本；EpisodePlanUpstreamReader 仅返回匹配当前原文的已确认知识及片段。领域裁决/确认再次复核上游。候选读取允许历史只读，不把前端权限当作写入授权。每次决定和确认产生新版本并记录操作者/时间，现有幂等键保证原样重放；旧候选不可覆盖活动版本。

迁移 `packages/script/migrations/0010_episode_plans.sql` 建立版本、活动头及操作结果三表，复合外键、索引、不可变版本/操作记录、强制RLS。novel_app只有必要读/写权限，编辑不能插入正式版本或设置正式头。仓储写入事务按章节 SHARE → 知识头 SHARE → 拆集头 UPDATE 顺序锁定；核对当前原文及已确认知识、活动版本CAS，版本/头/操作结果原子提交。业务数据库迁移必须由管理员另行执行。

审核页在故事知识确认后出现，用户明确读取候选。单集时长、集标题、选中集的原文范围及核心事件可查看；重大改编逐项批准或拒绝，全部裁决后由负责人/审核人明确确认。空结果不展示虚构方案，过期及编辑用户只读。拆集确认不等于剧本正文已生成，不解锁设定或分镜。

生成继续复用已有可信 EpisodePlanRunner；本轮不新增拆集模型/后台生成任务、生产模块装配、质量计费或改编新增流程。验证使用模拟模型/HTTP和专用临时PostgreSQL，不调用真实AI，不迁移业务数据库。
