# D1b最小来源写入契约

日期：2026-10-08。状态：仓储写入仍为设计草案；上一轮只批准接口契约、权限矩阵和验收清单。本轮额外批准并完成下述纯函数协议准备；角色授权、迁移、数据库执行及写入仓储仍未批准。

后续批准：2026-10-08用户确认仅实施纯函数prepareSourceIngestIdentity(serviceId, operation, command)，operation为initialize/register。返回identity副本、commandFingerprint及ingestKey={workspaceId,ingestId}；非法输入统一INVALID_COMMAND。现由billing包根导出；不授权/认证服务、不占键、不证明业务来源、不写数据库或生成成功回执。上述三个仓储接口仍未实现，I01～I16仍为未来验收。

编码冻结为canonicalEvidenceValue({ ...command, serviceId, operation })的UTF8 SHA256，键按现有规范排序，不进行Unicode归一化。serviceId与operation是独立参数，命令包含同名字段拒绝。不改变v1/v2发布算法。两条固定向量以手写规范字节通过OpenSSL独立计算：

```json
{"executionReference":{"id":"execution-1","version":"1"},"ingestId":"ingest-1","operation":"initialize","protocolVersion":"source-ingest-v1","serviceId":"collector","snapshotReference":{"id":"snapshot-1","version":"1"},"taskReference":{"id":"task-1","version":"1"},"unitId":"unit-1","workspaceId":"studio"}
```

SHA256：ebd501128ae55bf1cc1e376560fa0335fb8d12b9ebf99d3e8996e71c0ff1bce5。

```json
{"businessReference":{"id":"任务一","kind":"snapshot","version":"1"},"expectedHeadRevision":1,"ingestId":"ingest-1","operation":"register","protocolVersion":"source-ingest-v1","serviceId":"collector","unitId":"unit-1","workspaceId":"工作室"}
```

SHA256：ee5a3720794a4797942b9e5c8fc2fc85427bb5a2a9f8f4f74780a258e9117130。共享键不含协议/操作/服务/集合；指纹包含完整身份。该纯函数不提供跨操作冲突检测，后续持久化仍须共同唯一登记。

依据[可信来源事务](EVIDENCE_TRUSTED_SOURCE_TRANSACTION.md)、[数据库设计](../plans/2026-10-08-evidence-source-database-design.md)、[D1a实库记录](../plans/2026-10-08-evidence-source-d1a-postgres-validation.md)。保留ADR0004同库屏障及ADR0005发布协议，不变更既有v1/v2身份算法。

## 1. 范围与不变量

明确三个未来测试边界：initializeSourceCollection(command)、registerSourceFromBusiness(command)、readIngestReceipt(workspaceId,ingestId)。它们是受控服务器接口，不是HTTP API，也不是当前可调用TypeScript类型。

本最小切片只定义固定任务/快照初始化及task/snapshot版本登记。execution/fence/result/validation/pricing/closure涉及发送关闭、迟到隔离和规则证明，下一切片单独设计/批准；本切片拒绝这些kind，不返回“稍后补齐”的成功回执。真实任务/报价接线仍是D2，D1b实验必须标记测试业务来源，不能宣称真实生产来源。

不接受浏览器/模型自报payload、binding权威、金额、responsibility、canonicalHash、complete、sealKind或服务身份。业务记录定位不是业务记录真实性证明；适配器必须从允许的本库业务行读取精确不可变版本并验证关联。没有真实固定报价/任务修订/执行定位时拒绝，不从ModelTask状态、usage、租约推导事实。

登记不是封存或发布。空集合不证明执行关闭，回执不属于published或九字段结算证据。D1a仍保持原封闭状态；不能为本契约先授予其表INSERT。权限/表演进与新的预检配置须另批，不把D1a只读目录检查变成可写装配。

## 2. 命令与服务端资料（仅设计）

所有命令为普通严格JSON对象，未知字段/访问器/符号/undefined拒绝，定位字符串沿用v2的UTF16长度与空白/禁字符规则；数组保持固定顺序。数字只接受安全整数，不自动trim、补默认或切当前活动版本。协议名称source-ingest-v1仅表示来源登记，不与evidence-publication-v1混用；本轮已冻结文首的编码向量。

