# T08 — Versions, impact analysis, and collaboration

status: blocked  
blocked_by: [T07]  
unlocks: [T10]

## Goal

Protect confirmed work when upstream content changes and support non-realtime studio collaboration.

## Acceptance criteria

- Confirmed edits create new versions and identify potentially invalid downstream items.
- The system never silently regenerates affected or locked content.
- Users choose which affected items to keep, revise, or regenerate.
- Owners, editors, and reviewers follow the approved permission matrix.
- Suggestions contain replacement content, reason, author, status, and reviewer decision.
- Key operations appear in an immutable project audit view.
- Concurrent edit attempts fail safely without overwriting another member’s work.

