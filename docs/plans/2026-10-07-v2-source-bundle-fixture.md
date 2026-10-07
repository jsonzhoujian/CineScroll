# v2完整来源包规则夹具

用户确认测试边界：validateV2SourceBundle(serviceId,command,bundle)。输出包含已准备的v2身份、最终协议ID资料/materialFingerprint、sourceFingerprint/sourceSealId；不是发布回执。依据[v2协议](../contracts/EVIDENCE_PUBLICATION_V2.md)和[可信来源契约](../contracts/EVIDENCE_TRUSTED_SOURCE_TRANSACTION.md)。

本轮已按TDD逐项实现成功准备、清单缺项/错代拒绝、完整binding和payload一致性、关闭栅栏、全原始结果、来源版本前序、BYOK零计价及严格JSON/容量限制；不会实现来源认证、真实业务行读取、当前头锁、前序发布存在性或数据库。原v1判据复用但不修改。

## 夹具输入格式（formatVersion=1，非生产Schema）

bundle仅四字段：formatVersion/material/records/seal。material沿用既有formatVersion=1资料判据；输入id为来源占位，返回前替换为v2最终ID并重验。

每条record固定kind/id/version/revision/predecessorVersion/payloadFingerprint/producerServiceId/ruleVersion/recordedAt/businessRecordId/binding/payload。kind为task/snapshot/execution/result/validation/pricing/fence/closure。binding为现有七字段固定绑定。payloadFingerprint为SHA256(规范化payload)。元数据含业务行定位声明而非已验证行；fixture全部ruleVersion与资料固定规则一致，生产不同规则版本的兼容注册尚待设计。

同kind只允许一个来源ID，每组版本从revision=1开始连续推进，前序等于上一版version；不得重复版本，引用必须选择该组最大revision。数组不表示版本顺序，revision/前序才是顺序依据。所有来源版本保留在members；多个原始结果/结果版本保守拒绝，不任意选一条。关闭执行不得回退unknown或改变既定关闭结论；发送栅栏不能从closed回open或已授权回未授权。固定snapshot历史版本不能改变预留/报价/责任等资料。

任务payload包含binding/taskRevision/scopeKeys；快照、执行、结果和计价payload沿用既有资料字段。校验payload包含binding/resultId/resultVersion/resultFingerprint/verdict/ruleVersion；与原始结果逐项匹配，verdict为passed/failed。这里只检查夹具关系，不实际执行内容质量校验或计算价格。

历史validation/pricing/closure也逐版本核验真实存在于包内的引用与判据，不能用合法最新版隐藏缺失结果、非法金额或虚构栅栏。固定报价/结果下历史pricing必须与当前资料相同，计价矛盾保守拒绝；关闭资料关联具体前序执行版本及相应已关闭栅栏，来源时间不得早于所引用资料。

fence payload：binding/executionId/generation/state(open|closed)/dispatchAuthorized。closure payload：binding/executionId/fenceId/fenceVersion/fenceFingerprint/predecessorExecutionVersion/reason/dispatchClosed/resultRegistrationClosed。关闭证明匹配当前执行前序及栅栏，两个关闭标记必须true；not_sent要求历史栅栏均未授权发送，completed/invalid_response要求当前已授权；unknown要求open栅栏、无closure且observation。首次独立已关闭执行可为revision1/前序null，真实性依赖未来受控生产者，不推导“未发送”的真实事实。

seal固定formatVersion/sealId/binding/generation/kind/ruleVersion/producerServiceId/sealedAt/references/unresolved/members/fingerprint。kind为observation/final；unresolved必须false；members等于全部records去掉payload后的元数据列表，顺序原样保留、数量由列表长度确定。fingerprint为SHA256(规范化seal去掉fingerprint)。与command三个封存期望及references严格一致。recordedAt/sealedAt为标准ISO毫秒UTC，记录不得晚于封存；同组版本时间不得倒退。sealId及来源字段是测试声明，不是密码学来源证明。

## 安全与容量边界

拒绝非普通JSON对象、符号/非枚举字段、访问器、数组空洞、非有限数/undefined；在复制前检查描述符，所有异常净化为INVALID_SOURCE_BUNDLE。复制后才异步执行资料判据，调用期间外部修改不改变核验基础。

夹具最多256条来源记录、100个上游版本/任务scopeKeys；JSON不超过2MiB、深度24、访问节点60,000、单数组1024项、单对象64键、字符串4096字符。定位字段另外受1～256字符限制。这些仅为规则夹具资源边界，不是生产容量/留存策略；超限拒绝，不裁剪清单。

本函数没有服务授权、来源生产者认证、业务记录关联核验、现存集合完整性证明或当前seal检查。即使自行拼出一致hash也不成为可信来源。它不验证supplement前序是否已发布/属于v2，不占共享requestId，不参与共同事务，不可直接接v1commit/append收费。其余C/P/S/V实库验收尚未执行。

下一步共同事务规则夹具与共享请求登记，需先确认相应接口切片；生产来源/SQL/全部Writer升级/读取门禁单独批准。

## 本轮验证

新增16项公开边界规则测试通过；类型检查和diff检查通过；允许本地HTTP监听后全量294项，276通过、18跳过、0失败。未配置或执行数据库验收。双线审查发现的历史引用/金额缺口已先复现失败、再修复并复审通过。TDD及输入安全审查仅针对本夹具，不代表生产来源认证或全项目安全审计完成。
