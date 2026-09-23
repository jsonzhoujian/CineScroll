# Project import module

This package contains the first T04 domain/application seam and its PostgreSQL persistence adapter. It deliberately has no web framework dependency yet.

## Public seam

`ProjectImportService` owns these user-visible behaviours:

- create a project only after the user declares adaptation rights;
- inspect and import one chapter from normalized text;
- create immutable source versions and traceable source fragments;
- re-import a chapter while preserving history and returning a diff;
- hide project existence across workspace boundaries.

`InMemoryProjectImportRepository` is a deterministic test adapter. `PostgresProjectImportRepository` is the production persistence choice behind the same repository seam. Node.js executes the TypeScript directly and `tsc` supplies strict static type checking.

`MammothDocxTextExtractor` is the production DOCX-to-text adapter. It parses inside a worker thread with upload, timeout, archive-size, compression-ratio, path and external-reference guards. File parsing failures are normalized by `ProjectImportService` into the recoverable `MALFORMED_DOCUMENT` outcome.

`HttpComplianceScanner` connects the provider-neutral compliance port to a production HTTPS moderation gateway. The gateway accepts `{ "text": string }` with bearer authentication and returns `{ "allowed": boolean, "reason"?: string, "requestId"?: string }`. The adapter enforces HTTPS, API-key and timeout configuration, normalizes malformed/non-success responses, and never exposes the upstream body. `ProjectImportService` requires a scanner at construction, maps gateway failures to the recoverable `COMPLIANCE_UNAVAILABLE` outcome and carries the provider request ID across its public boundary; configure the concrete mainland provider at the deployment boundary.

`PostgresProjectImportRepository` persists projects, members, chapters, immutable source versions and reusable source fragments. Its transaction boundary sets request-scoped user/workspace context, applies a five-second statement timeout and relies on PostgreSQL RLS as a second tenant-isolation boundary. Chapter creation and version appends use chapter-scoped commands: an append locks only the target chapter and reads only its active source version. Set `TEST_DATABASE_URL` to run the real database integration test.

Run the focused tests with:

```bash
npm run test:import
npm run typecheck
TEST_DATABASE_URL=postgres://... npm run test:postgres
```
