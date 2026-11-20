import assert from "node:assert/strict";
import test from "node:test";
import "reflect-metadata";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { HmacSessionManager } from "@novel-adaptation/identity";
import type { IdentityService } from "@novel-adaptation/identity";
import { InMemoryProjectImportRepository, ProjectImportService } from "@novel-adaptation/project-import";
import { InMemoryStoryKnowledgeRepository, StoryKnowledgeService } from "@novel-adaptation/story-knowledge";
import { ForwardedClientIpResolver, HmacDeviceTokenService, ProjectImportApiModule } from "../src/index.ts";

test("认证项目成员可读取活动故事知识，非成员看到统一的不存在响应", async () => {
  const harness = await createHarness();
  try {
    const candidate = await harness.storyKnowledge.recordExtraction(harness.owner, extraction());
    const path = "/projects/prj_1/chapters/chp_1/story-knowledge";

    await request(harness.app.getHttpServer()).get(path).expect(401);
    const response = await request(harness.app.getHttpServer()).get(path)
      .set("authorization", `Bearer ${harness.ownerToken}`).expect(200);
    assert.equal(response.body.id, candidate.id);
    assert.equal(response.body.facts[0].statement, "少年觉醒灵纹");

    const hidden = await request(harness.app.getHttpServer()).get(path)
      .set("authorization", `Bearer ${harness.outsiderToken}`).expect(404);
    assert.equal(hidden.body.code, "STAGE_RESULT_NOT_FOUND");
  } finally {
    await harness.app.close();
  }
});

test("故事知识 API 支持编辑、审核、确认、锁定并读取历史版本", async () => {
  const harness = await createHarness();
  try {
    const candidate = await harness.storyKnowledge.recordExtraction(harness.owner, extraction());
    const base = "/projects/prj_1/chapters/chp_1/story-knowledge";
    const authorization = { authorization: `Bearer ${harness.ownerToken}` };

    const edited = await request(harness.app.getHttpServer()).post(`${base}/facts/fact_1/edit`)
      .set(authorization).send({
        expectedActiveVersionId: candidate.id,
        statement: "少年在宗门试炼中觉醒灵纹",
        reason: "补充事件地点",
      }).expect(201);
    assert.equal(edited.body.parentVersionId, candidate.id);
    const stale = await request(harness.app.getHttpServer()).post(`${base}/facts/fact_1/edit`)
      .set(authorization).send({
        expectedActiveVersionId: candidate.id,
        statement: "过期修改",
        reason: "使用旧版本",
      }).expect(409);
    assert.equal(stale.body.code, "VERSION_CONFLICT");

    const reviewed = await request(harness.app.getHttpServer()).post(`${base}/facts/fact_1/review`)
      .set(authorization).send({
        expectedActiveVersionId: edited.body.id,
        outcome: "accepted",
        reason: "符合原文",
      }).expect(201);
    assert.equal(reviewed.body.facts[0].decision.outcome, "accepted");

    const confirmed = await request(harness.app.getHttpServer()).post(`${base}/confirm`)
      .set(authorization).send({ expectedActiveVersionId: reviewed.body.id, reason: "审核完成" }).expect(201);
    assert.equal(confirmed.body.version.status, "confirmed");
    assert.equal(confirmed.body.storyBible.facts.length, 1);

    const locked = await request(harness.app.getHttpServer()).post(`${base}/facts/fact_1/lock`)
      .set(authorization).send({
        expectedActiveVersionId: confirmed.body.version.id,
        action: "lock",
        reason: "后续剧本不得改变",
      }).expect(201);
    assert.equal(locked.body.facts[0].locked, true);
    const storyBible = await request(harness.app.getHttpServer()).get(`${base}/story-bible`)
      .set(authorization).expect(200);
    assert.equal(storyBible.body.versionId, locked.body.id);
    assert.equal(storyBible.body.facts[0].locked, true);

    const original = await request(harness.app.getHttpServer()).get(`${base}/versions/${candidate.id}`)
      .set(authorization).expect(200);
    assert.equal(original.body.facts[0].statement, "少年觉醒灵纹");
    const retryable = await request(harness.app.getHttpServer()).get(`${base}/retryable-scopes`)
      .set(authorization).expect(200);
    assert.deepEqual(retryable.body, { scopeKeys: [] });
  } finally {
    await harness.app.close();
  }
});

