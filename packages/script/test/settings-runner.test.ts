import assert from "node:assert/strict";
import test from "node:test";
import { SettingsRunner,type SettingsCandidate } from "../src/settings-runner.ts";
import { version,context } from "./script-quality-fixture.ts";
test("settings generation rechecks formal identity after transport and never saves stale results",async () => {
  let changed = false,calls = 0,saved: SettingsCandidate | null = null;
  const handoff = { read: async () => ({ version: { ...version,id: changed ? "new-formal" : "formal",status: "confirmed" as const },sourceFragments: context.fragments,upstreamConfirmedVersionIds: ["plan_1","bible_1"] }) };
  const runner = new SettingsRunner({ handoff,repository: { findGeneration: async () => saved,saveGeneration: async (_a,v) => { saved = v;return v; } },model: { async generate() { calls++;changed = true;return {}; } },idGenerator: () => "settings",clock: () => new Date("2026-11-03") });
  await assert.rejects(() => runner.run({ userId: "owner",workspaceId: "w" },"p","c","job"),{ code: "UPSTREAM_CHANGED" });
  assert.equal(calls,1);assert.equal(saved,null);
});

import { InMemorySettingsCandidateRepository } from "../src/settings-runner.ts";
test("settings candidate repository preserves immutable task results, chapter CAS and tenant separation",async () => {
  const actor = { userId: "owner",workspaceId: "w" };
  const handoff = { read: async () => ({ version: { ...version,id: "formal",status: "confirmed" as const },sourceFragments: context.fragments,upstreamConfirmedVersionIds: ["plan_1","bible_1"] }) };
  const repository = new InMemorySettingsCandidateRepository(handoff);
  const candidate: SettingsCandidate = { id: "settings",jobId: "job",projectId: "p",chapterId: "c",sourceVersionId: "source_1",upstreamConfirmedVersionIds: ["formal","plan_1","bible_1"],scriptVersionId: "formal",status: "candidate",createdBy: "owner",createdAt: "2026-11-03",assets: [],failures: [{ scopeKey: "character",code: "INVALID_ASSET",retryable: true }],generationStatus: "failed" };
  const races = await Promise.allSettled([repository.saveGeneration(actor,candidate),repository.saveGeneration(actor,{ ...candidate,id: "other",jobId: "other-job" })]);
  assert.equal(races.filter(r => r.status === "fulfilled").length,1);
  const read = await repository.findGeneration(actor,"p","c","job");assert.deepEqual(read,candidate);
  read!.failures.length = 0;assert.equal((await repository.findActive(actor,"p","c"))?.failures.length,1);
  assert.equal(await repository.findGeneration({ ...actor,workspaceId: "other" },"p","c","job"),null);
  assert.deepEqual(await repository.saveGeneration(actor,candidate),candidate);
});
