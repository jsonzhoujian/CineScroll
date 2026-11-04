import assert from "node:assert/strict";
import test from "node:test";
import { SettingsReviewService,InMemorySettingsReviewRepository } from "../src/settings-review.ts";
import type { SettingsCandidate } from "../src/settings-runner.ts";
import { version,context } from "./script-quality-fixture.ts";
function fixture(overrides: Partial<SettingsCandidate> = {}) {
  const actor = { userId: "owner",workspaceId: "w" };
  const asset = { id: "courtyard",assetType: "location" as const,name: "courtyard",visibleDefinition: { weather: "rain" },state: "wet",stateChanges: [],restrictions: [],provenance: [{ type: "source_fragment" as const,sourceVersionId: "source_1",fragmentId: context.fragments[0]!.id,transformation: "retained" as const }] };
  const candidate: SettingsCandidate = { id: "settings",jobId: "job",projectId: "p",chapterId: "c",sourceVersionId: "source_1",scriptVersionId: "formal",upstreamConfirmedVersionIds: ["formal","plan_1","bible_1"],status: "candidate",createdBy: "owner",createdAt: "2026-11-03",assets: [asset],failures: [],generationStatus: "succeeded",...overrides };
  const handoff = { read: async () => ({ version: { ...version,id: "formal",status: "confirmed" as const },sourceFragments: context.fragments,upstreamConfirmedVersionIds: ["plan_1","bible_1"] }) };
  let sequence = 0;
  const repository = new InMemorySettingsReviewRepository(actor,candidate);
  const service = new SettingsReviewService({ repository,handoff,access: { findProjectAccess: async a => a.userId === "outsider" ? null : { role: a.userId === "editor" ? "editor" : a.userId === "reviewer" ? "reviewer" : "owner" } },idGenerator: () => `review-${++sequence}`,clock: () => new Date("2026-11-03T00:00:00Z") });
  return { actor,asset,candidate,handoff,repository,service };
}
test("settings candidate review enforces role, evidence, immutable audit and idempotent request identity",async () => {
  const f = fixture(),editor = { ...f.actor,userId: "editor" };
  const command = { kind: "edit" as const,requestId: "edit",expectedActiveVersionId: "settings",reason: "visible detail",assetId: "courtyard",value: { ...f.asset,name: "rain courtyard" } };
  await assert.rejects(() => f.service.execute(editor,"p","c",command),{ code: "FORBIDDEN" });
  await assert.rejects(() => f.service.execute({ ...f.actor,userId: "outsider" },"p","c",command),{ code: "NOT_FOUND" });
  await assert.rejects(() => f.service.execute(f.actor,"p","c",{ ...command,value: { ...command.value,provenance: [{ ...f.asset.provenance[0]!,fragmentId: "invented" }] } }),{ code: "INVALID_COMMAND" });
  const edited = await f.service.execute({ ...f.actor,userId: "reviewer" },"p","c",command);
  assert.equal(edited.assets[0]!.name,"rain courtyard");assert.equal(edited.operation?.reason,"visible detail");
  assert.equal((await f.repository.findVersion(f.actor,"p","c","settings"))!.assets[0]!.name,"courtyard");
  assert.deepEqual(await f.service.execute({ ...f.actor,userId: "reviewer" },"p","c",command),edited);
  await assert.rejects(() => f.service.execute({ ...f.actor,userId: "reviewer" },"p","c",{ ...command,reason: "different" }),{ code: "VERSION_CONFLICT" });
});
test("settings formal workflow blocks pending suggestions and locks, preserves formal head until reconfirmation",async () => {
  const f = fixture(),editor = { ...f.actor,userId: "editor" };
  let active = await f.service.execute(editor,"p","c",{ kind: "suggest",requestId: "suggest",expectedActiveVersionId: "settings",reason: "visual",assetId: f.asset.id,value: { ...f.asset,name: "new courtyard" } });
  await assert.rejects(() => f.service.execute(f.actor,"p","c",{ kind: "confirm",requestId: "pending",expectedActiveVersionId: active.id,reason: "check" }),{ code: "INVALID_STATE" });
  active = await f.service.execute(f.actor,"p","c",{ kind: "decide",requestId: "accept",expectedActiveVersionId: active.id,reason: "verified",suggestionId: active.suggestions[0]!.id,decision: "accepted" });
  active = await f.service.execute(f.actor,"p","c",{ kind: "confirm",requestId: "confirm",expectedActiveVersionId: active.id,reason: "verified" });
  assert.equal(active.status,"confirmed");
  await assert.rejects(() => f.service.execute(f.actor,"p","c",{ kind: "edit",requestId: "formal-edit",expectedActiveVersionId: active.id,reason: "change",assetId: f.asset.id,value: f.asset }),{ code: "INVALID_STATE" });
  active = await f.service.execute(f.actor,"p","c",{ kind: "lock",requestId: "lock",expectedActiveVersionId: active.id,reason: "freeze",assetId: f.asset.id });
  await assert.rejects(() => f.service.execute(editor,"p","c",{ kind: "suggest",requestId: "locked",expectedActiveVersionId: active.id,reason: "change",assetId: f.asset.id,value: f.asset }),{ code: "LOCKED" });
  active = await f.service.execute(f.actor,"p","c",{ kind: "unlock",requestId: "unlock",expectedActiveVersionId: active.id,reason: "revision",assetId: f.asset.id });
  active = await f.service.execute(editor,"p","c",{ kind: "suggest",requestId: "formal-suggest",expectedActiveVersionId: active.id,reason: "revision",assetId: f.asset.id,value: f.asset });
  const formalId = active.id;
  active = await f.service.execute(f.actor,"p","c",{ kind: "decide",requestId: "formal-accept",expectedActiveVersionId: active.id,reason: "accepted",suggestionId: active.suggestions.find(s => s.status === "pending")!.id,decision: "accepted" });
  assert.equal(active.status,"candidate");assert.equal((await f.repository.findConfirmed(f.actor,"p","c"))?.id,formalId);
  active = await f.service.execute(f.actor,"p","c",{ kind: "confirm",requestId: "reconfirm",expectedActiveVersionId: active.id,reason: "rechecked" });
  assert.equal((await f.repository.findConfirmed(f.actor,"p","c"))?.id,active.id);
});
test("settings review repository preserves CAS, original operation recovery, tenant isolation and stale-suggestion protection",async () => {
  const f = fixture();
  const command = { kind: "edit" as const,requestId: "race",expectedActiveVersionId: "settings",reason: "visual",assetId: f.asset.id,value: { ...f.asset,name: "changed" } };
  const results = await Promise.allSettled([f.service.execute(f.actor,"p","c",command),f.service.execute(f.actor,"p","c",{ ...command,requestId: "competing" })]);
  assert.equal(results.filter(r => r.status === "fulfilled").length,1);assert.equal(results.filter(r => r.status === "rejected" && r.reason.code === "VERSION_CONFLICT").length,1);
  let active = (await f.repository.findActive(f.actor,"p","c"))!;
  active.assets[0]!.visibleDefinition.weather = "mutated";
  assert.equal((await f.repository.findActive(f.actor,"p","c"))!.assets[0]!.visibleDefinition.weather,"rain");
  assert.equal(await f.repository.findActive({ ...f.actor,workspaceId: "other" },"p","c"),null);
  active = await f.service.execute({ ...f.actor,userId: "editor" },"p","c",{ kind: "suggest",requestId: "stale-suggest",expectedActiveVersionId: active.id,reason: "propose",assetId: f.asset.id,value: f.asset });
  const suggestionId = active.suggestions[0]!.id;
  active = await f.service.execute(f.actor,"p","c",{ ...command,requestId: "new-edit",expectedActiveVersionId: active.id,value: { ...f.asset,name: "newer" } });
  await assert.rejects(() => f.service.execute(f.actor,"p","c",{ kind: "decide",requestId: "stale-accept",expectedActiveVersionId: active.id,reason: "accept",suggestionId,decision: "accepted" }),{ code: "SUGGESTION_CONFLICT" });
  const save = f.repository.save.bind(f.repository);
  f.repository.save = async (a,v,expected) => { await save(a,v,expected);throw new Error("lost storage acknowledgement"); };
  const rejection = { kind: "decide" as const,requestId: "reject",expectedActiveVersionId: active.id,reason: "outdated",suggestionId,decision: "rejected" as const };
  await assert.rejects(() => f.service.execute(f.actor,"p","c",rejection));
  const recovered = await f.service.execute(f.actor,"p","c",rejection);
  assert.equal(recovered.suggestions[0]!.status,"rejected");assert.equal(recovered.operation?.requestId,"reject");
  f.handoff.read = async () => ({ version: { ...version,id: "different-formal",status: "confirmed" as const },sourceFragments: context.fragments,upstreamConfirmedVersionIds: ["plan_1","bible_1"] });
  await assert.rejects(() => f.service.execute(f.actor,"p","c",{ ...command,requestId: "stale-upstream",expectedActiveVersionId: recovered.id }),{ code: "UPSTREAM_CHANGED" });
});
test("failed settings scope blocks confirmation and malformed commands cannot create audit versions",async () => {
  const f = fixture({ generationStatus: "partially_succeeded",failures: [{ scopeKey: "character",code: "INVALID_ASSET",retryable: true }] });
  await assert.rejects(() => f.service.execute(f.actor,"p","c",{ kind: "confirm",requestId: "failed",expectedActiveVersionId: "settings",reason: "check" }),{ code: "INVALID_STATE" });
  await assert.rejects(() => f.service.execute(f.actor,"p","c",{ kind: "confirm",requestId: "empty",expectedActiveVersionId: "settings",reason: " " }),{ code: "INVALID_COMMAND" });
  assert.equal((await f.repository.findActive(f.actor,"p","c"))!.id,"settings");
});
test("canonical asset IDs matching object prototype names can be edited, locked and explicitly unlocked",async () => {
  for (const id of ["constructor","__proto__"]) {
    const seed = fixture();
    const f = fixture({ assets: [{ ...seed.asset,id }] });
    let active = await f.service.execute(f.actor,"p","c",{ kind: "edit",requestId: "edit-special",expectedActiveVersionId: "settings",reason: "visible",assetId: id,value: { ...seed.asset,id,name: "changed" } });
    active = await f.service.execute(f.actor,"p","c",{ kind: "confirm",requestId: "confirm-special",expectedActiveVersionId: active.id,reason: "checked" });
    await assert.rejects(() => f.service.execute(f.actor,"p","c",{ kind: "unlock",requestId: "false-unlock",expectedActiveVersionId: active.id,reason: "unlock",assetId: id }),{ code: "INVALID_STATE" });
    active = await f.service.execute(f.actor,"p","c",{ kind: "lock",requestId: "lock-special",expectedActiveVersionId: active.id,reason: "freeze",assetId: id });
    assert.equal(Object.hasOwn(active.locks,id),true);
    assert.equal(active.locks[id]!.lockedBy,"owner");
    active = await f.service.execute(f.actor,"p","c",{ kind: "unlock",requestId: "unlock-special",expectedActiveVersionId: active.id,reason: "revision",assetId: id });
    assert.equal(Object.hasOwn(active.locks,id),false);
  }
});
