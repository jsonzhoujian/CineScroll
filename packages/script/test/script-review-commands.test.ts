import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryScriptContentRepository, ScriptContentService, type ScriptContentVersion } from "../src/script-content.ts";
const actor = { userId: "owner",workspaceId: "studio" };
const candidate: ScriptContentVersion = { id: "v1",parentVersionId: null,projectId: "p",chapterId: "c",sourceVersionId: "s",planVersionId: "plan",jobId: "job",status: "candidate",generationStatus: "succeeded",createdBy: "owner",createdAt: "2026-10-29T00:00:00Z",scenes: [],failures: [],elements: [{ id: "action",sceneId: "scene",elementType: "action",ordinal: 1,text: "雨落",provenance: [{ type: "source_fragment",sourceVersionId: "s",fragmentId: "f",transformation: "retained" }] }] };
test("review commands persist request identity and replay exact results without overwriting later edits",async () => {
  const repository = new InMemoryScriptContentRepository(); await repository.save(actor,candidate,null);
  let sequence = 0;
  const service = new ScriptContentService({ repository,accessReader: { findProjectAccess: async a => ({ role: a.userId === "editor" ? "editor" : "owner" }) },
    contextReader: { findGenerationContext: async () => ({ sourceVersionId: "s",planVersionId: "plan",fragments: [{ id: "f",text: "雨落" }],approvedAdditionIds: [] }) },idGenerator: () => `v${++sequence+1}`,clock: () => new Date("2026-10-29") });
  const command = { kind: "edit" as const,requestId: "request",expectedActiveVersionId: "v1",elementId: "action",text: "雨打庭院",reason: "视觉表达" };
  const edited = await service.reviewCandidate(actor,"p","c",command);
  assert.equal(edited.reviewOperation?.requestId,"request");
  await service.reviewCandidate(actor,"p","c",{ ...command,requestId: "next",expectedActiveVersionId: edited.id,text: "雨落庭院" });
  assert.deepEqual(await service.reviewCandidate(actor,"p","c",command),edited);
  await assert.rejects(() => service.reviewCandidate(actor,"p","c",{ ...command,text: "different" }),{ code: "VERSION_CONFLICT" });
  await assert.rejects(() => service.reviewCandidate({ ...actor,userId: "editor" },"p","c",command),{ code: "FORBIDDEN" });
  assert.deepEqual(edited.elements[0]!.provenance,candidate.elements[0]!.provenance);
});

test("suggestion acceptance detects a changed target and concurrent edits cannot overwrite each other",async () => {
  const repository = new InMemoryScriptContentRepository(); await repository.save(actor,candidate,null);
  let sequence = 0;
  const service = new ScriptContentService({ repository,accessReader: { findProjectAccess: async () => ({ role: "owner" }) },contextReader: { findGenerationContext: async () => ({ sourceVersionId: "s",planVersionId: "plan",fragments: [],approvedAdditionIds: [] }) },idGenerator: () => `next-${++sequence}`,clock: () => new Date("2026-10-29") });
  const base = { requestId: "suggest",expectedActiveVersionId: candidate.id,elementId: "action",text: "建议文本",reason: "理由" };
  const proposed = await service.reviewCandidate(actor,"p","c",{ ...base,kind: "suggest" });
  const edits = await Promise.allSettled([service.reviewCandidate(actor,"p","c",{ ...base,kind: "edit",requestId: "a",expectedActiveVersionId: proposed.id,text: "已改文本" }),service.reviewCandidate(actor,"p","c",{ ...base,kind: "edit",requestId: "b",expectedActiveVersionId: proposed.id,text: "另一个文本" })]);
  assert.equal(edits.filter(r => r.status === "fulfilled").length,1);
  const active = (await repository.findActive(actor,"p","c"))!;
  await assert.rejects(() => service.reviewCandidate(actor,"p","c",{ kind: "decide",requestId: "decide",expectedActiveVersionId: active.id,suggestionId: proposed.suggestions![0]!.id,decision: "accepted",reason: "复核" }),{ code: "SUGGESTION_CONFLICT" });
});

test("a concurrent same-direction decision cannot masquerade as this request's successful result",async () => {
  const backing = new InMemoryScriptContentRepository(); await backing.save(actor,candidate,null);
  let sequence = 0;
  const dependencies = { repository: backing,accessReader: { findProjectAccess: async () => ({ role: "owner" as const }) },contextReader: { findGenerationContext: async () => ({ sourceVersionId: "s",planVersionId: "plan",fragments: [],approvedAdditionIds: [] }) },idGenerator: () => `race-${++sequence}`,clock: () => new Date("2026-10-29") };
  const other = new ScriptContentService(dependencies);
  const proposed = await other.reviewCandidate(actor,"p","c",{ kind: "suggest",requestId: "proposal",expectedActiveVersionId: candidate.id,elementId: "action",text: "雨打庭院",reason: "视觉" });
  const decision = { kind: "decide" as const,expectedActiveVersionId: proposed.id,suggestionId: proposed.suggestions![0]!.id,decision: "accepted" as const,reason: "符合原文" };
  let raced = false;
  const repository = { findActive: backing.findActive.bind(backing),save: backing.save.bind(backing),async findReviewOperation(a: typeof actor,p: string,c: string,r: string) {
    if (r === "own" && !raced) { raced = true; await other.reviewCandidate(actor,"p","c",{ ...decision,requestId: "other" }); }
    return backing.findReviewOperation(a,p,c,r);
  } };
  const own = new ScriptContentService({ ...dependencies,repository });
  await assert.rejects(() => own.reviewCandidate(actor,"p","c",{ ...decision,requestId: "own" }),{ code: "VERSION_CONFLICT" });
  assert.equal(await backing.findReviewOperation(actor,"p","c","own"),null);
  assert.ok(await backing.findReviewOperation(actor,"p","c","other"));
});
