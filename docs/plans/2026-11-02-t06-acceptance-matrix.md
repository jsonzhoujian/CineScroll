# T06 原始验收证据矩阵

状态：核对中，不能据此关闭父项。基线 e813798。引用现有用例只说明存在证据，本轮未重新执行全部用例。

| 原始要求 | 可重复证据入口 | 当前判断与缺口 |
| --- | --- | --- |
| 1/3/5分钟、拆集原文范围与核心事件、明确确认 | packages/script/test/episode-plan-runner.test.ts；packages/api/test/episode-plan-task-executor.test.ts；packages/web/e2e/task-status.spec.ts | 既有拆集用例；仍须核对三个时长的完整矩阵与三类样本的拆集起点 |
| 重大改编逐项批准才进入正式内容 | packages/script/test/script-runner.test.ts；拆集审核API/浏览器回归 | 存在门禁测试；新增未决零调用/写入，以及approved/rejected裁决精确传输分支；仍需与真实拆集逐项裁决API和三类演示衔接 |
| 场次含环境、人物、动作、对白、旁白和声音 | packages/script/test/script-content.test.ts；docs/contracts/json/ai | 领域类型/校验覆盖；三类闭环样本现含环境、人物、动作、对白、旁白、声音，检查元素类型及对白speaker；固定模拟不证明真实生成质量 |
| 文学环境、心理转可视动作，保留转换类型 | packages/script/test/t06-acceptance.test.ts | 固定输入/模拟输出包含 actionized、visualized；真实模型语义正确性未测量 |
| 每条对白/动作对应原文或获批新增 | packages/script/test/t06-acceptance.test.ts；script-content.test.ts；script-runner.test.ts | 三类样本逐元素检查来源；对白已串入；获批新增完整演示仍需补齐 |
| 追溯/审核切换不丢章节、场次、片段、确认和建议 | packages/web/e2e/task-status.spec.ts 的“剧本候选编辑和建议权限及模式恢复” | 既有模式与刷新恢复；三模式精确游标矩阵尚待核对，未生成的分镜不能虚构可操作数据 |
| 核心事件覆盖和禁止核心事实变更，固定样本回归 | packages/script/test/script-quality.test.ts；t06-acceptance.test.ts | 90%/时长阈值、冲突/未知/不完整门禁已有回归；语义 verdict 为模拟，不证明模型准确率 |
| 部分失败重试、成功保留、建议/锁定/修订/重新确认 | packages/script/test/t06-acceptance.test.ts；postgres-script-content.test.ts；task-status.spec.ts | 三类公开服务样本已串联，隔离实库及浏览器另有分层证据；不冒充同一次真实模型端到端 |
| T07只读取当前有效正式剧本 | packages/script/test/script-handoff.test.ts；packages/api/test/script-revision-api.test.ts | 已有严格读取与API装配；T07保存事务仍须复验并登记精确依赖；待双轴复审 |

## 证据分级和发布门禁

- 模拟传输/固定语义：可以证明请求身份、版本、结构、权限、门禁及恢复行为，不能证明语义质量。
- 隔离 PostgreSQL/TLS：可以证明RLS、CAS、迁移、正式指针、修订及影响事务；测试实例不是生产环境。
- 真实模型语义：本轮无证据，不调用真实密钥、不自动付费。真实样本评分、核心事实人工核对和目标工作室验证仍是发布门禁。
- 工作模式和游标不构成确认、生成或版本修改授权。历史正式版可读不构成旧上游生成授权。

## 后续收敛顺序

1. 为三类样本补齐对白/旁白/声音/环境与人物身份，逐项核查来源和转换类型。
2. 串联重大改编未决拒绝与批准后生成，核对三种时长和模式游标。
3. 重跑必要集成与浏览器回归，归档实际结果和环境。
4. Standards/Spec 双轴审查后，逐项更新 T06-06 与父项；真实语义发布门禁单独保留。
