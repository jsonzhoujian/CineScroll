# MVP Delivery Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Turn the confirmed product specification into a validated, contract-first MVP through independently verifiable tracer-bullet tickets.

**Architecture:** Begin with user validation and canonical data contracts, then establish the technical architecture. Build one thin end-to-end chapter flow before expanding stage depth, collaboration, billing, compliance, and exports. The three desktop work modes must remain projections over one canonical project state.

**Tech Stack:** To be selected and recorded by ticket `T03`; Markdown and JSON Schema are used for pre-implementation artifacts.

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

T01a and T02 are complete, so T03 is ready. T01b is deliberately deferred until an operable MVP exists and remains a gate for T10 and paid launch validation.

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
