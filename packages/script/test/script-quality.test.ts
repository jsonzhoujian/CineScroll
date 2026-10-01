import assert from "node:assert/strict";
import test from "node:test";
import { ScriptQualityEvaluator } from "../src/script-quality.ts";
import type { ScriptContentVersion, ScriptGenerationContext } from "../src/script-content.ts";

const version: ScriptContentVersion = {
  id: "script_1", parentVersionId: null, projectId: "p", chapterId: "c", sourceVersionId: "source_1", planVersionId: "plan_1", jobId: "job",
  status: "candidate", generationStatus: "succeeded", createdBy: "owner", createdAt: "2026-10-01", failures: [],
  scenes: [{ id: "scene_1", episodeId: "episode_1", ordinal: 1, title: "庭院", environment: "晨光", characters: ["少年"] }],
  elements: [{ id: "e1", sceneId: "scene_1", elementType: "action", ordinal: 1, text: "少年起身。",
    provenance: [{ type: "source_fragment", sourceVersionId: "source_1", fragmentId: "f1", transformation: "retained" }] }],
};
const context: ScriptGenerationContext = {
  planVersionId: "plan_1", sourceVersionId: "source_1", fragments: [{ id: "f1", text: "少年起身。" }], approvedAdditionIds: [],
  confirmedPlan: { id: "plan_1", parentVersionId: null, projectId: "p", chapterId: "c", sourceVersionId: "source_1", status: "confirmed",
    storyBibleVersionId: "bible_1", targetDurationSeconds: 60, aspectRatio: "9:16", narrativeMode: "narration", createdBy: "owner", createdAt: "2026-10-01",
    majorAdaptationProposals: [], episodes: [{ id: "episode_1", ordinal: 1, title: "起身", sourceFragmentIds: ["f1"], coreEventFactIds: ["fact_1"] }] },
  confirmedStoryKnowledge: { versionId: "bible_1", facts: [{ id: "fact_1", statement: "少年起身。" }] },
};
const verdict = { versionId: "script_1", events: [{ factId: "fact_1", elementIds: ["e1"], verdict: "covered" }],
  facts: [{ factId: "fact_1", verdict: "consistent" }], unsupportedCoreFactElementIds: [], episodes: [{ episodeId: "episode_1", estimatedSeconds: 60 }] };

test("质量评估按证据、核心事件、事实一致性和逐集估算时长决定是否放行", async () => {
  let response: unknown = verdict;
  const evaluator = new ScriptQualityEvaluator({ context, model: { async assess() { return response; } } });
  assert.equal(await evaluator.validate(version), true);
  for (const estimatedSeconds of [54, 66]) {
    response = { ...verdict, episodes: [{ episodeId: "episode_1", estimatedSeconds }] };
    assert.equal(await evaluator.validate(version), true);
  }
  response = { ...verdict, events: [{ factId: "fact_1", elementIds: [], verdict: "missing" }] };
  assert.equal(await evaluator.validate(version), false);
  response = { ...verdict, facts: [{ factId: "fact_1", verdict: "contradicted" }] };
  assert.equal(await evaluator.validate(version), false);
  response = { ...verdict, episodes: [{ episodeId: "episode_1", estimatedSeconds: 67 }] };
  assert.equal(await evaluator.validate(version), false);
});

test("评估器拒绝伪造出处、错配版本、漏项、未知引用和模型故障", async () => {
  let response: unknown = verdict;
  let unavailable = false;
  const evaluator = new ScriptQualityEvaluator({ context, model: { async assess() {
    if (unavailable) throw new Error("provider secret"); return response;
  } } });
  for (const malformed of [
    { ...verdict, versionId: "stale" }, { ...verdict, facts: [] },
    { ...verdict, events: [...verdict.events, ...verdict.events] },
    { ...verdict, events: [{ ...verdict.events[0], elementIds: ["unknown"] }] },
    { ...verdict, unsupportedCoreFactElementIds: ["e1"] },
    { ...verdict, facts: [{ factId: "fact_1", verdict: "uncertain" }] },
    { ...verdict, episodes: [{ episodeId: "episode_1", estimatedSeconds: NaN }] },
  ]) { response = malformed; assert.equal(await evaluator.validate(version), false); }
  response = verdict;
  assert.equal(await evaluator.validate({ ...version, elements: [{ ...version.elements[0]!, provenance: [] }] }), false);
  assert.equal(await evaluator.validate({ ...version, scenes: [{ ...version.scenes[0]!, episodeId: "unknown" }] }), false);
  assert.equal(await evaluator.validate({ ...version, scenes: [...version.scenes, ...version.scenes] }), false);
  unavailable = true;
  assert.deepEqual((await evaluator.evaluate(version)).reasons, ["ASSESSOR_UNAVAILABLE"]);
});

test("十个核心事件覆盖九个达到边界，八个则拒绝", async () => {
  const facts = Array.from({ length: 10 }, (_, i) => ({ id: `f_${i}`, statement: `事件${i}` }));
  const expanded: ScriptGenerationContext = { ...context,
    confirmedStoryKnowledge: { ...context.confirmedStoryKnowledge!, facts },
    confirmedPlan: { ...context.confirmedPlan!, episodes: [{ ...context.confirmedPlan!.episodes[0]!, coreEventFactIds: facts.map(({ id }) => id) }] },
  };
  let covered = 9;
  const evaluator = new ScriptQualityEvaluator({ context: expanded, model: { async assess() { return {
    ...verdict, events: expanded.confirmedStoryKnowledge!.facts.map(({ id }, i) => ({ factId: id, elementIds: i < covered ? ["e1"] : [], verdict: i < covered ? "covered" : "missing" })),
    facts: expanded.confirmedStoryKnowledge!.facts.map(({ id }) => ({ factId: id, verdict: "consistent" })),
  }; } } });
  assert.equal((await evaluator.evaluate(version)).coverage, 0.9);
  assert.equal(await evaluator.validate(version), true);
  covered = 8;
  assert.equal(await evaluator.validate(version), false);
});
