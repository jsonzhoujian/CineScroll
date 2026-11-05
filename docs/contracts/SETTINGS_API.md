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

The same opt-in `settingsTasks` switch now mounts review routes after migrations 0025–0031 and the expanded startup checks succeed. Existing enabled installations require that trusted-owner migration before upgrading; startup does not install it.

| Method | Route | Input / result |
|---|---|---|
| POST | `/projects/:p/chapters/:c/settings/review` | Review command; returns the immutable saved version |
| GET | `/projects/:p/chapters/:c/settings/versions/confirmed` | Independent formal version, or 404 |
| GET | `/projects/:p/chapters/:c/settings/versions/:id` | Read-only historical version, including the original generation |
| GET | `/projects/:p/chapters/:c/settings/operations/:requestId` | Original result for this actor's request, or 404; never executes a command |

Commands share `{kind,requestId,expectedActiveVersionId,reason}`. `edit` and `suggest` add `{assetId,value}` with a complete canonical asset; `decide` adds `{suggestionId,decision}` (`accepted` or `rejected`); `lock`/`unlock` add `{assetId}`; `confirm` adds nothing. Unknown fields are rejected. Actor, role, timestamps and operation fingerprint are assigned by the server.

Owners/reviewers may edit candidates, decide suggestions, confirm, lock and unlock. Editors may only suggest. Formal content changes require accepting a suggestion to derive a candidate, then reconfirming. Locked targets require explicit unlock first. Failure scopes or pending suggestions block confirmation. Writes use CAS; repeating an unchanged request returns its original result, and reusing its ID with different content returns 409.

Active/generation candidate reads additionally return `active` and `permissions` (`canEdit`, `canSuggest`, `canDecide`, `canConfirm`, `canLock`). `current` still describes upstream validity; `active` identifies the current review head. Inactive generation results and stale upstream results have no review action permissions. The active read follows review history, while the generation read always preserves the original result. Version/operation routes return `{version}` as read-only history.

Review errors use controlled codes: `INVALID_COMMAND` 400, `NOT_FOUND` 404, `FORBIDDEN` 403, `VERSION_CONFLICT`/`SUGGESTION_CONFLICT`/`INVALID_STATE`/`LOCKED`/`UPSTREAM_CHANGED` 409, and `STORAGE_UNAVAILABLE` 503. Responses are `no-store`. After an uncertain write, clients can read the original operation or reconcile the identical command; they must preserve request identity and avoid submitting a different operation. Browser review controls are implemented as described below; local regeneration browser controls are described below.


## Browser review behavior

The desktop workbench explicitly reads the current settings head before enabling review. Controls follow server permissions, upstream validity, active-head identity and each asset's lock. Editors can draft suggestions; owners/reviewers can edit candidates and decide suggestions. The form edits existing visible characteristics, state, state changes and restrictions while preserving asset identity and provenance. Suggestion details expose the complete proposed content and source evidence before a decision.

Confirmation is blocked for failure scopes, empty assets or pending suggestions. Formal changes proceed through suggestions and derive a candidate; the retained formal version remains readable until explicit reconfirmation. Mobile continues to provide read-only tracing.

Before a write, the exact command is saved to sessionStorage under its project/chapter/upstream context. An unknown outcome blocks new review actions; refresh restores the command but never automatically posts it. “核对设定原操作” reads the actor-scoped original operation; explicit resend preserves the same request ID/body. A successful write followed by a failed current-head read retains its reconciliation entry and reports that the write was saved. Command content is not placed in the URL. Missing/corrupt local recovery data fails closed. Browser review does not invoke a model or regenerate assets.


## Internal local regeneration persistence

Local regeneration now has authenticated submission/read routes listed below; execution and recovery remain internal. Migration 0030 and `PostgresSettingsRegenerationRepository` persist results through the existing review transaction. A result is bound to a running `settingsRegeneration` task and its actor, chapter, base version, selection, source, formal upstreams and generation parameters. The SQL guard independently reconstructs the permitted merge and rejects changes outside the selected unlocked targets. Invalid/failed replacements retain old assets; selected retryable failure scopes can be filled or retried. Task results remain immutable and actor-scoped, with one result per task. Candidate, active pointer and actual source-based script dependency registrations commit or roll back together; the confirmed pointer is retained until explicit confirmation. Production transport and independent Worker composition are implemented behind the existing default-off settings switch; Session API and browser controls are implemented as described below.


## Local regeneration Session API

These routes share the default-off production `settingsTasks` switch, Session verification and project/chapter membership. They never accept actor, source/upstream identities, credentials or provider URLs from the client. All successful responses are `no-store`.

