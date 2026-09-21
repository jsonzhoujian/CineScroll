# T05 — Story-knowledge extraction and confirmation

status: blocked  
blocked_by: [T04]  
unlocks: [T06]

## Goal

Turn a source version into reviewable story knowledge without silently resolving ambiguity or contradiction.

## Acceptance criteria

- A background task extracts people, relationships, events, scenes, props, and world rules with source evidence.
- Explicit source facts and AI inferences are visibly distinct.
- Alias, hidden-identity, and conflicting-fact candidates retain all evidence until a user decides.
- Users can edit, accept, reject, lock, and locally retry knowledge items.
- Partial success persists valid items and permits retry of failed items only.
- A responsible owner or reviewer can confirm the stage, producing a versioned story bible.

