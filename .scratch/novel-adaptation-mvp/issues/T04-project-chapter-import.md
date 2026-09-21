# T04 — Project creation and chapter import tracer bullet

status: blocked  
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

