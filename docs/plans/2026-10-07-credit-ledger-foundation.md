# Credit Ledger Foundation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement an independent, trusted-server credit ledger without connecting task billing or production.

**Architecture:** Billing owns immutable entries, fixed task/unit reservations and event receipts. Public service commands authorize a trusted service principal and mutate an aggregate through repository revision CAS. Queries return cloned workspace-scoped snapshots; settlement reads evidence from an injected trusted reader, not client amounts. Fixed event IDs plus canonical content fingerprints are the chosen idempotency protocol.

**Tech Stack:** TypeScript, Node test runner, in-memory CAS repository, existing monorepo tooling.

---

User confirmed public seams: grant/reserve/settle commands and balance/entry queries. Scope excludes SQL persistence, task/Outbox coupling, payment, expiration, compensation and real model calls. The named superpowers skill is unavailable; execute directly with the available tdd skill in this checkout. No implementation delegation; use two agents only for the required closing review.

### Task 1: Grant and reserve

Files: create packages/billing/package.json, tsconfig.json, src/index.ts and test/credit-ledger.test.ts.

1. Write literal C01 test: grant100 then reserve60; assert available40/reserved60/consumed0 and ledger grant/reserve entries.
2. Run `node --test packages/billing/test/*.test.ts`; expect missing module/failing behavior.
3. Add minimal service and cloned in-memory revision CAS aggregate. Validate safe integers and trusted access; no HTTP entry.
4. Rerun; expect pass. Add one test at a time for insufficient funds, multiunit atomic reservations and event identity conflicts, then implement each slice.

### Task 2: Trusted settlement and uncertainty

1. Write C02: reserve60, trusted successful evidence50, consume50/release10 atomically, final balance50/0/50.
2. Run test red, then implement settle by evidence ID with workspace/task/unit/source binding and fixed receipt fingerprint.
3. Repeat red-green for clear failure release, unknown evidence retaining reservation, later reconciliation, BYOK exempt and over-quote reconciliation.
4. Do not accept outcome/amount from a caller as trusted evidence. Replays must return the original receipt; changed content conflicts. New event IDs cannot bypass closed-unit guards.

### Task 3: Concurrency, isolation and delivery

1. Red-green concurrent reserve60 twice against100: at most one succeeds. Test two services sharing the same repository, duplicate settlement race, tenant isolation, invalid/mutated input and query copies.
2. Run package tests and TypeScript, then `node --test packages/*/test/*.test.ts` (HTTP tests need local listener permission).
3. Update T09 and settlement contract with delivered subset/limitations. This does not unblock T09 or implement candidate/task/ledger transactions.
4. Standards + Spec review against32f1f0d; fix blocking findings with regressions.
5. Commit locally after verification, no push.

Numeric policy for this foundation: safe nonnegative integer quantities and checked aggregate sums; platform unit reservations must be positive, BYOK unit reservations zero. Each unit closes once; unknown/over-quote remains reconciling. Real quote/evidence validation, authenticated identity, durable persistence and permissions must be supplied before production integration.
