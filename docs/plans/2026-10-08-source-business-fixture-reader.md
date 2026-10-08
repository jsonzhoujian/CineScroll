# D1b 已存业务资料完整性读取（方案 A）

用户批准隔离测试管理员专用读取，不新增运行登记角色的读权限。本轮 seam：`createIsolatedSourceBusinessReader(pool, config).read(input)`，仅放在 test/support，无应用 export/HTTP/收费装配。

## 精确定位与范围

固定 config 的 workspaceId/allowedProducerServiceIds 克隆后不可由外部修改。input 精确包含 taskReference/snapshotReference/executionReference（各 id/version）；描述符检查拒绝 getter、符号、隐藏字段和额外元数据，然后复用严格登记协议引用校验。NUL/孤立代理项在查询前拒绝；不接受自报文档、金额、指纹或连接。

管理员连接必须满足现有临时实例检查：PG16/UTF8、真实 session_user 超级管理员且未切角色、无 TCP、精确临时集群路径及随机 d1b 测试库。随后仅 SET LOCAL ROLE 到现有业务 fixture 角色；没有新增 GRANT 或 SQL 对象。READ ONLY + REPEATABLE READ 保持同事务视图，statement_timeout 5s，绑定依赖、固定 search_path。

初始三引用均按 workspace/id/version 与允许 producer 精确过滤。缺失或范围外同 NOT_FOUND，不查询最新。报价从选中快照 SQL 引用精确读取，任务沿选中 SQL predecessor 链回溯至首版，最多 4093 个任务版本、拒绝循环。依赖行缺失/范围外返回 INTEGRITY_CONFLICT；这些是管理员测试工具的错误约定，不是最终运行服务授权契约。

## 完整性校验

将精确读取的四类文档重新交给纯校验，验证完整 binding（含上游顺序）、固定引用/任务锚点、平台或 BYOK 报价、连续任务版本链。重新产生规范 JSON、UTF8 字节和 SHA256，不相信存储行自报指纹。

校验生成的记录须与**实际选中行**的 workspace/id/version 相同，不能用另一组存在的行代替请求定位。随后每条记录在同一事务按完整 SQL 投影逐列 `IS NOT DISTINCT FROM` 比较，涵盖 document/canonical/business_fingerprint、producer/time、专有字段及引用。只有恰一行完全匹配才返回纯校验产生的独立副本。

读取时 canonical 必须为非空 Buffer，单条 canonical 和 JSON 文档最多 2MiB，累计 canonical 最多 16MiB；纯校验另限制访问节点/深度/数组。读取了受限单条响应后才检查大小，不声称 PostgreSQL 服务端响应在解码前完全受控；依赖已安装的原始数据约束与管理员管理的合成库。先前目录門禁是独立验收，本函数未自动执行完整冻结目录门禁，不能抗恶意管理员修改 schema 或作为生产许可。

错误保持 INVALID_COMMAND/FORBIDDEN/NOT_FOUND/INTEGRITY_CONFLICT/UNAVAILABLE。存储或提交/释放故障不带原始诊断。失败尝试回滚；成功和失败连接均销毁，不自动重试、不修复行、不切版本。校验成功只表示合成资料在该快照中一致，不证明业务权威、执行完成或收费依据。

## TDD 与验证

精确版本入口先因不存在失败；读取 v1/v2 与不存在版本验证无回退。额外命令元数据先错误通过，随后描述符精确形状校验修复，getter 调用数为零。返回副本被修改不影响后续读取。

真实 PG 在管理员明确关闭报价 ALWAYS guard 后制造两类损坏：price_version 投影与 document 不同；canonical 前置空格且同步改为匹配 SHA256（JSON 与数据库 CHECK 仍合法）。读取反复 INTEGRITY_CONFLICT，不自动修复；测试恢复原行并以 finally 恢复 ALWAYS guard，读取与完整扩展门禁重新健康。故意破坏仅为合成测试，不给读取入口任意 SQL 参数。

另验收普通运行登录 FORBIDDEN、范围外或不存在 workspace 同 NOT_FOUND、外部修改配置数组不扩大读取范围。未注入缺失依赖/循环链/全部容量边界或并发管理员修改读快照，不能将未测场景计为已验证。

## 后续

先独立装配目录门禁与只读材料取得，再接来源集合初始化；运行服务授权/撤权、来源登记写事务、D2 生产来源与计费保持关闭。

## 完成记录

实库专项 64 项全部通过；全仓回归 414 项，395 通过、19 项其他数据库环境跳过、0 失败。全仓 typecheck 通过；最后调整后 billing typecheck 及 diff 检查再次通过。原 SQL、授权与冻结目录摘要未改。

Standards / Spec 无阻断。按 Standards 性能建议，版本链改为向后累积再一次 reverse，避免循环 unshift 移动数组；补充 NUL 命令回归后实库专项再次全部通过，不重跑无关全仓测试。原型/描述符和查询/释放依赖绑定维持严格边界。

临时实例独立查询测试数据库和角色均为 0，pg_ctl 停止成功。保留临时集群目录及日志，未递归删除其他用户文件。