test("故事知识 API 支持不确定事实裁决与局部幂等重试", async () => {
  const decisionHarness = await createHarness();
  try {
    const candidate = await decisionHarness.storyKnowledge.recordExtraction(decisionHarness.owner, {
      ...extraction(),
      items: [{
        scopeKey: "fact:identity", status: "succeeded",
        value: {
          id: "fact_identity", factType: "relationship", statement: "墨白可能是无心",
          assertionKind: "inferred", resolutionStatus: "pending_identity", resolutionGroupId: "identity:wuxin",
          evidence: [{ sourceVersionId: "srcv_1", fragmentId: "frag_1" }],
        },
      }],
    });
    const base = "/projects/prj_1/chapters/chp_1/story-knowledge";
    const authorization = { authorization: `Bearer ${decisionHarness.ownerToken}` };
    const resolved = await request(decisionHarness.app.getHttpServer()).post(`${base}/facts/fact_identity/resolve`)
      .set(authorization).send({ expectedActiveVersionId: candidate.id, statement: "墨白是无心使用的身份", reason: "原文线索一致" }).expect(201);
    assert.equal(resolved.body.parentVersionId, candidate.id);
    assert.equal(resolved.body.facts[0].resolutionStatus, "resolved");
    const staleDecision = await request(decisionHarness.app.getHttpServer()).post(`${base}/facts/fact_identity/resolve`)
      .set(authorization).send({ expectedActiveVersionId: candidate.id, statement: "陈旧决定", reason: "页面未刷新" }).expect(409);
    assert.equal(staleDecision.body.code, "VERSION_CONFLICT");
  } finally {
    await decisionHarness.app.close();
  }

  const retryHarness = await createHarness();
  try {
    const failed = await retryHarness.storyKnowledge.recordExtraction(retryHarness.owner, {
      ...extraction(), jobId: "job_failed", status: "failed",
      items: [{
        scopeKey: "fact:location", status: "failed",
        error: { code: "MODEL_TIMEOUT", message: "模型超时", retryable: true },
      }],
    });
    const command = {
      expectedActiveVersionId: failed.id,
      retryOfJobId: "job_failed",
      extraction: {
        ...extraction(), jobId: "job_retry",
        items: [{
          scopeKey: "fact:location", status: "succeeded",
          value: {
            id: "fact_location", factType: "location", statement: "事件发生在天涯阁",
            assertionKind: "explicit", resolutionStatus: "resolved", resolutionGroupId: null,
            evidence: [{ sourceVersionId: "srcv_1", fragmentId: "frag_1" }],
          },
        }],
      },
    };
    const path = "/projects/prj_1/chapters/chp_1/story-knowledge/retries";
    const authorization = { authorization: `Bearer ${retryHarness.ownerToken}` };
    const retried = await request(retryHarness.app.getHttpServer()).post(path).set(authorization).send(command).expect(201);
    const repeated = await request(retryHarness.app.getHttpServer()).post(path).set(authorization).send(command).expect(201);
    assert.equal(retried.body.id, repeated.body.id);
    assert.equal(retried.body.facts[0].id, "fact_location");
    assert.deepEqual(retried.body.failures, []);
  } finally {
    await retryHarness.app.close();
  }
});

test("编辑提交故事事实建议，审核人并发裁决只写入一个新候选", async () => {
  const h = await createHarness();
  try {
    const candidate = await h.storyKnowledge.recordExtraction(h.owner, extraction());
    const base = "/projects/prj_1/chapters/chp_1/story-knowledge";
    const submit = `${base}/facts/fact_1/suggestions`;
    const list = `${base}/versions/${candidate.id}/facts/fact_1/suggestions`;
    const client = request(h.app.getHttpServer());
    const command = { expectedActiveVersionId: candidate.id, statement: "少年在试炼中觉醒灵纹", reason: "补足地点" };
    const proposed = await client.post(submit).auth(h.editorToken, { type: "bearer" }).send(command).expect(201);
    assert.equal(proposed.body.createdBy, "usr_editor");
    assert.deepEqual(await h.storyKnowledge.getActive(h.owner, "prj_1", "chp_1"), candidate);
    await client.get(list).auth(h.outsiderToken, { type: "bearer" }).expect(403);
    const rejectedProposal = await client.post(submit).auth(h.editorToken, { type: "bearer" })
      .send({ ...command, statement: "新事实" }).expect(201);
    await client.post(`${list}/${rejectedProposal.body.id}/decision`).auth(h.reviewerToken, { type: "bearer" })
      .send({ outcome: "rejected", reason: "原文无依据" }).expect(201);
    assert.deepEqual(await h.storyKnowledge.getActive(h.owner, "prj_1", "chp_1"), candidate);
    const decision = `${list}/${proposed.body.id}/decision`;
    const accept = { outcome: "accepted", reason: "已核对原文" };
    await client.post(decision).auth(h.editorToken, { type: "bearer" }).send(accept).expect(403);
    const results = await Promise.all([h.ownerToken, h.reviewerToken].map(token =>
      client.post(decision).auth(token, { type: "bearer" }).send(accept)));
    assert.deepEqual(results.map(result => result.status).sort(), [201, 409]);
    const active = await h.storyKnowledge.getActive(h.owner, "prj_1", "chp_1");
    assert.equal(active.parentVersionId, candidate.id);
    const [activeFact] = active.facts;
    const [originalFact] = candidate.facts;
    assert.ok(activeFact && originalFact);
    assert.equal(activeFact.statement, command.statement);
    assert.deepEqual(activeFact.evidence, originalFact.evidence);
    const history = await client.get(list).auth(h.editorToken, { type: "bearer" }).expect(200);
    assert.deepEqual(history.body.map((item: { decision: { outcome: string } }) => item.decision.outcome), ["accepted", "rejected"]);
    await client.post(submit).auth(h.editorToken, { type: "bearer" }).send(command).expect(409);
    const confirmed = await client.post(`${base}/confirm`).auth(h.ownerToken, { type: "bearer" })
      .send({ expectedActiveVersionId: active.id, reason: "确认故事知识" }).expect(201);
    const formalId = confirmed.body.version.id;
    const formalSuggestion = await client.post(submit).auth(h.reviewerToken, { type: "bearer" })
      .send({ ...command, expectedActiveVersionId: formalId, statement: "少年在初次试炼中觉醒灵纹" }).expect(201);
    const formalDecision = `${base}/versions/${formalId}/facts/fact_1/suggestions/${formalSuggestion.body.id}/decision`;
    const revised = await client.post(formalDecision).auth(h.ownerToken, { type: "bearer" }).send(accept).expect(201);
    assert.equal(revised.body.version.parentVersionId, formalId);
    assert.equal(revised.body.version.status, "candidate");
    assert.equal(revised.body.version.confirmedBy, undefined);
    assert.equal(revised.body.version.facts[0].decision, undefined);
    const published = await client.get(`${base}/story-bible`).auth(h.editorToken, { type: "bearer" }).expect(200);
    assert.deepEqual(published.body, confirmed.body.storyBible);
    const fullHistory = await client.get(submit).auth(h.editorToken, { type: "bearer" }).expect(200);
    assert.equal(fullHistory.body.length, 3);
    assert.equal(fullHistory.body.at(-1).decision.outcome, "accepted");
  } finally {
    await h.app.close();
  }
});

