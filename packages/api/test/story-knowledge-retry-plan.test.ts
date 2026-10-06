import assert from "node:assert/strict";
import test from "node:test";
import "reflect-metadata";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { HmacSessionManager } from "@novel-adaptation/identity";
import { InMemoryProjectImportRepository } from "@novel-adaptation/project-import";
import { InMemoryStoryKnowledgeRepository, StoryKnowledgeService } from "@novel-adaptation/story-knowledge";
import { StoryKnowledgeTaskApiModule } from "../src/story-knowledge-task-api.ts";
import type { ModelTaskService } from "@novel-adaptation/script/model-tasks";

test("局部重试准入从当前原文派生来源任务，不接受伪造上下文", async () => {
  const owner = { userId: "owner", workspaceId: "w" };
  const projects = new InMemoryProjectImportRepository();
  const project = { id: "p", workspaceId: "w", ownerUserId: "owner", members: [{ userId: "owner", role: "owner" as const },
    { userId: "editor", role: "editor" as const }, { userId: "reviewer", role: "reviewer" as const }], title: "作品",
    aspectRatio: "9:16" as const, targetDurationSeconds: 180 as const, narrativeMode: "narration" as const, dataRegion: "CN" as const, createdAt: "2026-10-06",
    chapters: [{ id: "c", title: "章节", activeSourceVersionId: "s", versions: [{ id: "s", ordinal: 1, createdAt: "2026-10-06", createdBy: "owner", characterCount: 2,
      text: "雨落", fragments: [{ id: "f", ordinal: 1, startOffset: 0, endOffset: 2, text: "雨落", contentHash: "hash" }] }] }] };
  await projects.saveProject(owner, project);
  let id = 0;
  const knowledge = new StoryKnowledgeService({ repository: new InMemoryStoryKnowledgeRepository(), projectAccessReader: projects,
    sourceReader: { async findSourceVersion(actor, p, c, s) {
      const chapter = await projects.findChapter(actor, p, c);
      const source = chapter?.versions.find(v => v.id === s);
      return source ? { id: source.id, fragmentIds: source.fragments.map(f => f.id) } : null;
    } }, idGenerator: () => `k${++id}`, clock: () => new Date("2026-10-06") });
  const candidate = await knowledge.recordExtraction(owner, { contractVersion: "0.1.0", jobId: "origin", stage: "storyKnowledge", projectId: "p", chapterId: "c", sourceVersionId: "s",
    status: "failed", items: [
      { scopeKey: "identity", status: "failed", error: { code: "UNKNOWN", message: "无法确定", retryable: true } },
      { scopeKey: "props", status: "failed", error: { code: "UNKNOWN", message: "道具待查", retryable: true } },
      { scopeKey: "weather", status: "failed", error: { code: "BLOCKED", message: "不可重试", retryable: false } },
    ] });
  const sessions = new HmacSessionManager({ secret: "0123456789abcdef0123456789abcdef", resolveActor: async userId => ({ userId, workspaceId: "w" }) });
  const ref = await Test.createTestingModule({ imports: [StoryKnowledgeTaskApiModule.register({ sessionVerifier: sessions, tasks: {} as ModelTaskService,
    retryPlanning: { projects, storyKnowledge: knowledge } })] }).compile();
  const app = ref.createNestApplication(); await app.listen(0, "127.0.0.1");
  try {
    const http = request(app.getHttpServer()), path = "/projects/p/chapters/c/story-knowledge-tasks/retry-plan";
    const auth = { authorization: `Bearer ${await sessions.issue("owner", "w")}` };
    const input = { expectedActiveVersionId: candidate.id, scopeKeys: ["identity"] };
    await http.post(path).send(input).expect(401);
    await http.post(path).set("authorization", `Bearer ${await sessions.issue("outsider", "w")}`).send(input).expect(404);
    const planned = await http.post(path).set(auth).send(input).expect(201);
    assert.deepEqual(planned.body, { projectId: "p", chapterId: "c", expectedActiveVersionId: candidate.id, sourceVersionId: "s", retryOfJobId: "origin", scopeKeys: ["identity"] });
    assert.equal(planned.headers["cache-control"], "no-store");
    for (const member of ["editor", "reviewer"]) {
      const allowed = await http.post(path).set("authorization", `Bearer ${await sessions.issue(member, "w")}`).send(input).expect(201);
      assert.deepEqual(allowed.body, planned.body);
    }
    for (const scopeKeys of [[], ["identity", "identity"], ["weather"], ["missing"]]) await http.post(path).set(auth).send({ ...input, scopeKeys }).expect(400);
    await http.post(path).set(auth).send({ ...input, retryOfJobId: "forged" }).expect(400);
    await http.post(path).set(auth).send({ ...input, expectedActiveVersionId: "old" }).expect(409);
    assert.equal((await knowledge.getActive(owner, "p", "c")).id, candidate.id);
    const retried = await knowledge.recordRetry(owner, "p", "c", { expectedActiveVersionId: candidate.id, retryOfJobId: "origin",
      extraction: { contractVersion: "0.1.0", jobId: "retry-origin", stage: "storyKnowledge", projectId: "p", chapterId: "c", sourceVersionId: "s", status: "failed",
        items: [{ scopeKey: "identity", status: "failed", error: { code: "UNKNOWN", message: "仍不确定", retryable: true } }] } });
    await http.post(path).set(auth).send(input).expect(409);
    await http.post(path).set(auth).send({ expectedActiveVersionId: retried.id, scopeKeys: ["identity", "props"] }).expect(400);
    const replanned = await http.post(path).set(auth).send({ ...input, expectedActiveVersionId: retried.id }).expect(201);
    assert.equal(replanned.body.retryOfJobId, "retry-origin");
    project.chapters[0]!.activeSourceVersionId = "new-source";
    await projects.saveProject(owner, project);
    const stale = await http.post(path).set(auth).send({ ...input, expectedActiveVersionId: retried.id }).expect(409);
    assert.equal(stale.body.code, "UPSTREAM_CHANGED");
  } finally { await app.close(); }
});
