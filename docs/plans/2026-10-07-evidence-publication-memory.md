# 发布协议与内存原子规则

用户确认测试边界：协议ID/指纹函数、InMemoryEvidencePublicationRepository.commit/lookup/get、EvidencePublicationService.publish/supplement/lookup。请求/资料/审计/回执存于一个不可变复合记录，全部验证后一次Map.set；无独立append或半份状态。

serviceId固定，EvidencePublicationAccess专用publish/supplement授权每次检查（含重放/lookup），授权后先查既存请求指纹，重放不重新读取来源。可信prepare端口仅为测试资料/审计准备夹具，服务请求仍只有来源引用，不接受material。资料最终ID重算并重验，审计引用必须匹配请求，补证前序同workspace/binding/snapshot/execution，未知错误脱敏。

不实现真实来源屏障、服务身份认证、Postgres发布、持久化幂等、生产读取门禁/通知或扣费。内存提交原子仅为规则验证，不接受预核验草稿作为生产凭证。依赖绑定、配置/输入/输出副本隔离；固定时钟验证回执重放时间不变。TDD回归/双轴审查后本地提交。
