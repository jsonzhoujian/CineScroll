# D1b隔离SQL草稿交付与实施记录

日期：2026-10-08。用户确认按既有锁序、受控锁定helper和实验容量编写独立SQL草稿；本轮只保存文件与静态审查，不在任何数据库执行。文件：[evidence-source-d1b.sql](../sql-drafts/evidence-source-d1b.sql)。

后续增量：[隔离PG16.14执行记录](2026-10-08-source-ingest-d1b-postgres-validation.md)已验证原样创建、失败回滚和负向权限，共10项通过。该增量未装载授权行或业务资料，正向锁/撤权/登记仍未完成；下文保留草稿交付时的静态状态。

## 实施步骤与范围

1. 在docs/sql-drafts/evidence-source-d1b.sql编写独立PG16/UTF8结构，严格新建，不覆盖同名对象；D1a文件保持不变。
2. 固定四类业务表、collection/source、类型关联、共享ingest回执/成员、workspace预算及身份许可表的键与范围。
3. 实现内部lock_authorization(workspace,operation,kind)：session_user固定映射、principal→grant共享行锁、操作/kind核验、范围快照；不提交事务。
4. 配置NOLOGIN职责、默认拒绝RLS、封闭写触发器和内部helper最小权限，检查共享锁权限不能修改授权。
5. 进行静态检查及Standards/Spec审查，记录未验证项，本地提交。未运行SQL的静态结果不能替代未来实库验收。

以上为本次已授权草稿实施路径。writing-plans用于明确文件和检查顺序；现有工作区干净，沿用当前目录，不额外创建worktree或要求重复授权。

## 草稿包含什么

13张表、五个独立NOLOGIN角色、三种域、结构校验函数、跨工作室隔离的复合FK和查询索引；四类业务循环FK与集合初始来源FK延迟到提交。共享回执主键仅workspace/ingest，不按服务/操作/集合拆分。task/snapshot关联是有类型FK。回执成员携带来源指纹和同集合关联。

源表仅支持首代、无封存/未决状态；后续生命周期需独立演进，不能拿此草稿测试已封存新代后登记。所有表INSERT/UPDATE/DELETE/TRUNCATE保持封闭，ENABLE ALWAYS触发器与FORCE RLS共同保护；没有业务资料装载、授权管理或initialize/register/readReceipt函数，也不产生成功回执。这些是仓储实现范围，未因写草稿而自动开放。

内部helper唯一owner为novel_d1b_locker，只有两个授权表SELECT及lock_token列UPDATE；触发器拒绝实际修改任何列，FOR SHARE本身不触发更新。helper只向NOLOGIN mutator/reader职责授予EXECUTE，没有login或角色成员关系，外部服务不能调用。locker不拥有表/DDL/角色管理权；只在同一草稿事务的owner转移期间获得schema CREATE，随后撤回。执行草稿的未来实验管理员需能创建角色和转移函数owner（隔离实例受信管理员），并非运行账号。

授权表RLS仅针对locker的非递归SELECT/UPDATE策略，不查自身；其他表无策略默认拒绝。恢复reader的业务范围RLS仍未创建，因为receipt读取入口未实现；不能将当前默认拒绝宣称恢复读已可用。查出的receipt_producer_ids属于登记服务范围，business_producer_ids属于原业务生产者，外层函数以后必须逐个核验。

共享锁语义按ADR0007：helper先锁后核验，授权管理员未来须同序冲突锁。当前没有授权管理员入口，不能声称撤权流程已实现。helper被调用时需READ COMMITTED和同事务贯穿后续工作；返回JSON不是可跨连接使用的授权令牌。预算外层串行、头锁及完整提交仍由未来仓储承担，草稿只提供其存储位置和限额约束。

## 已固定数值与尚缺的行为

预算字段固定实验候选：workspace回执1024份/16MiB，单份16KiB；来源4096份/32MiB；业务4096行/16MiB；unit来源256份/2MiB。这些是字段范围，不是累计维护已经完成。accounted_bytes至少包含命令和回执字节，有序成员以及关联/集合的完整核算公式仍需与writer一起固定，不能自报数字通过CHECK就当真实预算。

时限选择沿用池2s、锁1s、语句5s、整体10s、idle事务5s；草稿不修改管理员/运行角色默认配置。未来装配必须显式设置并验收；函数内临时设置statement_timeout不能代替调用语句开始前的设置或应用整体截止。

valid_document仅验证JSON与字节解析相等、UTF8字节边界和SHA256一致，使用PG内置sha256(bytea)，不安装扩展；它不证明字节按JS键顺序规范化。完整业务document也尚未与所有关系列逐字段重构比较。valid_binding仅做结构与基本定位检查，上游数组元素类型/顺序/范围和所有跨行绑定、来源投影、生产者规则、task连续版本白名单仍由未来完整校验承担。没有这些校验前保持写入封闭，不能通过管理员临时解除触发器作为常规装载/测试入口。

SQL identifier域按可表示文本计算UTF16长度，并允许nullable列为null；必填列显式NOT NULL。NUL/孤立代理项由未来驱动前检查拒绝，纯函数指纹协议不修改。有限timestamp、正安全整数、责任与预留范围仅为局部结构约束。

初始化恰两来源、每来源恰一类型关联、回执有完整成员、预算累计、记录指纹与业务列对应均未仅靠FK/CHECK解决。故本文件交付是封闭存储与内部授权锁定草稿，不能当完整D1b仓储或生产屏障。

## 本轮验证及下一执行范围

检查git diff、对象引用/命名和本地文档引用；没有可用本地SQL解析器，未声称SQL语法或PL/pgSQL运行已验证。未跑代码测试、未启动PG、未连接业务库、未执行角色授权。

后续独立隔离实库任务可先验证草稿原样创建、目录/ACL/默认拒绝及helper未授权拒绝，成功授权锁与撤权竞态还需受控fixture装载/授权管理方案。实库验收应先证明清空环境的创建与失败回滚，再添加正向授权用例，不能把静态检查当P01～P12通过。

双项静态审查：Standards与Spec均无阻断。实库清单另明确三项：列级UPDATE是否足以取得FOR SHARE；lock_token同值UPDATE也必须被guard拒绝；owner转移后的最终EXECUTE ACL与schema CREATE撤回正确。语句机制参考[PG16 SELECT权限](https://www.postgresql.org/docs/16/sql-select.html)、[PG16内置SHA256](https://www.postgresql.org/docs/16/functions-binarystring.html)，不以文档依据替代执行验证。

Standards/Spec审查结果记录在T09；本次草稿不修改D1a或v1/v2/source-ingest-v1指纹实现。
