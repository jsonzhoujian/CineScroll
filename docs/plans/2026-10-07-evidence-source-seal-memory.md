# 来源封存内存规则实施计划

**Goal:** 验证用户确认的四个来源封存接口，不接真实来源、数据库或扣费。

**Architecture:** 预置固定工作室/单元/任务/快照绑定，以同步内存状态变更模拟集合屏障。清单复制后保存且永不覆盖；来源真实身份与执行关闭证明不在本轮范围。

**Tech Stack:** TypeScript、node:test、现有规范化JSON指纹函数。

## 已确认测试边界

registerSource、sealCollection、requireCurrentSeal、readSeal。既存发布仓储继续负责历史请求重放，本轮不复制发布协议或将点时核验接入发布。

## 切片与检查点

1. 新建packages/billing/test/evidence-source-seal.test.ts，观察缺模块失败；新建src/evidence-source-seal.ts，实现预置集合、observation和历史读取；运行单文件测试。
2. 添加迟到来源推进代/旧清单拒绝测试，观察失败；实现封存后新登记清除当前头且推进代；运行单文件测试。
3. 添加未关闭不能final、final后正常来源隔离测试，观察失败；实现失败关闭和隔离记录；运行单文件测试。
4. 添加同版本重放/异指纹冲突测试，观察失败；实现幂等比较；运行单文件测试。
5. 添加成功所需唯一结果、校验和计价测试，观察失败；实现保守完整性检查；运行单文件测试。
6. 添加非法来源/固定绑定/工作室隔离测试，观察失败；实现严格结构和复制隔离；运行单文件测试。
7. 补充同步并发、容量拒绝与异常事实重放测试；final后同版本异内容单独验证红—绿，事实保留在隔离集合，不覆盖旧流水。
8. 更新billing子路径导出、README、来源契约及T09增量记录；运行typecheck、全量node测试、diff检查；相对fbb9743执行Standards/Spec双线审查，修复后本地提交，不推送。

命令：`node --test packages/billing/test/evidence-source-seal.test.ts`、`env -i PATH="$PATH" pnpm typecheck`、`node --test packages/*/test/*.test.ts`。真实数据库用例不在本轮执行。

## 夹具限制

本轮验证：新增10项规则测试通过，类型检查通过；允许本地HTTP监听后全量270项，252通过、18跳过、0失败。未提供数据库测试配置，实库验收未执行。Standards/Spec双线审查无阻断，执行变量按建议改名；额外红—绿测试封闭相互矛盾的关闭执行版本，以及closed历史回退unknown的封存路径。

最多64个预置集合，每集合来源和隔离资料合计256项，字符串字段有界。ID/version/fingerprint仅为可信测试调用方声明，未绑定真实业务行或生产服务。final夹具仅支持已关闭无结果失败或唯一结果且有效校验/计价齐全的成功；其他结论保守拒绝，不能当作完整生产判据。执行资料版本按登记顺序观察，不提供远端版本排序/关闭证明。异常隔离仅内存保留与重放，没有裁决/导出/持久化接口，进程结束即丢失。requireCurrentSeal为点时断言，不持锁跨调用，不是发布事务。
