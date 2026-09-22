# T02 — Canonical domain and data contracts

status: done  
blocked_by: []  
unlocks: [T03]

## Goal

Define one canonical project model shared by trace, review, and storyboard modes, including AI input/output and export contracts.

## Deliverables

- `docs/contracts/DOMAIN_MODEL.md`
- `docs/contracts/STATE_TRANSITIONS.md`
- `docs/contracts/json/project.schema.json`
- One schema per AI stage under `docs/contracts/json/ai/`
- Valid and invalid fixtures under `docs/contracts/fixtures/`

## Acceptance criteria

- Entities, identifiers, ownership, version fields, confirmation states, locks, suggestions, provenance, and affected-item links are defined.
- Every story fact, script element, setting asset, and shot can reference stable source fragments or approved adaptation additions.
- Mode and UI selection state are separated from canonical content versions.
- Partial AI results and per-item failures have an explicit representation.
- DOCX/XLSX/JSON export fields map back to the canonical model.
- Schemas validate representative fantasy, urban, and suspense fixtures.

## Primary sources

- `CONTEXT.md`
- `docs/PRODUCT_SPEC.md` sections 4, 6, 8–10

## Completion

- Completed: 2026-09-21
- Contract index: `docs/contracts/README.md`
- Validation: all five Schemas pass Draft 2020-12 metaschema checks; fantasy, urban, suspense project fixtures and four AI response fixtures validate; all declared invalid fixtures fail as expected.
- T03 input: ready from T02. Together with completed T01a, T03 is now unblocked.
