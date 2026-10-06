# T06 — Script generation and source traceability

status: in_progress
blocked_by: [T05]  
unlocks: [T07]

## Goal

Generate and confirm a structured dynamic-comic script while preserving evidence for every adaptation choice.

## Incremental delivery — persisted episode-plan review (2026-10-06)

- Added PostgreSQL episode-plan versions, heads and operation results with immutable records, tenant/project RLS, upstream/source references and transactional CAS. Current source and confirmed knowledge are locked and compared through writes; formal heads cannot be cleared or rewound.
- Added optional authenticated read/history/major-adaptation decision/confirmation API, plus an upstream reader that rejects knowledge from old source versions. Editors are read-only for decisions/confirmation; owners and reviewers may decide.
- The review workbench explicitly reads saved candidates after story knowledge confirmation, displays target duration, per-episode source evidence and events, and requires each major-adaptation proposal to be decided before explicit confirmation. Empty/stale results do not become invented or editable candidates.
- Not delivered here: AI episode-plan background tasks/provider transport, production API wiring, script正文 API/UI/persistence or formal revision workflow. Trusted EpisodePlanRunner remains the candidate-writing entry. T06 stays in progress.
- Contract and verification: `docs/contracts/EPISODE_PLAN_WORKBENCH.md`, `docs/plans/2026-10-06-episode-plan-workbench.md`.

## Incremental delivery — episode task foundation (2026-10-06)

- Added explicit `resultType: episodePlan` for script-stage tasks, with exactly one confirmed knowledge version and no story retry metadata; legacy script tasks remain distinct.
- Episode tasks require explicit workspace/provider admission and generation policy. Queued tasks recheck admission before model invocation and pause when disabled.
- Request-scoped submission is idempotent under concurrent inserts; replay returns the original task snapshot and conflicting model selection is rejected. Source, knowledge or result type changes pause execution without invoking a model.
- Verification: 6 new public-service tests pass; full Node regression 171 pass, 10 database tests skipped; script TypeScript passes. No real model calls.
- Still outstanding: authoritative episode context/executor, persisted result recovery, dedicated scanning/dispatch, authenticated task API and review-page controls. This is task foundation only; T06 remains in progress. Plan: `docs/plans/2026-10-06-episode-plan-tasks.md`.

## Incremental delivery — episode task execution and reconciliation (2026-10-06)

- Authoritative episode context verifies project membership, current source (at most 20,000 characters), confirmed knowledge from that source and project generation parameters. Historical task reads use a membership-only gate while generation prerequisites remain strict.
- Internal credentialed executor constructs a frozen canonical request from source fragments and accepted story-bible facts. All accepted events are conservatively required as core events until a separate classifier exists. Existing plan heads prevent automatic overwrite; generation produces a candidate only.
- Before and after model response, checks source, confirmed knowledge, membership, parameters and generation policy. Final transactional upstream conflicts now use a typed VERSION_CONFLICT-compatible error and pause as UPSTREAM_CHANGED, distinct from candidate-head conflicts.
- Recovery uses the immutable generation operation index and matches source, knowledge and parameters even after review-head advances or source updates. Missing results become EXECUTION_UNCERTAIN; never reissue a model request.
- Verification: 11 executor integration tests pass; full Node regression 182 pass, 10 database tests skipped. Dedicated PostgreSQL operation-index/upstream-gate test passes; script/API TypeScript checks pass; dual review has no remaining blockers.
- Still not delivered: vendor-native episode transport, independent scan/dispatch, authenticated task API, generation/status UI and production wiring. No real AI calls or production enablement. T06 remains in progress.

## Incremental delivery — episode scanning and dispatch (2026-10-06)

- Latest increment (2026-10-06): independent episode task scanning and internal dispatcher now match both script stage and episodePlan result type, use workspace-scoped bounded byte-ordered pagination, and discover only queued tasks or expired/uncertain recovery tasks. Executors reauthorize original submitters and claim through CAS. Default-off worker loop is reused through its public tick interface; no production registration or public execution route was added.
- Verification: full Node suite 184 pass, 10 database tests skipped; dedicated real PostgreSQL task contract run 7 pass (including episode pagination, isolation and recovery); script/API TypeScript and Standards/Spec reviews pass. Added migration 0011 provides matching partial indexes, applied only to the isolated test database. Remaining: authenticated episode task API and review-page controls, vendor-native transport and production wiring.

## Incremental delivery — authenticated episode task API (2026-10-06)

