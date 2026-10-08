# D1b 运行服务来源初始化事务设计

状态：设计候选。用户批准本轮文档，不批准代码、可执行 SQL、新 GRANT、目录摘要变化、数据库执行或生产启用。仅 initialize；register 和 readIngestReceipt 仍为后续切片。

依据 ADR0004 同库屏障、ADR0006 隔离业务资料、ADR0007 授权/预算锁序及 `EVIDENCE_SOURCE_D1B_INGEST.md`。已实现的管理员装载、完整性读取和只读装配仅供测试准备与验收，不能拼接成运行写事务。

## 1. 接口与职责

服务器仓储 seam 仍为 `initializeSourceCollection(command: unknown): Promise<IngestReceipt>`。命令沿冻结 source-ingest-v1：protocolVersion/workspaceId/unitId/ingestId 与三项 task/snapshot/executionReference；不加入 payload、报价、producer、serviceId、Pool、client、回调或 SQL。

固定运行装配持有单一隔离端点、普通服务 LOGIN、预期 serviceId 和独立只读 inspector。与管理员装配分离：运行端点不得使用超级管理员账号，不暴露连接/事务，也不接已有管理员 read 返回的 records。严格准备命令可复用 prepareSourceIngestIdentity，但其指纹不构成授权或业务证明。

候选实现：同连接 BEGIN READ COMMITTED 后只调用受控 SECURITY DEFINER 初始化入口，入口不自行 COMMIT。入口内部完成授权锁、精确业务核验、来源/关联/回执及预算，外层确认 COMMIT 后才返回成功。运行 LOGIN 没有表读写权，不能由 TypeScript 自由拼表 DML。

SQL 入口候选参数为严格 command JSONB + expectedServiceId 断言。后者只来自固定服务器配置，不加入命令 JSON；函数必须先由 session_user 的不可变映射取得真实 serviceId，并在同事务许可锁下要求二者相等。该参数仅是配置错配检查，绝不选择或替代调用者身份；直接 SQL 调用者换断言也不能冒充另一服务。最终 SQL 名称/参数及编码实现仍须后续确认。

```text
普通服务 LOGIN / 固定装配
  └─ BEGIN READ COMMITTED（单连接、一次 initialize）
     └─ 受控初始化入口 / 非登录 initializer owner
        ├─ principal SHARE → grant SHARE → 真实服务与 initialize 授权
        ├─ 原回执：当前授权下完整历史重放
        └─ 新命令：budget UPDATE → unit/head → 精确四类业务
           → 两来源 + 类型关联 + collection/head + 回执成员 + 回执 + 预算
     └─ COMMIT 确认后返回；未知提交仍 UNAVAILABLE
```

## 2. 事务与锁顺序

1. **语法准备**：严格字段/引用、安全数字与文本；不可表示 NUL/孤立代理项发送前 INVALID_COMMAND。SQL 入口仍独立验证形状与规范身份，不接受 prepared/hash 权威。
2. **当前授权**：内部 locker 按 principal FOR SHARE → workspace grant FOR SHARE，持到事务结束；检查启用、initialize、真实服务断言及所需业务 producer 范围。缺映射/停用/许可异常 FORBIDDEN，先于任何业务、回执或冲突查询。
3. **历史原键**：按 (workspace,ingest) 查询。完整身份指纹相同则核验原回执及不可变关联后重放，**不锁预算/当前头、不重读活动业务、不改计数或提交时间**。异指纹 CONFLICT；同键跨操作/服务不另开命名空间。initialize 授权不推导 register 或 receipt_read。
4. **新写串行点**：锁已存在的 workspace_budget FOR UPDATE；缺预算 NOT_FOUND，不由服务创建。取得锁后重新查共享键，吸收前一事务胜者；不存在回执行不是被锁的对象，真正串行点是预算行。
5. **unit 与头**：按 workspace/unit 查既有 collection 并锁头。新 unit 仍以唯一约束创建竞争保护，但集合、来源、预算不能先单独提交。新命令只允许 generation=1、无历史/final/未决的生命周期；否则 STATE_BLOCKED。服务无解除状态能力。
6. **同连接核验业务**：读取命令指定 task/snapshot/execution 及快照指向的 quote，均按完整 workspace/id/version 和当前允许 producer 预过滤；不得按 latest、仅缓存或管理员读取结果代替。初始化 task 必须 revision=1/predecessor=null；不能用 v2 重置初始锚点。
7. **投影与共同保存**：完整核验通过后构造恰两来源（task、snapshot），保存类型关联、集合固定资料、头、回执及有序成员、累计预算；提交前检查所有计数和恰两项关联。全连接全事务成功才返回。

