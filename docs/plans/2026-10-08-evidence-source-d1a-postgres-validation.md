# D1a 隔离 PostgreSQL16 验收记录

日期：2026-10-08。用户另行批准：新建临时实例，执行D1a草稿、健康预检及目录/权限漂移注入，发现问题补回归修复；停止实例、仅本地提交。不连接业务库，不接模型/Key/Writer/收费。

## 环境与安全边界

实际版本：PostgreSQL16.14（Homebrew）。新建目录 `/private/tmp/source-d1a.KaQBJs/data`，UTF8/locale C，Unix socket位于其权限受限父目录，TCP listen_addresses为空，host认证reject。仅此可丢弃实例的本地管理员使用trust认证；绝不是部署登录策略。没有安装软件或扩展，没有使用既有实例/业务数据。

测试文件为 `packages/billing/test/evidence-source-database-readiness-postgres.test.ts`；入口仍是assertEvidenceSourceDatabase(pool)，管理员DDL仅用于草稿安装和故障注入。TEST_SOURCE_D1A_DATABASE_URL未设置时显式跳过；设置后先检查socket前缀、真实data_directory、关闭TCP和固定草稿角色不存在，再创建随机测试库/登录。测试只有新建实例的管理权，不能把普通业务库URL接给它。固定角色测试须串行运行，不能多个进程共享同一临时实例并发安装。

测试结束关闭连接池、删除本次随机测试数据库/登录/辅助角色以及本次草稿角色，不改已有业务对象。实例生命周期由测试宿主管理，未提供自动启动/部署代码。

## 先红后绿与修复

草稿SQL在新库执行成功，但初版健康预检返回EVIDENCE_SOURCE_DATABASE_NOT_READY。实库阶段诊断显示roles/tables通过、structure拒绝；实际PG16约束目录的connoinherit：CHECK=false，PRIMARY KEY/UNIQUE/FOREIGN KEY=true。原判据一律要求false，误拒健康库。

修复限定为按预期约束类型检查 `c.connoinherit=(e.type<>'c')`，未移除该检查，也未放松定义、FK、索引或权限条件。健康预检转绿；新增CHECK NO INHERIT漂移仍拒绝，恢复后再次健康通过。诊断仅测试夹具目录字段/阶段及SQLSTATE，生产接口仍返回固定脱敏错误。

## 实际执行结果

隔离测试33项全部通过（1个父测试+32个子测试）。其中28类漂移每次均执行“注入→两次拒绝→管理员恢复→健康通过”，覆盖：

- BYPASSRLS、额外继承、owner可达、检查角色LOGIN、数据库/schema CREATE。
- 集合缺失、FORCE RLS移除、宽松policy、表SELECT/列UPDATE、额外对象/列。
- 主键/枚举索引缺失、错误排序collation、弱CHECK、CHECK继承变化、FK缺失/延迟。
- 行/TRUNCATE触发器禁用、ALWAYS降级、保护函数体/search_path/SECURITY DEFINER变化、PUBLIC执行权限和额外函数。

另验证管理员身份不能冒充检查角色；受限角色无法SELECT/INSERT/UPDATE/DELETE/TRUNCATE或执行源函数；临时管理员的INSERT与TRUNCATE也被封闭触发器阻止。ID结构检查验证TAB、NBSP、BOM、Unicode空白、换行、通配符和URL拒绝、中文通过；确认200个非BMP字符的SQL长度与JS UTF16长度不同，D1b仍需原协议完整验证。

携带仅D1a临时库配置的全量回归：360项中342通过、18项其他数据库条件测试跳过、0失败。类型检查通过。未配置该临时库时，本测试跳过，不能宣称默认CI已执行实库验收。

## 未交付与下一步

这是封闭结构草稿/目录预检的PG16验证，不是全部DB01～DB16、来源真实性、累计容量、发送关闭、迟到隔离、共同发布或计费验收。草稿仍位于docs/sql-drafts，不进入自动迁移；未部署到业务环境，没有来源写仓储、业务身份映射或真实Writer。

建议下一轮先确认D1b最小切片的受控初始化/登记接口、真实业务证明与权限方案，不能直接开启模型或收费。暂不将SQL粗结构函数当作v2完整验证器，不自动扩大限额或回填历史资料。

## 审查与收尾

Standards与Spec审查无阻断；按Standards建议将各清理步骤独立执行并汇总净化失败，避免首个失败跳过后续对象。最终回归和类型检查再次通过。

实例残留检查：test_databases=0、test_roles=0。已停止该临时实例，pg_ctl status确认no server running。临时空集群数据目录保留以便诊断，不删除其他实例或用户目录；本轮测试数据库和角色已移除，不含业务数据。
