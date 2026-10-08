# 来源存储与数据库屏障实施设计

日期：2026-10-08。状态：设计草案；用户批准本轮文档范围，不等于批准以下参数、SQL、角色创建或迁移执行。

## 1. 目标、现状与范围

依据[ADR0004](../adr/0004-evidence-source-seal.md)、[ADR0005](../adr/0005-evidence-publication-v2.md)、[可信来源契约](../contracts/EVIDENCE_TRUSTED_SOURCE_TRANSACTION.md)及[v2协议](../contracts/EVIDENCE_PUBLICATION_V2.md)。保留同数据库路线、固定v2指纹与v1历史，不重新决策数据库技术。

交付目标：把来源集合、不可变版本、完整清单、发送/关闭栅栏及异常隔离细化为可分步实施的数据库设计，明确受控写入口、索引、失败恢复和实库验收。本文没有可执行DDL，也不是新的运行时API。

已交付：内存来源、完整包校验、共同发布与九字段读取规则。未交付：真实数据库来源、可信业务关联、所有Writer屏障、持久化共享请求键、生产读取与收费。现有 `packages/script/src/postgres-model-tasks.ts` 自行管理任务事务；`model-tasks.ts` 的单个candidateVersionId不能列举全部原始结果。旧 `packages/billing/migrations/0002_evidence_material.sql` 只有资料不可变约束，不能证明published。

本轮不修改这些实现，不将它们自动升级为可信来源，不建立新的执行ID掩盖已有未知执行。生产发布开关保持关闭。

## 2. 总体结构与分期

```text
受认证的服务身份 + 工作室/操作授权
                 ↓
受控业务写入口：锁来源头 → 核验真实业务记录 → 追加版本/推进代
                 ↓
发送资格/关闭栅栏      完整封存清单      final后异常隔离
                 ↓
未来共同发布：共享请求锁 → 来源头锁 → 四对象同事务
                 ↓
未来生产读取：原发布关联 + 原不可变清单 → 九字段投影
```

阶段D1：存储/受控入口/启动预检在隔离数据库验证；只用明确标记的测试业务记录，不能启用生产发布。
阶段D2：固定报价、发送、原始结果、关闭、校验、计价的真实生产者逐一接入；全部完成前仍不可生产发布。
阶段D3：共享请求登记、共同发布、生产读取及v1写入兼容；不能用D1通过代替D2/D3验收。任务冻结/账本/Outbox共同事务、实际扣费、历史迁移和人工裁决另行批准。

技术基线候选为已有TypeScript/Node、pg驱动和隔离PostgreSQL16测试环境；不引入缓存作为权威。生产数据库版本、扩展、容量及部署拓扑另行批准，不要求使用Supabase托管服务。

## 3. 逻辑表结构（表名与列为设计，不是迁移）

所有主键、外键和查询均包含workspace_id。collection_id是服务器分配的集合定位，不能替代固定binding；binding固定包含workspace/task/unit/project/chapter/sourceVersion及有序upstreamVersionIds。同工作室unit_id仅对应一个固定集合，换任务/原文不得复用unit_id。

集合还固定唯一execution_id，受控初始化确定并与任务/单元绑定；执行/发送/fence/closure/result不得改用另一个execution_id规避旧unknown。引用修订可追加，固定执行身份不能更新。

