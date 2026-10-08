# D1b initialize 编码、回执与预算候选

状态：待批准的设计基线，不是已实施冻结协议。承接[运行事务](2026-10-08-source-initialize-runtime-design.md)、[入口权限](2026-10-08-source-initialize-entry-permissions.md)和[现有命令契约](../contracts/EVIDENCE_SOURCE_D1B_INGEST.md)。本轮仅文档，不改既有指纹、SQL、权限或数据库。ADR0008保持 Proposed。

## 1. 编码边界

记 C(x)=canonicalEvidenceValue(x)，B(x)=UTF8(C(x))的字节数，H(x)=SHA256(UTF8(C(x)))小写64位十六进制。命令身份仍为严格 command 加真实 serviceId、operation；既有两条固定指纹不得改变。ingest_receipt.command 保存完整身份对象（含 serviceId/operation），不是仅外部 command；command_canonical 与 command_fingerprint均针对该身份，服务身份与 receipt.producerServiceId必须相等。

批准字段树的键均为固定 ASCII 字段名，按 JavaScript UTF16排序；不得采用数据库默认排序或 jsonb::text。数组保持顺序，null/布尔按 JSON 字面量，无空格、BOM或尾换行。字符串沿 JSON.stringify：引号和反斜线转义，控制字符用标准短转义或小写四位 \u 转义，其余合法 Unicode 直接 UTF8；不转义普通斜杠、不做 Unicode 归一化。NUL及孤立代理项在数据库发送前拒绝；SQL也独立拒绝不可表示文本。字段验证先于编码，不能用编码器接受任意 JSON。

本入口所有数字限安全整数；整数输出十进制无指数/小数部分，负零按0编码（业务字段另限制正值/非负值）。SQL JSONB词法不能证明原数字拼写，按解析后值验证；不声称保留原JSON字节。对象仅批准键集合，不支持用户自定义键，避免非BMP键排序差异。时间固定 UTC毫秒格式 YYYY-MM-DDTHH:mm:ss.sssZ；SQL timestamp 到规范字符串必须独立校验精度，不能无声截断业务时间。

SQL实现必须逐字符编码并按固定字段树重建，不能信任客户端 canonical/hash。有限类型树比通用 JSON/JCS实现范围更小，代价是每次字段演进须重新批准规则与向量；不能以更换通用编码库改变既有发布或来源指纹。

## 2. 来源投影与回执

来源 payload不变：task={binding,taskRevision,scopeKeys}；snapshot={binding,responsibility,quoteId,priceVersion,reserved}。payloadFingerprint=H(payload)，不是完整业务指纹；link保留后者，snapshot link另保留完整报价指纹。ExecutionIdentity只用于固定集合身份，不生成第三个来源。ruleVersion/projectionRuleVersion的具体字符串及完整来源序列化须在实现前与既有来源类型定义逐字段对齐，不猜默认值。

initialize 回执严格为以下13键：protocolVersion、workspaceId、ingestId、operation、producerServiceId、commandFingerprint、collectionId、unitId、generationAtCommit、headRevisionAtCommit、status、sourceReferences、committedAt。sourceReferences恰两项、task在前snapshot在后，每项严格 kind/id/version/payloadFingerprint。operation=initialize，status仅initialized/already_registered，generationAtCommit=1；初始化新集合head=1，既有集合记录当次实际头。不添加完整payload、原文、Key、费用、当前头或包装摘要。

committedAt为入口生成并持久化的提交审计标记，不是数据库实际 COMMIT完成时间；外层只有确认COMMIT后返回。SQL列、receipt JSON、成员序号/指纹全部交叉核对。receipt_fingerprint=H(receipt)，不放进receipt自身，避免自引用；历史重放返回原副本，不更新标记。collectionId候选用服务器随机UUID文本，命令不控制它；固定测试向量用指定ID，随机值不参与命令指纹。

## 3. 精确逻辑预算

不使用 pg_column_size、页/WAL/索引/TOAST大小作为逻辑额度；它们属于独立运维指标，逻辑限额不是物理磁盘保证。以下 row(t) 是固定 SQL 草稿表全部列组成的严格对象，键使用原 snake_case列名；domain转字符串/安全整数，timestamp用上述UTC格式，JSON保留结构，bytea转小写hex（不带前缀）。不得用动态SELECT *在运行时学习字段；实现前固定列清单及向量。规范字节副本与JSON字段同时计费是有意保守重复，不称物理占用。