授权管理员沿 principal→grant 冲突锁更新稳定行，不先持预算/头。操作先持许可锁则撤权等待它提交/回滚；撤权先提交则新操作读到新许可拒绝。不是发起撤权瞬间取消在途事务。准备业务装载必须先提交，运行服务只读不可变业务，不反向取得业务更新锁。

## 3. 最小权限候选

角色名称均候选，不授予本轮权限。现有管理员 fixture 角色和只读 profile 不扩权。

| 职责 | 候选最小能力 | 明确禁止 |
| --- | --- | --- |
| 初始化服务 LOGIN | 仅 initialize 入口 EXECUTE；session_user 映射固定服务 | 表/列 SELECT、DML、TRUNCATE、DDL、SET ROLE owner、内部 helper EXECUTE |
| 新 initializer NOLOGIN owner | 必要授权 helper EXECUTE；按当前授权读取四类业务；读历史来源/关联/回执；INSERT 新集合/来源/关联/成员/回执；限定预算增量及必要集合头锁权限 | 超级用户/BYPASSRLS/角色管理/schema CREATE/业务 UPDATE/DELETE、修改授权、其他来源类型/发布/收费 |
| 内部 locker | 沿用稳定授权行读取与专用锁列权限，锁后检查许可 | 更改 enabled/映射/范围/锁标记，任意业务读取 |
| inspector | 仅新运行 profile 元数据验收 | 数据读取、写入口 EXECUTE 或返回仓储 |
| 测试准备/授权管理员 | 既有隔离工具准备资料与服务映射/许可 | 作为运行初始化服务身份或传 prepared 权威 |

所有数据表 FORCE RLS。initializer 的业务查询与 RLS 同时限制真实服务可访问 workspace，函数额外核验本次 initialize 和允许 producer；授权控制表策略继续非递归。头/预算锁所需 UPDATE 列权限必须逐项设计，不能默认 SELECT 足够，也不能给整表 UPDATE 来取锁。每次服务映射与授权均从真实稳定行读取，不用 caller GUC 或 SECURITY DEFINER 的 current_user 当原调用者。

PUBLIC 无受控函数执行权；函数 owner 非登录、非超级用户、无 BYPASSRLS/成员链，固定 search_path、显式对象限定；不提供动态对象名或通用 SQL 参数。正常行 UPDATE/DELETE/TRUNCATE 保护与仅函数内的受控可变字段保护须另设计并纳入新目录验收。

## 4. 材料核验与生成规则

同连接 SQL 内部材料核验须达到现有管理员 reader 的标准：严格四类文档、完整 binding/上游顺序、任务锚点与双向引用、固定责任/报价、规范 UTF8 字节/摘要、全部列投影及实际选中定位一致。四类 producer 都需属于本次业务范围，不能只核验生成来源的两类；ExecutionIdentity 仍仅身份，不产生 execution 来源。

来源投影保持既有 task={binding,taskRevision,scopeKeys}、snapshot={binding,responsibility,quoteId,priceVersion,reserved}。完整业务指纹与来源 payload 指纹分开保存；snapshot 关联另记精确 quoteReference/指纹，集合另记 execution 精确引用/指纹。recordedAt 与业务 producer 沿精确业务行，verifiedByServiceId 与 verifiedAt 属核验服务/时间，不冒充原生产者。

新集合初值 generation=1、headRevision=1、memberCount=2，未封存/未发布。collectionId 为服务器产生、持久化的无业务含义标识，格式及生成方法后续冻结，不以新 ID 绕过 unit 唯一键。同 unit 新 ingest 的完整固定身份和初始来源相同，保存 already_registered 回执且不新增来源/推进头；异内容 CONFLICT，原集合不改。历史原命令重放优先，不因后来任务链或头变化拒绝。

## 5. 编码、预算与故障前置条件

现有两个 source-ingest-v1 固定向量不变。SQL 入口必须独立产生同一 canonicalEvidenceValue 身份：严格键集合/排序、有序数组、无 Unicode 归一化、安全整数及完整字符串转义。JSONB 不保留原字节，不能用 jsonb::text 充当规范编码；需要仅针对批准字段树的 SQL 编码/校验与 Node/OpenSSL 固定向量。完成前不得执行初始化写函数。

容量沿已有隔离上界：workspace 回执 1024/16MiB、单回执 16KiB；unit 来源 256/2MiB；workspace 来源 4096/32MiB；已准备业务 4096行/16MiB。新回执（含 already_registered）计入回执预算，历史原键重放不新增；新初始化两来源及固定集合/关联计入相应来源/unit 包预算。字节口径、回执完整字段/成员结构、collection 固定资料计入公式及向量**尚未冻结**，不能只用 CHECK 或在运行时猜测长度放行；不删除历史释放容量。