- `POST /projects/:projectId/chapters/:chapterId/settings-regeneration-tasks`: exact body `{configurationVersionId,modelId,requestId,selection}`. `selection` is exactly `{expectedActiveVersionId,assetIds,failureScopeKeys,reason}`: 1–100 unique explicit targets in total, nonempty bounded reason and IDs. Owner/reviewer only; locks, pending target suggestions, active baseline, confirmed upstream, policy, BYOK, workspace/provider admission and same-base active-task protection are checked by existing services. Returns the queued/original task (201), never executes it inline. Shape-valid attempts consume the shared workspace generate budget; denial is 429 with `Retry-After`, unavailable limiter is 503 and queues nothing.
- `POST .../settings-regeneration-tasks/availability`: exact body `{configurationVersionId,modelId,selection}`. Returns `{available,reason}` (201), or a controlled context/permission/configuration error. Performs no model call or queue insertion. Selection and reason stay in the body instead of URL query parameters.
- `GET .../settings-regeneration-tasks?limit=20&cursor=...`: member-visible regeneration-only task page, limit 1–50. Historical reads remain available when upstream changes.
- `GET .../settings-regeneration-tasks/submissions/:requestId`: resolves the original request for the current workspace/actor/project/chapter. Missing/other-actor request is 404. This GET never submits or recovers a task. After an unknown submission, look up this exact request; explicit POST reconciliation must preserve its entire original body and request ID.
- `GET /settings-regeneration-tasks/:id`: member-visible state of a regeneration task; tasks from another stage/chapter membership scope are 404.
- `GET /projects/:projectId/chapters/:chapterId/settings/regenerations/:id`: explicitly loads the current actor's immutable result for that task, using the same `{version,current,active,permissions,sourceFragments,scriptVersion}` shape as initial generation. Unsaved/mismatched task or other actor's task result is 404. Evidence comes from the pinned historical source and confirmed script; stale results return `current:false` and retain read-only tracing. Shared review history remains readable via the existing version routes.

Errors follow task API codes: invalid context/configuration 400; missing task 404; forbidden/policy/workspace/provider 403; state/upstream/configuration version conflict 409; queue/execution capacity 429; controlled storage/configuration readiness failures 503. Unknown internal exceptions are sanitized as `STORAGE_UNAVAILABLE`.

No public run, recover or resubmit endpoint is mounted. An `EXECUTION_UNCERTAIN` task can be reconciled by GET or identical POST without execution; a new request for the same baseline cannot bypass the active-task guard. Only the internal Worker executes/reconciles saved results. Browser regeneration selection, submission reconciliation and explicit result loading are implemented below.


## Browser local regeneration behavior

The desktop workbench offers explicit asset/retryable-failure checkboxes only for the current active settings head and owner/reviewer permissions. Locked assets, pending target suggestions, nonretryable failures and overlapping asset/failure selections are disabled. The user supplies a bounded reason and selects a tested mainland model; submission first checks availability, then persists the exact request ID/configuration/model/selection to sessionStorage under the pinned project/chapter/upstream context before posting. Failure to persist sends no task. Reason/target contents are never placed in the URL.

Refresh restores the pending identity and exposes GET reconciliation, without automatic POST or model calls. If the active head has advanced, restore reads the saved baseline through the history API and displays it read-only until explicit result load. The original submission is queried by the current actor's request ID; only an explicit missing-submission response exposes resend of the same saved body/identity. An execution-uncertain task cannot be discarded to submit another job. A known failed/stopped task can be explicitly ended locally; new submission still passes server admission.

Completed task results require an explicit “载入设定重生结果”. The browser checks task kind, project/chapter, pinned source/upstreams, selected baseline/scopes/reason, result candidate ID, regeneration metadata/outcome, operation target and confirmed script identity before displaying them. A mismatch retains the pending identity and does not load the result. Loading a candidate retains the formal version for read-only comparison and reuses existing asset/source/script tracing. It does not confirm the candidate.

Pending review and regeneration states block new competing writes. Their GET reconciliation and formal-history reads remain available even if both identities are restored. Corrupt/unavailable browser recovery storage fails closed for writes while allowing current content to be read-only. Mobile hides submission/resend/end controls and permits read-only reconciliation and loading. Existing role, CAS, lock and unknown-execution guards remain authoritative on the server.


## Read-only upstream impact records

