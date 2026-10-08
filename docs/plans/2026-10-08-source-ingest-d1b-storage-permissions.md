# D1b独立隔离存储、权限与事务方案

日期：2026-10-08。状态：设计候选；用户批准本轮文档，不批准可执行SQL、授权、代码或数据库执行。依据[隔离测试来源](2026-10-08-source-ingest-fixture-design.md)、[D1b契约](../contracts/EVIDENCE_SOURCE_D1B_INGEST.md)、[ADR0004](../adr/0004-evidence-source-seal.md)。不覆盖D1a、不接生产Writer、发布或收费。

后续增量：用户已确认独立SQL草稿阶段，选择受控锁定helper与本文实验容量/锁序。见[草稿交付记录](2026-10-08-source-ingest-d1b-sql-draft.md)；本篇下文保留提出候选时的设计记录，SQL执行/运行仓储仍未批准。

## 1. 目标与选择

在独立PG16/UTF8实验配置内，用四类已提交不可变测试资料核验task/snapshot登记，保留共同workspace/ingest键、完整关联、原子回执和当前授权。所有名称为逻辑候选，不是迁移或可调用函数。

关键取舍：增加稳定工作室预算行作为写事务串行点。它解决跨集合共享登记键的缺行竞争，并使容量累计可原子核验；代价是同工作室写入串行，首个隔离切片可接受，不能称生产吞吐设计。仍保留来源头屏障，后续Writer接线不能绕过头。预算行由实验准备阶段建立，运行时缺失则拒绝，不在首次命令中隐式创建工作室。

备选：每ingest独立保留行/事务advisory锁可提高并发，但增加未提交保留行、哈希锁碰撞和容量锁组合；延期。仅空FOR UPDATE或每集合独立map不能解决跨集合唯一登记，拒绝。

锁序候选记录为[ADR0007（Proposed）](../adr/0007-source-ingest-fixture-lock-order.md)，不得将本轮设计授权视为接受新锁序。

建议独立逻辑命名空间source_ingest_d1b_fixture_v1。D1a草稿、角色和预检保持原状；未来新草稿留在sql-drafts，不进migrations，不由应用启动自动执行。仅隔离测试profile可装配，标记fixture不提供认证或生产防护。

## 2. 逻辑存储与约束

每个业务/来源定位包含workspace。四类业务内容与前序/固定引用沿用方案A；本设计不批准task追加白名单运行时启用。

| 逻辑对象 | 键/必需字段 | 约束和索引意图 |
| --- | --- | --- |
| task_revision | PK(workspace,id,version)，UNIQUE(workspace,id,revision)；完整严格业务内容、规范字节/指纹、固定快照/执行引用 | 同实体前序FK；revision连续由受控登记核验。id=taskId，scopeKeys固定单unit；不可更新/删除 |
| fixed_snapshot | PK(workspace,id,version)；固定任务锚点/执行/报价引用、完整业务内容及规范字节/指纹 | 对task_revision、execution_identity、fixed_quote精确复合FK；固定责任与报价相等需受控核验，FK本身不证明相等 |
| execution_identity | PK(workspace,id,version)；固定task锚点、snapshot引用、binding与规范内容 | task/snapshot复合FK；无发送/关闭/结果字段，不能登记execution来源 |
| fixed_quote | PK(workspace,id,version)；task锚点/执行引用、quoteId/priceVersion/责任/预留/规则与规范内容 | 精确业务FK；BYOK预留0/platform正安全整数；不含消费金额 |
| collection | PK(workspace,collectionId)，UNIQUE(workspace,unitId)；固定binding、初始化任务/快照/执行/报价引用及业务指纹、初始来源引用、头状态与计数 | 所有固定引用不可替换；首切片generation=1，head正安全整数；有历史/final/未决则新登记阻塞，不伪装完整关闭 |
| source_version | PK(workspace,collection,kind,id,version)，UNIQUE(workspace,collection,kind,id,revision)；来源投影规范字节/指纹、生产者/规则/时间、前序、introducedGeneration | kind仅task/snapshot；同集合/实体前序复合FK；来源枚举索引以workspace/collection开头；不可修改/删除 |
| task_source_link / snapshot_source_link | PK对应完整source_version键；精确业务引用/完整业务指纹、投影规则、核验服务/时间；snapshot还绑定quote | 各自类型固定，FK到精确业务行、来源及报价；不以通用JSON业务类型字段代替类型FK；恰一关联由事务/核验函数保证 |
| ingest_receipt | PK(workspace,ingestId)；完整命令规范字节/指纹、操作/固定登记服务、collection/unit、提交代/头/status/time | 不将protocol/operation/service/collection加入唯一键；不可修改/删除，合法状态匹配操作，由仓储只返回完整提交 |
| receipt_source_member | PK(workspace,ingestId,ordinal)，UNIQUE同receipt来源完整定位；来源指纹 | receipt、collection与source同workspace且同collection复合FK；初始化固定task/snapshot顺序、两项；登记一项 |
| workspace_budget | PK(workspace)；已提交回执数/字节及来源数/字节累计 | 提前准备且不删除；写事务持排他行锁更新，拒绝溢出，不做保留成功回执或请求身份 |
| service_principal / workspace_service_grant | 登录主体唯一固定serviceId/启用状态；PK(workspace,serviceId)稳定许可行，enabled/version、操作/kind/业务生产者及回执生产者许可 | 只由受控管理员更新，关闭而非删除；服务身份映射和许可均持锁复查，不信任客户端/GUC |