| 拟定对象 | 关键字段与键 | 约束及用途 |
| --- | --- | --- |
| evidence_source_collection | PK(workspace_id,collection_id)，UNIQUE(workspace_id,unit_id)；固定binding、snapshot引用/指纹、generation、head_revision、current_seal_id、final_seal_id、成员/字节计数、unresolved_count | 固定binding/快照不可更新；代和头修订只由受控入口推进；当前封存必须同集合/同代；未决冲突阻止新可消费封存/发布；final后正常写入永久关闭 |
| evidence_source_version | PK(workspace_id,collection_id,kind,record_id,version)；revision/predecessor_version、introduced_generation、payload及规范字节/指纹、producer_service_id、rule_version、业务引用、时间 | kind涵盖task/snapshot/execution/fence/result/validation/pricing/closure；只追加；唯一(workspace,collection,kind,id,revision)；前序同实体且revision连续，不按version字符串选最新 |
| evidence_source_business_link | 来源版本复合键、业务类型/主键/版本/指纹、核验服务/规则/时间 | 与来源版本同事务；仅受控适配器核验真实业务行后写入；不能仅存自报ID。有类型的具体FK/不可变业务快照在D2按实际表确定，通用JSON引用不是真实性保证 |
| evidence_source_seal | PK(workspace_id,seal_id)，UNIQUE(workspace_id,collection_id,generation)；kind、完整manifest规范字节/指纹、固定引用、计数、规则/服务/时间 | 只追加；observation/final判据沿用v2，不接受complete布尔声明；清单是该代全部历史成员的快照 |
| evidence_source_seal_member | PK(workspace_id,seal_id,ordinal)；完整来源版本键/指纹/introduced_generation | FK至同工作室/集合的seal和version；UNIQUE(workspace_id,seal_id,collection_id,kind,record_id,version)；清单数组顺序由ordinal固定，核验全覆盖及无重复，不能只保存选中结果 |
| evidence_source_dispatch | PK(workspace_id,collection_id,execution_id,attempt_id)；发送资格/栅栏版本、受控状态、业务关联、时间 | 为具体发送尝试保留不可变事实；当前栅栏状态由fence版本表达。可能已发送的资格不能因过期或取消被擦除 |
| evidence_source_quarantine | PK(workspace_id,quarantine_id)；collection/execution引用、可空final_seal引用、ingest_id、指纹、净化原因、受保护业务指针、采集时间 | 只追加；同ingest_id+内容幂等，异内容冲突；隔离不得成为可消费成员、推进final集合或覆盖旧证据 |
| evidence_source_ingest_receipt | PK(workspace_id,ingest_id)；命令指纹、来源或隔离定位、提交时代/修订、结果 | 与业务事实/版本或隔离同事务；重放返回原回执，不能用当前generation重算历史登记结果；ID由采集端在可靠暂存后固定 |

头→当前seal与seal→集合会形成循环引用：推荐头锁定后先追加seal/member，再更新头指针，同一事务完成；新集合先有空指针，封存前必须具备受控固定task/snapshot。复合FK具体可延迟性与SQL语法留给D1评审，不能提交半份清单。所有计数是事务维护的优化值，封存时必须与真实成员核对，不以计数代替全覆盖证明。

未来D3另需共享请求锁/登记、资料、审计、回执表及完整关联约束；本轮不复用裸资料表宣称已有四对象事务。共享键仍为(workspace,request_id)，不含协议。旧v1入口必须接同一约束或关闭旧写入口，迁移/导入策略未批准。

### 索引与编码

- 来源枚举索引(workspace,collection,introduced_generation,kind,record_id,revision)，读取该代时累计 `introduced_generation <= generation`，包含历史版本，不删除旧成员。
- 实体版本唯一键用于前序定位；seal_member的版本外键侧建立复合索引；头的unit唯一索引负责定位，封存PK负责历史读。业务引用索引在D2按实际查询确定，避免全字段GIN。
- 隔离查询采用(workspace,collection,recorded_at,quarantine_id)稳定游标，并保留execution定位索引；不使用OFFSET作为大历史分页方案。
- generation/revision以bigint存储，但边界限制为正JavaScript安全整数；额度同样不得溢出既有协议。ID长度及禁字符沿用v2；SQL字符/UTF-8字节限额分开定义。
- 沿用v2的JavaScript规范化JSON/UTF-8/SHA256，不用 `jsonb::text` 重算协议指纹。存储规范字节与jsonb，受控写/读适配器校验二者语义和指纹对应；数据库负责结构/范围/关联约束。SQL端规范化、hash扩展与约束实现仍待方案验证，不声称仅存hash就具有DB真实性。
- 清单顺序拟按kind固定序及record_id/revision排序，在形成清单时固定；数据库采用明确稳定排序，跨语言需测试中文/非BMP/version值，不静默改变既有已保存manifest数组顺序。具体排序算法在D1接口冻结前确认。

## 4. 写入口与同事务屏障

