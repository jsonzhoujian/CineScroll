# 以独立v2协议绑定封存身份，跨版本共享请求唯一键

Status: Accepted（用户确认协议方向与四个公开测试边界；运行时、数据库和生产兼容接线尚未实施）。

v1请求指纹不包含期望封存身份，直接加字段会改变旧请求重放语义。因此新增evidence-publication-v2，将单元及期望sealId/generation/manifestFingerprint纳入指纹；v1保留原ID、指纹和授权重放行为，不静默改写历史。两版共用(workspaceId,requestId)唯一命名空间，跨版本占用返回冲突，不重新发布、不自动升级或降级。

代价是未来共同请求登记与兼容适配需要协调，现有两个独立内存仓储不能证明跨版本去重；迁移必须显式批准。拒绝直接修改v1和按protocolVersion分开请求键两种方案，前者破坏历史，后者允许同一业务请求跨版本双发。四个确认边界为完整来源包校验、publishFromSeal、lookupPublished、readPublishedEvidence；具体规范及未来测试见[v2协议契约](../contracts/EVIDENCE_PUBLICATION_V2.md)。
