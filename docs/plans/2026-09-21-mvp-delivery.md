# MVP Delivery Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Turn the confirmed product specification into a validated, contract-first MVP through independently verifiable tracer-bullet tickets.

**Architecture:** Begin with user validation and canonical data contracts, then establish the technical architecture. Build one thin end-to-end chapter flow before expanding stage depth, collaboration, billing, compliance, and exports. The three desktop work modes must remain projections over one canonical project state.

**Tech Stack:** T03 已完成选型，见 ADR-0001～0003；TypeScript 模块化单体、独立 Worker、Next.js、NestJS 和 PostgreSQL。架构中的队列和 Outbox 为目标设计，不表示全部已经接入。

---

## How to use this plan

- The local issue tracker is `.scratch/novel-adaptation-mvp/issues/`.
- Work only on tickets whose `blocked_by` entries are all complete.
- Each implementation ticket must be executed test-first and reviewed against both this plan and `docs/PRODUCT_SPEC.md`.
- Do not start production implementation until tickets T01a, T02, and T03 are approved.
- One ticket should produce a demonstrable vertical result, not a horizontal layer with no user-visible outcome.

## Dependency graph

```text
T01a public evidence + internal exploration
 └─→ T03 architecture decision ─→ T04 project + chapter import ─→ T05 story knowledge
T02 canonical contracts ────────┘                                  └─→ T06 script + trace
                                                                        └─→ T07 settings + storyboard
                                                                            ├─→ T01b target-studio validation
                                                                            ├─→ T08 version + collaboration
                                                                            ├─→ T09 async AI + credits
                                                                            └─→ T10 export + compliance + pilot
```

2026-10-29：T01a、T02～T05 已按详细任务记录完成；T06 进行中，Checkpoint C 尚未通过。T07、T08、T09 整体验收仍受阻；T09 独立基础设施进展不解除产品依赖。T01b 在可操作 MVP 后进行，继续作为 T10 和收费验证门禁。

优先完成 T06 的确认拆集 → 生成剧本 → 审核确认 → 原文追溯闭环，见[已确认拆分方案](./2026-10-29-t06-ticket-draft.md)与[独立任务索引](../../.scratch/novel-adaptation-mvp/issues/README.md)。当前可领取 T06-01，发布任务不代表开始实现或通过验收。T09 单独追踪[基础设施与整体验收](../../.scratch/novel-adaptation-mvp/issues/T09-infrastructure-status.md)。图中 T10 完整阻塞集合为 T01b、T08、T09；T07 为间接依赖。

## Delivery checkpoints

### Checkpoint A — Product evidence

Complete T01a. Expected result: primary sources establish the problem space, internal exploration exposes prototype inconsistencies, and all usability claims remain explicitly unvalidated.

### Checkpoint B — Contracts and architecture

Complete T02 and T03. Expected result: canonical entities, state transitions, AI boundaries, JSON Schema, storage region, security boundaries, and test strategy are explicit while UI decisions remain reversible.

### Checkpoint C — First tracer bullet

Complete T04–T06. Expected result: a user can import one chapter, confirm story knowledge, generate a script, and trace every script element back to source text.

### Checkpoint D — MVP workflow

Complete T07–T09. Expected result: settings and storyboard stages work, all three modes share state, changes propagate safely, and background AI jobs settle credits correctly.

### Checkpoint E — Closed beta

Complete T10. Expected result: confirmed data exports correctly, compliance gates are active, and the product is ready for 5–10 invited studios.

## Implementation discipline

For each implementation ticket:

1. Write one failing acceptance or contract test for the smallest behavior.
2. Run the focused test and verify the expected failure.
3. Implement only enough behavior to pass that test.
4. Run the focused test and the relevant regression suite.
5. Commit the slice with the ticket ID.
6. Repeat until all ticket acceptance criteria pass.
7. Run a Standards + Spec code review before closing the ticket.
