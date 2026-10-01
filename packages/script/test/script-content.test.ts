import assert from "node:assert/strict";
import test from "node:test";
import { ScriptContentService, InMemoryScriptContentRepository } from "../src/script-content.ts";
import type { EpisodePlanVersion } from "../src/index.ts";

const confirmedPlan: EpisodePlanVersion = {
  id: "plan_confirmed", status: "confirmed", parentVersionId: null, projectId: "project_1", chapterId: "chapter_1", sourceVersionId: "source_1",
  storyBibleVersionId: "bible_1", targetDurationSeconds: 60, aspectRatio: "9:16", narrativeMode: "narration",
  createdBy: "owner", createdAt: "2026-10-01", confirmedBy: "owner", confirmedAt: "2026-10-01",
  majorAdaptationProposals: [], episodes: [{ id: "episode_1", ordinal: 1, title: "庭院", sourceFragmentIds: ["frag_1"], coreEventFactIds: ["fact_1"] }],
};
const scenes = [{ id: "scene_1", episodeId: "episode_1", ordinal: 1, title: "庭院", environment: "晨光", characters: ["少年"] }];

const actor = { userId: "owner", workspaceId: "studio" };

test("剧本候选保留有效内容与转换方式，错误出处形成局部失败", async () => {
  let sequence = 0;
  let role: "owner" | "editor" | "reviewer" = "owner";
  const service = new ScriptContentService({
    repository: new InMemoryScriptContentRepository(),
    accessReader: { async findProjectAccess() { return { role }; } },
    contextReader: { async findGenerationContext() { return {
      planVersionId: "plan_confirmed", sourceVersionId: "source_1",
      confirmedPlan,
      fragments: [{ id: "frag_1", text: "少年紧握双拳，压住心中的恐惧。" }], approvedAdditionIds: [],
    }; } },
    idGenerator: () => `script_${++sequence}`,
    clock: () => new Date("2026-10-01T10:00:00Z"),
  });
  const result = await service.recordGeneration(actor, {
    expectedActiveVersionId: null, projectId: "project_1", chapterId: "chapter_1",
    sourceVersionId: "source_1", planVersionId: "plan_confirmed", jobId: "job_1",
    scenes,
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
  const edited = await service.editElement(actor, "project_1", "chapter_1", {
    expectedActiveVersionId: result.id, elementId: "element_1", text: "少年双拳紧攥，指节发白。", reason: "强化可见表演",
  });
  assert.notEqual(edited.id, result.id);
  assert.equal(edited.parentVersionId, result.id);
  assert.equal(result.elements[0]?.text, "少年握紧双拳，手指微微发抖。");
  assert.deepEqual(edited.elements[0]?.provenance, result.elements[0]?.provenance);
  assert.deepEqual(edited.scenes, result.scenes);
  assert.deepEqual(edited.failures, result.failures);
  assert.equal(edited.generationStatus, "partially_succeeded");
  assert.equal(edited.elements[0]?.lastEdit?.editedBy, "owner");
  assert.equal(edited.elements[0]?.lastEdit?.editedAt, "2026-10-01T10:00:00.000Z");
  assert.equal(edited.elements[0]?.lastEdit?.reason, "强化可见表演");
  assert.equal(edited.elements[0]?.text, "少年双拳紧攥，指节发白。");
  role = "editor";
  await assert.rejects(() => service.editElement(actor, "project_1", "chapter_1", {
    expectedActiveVersionId: edited.id, elementId: "element_1", text: "无权限修改", reason: "测试",
  }), { code: "FORBIDDEN" });
  role = "reviewer";
  await assert.rejects(() => service.editElement(actor, "project_1", "chapter_1", {
    expectedActiveVersionId: edited.id, elementId: "element_1", text: " ", reason: "测试",
  }), { code: "INVALID_EDIT" });
  await assert.rejects(() => service.editElement(actor, "project_1", "chapter_1", {
    expectedActiveVersionId: edited.id, elementId: "missing", text: "测试", reason: "测试",
  }), { code: "ELEMENT_NOT_FOUND" });
  await assert.rejects(() => service.editElement(actor, "project_1", "chapter_1", {
    expectedActiveVersionId: result.id, elementId: "element_1", text: "迟到编辑", reason: "旧页面",
  }), { code: "VERSION_CONFLICT" });
  const reviewed = await service.editElement(actor, "project_1", "chapter_1", {
    expectedActiveVersionId: edited.id, elementId: "element_1", text: "少年攥紧双拳。", reason: "审核调整",
  });
  assert.equal(reviewed.parentVersionId, edited.id);
  assert.equal(reviewed.elements[0]?.text, "少年攥紧双拳。");
  role = "editor";
  const proposed = await service.submitSuggestion(actor, "project_1", "chapter_1", {
    expectedActiveVersionId: reviewed.id, elementId: "element_1", text: "少年缓缓松开拳头。", reason: "调整动作节奏",
  });
  assert.equal(proposed.elements[0]?.text, "少年攥紧双拳。");
  assert.equal(proposed.suggestions?.[0]?.status, "pending");
  await assert.rejects(() => service.decideSuggestion(actor, "project_1", "chapter_1", {
    expectedActiveVersionId: proposed.id, suggestionId: proposed.suggestions![0]!.id, decision: "accepted",
  }), { code: "FORBIDDEN" });
  role = "reviewer";
  const accepted = await service.decideSuggestion(actor, "project_1", "chapter_1", {
    expectedActiveVersionId: proposed.id, suggestionId: proposed.suggestions![0]!.id, decision: "accepted",
  });
  assert.equal(accepted.elements[0]?.text, "少年缓缓松开拳头。");
  assert.deepEqual(accepted.elements[0]?.provenance, result.elements[0]?.provenance);
  assert.equal(accepted.suggestions?.[0]?.status, "accepted");
  assert.deepEqual(await service.decideSuggestion(actor, "project_1", "chapter_1", {
    expectedActiveVersionId: proposed.id, suggestionId: proposed.suggestions![0]!.id, decision: "accepted",
  }), accepted);
  assert.equal(proposed.suggestions?.[0]?.status, "pending");
  const nextProposal = await service.submitSuggestion(actor, "project_1", "chapter_1", {
    expectedActiveVersionId: accepted.id, elementId: "element_1", text: "少年闭上双眼。", reason: "另一个建议",
  });
  role = "owner";
  const changed = await service.editElement(actor, "project_1", "chapter_1", {
    expectedActiveVersionId: nextProposal.id, elementId: "element_1", text: "少年抬头。", reason: "负责人修改",
  });
  await assert.rejects(() => service.decideSuggestion(actor, "project_1", "chapter_1", {
    expectedActiveVersionId: changed.id, suggestionId: nextProposal.suggestions![1]!.id, decision: "accepted",
  }), { code: "SUGGESTION_CONFLICT" });
  const rejected = await service.decideSuggestion(actor, "project_1", "chapter_1", {
    expectedActiveVersionId: changed.id, suggestionId: nextProposal.suggestions![1]!.id, decision: "rejected",
  });
  assert.equal(rejected.elements[0]?.text, "少年抬头。");
  assert.equal(rejected.suggestions?.[1]?.status, "rejected");
  assert.equal(rejected.suggestions?.[1]?.decidedBy, "owner");
  assert.deepEqual(await service.decideSuggestion(actor, "project_1", "chapter_1", {
    expectedActiveVersionId: changed.id, suggestionId: nextProposal.suggestions![1]!.id, decision: "rejected",
  }), rejected);
  await assert.rejects(() => service.decideSuggestion(actor, "project_1", "chapter_1", {
    expectedActiveVersionId: rejected.id, suggestionId: nextProposal.suggestions![1]!.id, decision: "accepted",
  }), { code: "SUGGESTION_CONFLICT" });
  await assert.rejects(() => service.submitSuggestion(actor, "project_1", "chapter_1", {
    expectedActiveVersionId: rejected.id, elementId: "element_1", text: "建议", reason: " ",
  }), { code: "INVALID_EDIT" });
  await assert.rejects(() => service.decideSuggestion(actor, "project_1", "chapter_1", {
    expectedActiveVersionId: rejected.id, suggestionId: "missing", decision: "rejected",
  }), { code: "SUGGESTION_NOT_FOUND" });
  await assert.rejects(() => service.submitSuggestion(actor, "project_1", "chapter_1", {
    expectedActiveVersionId: accepted.id, elementId: "element_1", text: "迟到建议", reason: "旧页面",
  }), { code: "VERSION_CONFLICT" });
  const competing = await Promise.allSettled(["建议一", "建议二"].map((text) => service.submitSuggestion(actor, "project_1", "chapter_1", {
    expectedActiveVersionId: rejected.id, elementId: "element_1", text, reason: "并发提交",
  })));
  assert.equal(competing.filter(({ status }) => status === "fulfilled").length, 1);
  const conflict = competing.find((item) => item.status === "rejected");
  assert.equal(conflict?.status === "rejected" ? conflict.reason.code : null, "VERSION_CONFLICT");
});

test("未确认方案禁止生成，新增仅接受批准标识，并发写入保留当前版本", async () => {
  const repository = new InMemoryScriptContentRepository();
  let available = false;
  let nextId = 0;
  const service = new ScriptContentService({
    repository,
    contextReader: { async findGenerationContext() { return available ? {
      planVersionId: "plan_confirmed", sourceVersionId: "source_1",
      confirmedPlan,
      fragments: [{ id: "frag_1", text: "少年起身。" }], approvedAdditionIds: ["addition_approved"],
    } : null; } },
    idGenerator: () => `script_${++nextId}`, clock: () => new Date("2026-10-01T10:00:00Z"),
  });
  const input = {
    expectedActiveVersionId: null, projectId: "project_1", chapterId: "chapter_1",
    sourceVersionId: "source_1", planVersionId: "plan_confirmed", jobId: "job_1",
    scenes,
    items: [{ scopeKey: "sound:1", value: { id: "element_1", sceneId: "scene_1", elementType: "sound", ordinal: 1,
      text: "远处响起钟声。", provenance: [{ type: "approved_addition", additionId: "addition_approved" }] } }],
  };
  await assert.rejects(() => service.recordGeneration(actor, input), { code: "CONTEXT_NOT_FOUND" });
  available = true;
  for (const invalidScenes of [
    [{ ...scenes[0]!, episodeId: "unknown_episode" }],
    [scenes[0]!, { ...scenes[0]!, ordinal: 2 }],
    [scenes[0]!, { ...scenes[0]!, id: "scene_2" }],
  ]) {
    await assert.rejects(() => service.recordGeneration(actor, { ...input, scenes: invalidScenes }), { code: "INVALID_GENERATION" });
    assert.equal(await repository.findActive(actor, "project_1", "chapter_1"), null);
  }
  const first = await service.recordGeneration(actor, input);
  assert.equal(first.generationStatus, "succeeded");
  await assert.rejects(() => service.editElement(actor, "project_1", "chapter_1", {
    expectedActiveVersionId: first.id, elementId: "element_1", text: "改写钟声", reason: "缺少权限读取器",
  }), { code: "FORBIDDEN" });
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
