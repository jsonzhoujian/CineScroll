# DeepSeek 故事知识传输

批准范围：一家国内厂商，使用任务服务解密后传入的工作室共享Key及固定模型；超时、请求/响应大小限制、结构/任务身份校验、错误脱敏，发送后不自动重试。仅模拟HTTP测试，不真实调用、不生产挂载、不改收费。

边界：CredentialedStoryKnowledgeModel.generate 与注入fetch端口；基线4e6e114。固定DeepSeek官方HTTPS地址，区域必须为已授权mainland，厂商不匹配拒绝。复用故事知识请求及提取校验和有界JSON读取；原文不作为系统指令。模型名来自服务端已测试配置，不硬编码产品目录或宣称实际数据驻留。

官方参考：https://api-docs.deepseek.com/api/create-chat-completion/ 和 https://api-docs.deepseek.com/guides/json_mode/ （2026-10-06查询）。JSON mode不保证语义或证据正确，Runner及持久化知识服务仍执行证据与权限校验。

完成与验证：新增适配器缺失红灯、调用期间输入修改导致错配红灯均确认后转绿；6项模拟HTTP测试通过，全量155通过/9项数据库集成跳过；API/script/story-knowledge类型检查与diff检查通过。Standards无硬违规，判断性建议为以后抽取与质量适配器重复的completion解析（当前不扩张）；Spec无阻断。安全边界已记录固定URL、不重定向、认证头Key、错误脱敏，未真实调用或部署。截止中止不证明远端未执行/未收费。