以下仅为设计签名。固定serviceId来自服务器装配/数据库身份映射，操作授权独立于成员审核；命令不携带任意Pool、client、material、canonicalHash或complete。仓储内部持有同一连接管理BEGIN/COMMIT，业务适配不能通过现有独立事务方法拼接。

| 拟定边界 | 输入/结果与拒绝规则 |
| --- | --- |
| initializeSourceCollection(binding,fixedSnapshotReference) | 由任务/报价受控创建服务从真实记录核验固定绑定；幂等同内容返回原集合，异内容冲突；普通结果到达不能隐式创建空集合 |
| registerSourceFromBusiness({target,ingestId,expectedHeadRevision,businessReference}) | 只接受受控业务定位；内部锁头、核验真实行/不可变版本并构造来源payload，结果事实与来源/代/回执共同保存；不接客户端自报payload作为生产来源 |
| claimDispatch({target,executionId,attemptId,expectedFenceVersion}) | 锁头并核验未关闭栅栏，保存发送资格事实；事务提交后才允许外部调用。已获资格但是否发送不明仍unknown，不自动再次发送 |
| closeExecution({target,executionId,expectedFenceVersion,closureBusinessReference}) | 锁头核验所有资格/结果登记与关闭事实，追加fence/closure；不得用Abort、queued或租约过期替代关闭证据 |
| sealCollection({target,expectedGeneration,expectedHeadRevision,kind,references}) | 同头锁枚举全部历史版本/业务关联，核验固定快照/发送关闭/结果/校验/报价，追加seal/member并更新头；显式引用不缩小全成员范围 |
| readSeal(workspaceId,sealId) | 来源读取权限后读取不可变完整清单，缺失/不全拒绝；只是历史来源读，不返回published或结算投影 |
| readIngestReceipt(workspaceId,ingestId) | 授权恢复同一个已提交登记；未读到不证明未提交，不能丢弃暂存或换ID |

已有内存简化SourceVersion不包含完整业务证明、fence/closure等，不能原样作为数据库生产API。具体TypeScript运行时形状、错误类型、测试seam需在各实施切片前由用户确认。

registerSourceFromBusiness定位已存在的不可变业务事实；若业务事实尚未持久化，D2必须改造其专用保存入口，让业务事实保存和来源登记共享仓储内部连接，并共同提交。不得先调用旧独立候选仓储提交，再用新事务登记来源。具体事实字段只能由受认证内部适配传入并核验，不由浏览器提供。通用签名不是业务保存已经原子化的承诺。

### 锁序与新增资料

建议 READ COMMITTED + 共同来源头 `FOR UPDATE`，所有正常Writer、关闭、封存及未来发布遵循同头屏障。先锁头，再核验/锁必要业务行；多集合按固定(workspace,collection)顺序，业务行再按固定类型/主键顺序。现有业务Writer如果先锁业务行再来锁头必须改造，不能留反向路径。D3完整顺序为请求身份→来源头→业务核验/不可变前序读取。

受控初始化用unit唯一约束串行化新集合创建：同内容重复不覆盖固定快照，异内容冲突。对不存在集合的FOR UPDATE不会制造行锁，不能以空查询充当屏障。

无封存时：新资料在当前代追加，同时head_revision增加并更新计数。observation后首条新资料：同事务generation+1、清空current_seal指针，保留旧seal和全部成员；同代后续资料继续追加。同版本同内容重放不推进代；同版本异内容保存冲突事实到隔离并返回显式结果/待核对，不伪装为成功成员，也不能丢弃新事实。

final之前出现隔离冲突也必须同头锁增加未决标志/head_revision；若已有observation，则推进新代并清空当前指针。未决冲突阻止新封存及新发布，不能把矛盾藏在隔离中继续声称空结果unknown。旧已发布observation仍可历史读取。解冲突需独立授权裁决方案，本轮没有自动清除标志的入口；final之后仅记录隔离，不改原final结论。

final后：正常来源和发送资格入口不得重开集合。可信采集把晚到/矛盾事实写入独立隔离及登记回执，保持final指针/代/成员不变。隔离保存失败返回可恢复失败，采集方保持可靠暂存。异常重开/人工裁决及自动补扣不在接口内。