- collectionBase=row(collection)仅移除package_bytes，避免自引用；其它全部列含binding、固定业务指纹、头和生命周期字段均计入。
- sourceCost(s)=B(row(source_version))+B(row(对应类型link))；包括payload、canonical的hex副本、两类指纹及审计字段。
- packageBytes=B(collectionBase)+两初始sourceCost之和。该值写collection.package_bytes。
- receiptBase=row(ingest_receipt)仅移除accounted_bytes；保留完整command/receipt、两份canonical的hex和两个指纹。receiptCost=B(receiptBase)+两项B(row(receipt_source_member))。该值写accounted_bytes。无自引用，且必大于等于原SQL要求的两份canonical原始字节之和。

新集合：source_count+2，source_bytes+packageBytes；receipt_count+1，receipt_bytes+receiptCost。既有同内容unit的新ingest：来源两个计数零增量，仅增加一份receiptCost与回执计数。原键重放所有预算零增量，即使预算已满也不读取预算。business_count/business_bytes维持已批准业务装载口径，无新增业务，无重复累计。

source_bytes按各集合packageBytes求和（包含固定集合资料），source_count按source_version行数；receipt_bytes按accounted_bytes求和，receipt_count按receipt行数。成员/link分别已计入相应字节，不另增加行计数；不同回执引用同来源仍各计自身成员。所有额度在workspace预算锁内先算完整增量，再校验安全整数和上界，任一超限CAPACITY整项回滚，不截断、减计数或释放历史。

沿用上界：单集合256来源/2MiB；工作室4096来源/32MiB；单回执16KiB，工作室1024回执/16MiB；业务4096行/16MiB。等于上界允许，多1字节或1条拒绝。register未来若推进头或追加来源，必须重新设计包差额规则；本初始化切片不能预先宣称该路径已支持。

## 4. 向量与实施门禁

现有initialize命令向量SHA256=ebd501128ae55bf1cc1e376560fa0335fb8d12b9ebf99d3e8996e71c0ff1bce5，register回归向量=ee5a3720794a4797942b9e5c8fc2fc85427bb5a2a9f8f4f74780a258e9117130；完整字节沿原契约，不重新生成替代值。

未来必须提交独立手写规范字节/OpenSSL摘要、Node计算值与SQL实库值三方对照：中文/非BMP、组合与预组合Unicode不等、引号/反斜线/控制字符、数组顺序、整数上界/负零、两投影、完整receipt/各row以及packageBytes/receiptCost。固定所有ID/时间/producer/ruleVersion，不能用当前时间或随机ID计算黄金值。NUL/孤立代理项、额外字段、时间精度不合规均为拒绝向量。

| ID | 待执行验收 |
| --- | --- |
| C01 | 两个既有命令指纹不变，SQL独立计算与Node/OpenSSL一致 |
| C02 | 字符串转义、Unicode不归一化、数组顺序及整数边界符合明确字节 |
| C03 | command JSON为完整身份，服务/操作/各列一致；客户端指纹无权威 |
| C04 | 两来源投影与完整业务指纹分离，第三种来源拒绝 |
| C05 | 回执严格13键/两有序引用，规范内容、指纹及SQL投影一致 |
| C06 | 全列预算投影无漏字段/自引用；hex、UTC时间和固定向量一致 |
| C07 | 新集合/新ingest/原键重放分别按上述增量，满额重放不累计 |
| C08 | 字节/条数恰上界允许、超过拒绝，事务故障无半累计 |

本轮只明确候选算法，**新增完整回执、来源row及预算黄金字节/摘要尚未产出，具体规则版本字符串尚未对齐**，不能称编码和预算已全部冻结或验收。下一步先做这些离线固定向量与字段对齐，再批准 SQL草稿和运行profile；无新增常驻服务或生产SLA。

## 5. 本轮检查

Standards与Spec分别审查均无阻断；固定全列清单需包括现有collection的initial_task_kind/initial_snapshot_kind等后加列，不能仅抄CREATE TABLE首段。相对引用、C01～C08唯一编号及diff检查通过。未运行代码/数据库测试，新增黄金向量与SQL对照仍是后续实施门禁。