Full current/generation/regeneration views additionally return `impacts`: an array of immutable script impact links, or `null` when the read port is unavailable in a composition. An empty array means the query succeeded with no registered links; it does not establish that source import, story knowledge or episode-plan changes have no effect. `current` remains the authoritative overall upstream-validity indicator. Production uses the existing forced-RLS script-impact table, filtered by workspace/project/chapter, target stage `settings` and the exact settings version.

`GET /projects/:projectId/chapters/:chapterId/settings/versions/:id/impacts` returns `{versionId,impacts}` after Session, chapter membership and historical-version checks; inaccessible/missing versions are 404, read failures are sanitized 503 and successful responses are no-store. It performs no resolution, regeneration or lock write. Browser recovery of an earlier pending baseline queries this exact baseline's impacts and checks the response version ID, avoiding mixing in the advanced active head's links.

The settings panel shows target asset names, original script/element, the new confirmed script and “待核对”; locked targets explicitly retain the unlock requirement. Stale settings heads can load their pinned historical script/source even when the current script ID differs, with all review/regeneration writes blocked. A loaded stale formal script retains a read-only settings entry. No content, lock or pointer is rewritten by reading impact records. Script changes produce links only when the revised script is explicitly confirmed; suggestions/candidate revisions do not trigger downstream rewriting.

Remaining boundary: same-source explicit retention is implemented below; cross-source evidence migration/manual repair and pending-target regeneration remain T07-02b/T07-02c. Existing review/regeneration writers still require the settings version to match the current formal upstream. These read-only markers do not resolve an impact or authorize rebinding old evidence to new upstream versions; T07-02 remains in progress pending that controlled workflow and final acceptance.


## Same-source reconciliation (T07-02a)

Mounted by the existing default-off settings switch after trusted-owner migration 0031. `GET .../settings/reconciliation` is a read-only preview returning `{baseVersionId,sourceVersionId,upstreamConfirmedVersionIds,sameSource,requiresReconciliation,canBegin}`. Members can preview; only owner/reviewer may execute. The same source version and a different, currently valid formal upstream are required to begin. Source changes are explicitly rejected here.

`POST .../settings/reconciliation` accepts exactly `{kind,requestId,expectedActiveVersionId,expectedUpstreamConfirmedVersionIds,reason}` plus `assetId` only for `kind:"retain"`. Expected upstreams are an ordered three-ID acknowledgement, not authority supplied by the caller. The server rereads the real formal handoff and locks project, member, chapter and confirmed heads in the save transaction; actual script source/plan and plan parameters must match. Reasons/IDs are bounded as review commands; errors use existing review 400/403/404/409/503 mappings and responses are no-store.

- `kind:"begin"`: explicitly derives a candidate bound to the new formal script/plan/knowledge. Copies no asset into the effective collection by default. Existing assets and previously unfinished assets become `reconciliation.pendingAssets`; failures are tracked by `pendingFailureScopeKeys`. The metadata also records the immutable `originVersionId`. Locks are conserved, old suggestions remain in the old version and the new candidate's suggestions start empty. Original generation result/job identity stays unchanged.
- `kind:"retain"`: moves exactly the selected pending asset, unchanged, into effective `assets`; its original lock audit remains identical. No caller-provided asset value or evidence is accepted. Current-source canonical evidence is revalidated. Retain is not an unlock or confirmation.

All existing review operations continue through exact prior-state reconstruction and current epoch authority. Confirmation additionally requires both pending collections empty; existing failure/empty-asset/new-suggestion gates remain. Ordinary regeneration cannot process a half-reconciled candidate in either the application or SQL. New-version dependencies use the actual new formal script and shared source evidence, not the original generation's script. Version/head/formal pointer/dependencies commit or roll back together; role revocation cannot interleave through the held member lock. Historical generation, operations and formal pointers remain readable.

Actor-scoped `GET .../settings/operations/:requestId` reconciles original commands. The browser persists the exact request before POST, refresh never posts, and lost acknowledgements are read back. Successful write followed by read failure retains the original identity. Only a same-identity retry explicitly rejected by the server followed by the original-operation GET itself returning 404 permits a user to end unsaved reconciliation; a local rejection receipt is kept before clearing the pending record. A 404 from a subsequent current-view read never counts as evidence that the original write was absent. Unknown 5xx outcomes cannot be discarded or silently assigned a new request ID.

The desktop panel previews and starts explicitly, shows pending historical content/source plus lock notices, retains assets one by one, reads old suggestions without migration and requires ordinary explicit reconfirmation. Review/regeneration/reconciliation pending states block new competing writes while GET reconciliation stays available. The retained formal version may have a different script binding and is read-only; loading it validates project/chapter rather than treating it as current authority. Mobile remains read-only. No new model or public execution endpoint is introduced.
