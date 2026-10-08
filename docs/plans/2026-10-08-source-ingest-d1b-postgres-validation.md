# D1b封闭草稿的隔离PG16验证

日期：2026-10-08。用户要求继续下一步，按已确定的隔离实库路线验证草稿创建、权限及默认拒绝；新增回归测试：[evidence-source-d1b-postgres.test.ts](../../packages/billing/test/evidence-source-d1b-postgres.test.ts)。基线82b4c0d；本轮未修改SQL草稿或运行仓储。

## 环境与可重跑入口

使用本机PostgreSQL16.14，新建/private/tmp/source-d1b.pUHIrL/data，socket目录为父目录、端口56438、listen_addresses为空，host认证reject、local仅临时目录socket信任。没有读取业务数据库配置。测试在任何DDL前核验socket路径模式、实际data_directory、无TCP监听、PG主版本16及固定草稿角色不存在。

```sh
TEST_SOURCE_D1B_DATABASE_URL='postgresql://zhoujian@localhost/postgres?host=/private/tmp/source-d1b.pUHIrL&port=56438' node --test packages/billing/test/evidence-source-d1b-postgres.test.ts
```

该实例已停止，以上命令不能直接重跑；后续需创建/启动同约束的新临时实例，并替换socket/port。未设置TEST_SOURCE_D1B_DATABASE_URL时只跳过本实库测试。连接池等待上限2秒；本测试不配置生产登录、模型凭据或计费资料。

测试创建随机测试库/临时非特权login，在该库执行独立草稿；测试结束关闭连接池、删除本次测试库/login及五个草稿角色，清理失败独立汇总为断言。测试初始化的共享内存系统调用需沙箱外权限，已通过执行审批后完成。

## 已取得的执行证据

10项测试（包括父测试）全部通过：

- 草稿末尾COMMIT前注入错误，随后ROLLBACK：schema与五个集群角色均不存在；实际草稿随后可正常创建。
- 13表均ENABLE/FORCE RLS，各有两项ENABLE ALWAYS封闭触发器。
- 严格草稿再次执行因同名角色失败；回滚后原13表仍存在。
- locker能在空授权表执行FOR SHARE；撤销lock_token列UPDATE后同查询42501拒绝；恢复后最终ACL正确。locker修改enabled仍42501拒绝。
- 五角色均NOLOGIN/非super/非CREATEDB/非CREATEROLE/非BYPASSRLS/非replication；四项策略只在授权表面向locker。
- helper最终owner为locker、SECURITY DEFINER及固定search_path正确；PUBLIC无EXECUTE；locker的CREATE已撤回。helper owner拥有隐式EXECUTE，mutator/reader有显式EXECUTE，inspector无执行权；测试login不能SET ROLE为任何草稿角色。
- 临时login即使有schema USAGE，仍不能裸读/插入/删除/截断来源与授权表，不能修改许可、创建对象或直接调用helper。
- 仅为负向调用测试暂授helper EXECUTE，并在finally撤回：无principal时返回净化FORBIDDEN，伪GUC与非法kind不提供认证。
- 隔离管理员对所有13表INSERT default values以及全表TRUNCATE被D1B_STORAGE_CLOSED拒绝。
- nullable identifier、边界空白、中文、UTF16 256单位/非BMP边界及数组重复/null元素检查符合可表示文本结构规则。

测试脚手架修正两项断言：pg_policies.roles的name[]显式转text[]供驱动读取；函数owner的隐式EXECUTE计入最终权限。二者为测试读取/权限期望修正，未发现需要修改草稿的执行缺陷。

全仓回归在清空环境后仅传入该临时URL执行：344项，325通过、19项其他数据库条件跳过、0失败；全仓typecheck及git diff检查通过。此前源登记纯函数测试计入全仓，不当作实库正向写入证明。

## 明确未验证的行为

授权表未装载任何行，没有暂时关闭写保护。因此空表FOR SHARE只证明实际权限足够，不证明锁住既有行或撤权双连接竞争；无principal调用也不证明有授权时返回正确范围。lock_token同值UPDATE对真实行是否被guard拒绝、正向授权/撤权及业务资料循环引用装载仍需后续专用测试准备方案。

本轮证明封闭草稿可创建及负向权限行为，不宣称I01～I16、F01～F18、P01～P12全通过。共享登记并发、预算累计、完整业务投影/编码、成功回执、未知COMMIT恢复、历史读取和受控writer尚未实现。默认拒绝验收不能替代这些行为。

## 清理与后续

后续已实施[只读目录预检](2026-10-08-source-ingest-d1b-readiness.md)，扩展为25类目录漂移测试；这不改变本文初轮10项证据或正向授权/登记尚未交付的边界。

全仓测试后独立查询：novel_d1b_*及d1b_login_*角色数0，d1b_*测试库数0。pg_ctl停止成功，再查status为no server running。保留空临时集群目录及日志便于诊断，未执行递归删除。

Standards/Spec审查结果记入T09。下一步可实现独立D1b目录预检，拒绝结构/权限/函数漂移并保留默认关闭；正向业务装载和运行仓储各自通过后续切片完成。

双项审查均无阻断。按Spec建议调整T09新增进度与原验收标题的层级；Standards建议后续覆盖创建已提交但响应丢失时的测试准备清理。本轮清理标记只在成功响应后设置，未注入该故障；未来需在已验证隔离实例中按本次随机身份核对残留，不能据此声称测试准备具完整未知提交恢复。本轮独立目录查询确认实际没有残留角色/测试库。