```text
Reference = { id, version }
InitializeCommand = {
  protocolVersion: "source-ingest-v1", workspaceId, unitId, ingestId,
  taskReference: Reference, snapshotReference: Reference,
  executionReference: Reference
}
RegisterCommand = {
  protocolVersion: "source-ingest-v1", workspaceId, unitId, ingestId,
  expectedHeadRevision: 正安全整数,
  businessReference: { kind: "task" | "snapshot", id, version }
}
```

executionReference仅定位已有受控执行身份以固定executionId，不允许登记执行结论、创建新执行掩盖旧未知、发送或关闭执行。具体任务/报价/执行业务表与版本字段尚缺，D2适配路径未完成；不存在时不初始化生产集合。请求不能传入内部transaction client或任意业务SQL。

服务端构造固定binding（workspace/task/unit/project/chapter/sourceVersion/有序upstreamVersionIds）、完整计费快照（责任/固定报价/预留/规则）、collectionId、executionId、来源payload/规范字节/指纹及审计时间/服务。来自不同来源的binding必须逐字段相等，不允许“以task为准”覆盖不一致。引用绑定真实业务行及不可变版本，校验不存在/跨工作室/内容错配时整项拒绝。

initialize成功必须同事务创建集合、固定task/snapshot两份初始来源、真实业务关联、初始头计数和初始化回执；不能先返回空集合后补来源。初始generation=1、headRevision=1、memberCount=2、historyCount=0、unresolvedCount=0，当前/final seal均null，固定executionId仅作身份绑定。具体完整来源包在执行资料缺失时仍不得封存/发布。

register只登记已固定task/snapshot实体的合法追加版本：固定binding、计费快照、报价/责任/执行身份不能被新版本改变；本首切片snapshot固定版本以同内容重放为主，不允许借“新版本”修改固定快照。task追加候选仅允许受控taskRevision记录版本推进，固定binding与scopeKeys必须不变；该白名单及具体业务版本链须在实施前确认，未确认时默认拒绝所有新task版本。revision/前序由可信业务记录证明，不按version文本/到达顺序推断；不接调用者声明的前序/指纹替代核验。

## 3. 幂等身份与回执

初始化与登记共同使用唯一(workspaceId,ingestId)，不包含操作、服务、集合、kind或版本。命令指纹覆盖完整严格命令+服务器固定serviceId+操作名称；改变任一绑定、引用、期望头或服务是同键冲突，不能自动换ID重试。指纹沿用已有规范化JSON/UTF8/SHA256原则，本轮已冻结文首来源协议固定向量，不改发布协议算法；冲突检测仍待后续仓储实现。

回执候选结构：protocolVersion、workspaceId、ingestId、operation、producerServiceId、commandFingerprint、collectionId、unitId、generationAtCommit、headRevisionAtCommit、status、sourceReferences、committedAt。status为initialized/registered/already_registered；sourceReferences列出实际提交关联的kind/id/version/payloadFingerprint，初始化必含两项。回执不含原文、Key、完整payload或客户端费用。查询及重放返回副本。

同ingestId同指纹返回原已提交回执，不重读活动业务版本，不按当前头重算时间/代/修订；当前授权仍检查。相同业务版本在另一新ingestId下登记且内容一致：可保存新的already_registered回执，指向既有不可变来源，不增加成员/推进头；不同内容不得覆盖。不同ingestId不等同于新事实，实体版本唯一约束同样必要。

同ingestId异指纹仅CONFLICT，不消费这条新命令；调用方保留该事实并修正其采集身份管理，不把冲突当成功或释放暂存。采集端应在首次可靠暂存时为每个事实分配固定ingestId，重试始终沿用；不得收到未知提交后换ID。

同实体版本异内容是另一类冲突：正常登记默认拒绝，不改旧来源/回执。若遇到真实矛盾事实，必须先可靠保留，进入独立隔离/未决处理契约；该处理尚未实现，本切片不得用于会产生真实冲突的生产采集。不能在没有隔离能力时丢弃事实、返回成功或继续正常封存/发布。后续隔离实现必须遵守未决标记、observation失效及final不重开规则。

## 4. 三个接口的行为

### initializeSourceCollection

