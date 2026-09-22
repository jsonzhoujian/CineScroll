# T04 — Project creation and chapter import tracer bullet

status: in_progress
blocked_by: [T03]
unlocks: [T05]

## Goal

Deliver the first vertical slice from authentication through project creation to a persisted, versioned chapter with stable source fragments.

## Acceptance criteria

- A user signs in by supported MVP authentication and creates a project with rights declaration, ratio, duration, and narrative type.
- Paste, TXT, and DOCX inputs are supported; multi-chapter files expose a selectable chapter list.
- One selected chapter up to 20,000 Chinese characters is stored as an immutable source version with stable fragment IDs.
- Re-import creates a new source version and displays a diff instead of overwriting history.
- Oversize, unsupported, malformed, and compliance-restricted inputs have distinct recoverable outcomes.
- Authorization and tenant-isolation tests cover project and source access.

## Implementation progress

- [x] Accept ADRs and establish the `ProjectImportService` public seam.
- [x] Require an adaptation-rights declaration when creating a project.
- [x] Import pasted/TXT-equivalent text, detect chapter headings, and persist one selected chapter in the repository port.
- [x] Create immutable source versions with stable fragment IDs, offsets, hashes, and character counts.
- [x] Re-import without overwriting history and return a paragraph-level diff.
- [x] Return indistinguishable not-found outcomes across workspace boundaries.
- [x] Cover rights and 20,000-character limit failures with machine-readable error codes.
- [x] Validate project option enums and expose chapter inspection before import.
- [x] Add TXT decoding and a Mammoth DOCX extraction adapter.
- [x] Normalize unsupported, malformed, and compliance-restricted inputs into distinct recoverable outcomes.
- [x] Prevent compliance-preflight bypass during import and re-import.
- [x] Isolate DOCX parsing in a worker and guard MIME spoofing, compression bombs, external references, and path traversal.
- [ ] Connect the compliance port to the production moderation provider.
- [ ] Replace the in-memory repository with PostgreSQL persistence and transactions.
- [ ] Expose the application seam through authenticated API endpoints and the import UI.
- [ ] Add phone-code and WeChat authentication adapters.
