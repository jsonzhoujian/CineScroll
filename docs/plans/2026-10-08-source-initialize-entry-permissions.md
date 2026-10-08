# D1b initialize 入口与权限细化

状态：设计候选，延续 [事务设计](2026-10-08-source-initialize-runtime-design.md) 与 [ADR0008](../adr/0008-source-initialize-runtime-boundary.md)（Proposed）。本轮仅文档；没有 SQL、GRANT、运行实现、数据库执行或生产许可。

## 1. 单一入口与身份

候选入口名 `initialize_runtime(command jsonb, expected_service_id text)`，由独立 initializer NOLOGIN 角色拥有，以 SECURITY DEFINER 执行；外层仍负责同连接 READ COMMITTED 事务及 COMMIT。名称、签名和角色均待实施前批准，不改变现有 source-ingest-v1 命令字段。

函数独立严格验证命令，拒绝未知字段及不合法引用；不能接收业务记录、预计算指纹、任意 SQL 或对象名。固定 search_path 为 pg_catalog、pg_temp，业务对象显式限定 schema，不从临时对象解析依赖；无动态 SQL。

真实服务只取 session_user 的稳定 principal 映射，并在 principal→grant 的 FOR SHARE 锁下校验当前 initialize 许可。expected_service_id 仅与真实服务比较，不能选择身份。current_user 只用于识别受控执行角色，不能代表原调用服务。任意 caller GUC、SET ROLE 或替换断言都不能改变 actor。

首个隔离实验候选使用固定普通 LOGIN `novel_d1b_initialize_login`，无角色成员关系，固定映射一个 serviceId；一个服务可通过不同 grant 行访问多个工作室。多服务 LOGIN 配置及动态授权不属于本切片，不以共享执行角色成员链偷偷扩展。运行装配只能使用这一普通登录与独立 inspector，不能使用测试管理员池。

## 2. 权限矩阵

以下全部是新运行 profile 的候选权限，不修改旧封闭或管理员只读 profile。

| 对象 | initializer 最小能力 | 禁止/保护 |
| --- | --- | --- |
| 授权控制表 | 仅调用受控锁定及策略 helper | 无直接授权修改；稳定映射不可替换 |
| 四类业务表 | SELECT，受工作室及 producer 范围限制 | 无 INSERT/UPDATE/DELETE/TRUNCATE |
| collection | SELECT、INSERT、仅 head_revision 列 UPDATE 权限供 FOR UPDATE 锁使用 | 所有实际 UPDATE（含同值）/DELETE/TRUNCATE 拒绝；初始化不推进已有头 |
| source_version、两类 link | SELECT、INSERT | 实际 UPDATE/DELETE/TRUNCATE 拒绝 |
| ingest_receipt、receipt_source_member | SELECT、INSERT | 实际 UPDATE/DELETE/TRUNCATE 拒绝；共享键不释放 |
| workspace_budget | SELECT、仅 receipt_count/receipt_bytes/source_count/source_bytes 列 UPDATE | 无 INSERT/DELETE/TRUNCATE；business 计数及 workspace 不变 |

LOGIN 只有 schema USAGE 和单一入口 EXECUTE，无上述表/列权限、内部 helper EXECUTE 或 owner 成员关系。initializer 无 LOGIN、SUPERUSER、BYPASSRLS、CREATEROLE、CREATEDB、REPLICATION、schema CREATE 或表所有权；表继续 FORCE RLS。锁列权限与允许实际修改是两件事，不能为取得行锁赋整表 UPDATE。

内部 locker 保持既有授权行 SELECT 与专用锁列权限；新增 initializer 对锁 helper 的调用权必须单独纳入新 profile。PUBLIC、普通 LOGIN 及其它 fixture 角色不获得新入口/helper 权限。所有函数创建后的 PUBLIC 默认 EXECUTE、全局及 schema 默认 ACL、owner 隐含能力和成员链都需验收，不能只检查显式 GRANT。

## 3. RLS 与历史重放

候选新增私有授权策略 helper，仅由有限 locker 角色 SECURITY DEFINER 执行，读取 principal/grant，不读业务/来源表，避免策略递归。只向 initializer 开放，不向 LOGIN/PUBLIC 开放。输入工作室及可选 producer 不能替代 session_user 身份；函数返回布尔范围判断，不暴露授权记录。具体函数正文及 ACL 待独立 SQL 草稿冻结。

策略 helper 检查当前映射启用、工作室许可启用和 allow_initialize；它不替代入口的 FOR SHARE 授权锁。四类业务 SELECT 另要求 producer 属于当前允许业务 producer 集合；来源、集合及回执 SELECT 按工作室授权，不使用 receipt_read 的 producer allowlist，否则可能隐藏跨服务共享键冲突。入口只返回本操作允许的结果，不提供通用历史读取接口。

明确分支：当前 initialize 授权先于历史查询；同原键、同完整身份的历史重放只核验保存回执与不可变来源/关联，不读取当前业务、预算或活动头。业务 producer 范围为空或后来缩小，不单独阻断这种历史重放；新命令必须核验四类业务 producer，范围不满足则拒绝，不借旧资料绕过。此为候选语义细化，不声称现有 helper 已实现运行入口。取消 initialize 许可仍阻断所有重放。

