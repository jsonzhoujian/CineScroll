# Project import module

This package contains the first T04 domain/application seam. It deliberately has no web framework or database dependency yet.

## Public seam

`ProjectImportService` owns these user-visible behaviours:

- create a project only after the user declares adaptation rights;
- inspect and import one chapter from normalized text;
- create immutable source versions and traceable source fragments;
- re-import a chapter while preserving history and returning a diff;
- hide project existence across workspace boundaries.

`InMemoryProjectImportRepository` is a deterministic test adapter, not the production persistence choice. The production PostgreSQL adapter will implement the same repository seam. Node.js executes the TypeScript directly for this dependency-free first slice; a workspace-wide compiler configuration is added with the production scaffold.

Run the focused tests with:

```bash
npm run test:import
```
