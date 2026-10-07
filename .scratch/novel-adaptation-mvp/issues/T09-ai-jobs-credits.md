# T09 — Background AI jobs, model routing, and credits

status: blocked  
blocked_by: [T07]  
unlocks: [T10]

## Goal

Operate every AI stage reliably with resumable background work, transparent credit settlement, and optional BYOK.

## Design increment — credit ledger and settlement boundary (2026-10-07)

- User-approved documentation-only delivery: `docs/contracts/AI_CREDIT_SETTLEMENT.md` defines workspace ledger, immutable billing responsibility, unit reservations/settlements/releases, idempotency, evidence and reconciliation, plus C01–C18 future acceptance cases.
- Platform submission/task/reservation/Outbox must be atomic; BYOK has no platform-model reservation or consumption. Unknown execution retains reservations and reconciles without regenerating.
- Existing runtime has neither ledger nor platform billing and candidate/task completion is not atomic. This design does not enable charging, implement payment or clear T09's T07 dependency. Unit pricing, expiry/entitlements, over-quote handling, compensation permissions and retention remain decisions before real charging.

## Incremental delivery — independent ledger foundation (2026-10-07)

- New billing domain package exposes trusted grant/reserve/settle and balance/entries/task queries, fixed event identities and canonical content fingerprints, immutable snapshots/entries, workspace-scoped authorization and in-memory revision CAS.
- Successful units consume and release remaining reservation in one update; failures release, unknown/over-quote stays reconciling, BYOK stays exempt without zero-value credit entries. Grant/task/evidence identity guards prevent repeated writes with new event IDs. Runtime validation rejects extra fields and unsafe integer sums; explicit true authorization is required.
- This is independent domain infrastructure, not PostgreSQL storage, task/reservation/Outbox coupling, authenticated service identity, actual evidence/quote validation, compensation, expiry, payment or production charging. Shared-memory concurrency is tested; cross-process guarantees and real balance service remain undelivered. T09 keeps its blocked dependency.
- Plan: docs/plans/2026-10-07-credit-ledger-foundation.md. Package README defines trusted-port and persistence limitations. Verification: billing package 13 tests pass; full Node regression 211 pass and 10 skip; full workspace typecheck passes. Standards/Spec reviews have no remaining blockers; strict-true authorization and sanitized actor-clone failure regressions pass.

## Acceptance criteria (original scope, unchanged)

- Jobs expose queued, running, partial-success, failed, restricted, awaiting-user, and completed states.
- Closing the page does not interrupt jobs; completion and required action create in-app notifications.
- Submission freezes estimated credits; successful units settle and failed units refund automatically and idempotently.
- Retries target failed units only and cannot double-charge or overwrite locked content.
- Default model routing and provider failover remain behind a domain-neutral adapter.
- BYOK secrets are encrypted, never logged, scoped per tenant, and calls do not consume platform model credits.
- One chapter per stage normally completes within the five-minute service target under documented test conditions.
