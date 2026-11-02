import assert from "node:assert/strict";
import test from "node:test";
import { ScriptQualityEvaluator } from "../src/script-quality.ts";
import type { ScriptContentVersion, ScriptGenerationContext } from "../src/script-content.ts";

import { version,context,verdict } from "./script-quality-fixture.ts";

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

test("three fixed synthetic genres exercise acceptance, unsupported facts and incomplete assessment",async () => {
  const cases = [
    { genre: "都市",text: "记者在会议室公开证据。",response: { ...verdict },expected: true },
    { genre: "言情",text: "她在车站归还信件。",response: { ...verdict,unsupportedCoreFactElementIds: ["e1"] },expected: false },
    { genre: "玄幻",text: "弟子在山门交还令牌。",response: { ...verdict,facts: [] },expected: false },
  ];
  for (const sample of cases) {
    const input = { ...version,elements: [{ ...version.elements[0]!,text: sample.text }] };
    const sampleContext = { ...context,fragments: [{ id: "f1",text: sample.text }],confirmedStoryKnowledge: { versionId: "bible_1",facts: [{ id: "fact_1",statement: sample.text }] } };
    const evaluator = new ScriptQualityEvaluator({ context: sampleContext,model: { async assess() { return sample.response; } } });
    assert.equal(await evaluator.validate(input),sample.expected,sample.genre);
  }
  // These are contract/gate fixtures, not a measurement of real semantic model accuracy.
});
test("uncertain events at 90 percent and just-outside duration estimates block confirmation",async () => {
  const facts = Array.from({ length: 10 },(_,i) => ({ id: `event_${i}`,statement: `事件 ${i}` }));
  const input = { ...context,confirmedStoryKnowledge: { versionId: "bible_1",facts },confirmedPlan: { ...context.confirmedPlan!,episodes: [{ ...context.confirmedPlan!.episodes[0]!,coreEventFactIds: facts.map(f => f.id) }] } };
  const evaluator = new ScriptQualityEvaluator({ context: input,model: { async assess() { return { ...verdict,events: facts.map((f,i) => ({ factId: f.id,elementIds: i < 9 ? ["e1"] : [],verdict: i < 9 ? "covered" : "uncertain" })),facts: facts.map(f => ({ factId: f.id,verdict: "consistent" })) }; } } });
  assert.equal((await evaluator.evaluate(version)).coverage,0.9);assert.equal(await evaluator.validate(version),false);
  for (const seconds of [53.999,66.001]) assert.equal(await new ScriptQualityEvaluator({ context,model: { async assess() { return { ...verdict,episodes: [{ episodeId: "episode_1",estimatedSeconds: seconds }] }; } } }).validate(version),false);
});
