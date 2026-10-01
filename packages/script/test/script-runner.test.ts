import assert from "node:assert/strict";
import test from "node:test";
import { ScriptRunner } from "../src/script-runner.ts";
import { ScriptContentService, InMemoryScriptContentRepository } from "../src/script-content.ts";
import type { EpisodePlanVersion } from "../src/index.ts";

test("剧本运行器先读取授权确认上下文，保留模型局部失败和有效出处", async () => {
  const contextReader = { async findGenerationContext() { return {
    sourceVersionId: "source_1", planVersionId: "plan_1",
    confirmedStoryKnowledge: { versionId: "bible_1", facts: [{ id: "fact_1", statement: "少年握拳" }] },
    fragments: [{ id: "frag_1", text: "少年握拳。" }], approvedAdditionIds: [],
    confirmedPlan: { id: "plan_1", status: "confirmed", projectId: "project_1", chapterId: "chapter_1", sourceVersionId: "source_1",
      parentVersionId: null, storyBibleVersionId: "bible_1", targetDurationSeconds: 60, aspectRatio: "9:16", narrativeMode: "narration",
      episodes: [{ id: "episode_1", ordinal: 1, title: "握拳", sourceFragmentIds: ["frag_1"], coreEventFactIds: ["fact_1"] }],
      majorAdaptationProposals: [], createdBy: "owner", createdAt: "2026-10-01", confirmedBy: "owner", confirmedAt: "2026-10-01",
    } satisfies EpisodePlanVersion,
  }; } };
  const repository = new InMemoryScriptContentRepository();
  const service = new ScriptContentService({ repository, contextReader, idGenerator: () => "script_1", clock: () => new Date("2026-10-01") });
  const runner = new ScriptRunner({ contextReader, service, model: { async generate(request) {
    assert.equal(Object.isFrozen(request.input.sourceFragments), true);
    assert.equal(request.input.confirmedUpstreamContent.length, 2);
    return { contractVersion: "0.1.0", jobId: request.jobId, stage: "script", projectId: request.projectId,
      chapterId: request.chapterId, sourceVersionId: request.sourceVersionId,
      scenes: [{ id: "scene_1", episodeId: "episode_1", ordinal: 1, title: "庭院·清晨", environment: "晨雾笼罩庭院", characters: ["少年"] }],
      upstreamConfirmedVersionIds: ["plan_1", "bible_1"], status: "partially_succeeded", items: [
        { scopeKey: "action:1", status: "succeeded", value: { id: "element_1", sceneId: "scene_1", elementType: "action", ordinal: 1,
          text: "少年握紧双拳。", provenance: [{ type: "source_fragment", sourceVersionId: "source_1", fragmentId: "frag_1", transformation: "actionized" }] } },
        { scopeKey: "dialogue:1", status: "failed", error: { code: "TIMEOUT", message: "生成超时", retryable: true } },
        { scopeKey: "action:2", status: "succeeded", value: null },
        { scopeKey: "action:3", status: "succeeded", value: { id: "orphan", sceneId: "scene_missing", elementType: "action", ordinal: 1,
          text: "少年起身。", provenance: [{ type: "source_fragment", sourceVersionId: "source_1", fragmentId: "frag_1", transformation: "actionized" }] } },
      ] };
  } } });
  const result = await runner.run({ userId: "owner", workspaceId: "studio" }, {
    projectId: "project_1", chapterId: "chapter_1", jobId: "job_1", expectedActiveVersionId: null,
    generationParameters: { targetDurationSeconds: 60, aspectRatio: "9:16", narrativeMode: "narration" },
  });
  assert.equal(result.generationStatus, "partially_succeeded");
  assert.equal(result.elements[0]?.id, "element_1");
  assert.deepEqual(result.scenes, [{ id: "scene_1", episodeId: "episode_1", ordinal: 1, title: "庭院·清晨", environment: "晨雾笼罩庭院", characters: ["少年"] }]);
  assert.deepEqual(result.failures, [
    { scopeKey: "dialogue:1", code: "TIMEOUT", message: "生成超时", retryable: true },
    { scopeKey: "action:2", code: "INVALID_ELEMENT", message: "剧本条目结构或出处无效", retryable: true },
    { scopeKey: "action:3", code: "INVALID_ELEMENT", message: "剧本条目结构或出处无效", retryable: true },
  ]);
});

test("未授权或未确认项目在模型调用前被拒绝", async () => {
  let calls = 0;
  const contextReader = { async findGenerationContext() { return null; } };
  const service = new ScriptContentService({ repository: new InMemoryScriptContentRepository(), contextReader,
    idGenerator: () => "unexpected", clock: () => new Date("2026-10-01") });
  const runner = new ScriptRunner({ service, contextReader, model: { async generate() { calls++; return {}; } } });
  await assert.rejects(() => runner.run({ userId: "other", workspaceId: "other" }, {
    projectId: "project_1", chapterId: "chapter_1", jobId: "job_1", expectedActiveVersionId: null,
    generationParameters: { targetDurationSeconds: 60, aspectRatio: "9:16", narrativeMode: "narration" },
  }), { code: "CONTEXT_NOT_FOUND" });
  assert.equal(calls, 0);
});
