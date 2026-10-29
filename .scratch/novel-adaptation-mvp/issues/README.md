# Novel Adaptation MVP — Local Issue Tracker

Status values: `ready`, `blocked`, `in_progress`, `review`, `done`.

The dependency graph and delivery checkpoints are documented in `docs/plans/2026-09-21-mvp-delivery.md`.

| ID | Ticket | Current status | Blocked by |
| --- | --- | --- | --- |
| T01a | Public evidence and internal exploration | done | — |
| T01b | Operable-MVP target-studio validation | blocked | T07 |
| T02 | Canonical domain and data contracts | done | — |
| T03 | Architecture and stack decision | done | T01a, T02 completed |
| T04 | Project creation and chapter import tracer bullet | done | T03 completed |
| T05 | Story-knowledge extraction and confirmation | done | T04 completed |
| T06 | Script generation and source traceability | in_progress | T05 completed |
| T07 | Settings and storyboard workflow | blocked | T06 |
| T08 | Versions, impact analysis, and collaboration | blocked | T07 |
| T09 | Background AI jobs, model routing, and credits | blocked | T07 |
| T10 | Export, compliance, operations, and closed beta | blocked | T01b, T08, T09 |

2026-10-29：依据详细任务和代码入口同步，未重新验收。T04/T05 的 done 为历史交付记录，新增权限规则的实现对齐仍须追踪。用户已确认 T06 的[拆分方案](../../../docs/plans/2026-10-29-t06-ticket-draft.md)，独立任务如下。父项 T06 保持 in_progress，完成须核对原始验收条件。

## T06 remaining tickets

| ID | Ticket | Status | Blocked by |
| --- | --- | --- | --- |
| T06-01 | [生成并追溯剧本候选](./t06/01-generate-script-candidate.md) | done | — |
| T06-02 | [候选编辑与修改建议](./t06/02-review-edit-suggestions.md) | done | T06-01 completed |
| T06-03 | [失败范围重试](./t06/03-retry-failed-scopes.md) | ready | T06-01 completed |
| T06-04 | [质量报告、确认与锁定](./t06/04-quality-confirm-lock.md) | blocked | T06-02, T06-03 |
| T06-05 | [正式剧本修订与影响范围](./t06/05-revise-confirmed-script.md) | blocked | T06-04 |
| T06-06 | [闭环验收与 T07 交接](./t06/06-acceptance-handoff.md) | blocked | T06-05 |

T06-01 已完成，见[候选生成记录](../../../docs/plans/2026-10-29-script-candidate-delivery.md)；T06-02 已完成，见[候选审核记录](../../../docs/plans/2026-10-29-script-review-delivery.md)。当前可领取 T06-03；T06-04 仍等待 T06-03。T06 父项仍进行中。

T09 的 blocked 表示整体验收受阻；已交付基础设施与剩余门禁见[独立状态页](./T09-infrastructure-status.md)。
