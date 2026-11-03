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
