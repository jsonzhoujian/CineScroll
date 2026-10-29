import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryScriptContentRepository } from "../src/script-content.ts";
import type { ScriptContentVersion } from "../src/script-content.ts";

const actor = { workspaceId: "studio", userId: "owner" };
const candidate: ScriptContentVersion = { id: "candidate", parentVersionId: null, projectId: "project", chapterId: "chapter",
  sourceVersionId: "source", planVersionId: "plan", jobId: "task", status: "candidate", generationStatus: "partially_succeeded",
  createdBy: "owner", createdAt: "2026-10-29T00:00:00Z", scenes: [], elements: [], failures: [{ scopeKey: "action",code: "INVALID_ELEMENT",message: "Invalid evidence",retryable: true }] };

test("persisted generation remains recoverable by task after the review head advances", async () => {
  const repository = new InMemoryScriptContentRepository();
  await repository.save(actor,candidate,null);
  await repository.save(actor,{ ...candidate,id: "edited",parentVersionId: candidate.id },candidate.id);
  assert.deepEqual(await repository.findGeneration(actor,"project","chapter","task"),candidate);
  assert.equal(await repository.findGeneration({ ...actor,workspaceId: "other" },"project","chapter","task"),null);
  assert.equal(await repository.findGeneration(actor,"project","different","task"),null);
});
