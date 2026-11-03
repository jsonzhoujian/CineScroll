import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryScriptContentRepository } from "../src/script-content.ts";
import { ConfirmedScriptHandoff } from "../src/script-handoff.ts";
import { version,context } from "./script-quality-fixture.ts";
test("T07 reads the pinned formal script while a revision candidate is pending and rejects stale upstream",async () => {
  const actor = { workspaceId: "w",userId: "owner" },repo = new InMemoryScriptContentRepository();let current = context;
  const handoff = new ConfirmedScriptHandoff(repo,{ findGenerationContext: async () => current });
  await repo.save(actor,version,null);await assert.rejects(() => handoff.read(actor,"p","c"),{ code: "INVALID_STATE" });
  const formal = { ...version,id: "formal",parentVersionId: version.id,status: "confirmed" as const };
  await repo.save(actor,formal,version.id);await repo.save(actor,{ ...version,id: "revision",parentVersionId: formal.id },formal.id);
  const read = await handoff.read(actor,"p","c");assert.equal(read.version.id,formal.id);assert.deepEqual(read.sourceFragments,context.fragments);
  current = { ...context,sourceVersionId: "new-source" };await assert.rejects(() => handoff.read(actor,"p","c"),{ code: "INVALID_STATE" });
  await assert.rejects(() => handoff.read({ ...actor,workspaceId: "other" },"p","c"),{ code: "INVALID_STATE" });
});

test("T07 refuses incomplete knowledge and broken formal evidence instead of omitting upstream identities",async () => {
  const actor = { workspaceId: "w",userId: "owner" },repo = new InMemoryScriptContentRepository();
  await repo.save(actor,{ ...version,status: "confirmed",elements: version.elements.map(e => ({ ...e,provenance: [] })) },null);
  await assert.rejects(() => new ConfirmedScriptHandoff(repo,{ findGenerationContext: async () => context }).read(actor,"p","c"),{ code: "INVALID_STATE" });
  const { confirmedStoryKnowledge: _knowledge,...incomplete } = context;
  await assert.rejects(() => new ConfirmedScriptHandoff(repo,{ findGenerationContext: async () => incomplete }).read(actor,"p","c"),{ code: "INVALID_STATE" });
});
