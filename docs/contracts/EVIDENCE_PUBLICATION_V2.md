# 封存绑定发布v2协议与公开测试边界

日期：2026-10-07。用户已确认独立v2、保留v1历史、跨版本共享请求键及四个测试边界；本轮记录ADR/接口规范/未来验收，不交付运行时代码、迁移或收费。

依据：[ADR0005](../adr/0005-evidence-publication-v2.md)、[可信来源事务契约](EVIDENCE_TRUSTED_SOURCE_TRANSACTION.md)、[v1原子发布契约](EVIDENCE_ATOMIC_PUBLICATION.md)。以下为v2实现规范，不重定义v1算法。

## 1. 版本与请求身份

protocolVersion固定evidence-publication-v2。不支持省略后猜版本或自动回退。跨v1/v2请求键均为(workspaceId,requestId)，不包含protocolVersion、serviceId、operation或unitId；这些字段发生变化是同键冲突，而非新请求。

未来共同登记必须同时约束全部v1/v2发布入口。已存在另一版本请求即CONFLICT，无论资料看起来是否相同；授权拒绝优先于查找/冲突，错误不泄露其他工作室记录。v1原函数/历史ID/指纹/回执不改变；经原专用授权重放仍返回原记录，但不因此宣称旧裸资料或内存夹具有生产关联。

尚无生产共同请求登记：内存事务夹具仅将v1预置占用与v2记录放入同一Map，原v1仓储写路径未接入，不能用两个独立Map或两张独立版本表宣称跨版本幂等。生产启用前须关闭绕过共享键的旧写入口或将其纳入同一约束，不能删除/覆写历史来释放已占用requestId。历史导入/迁移需独立批准，不导入v1资料夹具。

## 2. 指纹与ID算法

服务器规范化身份对象包含且仅包含下列字段，全部显式存在：

```text
protocolVersion, workspaceId, requestId, serviceId, unitId, operation,
references, expectedSealId, expectedGeneration, expectedManifestFingerprint,
predecessorId
```

serviceId由固定服务器装配注入，调用者命令不接收此字段。workspaceId/unitId必须与最终来源binding一致。operation为publish或supplement；publish前序为null，supplement前序为有效ID且不能自引用。

references结构沿用v1六项ID/version引用：task、snapshot、execution必需，result/validation/pricing可为显式null，是否允许null按完整来源包和既有结算判据决定。它只定位结论引用，不是完整结果集合；完整成员仍由封存清单读取，调用者不能通过指定单个结果隐藏其他候选。结果/校验/计价的版本与指纹对应关系必须在事务内核验。

ID/version/serviceId/unitId等定位字符串1～256字符，禁止首尾空白、CR/LF、URL及通配符；不自动trim或Unicode规范化。expectedGeneration为正安全整数；expectedManifestFingerprint严格64位小写十六进制。未知字段、undefined、非JSON值拒绝。实际来源包总容量另行设计，不从这些定位字段推出生产限额。

规范化规则：普通JSON对象键按JavaScript字符串排序；数组保留顺序，null显式保留；UTF-8编码，SHA256输出小写十六进制。引用对象也按该规则规范化。没有可省略的默认字段。请求指纹为该身份对象规范化文本的SHA256；改变版本、服务、操作、单元、任何引用/期望封存或前序即冲突。publishedAt、auditId及最终material不进入请求指纹，由事务生成且存有独立校验指纹。

v2最终evidenceId为`evp2_`加SHA256(UTF-8(JSON.stringify(["evidence-publication-v2",workspaceId,requestId])))。auditId采用同一数组摘要但前缀`audit2_`。两者定位同一次请求，前缀区分用途；资料字段及来源身份由独立指纹证明一致性，ID本身不证明真实性。v1继续使用evp_及原evidence-publication-v1数组，不修改原函数。

回执至少包含protocolVersion/workspaceId/requestId/evidenceId/requestFingerprint/materialFingerprint/operation/predecessorId/auditId/publishedAt，以及unitId/expectedSealId/expectedGeneration/expectedManifestFingerprint，与请求/来源审计共同保存。不向既有formatVersion=1资料或九字段投影塞协议字段。回执是设计，不得把现有v1回执强转为此结构。

## 3. 四个公开测试边界

| 边界（设计语义） | 输入与可观察行为 |
| --- | --- |
| 完整来源包校验 | 受控来源包+固定命令绑定；核验真实资料关联的证明约定、关闭前序/栅栏、全原始结果、校验及计价；返回经判据校验的资料准备结果或净化拒绝。函数名/TypeScript类型在TDD切片中落实；此结果不是发布凭证 |
| publishFromSeal(command) | 命令为第2节身份对象去掉serviceId；固定身份专用授权后，内部共同事务重读来源/核验封存、前序、构造最终ID资料，提交请求/资料/审计/回执。禁止客户端material/complete/金额及外部transaction client |
| lookupPublished(command) | 同规范命令且由宿主注入serviceId，当前专用操作授权后按共享请求键查找；v2同指纹返回完整已提交原回执，异指纹/版本CONFLICT，未读到返回null但不证明未提交。不得为查询调用模型 |
| readPublishedEvidence(workspaceId,evidenceId) | 固定身份通过settle读取权限，核验四对象和原不可变seal关联后输出既有九字段。历史头推进不改变读回；只存在裸资料/残缺关联拒绝。非成员身份不能直接调用低层服务器接口 |

发布/查询使用publish或supplement专用权限，settle不推导发布能力；读取使用既有settle规则，不把成员审核权限当服务认证。低层来源校验仅为受控服务器seam，不提供HTTP或鉴权替代。每次调用复制输入/输出，错误不回传原始模型响应或Key。

