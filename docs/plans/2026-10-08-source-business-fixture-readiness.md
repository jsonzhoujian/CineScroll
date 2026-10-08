# D1b 完整扩展目录门禁（方案 A）

用户确认：固定测试函数归属、撤回临时探针授权，再冻结完整扩展目录摘要。本切片只实现目录验收；持久化完整性读取留给下一步。

## 固定归属与边界

两个 SQL 扩展的 guard 函数改归稳定 `novel_d1b_owner`，仍为 SECURITY INVOKER，不改变检查 current_user/session_user 的写保护。管理与探针函数继续归各自 NOLOGIN 角色；不授予新所有权或成员关系。目录验收前撤回随机运行登录的探针 EXECUTE **及 schema USAGE**；这些权限的授予者/被授予者不得按白名单从摘要剔除。

新 `assertIsolatedBusinessFixtureDatabase` 位于 test/support，不通过应用 exports 暴露，不返回写入器或给生产装配许可。受限 inspector 必须满足原闭合门禁角色规则；再校验新增两角色无 LOGIN/超级用户/建库/建角色/BYPASSRLS/复制权限且不具有其他角色成员关系。仅接受随机 d1b 测试库、无 TCP 监听。实例 data_directory 的精确临时路径仍由测试管理员/装载器核验，inspector 无权读取该设置，未授予 pg_read_all_settings 或安装提权设置函数。

## 目录冻结

复用原 PG16 元数据规范查询，包含 source schema 内表/列/域/约束/索引/函数定义及所有权/ACL/触发器（含内部 FK）/策略/默认权限等；扩展 global default ACL 所属角色范围加入 auth/business fixture。基于名称和定义而非 OID；ACL 与数组使用原 C 排序。原闭合摘要 `96275bf...` 及其验收行为不改变，原函数仅导出内部 SQL 供测试工具复用角色检查。

在干净临时库仅执行三份批准 SQL 后一次捕获并写入常量：

`41fc16710899f624e3f2bf2ac4f192f23d7e8fbdb6d468c83fd9f008a05f93fb`

没有启动时学习、错误后更新摘要或自动修复权限。数据行和数据库/随机登录名称不是合法目录内容；临时登录的 schema/函数 ACL 若残留仍会造成拒绝。通过门禁只证明检查时目录与固定 profile 一致，不证明业务行完整、不阻止之后管理员 DDL、也不独立证明生产来源权威。

## 执行与错误

绑定 connect/query/release，单连接 READ ONLY 事务，statement_timeout 5s，固定 pg_catalog search_path。三项结果均须单行 ready===true；失败尝试 rollback、销毁连接，统一 `BUSINESS_FIXTURE_DATABASE_NOT_READY`，不带原始诊断。正常只读提交并释放；不查询业务表、不调用 source 自定义函数、不写授权或安装扩展。

## TDD 与实库验收

门禁在待冻结摘要时先失败，写入一次审核捕获值后通过。受限读取 data_directory 的错误确认后移除该受限查询，保留独立管理员实例路径校验，不扩大角色权限。测试过程中临时诊断已删除。

13 类漂移分别修改、拒绝两次、恢复、重新通过：新增角色 LOGIN/BYPASSRLS/成员关系，业务 UPDATE、预算 scope 列 UPDATE，两个 ALWAYS guards 停用，guard 归属/正文改变，PUBLIC/随机登录 probe EXECUTE，随机 schema USAGE，新增角色 global default ACL。扩展正常时原闭合门禁仍拒绝，管理员不能充当 inspector。业务行/预算已存在不影响目录结果。

连接边界模拟验证 query 被替换也不影响已绑定依赖，非单行严格 true 拒绝，连接异常不泄露诊断、rollback 和失败连接销毁。不声称已有提交未知恢复故障测试。

## 下一切片

按固定类型/精确版本读取四类已提交业务行，复验规范字节/指纹/完整 SQL 投影与关联，再向来源初始化提供只读材料。该读取能力本轮未实现；当前装载器也尚未强制串接 inspector 门禁，须后续独立装配。

## 完成记录

实库 59 项及连接边界三项最终专项 62 项全部通过。全仓回归 408 项、389 通过、19 项其他数据库环境跳过、0 失败；该次全仓运行在最后增加第三项连接故障用例之前，新增用例随后专项通过，不把专项新增计入全仓数量。全仓 typecheck 通过，新增用例后 billing typecheck 再次通过；diff 检查通过。

Standards / Spec 无阻断。按 Standards 建议，在复用目录模板时要求旧角色片段恰好出现一次，若模板变化立即拒绝，而非静默漏掉扩展 global default ACL；实库再次通过，固定摘要不变。原封闭目录摘要及角色检查 SQL 文本未变化。

本轮隔离库多次使用不同随机名称和登录，固定摘要均通过；尚未单独更换安装管理员登录做跨管理员实验，不声称该实验已执行。捕获脚本临时创建的固定命名合成库也已删除。独立查询本轮测试数据库与角色均为 0，实例停止成功；保留临时集群目录和日志。
