# D1b 隔离授权资料准备与撤权验证

本切片承接封闭目录预检，只实现测试用授权资料，不接生产装配、业务四类资料、登记仓储或计费。

## 边界与入口

独立 SQL `docs/sql-drafts/evidence-source-d1b-auth-fixture.sql` 仅在 PG16/UTF8、socket-only、`/private/tmp/source-d1b.XXXXXX/data` 的临时实例中由可信超级管理员应用。不是应用迁移；实例路径检查防误用，不防恶意管理员。

新建 NOLOGIN、非超级用户、无 BYPASSRLS 的授权 fixture 角色。只有两个授权表新增定向 RLS 和 SELECT/INSERT、enabled/revision 列 UPDATE。不授予 DELETE/TRUNCATE、表所有权或持久 schema CREATE。其他十一表保持封闭；两个授权表以 ALWAYS 限定触发器替换原 row guard，TRUNCATE guard 不变。

- `prepare_test_access`：管理员准备普通无成员关系的 LOGIN 与 service/workspace 固定映射；锁顺序 principal → grant；相同参数幂等，不恢复已撤销权限；映射或范围变化拒绝。
- `set_test_grant_enabled`：管理员按预期 revision 切换 workspace 授权；principal FOR SHARE → grant FOR UPDATE；同状态不递增，过期 revision 拒绝，不删除稳定行。
- `probe_test_access`：测试专用 SECURITY DEFINER 包装，只调用既有 lock_authorization，保留 session_user，锁留在调用者事务中。测试管理员仅向指定登录授权探针 EXECUTE，不开放管理函数。

管理函数既检查 session_user 超级管理员，也不向 PUBLIC 或普通登录授权执行。此处没有 principal 撤权管理、授权范围更新或生产管理 API，后续不得宣称这些功能已完成。

## 验证

首轮先运行新用例，因 SQL 不存在而失败，再实现入口。真实 PG 覆盖准备幂等、service 映射冲突、非法 kind、workspace/kind 隔离、receipt producer 范围、普通登录管理拒绝、fixture 角色不可切换、locker 对真实行 lock_token 同值 UPDATE 拒绝。

双连接以 `pg_blocking_pids` 确认真实行等待，而非仅依赖延时：先探针读锁则撤权等待读事务提交；先撤权未提交则新读取等待并在撤权提交后拒绝。检查过期 revision、同状态幂等及重复准备不会复活授权。

扩展故意改变目录。原封闭预检在扩展后仍拒绝，原 SQL、冻结摘要与预检实现不放宽。只在临时实例创建合成授权；测试结束删除随机测试库和测试角色，停止实例。

## 下一切片

实现四类不可变业务资料的受控装载与一致性校验，再推进登记写入；不把本测试入口作为生产授权管理使用。

## 实施结果

专项 39 项全部通过；全仓回归 378 项，359 通过、19 项其他数据库环境跳过、0 失败；全仓 typecheck 通过。双项审查中 Spec 无阻断并建议补充范围冲突用例，已补；Standards 发现 inspector 生命周期导致假阳性及并发失败清理顺序问题，已重建真实受限连接并验证 current_user，增加连接级超时、先释放管理事务且分别销毁连接，专项复验通过。

临时实例独立查询随机测试数据库和角色数量均为 0，实例已停止；保留临时集群目录及日志。原封闭 SQL、摘要和公开预检实现未改动。
