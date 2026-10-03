# Script quality gateway

## Workspace BYOK foundation

`model-settings` exposes a 12-provider candidate catalog and `WorkspaceModelSettings`. Workspace membership and advanced entitlement are checked through a server access port; only owners configure credentials or probe connections. Public settings contain a fixed mask, never plaintext or ciphertext. Keys use AES-256-GCM with fresh nonces and workspace/version/provider authenticated data. The caller supplies a server-side 32-byte encryption key; production KMS/key rotation is not implemented here.

Connection probes are injected adapters, not catalog labels. They declare a trusted processing route before any external call. Unknown routes cannot be tested; overseas routes require explicit owner approval. Probe output must match that route. Members can select only tested model IDs. The returned immutable descriptor pins configuration version/provider/model; actual worker secret resolution and job persistence are separate, still unimplemented.

This initial repository stores a single active configuration per workspace, with internal immutable encrypted history. It is an in-memory development foundation, not a deployed secret vault or completed settings UI. Native provider adapters, multi-provider credential slots, persistent PostgreSQL storage/audit, deletion/revocation, API/UI, regional policy verification and real model tests remain pending. Do not persist real production keys in this development repository. See `docs/plans/2026-10-01-model-access.md` for the delivery sequence.

## Quality gateway client

### Native directory probe (Task 2, partial)

