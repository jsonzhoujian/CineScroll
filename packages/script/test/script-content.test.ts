import assert from "node:assert/strict";
import test from "node:test";
import { ScriptContentService, InMemoryScriptContentRepository } from "../src/script-content.ts";

const actor = { userId: "owner", workspaceId: "studio" };

test("剧本候选保留有效内容与转换方式，错误出处形成局部失败", async () => {
  const service = new ScriptContentService({
    repository: new InMemoryScriptContentRepository(),
    contextReader: { async findGenerationContext() { return {
      planVersionId: "plan_confirmed", sourceVersionId: "source_1",
      fragments: [{ id: "frag_1", text: "少年紧握双拳，压住心中的恐惧。" }], approvedAdditionIds: [],
    }; } },
    idGenerator: () => "script_1",
    clock: () => new Date("2026-10-01T10:00:00Z"),
  });
  const result = await service.recordGeneration(actor, {
    expectedActiveVersionId: null, projectId: "project_1", chapterId: "chapter_1",
    sourceVersionId: "source_1", planVersionId: "plan_confirmed", jobId: "job_1",
    items: [
      { scopeKey: "scene:1/action:1", value: { id: "element_1", sceneId: "scene_1", elementType: "action", ordinal: 1,
        text: "少年握紧双拳，手指微微发抖。", provenance: [{ type: "source_fragment", sourceVersionId: "source_1", fragmentId: "frag_1", transformation: "actionized" }] } },
      { scopeKey: "scene:1/dialogue:1", value: { id: "element_2", sceneId: "scene_1", elementType: "dialogue", ordinal: 2,
        text: "我必定成为天下第一。", provenance: [] } },
    ],
  });
  assert.equal(result.status, "candidate");
  assert.equal(result.generationStatus, "partially_succeeded");
  assert.deepEqual(result.elements.map(({ id }) => id), ["element_1"]);
  assert.deepEqual(result.failures.map(({ scopeKey }) => scopeKey), ["scene:1/dialogue:1"]);
  assert.deepEqual(await service.getElementEvidence(actor, "project_1", "chapter_1", "element_1"), [
    { id: "frag_1", text: "少年紧握双拳，压住心中的恐惧。", transformation: "actionized" },
  ]);
});

test("未确认方案禁止生成，新增仅接受批准标识，并发写入保留当前版本", async () => {
  const repository = new InMemoryScriptContentRepository();
  let available = false;
  let nextId = 0;
  const service = new ScriptContentService({
    repository,
    contextReader: { async findGenerationContext() { return available ? {
      planVersionId: "plan_confirmed", sourceVersionId: "source_1",
      fragments: [{ id: "frag_1", text: "少年起身。" }], approvedAdditionIds: ["addition_approved"],
    } : null; } },
    idGenerator: () => `script_${++nextId}`, clock: () => new Date("2026-10-01T10:00:00Z"),
  });
  const input = {
    expectedActiveVersionId: null, projectId: "project_1", chapterId: "chapter_1",
    sourceVersionId: "source_1", planVersionId: "plan_confirmed", jobId: "job_1",
    items: [{ scopeKey: "sound:1", value: { id: "element_1", sceneId: "scene_1", elementType: "sound", ordinal: 1,
      text: "远处响起钟声。", provenance: [{ type: "approved_addition", additionId: "addition_approved" }] } }],
  };
  await assert.rejects(() => service.recordGeneration(actor, input), { code: "CONTEXT_NOT_FOUND" });
  available = true;
  const first = await service.recordGeneration(actor, input);
  assert.equal(first.generationStatus, "succeeded");
  await assert.rejects(() => service.recordGeneration(actor, input), { code: "VERSION_CONFLICT" });
  const invalid = await service.recordGeneration(actor, { ...input, expectedActiveVersionId: first.id,
    items: [{ scopeKey: "sound:1", value: { ...input.items[0]!.value,
      provenance: [{ type: "approved_addition", additionId: "addition_pending" }] } }],
  });
  assert.equal(invalid.generationStatus, "failed");
  assert.equal(invalid.elements.length, 0);
  const malformed = await service.recordGeneration(actor, { ...input, expectedActiveVersionId: invalid.id,
    items: [{ scopeKey: "sound:1", value: { ...input.items[0]!.value,
      elementType: ["sound"], provenance: [{ type: "approved_addition", additionId: ["addition_approved"] }] } }],
  });
  assert.equal(malformed.generationStatus, "failed");
  assert.equal(await repository.findActive({ userId: "other", workspaceId: "other_studio" }, "project_1", "chapter_1"), null);
});
