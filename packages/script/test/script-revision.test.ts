import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryScriptContentRepository } from "../src/script-content.ts";
import { ScriptRevisionService } from "../src/script-revision.ts";
import { version,context } from "./script-quality-fixture.ts";
test("explicit unlock precedes formal suggestions and accepted revision preserves the formal pointer",async () => {
  const actor = { workspaceId: "w",userId: "owner" },repo = new InMemoryScriptContentRepository();let sequence = 0;
  const formal = { ...version,status: "confirmed" as const,elements: version.elements.map(e => ({ ...e,lockedAt: "2026-11-02",lockedBy: "owner" })) };
  await repo.save(actor,formal,null);
  const service = new ScriptRevisionService({ repository: repo,contextReader: { findGenerationContext: async () => context },accessReader: { findProjectAccess: async a => ({ role: a.userId === "editor" ? "editor" : "owner" }) },idGenerator: () => `revision-${++sequence}`,clock: () => new Date("2026-11-02") });
  const suggest = { kind: "suggest" as const,requestId: "suggest",reason: "动作节奏",expectedActiveVersionId: formal.id,elementId: "e1",text: "少年缓缓起身。" };
  await assert.rejects(() => service.execute(actor,"p","c",suggest),{ code: "INVALID_STATE" });
  await assert.rejects(() => service.execute({ ...actor,userId: "editor" },"p","c",{ kind: "unlock",requestId: "unlock",reason: "修订",expectedActiveVersionId: formal.id,elementId: "e1" }),{ code: "FORBIDDEN" });
  const unlocked = await service.execute(actor,"p","c",{ kind: "unlock",requestId: "unlock",reason: "修订",expectedActiveVersionId: formal.id,elementId: "e1" });
  const proposed = await service.execute({ ...actor,userId: "editor" },"p","c",{ ...suggest,expectedActiveVersionId: unlocked.id });
  const command = { kind: "decide" as const,requestId: "accept",reason: "符合原文",expectedActiveVersionId: proposed.id,suggestionId: proposed.suggestions![0]!.id,decision: "accepted" as const };
  const candidate = await service.execute(actor,"p","c",command);
  assert.deepEqual(candidate.revisionChanges,{ fromVersionId: proposed.id,acceptedSuggestionId: command.suggestionId,elementIds: ["e1"],sceneIds: ["scene_1"],episodeIds: ["episode_1"] });
  assert.equal(candidate.status,"candidate");assert.equal(candidate.qualityReportId,undefined);assert.equal(candidate.elements[0]?.text,"少年缓缓起身。");
  assert.equal((await repo.findConfirmed(actor,"p","c"))?.id,proposed.id);
  assert.equal((await service.execute(actor,"p","c",command)).id,candidate.id);
  await assert.rejects(() => service.execute(actor,"p","c",{ ...command,reason: "其他" }),{ code: "VERSION_CONFLICT" });
});

import { ScriptContentService } from "../src/script-content.ts";
test("candidate editing and accepting suggestions cannot bypass inherited element locks",async () => {
  const actor = { workspaceId: "w",userId: "owner" },repository = new InMemoryScriptContentRepository();
  const candidate = { ...version,elements: version.elements.map(e => ({ ...e,lockedAt: "2026-11-02",lockedBy: "owner" })),suggestions: [{ id: "sug",elementId: "e1",baseText: version.elements[0]!.text,text: "替换",reason: "节奏",submittedBy: "editor",submittedAt: "2026-11-02",status: "pending" as const }] };
  await repository.save(actor,candidate,null);
  const content = new ScriptContentService({ repository,contextReader: { findGenerationContext: async () => context },accessReader: { findProjectAccess: async () => ({ role: "owner" }) },idGenerator: () => "next",clock: () => new Date("2026-11-02") });
  await assert.rejects(() => content.editElement(actor,"p","c",{ expectedActiveVersionId: candidate.id,elementId: "e1",text: "覆盖",reason: "修改" }),{ code: "INVALID_STATE" });
  await assert.rejects(() => content.decideSuggestion(actor,"p","c",{ expectedActiveVersionId: candidate.id,suggestionId: "sug",decision: "accepted" }),{ code: "INVALID_STATE" });
  assert.deepEqual(await repository.findActive(actor,"p","c"),candidate);
});
