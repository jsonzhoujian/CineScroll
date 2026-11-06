import { SETTINGS_REGENERATION_WORKER,SETTINGS_WORKER } from "../src/settings-worker-module.ts";
import type { ModelTaskService } from "@novel-adaptation/script/model-tasks";
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
import { SCRIPT_CONTENT_WORKER } from "../src/script-content-worker-module.ts";
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
    if (input.stage === "settings") {
      const result = { contractVersion: "0.1.0",jobId: input.jobId,stage: "settings",projectId: input.projectId,chapterId: input.chapterId,sourceVersionId: input.sourceVersionId,upstreamConfirmedVersionIds: input.upstreamConfirmedVersionIds,status: "succeeded",items: [{ scopeKey: input.regeneration?.targets[0].scopeKey ?? "location",status: "succeeded",value: { id: "location",assetType: "location",name: input.regeneration ? "重生庭院" : "庭院",visibleDefinition: { weather: "rain" },state: "",stateChanges: [],restrictions: [],provenance: [{ type: "source_fragment",sourceVersionId: input.sourceVersionId,fragmentId: input.input.sourceFragments[0].id,transformation: "retained" }] } }] };
      return Response.json({ object: "chat.completion",model: "m",choices: [{ index: 0,finish_reason: "stop",message: { role: "assistant",content: JSON.stringify(result) } }] });
    }
    if (input.version) {
      const assessment = { versionId: input.version.id,events: [{ factId: "rain",elementIds: ["action"],verdict: "covered" }],facts: [{ factId: "rain",verdict: "consistent" }],episodes: [{ episodeId: "e1",estimatedSeconds: 60 }],unsupportedCoreFactElementIds: [] };
      return Response.json({ object: "chat.completion",model: "m",choices: [{ index: 0,finish_reason: "stop",message: { role: "assistant",content: JSON.stringify(assessment) } }] });
    }
    if (input.stage === "script" && input.input.retry) {
      assert.deepEqual(input.scopeKeys,["dialogue"]); assert.equal("elements" in input.input,false);
      const result = { contractVersion: "0.1.0",jobId: input.jobId,stage: "script",projectId: input.projectId,chapterId: input.chapterId,sourceVersionId: input.sourceVersionId,upstreamConfirmedVersionIds: input.upstreamConfirmedVersionIds,status: "succeeded",scenes: [],items: [{ scopeKey: "dialogue",status: "succeeded",value: { id: "recovered-dialogue",sceneId: "scene",elementType: "dialogue",ordinal: 2,text: "下雨了",provenance: [{ type: "source_fragment",sourceVersionId: input.sourceVersionId,fragmentId: input.input.sourceFragments[0].id,transformation: "retained" }] } }] };
      return Response.json({ object: "chat.completion",model: "m",choices: [{ index: 0,finish_reason: "stop",message: { role: "assistant",content: JSON.stringify(result) } }] });
    }
    if (input.stage === "script" && input.scopeKeys[0] === "script") {
      const result = { contractVersion: "0.1.0",jobId: input.jobId,stage: "script",projectId: input.projectId,chapterId: input.chapterId,sourceVersionId: input.sourceVersionId,upstreamConfirmedVersionIds: input.upstreamConfirmedVersionIds,status: "partially_succeeded",
        scenes: [{ id: "scene",episodeId: "e1",ordinal: 1,title: "rain",environment: "outside",characters: [] }],items: [{ scopeKey: "action",status: "succeeded",value: { id: "action",sceneId: "scene",elementType: "action",ordinal: 1,text: "雨落",provenance: [{ type: "source_fragment",sourceVersionId: input.sourceVersionId,fragmentId: input.input.sourceFragments[0].id,transformation: "retained" }] } }] };
      return Response.json({ object: "chat.completion",model: "m",choices: [{ index: 0,finish_reason: "stop",message: { role: "assistant",content: JSON.stringify({ ...result,items: [...result.items,{ scopeKey: "dialogue",status: "failed",error: { code: "INVALID_ELEMENT",message: "missing dialogue",retryable: true } }] }) } }] });
    }
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
  const start = async (databaseTlsCa = ca, tasksEnabled = false, episodesEnabled = false, scriptsEnabled = false, settingsEnabled = false) => {
    const production = createProductionApi({ ...config, modelSettings: { ...config.modelSettings, databaseTlsCa },
      ...(settingsEnabled ? { settingsTasks: { enabled: true,workspaceIds: [workspaceId],intervalMs: 100 } } : {}),
      ...(tasksEnabled ? { storyTasks: { enabled: true, workspaceIds: [workspaceId], intervalMs: 100 } } : {}),
      ...(scriptsEnabled ? { scriptTasks: { enabled: true,workspaceIds: [workspaceId],intervalMs: 100 } } : {}),
      ...(episodesEnabled ? { episodeTasks: { enabled: true,workspaceIds: [workspaceId],intervalMs: 100 } } : {}) }, { modelFetch });
    try {
      const ref = await Test.createTestingModule({ imports: [production.module] }).compile();
      const app = ref.createNestApplication();
      try { await app.listen(0, "127.0.0.1"); }
      catch (error) { await app.close(); throw error; }
      return { http: request(app.getHttpServer()), worker: tasksEnabled ? app.get(StoryKnowledgeTaskWorker) : null,
        regenerationTasks: settingsEnabled ? app.get("SETTINGS_REGENERATION_TASK_SERVICE") as ModelTaskService : null,
        regenerationWorker: settingsEnabled ? app.get(SETTINGS_REGENERATION_WORKER) as StoryKnowledgeTaskWorker : null,
        settingsTasks: settingsEnabled ? app.get("SETTINGS_TASK_SERVICE") as ModelTaskService : null,
        settingsWorker: settingsEnabled ? app.get(SETTINGS_WORKER) as StoryKnowledgeTaskWorker : null,
        scriptWorker: scriptsEnabled ? app.get(SCRIPT_CONTENT_WORKER) as StoryKnowledgeTaskWorker : null,
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
      "../../script/migrations/0012_episode_task_list.sql", "../../script/migrations/0013_script_content.sql", "../../script/migrations/0014_script_review.sql", "../../script/migrations/0015_script_retry.sql", "../../script/migrations/0016_script_publication.sql", "../../script/migrations/0017_script_confirmed_head.sql", "../../script/migrations/0018_script_revision.sql", "../../script/migrations/0019_script_revision_transitions.sql", "../../script/migrations/0020_script_revision_confirmation.sql", "../../script/migrations/0021_script_revision_change_scope.sql", "../../script/migrations/0022_script_impacts.sql", "../../script/migrations/0023_script_revision_lock_audit.sql", "../../script/migrations/0024_script_revision_rejection.sql", "../../script/migrations/0025_settings_candidates.sql", "../../script/migrations/0026_settings_dependencies.sql", "../../script/migrations/0027_settings_tasks.sql", "../../script/migrations/0028_settings_review.sql", "../../script/migrations/0029_settings_regeneration_tasks.sql", "../../script/migrations/0030_settings_regeneration_results.sql", "../../script/migrations/0031_settings_reconciliation.sql", "../../script/migrations/0032_settings_source_reconciliation.sql", "../../script/migrations/0033_settings_pending_regeneration.sql", "../../script/migrations/0034_settings_failure_decisions.sql", "../migrations/0001_model_rate_limits.sql",
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
    await admin.query("update model_rate_limits set window_started_at=now()-interval '61 seconds' where workspace_id=$1 and action='generate'",[workspaceId]);
    await admin.query("alter table script_content_heads disable trigger script_content_head_transition");
    try { await assert.rejects(() => start(ca,false,false,true),{ message: "SCRIPT_CONTENT_DATABASE_NOT_READY" }); }
    finally { await admin.query("alter table script_content_heads enable trigger script_content_head_transition"); }
    await admin.query("alter index model_tasks_script_retry_active_idx rename to hidden_retry_active_idx");
    try { await assert.rejects(() => start(ca,false,false,true),{ message: "SCRIPT_CONTENT_DATABASE_NOT_READY" }); }
    finally { await admin.query("alter index hidden_retry_active_idx rename to model_tasks_script_retry_active_idx"); }
    const scriptApp = await start(ca,false,false,true);
    let scriptTaskId: string,scriptReviewedId: string,retryTaskId: string;
    try {
      const path = `/projects/${projectId}/chapters/${chapterId}/script-content-tasks`;
      const submitted = await scriptApp.http.post(path).set("authorization",bearer).send({ configurationVersionId: version!,modelId: "m",requestId: "fixture-script" }).expect(201);
      scriptTaskId = submitted.body.id;
      let status;
      for (let i=0;i<100;i++) {
        status = await scriptApp.http.get(`/script-content-tasks/${scriptTaskId}`).set("authorization",bearer).expect(200);
        if (status.body.state === "succeeded" || status.body.state === "failed" || status.body.state === "paused") break;
        await new Promise(resolve => setTimeout(resolve,20));
      }
      assert.equal(status!.body.state,"succeeded",JSON.stringify(status!.body));
      const view = await scriptApp.http.get(`/projects/${projectId}/chapters/${chapterId}/script-content`).set("authorization",bearer).expect(200);
      assert.equal(view.body.version.id,status!.body.result.candidateVersionId);
      assert.equal(view.body.current,true); assert.equal(modelCalls,3);
      assert.equal(view.body.permissions.canEdit,true);
      const command = { kind: "edit",requestId: "tls-edit",expectedActiveVersionId: view.body.version.id,elementId: "action",text: "雨打庭院",reason: "镜头表达" };
      const edited = await scriptApp.http.post(`/projects/${projectId}/chapters/${chapterId}/script-content/review`).set("authorization",bearer).send(command).expect(201);
      scriptReviewedId = edited.body.id;
      assert.equal(edited.body.elements[0].text,"雨打庭院");
      const replay = await scriptApp.http.post(`/projects/${projectId}/chapters/${chapterId}/script-content/review`).set("authorization",bearer).send(command).expect(201);
      assert.equal(replay.body.id,scriptReviewedId);
      const retryInput = { configurationVersionId: version!,modelId: "m",requestId: "tls-retry",expectedActiveVersionId: edited.body.id,scopeKeys: ["dialogue"] };
      const retried = await scriptApp.http.post(`${path}/retries`).set("authorization",bearer).send(retryInput).expect(201);
      retryTaskId = retried.body.id;
      for (let i=0;i<100;i++) {
        status = await scriptApp.http.get(`/script-content-tasks/${retryTaskId}`).set("authorization",bearer).expect(200);
        if (["succeeded","failed","paused"].includes(status.body.state)) break;
        await new Promise(resolve => setTimeout(resolve,20));
      }
      assert.equal(status!.body.state,"succeeded",JSON.stringify(status!.body));
      const merged = await scriptApp.http.get(`/projects/${projectId}/chapters/${chapterId}/script-content`).set("authorization",bearer).expect(200);
      assert.equal(merged.body.version.elements[0].text,"雨打庭院"); assert.equal(merged.body.version.elements[1].text,"下雨了");
      assert.equal(merged.body.version.failures.length,0); assert.equal(modelCalls,4);
      scriptReviewedId = merged.body.version.id;
      assert.equal((await scriptApp.http.post(`${path}/retries`).set("authorization",bearer).send(retryInput).expect(201)).body.id,retryTaskId);
    } finally { await scriptApp.close(); assert.equal(scriptApp.scriptWorker!.status().state,"stopped"); }
    let qualityTaskId: string,lockedScriptId: string;
    const scriptRestart = await start(ca,false,false,true);
    try {
      const task = await scriptRestart.http.get(`/script-content-tasks/${scriptTaskId!}`).set("authorization",bearer).expect(200);
      const view = await scriptRestart.http.get(`/projects/${projectId}/chapters/${chapterId}/script-content`).set("authorization",bearer).expect(200);
      assert.equal(view.body.version.id,scriptReviewedId!); assert.notEqual(view.body.version.id,task.body.result.candidateVersionId); assert.equal(modelCalls,4);
      const retried = await scriptRestart.http.get(`/script-content-tasks/${retryTaskId!}`).set("authorization",bearer).expect(200);
      assert.equal(retried.body.result.candidateVersionId,view.body.version.id);
      const base = `/projects/${projectId}/chapters/${chapterId}/script-content`;
      const assessment = { configurationVersionId: version!,modelId: "m",requestId: "tls-quality",expectedActiveVersionId: view.body.version.id };
      qualityTaskId = (await scriptRestart.http.post(`${base}/quality`).set("authorization",bearer).send(assessment).expect(201)).body.id;
      let quality;
      for (let i=0;i<100;i++) {
        quality = await scriptRestart.http.get(`${base}/quality/${qualityTaskId}`).set("authorization",bearer).expect(200);
        if (["succeeded","failed","paused"].includes(quality.body.task.state)) break;
        await new Promise(resolve => setTimeout(resolve,20));
      }
      assert.equal(quality!.body.task.state,"succeeded",JSON.stringify(quality!.body));assert.equal(quality!.body.report.passed,true,JSON.stringify(quality!.body));
      assert.equal(modelCalls,5);
      const confirm = { kind: "confirm",requestId: "tls-confirm",reason: "核对合成样本",expectedActiveVersionId: view.body.version.id,reportId: qualityTaskId };
      const formal = await scriptRestart.http.post(`${base}/publication`).set("authorization",bearer).send(confirm).expect(201);
      const locked = await scriptRestart.http.post(`${base}/publication`).set("authorization",bearer).send({ kind: "lock",requestId: "tls-lock",reason: "锁定样本",expectedActiveVersionId: formal.body.id,elementIds: ["action"] }).expect(201);
      lockedScriptId = locked.body.id;
      assert.equal(locked.body.elements[0].lockedBy,userId);
      assert.equal((await scriptRestart.http.post(`${base}/publication`).set("authorization",bearer).send(confirm).expect(201)).body.id,formal.body.id);
    } finally { await scriptRestart.close(); }
    await admin.query("alter table script_content_versions disable trigger script_impacts_on_confirmation");
    try { await assert.rejects(() => start(ca,false,false,true),{ message: "SCRIPT_CONTENT_DATABASE_NOT_READY" }); }
    finally { await admin.query("alter table script_content_versions enable trigger script_impacts_on_confirmation"); }
    await admin.query("alter table script_quality_reports disable trigger script_quality_reports_immutable");
    try { await assert.rejects(() => start(ca,false,false,true),{ message: "SCRIPT_CONTENT_DATABASE_NOT_READY" }); }
    finally { await admin.query("alter table script_quality_reports enable trigger script_quality_reports_immutable"); }
    const publicationRestart = await start(ca,false,false,true);
    try {
      const base = `/projects/${projectId}/chapters/${chapterId}/script-content`;
      const view = await publicationRestart.http.get(base).set("authorization",bearer).expect(200);
      assert.equal(view.body.version.id,lockedScriptId!);assert.equal(view.body.version.status,"confirmed");assert.ok(view.body.version.elements[0].lockedAt);
      assert.equal((await publicationRestart.http.get(`${base}/quality/${qualityTaskId!}`).set("authorization",bearer).expect(200)).body.report.passed,true);
      assert.equal(modelCalls,5);
    } finally { await publicationRestart.close(); }
    await admin.query("alter table settings_candidate_versions disable trigger settings_candidates_immutable");
    try { await assert.rejects(() => start(ca,false,false,false,true),{ message: "SETTINGS_DATABASE_NOT_READY" }); }
    finally { await admin.query("alter table settings_candidate_versions enable trigger settings_candidates_immutable"); }
    await admin.query("revoke insert on script_downstream_dependencies from novel_app");
    try { await assert.rejects(() => start(ca,false,false,false,true),{ message: "SETTINGS_DATABASE_NOT_READY" }); }
    finally { await admin.query("grant insert on script_downstream_dependencies to novel_app"); }
    await admin.query("alter table settings_review_heads disable trigger settings_review_head_transition");
    try { await assert.rejects(() => start(ca,false,false,false,true),{ message: "SETTINGS_DATABASE_NOT_READY" }); }
    finally { await admin.query("alter table settings_review_heads enable trigger settings_review_head_transition"); }
    await admin.query("revoke execute on function lock_settings_review_authority(text,text,text) from novel_app");
    try { await assert.rejects(() => start(ca,false,false,false,true),{ message: "SETTINGS_DATABASE_NOT_READY" }); }
    finally { await admin.query("grant execute on function lock_settings_review_authority(text,text,text) to novel_app"); }
    await admin.query("alter table settings_review_versions disable trigger settings_regeneration_transition");
    try { await assert.rejects(start(ca,false,false,false,true),/SETTINGS_DATABASE_NOT_READY/); }
    finally { await admin.query("alter table settings_review_versions enable trigger settings_regeneration_transition"); }
    await admin.query("alter index settings_regeneration_job_idx rename to temporarily_missing_settings_regeneration_job_idx");
    try { await assert.rejects(start(ca,false,false,false,true),/SETTINGS_DATABASE_NOT_READY/); }
    finally { await admin.query("alter index temporarily_missing_settings_regeneration_job_idx rename to settings_regeneration_job_idx"); }
    const regenerationTrigger = (await admin.query("select pg_get_triggerdef(oid) definition from pg_trigger where tgname='settings_regeneration_transition'")).rows[0].definition;
    await admin.query("drop trigger settings_regeneration_transition on settings_review_versions;create trigger settings_regeneration_transition before insert on settings_review_versions for each row when (false) execute function guard_settings_pending_regeneration_version()");
    try { await assert.rejects(start(ca,false,false,false,true),/SETTINGS_DATABASE_NOT_READY/); }
    finally { await admin.query("drop trigger settings_regeneration_transition on settings_review_versions");await admin.query(regenerationTrigger); }
    await admin.query("alter table settings_review_versions disable trigger settings_reconciliation_transition");
    try { await assert.rejects(start(ca,false,false,false,true),/SETTINGS_DATABASE_NOT_READY/); }
    finally { await admin.query("alter table settings_review_versions enable trigger settings_reconciliation_transition"); }
    const reconciliationTrigger = (await admin.query("select pg_get_triggerdef(oid) definition from pg_trigger where tgname='settings_reconciliation_transition'")).rows[0].definition;
    await admin.query("drop trigger settings_reconciliation_transition on settings_review_versions;create trigger settings_reconciliation_transition before insert on settings_review_versions for each row when (false) execute function guard_settings_reconciliation_version()");
    try { await assert.rejects(start(ca,false,false,false,true),/SETTINGS_DATABASE_NOT_READY/); }
    finally { await admin.query("drop trigger settings_reconciliation_transition on settings_review_versions");await admin.query(reconciliationTrigger); }
    const settingsApp = await start(ca,false,false,false,true);
    let settingsTaskId: string,settingsCandidateId: string,settingsActiveId: string,regenerationTaskId: string,regenerationVersionId: string;
    try {
      const actor = { workspaceId,userId };
      const base = `/projects/${projectId}/chapters/${chapterId}/settings-tasks`;
      await settingsApp.http.post(base).send({ configurationVersionId: version!,modelId: "m",requestId: "tls-settings" }).expect(401);
      const task = (await settingsApp.http.post(base).set("authorization",bearer).send({ configurationVersionId: version!,modelId: "m",requestId: "tls-settings" }).expect(201)).body;
      settingsTaskId = task.id;
      let completed = task;
      for (let i=0;i<100;i++) {
        completed = (await settingsApp.http.get(`/settings-tasks/${task.id}`).set("authorization",bearer).expect(200)).body;
        if (["succeeded","failed","paused"].includes(completed.state)) break;
        await new Promise(resolve => setTimeout(resolve,20));
      }
      assert.equal(completed.state,"succeeded",JSON.stringify(completed));assert.equal(modelCalls,6);
      settingsCandidateId = completed.result!.candidateVersionId;
      const view = await settingsApp.http.get(`/projects/${projectId}/chapters/${chapterId}/settings/generations/${task.id}`).set("authorization",bearer).expect(200);
      assert.equal(view.body.version.id,settingsCandidateId);assert.equal(view.body.current,true);assert.equal(view.body.scriptVersion.id,lockedScriptId!);assert.equal(view.body.sourceFragments[0].text,"雨落");
      const dependencies = await admin.query("select script_version_id,target_item_id from script_downstream_dependencies where target_stage='settings' and target_version_id=$1",[settingsCandidateId]);
      assert.equal(dependencies.rows.length,2);assert.ok(dependencies.rows.every(d => d.script_version_id === lockedScriptId && d.target_item_id === "location"));
      const settingsBase = `/projects/${projectId}/chapters/${chapterId}/settings`;
      let reviewed = (await settingsApp.http.post(`${settingsBase}/review`).set("authorization",bearer).send({ kind: "edit",requestId: "tls-settings-edit",expectedActiveVersionId: settingsCandidateId,reason: "visible",assetId: "location",value: { ...view.body.version.assets[0],name: "雨中庭院" } }).expect(201)).body;
      assert.equal((await settingsApp.http.get(`${settingsBase}/operations/tls-settings-edit`).set("authorization",bearer).expect(200)).body.version.id,reviewed.id);
      reviewed = (await settingsApp.http.post(`${settingsBase}/review`).set("authorization",bearer).send({ kind: "confirm",requestId: "tls-settings-confirm",expectedActiveVersionId: reviewed.id,reason: "checked" }).expect(201)).body;
      reviewed = (await settingsApp.http.post(`${settingsBase}/review`).set("authorization",bearer).send({ kind: "lock",requestId: "tls-settings-lock",expectedActiveVersionId: reviewed.id,reason: "freeze",assetId: "location" }).expect(201)).body;
      assert.equal(reviewed.locks.location.lockedBy,userId);
      reviewed = (await settingsApp.http.post(`${settingsBase}/review`).set("authorization",bearer).send({ kind: "unlock",requestId: "tls-settings-unlock",expectedActiveVersionId: reviewed.id,reason: "revision",assetId: "location" }).expect(201)).body;
      settingsActiveId = reviewed.id;
      assert.equal((await settingsApp.http.get(`${settingsBase}/versions/confirmed`).set("authorization",bearer).expect(200)).body.version.id,settingsActiveId);
      const regenerationBase = `/projects/${projectId}/chapters/${chapterId}/settings-regeneration-tasks`;
      const regenerationInput = { configurationVersionId: version!,modelId: "m",requestId: "tls-regeneration",selection: { expectedActiveVersionId: settingsActiveId,assetIds: ["location"],failureScopeKeys: [],reason: "visible revision" } };
      await settingsApp.http.post(regenerationBase).send(regenerationInput).expect(401);
      const regeneration = (await settingsApp.http.post(regenerationBase).set("authorization",bearer).send(regenerationInput).expect(201)).body;
      regenerationTaskId = regeneration.id;
      assert.equal((await settingsApp.http.post(regenerationBase).set("authorization",bearer).send(regenerationInput).expect(201)).body.id,regeneration.id);
      assert.equal((await settingsApp.http.get(`${regenerationBase}/submissions/tls-regeneration`).set("authorization",bearer).expect(200)).body.id,regeneration.id);
      let regenerated = regeneration;
      for (let i=0;i<100;i++) {
        regenerated = await settingsApp.regenerationTasks!.get(actor,regeneration.id);
        if (["succeeded","failed","paused"].includes(regenerated.state)) break;
        await new Promise(resolve => setTimeout(resolve,20));
      }
      assert.equal(regenerated.state,"succeeded",JSON.stringify(regenerated));assert.equal(modelCalls,7);
      regenerationVersionId = regenerated.result!.candidateVersionId;
      const loadedRegeneration = await settingsApp.http.get(`${settingsBase}/regenerations/${regeneration.id}`).set("authorization",bearer).expect(200);
      assert.equal(loadedRegeneration.body.version.id,regenerationVersionId);assert.equal(loadedRegeneration.body.sourceFragments[0].text,"雨落");
      const regeneratedView = (await settingsApp.http.get(settingsBase).set("authorization",bearer).expect(200)).body;
      assert.equal(regeneratedView.version.id,regenerationVersionId);assert.equal(regeneratedView.version.assets[0].name,"重生庭院");assert.equal(regeneratedView.version.status,"candidate");
      assert.equal((await settingsApp.http.get(`${settingsBase}/versions/confirmed`).set("authorization",bearer).expect(200)).body.version.id,settingsActiveId);
      assert.equal((await admin.query("select count(*)::int n from script_downstream_dependencies where target_version_id=$1",[regenerationVersionId])).rows[0].n,2);
      await settingsApp.http.post(`/settings-regeneration-tasks/${regeneration.id}/run`).set("authorization",bearer).expect(404);
      // Persist a result but fail its final task-state acknowledgement; restart must only read it.
      await admin.query("create function fail_regeneration_ack_test() returns trigger language plpgsql as $$ begin if new.payload->'input'->>'resultType'='settingsRegeneration' and new.state='succeeded' then raise exception 'simulated lost task acknowledgement'; end if;return new;end $$");
      await admin.query("create trigger fail_regeneration_ack_test before update on model_tasks for each row execute function fail_regeneration_ack_test()");
      const uncertain = await settingsApp.regenerationTasks!.submitSettingsRegeneration(actor,{ projectId,chapterId,configurationVersionId: version!,modelId: "m",requestId: "tls-regeneration-unknown",selection: { expectedActiveVersionId: regenerationVersionId,assetIds: ["location"],failureScopeKeys: [],reason: "recover saved result" } });
      for (let i=0;i<100;i++) {
        const current = (await settingsApp.http.get(settingsBase).set("authorization",bearer).expect(200)).body.version;
        if (current.regeneration?.jobId === uncertain.id) { regenerationVersionId = current.id;break; }
        await new Promise(resolve => setTimeout(resolve,20));
      }
      assert.equal((await settingsApp.http.get(settingsBase).set("authorization",bearer).expect(200)).body.version.regeneration.jobId,uncertain.id);
      await settingsApp.regenerationWorker!.stop();
      assert.equal((await settingsApp.regenerationTasks!.get(actor,uncertain.id)).state,"running");
      await admin.query("update model_tasks set state='paused',reason='EXECUTION_UNCERTAIN',revision=revision+1,lease_expires_at=null where workspace_id=$1 and id=$2",[workspaceId,uncertain.id]);
      await admin.query("drop trigger fail_regeneration_ack_test on model_tasks;drop function fail_regeneration_ack_test()");
      regenerationTaskId = uncertain.id;assert.equal(modelCalls,8);

    } finally { await settingsApp.close();assert.equal(settingsApp.settingsWorker!.status().state,"stopped");assert.equal(settingsApp.regenerationWorker!.status().state,"stopped"); }
    const settingsRestart = await start(ca,false,false,false,true);
    try {
      const recovered = (await settingsRestart.http.get(`/settings-tasks/${settingsTaskId!}`).set("authorization",bearer).expect(200)).body;
      assert.equal(recovered.result?.candidateVersionId,settingsCandidateId!);assert.equal(modelCalls,8);
      const view = await settingsRestart.http.get(`/projects/${projectId}/chapters/${chapterId}/settings`).set("authorization",bearer).expect(200);
      assert.equal(view.body.version.id,regenerationVersionId!);assert.equal(view.body.version.status,"candidate");
      let regenerated = await settingsRestart.regenerationTasks!.get({ workspaceId,userId },regenerationTaskId!);
      for (let i=0;i<100 && regenerated.state!=="succeeded";i++) {
        await new Promise(resolve => setTimeout(resolve,20));
        regenerated = await settingsRestart.regenerationTasks!.get({ workspaceId,userId },regenerationTaskId!);
      }
      assert.equal(regenerated.state,"succeeded");
      assert.equal((await settingsRestart.http.get(`/projects/${projectId}/chapters/${chapterId}/settings-regeneration-tasks/submissions/tls-regeneration-unknown`).set("authorization",bearer).expect(200)).body.result.candidateVersionId,regenerationVersionId!);
      assert.equal(regenerated.result?.candidateVersionId,regenerationVersionId!);assert.equal(modelCalls,8);
      assert.equal((await settingsRestart.http.get(`/projects/${projectId}/chapters/${chapterId}/settings/generations/${settingsTaskId!}`).set("authorization",bearer).expect(200)).body.version.id,settingsCandidateId!);
    } finally { await settingsRestart.close(); }
    const impactApp = await start(ca,false,false,true,true);
    try {
      const settingsBase = `/projects/${projectId}/chapters/${chapterId}/settings`,scriptBase = `/projects/${projectId}/chapters/${chapterId}/script-content`;
      const setting = (await impactApp.http.get(settingsBase).set("authorization",bearer).expect(200)).body;
      assert.deepEqual(setting.impacts,[]);
      let locked = (await impactApp.http.post(`${settingsBase}/review`).set("authorization",bearer).send({ kind: "confirm",requestId: "impact-setting-confirm",reason: "checked",expectedActiveVersionId: setting.version.id }).expect(201)).body;
      locked = (await impactApp.http.post(`${settingsBase}/review`).set("authorization",bearer).send({ kind: "lock",requestId: "impact-setting-lock",reason: "preserve",expectedActiveVersionId: locked.id,assetId: "location" }).expect(201)).body;
      let revised = (await impactApp.http.post(`${scriptBase}/revision`).set("authorization",bearer).send({ kind: "unlock",requestId: "impact-script-unlock",reason: "revision",expectedActiveVersionId: lockedScriptId!,elementId: "action" }).expect(201)).body;
      revised = (await impactApp.http.post(`${scriptBase}/revision`).set("authorization",bearer).send({ kind: "suggest",requestId: "impact-script-suggest",reason: "revision",expectedActiveVersionId: revised.id,elementId: "action",text: "细雨洒落庭院" }).expect(201)).body;
      revised = (await impactApp.http.post(`${scriptBase}/revision`).set("authorization",bearer).send({ kind: "decide",requestId: "impact-script-decide",reason: "checked",expectedActiveVersionId: revised.id,suggestionId: revised.suggestions.find((s: { status: string }) => s.status === "pending").id,decision: "accepted" }).expect(201)).body;
      const qualityId = (await impactApp.http.post(`${scriptBase}/quality`).set("authorization",bearer).send({ configurationVersionId: version!,modelId: "m",requestId: "impact-quality",expectedActiveVersionId: revised.id }).expect(201)).body.id;
      let quality;
      for (let i=0;i<100;i++) {
        quality = (await impactApp.http.get(`${scriptBase}/quality/${qualityId}`).set("authorization",bearer).expect(200)).body;
        if (["succeeded","failed","paused"].includes(quality.task.state)) break;
        await new Promise(resolve => setTimeout(resolve,20));
      }
      assert.equal(quality.task.state,"succeeded");
      const confirmed = (await impactApp.http.post(`${scriptBase}/publication`).set("authorization",bearer).send({ kind: "confirm",requestId: "impact-script-confirm",reason: "checked",expectedActiveVersionId: revised.id,reportId: qualityId }).expect(201)).body;
      const impacted = await impactApp.http.get(settingsBase).set("authorization",bearer).expect(200);
      assert.deepEqual(impacted.body.version,locked);assert.equal(impacted.body.current,false);assert.equal(impacted.body.permissions.canEdit,false);
      assert.deepEqual(impacted.body.impacts,[{ confirmed_version_id: confirmed.id,source_version_id: lockedScriptId,source_element_id: "action",target_stage: "settings",target_version_id: locked.id,target_item_id: "location",status: "unreviewed" }]);
      const history = await impactApp.http.get(`${settingsBase}/versions/${locked.id}/impacts`).set("authorization",bearer).expect(200);
      assert.deepEqual(history.body,{ versionId: locked.id,impacts: impacted.body.impacts });assert.equal(history.headers["cache-control"],"no-store");
      await impactApp.http.get(`${settingsBase}/versions/missing/impacts`).set("authorization",bearer).expect(404);
      await impactApp.http.get(`${settingsBase}/versions/${locked.id}/impacts`).expect(401);
      assert.equal((await impactApp.http.get(`${settingsBase}/versions/confirmed`).set("authorization",bearer).expect(200)).body.version.id,locked.id);
      const preview = (await impactApp.http.get(`${settingsBase}/reconciliation`).set("authorization",bearer).expect(200)).body;
      assert.equal(preview.canBegin,true);
      const begin = { kind: "begin",requestId: "tls-reconciliation",expectedActiveVersionId: locked.id,expectedUpstreamConfirmedVersionIds: preview.upstreamConfirmedVersionIds,reason: "retain for new script" };
      await impactApp.http.post(`${settingsBase}/reconciliation`).send(begin).expect(401);
      const begun = (await impactApp.http.post(`${settingsBase}/reconciliation`).set("authorization",bearer).send(begin).expect(201)).body;
      assert.equal(begun.assets.length,0);assert.equal(begun.reconciliation.pendingAssets.length,1);
      assert.equal((await impactApp.http.get(`${settingsBase}/operations/${begin.requestId}`).set("authorization",bearer).expect(200)).body.version.id,begun.id);
      await impactApp.http.post(`${settingsBase}/review`).set("authorization",bearer).send({ kind: "confirm",requestId: "tls-pending-confirm",expectedActiveVersionId: begun.id,reason: "check" }).expect(409);
      const retained = (await impactApp.http.post(`${settingsBase}/reconciliation`).set("authorization",bearer).send({ ...begin,kind: "retain",assetId: "location",requestId: "tls-retain",expectedActiveVersionId: begun.id }).expect(201)).body;
      assert.deepEqual(retained.assets,locked.assets);assert.deepEqual(retained.locks,locked.locks);
      assert.equal((await impactApp.http.post(`${settingsBase}/reconciliation`).set("authorization",bearer).send(begin).expect(201)).body.id,begun.id);
      const final = (await impactApp.http.post(`${settingsBase}/review`).set("authorization",bearer).send({ kind: "confirm",requestId: "tls-reconfirm",expectedActiveVersionId: retained.id,reason: "checked" }).expect(201)).body;
      assert.equal((await impactApp.http.get(`${settingsBase}/versions/confirmed`).set("authorization",bearer).expect(200)).body.version.id,final.id);

    } finally { await impactApp.close(); }
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
