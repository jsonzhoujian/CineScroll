import assert from "node:assert/strict";
import test from "node:test";
import { SettingsReviewService,InMemorySettingsReviewRepository } from "../src/settings-review.ts";
import { SettingsRegenerationRunner,InMemorySettingsRegenerationRepository,type SettingsRegenerationRequest } from "../src/settings-regeneration.ts";
import { SettingsReconciliationService } from "../src/settings-reconciliation.ts";
import type { SettingsCandidate } from "../src/settings-runner.ts";
import { version,context } from "./script-quality-fixture.ts";
function fixture(overrides: Partial<SettingsCandidate> = {}) {
  const actor = { userId: "owner",workspaceId: "w" };
  const asset = { id: "a",assetType: "location" as const,name: "courtyard",visibleDefinition: { weather: "rain" },state: "wet",stateChanges: [],restrictions: [],provenance: [{ type: "source_fragment" as const,sourceVersionId: "source_1",fragmentId: context.fragments[0]!.id,transformation: "retained" as const }] };
  const candidate: SettingsCandidate = { id: "settings",jobId: "initial-job",projectId: "p",chapterId: "c",sourceVersionId: "source_1",scriptVersionId: "formal",upstreamConfirmedVersionIds: ["formal","plan_1","bible_1"],status: "candidate",createdBy: "owner",createdAt: "2026-11-04",assets: [asset,{ ...asset,id: "b",name: "untouched" }],failures: [{ scopeKey: "missing-character",code: "PROVIDER_ITEM_FAILED",retryable: true }],generationStatus: "partially_succeeded",...overrides };
  let formalId = "formal",allowed = true;
  const handoff = { read: async () => ({ version: { ...version,id: formalId,status: "confirmed" as const },sourceFragments: context.fragments,upstreamConfirmedVersionIds: ["plan_1","bible_1"] }) };
  const access = { findProjectAccess: async (a: typeof actor) => allowed ? { role: a.userId === "editor" ? "editor" as const : "owner" as const } : null };
  const reviews = new InMemorySettingsReviewRepository(actor,candidate);
  const repository = new InMemorySettingsRegenerationRepository(reviews,handoff,access);
  const selection = { expectedActiveVersionId: "settings",assetIds: ["a"],failureScopeKeys: ["missing-character"],reason: "visible details" };
  return { actor,asset,candidate,handoff,access,reviews,repository,selection,change: () => { formalId = "new-formal"; },revoke: () => { allowed = false; } };
}
function response(r: SettingsRegenerationRequest) {
  return { contractVersion: r.contractVersion,jobId: r.jobId,stage: "settings",projectId: r.projectId,chapterId: r.chapterId,sourceVersionId: r.sourceVersionId,upstreamConfirmedVersionIds: r.upstreamConfirmedVersionIds,status: "succeeded",items: r.regeneration.targets.map(t => ({ scopeKey: t.scopeKey,status: "succeeded",value: t.asset ? { ...t.asset,name: "regenerated" } : { id: "new-character",assetType: "character",name: "person",...t.pendingAsset,visibleDefinition: { coat: "blue" },state: "",stateChanges: [],restrictions: [],provenance: [{ type: "source_fragment",sourceVersionId: r.sourceVersionId,fragmentId: r.input.sourceFragments[0]!.id,transformation: "retained" }] } })) };
}
test("settings regeneration replaces only explicit targets, preserves evidence and recovers its immutable task result",async () => {
  const f = fixture();let calls = 0;
  const runner = new SettingsRegenerationRunner({ ...f,repository: f.repository,model: { async generate(r) { calls++;return response(r); } },idGenerator: () => "regenerated-settings",clock: () => new Date("2026-11-04") });
  const result = await runner.run(f.actor,"p","c","regen-job",f.selection);
  assert.equal(result.status,"candidate");assert.equal(result.assets[0]!.name,"regenerated");assert.deepEqual(result.assets[1],f.candidate.assets[1]);assert.equal(result.assets[2]!.id,"new-character");assert.equal(result.failures.length,0);
  assert.equal(result.regeneration?.outcome,"succeeded");assert.equal(result.operation?.kind,"regenerate");
  assert.deepEqual(await runner.run(f.actor,"p","c","regen-job",f.selection),result);assert.equal(calls,1);
  assert.deepEqual(await f.repository.findGeneration(f.actor,"p","c","regen-job"),result);
  await assert.rejects(() => runner.run(f.actor,"p","c","regen-job",{ ...f.selection,reason: "different" }),{ code: "VERSION_CONFLICT" });
  assert.equal(await f.repository.findGeneration({ ...f.actor,workspaceId: "other" },"p","c","regen-job"),null);
});
test("regeneration quarantines wrong target identity, keeps old assets and permits retrying a failed replacement",async () => {
  const f = fixture();let count = 0;
  const runner = new SettingsRegenerationRunner({ ...f,repository: f.repository,model: { async generate(r) { const raw = response(r);if (!count++) raw.items[0]!.value.id = "b";return raw; } },idGenerator: () => `regenerated-${count}`,clock: () => new Date("2026-11-04") });
  const first = await runner.run(f.actor,"p","c","job-1",{ ...f.selection,failureScopeKeys: [] });
  assert.deepEqual(first.assets,f.candidate.assets);assert.equal(first.failures.length,2);assert.equal(first.failures[1]!.assetId,"a");
  const next = await runner.run(f.actor,"p","c","job-2",{ ...f.selection,expectedActiveVersionId: first.id,assetIds: [],failureScopeKeys: [first.failures[1]!.scopeKey] });
  assert.equal(next.assets.length,2);assert.equal(next.assets[0]!.name,"regenerated");assert.deepEqual(next.failures,f.candidate.failures);
});
test("regeneration rejects editors, unexpected scopes, stale upstream and revoked access without saving results",async () => {
  for (const mode of ["editor","scope","upstream","revoked"]) {
    const f = fixture();let calls = 0;
    const runner = new SettingsRegenerationRunner({ ...f,repository: f.repository,model: { async generate(r) { calls++;const raw = response(r);if (mode === "scope") raw.items[0]!.scopeKey = "extra";if (mode === "upstream") f.change();if (mode === "revoked") f.revoke();return raw; } },idGenerator: () => "bad",clock: () => new Date("2026-11-04") });
    await assert.rejects(() => runner.run(mode === "editor" ? { ...f.actor,userId: "editor" } : f.actor,"p","c","job",f.selection));
    assert.equal((await f.reviews.findActive(f.actor,"p","c"))!.id,"settings");assert.equal(calls,mode === "editor" ? 0 : 1);
  }
});
test("locked targets are rejected before model invocation and formal regeneration preserves the original formal pointer",async () => {
  const f = fixture({ failures: [],generationStatus: "succeeded" });let calls = 0,sequence = 0;
  const review = new SettingsReviewService({ ...f,repository: f.reviews,idGenerator: () => `review-${++sequence}`,clock: () => new Date("2026-11-04") });
  let current = await review.execute(f.actor,"p","c",{ kind: "confirm",requestId: "confirm",expectedActiveVersionId: "settings",reason: "checked" });
  current = await review.execute(f.actor,"p","c",{ kind: "lock",requestId: "lock",expectedActiveVersionId: current.id,reason: "freeze",assetId: "a" });
  const runner = new SettingsRegenerationRunner({ ...f,repository: f.repository,model: { async generate(r) { calls++;return response(r); } },idGenerator: () => "regeneration",clock: () => new Date("2026-11-04") });
  await assert.rejects(() => runner.run(f.actor,"p","c","locked-job",{ ...f.selection,expectedActiveVersionId: current.id,failureScopeKeys: [] }),{ code: "LOCKED" });assert.equal(calls,0);
  current = await review.execute(f.actor,"p","c",{ kind: "unlock",requestId: "unlock",expectedActiveVersionId: current.id,reason: "revision",assetId: "a" });
  const regenerated = await runner.run(f.actor,"p","c","allowed-job",{ ...f.selection,expectedActiveVersionId: current.id,failureScopeKeys: [] });
  assert.equal(regenerated.status,"candidate");assert.equal((await f.reviews.findConfirmed(f.actor,"p","c"))!.id,current.id);assert.equal(calls,1);
});
test("regeneration preserves unrelated colliding failure scopes and restores saved results after a lost acknowledgement",async () => {
  const probe = fixture();
  const wrong = (r: SettingsRegenerationRequest) => { const raw = response(r);raw.items[0]!.value.id = "b";return raw; };
  const first = await new SettingsRegenerationRunner({ ...probe,repository: probe.repository,model: { async generate(r) { return wrong(r); } },idGenerator: () => "probe",clock: () => new Date("2026-11-04") }).run(probe.actor,"p","c","probe-job",{ ...probe.selection,failureScopeKeys: [] });
  const colliding = { scopeKey: first.failures[1]!.scopeKey,code: "UNRELATED_FAILURE",retryable: true };
  const f = fixture({ failures: [colliding] });let calls = 0;
  const runner = new SettingsRegenerationRunner({ ...f,repository: f.repository,model: { async generate(r) { calls++;return wrong(r); } },idGenerator: () => "saved-regen",clock: () => new Date("2026-11-04") });
  const save = f.repository.saveGeneration.bind(f.repository);
  f.repository.saveGeneration = async (a,v,expected) => { await save(a,v,expected);throw new Error("private storage acknowledgement"); };
  const selection = { ...f.selection,failureScopeKeys: [] };
  await assert.rejects(() => runner.run(f.actor,"p","c","saved-job",selection),{ code: "EXECUTION_UNCERTAIN" });
  const recovered = await runner.run(f.actor,"p","c","saved-job",selection);
  assert.equal(calls,1);assert.deepEqual(recovered.failures[0],colliding);assert.equal(recovered.failures.length,2);assert.equal(recovered.regeneration!.outcome,"failed");
});

