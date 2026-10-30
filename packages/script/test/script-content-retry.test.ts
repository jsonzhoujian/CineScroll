import assert from "node:assert/strict";
import test from "node:test";
import { ScriptContentService, InMemoryScriptContentRepository, type ScriptContentVersion } from "../src/script-content.ts";
import type { EpisodePlanVersion } from "../src/index.ts";
const actor = { userId: "owner",workspaceId: "w" };
const scene = { id: "scene",episodeId: "e",ordinal: 1,title: "庭院",environment: "雨中",characters: [] };
const evidence = [{ type: "source_fragment" as const,sourceVersionId: "s",fragmentId: "f",transformation: "retained" as const }];
const base: ScriptContentVersion = { id: "base",parentVersionId: null,projectId: "p",chapterId: "c",sourceVersionId: "s",planVersionId: "plan",jobId: "original",status: "candidate",generationStatus: "partially_succeeded",createdBy: "owner",createdAt: "2026-10-29T00:00:00Z",scenes: [scene],elements: [{ id: "saved",sceneId: "scene",elementType: "action",ordinal: 1,text: "雨落",provenance: evidence }],failures: [{ scopeKey: "dialogue",code: "INVALID_ELEMENT",message: "missing",retryable: true },{ scopeKey: "sound",code: "INVALID_ELEMENT",message: "missing",retryable: true }] };
async function fixture() {
  const repository = new InMemoryScriptContentRepository(); await repository.save(actor,base,null); let sequence = 0;
  const plan: EpisodePlanVersion = { id: "plan",parentVersionId: null,projectId: "p",chapterId: "c",sourceVersionId: "s",storyBibleVersionId: "bible",status: "confirmed",targetDurationSeconds: 60,aspectRatio: "9:16",narrativeMode: "dialogue",episodes: [{ id: "e",ordinal: 1,title: "雨",sourceFragmentIds: ["f"],coreEventFactIds: [] }],majorAdaptationProposals: [],createdBy: "owner",createdAt: base.createdAt };
  const contextReader = { findGenerationContext: async () => ({ sourceVersionId: "s",planVersionId: "plan",fragments: [{ id: "f",text: "雨落" }],approvedAdditionIds: [],confirmedPlan: plan }) };
  return { repository,service: new ScriptContentService({ repository,contextReader,idGenerator: () => `retry-${++sequence}`,clock: () => new Date(base.createdAt) }) };
}
test("retry merges only selected failed scopes while keeping prior successful content and other failures",async () => {
  const { service,repository } = await fixture();
  const result = await service.recordRetry(actor,{ projectId: "p",chapterId: "c",jobId: "retry-task",sourceVersionId: "s",planVersionId: "plan",retry: { expectedActiveVersionId: "base",retryOfJobId: "original",scopeKeys: ["dialogue"] },scenes: [],items: [{ scopeKey: "dialogue",value: { id: "recovered",sceneId: "scene",elementType: "dialogue",ordinal: 2,text: "下雨了",provenance: evidence } }] });
  assert.deepEqual(result.elements[0],base.elements[0]); assert.equal(result.elements[1]?.id,"recovered");
  assert.deepEqual(result.failures.map(f => f.scopeKey),["sound"]); assert.equal(result.parentVersionId,"base");
  assert.equal((await repository.findGeneration(actor,"p","c","retry-task"))?.id,result.id);
  await assert.rejects(() => service.getRetryCandidate(actor,"p","c",{ expectedActiveVersionId: result.id,scopeKeys: ["saved"] }),{ code: "INVALID_GENERATION" });
});

