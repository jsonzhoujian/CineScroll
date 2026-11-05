import { SettingsRegenerationRunner,InMemorySettingsRegenerationRepository } from "../src/settings-regeneration.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { SettingsReconciliationService } from "../src/settings-reconciliation.ts";
import { SettingsReviewService,InMemorySettingsReviewRepository } from "../src/settings-review.ts";
import type { SettingsCandidate } from "../src/settings-runner.ts";
import { version,context } from "./script-quality-fixture.ts";
async function fixture() {
  const actor = { userId: "owner",workspaceId: "w" };
  const asset = { id: "a",assetType: "location" as const,name: "courtyard",visibleDefinition: { rain: true },state: "wet",stateChanges: [],restrictions: [],provenance: [{ type: "source_fragment" as const,sourceVersionId: "source_1",fragmentId: context.fragments[0]!.id,transformation: "retained" as const }] };
  const candidate: SettingsCandidate = { id: "settings",jobId: "initial",projectId: "p",chapterId: "c",sourceVersionId: "source_1",scriptVersionId: "formal",upstreamConfirmedVersionIds: ["formal","plan_1","bible_1"],createdBy: "owner",createdAt: "2026-11-04",status: "candidate",generationStatus: "succeeded",assets: [asset,{ ...asset,id: "b" }],failures: [] };
  let formalId = "formal",source = "source_1",allowed = true,id = 0;
  const handoff = { async read() { return { version: { ...version,id: formalId,sourceVersionId: source,status: "confirmed" as const },sourceFragments: context.fragments,upstreamConfirmedVersionIds: ["plan_1","bible_1"] }; } };
  const access = { async findProjectAccess(a: typeof actor) { return allowed ? { role: a.userId === "editor" ? "editor" as const : "owner" as const } : null; } };
  const repository = new InMemorySettingsReviewRepository(actor,candidate),options = { repository,handoff,access,idGenerator: () => `v${++id}`,clock: () => new Date("2026-11-04") };
  const review = new SettingsReviewService(options),service = new SettingsReconciliationService(options);
  let old = await review.execute(actor,"p","c",{ kind: "confirm",requestId: "confirm",expectedActiveVersionId: candidate.id,reason: "checked" });
  old = await review.execute(actor,"p","c",{ kind: "lock",requestId: "lock",expectedActiveVersionId: old.id,assetId: "a",reason: "freeze" });
  old = await review.execute(actor,"p","c",{ kind: "suggest",requestId: "suggest",expectedActiveVersionId: old.id,assetId: "b",value: { ...asset,id: "b",name: "proposed" },reason: "old advice" });
  formalId = "new-formal";
  const command = { kind: "begin" as const,requestId: "begin",expectedActiveVersionId: old.id,expectedUpstreamConfirmedVersionIds: [formalId,"plan_1","bible_1"],reason: "review new script" };
  return { actor,asset,old,repository,review,service,command,handoff,access,change: () => { formalId = "later-formal"; },changeSource: () => { source = "new-source"; },revoke: () => { allowed = false; } };
}
test("same-source reconciliation explicitly retains assets in batches, preserves locks/history and requires reconfirmation",async () => {
  const f = await fixture();assert.equal((await f.service.preview(f.actor,"p","c")).canBegin,true);
  assert.equal((await f.repository.findActive(f.actor,"p","c"))!.id,f.old.id);
  let v = await f.service.execute(f.actor,"p","c",f.command);
  assert.equal(v.assets.length,0);assert.equal(v.suggestions.length,0);assert.equal(v.reconciliation!.pendingAssets.length,2);assert.deepEqual(v.locks,f.old.locks);
  assert.deepEqual((await f.repository.findVersion(f.actor,"p","c",f.old.id))!.suggestions,f.old.suggestions);
  assert.equal((await f.repository.findConfirmed(f.actor,"p","c"))!.id,f.old.id);
  await assert.rejects(() => f.review.execute(f.actor,"p","c",{ kind: "confirm",requestId: "early",expectedActiveVersionId: v.id,reason: "check" }),{ code: "INVALID_STATE" });
  v = await f.service.execute(f.actor,"p","c",{ ...f.command,kind: "retain",requestId: "retain-a",expectedActiveVersionId: v.id,assetId: "a" });
  assert.deepEqual(v.assets,[f.asset]);assert.deepEqual(v.locks,f.old.locks);
  let modelCalls = 0;
  const regeneration = new SettingsRegenerationRunner({ repository: new InMemorySettingsRegenerationRepository(f.repository,f.handoff,f.access),handoff: f.handoff,access: f.access,idGenerator: () => "unused",clock: () => new Date("2026-11-04"),model: { async generate() { modelCalls++;throw new Error("must not regenerate an effective asset during pending reconciliation"); } } });
  await assert.rejects(() => regeneration.run(f.actor,"p","c","blocked-regeneration",{ expectedActiveVersionId: v.id,assetIds: ["a"],failureScopeKeys: [],reason: "blocked" }),{ code: "NOT_FOUND" });assert.equal(modelCalls,0);

  await assert.rejects(() => f.review.execute(f.actor,"p","c",{ kind: "edit",requestId: "locked-edit",expectedActiveVersionId: v.id,assetId: "a",value: { ...f.asset,name: "changed" },reason: "change" }),{ code: "LOCKED" });
  v = await f.service.execute(f.actor,"p","c",{ ...f.command,kind: "retain",requestId: "retain-b",expectedActiveVersionId: v.id,assetId: "b" });
  v = await f.review.execute(f.actor,"p","c",{ kind: "confirm",requestId: "reconfirm",expectedActiveVersionId: v.id,reason: "checked all" });
  assert.equal(v.status,"confirmed");assert.equal((await f.repository.findConfirmed(f.actor,"p","c"))!.id,v.id);
  assert.equal((await f.service.execute(f.actor,"p","c",f.command)).operation!.requestId,"begin");
});
test("reconciliation rejects editors, changed request identity, stale authority, cross-source and revoked access",async () => {
  const f = await fixture();
  await assert.rejects(() => f.service.execute({ ...f.actor,userId: "editor" },"p","c",f.command),{ code: "FORBIDDEN" });
  await f.service.execute(f.actor,"p","c",f.command);
  await assert.rejects(() => f.service.execute(f.actor,"p","c",{ ...f.command,reason: "different" }),{ code: "VERSION_CONFLICT" });
  f.change();await assert.rejects(() => f.service.execute(f.actor,"p","c",{ ...f.command,requestId: "later" }),{ code: "UPSTREAM_CHANGED" });
  const other = await fixture();other.changeSource();await assert.rejects(() => other.service.execute(other.actor,"p","c",other.command),{ code: "UPSTREAM_CHANGED" });
  other.revoke();await assert.rejects(() => other.service.preview(other.actor,"p","c"),{ code: "NOT_FOUND" });
});
test("reconciliation CAS rejects competing retained targets and later authority can requeue all unfinished assets",async () => {
  const f = await fixture();const begun = await f.service.execute(f.actor,"p","c",f.command);
  const results = await Promise.allSettled(["a","b"].map(assetId => f.service.execute(f.actor,"p","c",{ ...f.command,kind: "retain",assetId,requestId: `compete-${assetId}`,expectedActiveVersionId: begun.id })));
  assert.equal(results.filter(r => r.status==="fulfilled").length,1);
  const active = (await f.repository.findActive(f.actor,"p","c"))!;
  assert.equal(active.assets.length,1);assert.equal(active.reconciliation!.pendingAssets.length,1);
  f.change();const preview = await f.service.preview(f.actor,"p","c");
  const next = await f.service.execute(f.actor,"p","c",{ ...f.command,requestId: "next-authority",expectedActiveVersionId: active.id,expectedUpstreamConfirmedVersionIds: preview.upstreamConfirmedVersionIds });
  assert.equal(next.reconciliation!.pendingAssets.length,2);assert.equal(new Set(next.reconciliation!.pendingAssets.map(a => a.id)).size,2);assert.deepEqual(next.locks,f.old.locks);
});

