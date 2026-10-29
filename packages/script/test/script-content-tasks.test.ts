import assert from "node:assert/strict";
import test from "node:test";
import { WorkspaceModelSettings, InMemoryModelSettingsRepository } from "../src/model-settings.ts";
import { ModelTaskService, InMemoryModelTaskRepository } from "../src/model-tasks.ts";

async function fixture() {
  const actor = { userId: "owner",workspaceId: "studio" };
  let seq = 0;
  const settings = new WorkspaceModelSettings({ repository: new InMemoryModelSettingsRepository(),encryptionKey: new Uint8Array(32).fill(7),
    access: { read: async () => ({ owner: true,advanced: true }) },idGenerator: () => `config-${++seq}`,
    probe: { processingRegion: () => "mainland",test: async () => ({ modelIds: ["model"],processingRegion: "mainland" }) } });
  const config = await settings.configure(actor,{ expectedVersionId: null,providerId: "deepseek",apiKey: "fixture-key" });
  const tested = await settings.testConnection(actor,config.id);
  const repository = new InMemoryModelTaskRepository(Date.now,() => ({ maxQueued: 10,maxExecuting: 10 }));
  const context = { stage: "script" as const,resultType: "scriptContent" as const,sourceVersionId: "source",upstreamConfirmedVersionIds: ["plan","bible"],
    generationParameters: { targetDurationSeconds: 60 as const,aspectRatio: "9:16" as const,narrativeMode: "dialogue" as const } };
  const options = { settings,repository,contextReader: { read: async () => structuredClone(context),canRead: async (a: typeof actor) => a.workspaceId === actor.workspaceId },
    generationPolicy: { isAllowed: async () => true },idGenerator: () => `task-${++seq}` };
  const input = { projectId: "p",chapterId: "c",configurationVersionId: tested.id,modelId: "model",requestId: "request" };
  return { actor,input,options,repository,context };
}
test("script generation is default-off, request-idempotent and independently discoverable",async () => {
  const f = await fixture();
  await assert.rejects(() => new ModelTaskService(f.options).submitScriptContent(f.actor,f.input),{ code: "WORKSPACE_TASK_DISABLED" });
  const admission = { workspaceIds: ["studio"],providerIds: ["deepseek"] };
  const tasks = new ModelTaskService({ ...f.options,scriptAdmission: admission });
  admission.workspaceIds.length = 0;
  const [a,b] = await Promise.all([tasks.submitScriptContent(f.actor,f.input),tasks.submitScriptContent(f.actor,f.input)]);
  assert.equal(a.id,b.id);
  assert.deepEqual((await f.repository.scanScriptContent("studio","run",{ limit: 20,cursor: null })).tasks.map(t => t.id),[a.id]);
  assert.equal((await f.repository.scanEpisodePlans("studio","run",{ limit: 20,cursor: null })).tasks.length,0);
  await assert.rejects(() => tasks.submitScriptContent(f.actor,{ ...f.input,modelId: "other" }),{ code: "STATE_CONFLICT" });
  const disabled = new ModelTaskService(f.options);
  const outcome = await disabled.run(f.actor,a.id,async () => { assert.fail("disabled task must not invoke provider"); });
  assert.equal(outcome.state,"paused");
});
