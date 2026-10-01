import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryScriptRepository, ScriptService } from "../src/index.ts";
import {
  EpisodePlanModelError,
  EpisodePlanRunner,
  type EpisodePlanGenerationRequest,
  type EpisodePlanModelPort,
} from "../src/episode-plan-runner.ts";

const actor = { userId: "usr_editor", workspaceId: "wsp_studio" } as const;

test("AI 根据不可变原文与故事事实生成可追溯拆集建议", async () => {
  const repository = new InMemoryScriptRepository();
  const calls: EpisodePlanGenerationRequest[] = [];
  const model: EpisodePlanModelPort = {
    async generate(request) {
      assert.equal(Object.isFrozen(request), true);
      assert.equal(Object.isFrozen(request.input.sourceFragments), true);
      calls.push(structuredClone(request));
      return {
        contractVersion: "0.1.0",
        jobId: request.jobId,
        stage: "script",
        resultType: "episodePlan",
        projectId: request.projectId,
        chapterId: request.chapterId,
        sourceVersionId: request.sourceVersionId,
        upstreamConfirmedVersionIds: request.upstreamConfirmedVersionIds,
        status: "succeeded",
        recommendationRationale: "觉醒与离乡形成两个独立情绪峰值，建议拆为两集。",
        episodes: [
          {
            id: "episode_1", ordinal: 1, title: "灵纹初醒",
            sourceFragmentIds: ["frag_1", "frag_2"], coreEventFactIds: ["fact_awaken"],
          },
          {
            id: "episode_2", ordinal: 2, title: "踏上旅途",
            sourceFragmentIds: ["frag_3"], coreEventFactIds: ["fact_departure"],
          },
        ],
        majorAdaptationProposals: [{
          id: "proposal_merge", kind: "merge_characters",
          summary: "合并两名引路人", rationale: "减少短时长内的新人物负担",
          affectedFactIds: ["fact_departure"],
        }],
      };
    },
  };
  const runner = new EpisodePlanRunner({ model, script: scriptService(repository) });

  const result = await runner.run(actor, generationRequest(), null);

  assert.deepEqual(calls, [generationRequest()]);
  assert.equal(result.status, "candidate");
  assert.equal(result.recommendationRationale, "觉醒与离乡形成两个独立情绪峰值，建议拆为两集。");
  assert.deepEqual(result.episodes.map(({ id, sourceFragmentIds, coreEventFactIds }) => ({ id, sourceFragmentIds, coreEventFactIds })), [
    { id: "episode_1", sourceFragmentIds: ["frag_1", "frag_2"], coreEventFactIds: ["fact_awaken"] },
    { id: "episode_2", sourceFragmentIds: ["frag_3"], coreEventFactIds: ["fact_departure"] },
  ]);
  assert.equal(result.majorAdaptationProposals[0]?.decision, undefined);
  assert.equal((await repository.findActiveEpisodePlan(actor, "project_1", "chapter_1"))?.id, result.id);
});

test("模型供应商故障被归一化且不会创建候选方案", async () => {
  const repository = new InMemoryScriptRepository();
  const runner = new EpisodePlanRunner({
    script: scriptService(repository),
    model: {
      async generate() {
        throw new Error("provider timeout: secret-key-should-not-leak");
      },
    },
  });

  await assert.rejects(
    () => runner.run(actor, generationRequest(), null),
    (error) => error instanceof EpisodePlanModelError
      && error.code === "PROVIDER_UNAVAILABLE"
      && !error.message.includes("secret-key-should-not-leak"),
  );
  assert.equal(await repository.findActiveEpisodePlan(actor, "project_1", "chapter_1"), null);
});

