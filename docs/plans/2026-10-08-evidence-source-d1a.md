# D1a：封闭来源结构草稿与只读目录预检

用户确认：独立SQL草稿，不进入自动迁移目录、不执行；assertEvidenceSourceDatabase(pool)只读检查；模拟数据库响应测试，隔离PostgreSQL另批。不提供写仓储/真实任务/收费。

本切片只包含集合、版本、封存、成员四类基础表；业务关联、发送/关闭、隔离及登记回执留到D1b/D2。独立schema/owner/目录检查角色，表FORCE RLS且无策略；不授予数据读写，无运行写函数，阻止正常DML与TRUNCATE。此封闭结构不能处理业务事实或代表完整屏障。

预检seam固定为assertEvidenceSourceDatabase(pool)：PG16目录形状检查，角色/继承/权限、精确列/约束/索引、RLS、封闭保护函数及触发器；缺失/漂移/异常统一EVIDENCE_SOURCE_DATABASE_NOT_READY。只返回void，不返回仓储，不修复。Pool/client方法在等待前绑定，异常清理失败也不泄露错误。

实验配置：256个来源版本、1MiB清单、2MiB来源包、64份历史封存；SQL仅承载相关字段范围与单对象字节约束，累计/完整包/成员全覆盖限额仍需D1b受控事务实现，不能假称由CHECK独立完成。预检statement_timeout=5s。不设置本切片不涉及的写入锁/池/整体期限，不作生产性能承诺。

精确约束/索引的PG16目录表达式仍需隔离库执行核实；模拟响应通过只证明预检拒绝规则，不证明SQL语法、真实权限、锁序或数据库部署可用。未来变更必须同步草稿与目录期望，经实库验证后才能评估实际装配。

SQL草稿位置：[docs/sql-drafts/evidence-source-d1a.sql](../sql-drafts/evidence-source-d1a.sql)。预检仅查询目录，固定current_user=novel_source_inspector；独立登录/SET ROLE由后续隔离库测试管理员另行建立，草稿不创建登录/密码，也不映射真实业务服务。owner和inspector均NOLOGIN，无其他继承角色，数据访问完全关闭。函数均SECURITY INVOKER，不提供执行入口给运行角色/PUBLIC。

5秒是每条数据库语句时限，不涵盖连接等待/整体事务，不能当作总SLA。预检是点时检查，不能阻止检查后管理员漂移，不作持续安全证明。宿主须提供pg兼容的release(destroy?)，失败调用绑定release(true)，不得用忽略销毁参数的适配器归还未核实会话。清理异常统一拒绝；不尝试重新授权、修复或重连执行写入。

草稿限定UTF8数据库；ID首尾空白检查显式列出JavaScript trim空白集合，不自动修正输入。SQL length统计字符、v2字符串length统计UTF16代码单元，非BMP边界仍需D1b结合原协议验证器拒绝；此SQL函数仅粗粒度结构范围检查，不是完整协议/来源验证器。隔离库必须补TAB、NBSP、Unicode空白及非BMP向量，未验证前不能开放写入。

## 本轮验证

模拟入口测试9项通过，覆盖健康目录、角色/表/结构/保护拒绝、严格true、方法绑定和错误清理；多个切片先红后绿，包括原先吞掉release错误的回归。静态检查6个函数体和21个约束名称与草稿对应，仅文本一致性，不执行SQL。类型检查通过，全量327项中309通过、18项已有数据库条件测试跳过、0失败。隔离库未执行，不能算DB01～DB16验收。

Standards和Spec审查无阻断；已修正README标题位置和SQL首尾空白集合。文档链接与git diff检查通过。后续先独立批准隔离PG16运行草稿及目录故障注入验收，再决定D1b；不通过内存/模拟结果直接开放业务Writer或收费。
