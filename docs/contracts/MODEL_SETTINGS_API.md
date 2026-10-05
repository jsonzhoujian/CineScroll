# Workspace model settings API (opt-in)

Import `ModelSettingsApiModule` from `@novel-adaptation/api/model-settings` and register a session verifier plus `WorkspaceModelSettings`. This module is not mounted by the existing production bootstrap. Production must supply authoritative workspace membership/owner/advanced-entitlement checks, the PostgreSQL repository, an externally managed encryption key, approved processing routes and sensitive-endpoint rate limits before enabling it.

All routes require Bearer session authentication. Workspace and actor come exclusively from the session. Unknown body fields, including actor, workspaceId and endpoint, are rejected. Responses contain only public configuration fields and `keyMask`, never Key/ciphertext/nonce/tag. Do not log request bodies or configure middleware/APM to capture Key-bearing requests. Serve over HTTPS with bounded body size, restrictive CORS and non-caching responses.

| Method / path | Input | Permissions |
| --- | --- | --- |
| GET `/workspace/model-settings` | none | advanced workspace member; returns `{configuration: masked active configuration or null}` |
| POST `/workspace/model-settings` | `expectedVersionId: string|null`, `providerId: string`, `apiKey: string` | advanced workspace owner |
| POST `/workspace/model-settings/test` | `expectedVersionId: string`, `allowNonMainland: boolean` | advanced workspace owner |

Saving creates an untested configuration version; stale expected versions return 409. Testing creates a tested successor only on successful directory probing. Explicit non-mainland approval is checked before external access; unknown route fails closed. Directory readiness does not mean generation capability or account balance. The module does not expose credential decryption or paid generation endpoints.

Stable errors: 401 invalid session; 400 malformed input/INVALID_CONFIGURATION; 403 FORBIDDEN; 409 VERSION_CONFLICT; 503 NOT_READY/PROVIDER_UNAVAILABLE/STORAGE_UNAVAILABLE. Model-setting errors expose code-only messages, never upstream/internal error details. Production throttling must return 429; in-module throttling is not implemented in this slice.

HTTP fixtures use the actual domain service and in-memory repository, not real Key or paid calls. PostgreSQL adapter validation is separate; production bootstrap, job credentials, revocation/rotation, audit read APIs and UI remain pending.
