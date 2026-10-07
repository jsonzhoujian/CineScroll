import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import "reflect-metadata";
import { Pool } from "pg";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { HmacSessionManager } from "@novel-adaptation/identity";
import { createProductionApi } from "../src/production.ts";
import { PostgresProjectImportRepository } from "@novel-adaptation/project-import/postgres-repository";
import { StoryKnowledgeTaskWorker } from "../src/story-knowledge-task-worker.ts";
import { EPISODE_PLAN_WORKER } from "../src/episode-plan-worker-module.ts";

// Opt-in: only a disposable admin-owned TLS database, never a business database.
test("TLS生产装配使用受限登录完成Key保存、重启读取、订阅撤销并拒绝额外角色", {
  skip: !process.env.TEST_TLS_DATABASE_URL || !process.env.TEST_TLS_CA_PATH,
}, async () => {
  const databaseUrl = process.env.TEST_TLS_DATABASE_URL!;
  const ca = await readFile(process.env.TEST_TLS_CA_PATH!, "utf8");
  const admin = new Pool({ connectionString: databaseUrl, ssl: { ca, rejectUnauthorized: true } });
  const suffix = randomUUID().replaceAll("-", "");
  const login = `model_${suffix}`, extraRole = `extra_${suffix}`;
  const workspaceId = `w_${suffix}`, userId = `u_${suffix}`;
  const sessionSecret = "0123456789abcdef0123456789abcdef";
  const restrictedUrl = new URL(databaseUrl); restrictedUrl.username = login; restrictedUrl.password = "";
  const config = {
    databaseUrl, databaseTlsCa: ca, sessionSecret, deviceTokenSecret: "abcdef0123456789abcdef0123456789",
    trustedProxyHops: 0, smsEndpoint: "https://sms.example/verify", smsApiKey: "fixture",
    wechatAppId: "fixture", wechatAppSecret: "fixture", wechatRedirectUri: "https://app.example/callback",
    complianceEndpoint: "https://compliance.example/scan", complianceApiKey: "fixture",
    modelSettings: { enabled: true as const, encryptionKeyBase64: Buffer.alloc(32, 7).toString("base64"),
      databaseUrl: restrictedUrl.toString(), databaseTlsCa: ca, routes: { deepseek: "mainland" as const } },
  };
  let modelEntered!: () => void, modelRelease!: () => void;
  const entered = new Promise<void>(resolve => { modelEntered = resolve; });
  const gate = new Promise<void>(resolve => { modelRelease = resolve; });
  let modelCalls = 0;
  const modelFetch: typeof fetch = async (url, init) => {
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture-not-real-key");
    if (String(url).endsWith("/models")) return Response.json({ object: "list", data: [{ object: "model", id: "m" }] });
    assert.equal(url, "https://api.deepseek.com/chat/completions");
    modelCalls++; modelEntered(); await gate;
    const input = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    if (input.stage === "script") {
      const plan = { contractVersion: "0.1.0",jobId: input.jobId,stage: "script",resultType: "episodePlan",
        projectId: input.projectId,chapterId: input.chapterId,sourceVersionId: input.sourceVersionId,
        upstreamConfirmedVersionIds: input.upstreamConfirmedVersionIds,status: "succeeded",recommendationRationale: "保留雨落事件",
        episodes: [{ id: "e1",ordinal: 1,title: "雨落",sourceFragmentIds: [input.input.sourceFragments[0].id],
          coreEventFactIds: ["rain"] }],majorAdaptationProposals: [] };
      return Response.json({ object: "chat.completion",model: "m",choices: [{ index: 0,finish_reason: "stop",message: { role: "assistant",content: JSON.stringify(plan) } }] });
    }
    const extraction = { contractVersion: "0.1.0", jobId: input.jobId, stage: "storyKnowledge", projectId: input.projectId,
      chapterId: input.chapterId, sourceVersionId: input.sourceVersionId, status: "succeeded",
      items: [{ scopeKey: "weather", status: "succeeded", value: { id: "rain", factType: "event", statement: "正在下雨",
        assertionKind: "explicit", resolutionStatus: "resolved", resolutionGroupId: null,
        evidence: [{ sourceVersionId: input.sourceVersionId, fragmentId: input.input.sourceFragments[0].id }] } }] };
    return Response.json({ object: "chat.completion", model: "m", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(extraction) } }] });
  };
  const start = async (databaseTlsCa = ca, tasksEnabled = false, episodesEnabled = false) => {
    const production = createProductionApi({ ...config, modelSettings: { ...config.modelSettings, databaseTlsCa },
      ...(tasksEnabled ? { storyTasks: { enabled: true, workspaceIds: [workspaceId], intervalMs: 100 } } : {}),
      ...(episodesEnabled ? { episodeTasks: { enabled: true,workspaceIds: [workspaceId],intervalMs: 100 } } : {}) }, { modelFetch });
    try {
      const ref = await Test.createTestingModule({ imports: [production.module] }).compile();
      const app = ref.createNestApplication();
      try { await app.listen(0, "127.0.0.1"); }
      catch (error) { await app.close(); throw error; }
      return { http: request(app.getHttpServer()), worker: tasksEnabled ? app.get(StoryKnowledgeTaskWorker) : null,
        episodeWorker: episodesEnabled ? app.get(EPISODE_PLAN_WORKER) as StoryKnowledgeTaskWorker : null,
        closeResources: production.close, close: async () => { try { await app.close(); } finally { await production.close(); } } };
    } catch (error) { await production.close(); throw error; }
  };
  try {
    for (const path of ["../../identity/migrations/0001_identity.sql", "../../project-import/migrations/0001_project_import.sql",
      "../../project-import/migrations/0002_imported_documents.sql", "../../story-knowledge/migrations/0001_story_knowledge.sql",
      "../../story-knowledge/migrations/0002_extraction_recovery.sql", "../../story-knowledge/migrations/0003_generation_policy.sql",
      "../../story-knowledge/migrations/0004_generation_policy_audit.sql", "../../script/migrations/0001_model_settings.sql",
      "../../script/migrations/0002_workspace_model_access.sql", "../../script/migrations/0003_model_tasks.sql",
      "../../script/migrations/0004_model_task_results.sql", "../../script/migrations/0005_model_task_recovery.sql",
      "../../script/migrations/0006_chapter_task_list.sql", "../../script/migrations/0007_story_task_scan.sql",
      "../../script/migrations/0008_generation_policy_reason.sql", "../../script/migrations/0009_workspace_task_limits.sql",
      "../../script/migrations/0010_episode_plans.sql", "../../script/migrations/0011_episode_task_scan.sql",
      "../../script/migrations/0012_episode_task_list.sql", "../migrations/0001_model_rate_limits.sql",
      "../migrations/0002_generation_rate_limits.sql"]) {
      await admin.query(await readFile(new URL(path, import.meta.url), "utf8"));
    }
    // Identifiers are generated locally from hex UUIDs, not supplied by users.
    await admin.query(`create role ${login} login nosuperuser nocreatedb nocreaterole nobypassrls`);
    await admin.query(`grant novel_app to ${login}`);
    await admin.query(`create role ${extraRole} nologin`);
    await admin.query("insert into identity_accounts(user_id,workspace_id,wechat_open_id) values($1,$2,$1)", [userId, workspaceId]);
    await admin.query("insert into workspace_model_members(workspace_id,user_id,role) values($1,$2,'owner')", [workspaceId, userId]);
    await admin.query("insert into workspace_model_entitlements values($1,'advanced',true,now()-interval '1 hour',now()+interval '1 hour')", [workspaceId]);
    await assert.rejects(() => start("invalid-test-ca"), { message: "MODEL_DATABASE_NOT_READY" });
    const sessions = new HmacSessionManager({ secret: sessionSecret, resolveActor: async () => ({ userId, workspaceId }) });
    const bearer = `Bearer ${await sessions.issue(userId, workspaceId)}`;
    let version: string;
    const first = await start();
    try {
      await first.http.get("/workspace/model-settings").expect(401);
      const saved = await first.http.post("/workspace/model-settings").set("authorization", bearer)
        .send({ expectedVersionId: null, providerId: "deepseek", apiKey: "fixture-not-real-key" }).expect(201);
      version = saved.body.id;
      assert.equal(saved.body.keyMask, "••••••••");
      assert.ok(!JSON.stringify(saved.body).includes("fixture-not-real-key"));
      await first.http.post("/workspace/model-settings").set("authorization", bearer)
        .send({ expectedVersionId: null, providerId: "deepseek", apiKey: "fixture-not-real-key" }).expect(409);
    } finally { await first.close(); }
    await assert.rejects(() => start(ca, true), { message: "STORY_TASK_DATABASE_NOT_READY" });
    assert.equal(modelCalls, 0);
    await admin.query("insert into workspace_task_limits values($1,10,1)", [workspaceId]);
    await admin.query("alter table model_rate_limits drop constraint model_rate_limits_action_check");
    await admin.query("alter table model_rate_limits add constraint model_rate_limits_action_check check(action in ('configure','test')) not valid");
    try { await assert.rejects(async () => { const bad = await start(ca,true); await bad.close(); }, { message: "STORY_TASK_DATABASE_NOT_READY" }); }
    finally { await admin.query(await readFile(new URL("../migrations/0002_generation_rate_limits.sql",import.meta.url),"utf8")); }
    await admin.query("alter table model_tasks disable trigger model_task_capacity");
    try { await assert.rejects(async () => { const unexpected = await start(ca, true); await unexpected.close(); }, { message: "STORY_TASK_DATABASE_NOT_READY" }); }
    finally { await admin.query("alter table model_tasks enable trigger model_task_capacity"); }
    await admin.query("alter function generation_allowed_locked(text,text,text,text) owner to novel_app");
    try { await assert.rejects(async () => { const unexpected = await start(ca, true); await unexpected.close(); }, { message: "STORY_TASK_DATABASE_NOT_READY" }); }
    finally {
      await admin.query("alter function generation_allowed_locked(text,text,text,text) owner to postgres");
      await admin.query("grant execute on function generation_allowed_locked(text,text,text,text) to novel_app");
    }
    const projectId = `p_${suffix}`, chapterId = `c_${suffix}`, sourceId = `s_${suffix}`;
    await new PostgresProjectImportRepository(admin).saveProject({ userId, workspaceId }, { id: projectId, workspaceId, ownerUserId: userId,
      members: [{ userId, role: "owner" }], title: "fixture", aspectRatio: "9:16", targetDurationSeconds: 60, narrativeMode: "narration", dataRegion: "CN", createdAt: new Date().toISOString(),
      chapters: [{ id: chapterId, title: "chapter", activeSourceVersionId: sourceId, versions: [{ id: sourceId, ordinal: 1, createdAt: new Date().toISOString(), createdBy: userId,
        characterCount: 2, text: "雨落", fragments: [{ id: `f_${suffix}`, ordinal: 1, startOffset: 0, endOffset: 2, text: "雨落", contentHash: "hash" }] }] }] });
    await admin.query("insert into project_generation_policy(workspace_id,project_id,state) values($1,$2,'allowed')", [workspaceId,projectId]);
    await admin.query("insert into source_generation_policy(workspace_id,project_id,chapter_id,source_version_id,state) values($1,$2,$3,$4,'allowed')", [workspaceId,projectId,chapterId,sourceId]);
    const taskApp = await start(ca, true);
    try {
      const connection = await taskApp.http.post("/workspace/model-settings/test").set("authorization", bearer).send({ expectedVersionId: version!, allowNonMainland: false }).expect(201);
      version = connection.body.id;
      const path = `/projects/${projectId}/chapters/${chapterId}/story-knowledge-tasks`;
      await taskApp.http.post(path).expect(401);
      const task = await taskApp.http.post(path).set("authorization", bearer).send({ configurationVersionId: version, modelId: "m" }).expect(201);
      await entered;
      let closed = false;
      const closing = taskApp.closeResources().then(() => { closed = true; });
      assert.equal(taskApp.worker!.status().state, "stopping");
      assert.equal(closed, false);
      modelRelease(); await closing;
      assert.equal(taskApp.worker!.status().state, "stopped");
      assert.equal(modelCalls, 1);
      // A fresh production instance reads persisted task and candidate after the old pools are closed.
      const restarted = await start(ca, true);
      try {
        const status = await restarted.http.get(`/story-knowledge-tasks/${task.body.id}`).set("authorization", bearer).expect(200);
        assert.equal(status.body.state, "succeeded"); assert.equal(status.body.result.extractionStatus, "succeeded");
        assert.ok(!JSON.stringify(status.body).includes("fixture-not-real-key"));
        assert.equal(modelCalls, 1);
        const knowledgePath = `/projects/${projectId}/chapters/${chapterId}/story-knowledge`;
        const reviewed = await restarted.http.post(`${knowledgePath}/facts/rain/review`).set("authorization",bearer)
          .send({ expectedActiveVersionId: status.body.result.candidateVersionId,outcome: "accepted",reason: "符合测试原文" }).expect(201);
        await restarted.http.post(`${knowledgePath}/confirm`).set("authorization",bearer)
          .send({ expectedActiveVersionId: reviewed.body.id,reason: "确认测试知识" }).expect(201);
      } finally { await restarted.close(); }
    } finally { modelRelease(); await taskApp.close(); }
    await admin.query("alter table episode_plan_heads disable trigger episode_plan_head_transition");
    try { await assert.rejects(async () => { const bad = await start(ca,false,true); await bad.close(); }, { message: "EPISODE_TASK_DATABASE_NOT_READY" }); }
    finally { await admin.query("alter table episode_plan_heads enable trigger episode_plan_head_transition"); }
    const both = await start(ca,true,true);
    let episodeTaskId: string;
    try {
      assert.notEqual(both.worker,both.episodeWorker);
      const path = `/projects/${projectId}/chapters/${chapterId}/episode-plan-tasks`;
      await both.http.post(path).expect(401);
      await both.http.get(`/projects/${projectId}/chapters/${chapterId}/episode-plan`).expect(401);
      const submitted = await both.http.post(path).set("authorization",bearer)
        .send({ configurationVersionId: version!,modelId: "m",requestId: "fixture-episode" }).expect(201);
      episodeTaskId = submitted.body.id;
      let status;
      for (let attempt = 0; attempt < 50; attempt++) {
        status = await both.http.get(`/episode-plan-tasks/${episodeTaskId}`).set("authorization",bearer).expect(200);
        if (status.body.state === "succeeded" || status.body.state === "failed" || status.body.state === "paused") break;
        await new Promise(resolve => setTimeout(resolve,20));
      }
      assert.equal(status!.body.state,"succeeded",JSON.stringify(status!.body));
      const plan = await both.http.get(`/projects/${projectId}/chapters/${chapterId}/episode-plan`).set("authorization",bearer).expect(200);
      assert.equal(plan.body.plan.status,"candidate");
      assert.equal(plan.body.plan.id,status!.body.result.candidateVersionId);
      await both.http.post(`/projects/${projectId}/chapters/${chapterId}/episode-plan/confirm`).set("authorization",bearer)
        .send({ expectedActiveVersionId: plan.body.plan.id }).expect(201);
      assert.equal(modelCalls,2);
    } finally {
      await both.close();
      assert.equal(both.worker!.status().state,"stopped");
      assert.equal(both.episodeWorker!.status().state,"stopped");
    }
    const episodeRestart = await start(ca,true,true);
    try {
      const plan = await episodeRestart.http.get(`/projects/${projectId}/chapters/${chapterId}/episode-plan`).set("authorization",bearer).expect(200);
      assert.equal(plan.body.plan.status,"confirmed");
      await episodeRestart.http.get(`/episode-plan-tasks/${episodeTaskId!}`).set("authorization",bearer).expect(200);
      assert.equal(modelCalls,2);
      // Administrator moves only this fixture's window; application cannot reset it.
      await admin.query("update model_rate_limits set window_started_at=now()-interval '61 seconds' where workspace_id=$1 and action='generate'",[workspaceId]);
      const selection = { configurationVersionId: version!,modelId: "m" };
      const episodePath = `/projects/${projectId}/chapters/${chapterId}/episode-plan-tasks`;
      await episodeRestart.http.post(episodePath).send({ ...selection,requestId: "fixture-episode" }).expect(401);
      await episodeRestart.http.post(episodePath).set("authorization",bearer).send({ ...selection,unexpected: true }).expect(400);
      for (let i = 0; i < 9; i++) {
        await episodeRestart.http.post("/story-knowledge-tasks/missing/resubmit").set("authorization",bearer).send(selection).expect(404);
      }
      await episodeRestart.http.post(episodePath).set("authorization",bearer).send({ ...selection,requestId: "fixture-episode" }).expect(201);
      const limited = await episodeRestart.http.post(episodePath).set("authorization",bearer).send({ ...selection,requestId: "blocked-episode" }).expect(429);
      assert.equal(limited.body.code,"TASK_RATE_LIMITED");
      assert.ok(Number(limited.headers["retry-after"]) >= 1);
      const listed = await episodeRestart.http.get(episodePath).set("authorization",bearer).expect(200);
      assert.equal(listed.body.tasks.length,1);
      assert.equal(modelCalls,2);
    } finally { await episodeRestart.close(); }
    const second = await start();
    try {
      const read = await second.http.get("/workspace/model-settings").set("authorization", bearer).expect(200);
      assert.equal(read.body.configuration.id, version!);
      assert.equal(read.body.configuration.ciphertext, undefined);
      await admin.query("update workspace_model_entitlements set enabled=false where workspace_id=$1", [workspaceId]);
      await second.http.get("/workspace/model-settings").set("authorization", bearer).expect(403);
    } finally { await second.close(); }
    await admin.query(`grant ${extraRole} to ${login}`);
    await assert.rejects(start, { message: "MODEL_DATABASE_NOT_READY" });
    await admin.query(`revoke ${extraRole} from ${login}`);
    await admin.query("revoke insert on model_settings_audit from novel_app");
    try { await assert.rejects(start, { message: "MODEL_DATABASE_NOT_READY" }); }
    finally { await admin.query("grant insert on model_settings_audit to novel_app"); }
  } finally {
    try { await admin.query(`drop role if exists ${login}`); }
    finally {
      try { await admin.query(`drop role if exists ${extraRole}`); }
      finally { await admin.end(); }
    }
  }
});
