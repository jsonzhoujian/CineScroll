import assert from "node:assert/strict";
import test from "node:test";
import "reflect-metadata";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { HmacSessionManager } from "@novel-adaptation/identity";
import { InMemoryProjectImportRepository } from "@novel-adaptation/project-import";
import { WorkspaceModelSettings, InMemoryModelSettingsRepository } from "@novel-adaptation/script/model-settings";
import { ModelTaskService, InMemoryModelTaskRepository } from "@novel-adaptation/script/model-tasks";
import { StoryKnowledgeTaskContext } from "../src/story-knowledge-task-context.ts";
import { StoryKnowledgeTaskApiModule } from "../src/story-knowledge-task-api.ts";

test("故事知识任务从授权原文生成输入，不接受客户端版本；旧Key暂停后显式重提交", async () => {
  const owner = { userId: "owner", workspaceId: "w" };
  const projects = new InMemoryProjectImportRepository();
  await projects.saveProject(owner, { id: "p", workspaceId: "w", ownerUserId: "owner", members: [{ userId: "owner", role: "owner" }],
    title: "fixture", aspectRatio: "9:16", targetDurationSeconds: 180, narrativeMode: "narration", dataRegion: "CN", createdAt: "2026-10-05",
    chapters: [{ id: "c", title: "chapter", activeSourceVersionId: "source1", versions: [{ id: "source1", ordinal: 1, createdAt: "2026-10-05", createdBy: "owner", characterCount: 2, text: "雨落", fragments: [{ id: "f", ordinal: 1, startOffset: 0, endOffset: 2, text: "雨落", contentHash: "hash" }] }] }] });
  let version = 0, job = 0;
  const settings = new WorkspaceModelSettings({ repository: new InMemoryModelSettingsRepository(), encryptionKey: new Uint8Array(32).fill(7),
    access: { read: async actor => actor.userId === "owner" ? { owner: true, advanced: true } : null }, idGenerator: () => `v${++version}`,
    probe: { processingRegion: () => "mainland", test: async () => ({ modelIds: ["m"], processingRegion: "mainland" }) } });
  const saved = await settings.configure(owner, { expectedVersionId: null, providerId: "deepseek", apiKey: "fixture-key" });
  const tested = await settings.testConnection(owner, saved.id);
  const tasks = new ModelTaskService({ settings, repository: new InMemoryModelTaskRepository(), contextReader: new StoryKnowledgeTaskContext(projects), idGenerator: () => `j${++job}` });
  const sessions = new HmacSessionManager({ secret: "0123456789abcdef0123456789abcdef", resolveActor: async userId => ({ userId, workspaceId: "w" }) });
  const ref = await Test.createTestingModule({ imports: [StoryKnowledgeTaskApiModule.register({ sessionVerifier: sessions, tasks })] }).compile();
  const app = ref.createNestApplication(); await app.listen(0, "127.0.0.1");
  try {
    const http = request(app.getHttpServer()), bearer = `Bearer ${await sessions.issue("owner", "w")}`;
    const path = "/projects/p/chapters/c/story-knowledge-tasks";
    const selection = { configurationVersionId: tested.id, modelId: "m" };
    await http.post(path).send(selection).expect(401);
    await http.post(path).set("authorization", bearer).send({ ...selection, sourceVersionId: "forged" }).expect(400);
    await http.post(`/projects/${"p".repeat(257)}/chapters/c/story-knowledge-tasks`).set("authorization", bearer).send(selection).expect(400);
    await http.get(`/story-knowledge-tasks/${"j".repeat(257)}`).set("authorization", bearer).expect(400);
    await http.post(path).set("authorization", `Bearer ${await sessions.issue("outsider", "w")}`).send(selection).expect(404);
    const created = await http.post(path).set("authorization", bearer).send(selection).expect(201);
    assert.equal(created.body.input.stage, "story_knowledge"); assert.equal(created.body.input.sourceVersionId, "source1");
    assert.deepEqual(created.body.input.upstreamConfirmedVersionIds, []); assert.equal(created.body.state, "queued");
    assert.equal(created.headers["cache-control"], "no-store"); assert.ok(!JSON.stringify(created.body).includes("fixture-key"));
    await http.get(`/story-knowledge-tasks/${created.body.id}`).set("authorization", bearer).expect(200);
    const changed = await settings.configure(owner, { expectedVersionId: tested.id, providerId: "deepseek", apiKey: "new-fixture" });
    const next = await settings.testConnection(owner, changed.id);
    assert.equal((await tasks.run(owner, created.body.id, async () => { throw new Error("must not execute"); })).state, "paused");
    const child = await http.post(`/story-knowledge-tasks/${created.body.id}/resubmit`).set("authorization", bearer).send({ configurationVersionId: next.id, modelId: "m" }).expect(201);
    assert.deepEqual(child.body.input, created.body.input); assert.equal(child.body.parentTaskId, created.body.id);
    await http.post(`/story-knowledge-tasks/${created.body.id}/resubmit`).set("authorization", bearer).send({ configurationVersionId: next.id, modelId: "m" }).expect(409);
    await http.get(`/story-knowledge-tasks/${created.body.id}`).set("authorization", `Bearer ${await sessions.issue("outsider", "w")}`).expect(404);
  } finally { await app.close(); }
});
