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

Candidate reads return `{version,current,sourceFragments,scriptVersion}`. The source fragments and immutable formal script are read by the candidate's stored source/script IDs. They remain available for historical tracing after an active upstream changes; `current` becomes false. Historical readability grants no generation authority. If pinned evidence cannot be read, return a sanitized 503 instead of substituting current evidence. Editing, suggestion, confirmation and locking APIs belong to T07-02.

Unauthenticated requests return 401; inaccessible projects/results or wrong-stage task IDs return 404. Task configuration, policy and workspace admission failures retain the controlled 400/403/409/429/503 mappings used by existing task APIs. Unexpected read failures return only `STORAGE_UNAVAILABLE`, never storage messages or credentials. Browser explicit loading and trace interactions remain pending until their separate regression is complete.
