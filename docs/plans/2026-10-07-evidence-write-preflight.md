# 写入前来源核验

用户批准测试边界：createEvidenceWritePreflight的verifyPublish/verifySupplement。固定serviceId及工作室publish/supplement专用权限，引用请求严格拒绝资料/金额/URL。只返回核验草稿，不调用append或分配发布回执。

可信来源端口load(workspaceId,references)提供一致资料包、实际引用、snapshotToken及complete=true（包括全部原始结果），isCurrent核对token。端口是信任根：未来真实提供者必须证明完整性/真实性，不可接模型或请求自报。适配器验证引用与资料task/execution/result/pricing标识、既有资料判据，并再次核对token；结果不完整/变化/异常拒绝。补证从可信readPredecessor读取，检查同绑定/快照/执行ID及不能自引用。

引用每项为{id,version}，task/snapshot/execution必填，result/validation/pricing可null；存在结果必须引用validation，有成功计价必须引用pricing。请求只有requestId/references，补证另有predecessorId。请求身份不实现持久化幂等；资料ID来自可信来源草稿，不是已发布ID协议。

方法与配置在工厂绑定/复制，输入await前复制；错误FORBIDDEN/INVALID_REQUEST/NOT_FOUND/UNAVAILABLE/CONFLICT脱敏。仅测试夹具，无HTTP/真实任务/DB/收费。TDD回归双轴审查后本地提交。