async function createHarness() {
  const owner = { userId: "usr_owner", workspaceId: "wsp_studio" } as const;
  const sessions = new HmacSessionManager({
    secret: "0123456789abcdef0123456789abcdef",
    resolveActor: async (userId) => ({ userId, workspaceId: userId === "usr_outsider" ? "wsp_other" : owner.workspaceId }),
  });
  const projectImport = new ProjectImportService({
    repository: new InMemoryProjectImportRepository(),
    complianceScanner: { async scan() { return { allowed: true }; } },
    idGenerator: (prefix) => `${prefix}_unused`,
    clock: () => new Date("2026-09-29T00:00:00.000Z"),
  });
  let id = 0;
  const storyKnowledge = new StoryKnowledgeService({
    repository: new InMemoryStoryKnowledgeRepository(),
    sourceReader: {
      async findSourceVersion(actor, projectId, chapterId, sourceVersionId) {
        return actor.workspaceId === owner.workspaceId && projectId === "prj_1" && chapterId === "chp_1" && sourceVersionId === "srcv_1"
          ? { id: "srcv_1", fragmentIds: ["frag_1"] }
          : null;
      },
    },
    projectAccessReader: {
      async findProjectAccess(actor, projectId) {
        if (actor.workspaceId !== owner.workspaceId || projectId !== "prj_1") return null;
        const role = actor.userId === "usr_editor" ? "editor" : actor.userId === "usr_reviewer" ? "reviewer" : "owner";
        return { role };
      },
    },
    idGenerator: () => `skv_api_${++id}`,
    clock: () => new Date("2026-09-29T08:00:00.000Z"),
  });
  const moduleRef = await Test.createTestingModule({ imports: [ProjectImportApiModule.register({
    identity: {} as IdentityService,
    sessionVerifier: sessions,
    projectImport,
    storyKnowledge,
    wechatRedirectUri: "https://app.example.cn/auth/wechat/callback",
    deviceTokens: new HmacDeviceTokenService("abcdef0123456789abcdef0123456789"),
    clientIpResolver: new ForwardedClientIpResolver(0),
  })] }).compile();
  const app = moduleRef.createNestApplication();
  await app.listen(0, "127.0.0.1");
  return {
    app, storyKnowledge, owner,
    ownerToken: await sessions.issue(owner.userId, owner.workspaceId),
    editorToken: await sessions.issue("usr_editor", owner.workspaceId),
    reviewerToken: await sessions.issue("usr_reviewer", owner.workspaceId),
    outsiderToken: await sessions.issue("usr_outsider", "wsp_other"),
  };
}

function extraction() {
  return {
    contractVersion: "0.1.0", jobId: "job_1", stage: "storyKnowledge",
    projectId: "prj_1", chapterId: "chp_1", sourceVersionId: "srcv_1", status: "succeeded",
    items: [{
      scopeKey: "fact:awakening", status: "succeeded",
      value: {
        id: "fact_1", factType: "event", statement: "少年觉醒灵纹", assertionKind: "explicit",
        resolutionStatus: "resolved", resolutionGroupId: null,
        evidence: [{ sourceVersionId: "srcv_1", fragmentId: "frag_1" }],
      },
    }],
  } as const;
}