当前source_initialize授权→验证身份/查原提交回执→受控核验固定业务版本→同库唯一unit创建/锁定→重验业务关联→构造两来源/关联/头/回执→共同提交。

同unit不同ingestId并发：固定binding/快照/execution和两初始来源一致时收敛到既有集合，保存already_registered回执；异内容拒绝且不改已有集合。不删除或重置已有unit来实现“初始化”。不存在unit不能靠FOR UPDATE空查询取得锁，创建竞争由唯一约束与共同事务管理。

新初始化命令只能处理无封存历史、generation=1且无未决的首切片集合；超出此生命周期STATE_BLOCKED，不补写新初始化回执或重置头。已提交原命令仍按原授权重放，不受后续状态影响。

### registerSourceFromBusiness

当前source_register且kind许可→查原已提交回执→锁既存来源头→同键并发胜者再检查→比对expectedHeadRevision→核验精确业务版本/固定关联及合法前序→追加来源/业务关联/头修订和回执→共同提交。

既存回执重放优先于当前expectedHeadRevision检查；不能因头推进拒绝合法历史重放。新ingestId的期望头不符返回HEAD_CONFLICT，无新的成功回执。默认停止自动改写/重投，保留原事实和命令，由受控协调方核对并批准后续命令；改变期望头不得继续冒用已占用ingestId。未提交且明确未曾成功的命令变更规则实施前另定，未确认前不自动替换指纹或分配新ID。

未初始化集合NOT_FOUND，不隐式创建。来源头已有封存历史、generation不是1、final或未决标记时，本最小切片拒绝新的正常登记（STATE_BLOCKED），不自动清空清单、推进新代或解除未决；历史已提交回执仍可授权重放。支持observation后新增/隔离的后续切片必须实现完整原规则，不能将STATE_BLOCKED当永久丢弃事实的理由。

无封存且合法新版本追加：generation保持1（本切片不生成其他代）、memberCount+1、headRevision+1；同内容既有版本不变化。事实与业务关联/版本/计数/回执保存失败全回滚，禁止半份成功回执。累计容量在同头锁内核验，不能仅靠D1a字段CHECK。

### readIngestReceipt

当前source_receipt_read工作室授权→取得服务端allowedProducerServiceIds→按(workspace,ingestId,允许生产者范围)读取完整关联→回执与来源/集合绑定一致则返回原回执，范围内未读到返回null。缺失关联/错配不当null返回，统一INTEGRITY_CONFLICT。只读原不可变提交关联，不要求头仍为原修订，也不去重读最新业务资料。

它不返回裸来源、当前集合头、未提交映射或published证据。无工作室/查询授权或允许生产者范围为空时先FORBIDDEN；有读取许可但目标属于范围外生产者时由查询/RLS过滤，与范围内不存在同样返回null，不能先读回执再用不同错误透露范围外存在性。当前查询操作不是初始化或登记授权。readIngestReceipt(null)不证明全局未提交，不允许丢暂存或重调模型。

## 5. 权限矩阵与装配

| 可信职责 | source_initialize | source_register | source_receipt_read | 其他能力 |
| --- | --- | --- | --- | --- |
| 固定任务/快照创建服务 | 显式工作室授权 | 不自动获得 | 可显式授予本服务回执范围 | 不获得发送/关闭/封存/发布/settle |
| task/snapshot来源登记服务 | 不自动获得 | 显式工作室+kind授权 | 可显式授予本服务回执范围 | 不获得金额自报或通用SQL写权限 |
| 内部恢复核对服务 | 否 | 否 | 显式工作室+allowedProducerServiceIds | 只核对原提交，不调用模型/补写业务 |
| 工作室负责人/审核成员 | 否 | 否 | 否 | 成员审核权限不能作服务认证 |
| D1a目录检查角色 | 否 | 否 | 否 | 只检查目录，仍不能数据读写 |

服务认证由受控服务器/数据库登录身份映射提供，serviceId固定且不可由请求/GUC选取。授权器只认显式工作室、操作、kind和生产者范围，严格true；未知/撤销/异常默认拒绝。数据库受控函数按真实登录映射检查授权，RLS上下文不能代替认证。不把持有通用共享数据库账号的人视为已绑定服务。