发送资格提交→实际网络调用之间存在崩溃窗口，DB锁不能证明外部“恰好一次发送”。可能发送时保持unknown，禁止恢复流程重投模型；未来独立发送适配器必须提供attempt定位与可靠恢复证明。锁内没有模型/网络/Key解密；关闭栅栏阻止新的正常资格和成员，不宣称供应商以后绝不回包。已持有旧资格的在途响应只能走受控接收，关闭后进入隔离。

### 并发登记幂等

拟定来源写入锁序为先锁头→登记ingest回执唯一键/版本→业务行操作（仍须遵守统一业务锁序）；D3发布独立采用请求键→头。来源写入口不获取发布请求锁，发布事务不调用来源登记入口，避免两种身份锁反向嵌套。同ingest跨集合竞争由workspace+ingest唯一键拒绝异命令；重放即使头已推进仍返回原提交结果。回执枚举不暴露未提交数据。

未来请求锁建议单独持久化键行：事务内INSERT ON CONFLICT建立共享键→锁该行→读取完整发布；唯一键解决“尚无行可锁”的并发缺口。备选事务级advisory lock仍需共享唯一键，且要明确hash碰撞与锁命名；仅唯一插入不能代替来源屏障。此处只比较方案，D3锁实现和未发布键容量/留存需另行确认。

## 5. 权限与不可变约束

推荐应用登录角色无表级INSERT/UPDATE/DELETE、无DDL/CREATEROLE/BYPASSRLS，仅获明确受控函数EXECUTE和必要受控读。数据库受控函数由非登录、非超级用户owner持有；各来源登记、发送/关闭、封存、发布、settle读取按职责分开。任何保留的旧表DML/函数入口、继承角色或默认PUBLIC权限都必须审计，不能只保护新表。

如采用SECURITY DEFINER，实施时固定安全search_path、限定schema、撤销PUBLIC EXECUTE、在同一迁移事务授予目标角色，禁止运行角色创建可被搜索到的对象；owner也受FORCE RLS约束并配置其最小策略/权限。不得借超级用户或BYPASSRLS绕过工作室边界。

RLS应用到每个含工作室的表、成员及业务关联；会话上下文SET LOCAL由可信服务器设置并在连接复用后清除。自定义GUC不是认证凭证：数据库函数必须按登录身份映射固定服务，并检查工作室/操作授权，不能只信调用方workspace或可自行设置的serviceId。登录身份/可继承角色映射及撤权模型在D1确认，不把数据库共享账号视为终端用户隔离。

不可变表仅受控追加，不提供正常更新/删除；触发器拒绝更新/删除和非法头回退、固定binding变化；RLS/FK约束保护同工作室/集合/版本关系。FK不能证明真实响应或关闭；触发器和函数必须守同头锁，直接SQL无合法绕过路径。受信管理员仍可能修改权限/资料，需审计及启动预检，不能宣称对恶意超级用户防篡改。

启动预检以只读方式核对角色继承、登录服务映射、表/列权限、FORCE RLS/策略、PK/FK/唯一/范围约束、不可变触发器、函数owner/search_path/ACL/定义指纹及必要索引。缺失/漂移不返回可写仓储，不在运行时修复或执行迁移。来源实库装配完成也不自动开放生产published或收费。

## 6. 容量、时限与恢复（候选，尚未批准）

| 项目 | 内测建议起点 | 确认/压测要求 |
| --- | --- | --- |
| 单元累计正常来源版本 | 256条 | 包含全部历史，明确与现有包校验256条兼容；提高前先升级验证器，超限拒绝，不截断 |
| 单封存规范字节 | 1MiB | 与元数据/源包整体预算核对，不能等同jsonb物理大小 |
| 完整读取来源包/复合记录 | 各自最多2MiB | 保留同样节点/深度/字段上限；数据库规范字节与jsonb存储开销分别监控，不能仅控制单清单 |
| 每单元历史封存 | 64份 | 容量不足不覆盖旧历史；先定义扩容/安全暂停处理方案 |
| 隔离单元/工作室累计增长 | 128条/单元；工作室预算待定 | 超限不能丢事实，必须有独立可靠暂存、告警及人工处理职责；无可靠暂存不接真实采集 |
| lock_timeout / statement_timeout | 1秒 / 5秒 | 仅实验起点，锁等待与语句分别限制 |
| 整体截止 / 池等待 | 10秒 / 2秒 | 协议取消和连接处置实测；整体截止不证明COMMIT没成功 |

