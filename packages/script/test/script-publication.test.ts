import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryScriptContentRepository, ScriptContentService } from "../src/script-content.ts";
import { ScriptPublicationService, qualityBinding, SCRIPT_QUALITY_RULE_VERSION } from "../src/script-publication.ts";
import { version,context,verdict } from "./script-quality-fixture.ts";

test("persisted exact-candidate quality report gates confirmation and idempotent element locks",async () => {
  const actor = { userId: "owner",workspaceId: "w" },repo = new InMemoryScriptContentRepository();
  await repo.save(actor,version,null); let id = 0;
  const contextReader = { findGenerationContext: async () => context };
  const accessReader = { findProjectAccess: async (a: typeof actor) => ({ role: a.userId === "editor" ? "editor" as const : "owner" as const }) };
  const content = new ScriptContentService({ repository: repo,contextReader,accessReader,idGenerator: () => `v${++id}`,clock: () => new Date("2026-11-02") });
  const publication = new ScriptPublicationService({ repository: repo,contextReader,accessReader,content });
  const command = { kind: "confirm" as const,reason: "已核对质量与原文",requestId: "confirm",expectedActiveVersionId: version.id,reportId: "report" };
  await assert.rejects(() => publication.execute(actor,"p","c",command),{ code: "INVALID_CONFIRMATION" });
  await publication.assess(actor,"p","c",{ jobId: "report",binding: qualityBinding(version,context),model: { async assess() { return verdict; } } });
  const report = await publication.report(actor,"p","c","report");
  assert.equal(report?.ruleVersion,SCRIPT_QUALITY_RULE_VERSION); assert.equal(report?.passed,true);
  await assert.rejects(() => publication.execute({ ...actor,userId: "editor" },"p","c",command),{ code: "FORBIDDEN" });
  const confirmed = await publication.execute(actor,"p","c",command);
  assert.equal(confirmed.status,"confirmed"); assert.equal(confirmed.qualityReportId,"report");
  const lock = { kind: "lock" as const,reason: "冻结审核结果",requestId: "lock",expectedActiveVersionId: confirmed.id,elementIds: ["e1"] };
  const locked = await publication.execute(actor,"p","c",lock);
  assert.equal(locked.elements[0]?.lockedBy,"owner");
  assert.equal((await publication.execute(actor,"p","c",lock)).id,locked.id);
  assert.equal((await publication.execute(actor,"p","c",command)).id,confirmed.id);
  assert.equal(locked.elements[0]?.provenance[0]?.type,"source_fragment");
});

function fixture() {
  const actor = { userId: "owner",workspaceId: "w" },repository = new InMemoryScriptContentRepository();
  let activeContext = context,id = 0;
  const contextReader = { findGenerationContext: async () => activeContext };
  const accessReader = { findProjectAccess: async (a: typeof actor) => ({ role: a.userId === "editor" ? "editor" as const : "owner" as const }) };
  const content = new ScriptContentService({ repository,contextReader,accessReader,idGenerator: () => `v${++id}`,clock: () => new Date("2026-11-02") });
  const publication = new ScriptPublicationService({ repository,contextReader,accessReader,content });
  return { actor,repository,content,publication,changeContext: () => { activeContext = { ...context,confirmedPlan: { ...context.confirmedPlan!,targetDurationSeconds: 180 } }; } };
}
test("old reports and changed context cannot confirm an edited candidate",async () => {
  const f = fixture();await f.repository.save(f.actor,version,null);
  const assess = () => f.publication.assess(f.actor,"p","c",{ jobId: "report",binding: qualityBinding(version,context),model: { async assess() { return verdict; } } });
  await assess();
  const edited = await f.content.reviewCandidate(f.actor,"p","c",{ kind: "edit",requestId: "edit",expectedActiveVersionId: version.id,elementId: "e1",text: "少年缓缓起身。",reason: "动作节奏" });
  const confirm = { kind: "confirm" as const,requestId: "confirm",reason: "核对",expectedActiveVersionId: edited.id,reportId: "report" };
  await assert.rejects(() => f.publication.execute(f.actor,"p","c",confirm),{ code: "INVALID_CONFIRMATION" });
  assert.equal((await f.repository.findActive(f.actor,"p","c"))?.status,"candidate");
  const changed = fixture();await changed.repository.save(changed.actor,version,null);
  await changed.publication.assess(changed.actor,"p","c",{ jobId: "report",binding: qualityBinding(version,context),model: { async assess() { return verdict; } } });
  changed.changeContext();
  await assert.rejects(() => changed.publication.execute(changed.actor,"p","c",{ ...confirm,expectedActiveVersionId: version.id }),{ code: "INVALID_CONFIRMATION" });
});
test("concurrent edits invalidate an in-flight assessment without publishing a report",async () => {
  const f = fixture();await f.repository.save(f.actor,version,null);
  await assert.rejects(() => f.publication.assess(f.actor,"p","c",{ jobId: "report",binding: qualityBinding(version,context),model: { async assess() {
    await f.content.reviewCandidate(f.actor,"p","c",{ kind: "edit",requestId: "edit",expectedActiveVersionId: version.id,elementId: "e1",text: "少年起身整理衣衫。",reason: "动作" });return verdict;
  } } }),{ code: "VERSION_CONFLICT" });
  assert.equal(await f.publication.report(f.actor,"p","c","report"),null);
});
test("two different confirmation commands cannot return each other's publication audit",async () => {
  const f = fixture();await f.repository.save(f.actor,version,null);
  await f.publication.assess(f.actor,"p","c",{ jobId: "report",binding: qualityBinding(version,context),model: { async assess() { return verdict; } } });
  const command = { kind: "confirm" as const,reason: "核对",requestId: "one",expectedActiveVersionId: version.id,reportId: "report" };
  const results = await Promise.allSettled([f.publication.execute(f.actor,"p","c",command),f.publication.execute(f.actor,"p","c",{ ...command,requestId: "two" })]);
  assert.equal(results.filter(r => r.status === "fulfilled").length,1);
  const winner = results.find(r => r.status === "fulfilled");assert.ok(winner && winner.status === "fulfilled");
  const requestId = winner.value.publicationOperation!.requestId;
  assert.equal((await f.publication.execute(f.actor,"p","c",{ ...command,requestId })).id,winner.value.id);
});
test("publication response loss reconciles the original immutable operation",async () => {
  const f = fixture();await f.repository.save(f.actor,version,null);
  await f.publication.assess(f.actor,"p","c",{ jobId: "report",binding: qualityBinding(version,context),model: { async assess() { return verdict; } } });
  const save = f.repository.save.bind(f.repository);let lost = false;
  f.repository.save = async (...args) => { const saved = await save(...args);if (saved.status === "confirmed" && !lost) { lost = true;throw new (await import("../src/script-content.ts")).ScriptContentError("STORAGE_UNAVAILABLE","lost"); }return saved; };
  const command = { kind: "confirm" as const,reason: "核对",requestId: "one",expectedActiveVersionId: version.id,reportId: "report" };
  const confirmed = await f.publication.execute(f.actor,"p","c",command);
  assert.equal((await f.publication.execute(f.actor,"p","c",command)).id,confirmed.id);
  await assert.rejects(() => f.publication.execute(f.actor,"p","c",{ ...command,reason: "different" }),{ code: "VERSION_CONFLICT" });
});
