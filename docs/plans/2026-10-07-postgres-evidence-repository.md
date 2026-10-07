# 受限PostgreSQL证据仓储

用户批准测试边界：PostgresEvidenceMaterialRepository.append/get/read，隔离PG16持久化/并发重放/冲突/补证回滚/权限/RLS及投影链路。无业务库迁移、生产入口或真实计费。

独立novel_evidence NOLOGIN角色仅SELECT/INSERT，forced RLS事务本地工作室上下文，不可变触发器拒绝UPDATE/DELETE。复合主键与同工作室前序FK，INSERT守卫匹配JSON标识、前序绑定/快照/执行及禁止自引用。应用复用准备/校验函数计算规范化指纹；读取重验资料与指纹，避免SQL插入无效资料被当可信。数据库守卫不完整复刻质量规则或证明真实性。

append在await前复制验证资料，INSERT ON CONFLICT DO NOTHING后读取核对指纹/完整资料；两个连接池并发时只保存一条，异内容冲突。每次事务超时5s并固定pg_catalog路径，错误脱敏，Pool宿主管理。不自动迁移或修复。单资料最大2MB，超限拒绝而非裁掉字段。受限非owner登录/TLS/部署预检、原始结果跨记录唯一性、写服务认证、扫描/留存仍延期。

先红后绿并完成双轴审查、本地提交。TEST_EVIDENCE_DATABASE_URL仅可丢弃管理员测试库；不得与其他DDL测试并行。
