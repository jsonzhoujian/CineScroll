# T06 — Script generation and source traceability

status: in_progress
blocked_by: [T05]  
unlocks: [T07]

## Goal

Generate and confirm a structured dynamic-comic script while preserving evidence for every adaptation choice.

## Acceptance criteria

- Users select 1/3/5 minutes and confirm AI-recommended episode splits with source ranges and core events.
- Major changes are proposed individually and cannot enter the formal script without approval.
- Generated scenes contain environment, characters, actions, dialogue, narration, and sound.
- Literary environment and psychology are converted to visible/actionable forms with recorded conversion types.
- Every dialogue and action points to source fragments or an approved adaptation addition.
- Trace and review modes switch without losing selected chapter, scene, source fragment, confirmation, or suggestion state.
- Core-event coverage and prohibited core-fact mutation checks run against fixed fixtures.

## Incremental delivery — candidate element editing

- Domain service supports owner/reviewer text edits as new candidate versions, preserving source references, scenes and partial failures; stale-version writes are rejected.
- Edit reason, actor and timestamp are stored in the version snapshot. This is not yet the append-only audit log with requestId required by SYSTEM_DESIGN.
- Editors must use the planned suggestion workflow; direct editing is denied. This follows the agreed suggestion-first collaboration requirement; the product permission table still needs reconciliation before API/UI delivery.
- Remaining: suggestions, confirmation/locking, append-only audit and persistent/API/UI integration, as well as quality gates. T06 remains in progress.
- Verification: script package 15 tests pass; full suite 93 pass and 4 PostgreSQL integration tests skipped; script TypeScript check passes.
