import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryScriptContentRepository } from "../src/script-content.ts";
import { ConfirmedScriptHandoff } from "../src/script-handoff.ts";
import { InMemorySettingsReviewRepository, SettingsReviewService } from "../src/settings-review.ts";
import { ConfirmedStoryboardHandoff } from "../src/storyboard-handoff.ts";
import { context, version } from "./script-quality-fixture.ts";

test("uses formal settings and script and rejects a formal settings pointer bound to an older script", async () => {
  const actor = { workspaceId: "w", userId: "owner" };
  const scripts = new InMemoryScriptContentRepository();
  const formal = { ...version, id: "formal", status: "confirmed" as const };
  await scripts.save(actor, formal, null);
  const script = new ConfirmedScriptHandoff(scripts, { findGenerationContext: async () => context });
  const settings = new InMemorySettingsReviewRepository(actor, {
    id: "settings", projectId: "p", chapterId: "c", jobId: "job", sourceVersionId: formal.sourceVersionId,
    scriptVersionId: formal.id, upstreamConfirmedVersionIds: [formal.id, "plan_1", "bible_1"],
    status: "candidate", createdBy: actor.userId, createdAt: "2026-11-07", failures: [], generationStatus: "succeeded",
    assets: [{ id: "location", assetType: "location", name: "courtyard", visibleDefinition: { weather: "rain" },
      state: "", stateChanges: [], restrictions: [], provenance: formal.elements[0]!.provenance }],
  });
  const handoff = new ConfirmedStoryboardHandoff(script, settings);
  await assert.rejects(() => handoff.read(actor, "p", "c"), { code: "UPSTREAM_CHANGED" });
  const service = new SettingsReviewService({
    repository: settings, handoff: script, access: { findProjectAccess: async () => ({ role: "owner" }) },
    idGenerator: () => "settings-formal", clock: () => new Date("2026-11-07"),
  });
  await service.execute(actor, "p", "c", { kind: "confirm", requestId: "confirm", expectedActiveVersionId: "settings", reason: "reviewed" });
  const result = await handoff.read(actor, "p", "c");
  assert.deepEqual(result.upstreamConfirmedVersionIds, ["formal", "settings-formal", "plan_1", "bible_1"]);
  assert.deepEqual(result.context.assetIds, ["location"]);
  assert.deepEqual(result.context.fragmentIds, context.fragments.map(fragment => fragment.id));
  await scripts.save(actor, { ...formal, id: "new-formal", parentVersionId: formal.id }, formal.id);
  await assert.rejects(() => handoff.read(actor, "p", "c"), { code: "UPSTREAM_CHANGED" });
});
