# D1b 私有核验独立验收

用户批准两个测试边界：`assertIsolatedPrivateVerificationDatabase(pool)` 与私有 `verify_initialize_business`。承接[业务核验清单](2026-10-09-source-private-verification.md)。本切片仅隔离测试，不新增生产角色、GRANT、RLS、初始化writer或运行导出。

## 独立目录配置

新门禁位于 `packages/billing/test/support/source-private-readiness.ts`，复用既有纯目录投影的字段规范，替换目标namespace，**不修改原业务/codec目录摘要和查询**。固定私有摘要：`1cd45fa2d0f30621cbc8a9cd5bc3fb8edbc32095b3ef5d8e83fc833d9ebfa536`；完整无OID资料在[静态目录文件](../fixtures/source-private-verification-catalog-v1.json)。首次资料来自新安装目录的离线采集及静态审核，不是人工独立推导；日后不运行时学习，也不接受caller expected hash。

同连接REPEATABLE READ READ ONLY检查既有受限inspector角色/有效权限，再检查随机d1b库名、无TCP、私有schema不可CREATE、两种身份不可EXECUTE及固定目录。覆盖schema ACL/owner、完整函数定义摘要、函数属性、codec_admin/codec_inspector角色属性/成员链/default ACL（含空header）/角色设置及额外对象。未知结果、空/多行、查询异常均回滚、销毁连接、净化为PRIVATE_VERIFY_DATABASE_NOT_READY。独立门禁不代替旧业务+codec组合门禁，更不证明二者与该门禁共享同一事务或DDL锁。临时目录路径由实库测试入口/管理员profile确认，门禁不读取受限的data_directory设置。

## 实库语义与权限边界

复用既有PG16无TCP、独立随机数据库和四类已存业务；安装SQL原稿无改动，运行结束删除随机数据库和测试角色。verify仍SECURITY INVOKER，owner为实验DDL管理员codec_admin。普通LOGIN直接调用被拒绝。

为测试真实session_user授权以及主函数完整读取语义，使用单独 `private_verify_test` schema 的临时SECURITY DEFINER wrapper（owner为实验管理员，仅测试LOGIN有EXECUTE）。它明确绕过业务RLS，是测试夹具，**不证明生产owner/RLS权限正确**；无应用导出，结束删除。损坏用例由管理员同事务临时关闭guard，修改已存行，再切换session authorization调用wrapper；ROLLBACK恢复原数据/guard。不是通过外部row JSON冒充已存资料。

已验证两内部payload与既有离线黄金字节/摘要一致、不输出回执或第三来源；escape/hex展示一致；四类记录分别覆盖非规范字节+自报匹配摘要、微秒时间、SQL binding投影损坏、隐藏producer；覆盖专属price/snapshot/rule投影、非法command、精确版本缺失、跨unit/workspace、规则/服务断言、撤权拒绝与恢复。两连接验证主函数返回后授权共享锁仍阻止撤权直至外层事务结束。8类私有目录漂移逐一拒绝并显式恢复。

尚未穷举B01～B12：每个SQL列/每条双向引用同步损坏document和canonical、byok正例、完整容量/Unicode/NULL边界仍需追加。纯codec已有边界测试不能代替主函数端到端覆盖。既有历史重放、预算/来源/回执共同写入、受限初始化owner与生产RLS、跨schema统一事务验收仍未实施，ADR0008仍Proposed。

## 验证记录

门禁单元从模块缺失红到绿；固定摘要未冻结时实库门禁拒绝，离线冻结后健康通过；合法字节比较改用已有固定黄金向量，不自行重算期望。实库111项通过（含既有组合/业务回归），私有子项及父项增量44项。另加四个document/规范字节/SQL投影全部同步更新的自洽行向量：跨行binding冲突、报价reserved冲突、execution反向snapshot冲突、snapshot指向quote版本缺失。B08～B10获得部分端到端覆盖，仍不宣称逐关联穷举。门禁单元2项通过；全仓结果与审查见收尾。

全仓379项：358通过、21数据库条件跳过、无失败；类型检查通过。Standards发现逐项清理风险，已修复为所有清理步骤分别尝试、固定阶段汇总；测试wrapper安装事务化并仅删除本次创建对象。共享旧目录投影是明确依赖，改动时需分别复核旧/新指纹。Spec指出单列损坏不能代替跨行证明，已追加上述四个自洽向量并明确余下覆盖。Standards复审无残留阻断；Spec复审无残留阻断。

实例 `/private/tmp/source-d1b.YIRgEw`，仅socket端口55439。独立psql连接核对随机d1b数据库0、novel_d1b/codec_inspector/private_verify_test_login角色0；实例已停止，目录和日志保留。未删除用户业务数据。