共享键异身份统一 CONFLICT，不返回他方命令/业务/回执内容；initialize 许可不隐含 register 或 receipt_read 许可。策略禁止 caller 自设 workspace/service GUC 充当授权上下文。撤权仍沿 principal→grant 冲突锁，顺序语义不变。

## 4. 不可变与跨行保护

新 guards 必须 ALWAYS、稳定非运行表 owner 拥有，且不能由 LOGIN/initializer 禁用、替换或新增绕过函数。它们可识别 current_user 为 initializer，但同时依赖冻结的唯一入口、最小 ACL、无成员链及真实 session_user 授权；仅角色名或 GUC 不构成写入许可。测试 fixture 分支保持自身受控条件，不向运行角色开放。

- 新 collection 仅 generation=1/headRevision=1/memberCount=2，无 history/final/未决；固定资料与精确四类指纹同事务核验。所有已有 collection 实际 UPDATE 拒绝，锁定本身不更改行。
- 新 source 仅 task/snapshot、revision=1、predecessor=null、introducedGeneration=1，类型 link 必须匹配精确业务及投影指纹；业务 producer 与核验服务分开保存。
- 新 receipt 仅 operation=initialize，状态 initialized/already_registered；真实服务、完整命令及独立重算规范指纹一致。成员 ordinal=0 为 task、1 为 snapshot，各恰一项，引用已存精确来源。不能依赖客户端计数。
- 新 unit 增加恰两来源及一回执；既有同内容 unit 的新 ingest 只增加回执及两成员，不增加来源、不推进头；同原键重放零修改。预算只允许本次冻结公式得出的精确正增量，business 两计数不变，不允许减计数释放历史。

入口最终核验与延迟约束 guard 共同检查提交时恰两成员、两类 link、固定引用及计数/字节一致。现有 FK 不证明恰两项，CHECK 不证明跨行完整性。建议写入顺序为 collection、来源/link、receipt、成员、预算：source→collection 的即时 FK 要求集合先存在，反向 collection→初始来源的既有延迟 FK 在提交时闭合循环依赖。任一步失败全部回滚，集合不能单独提交。guards 不调用外网、不依赖持久化 GUC，不单独创建预算或空集合。

尚未冻结的规范编码、完整回执及预算公式决定这些 guard 的准确表达；本文件不能替代它们，更不能提前授予 EXECUTE。实现前还需实库确认列级 UPDATE 足以取得 collection 锁且实际 UPDATE 全被拒绝。

## 5. profile 与未来验收

独立运行 profile 必须冻结入口/helper 正文、签名、owner/search_path/ACL、角色 flags/成员链、列权限、全部 RLS、ALWAYS guards 和延迟约束。旧两个 profile 摘要保持原值并继续拒绝运行扩展；不通过学习当前目录自动更新预期摘要。授权数据不放入元数据摘要，仍每事务核验。目录检查与执行间的管理员 DDL 间隙仍需另设计，尚无原子 DDL 安全声明。

| ID | 未来验收（本轮未执行） |
| --- | --- |
| E01 | 普通 LOGIN 仅入口可执行；表直读写、内部 helper、owner SET ROLE 均拒绝 |
| E02 | expected_service_id 错配、伪 GUC、替换工作室不能冒充；授权检查先于资料/冲突查询 |
| E03 | 四类 producer 任一越界/空范围新命令拒绝；无跨工作室泄露 |
| E04 | 范围缩小后原键完整重放无活动业务/预算/头依赖；initialize 撤权则拒绝 |
| E05 | 跨服务/操作共享键冲突不泄露原命令，receipt_read 范围不能隐藏冲突 |
| E06 | principal/grant 两种撤权顺序、多连接锁持续到事务结束 |
| E07 | collection FOR UPDATE 可用，但同值及真实 UPDATE 均被 guard 拒绝 |
| E08 | 来源/link/回执/成员的 UPDATE/DELETE/TRUNCATE、预算减计数及 business 计数修改均拒绝 |
| E09 | 缺成员、重复成员、错类型/link/指纹/计数的事务不能提交；无半集合 |
| E10 | initialized、already_registered、原键重放各预算精确且并发收敛；缺预算不创建 |
| E11 | PUBLIC/default ACL、函数/策略/trigger/owner/成员链漂移被新门禁拒绝；旧摘要不变 |
| E12 | 运行身份不能执行 fixture 准备或成为表 owner；管理员副本不能作写授权证明 |

E01～E12补充原 R01～R12，不是已通过的测试。下一步先冻结 SQL/Node 规范编码及投影、完整回执与字节预算向量，再申请独立可执行 SQL 与隔离实验；register、恢复读和生产装配仍不在本轮范围。

## 6. 本轮检查

Standards 与 Spec 分别审查，均发现同一外键写入顺序问题；修正为集合先于来源后复核无残留阻断。相对链接、E01～E12唯一编号及 diff 检查通过。本轮未运行代码或数据库测试，没有把未来验收列为通过。
