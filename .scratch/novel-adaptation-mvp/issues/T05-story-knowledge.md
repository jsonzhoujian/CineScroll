# T05 — Story-knowledge extraction and confirmation

status: in_progress
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

## Implementation progress

- [x] Establish the `StoryKnowledgeService` public seam and canonical story-fact types.
- [x] Persist successful facts from partially successful extraction while retaining item-level failures.
- [x] Restrict local retry scope to failures explicitly marked retryable.
- [x] Quarantine facts with missing or invalid source-fragment evidence as retryable item failures without discarding valid facts.
- [x] Preserve alias, hidden-identity, and conflicting-fact candidates with all evidence until a recorded user resolution.
- [ ] Support item edit, accept, reject, lock, and local retry transitions as immutable versions.
  - [x] Edit candidate facts with evidence preservation and an auditable reason.
  - [x] Accept or reject candidate facts without deleting their provenance.
  - [x] Merge retries for retryable failure scopes without replacing successful content.
  - [ ] Lock and unlock confirmed facts with owner/reviewer authorization.
- [ ] Confirm the stage as an owner or reviewer and publish a versioned story bible.
- [ ] Add persistence, authenticated API endpoints, background extraction adapter, and review UI.