FK循环（初始任务/快照/执行/报价）候选采用准备事务中延迟校验，提交前全关联有效；FK具体可延迟性与唯一引用列由未来SQL审查冻结。没有级联删除。集合及回执复合唯一目标需含collection供成员FK核验；关联表kind常量与来源kind绑定，避免把snapshot关联到task。每个FK引用侧按实际定位增加前导workspace的复合索引，不引入泛用GIN。

正常角色不拥有直接DML/TRUNCATE/DDL；不可变行仍需拒绝UPDATE/DELETE/TRUNCATE的数据库保护，头/预算只允许受控增量。普通FK不能保证初始化恰两项、来源恰一关联、计数正确或指纹真实，必须在受控函数末尾核验完整性，失败全回滚。D1a预检不能验收这一新结构。

### 字节、数字及指纹边界

数字使用bigint但限制JavaScript安全整数；服务端不得把溢出值转number或截断。来源payloadFingerprint与完整业务指纹分别保存，规范字节长度按UTF8 octets计算，不按jsonb::text或字符数。数据库保留结构化内容与规范字节，两者语义和摘要要共同验证。

source-ingest-v1算法不变；运行时数据库入口不能接受未验证的prepared命令/哈希。候选数据库端为本固定字段树生成相同规范编码并校验摘要，完整业务树规则也需固定向量；是否使用摘要扩展和具体函数定义待另批。未完成跨语言编码验证前不能开放写函数。数据库不拿jsonb::text重算JS协议。

Postgres文本无法无损存储NUL及孤立代理项；适配器须在发送前拒绝不可表示文本，不让驱动替换字符后写入不同身份，返回净化INVALID_COMMAND。该存储拒绝不改变既有纯函数允许集/历史指纹；合法中文/非BMP必须以UTF16限长及原始UTF8字节验收。不可表示案例必须独立测试，不能称两层接受集完全相同。

## 3. 登录身份、权限与RLS

候选职责拆分：schema owner、mutator函数owner、reader函数owner、fixture准备管理员、授权管理员、登记login、恢复login、只读目录inspector。owner均NOLOGIN/非super/非BYPASSRLS；登录角色不得继承或SET ROLE为owner、管理员或其他服务。固定session_user映射serviceId，不取SECURITY DEFINER里的current_user当调用者，不用客户端serviceId/GUC认证。

| 职责 | 数据/函数权限候选 |
| --- | --- |
| 登记login | 仅被批准initialize/register的受控入口EXECUTE；read另批。无任何表读写/DDL |
| 恢复login | 仅receipt读取入口EXECUTE；工作室及allowedProducerServiceIds显式许可。无登记/业务裸读 |
| fixture准备管理员 | 仅实验准备工具执行及四类业务装载；与运行服务隔离，不调用生产者或发模型请求 |
| 授权管理员 | 仅变更稳定principal/grant行的受控管理入口；不锁头/预算、不修改来源或回执 |
| mutator/reader函数owner | 按职责最小表权限，受FORCE RLS；不持DDL/角色管理，不可由login切换 |
| inspector | 仅独立目录预检；不得返回仓储或读取业务数据 |

所有数据表ENABLE+FORCE RLS，PUBLIC无执行/数据权和创建对象权，SECURITY DEFINER入口固定可信search_path并将临时命名空间放末尾、对象显式限定。受控入口不接任意SQL/动态对象名/外部事务client。禁止创建重载入口、任意函数执行或临时对象遮蔽。所有未来查询参数化。

RLS作用分层：mutator仅对真实登录有写操作许可的workspace可见，受控入口再核验本次操作/kind/允许业务producer；reader策略同时约束workspace和回执登记服务范围，并通过查询预过滤，与范围外不存在统一null。成员审核权限不进入此映射。受控函数内权限错误先于业务/冲突查询；缺映射、disabled、许可异常默认FORBIDDEN。不得把同workspace内已授权写命令的共享键冲突查询与恢复reader范围过滤混为同一权限。

