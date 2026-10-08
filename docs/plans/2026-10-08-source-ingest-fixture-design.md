# D1b隔离测试业务来源与最小仓储设计

日期：2026-10-08。状态：方案A文档交付；用户批准测试来源契约、最小仓储接口设计与验收用例，不批准代码、SQL、角色授权或数据库执行。字段及接口为候选，实施前仍需确认。依据[D1b登记契约](../contracts/EVIDENCE_SOURCE_D1B_INGEST.md)、[ADR0004](../adr/0004-evidence-source-seal.md)、[ADR0006](../adr/0006-source-ingest-isolated-fixture.md)。

## 1. 目标、缺口与非目标

已有prepareSourceIngestIdentity只验证严格命令、计算指纹并返回共享键，不认证服务或证明业务来源。现有ModelTask缺固定报价、单元及独立执行身份；旧v2-source-bundle-fixture自造businessRecordId和payload，只证明资料一致性。不得直接把任一对象当成真实业务证明。

本设计供后续隔离实验：先保存独立的不可变测试业务行，再由仓储在共同事务内读取精确版本、核验交叉关联并构造task/snapshot来源。测试成功只证明测试资料与登记的对应关系，不证明生产任务、模型发送、结果完整、执行关闭、封存或收费。

不新增HTTP页面、不改变已冻结source-ingest-v1指纹、不接现有任务仓储、不调用模型、不解密Key、不注册execution来源，不创建生产装配。D1a原草稿/角色/预检仍封闭；未来D1b必须独立版本与配置，不能给D1a临时grant来绕过验收。

## 2. 测试资料定位与不可变模型

以下是逻辑资料，不是SQL表声明。所有定位键均为(workspaceId,id,version)，业务类型也参与类型隔离；不使用全局id或按version文本排序。ID沿用source-ingest-v1/v2规则，数组有序且不可重复，JSON严格且有界。不得从浏览器提交这些资料；由测试管理员在隔离实验准备阶段装载，运行登记角色不能创建/修改它们。

共同字段：id、version、binding、producerServiceId、recordedAt。binding严格包含workspaceId/taskId/unitId/projectId/chapterId/sourceVersionId/upstreamVersionIds；定位workspaceId必须与binding相等。producerServiceId来自测试生产者映射而非命令；recordedAt为规范UTC时间。所有行已提交且禁止更新/删除；同键同规范内容准备可重放，同键异内容拒绝。资料装载权限、唯一性、不可变约束尚未实现。

| 测试业务资料 | 必需专有字段及约束 |
| --- | --- |
| TaskRevision | revision正安全整数；predecessorVersion首版null；scopeKeys本最小实验固定为[unitId]；snapshotReference、executionReference固定定位。id等于binding.taskId；初始化revision=1 |
| FixedBillingSnapshot | responsibility为platform/byok；quoteReference；quoteId、priceVersion、reserved；taskAnchorReference固定到初始任务；executionReference。首版只有一个版本，禁止新版本换报价或责任 |
| ExecutionIdentity | taskAnchorReference、snapshotReference；id为executionId。仅固定身份，没有state/closed/attempt/result/lease或关闭证据；首版一个固定版本，不从任务revision生成新executionId |
| FixedQuote | quoteId、priceVersion、responsibility、reserved、pricingRuleVersion、taskAnchorReference、executionReference。绑定同binding、任务锚点和执行定位；平台reserved为正安全整数，BYOK为0，不含usage或实际消费amount |

FixedQuote是隔离实验中独立已保存的固定报价资料，不是生产报价器。FixedBillingSnapshot的quoteReference精确定位它；quoteId/priceVersion/responsibility/reserved及binding逐字段一致。缺报价不能用常量、model usage或快照自报金额补齐。快照的报价规则权威来自该精确FixedQuote，仍不构成计价/结算来源。这样明确“读真实测试行”的核验路径，同时保留D2生产报价缺口。

任务、快照、执行三者在测试装载时组成一组固定资料，引用循环通过同一次准备事务解决；不能运行登记时临时拼凑缺行。任务锚点始终指TaskRevision第1版。后续TaskRevision仅沿原实体版本链推进，快照/执行中的锚点不改成活动任务版本。

### 关系图

```text
TaskRevision v1 ── snapshotReference ──▶ FixedBillingSnapshot ── quoteReference ──▶ FixedQuote
       └──────── executionReference ──▶ ExecutionIdentity ◀── executionReference ── FixedQuote
FixedBillingSnapshot ── executionReference ──▶ ExecutionIdentity
FixedBillingSnapshot ◀── snapshotReference ─── ExecutionIdentity
三者与报价均核验相同binding；快照/执行/报价的taskAnchorReference指向TaskRevision v1
TaskRevision v2 ── predecessorVersion ──▶ v1（binding、scope及固定引用不变）
```

## 3. 从业务行构造来源，而非接受payload

