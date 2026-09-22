# Novel Adaptation MVP — Local Issue Tracker

Status values: `ready`, `blocked`, `in_progress`, `review`, `done`.

The dependency graph and delivery checkpoints are documented in `docs/plans/2026-09-21-mvp-delivery.md`.

| ID | Ticket | Initial status | Blocked by |
| --- | --- | --- | --- |
| T01a | Public evidence and internal exploration | done | — |
| T01b | Operable-MVP target-studio validation | blocked | T07 |
| T02 | Canonical domain and data contracts | done | — |
| T03 | Architecture and stack decision | ready | T01a, T02 completed |
| T04 | Project creation and chapter import tracer bullet | blocked | T03 |
| T05 | Story-knowledge extraction and confirmation | blocked | T04 |
| T06 | Script generation and source traceability | blocked | T05 |
| T07 | Settings and storyboard workflow | blocked | T06 |
| T08 | Versions, impact analysis, and collaboration | blocked | T07 |
| T09 | Background AI jobs, model routing, and credits | blocked | T07 |
| T10 | Export, compliance, operations, and closed beta | blocked | T01b, T08, T09 |
