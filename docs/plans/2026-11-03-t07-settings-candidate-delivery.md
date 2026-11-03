# T07-01 文字设定候选交付验收

本票覆盖“已确认剧本 → 文字设定生成 → 显式加载候选 → 原文／正式剧本追溯”。设定审核确认、锁定和局部重生由 T07-02 承接，分镜尚未实现。

| 公开边界 | 验证内容 | 证据 |
|---|---|---|
| Session API | 幂等提交、任务类型隔离、分页、认证/权限、限流故障零入队、过期候选固定依据 | `packages/api/test/script-content-task.test.ts` |
| Worker | 正式上游身份及许可复验、部分失败隔离、保存回执丢失后读取原结果恢复且不重调模型 | 同上及 `settings-task-executor.ts` / `settings-task-dispatcher.ts` |
| 候选仓储 | 持久化重连、首次生成并发控制、任务恢复、强制RLS、不可变、上游变化拒绝、依赖写入失败整笔回滚 | `packages/script/test/postgres-script-content.test.ts`，临时隔离PostgreSQL通过 |
| 浏览器 | 正常生成后显式加载、原文与正式剧本追溯、未知提交刷新后使用原请求核对、错配拒绝、过期只读、移动端历史加载/追溯且零生成 | `packages/web/e2e/task-status.spec.ts` 的设定五场景 |
| 受控生产装配 | 大陆固定HTTPS传输、独立默认关闭、同库TLS/白名单/启动预检、停机清理、Session链路重启零额外调用 | `deepseek-settings-model.test.ts`、`production.test.ts`、真实临时TLS库 `production-tls.test.ts` |

资产与剧本元素的依赖按共享 `source_fragment` 依据登记，与候选及章节头同事务提交，不把全章元素都登记为依赖。canonical设定响应不含剧本元素ID；该映射是依据关系，不宣称模型完成了语义关联判断。生产获批新增入口尚未开放，当前仍拒绝未经批准的新增引用。

浏览器不自动读取候选或启动/恢复模型；恢复未知提交只复用原requestId核对原任务。服务端执行结果未知时，仅由可信后台读取已保存结果恢复。正式上游变化后，历史候选仍可追溯但不能作为新生成授权。文字内容按React文本渲染，不作为HTML或外部资源执行。

验收结果：Node全套431项（409通过、22项条件数据库跳过）；Chromium全套57项通过，包含本票新增五场景；web类型检查与Next生产构建通过。真实临时数据库/TLS回归已通过；全部模型响应为合成数据，未使用真实密钥、部署迁移、启用生产任务或真实计费。Standards/Spec整票复核未发现阻断问题。

运行配置与Session接口分别见 [MODEL_SETTINGS_API.md](../contracts/MODEL_SETTINGS_API.md) 与 [SETTINGS_API.md](../contracts/SETTINGS_API.md)。T07父项及T09整体验收保持原状态，不能因本票完成而视为完整MVP交付。
