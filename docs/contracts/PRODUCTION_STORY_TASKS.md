# 默认关闭的故事知识任务装配

`createProductionApi` 的 `storyTasks` 省略或 `{enabled:false}` 时不挂任务路由、不启动Worker。显式启用需BYOK开启、DeepSeek大陆授权、1～100个去重工作室ID，intervalMs可选100～60000。模型连接必须与业务连接指向同一主机/端口/数据库并使用同一TLS CA；允许不同登录账户，任务使用既有novel_app受限模型连接，不能用业务池权限执行。

装配任务API、PostgresModelTaskRepository、PostgresGenerationPolicyReader、真实执行器/DeepSeek传输及生命周期模块。所有任务均以原始提交人重新鉴权，当前政策缺失默认拒绝。仅当前DeepSeek大陆凭据可生成，其他BYOK厂商尚未接入此任务适配器；白名单是Worker扫描范围，不改变项目成员鉴权。未配置白名单的工作室任务不会被扫描，不应向其开放本功能。

onModuleInit在任何Worker bootstrap之前检查受限登录（复用BYOK门禁）、12项表的读取/写入最低权限与RLS/非所有者、任务列级更新、政策只读、状态/容量触发器启用、关键函数所有权不可被应用登录触达及执行身份/固定search_path、分页索引及政策原因迁移、租约/结果字段、每个白名单正数配额。projects/project_members保留既有非FORCE权限函数设计，其余要求FORCE RLS。缺失返回稳定STORY_TASK_DATABASE_NOT_READY；不执行迁移、不补政策或配额。检查是启动快照，后续管理员变化仍依赖运行时门禁，不证明任意被篡改的数据库函数或政策都安全。

可信宿主可注入第二参数modelFetch，用于模型目录探测和生成传输的外部端口；不由用户输入提供，测试仅模拟HTTP。默认使用native fetch，线上显式启用可能调用付费模型，需独立运行授权与合同/驻留确认。不得把mainland配置当成实际驻留证据。

`close()`幂等，先stop等待在途任务，finally释放业务/模型池；宿主需先停止接收HTTP并await app.close，再await production.close，初始化失败也应finally清理。Nest关闭钩子不自动关闭池，进程信号需宿主开启shutdown hooks。不要在close后重新初始化同一实例。测试特意先production.close验证在途模型仍能写结果，再用新实例读取；无自动重发/确认。

临时TLS库验证包含：无配额、禁用容量触发器阻止启动；受限登录提交、模拟HTTP生成、共享Key认证头、关闭等待、重复清理、重启读取持久候选指针。未运行线上数据库迁移、真实供应商或部署，未宣称生产可直接上线；管理员仍需按现有顺序执行项目/身份/知识/模型/限流迁移并提供明确政策和工作室配额。