test("cross-source reconciliation requires explicit unlock, exact evidence migration and authorized repair", async () => {
  const f = await fixture();
  f.changeSource();
  let evidenceMatches = true;
  let sequence = 0;
  const service = new SettingsReconciliationService({
    repository: f.repository, handoff: f.handoff, access: f.access,
    idGenerator: () => `cross-${++sequence}`, clock: () => new Date("2026-11-05"),
    async readEvidence() {
      return ["source_1","new-source"].map(id => ({ id,fragments: context.fragments.map(fragment => ({
        ...fragment, contentHash: id === "new-source" && !evidenceMatches ? "different" : "matching",
      })) }));
    },
  });
  const v = await service.execute(f.actor,"p","c",f.command);
  assert.equal(v.sourceVersionId,"new-source");
  assert.deepEqual(v.assets,[]);
  const retain = { ...f.command,kind:"retain" as const,requestId:"retain-cross",expectedActiveVersionId:v.id,assetId:"a" };
  await assert.rejects(() => service.execute(f.actor,"p","c",retain),{ code:"LOCKED" });
  const unlocked = await service.execute(f.actor,"p","c",{ ...retain,kind:"unlock",requestId:"unlock-cross" });
  assert.deepEqual(unlocked.reconciliation?.pendingAssets,v.reconciliation?.pendingAssets);
  const retained = await service.execute(f.actor,"p","c",{ ...retain,expectedActiveVersionId:unlocked.id });
  assert.deepEqual(retained.assets[0],{ ...f.asset,provenance:f.asset.provenance.map(ref => ({ ...ref,sourceVersionId:"new-source" })) });
  evidenceMatches = false;
  await assert.rejects(() => service.execute(f.actor,"p","c",{ ...retain,assetId:"b",requestId:"mismatch",expectedActiveVersionId:retained.id }),{ code:"INVALID_STATE" });
  const repair = { ...retain,kind:"repair" as const,assetId:"b",requestId:"repair",expectedActiveVersionId:retained.id };
  await assert.rejects(() => service.execute(f.actor,"p","c",{ ...repair,value:{ ...f.asset,id:"b" } }),{ code:"INVALID_STATE" });
  const repaired = await service.execute(f.actor,"p","c",{ ...repair,value:{ ...retained.assets[0],id:"b",name:"revised" } });
  assert.deepEqual(repaired.reconciliation?.pendingAssets,[]);
  assert.equal((await f.repository.findConfirmed(f.actor,"p","c"))?.id,f.old.id);
  const confirmed = await f.review.execute(f.actor,"p","c",{ kind:"confirm",requestId:"cross-confirm",expectedActiveVersionId:repaired.id,reason:"checked" });
  assert.equal(confirmed.status,"confirmed");
  assert.deepEqual(await f.repository.findVersion(f.actor,"p","c",f.old.id),f.old);
});