- Optional Session-guarded module provides episode task submission, availability, chapter-scoped history and individual state reads; no public run/recover route. Only model selection plus requestId are accepted at submission; client context, workspace and Key fields are rejected.
- Current members can inspect historical tasks after source changes. Type, workspace and chapter filters isolate episode tasks from legacy script/story tasks. Fixed bounded cursor pagination is supported by memory and PostgreSQL adapters and migration 0012's partial chapter index.
- Admission/policy denial returns 403, intent conflicts 409, capacity errors 429, invalid request 400, missing/nonmember/wrong-kind 404. No-store and sanitized errors retain the credential boundary.
- Verification: full Node regression 186 pass, 10 database tests skipped; independent real PostgreSQL task contract run 7 pass; script/API TypeScript checks pass; Standards and Spec reviews have no remaining blockers. Security review drove strict session/input/secret boundaries; PostgreSQL best-practices review drove the list index. No real AI calls or production registration.
- Next: review-page model selection, submission, progress and explicit result loading. Shared production limits/billing, native vendor transport and production enablement remain deferred. T06 stays in progress.

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
- Remaining: append-only audit and persistent/API/UI integration, concrete quality evaluation and formal-version revision workflow. T06 remains in progress.
- Verification: script package 15 tests pass; full suite 93 pass and 4 PostgreSQL integration tests skipped; script TypeScript check passes.

## Incremental delivery — modification suggestions

- Members can submit replacement text and reasons without changing the target element. Owner/reviewer acceptance or rejection creates a successor version, preserving evidence and the suggestion's submission/decision metadata.
- Pending decisions require the current version; acceptance also requires unchanged target text. Identical decisions are idempotent and opposite decisions are rejected. Concurrent submissions use repository compare-and-swap.
- Suggestions currently belong to candidate snapshots, not a separate persistent collaboration store. Generation creates a fresh candidate; cross-generation suggestion migration, formal confirmation, API/UI and append-only audit remain unimplemented.
- Verification covers editor submission/decision denial, reviewer acceptance, owner rejection, stale target/version, duplicate decisions and concurrent submissions. The script package and TypeScript checks pass; full regression has 93 passing and 4 skipped PostgreSQL tests.

## Incremental delivery — confirmation and locking

- Owner/reviewer can confirm successful, nonempty candidates without failures or pending suggestions; confirmation requires an injected quality evaluator to explicitly pass the exact snapshot. No evaluator means confirmation is blocked. The production evaluator is not implemented yet.
- Confirmation and locking create successor snapshots with actor/time metadata and compare-and-swap protection. Locking is element-level metadata (selected elements, or all by default), not a content status; the version remains confirmed. Confirmation retries retain their candidate identity across locking; immediate lock retries are idempotent. Locking requires a confirmed version.
- Formal versions reject direct edits, suggestion mutations and generation overwrites. The planned explicit revision fork/impact workflow is not available yet, so formal-version changes fail closed.
- Verification: script package 16 passing tests; TypeScript check passes. Full suite 94 pass and 4 PostgreSQL tests skipped. API/UI and persistent audit remain deferred.

## Incremental delivery — quality evaluation rule engine

- `ScriptQualityEvaluator` implements the confirmation-gate interface and exposes a report bound to the candidate version. It requires matching confirmed plan/story knowledge, valid evidence, planned episode membership, and content in every planned episode.
- Semantic assessor output must exhaustively cover the planned core events, confirmed facts and episodes. The rule engine requires at least 90% covered events, consistent fact verdicts without uncertainty or unsupported core-fact additions, and each episode's estimated duration within 10% of target.
- Invalid, incomplete, duplicate or unknown references and assessor failures fail closed. Context and candidate snapshots are cloned to isolate assessor mutation.
- This delivery is the rule engine and model port, NOT a production semantic model adapter or proof of AI accuracy. Duration remains an estimate, not measured video runtime. Model prompts/provider integration, genre-specific authorized semantic regressions, bootstrap wiring, report persistence/API/UI remain outstanding.
- Verification: script package 19 passing tests; TypeScript passes; full regression 97 pass and 4 PostgreSQL tests skipped. Fixtures test rule behavior, including the 90% coverage and 10% duration boundaries.

## Incremental delivery — semantic gateway adapter

- Added `HttpScriptQualityModel` and a versioned project-owned gateway contract. Trusted assessment instructions are separate from untrusted manuscript/context data. Envelope and candidate identity are checked before the evaluator validates full verdicts.
- Server-configured HTTPS only, no redirects, bounded request/response bodies, configurable timeout, sanitized errors and no automatic paid retries. No real secrets were read and no works sent externally.
- This is a gateway client, NOT a vendor-native adapter or deployed gateway service. Gateway implementation, provider selection/credentials, production wiring and live semantic accuracy tests remain outstanding. Deployment must enforce approved regional egress and content-processing permissions; user-defined endpoints are not supported by this adapter.
- Added transport tests for prompt/data separation, bad configuration, version mismatch, malformed/oversized responses and cancellation. The package README documents integration and limitations.
- Rejected upstream response streams are explicitly cancelled; oversized requests fail before network access. Script package 23 tests pass and TypeScript passes; full regression 101 pass with 4 PostgreSQL tests skipped.
