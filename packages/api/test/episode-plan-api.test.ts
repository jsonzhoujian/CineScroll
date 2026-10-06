import assert from "node:assert/strict";
import test from "node:test";
import "reflect-metadata";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { HmacSessionManager } from "@novel-adaptation/identity";
import { InMemoryProjectImportRepository } from "@novel-adaptation/project-import";
import { InMemoryStoryKnowledgeRepository, StoryKnowledgeService } from "@novel-adaptation/story-knowledge";
import { InMemoryScriptRepository, ScriptService } from "@novel-adaptation/script";
import { EpisodePlanApiModule, EpisodePlanUpstreamReader } from "../src/episode-plan-api.ts";

test("拆集API通过认证读取证据、逐项裁决及确认，旧原文拒绝写入", async () => {
  const owner = { userId: "owner", workspaceId: "w" }, projects = new InMemoryProjectImportRepository();
  const project = { id: "p", workspaceId: "w", ownerUserId: "owner", title: "雨落", aspectRatio: "9:16" as const, targetDurationSeconds: 60 as const, narrativeMode: "dialogue" as const, dataRegion: "CN" as const, createdAt: "2026-10-06",
    members: [{ userId: "owner", role: "owner" as const }, { userId: "editor", role: "editor" as const }, { userId: "reviewer", role: "reviewer" as const }],
    chapters: [{ id: "c", title: "雨落", activeSourceVersionId: "s", versions: [{ id: "s", ordinal: 1, createdBy: "owner", createdAt: "2026-10-06", characterCount: 2, text: "雨落", fragments: [{ id: "f", ordinal: 1, startOffset: 0, endOffset: 2, text: "雨落", contentHash: "h" }] }] }] };
  await projects.saveProject(owner, project);
  let id = 0;
  const knowledge = new StoryKnowledgeService({ repository: new InMemoryStoryKnowledgeRepository(), projectAccessReader: projects, idGenerator: () => `k${++id}`, clock: () => new Date("2026-10-06"),
    sourceReader: { async findSourceVersion(actor, p, c, s) { const source = (await projects.findChapter(actor, p, c))?.versions.find(v => v.id === s); return source ? { id: source.id, fragmentIds: source.fragments.map(f => f.id) } : null; } } });
  const script = new ScriptService({ repository: new InMemoryScriptRepository(), accessReader: projects, upstreamReader: new EpisodePlanUpstreamReader(projects, knowledge), idGenerator: () => `plan${++id}`, clock: () => new Date("2026-10-06") });
  const input = { expectedActiveVersionId: null, projectId: "p", chapterId: "c", sourceVersionId: "s", storyBibleVersionId: "missing", targetDurationSeconds: 60 as const, aspectRatio: "9:16" as const, narrativeMode: "dialogue" as const,
    episodes: [{ id: "e", ordinal: 1, title: "雨落", sourceFragmentIds: ["f"], coreEventFactIds: ["event"] }], majorAdaptationProposals: [{ id: "proposal", kind: "reorder_events" as const, summary: "调整顺序", rationale: "节奏", affectedFactIds: ["event"] }] };
  await assert.rejects(() => script.recordEpisodePlan(owner, input), { code: "CONFIRMED_STORY_BIBLE_NOT_FOUND" });
  const extracted = await knowledge.recordExtraction(owner, { contractVersion: "0.1.0", jobId: "job", stage: "storyKnowledge", projectId: "p", chapterId: "c", sourceVersionId: "s", status: "succeeded", items: [{ scopeKey: "event", status: "succeeded", value: { id: "event", factType: "event", statement: "开始下雨", assertionKind: "explicit", resolutionStatus: "resolved", resolutionGroupId: null, evidence: [{ sourceVersionId: "s", fragmentId: "f" }] } }] });
  const reviewed = await knowledge.reviewFact(owner, "p", "c", { expectedActiveVersionId: extracted.id, factId: "event", outcome: "accepted", reason: "符合原文" });
  const confirmed = await knowledge.confirmStage(owner, "p", "c", { expectedActiveVersionId: reviewed.id, reason: "审核完成" });
  const candidate = await script.recordEpisodePlan(owner, { ...input, storyBibleVersionId: confirmed.version.id });
  const sessions = new HmacSessionManager({ secret: "0123456789abcdef0123456789abcdef", resolveActor: async userId => ({ userId, workspaceId: "w" }) });
  const ref = await Test.createTestingModule({ imports: [EpisodePlanApiModule.register({ sessionVerifier: sessions, script, projects, knowledge })] }).compile();
  const app = ref.createNestApplication(); await app.listen(0, "127.0.0.1");
  try {
    const http = request(app.getHttpServer()), base = "/projects/p/chapters/c/episode-plan", auth = { authorization: `Bearer ${await sessions.issue("owner", "w")}` };
    await http.get(base).expect(401);
    await http.get(base).set("authorization", `Bearer ${await sessions.issue("outsider", "w")}`).expect(404);
    const view = await http.get(base).set(auth).expect(200);
    assert.equal(view.body.plan.id, candidate.id); assert.equal(view.body.canReview, true); assert.equal(view.body.sourceFragments[0].text, "雨落"); assert.equal(view.body.coreEvents[0].statement, "开始下雨");
    await http.post(`${base}/confirm`).set(auth).send({ expectedActiveVersionId: candidate.id }).expect(409);
    await http.post(`${base}/confirm`).set("authorization", `Bearer ${await sessions.issue("editor", "w")}`).send({ expectedActiveVersionId: candidate.id }).expect(403);
    await http.post(`${base}/confirm`).set(auth).send({ expectedActiveVersionId: candidate.id, actor: "forged" }).expect(400);
    const decided = await http.post(`${base}/proposals/proposal/decision`).set("authorization", `Bearer ${await sessions.issue("reviewer", "w")}`).send({ expectedActiveVersionId: candidate.id, decision: "rejected", reason: "保持原著顺序" }).expect(201);
    await http.post(`${base}/confirm`).set(auth).send({ expectedActiveVersionId: candidate.id }).expect(409);
    project.chapters[0]!.activeSourceVersionId = "new-source"; await projects.saveProject(owner, project);
    await http.post(`${base}/confirm`).set(auth).send({ expectedActiveVersionId: decided.body.id }).expect(409);
    const stale = await http.get(base).set(auth).expect(200); assert.equal(stale.body.canReview, false);
    project.chapters[0]!.activeSourceVersionId = "s"; await projects.saveProject(owner, project);
    const approved = await http.post(`${base}/confirm`).set(auth).send({ expectedActiveVersionId: decided.body.id }).expect(201);
    assert.equal(approved.body.status, "confirmed");
    const historical = await http.get(`${base}/versions/${candidate.id}`).set(auth).expect(200);
    assert.equal(historical.body.plan.id, candidate.id); assert.equal(historical.body.canReview, false);
    assert.equal(historical.headers["cache-control"], "no-store");
  } finally { await app.close(); }
});