应用运行角色无表DML/DDL/触发器关闭权限，只有明确受控入口执行与必要读。owner非登录、非super/BYPASSRLS且受FORCE RLS；PUBLIC无执行权，search_path固定。实际角色名、服务映射表、SECURITY DEFINER受限函数和授权撤销事务语义待实施方案批准，本文不创建它们。

授权必须在查提交/冲突信息前完成；异步等待与获得写锁后重新核验。提交线性化点与撤权竞争需明确：推荐同事务锁定/验证授权版本，让撤权与写事务串行；仅外部权限缓存复查不构成数据库内撤权屏障。具体授权锁序须在SQL实现前纳入整体锁序并实库验证，不能直接声称即时撤权保证。

## 6. 共同事务、真实业务证明与恢复

本切片首版只定位已经持久化的受控不可变业务记录。仓储内部在同一连接/事务读取并核验真实业务版本，保存来源和关联；不存在/内容不匹配/不能证明不可变性时拒绝。测试业务表必须标记为fixture，不能把D1a的jsonb行自报指纹当生产证明。

新业务事实的保存不属于这三个命令的外部自由参数；D2专用业务入口必须改造为业务事实+来源/关联/回执同连接共同保存。现有独立候选仓储自行commit不能接在前后拼接。内部适配器不得获得任意回调来查询外网/解密Key或替换事务连接；只允许审核通过的本库类型定位。

沿用来源设计的头→登记身份/版本→固定业务锁序；初始化先通过unit唯一约束解决无头竞争。不可变业务读取无更新锁依赖，必要业务行锁不得反向先业务再头。最小来源事务不获取发布请求锁、不调用发布或其他来源写命令；多集合暂不支持。D3请求锁与来源头顺序保留原契约，实际授权锁/登记唯一键等待策略另批。

同workspace+ingest跨集合并发由共同唯一登记保护，不能各集合维护独立map。来源/关联/头/回执同事务commit才返回成功。初始化和登记指纹应在同一登记空间判冲突；不能先插回执独立提交再构造来源。不存在回执的行锁/保留行具体实现待SQL设计，不以空查询冒称串行化。

采集事实先可靠暂存，明确提交并核对回执后才释放。锁等待/语句超时、死锁、断网、COMMIT响应丢失或连接状态未知统一UNAVAILABLE/待核对，不推导业务执行失败。原ingestId查询/原命令重放收敛，不换ID、不重投模型。未知连接销毁；只有明确回滚/未成功的数据库动作才能在原身份下重试。

同内容历史重放不重读可变头；授权仍必须有效。历史业务关联/版本/登记回执禁止更新或删除以释放ingestId。删除、留存、工作室总量和历史归档另批，不借项目删除规则清理来源权威。

## 7. 错误与限额

建议净化错误：INVALID_COMMAND、FORBIDDEN、NOT_FOUND、CONFLICT、HEAD_CONFLICT、STATE_BLOCKED、INTEGRITY_CONFLICT、CAPACITY、UNAVAILABLE。不向客户端返回SQL/连接/Key/原文/供应商私密错误；未知提交属于UNAVAILABLE但不能被当成失败终态。纯函数已冻结SourceIngestProtocolError（INVALID_COMMAND）；其余仓储错误类仍待TDD切片冻结。

沿用D1实验候选：单元正常历史版本256条、完整来源包2MiB、ID引用限制及有界JSON规则；初始化两版本计入容量。新回执即使指向同一版本也占登记空间，工作室登记回执总量/字节限额必须在实现前批准；超限拒绝不截断、不删除历史。隔离可靠暂存/128条候选不属于本最小接口的实现。

写事务候选lock_timeout=1s、statement_timeout=5s、整体截止10s、池等待2s，仍待隔离并发验证/明确配置批准，不作生产默认/SLA。锁内无模型、外网或Key操作。单次最多登记一个业务版本；初始化两版本作为一个原子动作，不提供批量自由写入。

## 8. 未来验收（本轮未执行）

