# T03 — Architecture and stack decision

status: ready  
blocked_by: [T01a, T02]  
unlocks: [T04]

## Goal

Choose and document an architecture that supports mainland-China deployment, asynchronous AI workflows, canonical versioned content, and a responsive review client.

## Deliverables

- `docs/adr/0001-application-architecture.md`
- `docs/adr/0002-ai-provider-boundary-and-byok.md`
- `docs/adr/0003-mainland-data-and-object-storage.md`
- `docs/architecture/TEST_STRATEGY.md`
- Initial production repository scaffold and automated quality checks.

## Acceptance criteria

- Web, mobile-review, API, worker, relational data, object storage, queue, authentication, notification, observability, and deployment choices are justified.
- The AI provider adapter prevents provider-specific payloads from becoming domain objects.
- BYOK secrets, tenant isolation, audit logs, data residency, backups, and deletion are threat-modeled.
- Local development and CI can run deterministic contract tests without paid model calls.
- The chosen stack has an explicit cost envelope for closed beta.
