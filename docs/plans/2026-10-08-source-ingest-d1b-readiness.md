# D1b封闭目录预检实施与验证

日期：2026-10-08。用户要求继续下一步，实施独立D1b只读目录预检。接口assertSourceIngestDraftDatabase(pool):Promise<void>由billing根包导出；成功仅返回void，失败统一SOURCE_INGEST_DRAFT_DATABASE_NOT_READY。没有创建仓储、读取业务表或开放登记入口。

## 实施边界

- 新增src/evidence-source-d1b-readiness.ts管理只读事务与当前角色判据；connect/query/release在异步等待前绑定，失败回滚并release(true)，cleanup错误也净化。
- 新增内部src/evidence-source-d1b-catalog.ts保存固定查询与目录指纹；运行时不读取SQL文件、不学习当前目录作为新基准、不执行来源定义的函数。
- 新增5项公开入口模拟测试；扩展既有隔离PG16测试，在专用inspector连接验证健康与25类漂移，SQL草稿和D1a实现保持原状。

pool由受控服务器准备且生命周期由宿主负责，预检不接浏览器提供的Pool。调用时current_user须为novel_d1b_inspector，session_user须为不同的受限LOGIN且仅可达inspector职责；五个内部职责均NOLOGIN且无额外可达角色。拒绝super/CREATEROLE/CREATEDB/BYPASSRLS/replication、数据库CREATE/TEMP、public/schema CREATE，以及有效表/列数据权限和来源函数EXECUTE。宿主须单独配置inspector登录/角色及数据库PUBLIC TEMP撤回；预检不自行授予或撤回权限。此处角色识别不代替业务服务认证。

## 固定目录判据

健康基准来自已验收的独立SQL草稿在新建PG16.14/UTF8临时库原样创建后的目录：96275bf28e4ac2e3b3adfeb591384c0b394e10d39d545fd98124e119d3aee138。提取后清理该临时库/角色；指纹是目录形状标识，不是来源payload/业务/发布协议指纹。

目录投影将本地OID解析为稳定名称、类型或定义，按条目内容的C顺序排序；ACL还按grantee、grantor、权限、is_grantable确定排序。范围包含schema owner/ACL、关系与列、域及约束、索引/操作符类/排序规则、函数定义/owner/ACL、用户与内部FK触发器、策略、默认ACL、继承及改写规则。包含内部FK触发器启用状态，忽略其不稳定OID命名。不会把新对象、宽松策略、未授权写函数或新默认权限默许为健康。

目录JSON使用PG16系统目录投影的jsonb文本作摘要，这不是JS来源协议编码；源登记/发布规范不变。PG目录反编译输出存在版本差异，未来更新PG/profile须审查后显式更新期望，不在启动时重新冻结。该检查仍是点时目录核验，不保证管理员之后无法改变目录，也不提供写事务屏障、业务数据真实性、独立数据库身份或TLS证明。

## 测试与实际观察

新临时实例/private/tmp/source-d1b.e99tS6/data，PG16.14，Unix socket父目录、端口56439、listen_addresses为空，host拒绝连接。测试在任何DDL前核验实际目录/无TCP/PG16及草稿角色缺失。未读取业务数据库环境。

健康冻结前预检拒绝；固定摘要后健康通过。25类漂移均连续拒绝两次，证明确未修复，人工恢复后重新通过健康判据：

| 组 | 实测漂移 |
| --- | --- |
| 身份/职责 | login BYPASSRLS、owner可达、locker可登录、数据库TEMP |
| 结构/预算 | 缺表、额外列、域可空性变化、预算CHECK放宽、循环FK提前校验、缺索引/额外索引 |
| 数据访问 | FORCE RLS撤回、额外宽松策略、inspector表读、login列读、locker授权列写、locker schema CREATE |
| 保护与函数 | row guard停用、内部FK guard停用、guard body变化、helper search_path变化、PUBLIC helper EXECUTE、未来PUBLIC默认执行、新函数、DML改写规则 |

隔离套件36项通过（包含原10项、目录父用例及25子用例），公开入口模拟5项通过：只读完成、严格单行true、连接/query/commit/rollback/release净化、绑定依赖、防止漂移且销毁失败会话。Standards/Spec无阻断；按Standards建议补齐ACL确定排序后，41项专项再次全部通过，固定目录摘要不变。

全仓回归375项、356通过、19项其他数据库条件跳过、0失败；全仓typecheck和diff检查通过。最后仅对ACL排序改动复验专项，不重复无关回归。

调试期间修正测试嵌套上下文：漂移子用例必须使用profileTest.test而不是排队到外层父测试。等待中的两次测试进程已精确终止，其随机测试库/角色手动限定清理；随后完整测试自动清理成功。此问题属于测试调度，不是数据库锁或预检函数故障。

最终独立查询本轮测试库与角色数量均0，pg_ctl停止成功且status为no server running。保留空临时集群和日志，未递归删除用户文件。

## 后续

目录预检可供后续隔离装配调用，但尚未接启动入口。所有业务写仍默认关闭；正向授权行锁/撤权、fixture装载、完整规范字节/投影、预算累计、三个登记/读取仓储方法及D2/D3仍需后续实现和各自验证。下一切片建议落实受控测试资料准备与授权管理入口，再验证真实行上的共享锁/撤权顺序。
