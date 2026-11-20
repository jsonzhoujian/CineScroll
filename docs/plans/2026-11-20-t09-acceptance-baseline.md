# T09 验收基线

## 本轮验证

| 命令 | 通过 | 失败 | 跳过 |
| --- | ---: | ---: | ---: |
| `node --test packages/billing/test/*.test.ts` | 148 | 0 | 11 |
| `node --test packages/api/test/*.test.ts packages/script/test/*.test.ts` | 229 | 0 | 7 |

使用 Node 24.21.0。直接运行 Node 避开本机 pnpm 启动错误。API 测试在允许监听本机回环地址后通过。跳过的 PostgreSQL 测试不计入验收证据。

## 剩余验收及顺序

1. 冻结 D1b 初始化访问权限配置。以已验证的隔离 SQL 为基准，覆盖角色及成员链、四张表的读策略、helper 定义、有效 ACL 和默认 ACL。隔离 PG16 验证配置正常、漂移拒绝、撤回后旧门禁恢复。 [权限前置证据](2026-10-09-source-initialize-access-precursor.md)
2. 实现并验收受控的来源初始化写入口。以真实最小权限身份验证共同写入、回滚、并发重放和未知提交恢复。 [写入口设计](2026-10-08-source-initialize-runtime-design.md)
3. 回到产品任务入口验收任务、额度冻结及 Outbox 的原子提交。验证中途失败全回滚、同请求重放仅一组记录、局部成功与失败分别结算、未知结果保留待核对，以及 BYOK 不消费平台额度。 [结算契约](../contracts/AI_CREDIT_SETTLEMENT.md)
4. 按 T09 原票补齐站内通知、真实模型时延、恢复和结算对账证据。 [T09 原票](../../.scratch/novel-adaptation-mvp/issues/T09-ai-jobs-credits.md)

本轮推进至基线回归。T09 仍为 ready，D1b 权限配置、共同事务和发布环境门禁待验收。
