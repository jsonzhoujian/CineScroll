# 拆集任务受控服务端装配

用户已确认：默认关闭；显式开启需 BYOK、同库 TLS、可信大陆路由和工作室白名单。公开测试边界为 createProductionApi、认证 HTTP API 与 Worker 生命周期。

## 实施与验收

1. production.test.ts：验证无效 episodeTasks 配置被拒绝（先红后绿）；默认关闭生成和审核路由。
2. production.ts：挂载既有拆集任务/审核模块、受限数据库仓储、原生 DeepSeek 端口及独立 Worker 注册。两个阶段分别开关，不共享 DI 标识。
3. episode-task-database-readiness.ts：复用已有任务容量/策略/权限门禁，补拆集表强制 RLS、最小写权限、不可变/确认触发器及扫描索引检查；只读预检，不执行迁移。
4. production-tls.test.ts：可丢弃 TLS 测试库验证初始化拒绝、认证提交、模拟模型保存候选、显式审核确认、重启读取及双 Worker 关闭。
5. 全量 Node 测试、类型检查、Standards/Spec 双轴评审后本地提交，不推送。

不配置部署开关，不读取真实 Key，不发送作品；全部模型请求模拟。大陆路由标识不是供应商数据驻留证明。积分结算、生产质量评估和真实模型验证不在本轮。