test("reconciliation regeneration promotes only selected successful pending targets", async () => {
  const f = fixture({ failures: [],generationStatus: "succeeded" });
  let sequence = 0;
  const options = { ...f,idGenerator: () => `pending-${++sequence}`,clock: () => new Date("2026-11-05") };
  const review = new SettingsReviewService({ ...options,repository: f.reviews });
  const formal = await review.execute(f.actor,"p","c",{ kind:"confirm",requestId:"confirm",expectedActiveVersionId:"settings",reason:"checked" });
  f.change();
  const reconciliation = new SettingsReconciliationService({ ...options,repository:f.reviews });
  const base = await reconciliation.execute(f.actor,"p","c",{ kind:"begin",requestId:"begin",expectedActiveVersionId:formal.id,expectedUpstreamConfirmedVersionIds:["new-formal","plan_1","bible_1"],reason:"new script" });
  const runner = new SettingsRegenerationRunner({ ...options,model:{ async generate(r) {
    assert.deepEqual(r.regeneration.targets[0]?.pendingAsset,{ id:"a",assetType:"location",name:"courtyard" });
    assert.equal(r.regeneration.targets[0]?.asset,undefined);
    const raw = response(r);
    raw.items[1]!.value.provenance = [{ type:"source_fragment",sourceVersionId:"old-source",fragmentId:context.fragments[0]!.id,transformation:"retained" }];
    return raw;
  } } });
  const result = await runner.run(f.actor,"p","c","pending-job",{ expectedActiveVersionId:base.id,assetIds:["a","b"],failureScopeKeys:[],reason:"refresh" });
  assert.equal(result.regeneration?.outcome,"partially_succeeded");
  assert.deepEqual(result.assets.map(a => a.id),["a"]);
  assert.deepEqual(result.reconciliation?.pendingAssets,[base.reconciliation!.pendingAssets[1]]);
  assert.equal((await f.reviews.findConfirmed(f.actor,"p","c"))?.id,formal.id);
  await assert.rejects(() => review.execute(f.actor,"p","c",{ kind:"confirm",requestId:"too-early",expectedActiveVersionId:result.id,reason:"checked" }),{ code:"INVALID_STATE" });
  const repaired = await reconciliation.execute(f.actor,"p","c",{ kind:"repair",requestId:"manual",expectedActiveVersionId:result.id,expectedUpstreamConfirmedVersionIds:["new-formal","plan_1","bible_1"],reason:"manual review",assetId:"b",value:{ ...f.candidate.assets[1]!,name:"manually repaired" } });
  const confirmed = await review.execute(f.actor,"p","c",{ kind:"confirm",requestId:"confirm-reconciled",expectedActiveVersionId:repaired.id,reason:"checked" });
  assert.equal(confirmed.status,"confirmed");
});

