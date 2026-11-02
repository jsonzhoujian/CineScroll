import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryScriptContentRepository } from "../src/script-content.ts";
import { version } from "./script-quality-fixture.ts";
test("revision candidates preserve the confirmed pointer and immutable historical snapshots",async () => {
  const actor = { userId: "owner",workspaceId: "w" },repo = new InMemoryScriptContentRepository();
  const formal = { ...version,status: "confirmed" as const };
  await repo.save(actor,formal,null);
  await repo.save(actor,{ ...version,id: "revision",parentVersionId: formal.id },formal.id);
  assert.equal((await repo.findActive(actor,"p","c"))?.id,"revision");
  assert.deepEqual(await repo.findConfirmed(actor,"p","c"),formal);
  assert.deepEqual(await repo.findVersion(actor,"p","c",formal.id),formal);
  assert.equal(await repo.findVersion({ ...actor,workspaceId: "other" },"p","c",formal.id),null);
});