| ID | 公开入口场景 | 预期 |
| --- | --- | --- |
| I01 | 合法固定任务/快照/执行初始化 | 集合+两初始来源+关联+回执一起可见，代1/修订1，不可封存/发布 |
| I02 | 初始化业务缺失/自报payload或金额/错工作室 | 拒绝，无半集合；不补默认报价 |
| I03 | 同unit同内容/异内容并发初始化 | 同内容收敛、异内容拒绝，不重置固定事实 |
| I04 | 初始化与登记复用同ingest异操作/服务/引用 | 共同命名空间CONFLICT，原回执不改 |
| I05 | 未初始化集合登记/不支持kind | NOT_FOUND或INVALID_COMMAND，不自动建集合或接执行结论 |
| I06 | 业务版本/binding/快照/前序错配 | 整体拒绝，旧来源不覆盖，不按活动版本补齐 |
| I07 | 同ingest同内容并发与新ingest既有版本 | 原回执收敛；already_registered不加成员/推进头 |
| I08 | 新登记期望头不符/历史回执头已变 | 新命令HEAD_CONFLICT，历史原命令重放正常 |
| I09 | 同实体版本异内容/有封存或未决 | 拒绝正常登记并要求事实可靠保留，不伪成功/解隔离 |
| I10 | 业务关联/版本/头/回执任何一步失败 | 全部回滚，公开恢复查询不见半份关联 |
| I11 | COMMIT响应丢失/在途结果暂不可见 | 原身份核对，null不证明未提交、不重投模型 |
| I12 | 撤权/伪serviceId或GUC/成员审核权限/跨工作室；同工作室生产者范围内/范围外/空allowlist | 未授权/空allowlist先FORBIDDEN；有读许可时范围内完整回执可读，范围外与不存在同为null且不泄露存在性，读权限不推导写权限 |
| I13 | 回执关联缺损/原回执输出修改 | 完整性拒绝/副本隔离，不按当前头重写回执 |
| I14 | 来源及登记回执容量/UTF16与Unicode边界 | 超限拒绝不截断，完整协议检查不能只靠SQL length |
| I15 | 外部client/业务SQL/连接替换或旧直接DML | 拒绝绕过；旧封闭D1a不被静默放开 |
| I16 | 源头→业务锁序竞争/授权与提交竞争 | 合法有序结果，有界等待，撤权线性化规则实库验证 |

先确认运行时形状与权限/真实业务测试定位，再在隔离PG16用两个独立连接和事务闸门逐项验收；不以模拟测试替代真实原子性/权限，不重跑模型制造来源。I01～I16全部尚未执行。

## 9. 取舍与下一步

方案A后续设计见[隔离测试业务来源与最小仓储](../plans/2026-10-08-source-ingest-fixture-design.md)：TaskRevision/固定快照/执行身份/固定报价的独立不可变关联，以及F01～F18未来验收。仅文档，不代表新业务读取、权限、仓储或数据库已实现；字段/追加白名单和装配仍需实施前确认。

推荐先做受控固定业务读取、初始化/登记规则的窄切片，而非一次开放所有来源类型。好处是授权/幂等/关联能独立验收；代价是遇到封存/迟到/真实冲突只能安全阻塞并保留事实，不能承接生产采集。

拒绝通用payload写入和依次调用旧仓储拼事务；它们易接入但不能证明真实性或共同提交。完整发送/关闭/隔离一并实现的方案闭环更完整，但超出本次最小范围，留作后续契约与批准。

下一步需批准：测试来源定位及不可变关联、仓储运行时seam、授权映射/撤权锁序、登记回执总量与事务时限、独立D1b SQL草稿/预检配置。纯函数接口与登记指纹固定向量本轮已确认。不得覆写D1a草稿或角色来跳过批准；新写入方案须有独立版本/预检，D1a封闭验收保留为回归。

## 10. 本轮检查

上一轮文档审查：Standards和Spec无阻断，补齐同工作室生产者过滤/空许可向量；仅修改契约及T09进度，没有代码改动或代码/数据库测试。

本轮纯函数切片：6项公开接口测试通过（包含两条独立OpenSSL固定向量）；全仓测试315通过、19项数据库条件测试跳过，类型检查及diff检查通过。Standards/Spec审查无阻断，已修正旧冻结状态表述。未启动或连接数据库。I01～I16仍属于未来仓储验收，纯函数测试不证明原子提交、认证、权限或业务来源真实性。
