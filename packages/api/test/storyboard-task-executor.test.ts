import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryModelTaskRepository, ModelTaskService } from "@novel-adaptation/script/model-tasks";
import { InMemoryModelSettingsRepository, WorkspaceModelSettings } from "@novel-adaptation/script/model-settings";
import type { ConfirmedStoryboardHandoff } from "@novel-adaptation/script/storyboard-handoff";
import type { StoryboardCandidate } from "@novel-adaptation/script/storyboard-runner";
import fixture from "../../../docs/contracts/fixtures/ai/valid-storyboard.json" with { type: "json" };
import { context, version } from "../../script/test/script-quality-fixture.ts";
import { StoryboardTaskExecutor, storyboardTaskContext } from "../src/storyboard-task-executor.ts";

test("storyboard executor claims once and reconciles an ambiguous save from the original result", async () => {
  const actor = { userId: "owner", workspaceId: "studio" };
  const { projectId, chapterId, sourceVersionId } = fixture;
  const ids = ["cv_ss1", "cv_st1", "plan", "bible"];
  const handoff: Pick<ConfirmedStoryboardHandoff, "read"> = { async read() {
    return {
      sourceVersionId, upstreamConfirmedVersionIds: ids,
      script: { version, sourceFragments: context.fragments, upstreamConfirmedVersionIds: ids.slice(2) },
      settings: {
        projectId, chapterId, sourceVersionId, upstreamConfirmedVersionIds: [ids[0]!, ...ids.slice(2)],
        id: ids[1]!, jobId: "settings-job", scriptVersionId: ids[0]!, status: "confirmed",
        assets: [], failures: [], generationStatus: "succeeded", createdBy: actor.userId,
        createdAt: "2026-11-07", parentVersionId: null, suggestions: [], locks: {},
      },
      context: {
        sourceVersionId, scenes: [{ id: "scene_s1", episodeId: "ep_s1", scriptElementIds: ["se_s1"] }],
        assetIds: ["asset_s1"], fragmentIds: ["frag_s1"], approvedAdditionIds: [],
      },
    };
  } };
  const reader = storyboardTaskContext({
    canRead: async a => a.workspaceId === actor.workspaceId,
    read: async () => ({
      stage: "script", resultType: "scriptContent", sourceVersionId, upstreamConfirmedVersionIds: ids.slice(2),
      generationParameters: { targetDurationSeconds: 60, aspectRatio: "9:16", narrativeMode: "dialogue" },
    }),
  }, handoff);
  let sequence = 0;
  const settings = new WorkspaceModelSettings({
    repository: new InMemoryModelSettingsRepository(), encryptionKey: new Uint8Array(32).fill(7),
    access: { read: async () => ({ owner: true, advanced: true }) }, idGenerator: () => `version-${++sequence}`,
    probe: { processingRegion: () => "mainland", test: async () => ({ modelIds: ["model"], processingRegion: "mainland" }) },
  });
  const config = await settings.configure(actor, { expectedVersionId: null, providerId: "deepseek", apiKey: "fixture-key" });
  const tested = await settings.testConnection(actor, config.id);
  const tasks = new ModelTaskService({
    settings, contextReader: reader, generationPolicy: { isAllowed: async () => true },
    repository: new InMemoryModelTaskRepository(Date.now, () => ({ maxQueued: 10, maxExecuting: 10 })),
    storyboardAdmission: { workspaceIds: [actor.workspaceId], providerIds: ["deepseek"] }, idGenerator: () => `task-${++sequence}`,
  });
  const task = await tasks.submitStoryboard(actor, { projectId, chapterId, configurationVersionId: tested.id, modelId: "model", requestId: "original" });
  let persisted: StoryboardCandidate | null = null;
  let calls = 0;
  const executor = new StoryboardTaskExecutor({
    tasks, handoff, context: reader,
    repository: {
      async findGeneration() { return persisted; },
      async saveGeneration(_actor, candidate) { persisted = candidate; throw new Error("commit response lost"); },
    },
    model: { async generate(request) {
      calls++;
      return { ...fixture, jobId: request.jobId, upstreamConfirmedVersionIds: request.upstreamConfirmedVersionIds };
    } },
  });
  await assert.rejects(() => executor.run({ ...actor, userId: "other" }, task.id), { code: "TASK_NOT_FOUND" });
  const outcomes = await Promise.allSettled([executor.run(actor, task.id), executor.run(actor, task.id)]);
  const completed = outcomes.find(outcome => outcome.status === "fulfilled");
  assert.equal(completed?.value.reason, "EXECUTION_UNCERTAIN");
  assert.equal(outcomes.filter(outcome => outcome.status === "rejected").length, 1);
  const recovered = await executor.recover(actor, task.id);
  assert.deepEqual(recovered.result, { candidateVersionId: task.id, extractionStatus: "succeeded" });
  assert.equal(recovered.state, "succeeded");
  assert.equal(calls, 1);
});