initialize严格命令仍只接受已有taskReference/snapshotReference/executionReference；报价从快照的固定引用读取，不向命令加字段。新命令在同事务核验：

1. 固定服务器身份与source_initialize授权；准备命令并检查共享键历史回执。
2. 锁定/竞争来源单元，精确读取四类已提交业务资料；类型、版本或工作室缺失则拒绝，不查询“最新”。
3. 所有binding逐字段相等，upstreamVersionIds和scopeKeys按顺序比较；命令workspace/unit与业务一致。
4. task.id等于binding.taskId；task的快照/执行引用等于命令；snapshot/execution/quote的初始taskAnchorReference均等于命令taskReference，快照与执行相互引用一致；快照与报价一致。
5. 初始化只能task revision=1/predecessor=null、固定snapshot/execution首版本；测试来源不带发送或完成结论。
6. 从行投影两份来源，与集合、业务关联、头及回执共同提交。不存在半空集合，也不把ExecutionIdentity登记为execution来源。

来源payload保持已有逻辑：task={binding,taskRevision,scopeKeys}；snapshot={binding,responsibility,quoteId,priceVersion,reserved}。payloadFingerprint为服务端由精确投影计算，不能使用装载方指纹代替计算。来源id/version对应实体业务id/version；task来源revision来自TaskRevision.revision，snapshot首版revision=1/predecessor=null。source recordedAt与producer来自精确业务行；登记核验服务与时间另记，不冒充原生产服务。source ruleVersion取服务器固定的实验投影规则，不从业务JSON自由选择。

业务关联最少保存：sourceKind/id/version/payloadFingerprint、workspace、业务类型/id/version、完整业务规范内容指纹、投影规则版本、verifiedByServiceId、verifiedAt。snapshot关联还记录精确quoteReference及其规范指纹；集合初始化关联记录ExecutionIdentity及其规范指纹。完整业务指纹包含固定引用、binding、前序、producer/time等全部严格字段；来源payload指纹仅覆盖投影，两者不能混用。具体关联存储形状/规则常量/编码固定向量待下一切片确认。

### task追加版本的候选白名单

仅允许相同TaskRevision实体、revision=当前已登记task最大revision+1、predecessorVersion精确指向该版本；绑定、scopeKeys、snapshotReference、executionReference完全不变。可变化字段仅version/revision/predecessorVersion/recordedAt；生产者固定不变，recordedAt不能倒退。不包含模型状态、结果选择、提示词、报价或执行变更。合法前序来自业务链及登记记录，不接受请求自报。初始化资料不得以rev2跳过rev1。

该白名单只是设计候选，未获运行时批准前新task版本默认拒绝。snapshot登记仅重放已固定版本；同内容新ingest产生already_registered而不推进头，新snapshot版本即使报价相同也拒绝。拒绝保留原来源；真实冲突必须可靠保留事实，不能把此实验用于生产采集。

## 4. 最小仓储interface（仅设计）

```text
SourceIngestRepository {
  initializeSourceCollection(command: unknown): Promise<IngestReceipt>
  registerSourceFromBusiness(command: unknown): Promise<IngestReceipt>
  readIngestReceipt(workspaceId, ingestId): Promise<IngestReceipt | null>
}
```

命令结构/回执字段/错误沿用D1b契约，不接受preparedIdentity、payload、金额、serviceId、SQL、Pool或transaction client作为方法参数。仓储内部固定服务身份、当前授权器、生产者范围、投影规则、连接与时间资料；装配factory名称及签名仍待确认。prepareSourceIngestIdentity结果由仓储自行产生，不能用外部prepared绕过校验。

测试资料装载属于独立测试工具，不是仓储方法、业务HTTP或动态adapter回调。未来测试通过这三个公开方法及独立事务观察者验证共同可见性；对故障/闸门的控制仅允许隔离测试装配，不在生产interface加任意SQL/回调。数据库权限测试可以检查真实角色权限，不以mock替代。

共享(workspace,ingest)跨初始化/登记/集合/服务唯一；相同命令授权历史重放原回执，不依赖当前头。新命令必须遵守期望头和单元固定资料；返回完整关联的独立副本。回执不泄露完整业务资料或报价细节，producerServiceId是固定登记服务（不是任意原行producer）。read按allowedProducerServiceIds预先过滤，空范围FORBIDDEN、范围外与不存在同null。缺损关联INTEGRITY_CONFLICT，不按当前活动版本修复。

## 5. 原子性、安全与运行成本

继承头→登记身份/版本→固定业务的锁序；初始化无头以单元唯一竞争解决。真实授权/撤销锁顺序及不存在ingest行的串行机制必须另定，不以空FOR UPDATE声称锁住。不允许测试资料装载与登记反向锁竞争；准备先完成，登记仅精确读取不可变资料。来源/关联/头/回执同连接事务提交，装载业务行先前已提交；不声称已实现D2新业务事实+来源共同保存。

