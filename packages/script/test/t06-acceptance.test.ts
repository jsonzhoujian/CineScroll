import { ScriptRevisionService } from "../src/script-revision.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryScriptContentRepository,ScriptContentService } from "../src/script-content.ts";
import { ScriptRunner } from "../src/script-runner.ts";
import { ScriptPublicationService,qualityBinding } from "../src/script-publication.ts";
import { ConfirmedScriptHandoff } from "../src/script-handoff.ts";
import { context as template } from "./script-quality-fixture.ts";

const samples = [
  { genre: "玄幻",source: "山门寒风凛冽。少年担心迟到，攥紧令牌，快步走入山门。",action: "少年攥紧令牌，快步走入山门。",environment: "寒风掠过山门",fact: "少年进入山门",character: "少年",dialogue: "我到了。",sound: "风声",narration: "少年担心迟到。" },
  { genre: "都市",source: "会议室灯光明亮。记者担心证据被毁，将文件放到桌上。",action: "记者将文件放到桌上。",environment: "明亮会议室",fact: "记者展示文件",character: "记者",dialogue: "文件在这里。",sound: "文件落桌声",narration: "记者担心证据被毁。" },
  { genre: "悬疑",source: "走廊昏暗。侦探心生疑虑，停下脚步，检查门锁。",action: "侦探停下脚步，检查门锁。",environment: "昏暗走廊",fact: "侦探检查门锁",character: "侦探",dialogue: "门锁不对劲。",sound: "脚步停下",narration: "侦探心生疑虑。" },
];
for (const sample of samples) test(`T06 synthetic public-boundary acceptance: ${sample.genre}`,async () => {
  const actor = { userId: "owner",workspaceId: "w" },repository = new InMemoryScriptContentRepository();let seq = 0;
  const context = { ...template,fragments: [{ id: "f1",text: `${sample.source}${sample.character}说：“${sample.dialogue}”${sample.sound}。` }],confirmedStoryKnowledge: { versionId: "bible_1",facts: [{ id: "fact_1",statement: sample.fact }] } };
  const contextReader = { findGenerationContext: async () => context },accessReader = { findProjectAccess: async () => ({ role: "owner" as const }) };
  const content = new ScriptContentService({ repository,contextReader,accessReader,idGenerator: () => `v${++seq}`,clock: () => new Date("2026-11-02") });
  const publication = new ScriptPublicationService({ repository,contextReader,accessReader,content });
  const partial = await new ScriptRunner({ contextReader,service: content,model: { async generate(request) { return {
    contractVersion: "0.1.0",jobId: request.jobId,stage: "script",projectId: "p",chapterId: "c",sourceVersionId: "source_1",upstreamConfirmedVersionIds: ["plan_1","bible_1"],status: "partially_succeeded",
    scenes: [{ id: "scene_1",episodeId: "episode_1",ordinal: 1,title: sample.genre,environment: sample.environment,characters: [sample.character] }],
    items: [{ scopeKey: "action",status: "succeeded",value: { id: "action",sceneId: "scene_1",elementType: "action",ordinal: 1,text: sample.action,provenance: [{ type: "source_fragment",sourceVersionId: "source_1",fragmentId: "f1",transformation: "actionized" }] } },...[{ id: "dialogue",elementType: "dialogue",ordinal: 3,text: sample.dialogue,speaker: sample.character,transformation: "retained" },{ id: "narration",elementType: "narration",ordinal: 4,text: sample.narration,transformation: "narrated" },{ id: "sound",elementType: "sound",ordinal: 5,text: sample.sound,transformation: "sonified" }].map(({ transformation,...value }) => ({ scopeKey: value.id,status: "succeeded",value: { ...value,sceneId: "scene_1",provenance: [{ type: "source_fragment",sourceVersionId: "source_1",fragmentId: "f1",transformation }] } })),{ scopeKey: "environment",status: "failed",error: { code: "INVALID_ELEMENT",message: "环境待恢复",retryable: true } }],
  }; } } }).run(actor,{ projectId: "p",chapterId: "c",jobId: "generate",expectedActiveVersionId: null,generationParameters: { targetDurationSeconds: 60,aspectRatio: "9:16",narrativeMode: "narration" } });
  assert.equal(partial.generationStatus,"partially_succeeded");
  const blockedReport = await publication.assess(actor,"p","c",{ jobId: "partial-quality",binding: qualityBinding(partial,context),model: { async assess() { throw new Error("preconditions must block before model invocation"); } } });
  assert.equal(blockedReport.passed,false);
  await assert.rejects(() => publication.execute(actor,"p","c",{ kind: "confirm",requestId: "blocked-partial",expectedActiveVersionId: partial.id,reason: "失败项不能确认",reportId: blockedReport.id }),{ code: "INVALID_CONFIRMATION" });
  const candidate = await new ScriptRunner({ contextReader,service: content,model: { async generate(request) {
    assert.deepEqual(request.scopeKeys,["environment"]);assert.equal(request.retryOfJobId,partial.jobId);
    return { contractVersion: "0.1.0",jobId: request.jobId,stage: "script",projectId: "p",chapterId: "c",sourceVersionId: "source_1",upstreamConfirmedVersionIds: ["plan_1","bible_1"],status: "succeeded",scenes: [],items: [{ scopeKey: "environment",status: "succeeded",value: { id: "environment",sceneId: "scene_1",elementType: "environment",ordinal: 2,text: sample.environment,provenance: [{ type: "source_fragment",sourceVersionId: "source_1",fragmentId: "f1",transformation: "visualized" }] } }] };
  } } }).run(actor,{ projectId: "p",chapterId: "c",jobId: "retry-environment",expectedActiveVersionId: partial.id,retry: { expectedActiveVersionId: partial.id,retryOfJobId: partial.jobId,scopeKeys: ["environment"] },generationParameters: { targetDurationSeconds: 60,aspectRatio: "9:16",narrativeMode: "narration" } });
  assert.equal(candidate.generationStatus,"succeeded");assert.deepEqual(candidate.elements[0],partial.elements[0]);assert.equal(candidate.failures.length,0);
  const report = await publication.assess(actor,"p","c",{ jobId: "quality",binding: qualityBinding(candidate,context),model: { async assess() { return { versionId: candidate.id,events: [{ factId: "fact_1",elementIds: ["action"],verdict: "covered" }],facts: [{ factId: "fact_1",verdict: "consistent" }],episodes: [{ episodeId: "episode_1",estimatedSeconds: 60 }],unsupportedCoreFactElementIds: [] }; } } });
  assert.equal(report.passed,true);
  const formal = await publication.execute(actor,"p","c",{ kind: "confirm",requestId: "confirm",expectedActiveVersionId: candidate.id,reason: "核对合成样本",reportId: report.id });
  const locked = await publication.execute(actor,"p","c",{ kind: "lock",requestId: "lock",expectedActiveVersionId: formal.id,reason: "锁定已确认动作",elementIds: ["action"] });
  const revision = new ScriptRevisionService({ repository,contextReader,accessReader,idGenerator: () => `revision${++seq}`,clock: () => new Date("2026-11-02") });
  const suggestion = { kind: "suggest" as const,requestId: "suggest",expectedActiveVersionId: locked.id,reason: "核对动作节奏",elementId: "action",text: sample.action };
  await assert.rejects(() => revision.execute(actor,"p","c",suggestion),{ code: "INVALID_STATE" });
  const unlocked = await revision.execute(actor,"p","c",{ kind: "unlock",requestId: "unlock",expectedActiveVersionId: locked.id,elementId: "action",reason: "明确修订" });
  const proposed = await revision.execute(actor,"p","c",{ ...suggestion,expectedActiveVersionId: unlocked.id });
  const revisionCandidate = await revision.execute(actor,"p","c",{ kind: "decide",requestId: "accept",expectedActiveVersionId: proposed.id,reason: "核对原文",suggestionId: proposed.suggestions!.find(s => s.status === "pending")!.id,decision: "accepted" });
  const reader = new ConfirmedScriptHandoff(repository,contextReader);
  assert.equal((await reader.read(actor,"p","c")).version.id,proposed.id);
  await assert.rejects(() => publication.execute(actor,"p","c",{ kind: "confirm",requestId: "stale-report",expectedActiveVersionId: revisionCandidate.id,reason: "旧报告不得复用",reportId: report.id }),{ code: "INVALID_CONFIRMATION" });
  const revisedReport = await publication.assess(actor,"p","c",{ jobId: "revised-quality",binding: qualityBinding(revisionCandidate,context),model: { async assess() { return { versionId: revisionCandidate.id,events: [{ factId: "fact_1",elementIds: ["action"],verdict: "covered" }],facts: [{ factId: "fact_1",verdict: "consistent" }],episodes: [{ episodeId: "episode_1",estimatedSeconds: 60 }],unsupportedCoreFactElementIds: [] }; } } });
  const revisedFormal = await publication.execute(actor,"p","c",{ kind: "confirm",requestId: "reconfirm",expectedActiveVersionId: revisionCandidate.id,reason: "重新评估确认",reportId: revisedReport.id });
  assert.equal((await reader.read(actor,"p","c")).version.id,revisedFormal.id);
  assert.deepEqual((await repository.findVersion(actor,"p","c",formal.id))?.elements,formal.elements);
  const handoff = await reader.read(actor,"p","c");
  assert.equal(handoff.version.id,revisedFormal.id);assert.equal(handoff.sourceFragments[0]?.text,context.fragments[0]!.text);
  assert.deepEqual(new Set(handoff.version.elements.map(e => e.elementType)),new Set(["action","environment","dialogue","narration","sound"]));
  assert.deepEqual(handoff.version.scenes[0]?.characters,[sample.character]);
  assert.equal(handoff.version.elements.find(e => e.elementType === "dialogue")?.speaker,sample.character);
  for (const element of handoff.version.elements) for (const evidence of element.provenance) { assert.equal(evidence.type,"source_fragment");if (evidence.type === "source_fragment") { assert.equal(evidence.sourceVersionId,"source_1");assert.ok(handoff.sourceFragments.some(f => f.id === evidence.fragmentId)); } }
});
