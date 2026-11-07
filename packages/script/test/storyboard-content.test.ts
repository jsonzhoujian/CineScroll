import assert from "node:assert/strict";
import { test } from "node:test";
import fixture from "../../../docs/contracts/fixtures/ai/valid-storyboard.json" with { type: "json" };
import { validateStoryboardResponse, validateStoryboardShot } from "../src/storyboard-content.ts";

const shot = fixture.items[0]!.value;
const context = {
  scenes: [{ id: "scene_s1", episodeId: "ep_s1", scriptElementIds: ["se_s1"] },
    { id: "scene_s2", episodeId: "ep_s1", scriptElementIds: ["se_s2"] }],
  assetIds: ["asset_s1"],
  sourceVersionId: "srcv_s1",
  fragmentIds: ["frag_s1"],
  approvedAdditionIds: ["approved_s1"],
};

test("accepts and detaches a canonical shot with authorized references", () => {
  const result = validateStoryboardShot(shot, context);
  assert.deepEqual(result, shot);
  assert.notEqual(result?.provenance, shot.provenance);
  assert.ok(validateStoryboardShot({ ...shot, provenance: [{ type: "approved_addition", additionId: "approved_s1" }] }, context));
});

test("rejects invalid fields and references outside the shot's confirmed inputs", () => {
  const { visual: _missing, ...incomplete } = shot;
  assert.equal(validateStoryboardShot(incomplete, context), null);
  for (const patch of [
    { ordinal: 0 }, { visual: "" }, { characters: [1] }, { durationSeconds: Infinity },
    { shotSize: "unknown" }, { cameraAngle: ["eye_level"] }, { action: null }, { extra: true },
    { splitReason: [] }, { splitReason: ["action_change", "action_change"] },
    { sceneId: "missing" }, { episodeId: "other" }, { assetIds: ["missing"] }, { assetIds: ["asset_s1", "asset_s1"] },
    { scriptElementIds: [] }, { scriptElementIds: ["se_s2"] }, { scriptElementIds: ["se_s1", "se_s1"] },
    { provenance: [] }, { provenance: [{ ...shot.provenance[0], sourceVersionId: "old" }] },
    { provenance: [{ ...shot.provenance[0], fragmentId: "missing" }] },
    { provenance: [{ type: "approved_addition", additionId: "missing" }] },
  ]) assert.equal(validateStoryboardShot({ ...shot, ...patch }, context), null, JSON.stringify(patch));
});

test("binds the response to the job and ordered formal versions before accepting shots", () => {
  assert.deepEqual(validateStoryboardResponse(fixture, fixture, context).shots, [shot]);
  for (const patch of [
    { jobId: "other" }, { chapterId: "other" }, { projectId: "other" }, { sourceVersionId: "old" },
    { upstreamConfirmedVersionIds: [...fixture.upstreamConfirmedVersionIds].reverse() },
    { status: "failed" }, { items: [fixture.items[0], fixture.items[0]] },
  ]) assert.throws(() => validateStoryboardResponse({ ...fixture, ...patch }, fixture, context), { code: "INVALID_RESPONSE" });
});

test("preserves valid shots and isolates invalid, duplicate, and provider-failed scopes", () => {
  const result = validateStoryboardResponse({ ...fixture, status: "partially_succeeded", items: [
    fixture.items[0],
    { scopeKey: "shot:2", status: "succeeded", value: { ...shot, episodeId: "other" } },
    { scopeKey: "shot:3", status: "succeeded", value: shot },
    { scopeKey: "shot:4", status: "failed", error: { code: "internal", message: "provider prose", retryable: false } },
  ] }, fixture, context);
  assert.deepEqual(result, {
    generationStatus: "partially_succeeded", shots: [shot], failures: [
      { scopeKey: "shot:2", code: "INVALID_SHOT", retryable: true },
      { scopeKey: "shot:3", code: "INVALID_SHOT", retryable: true },
      { scopeKey: "shot:4", code: "PROVIDER_ITEM_FAILED", retryable: false },
    ],
  });
});
