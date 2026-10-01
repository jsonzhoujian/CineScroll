# Script quality gateway

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
