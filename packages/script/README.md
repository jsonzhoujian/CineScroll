# Script quality gateway

## Workspace BYOK foundation

`model-settings` exposes a 12-provider candidate catalog and `WorkspaceModelSettings`. Workspace membership and advanced entitlement are checked through a server access port; only owners configure credentials or probe connections. Public settings contain a fixed mask, never plaintext or ciphertext. Keys use AES-256-GCM with fresh nonces and workspace/version/provider authenticated data. The caller supplies a server-side 32-byte encryption key; production KMS/key rotation is not implemented here.

Connection probes are injected adapters, not catalog labels. They declare a trusted processing route before any external call. Unknown routes cannot be tested; overseas routes require explicit owner approval. Probe output must match that route. Members can select only tested model IDs. The returned immutable descriptor pins configuration version/provider/model; actual worker secret resolution and job persistence are separate, still unimplemented.

This initial repository stores a single active configuration per workspace, with internal immutable encrypted history. It is an in-memory development foundation, not a deployed secret vault or completed settings UI. Native provider adapters, multi-provider credential slots, persistent PostgreSQL storage/audit, deletion/revocation, API/UI, regional policy verification and real model tests remain pending. Do not persist real production keys in this development repository. See `docs/plans/2026-10-01-model-access.md` for the delivery sequence.

## Quality gateway client

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
