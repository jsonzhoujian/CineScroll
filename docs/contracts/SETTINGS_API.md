# Settings Session API (T07-01)

Routes are mounted only when production `settingsTasks.enabled` is true. All routes require a verified Session and project/chapter membership. Successful responses use `Cache-Control: no-store`. Client input never supplies actor, source, upstream or provider credentials.

| Method | Route | Input / result |
|---|---|---|
| POST | `/projects/:p/chapters/:c/settings-tasks` | Exact body `{configurationVersionId,modelId,requestId}`; idempotent task submission |
| GET | `/projects/:p/chapters/:c/settings-tasks` | Optional `limit` (1–50, default 20), `cursor`; `{tasks,nextCursor}` |
| GET | `/projects/:p/chapters/:c/settings-tasks/availability` | Exact query `{configurationVersionId,modelId}`; availability and controlled reason |
| GET | `/settings-tasks/:id` | Settings-stage task status; another stage's task returns 404 |
| GET | `/projects/:p/chapters/:c/settings` | Active settings candidate and evidence; no query parameters |
| GET | `/projects/:p/chapters/:c/settings/generations/:jobId` | Persisted result for that chapter's settings task, for explicit loading |

Submission shares the existing workspace generation rate budget and task capacity/admission checks. Shape-valid attempts denied by the rate limiter return 429 with `Retry-After`; limiter failure returns 503 and queues nothing. Unknown body/query fields are rejected on submission, availability and task listing. Run/recover/retry endpoints are not exposed by this increment; trusted background Workers execute and reconcile tasks.

Candidate reads return `{version,current,active,permissions,sourceFragments,scriptVersion}`. The source fragments and immutable formal script are read by the candidate's stored source/script IDs. They remain available for historical tracing after an active upstream changes; `current` becomes false. Historical readability grants no generation authority. If pinned evidence cannot be read, return a sanitized 503 instead of substituting current evidence. Editing, suggestion, confirmation and locking APIs are documented in the T07-02 section below.

Unauthenticated requests return 401; inaccessible projects/results or wrong-stage task IDs return 404. Task configuration, policy and workspace admission failures retain the controlled 400/403/409/429/503 mappings used by existing task APIs. Unexpected read failures return only `STORAGE_UNAVAILABLE`, never storage messages or credentials. Browser explicit loading and trace interactions passed the T07-01 regression; review controls are described below.

## T07-02 review API

The same opt-in `settingsTasks` switch now mounts review routes after migration 0028 and the expanded startup checks succeed. Existing enabled installations require that trusted-owner migration before upgrading; startup does not install it.

| Method | Route | Input / result |
|---|---|---|
| POST | `/projects/:p/chapters/:c/settings/review` | Review command; returns the immutable saved version |
| GET | `/projects/:p/chapters/:c/settings/versions/confirmed` | Independent formal version, or 404 |
| GET | `/projects/:p/chapters/:c/settings/versions/:id` | Read-only historical version, including the original generation |
| GET | `/projects/:p/chapters/:c/settings/operations/:requestId` | Original result for this actor's request, or 404; never executes a command |

Commands share `{kind,requestId,expectedActiveVersionId,reason}`. `edit` and `suggest` add `{assetId,value}` with a complete canonical asset; `decide` adds `{suggestionId,decision}` (`accepted` or `rejected`); `lock`/`unlock` add `{assetId}`; `confirm` adds nothing. Unknown fields are rejected. Actor, role, timestamps and operation fingerprint are assigned by the server.

Owners/reviewers may edit candidates, decide suggestions, confirm, lock and unlock. Editors may only suggest. Formal content changes require accepting a suggestion to derive a candidate, then reconfirming. Locked targets require explicit unlock first. Failure scopes or pending suggestions block confirmation. Writes use CAS; repeating an unchanged request returns its original result, and reusing its ID with different content returns 409.

Active/generation candidate reads additionally return `active` and `permissions` (`canEdit`, `canSuggest`, `canDecide`, `canConfirm`, `canLock`). `current` still describes upstream validity; `active` identifies the current review head. Inactive generation results and stale upstream results have no review action permissions. The active read follows review history, while the generation read always preserves the original result. Version/operation routes return `{version}` as read-only history.

Review errors use controlled codes: `INVALID_COMMAND` 400, `NOT_FOUND` 404, `FORBIDDEN` 403, `VERSION_CONFLICT`/`SUGGESTION_CONFLICT`/`INVALID_STATE`/`LOCKED`/`UPSTREAM_CHANGED` 409, and `STORAGE_UNAVAILABLE` 503. Responses are `no-store`. After an uncertain write, clients can read the original operation or reconcile the identical command; they must preserve request identity and avoid submitting a different operation. Browser review controls are implemented as described below; local regeneration remains pending.


## Browser review behavior

The desktop workbench explicitly reads the current settings head before enabling review. Controls follow server permissions, upstream validity, active-head identity and each asset's lock. Editors can draft suggestions; owners/reviewers can edit candidates and decide suggestions. The form edits existing visible characteristics, state, state changes and restrictions while preserving asset identity and provenance. Suggestion details expose the complete proposed content and source evidence before a decision.

Confirmation is blocked for failure scopes, empty assets or pending suggestions. Formal changes proceed through suggestions and derive a candidate; the retained formal version remains readable until explicit reconfirmation. Mobile continues to provide read-only tracing.

Before a write, the exact command is saved to sessionStorage under its project/chapter/upstream context. An unknown outcome blocks new review actions; refresh restores the command but never automatically posts it. “核对设定原操作” reads the actor-scoped original operation; explicit resend preserves the same request ID/body. A successful write followed by a failed current-head read retains its reconciliation entry and reports that the write was saved. Command content is not placed in the URL. Missing/corrupt local recovery data fails closed. Browser review does not invoke a model or regenerate assets.


## Internal local regeneration persistence

Local regeneration has no public submission/execution route yet. Migration 0030 and `PostgresSettingsRegenerationRepository` persist results through the existing review transaction. A result is bound to a running `settingsRegeneration` task and its actor, chapter, base version, selection, source, formal upstreams and generation parameters. The SQL guard independently reconstructs the permitted merge and rejects changes outside the selected unlocked targets. Invalid/failed replacements retain old assets; selected retryable failure scopes can be filled or retried. Task results remain immutable and actor-scoped, with one result per task. Candidate, active pointer and actual source-based script dependency registrations commit or roll back together; the confirmed pointer is retained until explicit confirmation. Production transport/Worker composition and API/browser controls remain pending.
