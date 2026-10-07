# 受控只读证据服务装配

用户批准公开测试边界：createServerSettlementEvidenceReader工厂及返回的read(workspaceId,evidenceId)。先验证内部授权配置，再数据库只读预检；失败不返回服务。固定serviceId，用户不能选择身份。不返回底层仓储、资料或追加入口，返回冻结的只读九字段接口。

复用InternalBillingPolicy（settle权限控制证据读取）和受检证据仓储。配置在await前复制，Pool.connect由受检工厂绑定，宿主管理Pool。不开放HTTP、不做写服务/成员认证、不迁移、不挂生产或启用收费。数据库预检不证明资料来源真实或TLS。

先红后绿验证非法配置/连接失败。隔离PG16验证读取已存测试资料、工作室越权、缺失、输出复制及启动期间配置/连接方法修改。TEST_EVIDENCE_READINESS_DATABASE_URL夹具扩展，单独或test-concurrency=1运行。全量回归与Standards/Spec审查后本地提交。