候选池2s、锁1s、语句5s、idle-in-transaction 5s、整体事务10s；均待实施和实测，不是已实现默认/SLA。多语句与 COMMIT 截止由装配负责，不能把 statement_timeout 当整体截止。锁内不得调用模型/外网、解密 Key、回调业务仓储或递归 initialize。

任一步失败整项回滚，无半集合/成功回执；连接或 COMMIT 结果未知返回净化 UNAVAILABLE，销毁连接且保留原 ingest 身份。恢复必须使用同原命令或专用 readIngestReceipt，不换 ID、不重调模型；查询暂时未见不等于未提交。此 read 接口尚未实现，完整未知提交恢复验收必须等其具备，不能声称本单切片已闭环。

## 6. 新运行 profile 与装配

需要独立运行初始化 profile 及冻结目录摘要；不能把现有只读扩展摘要改成通用 writer 许可，也不能让管理员装配产生仓储。旧封闭和管理员只读门禁保持回归。运行 LOGIN 的 EXECUTE、initializer 表/列ACL、RLS、授权锁 helper、不可变/受控变更 guards、编码函数/向量均纳入完整目录验收；元数据验收不替代运行登录实际身份与每事务授权检查。

仅构造同一隔离地址的 inspector 与普通服务连接，不接受 caller Pool。目录检查与执行之间仍可能发生管理员 DDL，未来必须明确并测试该间隙策略，不因目前单 URI 就称原子安全。生产装配默认不存在，源码中的 fixture 字段不充当安全证明。

## 7. 未来验收（本轮未执行）

| ID | 场景 | 预期 |
| --- | --- | --- |
| R01 | 普通登录合法 initialize | 两来源/类型关联/集合头/恰两回执成员/回执/预算同事务可见；不封存/收费 |
| R02 | 登录直读写/SET ROLE/内部 helper/伪 GUC/预期服务错配 | 当前身份或权限拒绝，不泄露资料/冲突，不改预算 |
| R03 | 原键同指纹/异服务或操作指纹并发 | 原完整回执收敛或 CONFLICT；跨集合共享同一键 |
| R04 | 同 unit 同内容/异内容新 ingest；缺预算 | already_registered 或 CONFLICT；缺预算不隐式建工作室 |
| R05 | 权限先锁/撤权先锁两连接 | 按既定撤权顺序完成或 FORBIDDEN，许可锁持续至事务结束 |
| R06 | 四类缺失/producer 范围外/引用或列投影/规范字节/报价错配、初始 task v2 | 无默认资料/最新回退，整体拒绝，不用管理员副本补齐 |
| R07 | 历史回执后头/生命周期改变；满额原键重放 | 原键按当前授权完整重放，无当前头/活动业务依赖，不加预算 |
| R08 | 新 ingest 遇历史/final/未决、超预算 | STATE_BLOCKED/CAPACITY，无新回执或半组关联，不清历史 |
| R09 | 插入/更新/约束/提交故障；独立连接在途观察 | 全无或共同可见，COMMIT 未知原身份待核对；恢复接口具备后验证 |
| R10 | Node/SQL 编码、中文/非BMP/字符串转义、边界整数/NUL | 相同固定指纹；不可表示文本发送前拒绝不归一化 |
| R11 | profile owner/ACL/RLS/函数正文/默认权限/编码漂移 | 初始化前拒绝且不修复；旧两个 profile 行为不放宽 |
| R12 | 锁/语句/整体/idle 超时、关闭装配与连接异常 | 有界净化 UNAVAILABLE，无自动重投或换 ID |

R01～R12 与原 I/F/P 清单对齐，但此前管理员读取/探针测试不能替代运行写事务的上述验收。本轮没有执行代码或数据库测试。

## 8. 实施分段与未冻结项

下一设计切片优先冻结：运行 SQL 入口/预期服务断言、受限 initializer 角色和 RLS/guard 权限矩阵；随后冻结规范编码与投影规则、完整回执/预算公式和固定向量；再交付独立可执行 SQL 草稿及新 profile，仅经另批后在合成库 TDD 实现。不得在编码或预算缺口未关闭时先给 initialize EXECUTE。

仅初始化成功切片也不能称登记闭环：register、receipt_read、真实矛盾事实可靠隔离、D2 生产业务来源、执行关闭/收费依旧未实现。吞吐、RPO/RTO、备份与运维成本只限短期隔离实验，不增加常驻服务/云资源或生产 SLA。

## 9. 本轮检查

Standards 与 Spec 文档审查均无阻断，维持 Proposed ADR 和未冻结的 SQL/权限/编码/预算批准点。相对链接、R01～R12唯一编号和 git diff 检查通过。本轮仅文档，未重跑代码或数据库测试，也不把前轮测试数量计为本设计验收。