以上全部是待确认参数，不能写入生产默认值。工作室总字节/单元数、请求/登记回执总量、连接池大小、p95目标、RPO/RTO、业务来源/隔离/发布审计留存尚待容量和运营方案；不复制项目回收站30天或备份90天作为财务证据删除策略。完整历史被引用时禁止清理，清理/归档/保留期与迁移独立批准。

待核对错误统一净化，不返回SQL、连接地址、模型私密响应或Key。锁/语句超时、死锁、断网、COMMIT响应丢失不得推导执行失败、换request/ingest ID或再次调用模型。确认回滚后可按原身份重试数据库动作；提交状态未知先原身份恢复读取，查不到继续待核对。连接事务状态不明应销毁/隔离该连接，不将未清理连接归还业务池。

采集方在投递前先把事实与固定ingestId可靠暂存；数据库提交回执被确认后才可释放暂存。D1只用测试暂存验证，不实现真正供应商采集持久化。监控锁等待/死锁/事务时长/池等待、容量拒绝、未核对提交、unknown时长、隔离保存失败与积压；日志仅净化代码和必要定位，不记录正文/Key。

## 7. Writer接线清单与启用门槛

| 生产者 | 当前缺口 | D2必须证明 |
| --- | --- | --- |
| 任务/报价创建 | ModelTask无固定计费单元/平台报价 | 任务修订、范围、不可变报价/责任、binding共同建立；不从model usage猜额度 |
| 发送者/恢复执行器 | 租约不能作关闭或恰好一次发送证明 | 每个发送路径受持久化资格/栅栏约束；未知不重投 |
| 候选结果/迟到采集 | candidateVersionId仅选中一个结果 | 原始候选全部登记，业务结果与来源同事务，晚到隔离可靠保留 |
| 关闭证明生产者 | 任务终态不足以关闭全部入集合路径 | 同头核验发送资格/结果事实，旧Writer不能正常越过关闭 |
| 校验与计价 | 未有固定规则/真实记录同锁关联 | 匹配精确结果版本/报价；无效结果不计价、BYOK零额度 |
| 封存者 | 当前简化内存规则非真实业务证明 | 完整列举/合法前序/无未决/关闭证明，不能只选一个结果 |

D1不为上述当前缺口填充虚构默认事实。D3实施前盘点实际所有代码路径、运行角色及直接SQL入口，逐一给出接线证据；未知旧Writer存在时默认禁用。D3通过后仍需独立批准真实结算/计费启用。

## 8. 隔离PostgreSQL验收清单（未来执行）

执行环境必须新建隔离数据库、非超级用户运行角色、至少两个独立连接。通过拟定公开仓储/服务入口观察回执与历史；权限/预检场景允许管理员故障注入，不能用生产数据或内存断言替代。并发用受控事务闸门，不用sleep猜顺序。以下均未执行。