test("任务错配或引用不存在证据的响应不会污染活动方案", async () => {
  for (const mutate of [
    (response: Record<string, unknown>) => ({ ...response, projectId: "project_other" }),
    (response: Record<string, unknown>) => ({
      ...response,
      episodes: [{
        id: "episode_1", ordinal: 1, title: "伪造内容",
        sourceFragmentIds: ["frag_unknown"], coreEventFactIds: ["fact_awaken"],
      }],
    }),
  ]) {
    const repository = new InMemoryScriptRepository();
    const runner = new EpisodePlanRunner({
      script: scriptService(repository),
      model: {
        async generate(request) {
          const valid = {
            contractVersion: "0.1.0", jobId: request.jobId, stage: "script", resultType: "episodePlan",
            projectId: request.projectId, chapterId: request.chapterId, sourceVersionId: request.sourceVersionId,
            upstreamConfirmedVersionIds: [...request.upstreamConfirmedVersionIds], status: "succeeded",
            recommendationRationale: "单一核心事件适合一集完成。",
            episodes: [{ id: "episode_1", ordinal: 1, title: "觉醒", sourceFragmentIds: ["frag_1"], coreEventFactIds: ["fact_awaken"] }],
            majorAdaptationProposals: [],
          };
          return mutate(valid);
        },
      },
    });

    await assert.rejects(() => runner.run(actor, generationRequest(), null), {
      name: "EpisodePlanModelError", code: "INVALID_RESPONSE",
    });
    assert.equal(await repository.findActiveEpisodePlan(actor, "project_1", "chapter_1"), null);
  }
});

test("模型只能引用本次不可变快照中的原文和核心事件", async () => {
  const repository = new InMemoryScriptRepository();
  const restrictedRequest: EpisodePlanGenerationRequest = {
    ...generationRequest(),
    input: {
      ...generationRequest().input,
      sourceFragments: [{ id: "frag_1", text: "少年额间灵纹骤亮。" }],
      confirmedUpstreamContent: [
        { id: "fact_awaken", factType: "event", statement: "少年觉醒灵纹", isCoreEvent: true },
        { id: "fact_companion", factType: "character", statement: "墨白是少年同伴", isCoreEvent: false },
      ],
    },
  };
  const runner = new EpisodePlanRunner({
    script: scriptService(repository),
    model: {
      async generate(request) {
        return {
          contractVersion: "0.1.0", jobId: request.jobId, stage: "script", resultType: "episodePlan",
          projectId: request.projectId, chapterId: request.chapterId, sourceVersionId: request.sourceVersionId,
          upstreamConfirmedVersionIds: [...request.upstreamConfirmedVersionIds], status: "succeeded",
          recommendationRationale: "尝试引用快照外内容。",
          episodes: [{
            id: "episode_1", ordinal: 1, title: "错误建议",
            sourceFragmentIds: ["frag_2"], coreEventFactIds: ["fact_companion"],
          }],
          majorAdaptationProposals: [],
        };
      },
    },
  });

  await assert.rejects(() => runner.run(actor, restrictedRequest, null), {
    name: "EpisodePlanModelError", code: "INVALID_RESPONSE",
  });
  assert.equal(await repository.findActiveEpisodePlan(actor, "project_1", "chapter_1"), null);
});

test("重复回调返回同一候选版本，重复集标识被拒绝", async () => {
  const repository = new InMemoryScriptRepository();
  let duplicateIds = false;
  const model: EpisodePlanModelPort = {
    async generate(request) {
      const episodes = [{ id: "episode_1", ordinal: 1, title: "觉醒与离乡", sourceFragmentIds: ["frag_1", "frag_3"], coreEventFactIds: ["fact_awaken", "fact_departure"] }];
      if (duplicateIds) episodes.push({ id: "episode_1", ordinal: 2, title: "离乡", sourceFragmentIds: ["frag_3"], coreEventFactIds: ["fact_departure"] });
      return {
        contractVersion: "0.1.0", jobId: request.jobId, stage: "script", resultType: "episodePlan",
        projectId: request.projectId, chapterId: request.chapterId, sourceVersionId: request.sourceVersionId,
        upstreamConfirmedVersionIds: [...request.upstreamConfirmedVersionIds], status: "succeeded",
        recommendationRationale: "按情绪峰值拆分。", episodes, majorAdaptationProposals: [],
      };
    },
  };
  const runner = new EpisodePlanRunner({ script: scriptService(repository), model });

  const first = await runner.run(actor, generationRequest(), null);
  const replayed = await runner.run(actor, generationRequest(), null);
  assert.equal(replayed.id, first.id);

  duplicateIds = true;
  const anotherRepository = new InMemoryScriptRepository();
  const duplicateRunner = new EpisodePlanRunner({ model, script: scriptService(anotherRepository) });
  await assert.rejects(() => duplicateRunner.run(actor, { ...generationRequest(), jobId: "job_duplicate" }, null), {
    name: "EpisodePlanModelError", code: "INVALID_RESPONSE",
  });
});

