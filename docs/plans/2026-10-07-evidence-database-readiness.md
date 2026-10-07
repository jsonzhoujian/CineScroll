# 证据数据库只读预检

用户确认测试边界：assertEvidenceMaterialDatabase与createCheckedEvidenceMaterialRepository；隔离PG16验证健康初始化及角色/权限/RLS/结构/约束/触发器漂移，失败拒绝不自修复。

READ ONLY事务、5秒语句超时、pg_catalog路径，只读元数据与LIMIT0。检查实际登录与novel_evidence有效角色危险属性/额外成员资格、schema创建权、表/列最小权限、非owner、forced RLS单一严格scope策略、五列类型/空约束、有效主键、必要约束定义指纹、guard事件/源指纹/语言/搜索路径/执行权限。指纹绑定当前0002迁移及PG16，不抵抗恶意管理员或持续监控DDL。

受检工厂await前固定Pool.connect方法，预检成功才返回仓储；调用方管理Pool，旧低层构造器不预检。错误统一EVIDENCE_DATABASE_NOT_READY，不迁移/授权/修复、不写业务资料。TLS/生产写身份/真实性/部署装配和收费仍延期。

TEST_EVIDENCE_READINESS_DATABASE_URL仅可丢弃管理员测试库，独立或test-concurrency=1运行，测试临时漂移并恢复。TDD与全量回归/双轴审查后本地提交。