v2首个实现的supplement前序只接受关联完整的v2已发布证据，且binding/快照/executionId一致；v1历史不自动作为v2生产前序。跨版前序迁移延期，不能伪造v2审计。v1历史仍走原授权重放接口；本轮v2查询/读取不承担历史生产升级。

## 4. 共同事务与重放

锁序继承：共享请求身份→来源头→不可变前序读取。事务先检查已提交请求，v2同指纹返回原回执，勿依赖可变当前头；另一版本或异指纹拒绝。新请求才要求expected seal/代/指纹与当前头一致，并重验全部来源及关闭证明；不是先requireCurrentSeal、再单独commit。

四对象提交失败全部回滚。COMMIT结果未知返回净化UNAVAILABLE/待核对语义，保留原requestId，用lookup或原命令重放收敛；null不能触发换ID或重新调用模型。超过锁/语句/整体截止不证明供应商执行已关闭，时限值与实库实现后续批准。

旧observation发布后新来源出现：原命令仍可授权重放历史回执；新请求引用旧seal拒绝。补证使用新的requestId及新seal，关联旧v2证据，不覆写unknown或自动改账本。封存历史、关闭资料及发布审计均不可变。

## 5. 规范测试向量（仅算法示例，不是可信来源）

输入身份如下，references.result/validation/pricing=null用于未知执行示例，seal-1和指纹仅示例，不能据此发布：

```json
{"protocolVersion":"evidence-publication-v2","workspaceId":"studio","requestId":"request-1","serviceId":"publisher","unitId":"unit-1","operation":"publish","references":{"task":{"id":"task-1","version":"1"},"snapshot":{"id":"snapshot-1","version":"1"},"execution":{"id":"execution-1","version":"1"},"result":null,"validation":null,"pricing":null},"expectedSealId":"seal-1","expectedGeneration":1,"expectedManifestFingerprint":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","predecessorId":null}
```

独立SHA256计算的预期值（后续TDD应使用这些字面量，不用实现函数重算期待值）：

- requestFingerprint：`427658c7684e0eba33e46f1664b923db488b5fa3d7c977418263cad5703e8759`
- v2 evidenceId：`evp2_9334b4e364a5bd11f01ccaf89c275e26886058818743892b028b264f9df3b665`
- v2 auditId：`audit2_9334b4e364a5bd11f01ccaf89c275e26886058818743892b028b264f9df3b665`
- 同工作室/请求的原v1 evidenceId：`evp_ec4e5f98ccdd94c32550dc4fb85ea2856d9e9eda66ab0f7f00acba4cac8fb27a`

调换对象字段顺序不改请求指纹；任何expected字段变化应得到不同指纹。同键虽有不同v1/v2 evidenceId，仍只能占用一个共享请求身份，不因ID不同允许双发。

## 6. 未来验收与后续实施

V01～V10尚未执行：固定向量与字段乱序；expected三字段逐项变更冲突；协议/单位/服务/引用/前序变更冲突；非法身份字段拒绝；双版同键竞争无双发；同版回执授权重放；来源新代后历史重放与新请求旧seal拒绝；残缺关联/裸资料拒绝读取；四项回滚/COMMIT响应丢失；v1前序不能自动升v2。真实来源与数据库并发仍须覆盖[C01～C15](EVIDENCE_TRUSTED_SOURCE_TRANSACTION.md)及既有P/S场景。

下一切片：先TDD实现独立v2身份校验、规范指纹/ID/回执结构和完整来源包校验的规则夹具，保留原v1模块不改；共同请求登记/共同事务仓储另作切片，未完成前不得宣称跨版本去重可用。生产迁移、所有Writer升级、真实来源、读取门禁与收费均独立批准。

## 7. 协议准备增量（非发布）

用户另行确认prepareV2PublicationIdentity(serviceId,command)测试边界，现实现严格身份校验、复制隔离、规范请求指纹及两个ID；固定向量/乱序有测试，封存字段变化只证明指纹不同，不代表仓储冲突已实现。未知字段、访问器、符号字段及非普通JSON对象拒绝，所有异常净化为INVALID_PUBLICATION。输入为unknown并在运行时验证，不自动默认协议或来源字段。

该函数只是受控服务器的协议工具，不认证serviceId、不执行来源/关闭证明核验、不确认seal当前、前序存在/版本合法或共享键占用，不返回published回执。v1源码不变；V01和身份非法校验已具规则测试，其余发布/跨版本/实库验收尚未执行。下一切片为完整来源包校验，不直接调用现有v1commit或低层append拼出v2发布。

## 8. 来源包校验夹具增量

用户确认validateV2SourceBundle(serviceId,command,bundle)，夹具结构与边界见[说明](../plans/2026-10-07-v2-source-bundle-fixture.md)。核验固定来源/全成员/版本前序/封存期望/关闭资料/校验及计价关联，输出最终ID的准备资料，不发布。不证明现存数据库全结果、真实来源或当前集合屏障，也不查询前序发布存在性；不能把该校验结果当作事务凭证。下一步共同事务规则夹具与共享请求登记，生产验收仍需实库和所有Writer接线。

## 9. 共享登记与共同提交夹具增量

已新增[内存共同事务规则夹具](../plans/2026-10-07-v2-publication-transaction-fixture.md)，由确认的publishFromSeal/lookupPublished测试边界验证共享键、专用授权、前序/历史关联及一次四对象保存。最终同步来源读取至保存没有await，仅同进程可用；不是数据库屏障，也不升级原v1写路径。readPublishedEvidence/生产发布读取门禁尚未实现，真实SQL回滚、COMMIT不确定性、所有Writer与收费仍延期。
