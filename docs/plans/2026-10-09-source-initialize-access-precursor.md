# D1b 非BYPASS initializer 权限前置

用户“继续下一步”承接[新初始化边界及最小权限矩阵](2026-10-09-source-private-verification-complete-vectors.md#4-同事务写入待确认的新测试边界)。本轮先落地同事务写入所需的只读/核验权限前置，不跳过权限证明直接放行guard。**尚未实现initialize_source_collection、来源/集合/回执/预算共同写入、成功回执或运行装配**；只限合成数据库，无生产启用。

## 权限增量

新增隔离SQL `docs/sql-drafts/evidence-source-d1b-initialize-access.sql`：严格PG16/UTF8、socket-only、source-d1b临时目录/随机d1b库限定，安装在BEGIN/COMMIT内。新角色novel_d1b_initializer为NOLOGIN/NOINHERIT、非超级用户，无CREATE DB/ROLE、BYPASSRLS、replication、角色成员链。

| 对象 | initializer能力 | 保持封闭 |
| --- | --- | --- |
| 四类业务表 | SELECT；每表新增仅initializer的FOR SELECT RLS | FORCE RLS和全部ALWAYS guards不改；无表/列写权限 |
| 授权locker | EXECUTE既有lock_authorization | 无授权表直接SELECT、锁列UPDATE或授权编辑helper |
| 私有核验 | namespace USAGE、两函数EXECUTE | PUBLIC与普通LOGIN无执行权 |
| 纯codec | namespace USAGE、核验调用链必需7函数EXECUTE | 不授予budget_bytes（本轮无预算计算/写入） |
| 新权限namespace | USAGE、内部policy helper函数owner | namespace owner为DDL管理员codec_admin；initializer无CREATE/所有权 |
| 来源/集合/关联/回执/预算 | 无权限 | 原guard完全封闭，不修改或禁用 |

policy helper can_read_business(ws,producer)为INVОKER/固定search_path，真实身份来自既有locker的session_user映射，不用current_user或caller GUC。先锁principal→grant并确认initialize权限，再检查workspace与allowedBusinessProducerServiceIds。授权拒绝仅返回false供RLS隐藏行；未知异常净化UNAVAILABLE。非递归：授权表仍仅既有locker策略读取。主函数在业务查询前独立锁授权，RLS为额外防线；重复获取同事务共享锁不替代主函数完整核验。

SQL不创建LOGIN、不授予任何服务入口EXECUTE。初始化真正写入入口与预算增量/头锁/INSERT权限仍留后续切片，不能用该脚本当完整writer profile。

## 真实权限证明

`packages/billing/test/support/source-initialize-access.ts`用固定隔离连接创建临时普通LOGIN及两个测试wrapper；wrapper owner为非登录initializer，**不是codec_admin，不能绕过FORCE RLS**。verify wrapper只调用已批准私有seam，counts wrapper直接统计四表而不显式过滤producer，独立验证RLS：授权workspace各1行；未授权workspace四表0行；只允许other-producer的真实服务四表0行。主函数对后一服务返回NOT_FOUND，对错误workspace/撤权返回FORBIDDEN。

测试证明普通服务不能直读表、调用policy/私有helper或SET ROLE initializer；initializer没有表/列DML、schema CREATE/所有权、成员链或授权编辑能力。撤权后counts全0，私有核验拒绝；恢复后可核验。四表FORCE RLS/ALWAYS guards保持。安装末尾故障整组回滚角色、schema、ACL、策略，旧私有门禁继续健康；首轮缺SQL文件明确红，新增后绿。

测试wrapper仅隔离实验的可观测入口，不是生产/应用公开API，不返回成功回执。临时授予wrapper EXECUTE只存在测试代码，结束逐项清理连接、schema、LOGIN、策略、内部namespace、角色授权及initializer；清理失败净化为固定阶段名单。DROP OWNED只针对本次创建的initializer与本次随机库，用于撤回全部临时grant，不作用于用户库。

## 目录与剩余工作

旧业务/codec/私有目录查询和摘要均不改。访问扩展改变业务RLS及codec/私有ACL，因此旧闭合profile在扩展期间应拒绝（本轮验证私有profile拒绝），撤回扩展后恢复健康；这不是旧门禁放宽。**新完整访问配置尚未独立冻结**，不能部署或作为写入许可；下一步应先冻结包含新role属性/成员链、四策略、helper定义、所有有效ACL和default ACL的新隔离profile并加入漂移拒绝测试。

随后实现initialize_source_collection入口，才逐项授予所需预算增量/指定头锁列UPDATE及新组INSERT，并实现RLS、受控guard、来源/关联/回执成员与预算的一致性检查。按已冻结锁序和黄金预算行推进，COMMIT确认后仓储才返回成功；历史重放/并发/超额/未知提交恢复尚未闭环。ADR0008仍Proposed。

## 验证记录

实库254项通过（旧244项 + 新权限子项及父项10项），全仓382项：361通过/21数据库条件跳过，无失败；全仓类型检查通过，最后列级权限断言追加后billing类型检查复验通过。Standards静态审查无阻断（长测试函数拆分为可选判断性建议）；Spec静态审查无阻断，确认未把前置报告成writer。

临时实例 `/private/tmp/source-d1b.kiGyMC`，仅socket55439，无TCP；独立psql核对随机测试数据库0、测试角色0，实例已停止，日志/目录保留。未删除用户业务数据。
