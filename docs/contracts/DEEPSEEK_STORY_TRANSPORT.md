# DeepSeek 故事知识传输边界

`DeepSeekStoryKnowledgeModel` 实现内部 CredentialedStoryKnowledgeModel，接收已由任务服务鉴权并解密的当前工作室共享凭据。不持有工作室全局Key、不提供HTTP接口、不挂生产入口；默认构造也不会发请求。

仅允许providerId=deepseek、processingRegion=mainland，模型名来自已测试配置。区域值是服务端授权路由信息，不能证明供应商实际数据驻留；上线需另行核实合同与政策许可。固定 https://api.deepseek.com/chat/completions，不允许任意baseUrl和重定向。Key只在Authorization头，不在消息、结果或错误里记录。

请求含固定系统提取说明与单独的JSON用户数据消息，复制任务/原文身份，要求事实证据及待确认冲突；原文不是执行指令，不生成人工确认字段。输出受既有提取解析器校验，身份与调用时快照逐项匹配。模型目录不硬编码；具体模型的JSON能力与响应model名称需真实联调，当前严格要求返回model等于固定选择，不处理厂商别名。

请求上限2,000,000 UTF-8字节、响应上限1,000,000解码字节；默认60秒总截止时间，可设1～300000ms。截止后abort传输，仅一次请求，无自动重试。超时/HTTP或传输错误返回PROVIDER_UNAVAILABLE；完成体结构、JSON内容、截断或任务错配返回INVALID_RESPONSE；发送前配置/输入错误返回INVALID_REQUEST。错误消息均为稳定码，无cause、响应正文或原文。超时不意味着供应商未执行或未收费。

仅接受非流式单个assistant completion、finish_reason=stop，拒绝工具/函数调用。适配器只做传输与结构校验；Runner及知识服务继续执行原文证据、权限、生成许可和候选写入门禁，不自动确认结果。提示词分离不能保证抵御全部提示注入或语义错误，必须通过授权样本质量验收。

测试注入fetch，覆盖凭据认证头、请求快照、拒绝错误配置、大小限制、脱敏、截断/错配、超时及零重试。没有发送真实请求或验证语义准确率。fetch端口必须遵守AbortSignal取消连接/响应体；模拟忽略信号时调用仍按截止返回，但不能保证外部资源关闭。

官方协议参考：[Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)、[JSON Output](https://api-docs.deepseek.com/guides/json_mode/)；查询日期2026-10-06。