test("retry cannot overwrite successful element identities or rewrite existing scenes",async () => {
  const { service,repository } = await fixture();
  const input = { projectId: "p",chapterId: "c",jobId: "retry-task",sourceVersionId: "s",planVersionId: "plan",retry: { expectedActiveVersionId: "base",retryOfJobId: "original",scopeKeys: ["dialogue"] },scenes: [],items: [{ scopeKey: "dialogue",value: { ...base.elements[0]!,text: "试图替换" } }] };
  const result = await service.recordRetry(actor,input);
  assert.deepEqual(result.elements,base.elements); assert.ok(result.failures.some(f => f.scopeKey === "dialogue" && f.code === "EXISTING_ELEMENT"));
  const current = await repository.findActive(actor,"p","c");
  await assert.rejects(() => service.recordRetry(actor,{ ...input,jobId: "retry-two",retry: { ...input.retry,expectedActiveVersionId: current!.id,retryOfJobId: current!.jobId },scenes: [{ ...scene,title: "重写场次" }] }),{ code: "INVALID_GENERATION" });
  await assert.rejects(() => service.recordRetry(actor,{ ...input,items: [{ ...input.items[0]!,scopeKey: "unselected" }] }),{ code: "VERSION_CONFLICT" });
});
test("retry failures remain local, and current review suggestions survive an atomic retry merge",async () => {
  const { service,repository } = await fixture();
  const suggested = { ...base,id: "with-suggestion",parentVersionId: base.id,reviewOperation: { requestId: "review",fingerprint: "f",kind: "suggest" as const,targetId: "saved",reason: "reason" },suggestions: [{ id: "proposal",elementId: "saved",baseText: "雨落",text: "雨打庭院",reason: "visual",submittedBy: "editor",submittedAt: base.createdAt,status: "pending" as const }] };
  await repository.save(actor,suggested,base.id);
  const result = await service.recordRetry(actor,{ projectId: "p",chapterId: "c",jobId: "retry-partial",sourceVersionId: "s",planVersionId: "plan",retry: { expectedActiveVersionId: suggested.id,retryOfJobId: suggested.jobId,scopeKeys: ["dialogue"] },scenes: [],items: [{ scopeKey: "dialogue",error: { code: "INVALID_ELEMENT",message: "still invalid",retryable: true } }] });
  assert.deepEqual(result.suggestions,suggested.suggestions); assert.equal(result.reviewOperation,undefined);
  assert.equal(result.generationStatus,"partially_succeeded"); assert.deepEqual(result.elements,suggested.elements); assert.equal(result.failures.length,2);
  await assert.rejects(() => service.recordRetry(actor,{ projectId: "p",chapterId: "c",jobId: "outside",sourceVersionId: "s",planVersionId: "plan",retry: { expectedActiveVersionId: result.id,retryOfJobId: result.jobId,scopeKeys: ["dialogue"] },scenes: [],items: [{ scopeKey: "sound",error: { code: "INVALID_ELEMENT",message: "bad scope",retryable: true } }] }),{ code: "INVALID_GENERATION" });
});

test("retry rejects duplicate recovered ordering slots and confirmed content before writing",async () => {
  const { service,repository } = await fixture();
  const positioned = { ...base,id: "positioned",parentVersionId: base.id,elements: [{ ...base.elements[0]!,ordinal: 2 }] };
  await repository.save(actor,positioned,base.id);
  const result = await service.recordRetry(actor,{ projectId: "p",chapterId: "c",jobId: "ordering-retry",sourceVersionId: "s",planVersionId: "plan",retry: { expectedActiveVersionId: positioned.id,retryOfJobId: positioned.jobId,scopeKeys: ["dialogue","sound"] },scenes: [],items: ["dialogue","sound"].map(scopeKey => ({ scopeKey,value: { id: scopeKey,sceneId: "scene",elementType: "dialogue",ordinal: 1,text: "恢复表达",provenance: evidence } })) });
  assert.equal(result.elements.length,2); assert.deepEqual(result.elements[0],positioned.elements[0]); assert.equal(result.failures[0]?.scopeKey,"sound");
  const confirmed = { ...result,id: "confirmed",parentVersionId: result.id,status: "confirmed" as const };
  await repository.save(actor,confirmed,result.id);
  await assert.rejects(() => service.getRetryCandidate(actor,"p","c",{ expectedActiveVersionId: confirmed.id,scopeKeys: ["sound"] }),{ code: "INVALID_STATE" });
});
