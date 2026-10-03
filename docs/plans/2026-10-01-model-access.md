# Workspace Model Access Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Workspace-owned BYOK credentials and provider/model selection for domestic and international text AI, managed by owners.

**Architecture:** Catalog entries are candidates, not proof of integration. The server performs owner/advanced-plan checks, encrypts keys, probes available models through an adapter port and creates immutable configuration versions. Jobs pin a tested configuration; no cross-provider/region fallback. Actual processing region is configured per integration, never inferred from brand nationality.

**Tech Stack:** TypeScript, Node crypto AES-256-GCM, existing domain service/port architecture, later PostgreSQL/API/Next.js.

## Task 1 — Catalog and secure domain foundation (this delivery)

Status: implemented as domain foundation. Script typecheck passes; full regression 104 pass, 4 PostgreSQL tests skipped. Two-axis review found a pre-probe regional authorization gap and missing cryptographic/CAS test coverage; regional checks were moved before external calls and concurrent configuration/cross-workspace ciphertext tests added. Single active workspace configuration and in-memory storage are deliberate first-slice limits; multi-provider credential slots and production secret resolution are not complete.

Files: `packages/script/src/model-settings.ts`, `packages/script/test/model-settings.test.ts`, package exports.

1. Write a failing public-service test for owner configuration, editor denial, advanced subscription, masked reads, encrypted persistence and workspace isolation. Run `node --test packages/script/test/model-settings.test.ts` (expect module missing).
2. Implement catalog for Alibaba, Volcano, DeepSeek, Zhipu, Moonshot, MiniMax, OpenAI, Anthropic, Google, xAI, Mistral and OpenRouter. Separate direct providers from aggregators; do not hardcode unstable model IDs or endpoint assumptions.
3. Implement an immutable configuration containing ID, parent version, provider/model selection, encrypted key and test status. Service rejects non-owner mutations and unmet entitlement; public results exclude ciphertext and key. Encryption AAD binds workspace and configuration ID.
4. Test configuration version conflicts, secret authentication, disabled model use until connection test, regional consent and pinned job snapshots through public interfaces. Models come from verified adapter probes, not merely labels.
5. Run targeted tests plus `node packages/script/node_modules/typescript/bin/tsc --project packages/script/tsconfig.json`, then full `node --test`. Two-axis review against HEAD before scoped commit.

## Task 2 — Native provider adapters

Status: partial. First protocol slice adds DeepSeek native directory/authentication probe with a fixed official endpoint, explicit route metadata, bounded response, cancellation and sanitized errors. Directory access is not inference validation; generation adapters, capability checks, all other providers and production wiring remain outstanding. No live credentials or paid model calls used.

Verification: native probe 3 tests pass, covering authentication, malformed/duplicate directory entries, invalid keys, content type/UTF-8, size bounds and streaming cancellation/timeout. Script TypeScript check passes. Final full suite: 107 pass, 4 PostgreSQL integration tests skipped. Two-axis review found no blocking defect; transport coverage gaps were addressed. Shared bounded-JSON transport extraction is a future maintainability improvement.

Next partial delivery: DeepSeek native JSON-mode quality assessment adapter with shared trusted prompt, explicit server route metadata, finish-reason/tool-call/version/model checks and bounded transport. Parsed output passes to the existing rule evaluator. No general adaptation generator, native adapters for other vendors, worker credential resolution, live inference or semantic accuracy claims in this delivery.

Verification for native assessment: four adapter tests pass (request/prompt separation, malformed/truncated output, regional gate, limits, encoding, streaming timeout/cancellation), script TypeScript passes; full regression 111 pass and 4 PostgreSQL tests skipped. Both review axes found no blocker. Repeated bounded-response readers remain a documented maintainability opportunity for the next protocol implementation.

Next partial delivery (2026-10-03): Anthropic directory pagination and native Messages quality assessment, using fixed official endpoints and API-version headers. Unknown processing routes fail closed; direct Anthropic requires explicit overseas metadata, with owner approval enforced before workspace probing and explicit overseas approval before assessment. Only complete text JSON with pinned model/script version is accepted. Shared bounded JSON reading now replaces repeated readers in directory, DeepSeek and gateway adapters.

Verification: six Anthropic fixture tests and all 39 script tests pass, script typecheck passes; full regression 117 pass and 4 PostgreSQL integration tests skipped. Standards and Spec review found no blockers. No live credentials, paid requests, production task wiring or semantic accuracy validation. Gemini and remaining native protocols are still outstanding.

Create separate protocol adapters: chat-completions compatible, Anthropic Messages, Gemini. Verify each provider's official docs and region/account-specific endpoints before enabling. Test with local HTTP fixtures: model list, authentication, availability, timeouts, malformed responses, structured text extraction and error sanitization. No credentials or paid calls in default tests. Unknown adapters fail closed.

Next partial delivery (2026-10-03): Gemini Developer API directory and quality assessment, catalog provider `google`. Fixed HTTPS host and header-only Key; bounded `pageToken` pagination returns only `generateContent` metadata entries, without claiming live capability. Assessment separates system instructions from manuscript data, uses JSON mode, and rejects truncation, safety blocks, tools/thought/media, stale script versions and modelVersion mismatch. Direct route must be explicitly overseas with prior workspace-owner approval; Vertex AI/proxies are not included.

Verification: six Gemini fixture tests pass; script typecheck passes; full regression 123 pass and four PostgreSQL integration tests skipped. Standards review: no blockers, non-blocking duplication suggestions for provider lists/resource validation. Spec review: no blockers. Strict response-version comparison is a documented compatibility limit for moving aliases. No real credentials, paid calls, production wiring or semantic accuracy claims. Other catalog entries and Tasks 3–5 remain unfinished.

Task 2 additional partial delivery (2026-10-03): OpenAI native model directory and Responses quality assessment. Fixed official endpoints, header-only Key, explicit overseas authorization, JSON mode, non-streaming/non-background and store=false. Reject incomplete/error/refusal/tool output and stale model/script versions; reasoning metadata is never assessment text. Directory models are not evidence of inference capability. Six protocol fixtures and script typecheck pass; full regression 129 pass and four PostgreSQL integration tests skipped. No real Key or paid calls, production wiring or accuracy claims. Other provider adapters remain outstanding.

## Task 3 — Persistence, API and job integration

Add PostgreSQL storage scoped by workspace, transaction CAS, append-only audits and key-rotation/deletion policies. API derives actor from session, checks workspace owner and advanced entitlement. Connection testing uses an explicit synthetic prompt, not manuscript data. Jobs snapshot configuration/model/credential version and processing route. Revocation blocks new jobs; existing snapshots cannot be retargeted silently. Do not expose key decryption as a member API.

## Task 4 — Settings and model lists

Owner-only settings UI: provider → masked key input → test connection → available model list → save. Members select tested models without seeing secrets. Catalog items lacking adapters show unavailable. Overseas/unknown processing requires explicit owner approval and regional-policy verification before activation; domestic database storage does not imply domestic inference. Show aggregator downstream routing separately.

## Task 5 — Live regression and rollout

Configure secrets outside Git and choose permitted deployment routes. Run explicitly authorized live semantic tests using self-owned fixtures and human ground truth. Do not claim model accuracy from transport fixtures. Rollout remains blocked until native adapters, persistent secrets, API permissions, UI and regional-policy checks are complete.
