import assert from "node:assert/strict";
import { test } from "node:test";
import fixture from "../../../docs/contracts/fixtures/ai/valid-storyboard.json" with { type: "json" };
import { StoryboardRunner, type StoryboardCandidate } from "../src/storyboard-runner.ts";
import type { ConfirmedStoryboardHandoff } from "../src/storyboard-handoff.ts";
import { context, version } from "./script-quality-fixture.ts";

const actor = { userId: "owner", workspaceId: "w" };
const { jobId, projectId, chapterId, sourceVersionId, upstreamConfirmedVersionIds } = fixture;
const identity = { jobId, projectId, chapterId, sourceVersionId, upstreamConfirmedVersionIds };

function setup(changeDuringModel = false) {
  let source = sourceVersionId;
  let saved: StoryboardCandidate | null = null;
  let calls = 0;
  const handoff: Pick<ConfirmedStoryboardHandoff, "read"> = { async read() {
    return {
      sourceVersionId: source, upstreamConfirmedVersionIds,
      script: { version, sourceFragments: context.fragments, upstreamConfirmedVersionIds: [] },
      settings: {
        ...identity, id: "cv_st1", scriptVersionId: "cv_ss1", status: "confirmed", assets: [], failures: [],
        generationStatus: "succeeded", createdBy: actor.userId, createdAt: "2026-11-07",
        parentVersionId: null, suggestions: [], locks: {},
      },
      context: {
        sourceVersionId: source, scenes: [{ id: "scene_s1", episodeId: "ep_s1", scriptElementIds: ["se_s1"] }],
        assetIds: ["asset_s1"], fragmentIds: ["frag_s1"], approvedAdditionIds: [],
      },
    };
  } };
  const runner = new StoryboardRunner({
    handoff,
    repository: {
      async findGeneration() { return saved; },
      async saveGeneration(_actor, candidate) { saved = candidate; return candidate; },
    },
    model: { async generate() {
      calls++;
      if (changeDuringModel) source = "new-source";
      return fixture;
    } },
  });
  return { runner, calls: () => calls, saved: () => saved, changeSource: () => { source = "new-source"; } };
}

test("saves valid shots and recovers the original job without calling the model again", async () => {
  const f = setup();
  const result = await f.runner.run(actor, identity);
  assert.equal(result.shots.length, 1);
  f.changeSource();
  assert.deepEqual(await f.runner.run(actor, identity), result);
  await assert.rejects(() => f.runner.run({ ...actor, userId: "other" }, identity), { code: "UPSTREAM_CHANGED" });
  assert.equal(f.calls(), 1);
});

test("rejects stale task snapshots before model execution and late responses before saving", async () => {
  const stale = setup();
  stale.changeSource();
  await assert.rejects(() => stale.runner.run(actor, identity), { code: "UPSTREAM_CHANGED" });
  assert.equal(stale.calls(), 0);
  const late = setup(true);
  await assert.rejects(() => late.runner.run(actor, identity), { code: "UPSTREAM_CHANGED" });
  assert.equal(late.calls(), 1);
  assert.equal(late.saved(), null);
});