`NativeModelDirectoryProbe` implements **DeepSeek, Anthropic and Gemini model-directory authentication**, not inference validation. DeepSeek uses fixed `GET https://api.deepseek.com/models` and Bearer authentication. The endpoint and list response follow the [official model-list reference](https://api-docs.deepseek.com/api/list-models/) and [API base URL documentation](https://api-docs.deepseek.com/guides/agent_integrations/openclaw). Model IDs are read from responses, not copied from a static catalog.

Inject the probe into workspace settings only after configuring a trusted, verified processing route (`mainland` or `overseas`). No route is inferred from the provider's nationality. Unknown/unsupported providers fail closed before network access; workspace settings perform owner/overseas-approval checks before the probe receives a credential. Do not expose direct probe calls to members.

Directory access is not a generation capability test, balance check or semantic assessment. The current `tested` setting denotes credential/directory readiness only; generated-task execution must remain disabled until production credential resolution and capability validation exist. Remaining catalog entries have no native adapter yet. No production wiring or live credential call is included in this slice. Local fixtures validate protocol parsing/security, not real availability.

### OpenAI native protocol (Task 2, partial)

The `openai` directory uses fixed `GET https://api.openai.com/v1/models` with Bearer authentication and bounded list validation; see [List models](https://developers.openai.com/api/reference/resources/models/methods/list). This directory includes models of different capabilities and is not a Responses/text/JSON capability test. Production selection remains gated on separate capability validation.

`OpenAIQualityModel` uses fixed `POST https://api.openai.com/v1/responses`, independent trusted `instructions` and user data, JSON-object mode and a 4096-token output cap; see [Responses reference](https://developers.openai.com/api/reference/cli/resources/responses/methods/create). It sets `store: false`, `background: false`, `stream: false`. Closing application storage is not a claim of zero provider retention or regulatory compliance. No tools or previous response/conversation state are supplied.

Only completed responses with matching requested model, no error/incomplete details and exactly one completed assistant message are accepted. Reasoning metadata is not parsed as an assessment; tool outputs and refusals fail closed. Text blocks are joined then parsed as strict JSON, matching the script version before rule validation. Moving aliases resolving to another model version are rejected. Unknown/mainland direct routes are rejected; overseas requires explicit approval, and workspace-owner approval precedes directory probing. Azure, proxies and regional endpoints are not included. Limits, cancellation, timeout and sanitized errors apply with no retry. Fixtures do not validate real availability, semantic accuracy, account eligibility, region or production integration.

### Gemini native protocol (Task 2, partial)

The `google` catalog entry uses the Gemini Developer API, not Vertex AI or a proxy. Fixed `GET https://generativelanguage.googleapis.com/v1beta/models` uses `x-goog-api-key` (never a URL key), `pageSize=100` and `pageToken`; see the [Models reference](https://ai.google.dev/api/models) and [API-key guide](https://ai.google.dev/gemini-api/docs/api-key). At most ten pages, with a single overall timeout, are accepted. Duplicate names/cursors or malformed pages reject the entire directory. Only models declaring `generateContent` are selectable; this metadata does not prove text/JSON compatibility or live availability.

`GeminiQualityModel` uses fixed `POST https://generativelanguage.googleapis.com/v1beta/models/{id}:generateContent`, separate `systemInstruction` and user content, one candidate, JSON MIME type and a 4096-token output cap; see [generateContent](https://ai.google.dev/api/generate-content). It accepts only STOP, model-role text parts without tool/code/media/thought content and strict JSON with matching script version. Response `modelVersion` must exactly match the requested resource suffix; moving aliases that resolve to another version fail closed. Production activation must verify a compatible pinned model, not silently relax this check.

Resource names are restricted to a safe `models/{id}` path. Direct Gemini cannot be marked mainland processing; unknown routes and unapproved overseas assessment are rejected. Workspace settings must enforce owner consent before directory access. The adapter does not certify account eligibility, actual geography or cross-border compliance. Request/response limits (2 MB/1 MB), stream cancellation, timeout and sanitized errors apply with no automatic retry. Fixtures test protocol/security only: no real Key, paid requests, production task integration or semantic accuracy validation.

### Anthropic native protocol (Task 2, partial)

The directory uses fixed `GET https://api.anthropic.com/v1/models`, `x-api-key` and `anthropic-version: 2023-06-01`, following the [official list-models reference](https://platform.claude.com/docs/en/api/models/list). Pagination uses `after_id`, at most ten pages of 100 models, with a single overall timeout. Duplicate models/cursors, malformed pages or truncation at the page limit fail closed; no partial directory is published.

`AnthropicQualityModel` uses fixed `POST https://api.anthropic.com/v1/messages`, top-level trusted `system` instructions and a separate untrusted user payload, following the [Messages reference](https://platform.claude.com/docs/en/api/messages/create). Only `end_turn` with text-only content, strict JSON and matching requested model/script version is accepted; the existing evaluator validates the verdicts. Output has a 4096-token cap: truncation is rejected, not repaired or retried. Use a pinned model ID rather than a moving alias. This is assessment, not adaptation generation.

Direct Anthropic access cannot be configured as mainland processing. Server route metadata must explicitly identify overseas processing; the workspace settings service must obtain owner approval before directory probing, and the assessment adapter requires explicit non-mainland approval. Unknown routes fail closed. This does not establish account eligibility, cross-border compliance or actual processing geography from the brand name. Shared bounded JSON reading caps response bytes, cancels rejected/error streams and rejects invalid UTF-8. Tests use fixtures only; no real Key, live availability, paid call or semantic accuracy was validated.

### DeepSeek native quality assessment (Task 2, partial)

`DeepSeekQualityModel` implements `ScriptQualityModelPort` using fixed `POST https://api.deepseek.com/chat/completions` with separate system/user messages, non-streaming JSON-object mode and the shared quality-review instructions. Protocol references: [Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/) and [JSON Output](https://api-docs.deepseek.com/guides/json_mode/). This is quality assessment, not a general story/script generation adapter.

Construct only in an authorized server worker using its pinned workspace configuration. Explicit verified route metadata is required; unknown routes and unapproved overseas routes are rejected. The caller must provide a verified model ID; response model must match it exactly. Aliases whose response identifies a different concrete version fail closed; no silent model fallback is performed.

The adapter rejects truncation, tool calls, empty/fenced/invalid JSON and wrong candidate versions. Transport is bounded (2 MB request, 1 MB response), cancels rejected streams, uses a 60-second default timeout (maximum 300 seconds), sanitizes errors and never automatically retries. Parsed assessments still require `ScriptQualityEvaluator`'s exhaustive reference and policy validation. No native model call, actual semantic-accuracy validation, key-resolution integration, production bootstrap or UI is included in fixture tests. Directory readiness alone must not enable manuscript processing.

`HttpScriptQualityModel` is a server-side adapter for a **project-owned gateway protocol**. It is not a direct adapter to any named vendor API. A gateway must implement the contract below and invoke the selected semantic model; configuring an arbitrary vendor URL will not work.

Construction requires an administrator-controlled HTTPS endpoint, API key and model identifier. Default timeout is 60 seconds, configurable up to 300 seconds. Endpoint query parameters, URL credentials and fragments are rejected; redirects are disabled. Do not expose endpoint configuration to project members or reuse it for arbitrary BYOK URLs. Production egress must restrict hosts to approved mainland-region providers/gateways consistent with the work's data-processing permissions. Never commit or log keys or full manuscripts.

POST request (Bearer authentication):

```json
{
  "contractVersion": "0.1.0",
  "model": "configured-assessor",
  "instructions": "trusted reviewer instructions supplied by the adapter",
  "input": { "version": {}, "context": {} }
}
```

The gateway must preserve the separation between trusted `instructions` and untrusted `input`; use the trusted instructions as system/developer rules and serialized input as work data. Never promote manuscript instructions to trusted messages, enable tools or retrieve URLs found inside a work. Prompt separation reduces injection risk; it does not establish model accuracy or eliminate injection.

Successful response must be JSON with this envelope:

```json
{
  "contractVersion": "0.1.0",
  "versionId": "script_1",
  "assessment": {
    "versionId": "script_1",
    "events": [{ "factId": "fact_1", "elementIds": ["element_1"], "verdict": "covered" }],
    "facts": [{ "factId": "fact_1", "verdict": "consistent" }],
    "unsupportedCoreFactElementIds": [],
    "episodes": [{ "episodeId": "episode_1", "estimatedSeconds": 60 }]
  }
}
```

Return every required event, fact and episode once. Use `uncertain` rather than inventing confidence. Durations must be independent estimates, not copies of the target. `ScriptQualityEvaluator` performs final reference/exhaustiveness/policy checks; this adapter only validates transport and envelope. Request limit is 2,000,000 UTF-8 bytes; response limit is 1,000,000 bytes. Errors and timeouts are sanitized, and there are no automatic retries.

Compose the model with `ScriptQualityEvaluator({ context, model })` and inject the evaluator as the service's `confirmationGate`. Obtain the matching immutable context through an authorized server workflow. No production bootstrap wiring, provider gateway implementation or credential configuration is included in this slice. Tests inject a local transport double and do not call a paid model or validate semantic accuracy. Authorized genre-specific live regressions and human-reviewed ground truth remain required before release.