| ID | 场景 | 必须观察的结果 | 对应已有契约 |
| --- | --- | --- | --- |
| DB01 | 受控初始化重复/异绑定、不存在集合登记 | 同内容幂等；异内容/无集合拒绝，无默认空完整范围 | C01/S13 |
| DB02 | 同版本/ingest同内容并发及异内容 | 原回执收敛；异命令冲突/矛盾事实隔离，版本不覆盖 | C06/C14 |
| DB03 | 来源登记与封存双连接竞争 | 都锁同头，合法先后顺序；已纳入成员不遗漏 | S01/C05 |
| DB04 | 第二个原始候选或矛盾历史存在 | 全成员保留，拒绝final/伪空unknown，不只用选中candidate | S02/C06 |
| DB05 | observation后新增/重复重放 | 新资料新代、旧seal不可变；重复不推进代，返回原登记代 | S03/S04 |
| DB06 | claimDispatch与not_sent关闭并发 | 新资格与明确未发送关闭不能同时合法；已有可能发送资格保持unknown | C03/C04/S06 |
| DB07 | 旧资格结果/final后晚到事实 | 正常路径拒绝重开，隔离提交不改变final；失败时可靠暂存可重投原ingest | S05/C05/C14 |
| DB08 | 业务关联/规则/结果/报价/前序篡改 | 整体拒绝，不换最新引用；BYOK金额必须0 | C02/C07/C08 |
| DB09 | 版本、业务行、head、receipt任一步故障 | 全部回滚；无半份成功回执，无有业务无来源的正常结果 | C10 |
| DB10 | 锁等待/语句超时、死锁、COMMIT响应丢失 | 原身份恢复，不重复模型；未知连接不复用，确认结果前保留事实 | S10/C11 |
| DB11 | 跨工作室、伪造GUC/身份、直接DML/旧入口 | 拒绝；服务身份映射/权限不能只凭GUC，错误脱敏 | S07/S14/C13 |
| DB12 | 角色/RLS/FK/函数/触发器/索引漂移 | 启动只读拒绝，不自修复、不返回写仓储 | C13 |
| DB13 | 清单/包/历史/隔离容量越界 | 拒绝、不截断不删除历史；事实可靠暂存并告警 | S13/C14 |
| DB14 | 连接复用、分页、非ASCII规范字节 | 工作室上下文不串租户；历史稳定完整，指纹跨语言一致 | S09/S14 |
| DB15 | 旧Writer业务行先锁再锁头 | 接线/锁序检查拒绝部署；不能以死锁重试掩盖反向写路径 | S07 |
| DB16 | D3 v1/v2同键竞争/四对象/历史读取 | 单共享身份不双发；回滚/原回执收敛；裸资料不投影，历史不改结论 | C09-C12/C15/S08/S11/S12 |

DB16属于后续D3验收，不计入D1已交付。全部DB测试尚未执行，本轮只能检查设计覆盖。

## 9. 下一实施切片与批准事项

推荐先确认D1a：不可变来源集合/版本/完整清单的迁移草稿及只读启动预检；随后D1b受控写入口/发送关闭/隔离规则和真实双连接测试。每个切片先确认具体seam与参数，再TDD、Standards/Spec审查、本地提交。不得跳过D2直接接生产发布。

D1a本身需要另行批准：是否允许创建迁移文件、仅隔离库执行范围、角色/函数权限方案、工作室服务映射、规范化/排序规则及容量/超时参数。不访问现有业务库，不安装扩展、不读取真实密钥、不发模型请求。

本轮架构取舍保持ADR0004/0005：共同头锁而非点时检查；同数据库而非外部签名自动回退；持久化记录而非内存清单作为生产权威。新的具体锁/权限/参数建议尚未决议，确认后再记录独立ADR，不将设计草案写成Accepted。

## 10. 技术依据

行锁阻止其他事务对同一行冲突写入/锁定，但不是普通读取或不存在行的通用屏障；应用必须统一锁序。[PostgreSQL16显式锁文档](https://www.postgresql.org/docs/16/explicit-locking.html)。

RLS不替代认证，超级用户和BYPASSRLS可绕过；表owner默认也有特殊行为，需要FORCE RLS及最小权限。[PostgreSQL16行安全文档](https://www.postgresql.org/docs/16/ddl-rowsecurity.html)。

SECURITY DEFINER需安全search_path并谨慎配置默认PUBLIC执行权限。[PostgreSQL16函数文档](https://www.postgresql.org/docs/16/sql-createfunction.html)。以上资料支持技术约束，不证明本项目已实现或通过实库验收。

## 11. 本轮文档检查

已检查本地引用目标存在、DB01～DB16标签完整、git diff无空白错误；Standards和Spec审查均无阻断。Standards建议将成员唯一键中的workspace显式列出，已修正。仅修改本设计、契约进度和T09说明；未增加运行时代码、迁移或数据库验收结果。本轮未重新运行代码回归，上一实现提交的300通过/18条件跳过不能计作本设计的实库验收。