test("a selected pending failure resolves independently of an already retained asset and other failures", async () => {
  const failures = ["first","second"].map(scopeKey => ({ scopeKey,assetId:"a",code:"PROVIDER_ITEM_FAILED",retryable:true }));
  const f = fixture({ failures });
  f.change();
  let sequence = 0;
  const options = { ...f,idGenerator:() => `scope-${++sequence}`,clock:() => new Date("2026-11-05") };
  const service = new SettingsReconciliationService({ ...options,repository:f.reviews });
  const begin = { kind:"begin" as const,requestId:"begin",expectedActiveVersionId:"settings",expectedUpstreamConfirmedVersionIds:["new-formal","plan_1","bible_1"],reason:"new script" };
  const pending = await service.execute(f.actor,"p","c",begin);
  const retained = await service.execute(f.actor,"p","c",{ ...begin,kind:"retain",requestId:"retain-a",expectedActiveVersionId:pending.id,assetId:"a" });
  const runner = new SettingsRegenerationRunner({ ...options,model:{ async generate(r) { return response(r); } } });
  const result = await runner.run(f.actor,"p","c","scope-job",{ expectedActiveVersionId:retained.id,assetIds:[],failureScopeKeys:["first"],reason:"check first scope" });
  assert.deepEqual(result.assets,[f.asset]);
  assert.deepEqual(result.failures,[failures[1]]);
  assert.deepEqual(result.reconciliation?.pendingFailureScopeKeys,["second"]);
  assert.deepEqual(result.reconciliation?.pendingAssets,retained.reconciliation?.pendingAssets);
});