执行ACL和RLS只是部分保护；每次操作仍从登录映射读许可。可选init/register同一SQL mutator owner不意味着一个操作许可推导另一个；数据库函数分别显式检查操作及kind。原业务producer许可与回执producer许可是两套集合，后者指登记服务，不应默认接受任意源行生产者。

principal/grant控制表的RLS应采用仅固定内部职责可读/管理的非递归策略，不在其自身策略里再次查询自身授权表。业务策略所需内部映射读取不能变成login可自由执行的枚举接口；具体受控helper/owner最小权限和策略定义纳入新预检，再逐项实库验证。

## 4. 撤权屏障和完整锁序

推荐READ COMMITTED；稳定principal行与workspace_service_grant行采用共享行锁到事务结束，之后才判断enabled/版本/操作范围。授权管理员按相同principal→grant顺序取得冲突锁，再更新启用/许可；不删除授权行，不先持预算/来源头。仅FOR KEY SHARE不能阻止非键许可更新，故候选用FOR SHARE。相关机制以[PG16行锁文档](https://www.postgresql.org/docs/16/explicit-locking.html#LOCKING-ROWS)为依据，撤权线性化仍须双连接实测。

撤权语义：写/读取先获许可锁则可在撤权提交之前完成本次事务，撤权等待它结束；撤权先持锁并提交则后续操作读到新许可拒绝。不是管理员发起撤权的瞬间取消在途请求，也不能撤回已发送响应。等待锁之后复查最新许可；所有映射/授权更新路径必须守此屏障，外部缓存复查不替代它。

锁权限前置条件：不能只授SELECT却假定FOR SHARE可执行。后续SQL须列出所需列级UPDATE权限或独立受控锁定helper。候选为仅专用锁标记列的权限并以不可变保护拒绝实际修改，或限定内部owner可调用的锁定helper；二者具体选择/ACL/RLS仍待批准，不给reader/mutator整表授权修改权。必须实测“允许取得共享锁、拒绝修改enabled/serviceId/许可范围及锁标记、login不能直接调用内部helper或切换owner”。没有这一证明则新profile/仓储不得放行。

```text
principal共享锁 → workspace grant共享锁 → 当前授权与严格命令
  → 已提交回执只读历史重放（无预算/头变化）
  → 新写：workspace budget排他锁 → 再查共享键胜者
          → unit唯一竞争/来源头锁 → 登记版本核验 → 精确不可变业务读取
          → 来源/类型关联/头/回执成员/回执/预算 → 完整性检查 → COMMIT
```

workspace预算锁先于头，为新增外层串行点，保留内部头→登记版本→业务顺序。跨集合同ingest因同workspace预算串行；第二次共享键查询为已提交只读，不是反向锁定回执。空查询不锁键；串行点是已存在预算行。初始化单unit唯一竞争仍保留，但不把预算行或空集合单独commit当保留请求。任何未知/失败均整个事务回滚或待核对，无半份回执。

read先按同序锁授权行再做受范围约束的完整历史关联查询，不锁预算/头，也不要求当前头等于提交头；授权锁持到读事务结束。它可能与在途写并行返回null，不能推导未提交。历史回执重放也无需活动业务查找，核验原不可变关联及当前授权即可。新ingest既有版本仍持预算/头并核验精确业务，成功保存already_registered新回执只增回执预算。

每事务只一个workspace、一个unit和一个命令，不提供批量、多集合操作或嵌套调用。准备业务事务完成后登记仅读取它，不逆向锁装载业务行；测试管理员篡改注入必须与正常运行隔离。D2/D3若新增路径须重新审查外层授权/预算与发布请求锁组合，本设计不提前保证其无死锁。

## 5. 容量与超时候选

仅供隔离实验、尚待用户确认：每workspace最多1024成功回执、16MiB回执规范字节及成员/命令规范字节合计；单回执最多16KiB。每unit继续最多256来源、来源包2MiB；workspace合计最多4096来源/32MiB规范来源与业务关联字节。四类准备业务合计最多4096行/16MiB规范字节，装载工具预核验。容量不是实际PG磁盘/索引上限；不得宣称生产预算。

新增回执（含already_registered）在同预算锁内按候选定义精确计费字节并累计；历史原命令重放不新计数，满额仍可当前授权读取/重放原回执。超限CAPACITY，来源/头/预算/回执一起回滚，不删历史、不截断。receipt字节定义包含完整命令/回执/有序成员，但不重复计入共享业务/来源；来源预算涵盖新增投影、业务关联，集合固定资料计入对应unit包预算。计算公式/固定向量仍须实施前冻结，异常计数不自动修复。

候选沿用池等待2s、锁等待1s、语句5s、整体事务10s，另限制idle-in-transaction 5s；均非已实现默认或SLA。应用整体截止负责多语句/COMMIT未知，不把单statement_timeout当整个事务时限。锁内无外网/模型/Key；连接异常销毁，UNAVAILABLE只触发原身份恢复，不重发模型、不自动换头/ingest。暂不新增worker或后台重试。

## 6. 独立预检与隔离验收

未来预检须核对新profile固定数据库/命名空间/版本、PG16 UTF8、角色及继承/SET ROLE链、登录映射、ENABLE/FORCE RLS/策略、表/列ACL、PUBLIC/default ACL、函数owner/定义指纹/search_path/EXECUTE、约束/唯一键/FK/索引、不可变保护、受控头/预算修改和编码向量。必须拒绝漂移，不能在预检中补表/授权，也不接受仅fixture标志证明隔离。装配签名/数据库标识与策略指纹另批，目录检查通过不自动启用来源仓储。

| ID | 待执行场景 | 预期 |
| --- | --- | --- |
| P01 | 新profile健康、错误D1a/业务库/profile标识 | 健康仅可进入下一装配批准；错误拒绝，无迁移/grant自动修复 |
| P02 | login直DML/TRUNCATE/DDL/SET ROLE或PUBLIC调用 | 拒绝；受控入口内操作/kind独立授权 |
| P03 | 伪GUC/serviceId/current_user/临时对象遮蔽 | 不改变session_user绑定或对象解析，错误净化 |
| P04 | 两服务两集合复用同workspace/ingest | 一个原回执或CONFLICT，不重复占键，不反向持锁 |
| P05 | 同unit初始化竞争及缺预算/空头 | 唯一正确集合；缺预算拒绝，不用空查询伪锁 |
| P06 | 授权先获锁/撤权先获锁、读许可更新 | 两种合法顺序，撤权提交后的新请求拒绝；无即时取消假承诺 |
| P07 | 两连接逐步故障与COMMIT响应丢失 | 原子共同可见或原身份待核对，null不证明失败 |
| P08 | 四类资料循环FK/版本错配/少成员少关联 | 提交拒绝，完整关联不由JSON引用替代 |
| P09 | 满额同key历史重放/新already_registered | 前者不增预算；后者CAPACITY，不删历史或推进头 |
| P10 | 预算/业务规范字节/摘要/权限/RLS漂移 | 预检或完整性核验拒绝，无自动修复 |
| P11 | 中文/非BMP/NUL/孤立代理与编码向量 | 可表示字符精确匹配，无损存储；不可表示输入发送前拒绝 |
| P12 | 锁/语句/整体/idle超时与会话异常 | 有界净化UNAVAILABLE，未知连接销毁，原ID恢复 |

P01～P12与F01～F18/I01～I16均未执行；至少P02/P04～P08/P12需要独立连接和真实角色，mock不能替代。未来只能用户另批临时PG16实例，无TCP、合成资料、预检隔离路径，测试后清理测试库/角色并停止；本轮未执行这些操作。

## 7. 依据、风险与批准点

安全技能影响：不采用示例GUC作为身份，拆分调用者与definer身份，不把RLS当全部认证。Postgres技能影响：最小权限、FK侧索引、短事务及一致锁序，选择可解释的粗粒度串行而非未经证实的细粒度并发。

主要风险是编码实现差异、许可锁遗漏、预算公式不完整和fixture误接生产。缓解为跨语言固定向量、所有授权管理路径双连接测试、原子预算验收、独立装配白名单及默认生产禁用。仍不防恶意超级用户；备份/留存/删除与生产规模未设计。

参考：[PG16受控函数安全与search_path](https://www.postgresql.org/docs/16/sql-createfunction.html#SQL-CREATEFUNCTION-SECURITY)、[PG16 RLS](https://www.postgresql.org/docs/16/ddl-rowsecurity.html)。这些是技术机制依据，不是本方案已实现的证明。

下一步先批准：字段与task白名单、预算外层串行点、授权共享锁语义、容量/时限及新profile。之后才能另批写独立可执行SQL草稿和预检接口；SQL执行、运行仓储实现及生产接线各自独立确认。

本轮检查：Standards/Spec审查均无阻断；补充共享锁必要权限及防授权变更的实施前置条件。本地引用、P01～P12编号及git diff检查通过，仅文档未重跑代码/数据库测试。