服务身份来自固定装配/真实登录映射，测试行producer按受控类型许可核验；知道id不是授权。多工作室/生产者权限分别验收，不继承成员审核或账本读写权限。未来隔离profile必须由受控测试启动路径和独立数据库配置装配；单个origin="fixture"字段或调用者环境flag不能提供生产防护。生产入口保持不存在/禁用；具体数据库标识/角色预检方案须另批。

未知COMMIT、超时/断网维持UNAVAILABLE及原ingest恢复，不换ID、不调用模型；null不证明未提交。损坏连接销毁。容量继承每单元256来源/2MiB候选，初始化两来源计数，装载资料/回执总数与字节预算仍待批准；不删历史释放容量。lock1s/statement5s/整体10s/池2s仅前文候选，未作实现默认。性能目标是有界本地核验，尚无实测SLA/RPO/RTO；仅可用合成资料，无小说正文/Key/供应商响应，日志只净化操作与定位。运维成本限定独立临时实验，禁止长期服务、云资源或额外队列。

## 6. 未来验收清单（本轮未执行）

| ID | 方法/场景 | 应观察的结果 |
| --- | --- | --- |
| F01 | 四类已提交资料合法初始化 | 回执initialized，代1/头1，恰两初始来源及完整关联；不得封存/发布 |
| F02 | 缺报价/任务/快照/执行，或定位类型错 | NOT_FOUND/INTEGRITY_CONFLICT，整项拒绝，无默认资料 |
| F03 | binding任一字段/上游顺序/固定引用错配 | 拒绝，无集合或成功回执；不切活动版本 |
| F04 | 自报payload/producer/金额/complete/SQL/client | INVALID_COMMAND，不产生查询写入权威 |
| F05 | platform正预留、BYOK零预留及快照报价错配 | 合法责任分别通过，非法/非安全整数拒绝，不计算消费 |
| F06 | task合法v2前序与范围固定；跳版/乱序/改执行 | 经白名单批准后仅合法版本登记，代1/头+1/成员+1；其他拒绝 |
| F07 | snapshot新版本/同键异内容 | 拒绝，不覆盖固定快照；事实保留责任明确，不伪装已隔离 |
| F08 | 初始化/登记/不同集合共享ingest并发 | 同指纹一个原回执，异指纹CONFLICT，无两份成功事实 |
| F09 | 同unit不同ingest同内容/异内容初始化 | 同内容收敛，异内容拒绝；集合不重置 |
| F10 | 新ingest重登记同版本/历史头已推进重放 | already_registered不推进头；原命令返回原回执，不重新核验活动资料 |
| F11 | 事务逐步故障/独立连接在途观察 | 无半份成功关联，回滚全无；闸门释放后只共同可见 |
| F12 | COMMIT响应未知/恢复暂不可见 | 原ID重放/查询核对，null不当未提交，不重调模型 |
| F13 | 工作室/操作/kind/原行producer未许可、撤权 | 当前授权拒绝；撤权与写入线性化待实库规则验证 |
| F14 | 回执同工作室生产者范围内/外/空许可 | 范围内完整可读；范围外同不存在null；空许可FORBIDDEN |
| F15 | 缺关联/业务指纹损坏/输出副本被改 | INTEGRITY_CONFLICT；不修复为最新业务行，其他读取不受修改影响 |
| F16 | 封存历史/final/未决/新代，登记新命令 | STATE_BLOCKED；已提交原命令仍按当前授权历史重放 |
| F17 | 原始业务行被直接UPDATE/DELETE/类型替换 | 隔离权限/不可变约束拒绝；管理员故意破坏用例显式失败，不声称防恶意超级用户 |
| F18 | 容量边界/Unicode与跨生产装配 | 超限拒绝不截断；ID沿原UTF16规则；测试来源不能装配生产published或收费 |

F01～F18是未来实验验收，不等于已执行测试；映射覆盖原I01～I16但不能以文档替代它们。F11/F12/F13/F17至少需隔离PG16独立连接、角色与事务闸门；内存规则测试不得宣称已验证数据库原子性/权限。故障注入只能由测试管理员准备，不给登记服务篡改资料的能力。

## 7. 下一批准点

后续[独立D1b存储与权限候选](2026-10-08-source-ingest-d1b-storage-permissions.md)细化类型关联、外层预算串行点、撤权锁语义、容量与P01～P12实库验收；仍无SQL/授权/执行或运行时交付。

推荐先确认本逻辑资料字段、任务追加白名单与三个仓储seam，再确定实验投影规则/指纹向量及fixture装配限制。随后单独设计新D1b SQL/profile、服务映射与撤权锁序、回执预算与故障注入策略；获得批准后TDD及隔离实库验收。不得本轮直接创建表或接D2。

本轮本地引用、F01～F18编号和git diff检查通过；Standards/Spec审查均无阻断，按Standards建议补齐快照与执行的双向引用图。不重跑代码测试，不把上一切片315项通过计作本设计验收。
