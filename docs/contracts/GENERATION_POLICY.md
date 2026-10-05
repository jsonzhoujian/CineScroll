# 当前合规与投诉生成门禁

后续事务内许可变更审计已补，见 GENERATION_POLICY_AUDIT.md；下文早期未审计说明为历史切片，管理员UI/工单及真实审核服务仍未接入。

故事知识生成必须同时具备当前项目许可与固定原文版本许可；导入时通过扫描不自动等于当前许可。

`project_generation_policy` 保存allowed/complaint_suspended/content_blocked；`source_generation_policy` 按项目、章节、原文版本保存allowed/pending/blocked。任一记录缺失、非allowed或读取故障均禁止生成。迁移不回填历史作品为allowed，也不让新导入默认放行。

当前可信维护入口是独立数据库管理员SQL，不是工作室负责人或成员API。管理员根据审核/授权依据显式写入或更新状态及updated_at；novel_app仅SELECT和固定许可检查函数EXECUTE，无INSERT/UPDATE/DELETE，RLS隔离工作室及项目成员。管理工单、申诉、管理员UI、许可变更审计和供应商审核回写仍需后续接入，禁止把此基础宣布为完整投诉处理系统。

## 生成与读取边界

- ModelTaskService为story_knowledge任务注入generationPolicy；缺失默认拒绝，脚本阶段许可另行接入，不能认为已覆盖所有生成阶段。
- submit/resubmit先核对项目/原文，再查当前许可；拒绝HTTP403/POLICY_RESTRICTED，不查询或暴露投诉详情。
- run抢占后、解密/模型调用前检查；被限制转paused/POLICY_RESTRICTED。模型返回后执行器再次检查，受限响应不送入候选保存。
- 读取列表/状态及内部结果对账不因生成限制关闭，仍受原有项目成员鉴权；本片不撤销已保存候选或限制历史下载/分享。
- 限制状态不自动重试；人工恢复许可后可通过服务显式重提交，现有UI不对该暂停原因开放重提交按钮。

## 落库原子性与部署要求

PostgresStoryKnowledgeRepository在requireCurrentSource候选事务内先锁定当前章节，再调用generation_allowed_locked对项目/固定原文许可行加SHARE锁，保持至头CAS和版本提交。管理员先更新限制未提交时，候选等待、读取提交后状态并拒绝；候选先持锁时，管理员等待候选提交。保证以候选事务提交为顺序点，不承诺已开始的模型调用取消/退款或对提交后限制自动下架。

固定函数SECURITY DEFINER，只执行参数化的读/锁，并显式校验可信会话工作室及can_access_project；schema固定，PUBLIC无执行权。函数须由受信任迁移角色持有并具备RLS绕过能力，绝不能由应用账号拥有。实际部署前须验证函数所有者、TLS、迁移权限及管理审计，当前未生产装配。内存夹具只证明返回后检查，不提供跨仓储事务保证。

story-knowledge/0003新增许可表与函数，script/0008允许暂停原因POLICY_RESTRICTED。按历史迁移顺序升级；禁止重新应用旧0005覆盖新原因约束。只应用临时数据库，未修改业务数据库。

验证：任务公共接口缺失Reader/受限拒绝、HTTP403、受限仍可读、执行前不调用模型、返回后不保存；实库Reader重新创建后可读、源pending/blocked与投诉/content限制、跨工作室/成员隔离、应用账号写拒绝、未提交投诉限制阻塞候选、新原文许可缺失拒绝及任务原因持久化。
