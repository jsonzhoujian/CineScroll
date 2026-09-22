# Project import module

This package contains the first T04 domain/application seam. It deliberately has no web framework or database dependency yet.

## Public seam

`ProjectImportService` owns these user-visible behaviours:

- create a project only after the user declares adaptation rights;
- inspect and import one chapter from normalized text;
- create immutable source versions and traceable source fragments;
- re-import a chapter while preserving history and returning a diff;
- hide project existence across workspace boundaries.

`InMemoryProjectImportRepository` is a deterministic test adapter, not the production persistence choice. The production PostgreSQL adapter will implement the same repository seam. Node.js executes the TypeScript directly and `tsc` supplies strict static type checking.

`MammothDocxTextExtractor` is the production DOCX-to-text adapter. It parses inside a worker thread with upload, timeout, archive-size, compression-ratio, path and external-reference guards. File parsing failures are normalized by `ProjectImportService` into the recoverable `MALFORMED_DOCUMENT` outcome.

Run the focused tests with:

```bash
npm run test:import
npm run typecheck
```