test("合并人物可引用快照人物事实，但核心事件遗漏必须拒绝", async () => {
  const request = generationRequest();
  const repository = new InMemoryScriptRepository();
  let omitEvent = false;
  const runner = new EpisodePlanRunner({
    script: scriptService(repository),
    model: { async generate(input) {
      return {
        contractVersion: "0.1.0", jobId: input.jobId, stage: "script", resultType: "episodePlan",
        projectId: input.projectId, chapterId: input.chapterId, sourceVersionId: input.sourceVersionId,
        upstreamConfirmedVersionIds: [...input.upstreamConfirmedVersionIds], status: "succeeded",
        recommendationRationale: "合并功能相近的人物，保留全部核心事件。",
        episodes: [{ id: "episode_1", ordinal: 1, title: "觉醒与离乡", sourceFragmentIds: ["frag_1", "frag_3"],
          coreEventFactIds: omitEvent ? ["fact_awaken"] : ["fact_awaken", "fact_departure"] }],
        majorAdaptationProposals: [{ id: "proposal_1", kind: "merge_characters", summary: "合并引路人", rationale: "降低人物负担", affectedFactIds: ["fact_companion"] }],
      };
    } },
  });
  const withCharacter: EpisodePlanGenerationRequest = { ...request, input: { ...request.input,
    confirmedUpstreamContent: [...request.input.confirmedUpstreamContent,
      { id: "fact_companion", factType: "character", statement: "墨白是同伴", isCoreEvent: false }],
  } };
  const result = await runner.run(actor, withCharacter, null);
  assert.deepEqual(result.majorAdaptationProposals[0]?.affectedFactIds, ["fact_companion"]);
  omitEvent = true;
  await assert.rejects(() => runner.run(actor, { ...withCharacter, jobId: "job_omitted" }, result.id),
    { code: "INVALID_RESPONSE" });
  assert.equal((await repository.findActiveEpisodePlan(actor, "project_1", "chapter_1"))?.id, result.id);
});

function scriptService(repository: InMemoryScriptRepository): ScriptService {
  return new ScriptService({
    repository,
    accessReader: { async findProjectAccess() { return { role: "editor" }; } },
    upstreamReader: {
      async findConfirmedStoryBible() {
        return {
          versionId: "story_bible_v1", sourceVersionId: "source_v1",
          factIds: ["fact_awaken", "fact_departure", "fact_companion"],
          fragmentIds: ["frag_1", "frag_2", "frag_3"],
        };
      },
    },
    idGenerator: () => "plan_generated_1",
    clock: () => new Date("2026-10-01T09:00:00.000Z"),
  });
}

function generationRequest(): EpisodePlanGenerationRequest {
  return {
    contractVersion: "0.1.0", jobId: "job_plan_1", stage: "script",
    projectId: "project_1", chapterId: "chapter_1", sourceVersionId: "source_v1",
    upstreamConfirmedVersionIds: ["story_bible_v1"], scopeKeys: ["episode-plan"],
    generationParameters: { targetDurationSeconds: 180, aspectRatio: "9:16", narrativeMode: "narration" },
    input: {
      sourceFragments: [
        { id: "frag_1", text: "少年额间灵纹骤亮。" },
        { id: "frag_2", text: "众人惊呼。" },
        { id: "frag_3", text: "少年辞别故土。" },
      ],
      confirmedUpstreamContent: [
        { id: "fact_awaken", factType: "event", statement: "少年觉醒灵纹", isCoreEvent: true },
        { id: "fact_departure", factType: "event", statement: "少年离开故乡", isCoreEvent: true },
      ],
      approvedAdditionIds: [], lockedItemIds: [],
    },
  };
}
