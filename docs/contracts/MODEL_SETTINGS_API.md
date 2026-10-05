# Workspace model settings API (opt-in)

## Production composition

### Disposable TLS end-to-end verification

Run `node --test packages/api/test/production-tls.test.ts` only with `TEST_TLS_DATABASE_URL` pointing to an isolated, disposable administrator-owned PostgreSQL cluster and `TEST_TLS_CA_PATH` pointing to its public trusted CA certificate. Without both variables the test is explicitly skipped. Never provide a business/staging shared database: this harness applies migrations, creates temporary roles, seeds fixtures and temporarily revokes/restores `novel_app` audit INSERT. Run it alone, not concurrently with other database tests. The cluster's temporary host authentication must permit the generated restricted login without a password; do not configure this policy on a deployed database.

The harness exercises the actual production factory and Nest listener: valid TLS initialization with a restricted login, unauthenticated rejection, fake-Key save, stale-version rejection, service restart and masked persistent read, subscription withdrawal, invalid CA rejection, extra role membership rejection and missing audit write privilege rejection. Temporary generated login roles are dropped; fixture rows stay in the disposable database. TLS certificates/private keys are generated outside the repository, not committed. No connection-test endpoint or paid inference is called.

This test passed against an isolated local TLS PostgreSQL cluster on 2026-10-05. It verifies the local production assembly, not deployed HTTPS/body/CORS/logging policy or vendor routing/semantic quality. Those remain rollout checks.

`createProductionApi` now accepts optional `modelSettings`. Omission or `{enabled:false}` preserves the original module and exposes no model-settings routes. `{enabled:true,encryptionKeyBase64,databaseUrl,databaseTlsCa,routes}` composes the authenticated settings module, encrypted PostgreSQL repository, authoritative membership/subscription reader, native directory probe and database rate limiter. The encryption key is canonical Base64 of 32 random bytes, obtained from an external secret manager; it must not reuse session/device key bytes. Back it up securely: losing or replacing it makes existing encrypted versions unreadable. Rotation is not delivered.

Use a separate restricted login for the model database pool, authorized to assume `novel_app`, never a migration administrator. The TLS CA is mandatory and certificate checking cannot be overridden by URL SSL/options parameters. Startup initialization checks effective role, rejects superuser/create-role/create-database/bypass-RLS login flags and checks authority/head tables plus rate-function execution privilege. An unavailable/unsafe/unmigrated database fails initialization with `MODEL_DATABASE_NOT_READY`; malformed configuration fails synchronously with `INVALID_MODEL_SETTINGS_CONFIG`. These checks do not certify all database grants: administrators must additionally review role memberships and schema/function ownership.

Routes contain only explicitly verified `mainland`/`overseas` metadata for implemented adapters. OpenAI, Anthropic and Google direct routes cannot be marked mainland; omitted vendors remain unavailable. Metadata is not a legal compliance certificate. Workspace-owner overseas approval is still required before external probing. The factory opens no HTTP listener and applies no migrations; the returned `close()` releases both pools. Deployment must still enforce HTTPS, bounded request bodies, restrictive CORS, no Key-bearing logging/APM, administrator-change audit and reviewed regional policy. No deployment or real model calls are performed by these tests.

## Shared workspace rate limits

Register `rateLimiter: new PostgresModelRateLimiter(pool)` from the server-side `packages/api/src/model-rate-limit.ts`; no limiter means POST operations fail with 503, not unlimited access. Apply `packages/api/migrations/0001_model_rate_limits.sql` with a trusted migration administrator after creating `novel_app`. The security-definer function must belong to a trusted non-application owner; the application gets function execution only, never table reset privileges. Untrusted roles must not own or replace this function.

Saving Key consumes at most 10 requests and connection testing 5 requests per workspace per 60-second window beginning at the first accepted attempt. Database-time windows and atomic locking are shared across instances. Counters are separate per operation; authenticated, shape-valid attempts count even if downstream authorization, version checks or the provider later reject them. Unauthenticated or malformed-body requests do not count. GET is unchanged. This is an attempt budget, not billing or a concurrency semaphore.

Exceeded budgets return HTTP 429, `Retry-After` seconds, and `{code:"RATE_LIMITED",message:"RATE_LIMITED",retryAfterSeconds:number}`. Storage faults return sanitized 503 and block mutations/probes. No in-memory fallback. Rows are bounded to two per encountered workspace; administrative cleanup of deleted workspaces is required before production rollout. This slice does not enable the production bootstrap or replace edge-level anonymous traffic protection.

For custom assembly, import `ModelSettingsApiModule` from `@novel-adaptation/api/model-settings` and register a session verifier, `WorkspaceModelSettings` and rate limiter. Production assembly mounts it only when the explicit configuration above is enabled. Deployment must supply the migrations, restricted login, externally managed key and verified route metadata.

All routes require Bearer session authentication. Workspace and actor come exclusively from the session. Unknown body fields, including actor, workspaceId and endpoint, are rejected. Responses contain only public configuration fields and `keyMask`, never Key/ciphertext/nonce/tag. Do not log request bodies or configure middleware/APM to capture Key-bearing requests. Serve over HTTPS with bounded body size, restrictive CORS and non-caching responses.

| Method / path | Input | Permissions |
| --- | --- | --- |
| GET `/workspace/model-settings` | none | advanced workspace member; returns `{configuration: masked active configuration or null}` |
| GET `/workspace/model-settings/capabilities` | none | active workspace member; returns advanced subscription, canManage and provider availability/route metadata; no Key or configuration |
| POST `/workspace/model-settings` | `expectedVersionId: string|null`, `providerId: string`, `apiKey: string` | advanced workspace owner |
| POST `/workspace/model-settings/test` | `expectedVersionId: string`, `allowNonMainland: boolean` | advanced workspace owner |

Saving creates an untested configuration version; stale expected versions return 409. Testing creates a tested successor only on successful directory probing. Explicit non-mainland approval is checked before external access; unknown route fails closed. Directory readiness does not mean generation capability or account balance. The module does not expose credential decryption or paid generation endpoints.

Stable errors: 401 invalid session; 400 malformed input/INVALID_CONFIGURATION; 403 FORBIDDEN; 409 VERSION_CONFLICT; 429 RATE_LIMITED; 503 NOT_READY/PROVIDER_UNAVAILABLE/STORAGE_UNAVAILABLE. Model-setting errors expose code-only messages, never upstream/internal error details. Shared throttling is implemented as described above.

HTTP fixtures use the actual domain service and in-memory repository, not real Key or paid calls. PostgreSQL adapter validation is separate; live deployment verification, job credentials, revocation/rotation, audit read APIs and UI remain pending.
