import { SettingsReconciliationService } from "../src/settings-reconciliation.ts";
import { PostgresSettingsRegenerationRepository } from "../src/postgres-settings-regeneration.ts";
import { SettingsRegenerationRunner } from "../src/settings-regeneration.ts";
import { PostgresSettingsReviewRepository } from "../src/postgres-settings-review.ts";
import { SettingsReviewService } from "../src/settings-review.ts";
import { PostgresSettingsCandidateRepository } from "../src/postgres-settings-candidates.ts";
import type { SettingsCandidate } from "../src/settings-runner.ts";
import { ScriptRevisionService } from "../src/script-revision.ts";
import { ScriptPublicationService,qualityBinding } from "../src/script-publication.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PostgresModelTaskRepository } from "../src/postgres-model-tasks.ts";
import type { ModelTask } from "../src/model-tasks.ts";
import { PostgresScriptContentRepository } from "../src/postgres-script-content.ts";
import { ScriptContentService } from "../src/script-content.ts";
import type { ScriptContentVersion } from "../src/script-content.ts";
import { PostgresScriptRepository } from "../src/postgres-episode-plan.ts";
import { ScriptUpstreamChangedError, type EpisodePlanVersion } from "../src/index.ts";

test("PostgreSQL script candidate survives reconstruction, CAS races and upstream changes with isolated task recovery", { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const { Pool } = createRequire(new URL("../../project-import/package.json", import.meta.url))("pg");
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const app = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: "-c role=novel_app" });
  const suffix = randomUUID(), actor = { userId: `owner-${suffix}`, workspaceId: `w-${suffix}` }, projectId = `p-${suffix}`, chapterId = `c-${suffix}`, sourceId = `s-${suffix}`, bibleId = `b-${suffix}`;
  try {
    for (const path of ["../../project-import/migrations/0001_project_import.sql", "../../story-knowledge/migrations/0001_story_knowledge.sql", "../migrations/0010_episode_plans.sql", "../migrations/0003_model_tasks.sql", "../migrations/0004_model_task_results.sql", "../migrations/0005_model_task_recovery.sql", "../migrations/0008_generation_policy_reason.sql", "../migrations/0013_script_content.sql", "../migrations/0014_script_review.sql", "../migrations/0015_script_retry.sql", "../migrations/0016_script_publication.sql", "../migrations/0017_script_confirmed_head.sql", "../migrations/0018_script_revision.sql", "../migrations/0019_script_revision_transitions.sql", "../migrations/0020_script_revision_confirmation.sql", "../migrations/0021_script_revision_change_scope.sql", "../migrations/0022_script_impacts.sql", "../migrations/0023_script_revision_lock_audit.sql", "../migrations/0024_script_revision_rejection.sql", "../migrations/0025_settings_candidates.sql", "../migrations/0026_settings_dependencies.sql", "../migrations/0027_settings_tasks.sql", "../migrations/0028_settings_review.sql", "../migrations/0029_settings_regeneration_tasks.sql", "../migrations/0030_settings_regeneration_results.sql", "../migrations/0031_settings_reconciliation.sql", "../migrations/0032_settings_source_reconciliation.sql", "../migrations/0033_settings_pending_regeneration.sql", "../migrations/0034_settings_failure_decisions.sql"]) await admin.query(await readFile(new URL(path, import.meta.url), "utf8"));
    await admin.query("insert into projects(id,workspace_id,owner_user_id,title,aspect_ratio,target_duration_seconds,narrative_mode,created_at) values($1,$2,$3,'作品','9:16',60,'dialogue',now())", [projectId, actor.workspaceId, actor.userId]);
    for (const [user, role] of [[actor.userId, "owner"], ["editor", "editor"], ["reviewer", "reviewer"]]) await admin.query("insert into project_members(project_id,workspace_id,user_id,role) values($1,$2,$3,$4)", [projectId, actor.workspaceId, user, role]);
    await admin.query("insert into chapters(project_id,id,title) values($1,$2,'雨落')", [projectId, chapterId]);
    await admin.query("insert into source_versions(project_id,chapter_id,id,ordinal,created_at,created_by,character_count,source_text) values($1,$2,$3,1,now(),$4,2,'雨落')", [projectId, chapterId, sourceId, actor.userId]);
    await admin.query("update chapters set active_source_version_id=$3 where project_id=$1 and id=$2", [projectId, chapterId, sourceId]);
    await admin.query("insert into story_knowledge_versions(id,workspace_id,project_id,chapter_id,source_version_id,extraction_job_id,created_at,created_by,extraction_status,status,version_json) values($1,$2,$3,$4,$5,'job',now(),$6,'succeeded','confirmed',$7::jsonb)", [bibleId, actor.workspaceId, projectId, chapterId, sourceId, actor.userId, JSON.stringify({ id: bibleId, status: "confirmed", sourceVersionId: sourceId })]);
    await admin.query("insert into story_bibles(id,workspace_id,project_id,chapter_id,version_id,bible_json) values($1,$2,$3,$4,$1,$5::jsonb)", [bibleId, actor.workspaceId, projectId, chapterId, JSON.stringify({ versionId: bibleId })]);
    await admin.query("select set_config('app.story_knowledge_operation','confirm',false)");
    await admin.query("insert into story_knowledge_heads(workspace_id,project_id,chapter_id,active_version_id,confirmed_version_id) values($1,$2,$3,$4,$4)", [actor.workspaceId, projectId, chapterId, bibleId]);
    const version: EpisodePlanVersion = { id: `plan-${suffix}`, parentVersionId: null, projectId, chapterId, sourceVersionId: sourceId, storyBibleVersionId: bibleId, targetDurationSeconds: 60, aspectRatio: "9:16", narrativeMode: "dialogue", episodes: [{ id: "e", ordinal: 1, title: "雨落", sourceFragmentIds: ["f"], coreEventFactIds: ["event"] }], majorAdaptationProposals: [], status: "candidate", createdBy: actor.userId, createdAt: "2026-10-06T00:00:00Z" };
    const repository = new PostgresScriptRepository(app);
    const generationOperation = { key: `generation:task-${suffix}`, fingerprint: "trusted-generation" };
    await repository.saveEpisodePlan(actor, version, null, generationOperation);
    assert.deepEqual(await new PostgresScriptRepository(app).findActiveEpisodePlan(actor, projectId, chapterId), version);
    assert.equal(await repository.findEpisodePlanVersion({ ...actor, workspaceId: "other" }, projectId, chapterId, version.id), null);
    assert.equal(await repository.findActiveEpisodePlan({ ...actor, userId: "outsider" }, projectId, chapterId), null);
    const next = { ...version, id: `next-${suffix}`, parentVersionId: version.id };
    const competing = await Promise.allSettled([repository.saveEpisodePlan(actor, next, version.id), repository.saveEpisodePlan(actor, { ...next, id: `loser-${suffix}` }, version.id)]);
    assert.equal(competing.filter(r => r.status === "fulfilled").length, 1);
    const active = (await repository.findActiveEpisodePlan(actor, projectId, chapterId))!;
    const confirmed = { ...active, id: `confirmed-${suffix}`, parentVersionId: active.id, status: "confirmed" as const, confirmedBy: actor.userId, confirmedAt: version.createdAt };
    await assert.rejects(() => repository.saveEpisodePlan({ ...actor, userId: "editor" }, { ...confirmed, createdBy: "editor", confirmedBy: "editor" }, active.id), { code: "FORBIDDEN" });
    await admin.query("update chapters set active_source_version_id=null where project_id=$1 and id=$2", [projectId, chapterId]);
    await assert.rejects(() => repository.saveEpisodePlan(actor, confirmed, active.id), ScriptUpstreamChangedError);
    await admin.query("update chapters set active_source_version_id=$3 where project_id=$1 and id=$2", [projectId, chapterId, sourceId]);
    const operation = { key: `confirmation:${active.id}`, fingerprint: "confirm" };
    await repository.saveEpisodePlan(actor, confirmed, active.id, operation);
    const content = new PostgresScriptContentRepository(app);
    const candidate: ScriptContentVersion = { id: `script-${suffix}`,parentVersionId: null,projectId,chapterId,sourceVersionId: sourceId,planVersionId: confirmed.id,jobId: `task-${suffix}`,status: "candidate",generationStatus: "partially_succeeded",createdBy: actor.userId,createdAt: "2026-10-29T00:00:00Z",scenes: [],elements: [],failures: [{ scopeKey: "action",code: "INVALID_ELEMENT",message: "invalid evidence",retryable: true }] };
    await content.save(actor,candidate,null);
    assert.deepEqual(await new PostgresScriptContentRepository(app).findActive(actor,projectId,chapterId),candidate);
    assert.deepEqual(await content.findGeneration(actor,projectId,chapterId,candidate.jobId),candidate);
    const editorCandidate = { ...candidate,id: `editor-${suffix}`,parentVersionId: candidate.id,createdBy: "editor" };
    await content.save({ ...actor,userId: "editor" },editorCandidate,candidate.id);
    const nextContent = { ...candidate,id: `edit-${suffix}`,parentVersionId: editorCandidate.id };
    const writes = await Promise.allSettled([content.save(actor,nextContent,editorCandidate.id),content.save(actor,{ ...nextContent,id: `loser-${suffix}` },editorCandidate.id)]);
    assert.equal(writes.filter(r => r.status === "fulfilled").length,1);
    assert.deepEqual(await new PostgresScriptContentRepository(app).findGeneration(actor,projectId,chapterId,candidate.jobId),candidate);
    assert.equal(await content.findActive({ ...actor,workspaceId: "other" },projectId,chapterId),null);
    assert.equal(await content.findGeneration({ ...actor,userId: "outsider" },projectId,chapterId,candidate.jobId),null);
    let sequence = 0;
    const review = new ScriptContentService({ repository: content,accessReader: { findProjectAccess: async a => ({ role: a.userId === "editor" ? "editor" : "owner" }) },
      contextReader: { findGenerationContext: async () => ({ sourceVersionId: sourceId,planVersionId: confirmed.id,fragments: [],approvedAdditionIds: [] }) },idGenerator: () => `review-${suffix}-${++sequence}`,clock: () => new Date("2026-10-29") });
    const beforeReview = (await content.findActive(actor,projectId,chapterId))!;
    const reviewCommand = { kind: "suggest" as const,requestId: "suggestion",expectedActiveVersionId: beforeReview.id,elementId: "action",text: "rain falls",reason: "visual" };
    // Save a valid editable element as a candidate before exercising the public review seam.
    const populated = { ...beforeReview,id: `populated-${suffix}`,parentVersionId: beforeReview.id,elements: [{ id: "action",sceneId: "scene",elementType: "action" as const,ordinal: 1,text: "rain",provenance: [] }] };
    await content.save(actor,populated,beforeReview.id);
    const suggested = await review.reviewCandidate({ ...actor,userId: "editor" },projectId,chapterId,{ ...reviewCommand,expectedActiveVersionId: populated.id });
    const rebuilt = new PostgresScriptContentRepository(app);
    assert.equal((await rebuilt.findActive(actor,projectId,chapterId))?.suggestions?.[0]?.text,"rain falls");
    const accepted = await review.reviewCandidate(actor,projectId,chapterId,{ kind: "decide",requestId: "accept",expectedActiveVersionId: suggested.id,suggestionId: suggested.suggestions![0]!.id,decision: "accepted",reason: "verified" });
    assert.equal(accepted.elements[0]!.text,"rain falls");
    assert.equal((await rebuilt.findReviewOperation(actor,projectId,chapterId,"accept"))?.id,accepted.id);
    for (const field of ["requestId","fingerprint","kind","targetId","reason"]) {
      const malformed = { ...accepted,id: `malformed-${field}-${suffix}`,parentVersionId: accepted.id,reviewOperation: { ...accepted.reviewOperation!,[field]: null } };
      await assert.rejects(() => admin.query("insert into script_content_versions(workspace_id,project_id,chapter_id,id,parent_version_id,source_version_id,plan_version_id,job_id,created_by,version_json) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)",[actor.workspaceId,projectId,chapterId,malformed.id,malformed.parentVersionId,sourceId,confirmed.id,malformed.jobId,actor.userId,JSON.stringify(malformed)]),{ code: "23514" });
    }
    const directEditor = { ...accepted,id: `forged-edit-${suffix}`,parentVersionId: accepted.id,createdBy: "editor",reviewOperation: { ...accepted.reviewOperation!,requestId: "forged" } };
    await assert.rejects(() => content.save({ ...actor,userId: "editor" },directEditor,accepted.id),{ code: "FORBIDDEN" });
    const { reviewOperation: _audit,...unreviewed } = accepted;
    const partial = { ...unreviewed,id: `partial-${suffix}`,parentVersionId: accepted.id,scenes: [{ id: "scene",episodeId: "e",ordinal: 1,title: "rain",environment: "outside",characters: [] }],failures: [{ scopeKey: "dialogue",code: "INVALID_ELEMENT",message: "missing",retryable: true }],generationStatus: "partially_succeeded" as const };
    await content.save(actor,partial,accepted.id);
    const retries = new ScriptContentService({ repository: content,contextReader: { findGenerationContext: async () => ({ sourceVersionId: sourceId,planVersionId: confirmed.id,confirmedPlan: confirmed,fragments: [{ id: "f",text: "雨落" }],approvedAdditionIds: [] }) },idGenerator: () => `retried-${suffix}`,clock: () => new Date("2026-10-29") });
    const merged = await retries.recordRetry(actor,{ projectId,chapterId,sourceVersionId: sourceId,planVersionId: confirmed.id,jobId: `retry-job-${suffix}`,retry: { expectedActiveVersionId: partial.id,retryOfJobId: partial.jobId,scopeKeys: ["dialogue"] },scenes: [],items: [{ scopeKey: "dialogue",value: { id: "dialogue",sceneId: "scene",elementType: "dialogue",ordinal: 2,text: "下雨了",provenance: [{ type: "source_fragment",sourceVersionId: sourceId,fragmentId: "f",transformation: "retained" }] } }] });
    assert.deepEqual(merged.elements[0],partial.elements[0]); assert.equal(merged.failures.length,0);
    assert.deepEqual(await rebuilt.findGeneration(actor,projectId,chapterId,merged.jobId),merged);
    await review.reviewCandidate(actor,projectId,chapterId,{ kind: "edit",requestId: "after-retry",expectedActiveVersionId: merged.id,elementId: "action",text: "edited after retry",reason: "visual" });
    assert.deepEqual(await rebuilt.findGeneration(actor,projectId,chapterId,merged.jobId),merged);
    const taskRepository = new PostgresModelTaskRepository(app);
    const queued: ModelTask = { id: `queue-a-${suffix}`,workspaceId: actor.workspaceId,createdBy: actor.userId,projectId,chapterId,parentTaskId: null,input: { stage: "script",resultType: "scriptContent",sourceVersionId: sourceId,upstreamConfirmedVersionIds: [confirmed.id,bibleId],retry: { expectedActiveVersionId: partial.id,retryOfJobId: partial.jobId,scopeKeys: ["dialogue"] },generationParameters: { targetDurationSeconds: 60,aspectRatio: "9:16",narrativeMode: "dialogue" } },model: { workspaceId: actor.workspaceId,configurationVersionId: "cfg",providerId: "deepseek",modelId: "m",processingRegion: "mainland" },state: "queued",revision: 0,reason: null,result: null,leaseExpiresAt: null };
    await taskRepository.insert(queued);
    await assert.rejects(() => taskRepository.insert({ ...queued,id: `queue-b-${suffix}` }),{ code: "STATE_CONFLICT" });
    const running = await taskRepository.transition(actor.workspaceId,queued.id,0,"running",null);
    const unknown = await taskRepository.transition(actor.workspaceId,queued.id,running.revision,"paused","EXECUTION_UNCERTAIN");
    await assert.rejects(() => taskRepository.insert({ ...queued,id: `queue-c-${suffix}` }),{ code: "STATE_CONFLICT" });
    await taskRepository.recover(actor.workspaceId,queued.id,unknown.revision,{ candidateVersionId: merged.id,extractionStatus: "succeeded" });
    await taskRepository.insert({ ...queued,id: `queue-after-recovery-${suffix}` });
    const currentScript = (await content.findActive(actor,projectId,chapterId))!;
    const { reviewOperation: _lastOperation,...cleanCurrentScript } = currentScript;
    const ready = { ...cleanCurrentScript,id: `quality-ready-${suffix}`,parentVersionId: currentScript.id,elements: currentScript.elements.map(e => ({ ...e,provenance: [{ type: "source_fragment" as const,sourceVersionId: sourceId,fragmentId: "f",transformation: "retained" as const }] })) };
    await content.save(actor,ready,currentScript.id);
    assert.equal(await rebuilt.findRevisionOperation(actor,projectId,chapterId,"missing"),null);
    const qualityContext = { sourceVersionId: sourceId,planVersionId: confirmed.id,confirmedPlan: confirmed,confirmedStoryKnowledge: { versionId: bibleId,facts: [{ id: "event",statement: "雨落" }] },fragments: [{ id: "f",text: "雨落" }],approvedAdditionIds: [] };
    const contextReader = { findGenerationContext: async () => qualityContext };
    const accessReader = { findProjectAccess: async (a: typeof actor) => ({ role: a.userId === "editor" ? "editor" as const : "owner" as const }) };
    const formalService = new ScriptContentService({ repository: rebuilt,contextReader,accessReader,idGenerator: () => `formal-${suffix}-${++sequence}`,clock: () => new Date("2026-11-02") });
    const publication = new ScriptPublicationService({ repository: rebuilt,contextReader,accessReader,content: formalService });
    const report = await publication.assess(actor,projectId,chapterId,{ jobId: `report-${suffix}`,binding: qualityBinding(ready,qualityContext),model: { async assess() { return { versionId: ready.id,events: [{ factId: "event",elementIds: ["action"],verdict: "covered" }],facts: [{ factId: "event",verdict: "consistent" }],episodes: [{ episodeId: "e",estimatedSeconds: 60 }],unsupportedCoreFactElementIds: [] }; } } });
    assert.equal(report.passed,true);
    assert.deepEqual(await new PostgresScriptContentRepository(app).findQualityReport(actor,projectId,chapterId,report.id),report);
    assert.equal(await rebuilt.findQualityReport({ ...actor,workspaceId: "other" },projectId,chapterId,report.id),null);
    await assert.rejects(() => rebuilt.saveQualityReport({ ...actor,userId: "editor" },{ ...report,id: `forged-report-${suffix}`,createdBy: "editor" }),{ code: "FORBIDDEN" });
    const confirmation = { kind: "confirm" as const,reason: "已核对质量与原文",requestId: "formal-confirmation",expectedActiveVersionId: ready.id,reportId: report.id };
    await assert.rejects(() => publication.execute({ ...actor,userId: "editor" },projectId,chapterId,confirmation),{ code: "FORBIDDEN" });
    await admin.query("update projects set target_duration_seconds=180 where id=$1",[projectId]);
    await assert.rejects(() => publication.execute(actor,projectId,chapterId,confirmation),{ code: "CONTEXT_NOT_FOUND" });
    assert.equal((await rebuilt.findActive(actor,projectId,chapterId))?.id,ready.id);
    await admin.query("update projects set target_duration_seconds=60 where id=$1",[projectId]);
    const confirmedScript = await publication.execute(actor,projectId,chapterId,confirmation);
    assert.equal(confirmedScript.status,"confirmed");
    assert.deepEqual(await rebuilt.findConfirmed(actor,projectId,chapterId),confirmedScript);
    assert.deepEqual(await rebuilt.findVersion(actor,projectId,chapterId,ready.id),ready);
    assert.equal(await rebuilt.findVersion({ ...actor,workspaceId: "other" },projectId,chapterId,ready.id),null);
    const lockCommand = { kind: "lock" as const,reason: "冻结审核结果",requestId: "formal-lock",expectedActiveVersionId: confirmedScript.id,elementIds: ["action"] };
    const lockedScript = await publication.execute(actor,projectId,chapterId,lockCommand);
    assert.equal(lockedScript.elements.find(e => e.id === "action")?.lockedBy,actor.userId);
    assert.equal((await publication.execute(actor,projectId,chapterId,confirmation)).id,confirmedScript.id);
    assert.equal((await publication.execute(actor,projectId,chapterId,lockCommand)).id,lockedScript.id);
    assert.deepEqual(await new PostgresScriptContentRepository(app).findActive(actor,projectId,chapterId),lockedScript);
    assert.deepEqual(await new PostgresScriptContentRepository(app).findConfirmed(actor,projectId,chapterId),lockedScript);
    await assert.rejects(() => content.save(actor,{ ...lockedScript,id: `rewrite-${suffix}`,parentVersionId: lockedScript.id,publicationOperation: { ...lockedScript.publicationOperation!,requestId: "forged-rewrite" },elements: [] },lockedScript.id),{ code: "FORBIDDEN" });
    const revision = new ScriptRevisionService({ repository: rebuilt,contextReader,accessReader,idGenerator: () => `revision-${suffix}-${++sequence}`,clock: () => new Date("2026-11-02") });
    const unlocked = await revision.execute(actor,projectId,chapterId,{ kind: "unlock",requestId: "unlock",reason: "修订",expectedActiveVersionId: lockedScript.id,elementId: "action" });
    const relocked = await publication.execute(actor,projectId,chapterId,{ kind: "lock",requestId: "relock",reason: "重新锁定",expectedActiveVersionId: unlocked.id,elementIds: ["action"] });
    assert.ok(relocked.elements.find(e => e.id === "action")?.lockedAt);
    const unlockedAgain = await revision.execute(actor,projectId,chapterId,{ kind: "unlock",requestId: "unlock-again",reason: "继续修订",expectedActiveVersionId: relocked.id,elementId: "action" });
    const proposedForRejection = await revision.execute(actor,projectId,chapterId,{ kind: "suggest",requestId: "rejection-suggestion",reason: "待核对",expectedActiveVersionId: unlockedAgain.id,elementId: "action",text: "不采用" });
    const lockedWithSuggestion = await publication.execute(actor,projectId,chapterId,{ kind: "lock",requestId: "lock-pending",reason: "保留原内容",expectedActiveVersionId: proposedForRejection.id,elementIds: ["action"] });
    const rejected = await revision.execute(actor,projectId,chapterId,{ kind: "decide",requestId: "reject-locked",reason: "不采用建议",expectedActiveVersionId: lockedWithSuggestion.id,suggestionId: proposedForRejection.suggestions!.find(s => s.status === "pending")!.id,decision: "rejected" });
    assert.deepEqual(rejected.elements,lockedWithSuggestion.elements);
    const available = await revision.execute(actor,projectId,chapterId,{ kind: "unlock",requestId: "unlock-final",reason: "修订",expectedActiveVersionId: rejected.id,elementId: "action" });
    const suggestedFormal = await revision.execute({ ...actor,userId: "editor" },projectId,chapterId,{ kind: "suggest",requestId: "formal-suggestion",reason: "节奏",expectedActiveVersionId: available.id,elementId: "action",text: "雨落庭院" });
    const pending = suggestedFormal.suggestions!.find(s => s.status === "pending")!;
    const accept = { kind: "decide" as const,requestId: "revision-accept",reason: "符合原文",expectedActiveVersionId: suggestedFormal.id,suggestionId: pending.id,decision: "accepted" as const };
    const revisionCandidate = await revision.execute(actor,projectId,chapterId,accept);
    assert.equal(revisionCandidate.status,"candidate");assert.equal(revisionCandidate.elements.find(e => e.id === "action")?.text,"雨落庭院");
    assert.equal((await rebuilt.findConfirmed(actor,projectId,chapterId))?.id,suggestedFormal.id);
    assert.equal((await revision.execute(actor,projectId,chapterId,accept)).id,revisionCandidate.id);
    await admin.query("insert into script_downstream_dependencies values($1,$2,$3,'storyboard','board-version','shot-1',$4,'action')",[actor.workspaceId,projectId,chapterId,lockedScript.id]);
    assert.equal((await rebuilt.listImpacts(actor,projectId,chapterId,revisionCandidate.id)).length,0);
    const revisedReport = await publication.assess(actor,projectId,chapterId,{ jobId: `revised-report-${suffix}`,binding: qualityBinding(revisionCandidate,qualityContext),model: { async assess() { return { versionId: revisionCandidate.id,events: [{ factId: "event",elementIds: ["action"],verdict: "covered" }],facts: [{ factId: "event",verdict: "consistent" }],episodes: [{ episodeId: "e",estimatedSeconds: 60 }],unsupportedCoreFactElementIds: [] }; } } });
    const revisedFormal = await publication.execute(actor,projectId,chapterId,{ kind: "confirm",requestId: "revision-confirm",reason: "重新审核通过",expectedActiveVersionId: revisionCandidate.id,reportId: revisedReport.id });
    assert.equal(revisedFormal.status,"confirmed");
    const impacts = await rebuilt.listImpacts(actor,projectId,chapterId,revisedFormal.id);
    assert.equal(impacts.length,1);assert.equal(impacts[0]!.status,"unreviewed");assert.equal(impacts[0]!.target_item_id,"shot-1");
    assert.equal((await rebuilt.listImpacts({ ...actor,workspaceId: "other" },projectId,chapterId,revisedFormal.id)).length,0);
    assert.equal((await rebuilt.findConfirmed(actor,projectId,chapterId))?.id,revisedFormal.id);
    assert.equal((await rebuilt.findVersion(actor,projectId,chapterId,suggestedFormal.id))?.elements.find(e => e.id === "action")?.text,"edited after retry");
    const settingsQueued: ModelTask = { ...queued,id: `settings-queued-${suffix}`,input: { sourceVersionId: sourceId,generationParameters: queued.input.generationParameters,stage: "settings",resultType: "settingsContent",upstreamConfirmedVersionIds: [revisedFormal.id,confirmed.id,bibleId] } };
    await taskRepository.insert(settingsQueued);
    assert.deepEqual((await taskRepository.scanSettings(actor.workspaceId,"run",{ limit: 20,cursor: null })).tasks.map(t => t.id),[settingsQueued.id]);
    assert.deepEqual((await taskRepository.listSettings(actor.workspaceId,projectId,chapterId,{ limit: 20,cursor: null })).tasks.map(t => t.id),[settingsQueued.id]);
    assert.equal((await taskRepository.scanSettings("other","run",{ limit: 20,cursor: null })).tasks.length,0);
    await taskRepository.transition(actor.workspaceId,settingsQueued.id,0,"running",null);
    await taskRepository.transition(actor.workspaceId,settingsQueued.id,1,"paused","EXECUTION_UNCERTAIN");
    assert.deepEqual((await taskRepository.scanSettings(actor.workspaceId,"recover",{ limit: 20,cursor: null })).tasks.map(t => t.id),[settingsQueued.id]);
    const settingsHandoff = { async read() { return { version: revisedFormal,sourceFragments: [{ id: "f",text: "rain" }],upstreamConfirmedVersionIds: [confirmed.id,bibleId] }; } };
    const settingsRepo = new PostgresSettingsCandidateRepository(app,settingsHandoff);
    const generatedSettings: SettingsCandidate = { id: `generated-settings-${suffix}`,projectId,chapterId,sourceVersionId: sourceId,scriptVersionId: revisedFormal.id,jobId: `generated-settings-job-${suffix}`,createdBy: actor.userId,createdAt: "2026-11-03T00:00:00Z",status: "candidate",generationStatus: "succeeded",assets: [{ id: "rain-location",assetType: "location",name: "courtyard",visibleDefinition: { weather: "rain" },state: "",stateChanges: [],restrictions: [],provenance: [{ type: "source_fragment",sourceVersionId: sourceId,fragmentId: "f",transformation: "retained" }] }],failures: [],upstreamConfirmedVersionIds: [revisedFormal.id,confirmed.id,bibleId] };
    await admin.query("create function fail_settings_dependency_test() returns trigger language plpgsql as $$ begin raise exception 'simulated storage failure'; end $$");
    await admin.query("create trigger fail_settings_dependency_test before insert on script_downstream_dependencies for each row execute function fail_settings_dependency_test()");
    await assert.rejects(() => settingsRepo.saveGeneration(actor,generatedSettings),{ code: "STORAGE_UNAVAILABLE" });
    assert.equal(await settingsRepo.findGeneration(actor,projectId,chapterId,generatedSettings.jobId),null);
    assert.equal(await settingsRepo.findActive(actor,projectId,chapterId),null);
    await admin.query("drop trigger fail_settings_dependency_test on script_downstream_dependencies; drop function fail_settings_dependency_test()");
    await admin.query("update chapters set active_source_version_id=null where project_id=$1 and id=$2",[projectId,chapterId]);
    await assert.rejects(() => settingsRepo.saveGeneration(actor,generatedSettings),{ code: "UPSTREAM_CHANGED" });
    await admin.query("update chapters set active_source_version_id=$3 where project_id=$1 and id=$2",[projectId,chapterId,sourceId]);
    const results = await Promise.allSettled([settingsRepo.saveGeneration(actor,generatedSettings),settingsRepo.saveGeneration(actor,{ ...generatedSettings,id: `competing-settings-${suffix}`,jobId: `competing-settings-job-${suffix}` })]);
    assert.equal(results.filter(r => r.status === "fulfilled").length,1);
    assert.equal(results.filter(r => r.status === "rejected" && r.reason.code === "CANDIDATE_EXISTS").length,1);
    const savedSettings = results.find(r => r.status === "fulfilled")!.value;
    const reopenedSettings = new PostgresSettingsCandidateRepository(app,settingsHandoff);
    assert.deepEqual(await reopenedSettings.findGeneration(actor,projectId,chapterId,savedSettings.jobId),savedSettings);
    assert.deepEqual(await reopenedSettings.findActive(actor,projectId,chapterId),savedSettings);
    assert.deepEqual(await reopenedSettings.saveGeneration(actor,{ ...savedSettings,id: "replayed-id" }),savedSettings);
    assert.equal(await reopenedSettings.findActive({ ...actor,workspaceId: "other" },projectId,chapterId),null);
    assert.equal(await reopenedSettings.findGeneration({ ...actor,userId: "outsider" },projectId,chapterId,savedSettings.jobId),null);
    await assert.rejects(() => reopenedSettings.saveGeneration(actor,{ ...generatedSettings,scriptVersionId: lockedScript.id }),{ code: "UPSTREAM_CHANGED" });
    assert.deepEqual((await admin.query("select target_item_id,script_element_id from script_downstream_dependencies where target_stage='settings' and target_version_id=$1 order by script_element_id",[savedSettings.id])).rows,[{ target_item_id: "rain-location",script_element_id: "action" },{ target_item_id: "rain-location",script_element_id: "dialogue" }]);
    await admin.query("insert into source_fragments(id,project_id,chapter_id,text_content,content_hash) values('f',$1,$2,'雨落','fixture')",[projectId,chapterId]);
    await admin.query("insert into source_version_fragments values($1,'f',$2,$3,1,0,2)",[sourceId,projectId,chapterId]);
    const settingsReviewRepo = new PostgresSettingsReviewRepository(app,settingsHandoff);
    const settingsReview = new SettingsReviewService({ repository: settingsReviewRepo,handoff: settingsHandoff,access: accessReader,idGenerator: () => `settings-review-${suffix}-${++sequence}`,clock: () => new Date("2026-11-04") });
    const initialSettings = (await settingsReviewRepo.findActive(actor,projectId,chapterId))!;
    const settingAsset = initialSettings.assets[0]!;
    const editSettings = { kind: "edit" as const,requestId: "edit-settings",expectedActiveVersionId: initialSettings.id,reason: "visible",assetId: settingAsset.id,value: { ...settingAsset,name: "rain courtyard" } };
    await assert.rejects(() => settingsReview.execute({ ...actor,userId: "editor" },projectId,chapterId,editSettings),{ code: "FORBIDDEN" });
    const collisionReview = new SettingsReviewService({ repository: settingsReviewRepo,handoff: settingsHandoff,access: accessReader,idGenerator: () => savedSettings.id,clock: () => new Date("2026-11-04") });
    await assert.rejects(() => collisionReview.execute(actor,projectId,chapterId,{ ...editSettings,requestId: "settings-id-collision" }),{ code: "VERSION_CONFLICT" });
    await admin.query("create function fail_settings_review_dependency_test() returns trigger language plpgsql as $$ begin raise exception 'simulated review dependency failure'; end $$");
    await admin.query("create trigger fail_settings_review_dependency_test before insert on script_downstream_dependencies for each row execute function fail_settings_review_dependency_test()");
    await assert.rejects(() => settingsReview.execute(actor,projectId,chapterId,editSettings),{ code: "STORAGE_UNAVAILABLE" });
    assert.equal((await settingsReviewRepo.findActive(actor,projectId,chapterId))!.id,initialSettings.id);
    assert.equal(await settingsReviewRepo.findOperation(actor,projectId,chapterId,editSettings.requestId),null);
    await admin.query("drop trigger fail_settings_review_dependency_test on script_downstream_dependencies; drop function fail_settings_review_dependency_test()");
    const editedSettings = await settingsReview.execute({ ...actor,userId: "reviewer" },projectId,chapterId,editSettings);
    assert.deepEqual(await new PostgresSettingsReviewRepository(app,settingsHandoff).findActive(actor,projectId,chapterId),editedSettings);
    assert.equal((await settingsReview.execute({ ...actor,userId: "reviewer" },projectId,chapterId,editSettings)).id,editedSettings.id);
    assert.equal((await new PostgresSettingsCandidateRepository(app,settingsHandoff).findGeneration(actor,projectId,chapterId,savedSettings.jobId))!.id,savedSettings.id);
    let reviewedSettings = await settingsReview.execute({ ...actor,userId: "editor" },projectId,chapterId,{ kind: "suggest",requestId: "suggest-settings",expectedActiveVersionId: editedSettings.id,reason: "detail",assetId: settingAsset.id,value: { ...settingAsset,name: "new courtyard" } });
    reviewedSettings = await settingsReview.execute(actor,projectId,chapterId,{ kind: "decide",requestId: "accept-settings",expectedActiveVersionId: reviewedSettings.id,reason: "checked",suggestionId: reviewedSettings.suggestions[0]!.id,decision: "accepted" });
    reviewedSettings = await settingsReview.execute(actor,projectId,chapterId,{ kind: "confirm",requestId: "confirm-settings",expectedActiveVersionId: reviewedSettings.id,reason: "checked" });
    assert.equal((await settingsReviewRepo.findConfirmed(actor,projectId,chapterId))!.id,reviewedSettings.id);
    reviewedSettings = await settingsReview.execute(actor,projectId,chapterId,{ kind: "lock",requestId: "lock-settings",expectedActiveVersionId: reviewedSettings.id,reason: "freeze",assetId: settingAsset.id });
    assert.ok(reviewedSettings.locks[settingAsset.id]);
    reviewedSettings = await settingsReview.execute(actor,projectId,chapterId,{ kind: "unlock",requestId: "unlock-settings",expectedActiveVersionId: reviewedSettings.id,reason: "revision",assetId: settingAsset.id });
    reviewedSettings = await settingsReview.execute({ ...actor,userId: "editor" },projectId,chapterId,{ kind: "suggest",requestId: "formal-settings",expectedActiveVersionId: reviewedSettings.id,reason: "revision",assetId: settingAsset.id,value: settingAsset });
    const formalSettingsId = reviewedSettings.id;
    reviewedSettings = await settingsReview.execute(actor,projectId,chapterId,{ kind: "decide",requestId: "accept-formal-settings",expectedActiveVersionId: reviewedSettings.id,reason: "checked",suggestionId: reviewedSettings.suggestions.find(s => s.status === "pending")!.id,decision: "accepted" });
    assert.equal(reviewedSettings.status,"candidate");assert.equal((await settingsReviewRepo.findConfirmed(actor,projectId,chapterId))!.id,formalSettingsId);
    const competingSettings = await Promise.allSettled([settingsReview.execute(actor,projectId,chapterId,{ ...editSettings,requestId: "settings-race-a",expectedActiveVersionId: reviewedSettings.id }),settingsReview.execute(actor,projectId,chapterId,{ ...editSettings,requestId: "settings-race-b",expectedActiveVersionId: reviewedSettings.id })]);
    assert.equal(competingSettings.filter(r => r.status === "fulfilled").length,1);
    assert.equal(await settingsReviewRepo.findActive({ ...actor,workspaceId: "other" },projectId,chapterId),null);
    assert.equal(await settingsReviewRepo.findConfirmed({ ...actor,userId: "outsider" },projectId,chapterId),null);
    const stableSettings = (await settingsReviewRepo.findActive(actor,projectId,chapterId))!;
    await admin.query("update chapters set active_source_version_id=null where project_id=$1 and id=$2",[projectId,chapterId]);
    await assert.rejects(() => settingsReview.execute(actor,projectId,chapterId,{ ...editSettings,requestId: "settings-stale-source",expectedActiveVersionId: stableSettings.id }),{ code: "UPSTREAM_CHANGED" });
    await admin.query("update chapters set active_source_version_id=$3 where project_id=$1 and id=$2",[projectId,chapterId,sourceId]);
    await admin.query("insert into source_versions(project_id,chapter_id,id,ordinal,created_at,created_by,character_count,source_text) values($1,$2,'123',2,now(),$3,2,'雨落')",[projectId,chapterId,actor.userId]);
    await admin.query("insert into source_fragments(id,project_id,chapter_id,text_content,content_hash) values('42',$1,$2,'雨落','numeric-id-fixture')",[projectId,chapterId]);
    await admin.query("insert into source_version_fragments values('123','42',$1,$2,1,0,2)",[projectId,chapterId]);
    const regenerationTask: ModelTask = { ...settingsQueued,id: `regeneration-task-${suffix}`,input: { ...settingsQueued.input,resultType: "settingsRegeneration",regeneration: { expectedActiveVersionId: stableSettings.id,assetIds: [settingAsset.id],failureScopeKeys: [],reason: "visible" } } };
    await taskRepository.insert(regenerationTask);
    assert.deepEqual((await taskRepository.scanSettingsRegeneration(actor.workspaceId,"run",{ limit: 20,cursor: null })).tasks.map(t => t.id),[regenerationTask.id]);
    await assert.rejects(() => taskRepository.insert({ ...regenerationTask,id: `duplicate-regeneration-${suffix}` }),{ code: "STATE_CONFLICT" });
    await taskRepository.transition(actor.workspaceId,regenerationTask.id,0,"running",null);
    let generatedRegeneration: Awaited<ReturnType<SettingsRegenerationRunner["run"]>> | undefined;
    let proposedRegeneration: typeof generatedRegeneration;
    const regenerationRepository = new PostgresSettingsRegenerationRepository(app,settingsHandoff);
    let regenerationCalls = 0;
    const regenerationRunner = new SettingsRegenerationRunner({ repository: { findActive: (...args) => regenerationRepository.findActive(...args),findGeneration: (...args) => regenerationRepository.findGeneration(...args),saveGeneration: async (a,v,e) => { proposedRegeneration = structuredClone(v);return regenerationRepository.saveGeneration(a,v,e); } },handoff: settingsHandoff,access: accessReader,idGenerator: () => `regenerated-${suffix}-${++sequence}`,clock: () => new Date("2026-11-04"),model: { async generate(r) {
      regenerationCalls++;
      return { contractVersion: "0.1.0",stage: "settings",jobId: r.jobId,projectId,chapterId,sourceVersionId: sourceId,upstreamConfirmedVersionIds: r.upstreamConfirmedVersionIds,status: "succeeded",items: r.regeneration.targets.map(t => ({ scopeKey: t.scopeKey,status: "succeeded",value: { ...t.asset!,name: "regenerated courtyard" } })) };
    } } });
    await admin.query("create function fail_settings_review_dependency_test() returns trigger language plpgsql as $$ begin raise exception 'simulated dependency failure'; end $$");
    await admin.query("create trigger fail_settings_regeneration_dependency_test before insert on script_downstream_dependencies for each row execute function fail_settings_review_dependency_test()");
    await assert.rejects(() => regenerationRunner.run(actor,projectId,chapterId,regenerationTask.id,regenerationTask.input.regeneration!),{ code: "EXECUTION_UNCERTAIN" });
    assert.equal((await regenerationRepository.findActive(actor,projectId,chapterId))!.id,stableSettings.id);
    assert.equal(await regenerationRepository.findGeneration(actor,projectId,chapterId,regenerationTask.id),null);
    await admin.query("drop trigger fail_settings_regeneration_dependency_test on script_downstream_dependencies; drop function fail_settings_review_dependency_test()");
    // Raw application-role writes must obey the same boundaries even if the service is bypassed.
    const proposed = proposedRegeneration!;
    const rawRegeneration = async (v: typeof proposed) => {
      const client = await app.connect();
      try {
        await client.query("begin");
        await client.query("select set_config('app.current_user_id',$1,true),set_config('app.current_workspace_id',$2,true),set_config('app.model_workspace_id',$2,true)",[actor.userId,actor.workspaceId]);
        await client.query("insert into settings_review_versions(workspace_id,project_id,chapter_id,id,origin_version_id,parent_review_id,created_by,version_json) values($1,$2,$3,$4,$5,$6,$7,$8::jsonb)",[actor.workspaceId,projectId,chapterId,v.id,savedSettings.id,stableSettings.id,v.createdBy,JSON.stringify(v)]);
      } finally { await client.query("rollback");client.release(); }
    };
    for (const forged of [
      { ...proposed,regeneration: { ...proposed.regeneration!,jobId: "missing-task" } },
      { ...proposed,regeneration: { ...proposed.regeneration!,outcome: "failed" as const } },
      { ...proposed,regeneration: { ...proposed.regeneration!,assetIds: [] } },
      { ...proposed,assets: [...proposed.assets,{ ...settingAsset,id: "unselected" }] },
      { ...proposed,locks: { injected: { lockedBy: actor.userId,lockedAt: proposed.createdAt } } },
      { ...proposed,assets: [{ ...proposed.assets[0]!,assetType: "prop" as const }] },
      { ...proposed,assets: [{ ...proposed.assets[0]!,provenance: [] }] },
      { ...proposed,assets: [{ ...proposed.assets[0]!,name: "ok"+" ".repeat(20000) }] },
      { ...proposed,assets: [{ ...proposed.assets[0]!,name: "😀".repeat(10001) }] },
      { ...proposed,assets: [{ ...proposed.assets[0]!,visibleDefinition: Array.from({ length: 21 }).reduce<Record<string,unknown>>((child) => ({ child }),{ leaf: true }) }] },
      { ...proposed,assets: [{ ...proposed.assets[0]!,name: "\u00a0\u3000" }] },
      { ...proposed,createdBy: "editor" },
    ]) await assert.rejects(() => rawRegeneration(forged),{ code: "42501" });
    await taskRepository.transition(actor.workspaceId,regenerationTask.id,1,"paused","UPSTREAM_CHANGED");
    await assert.rejects(() => rawRegeneration(proposed),{ code: "42501" });
    // Resume through a fresh task: paused known failures cannot serve as a result-write capability.
    const writeTask: ModelTask = { ...regenerationTask,id: `regeneration-write-${suffix}` };
    await taskRepository.insert(writeTask);
    await taskRepository.transition(actor.workspaceId,writeTask.id,0,"running",null);
    generatedRegeneration = await regenerationRunner.run(actor,projectId,chapterId,writeTask.id,regenerationTask.input.regeneration!);
    assert.equal(generatedRegeneration.assets[0]!.name,"regenerated courtyard");
    assert.equal((await settingsReviewRepo.findConfirmed(actor,projectId,chapterId))!.id,formalSettingsId);
    assert.equal((await admin.query("select count(*)::int as n from script_downstream_dependencies where target_version_id=$1",[generatedRegeneration.id])).rows[0].n,2);
    const reopenedRegeneration = new PostgresSettingsRegenerationRepository(app,settingsHandoff);
    assert.deepEqual(await reopenedRegeneration.findGeneration(actor,projectId,chapterId,writeTask.id),generatedRegeneration);
    assert.equal(await reopenedRegeneration.findGeneration({ ...actor,workspaceId: "other" },projectId,chapterId,writeTask.id),null);
    assert.equal(await reopenedRegeneration.findGeneration({ ...actor,userId: "reviewer" },projectId,chapterId,writeTask.id),null);
    assert.deepEqual(await regenerationRunner.run(actor,projectId,chapterId,writeTask.id,regenerationTask.input.regeneration!),generatedRegeneration);
    assert.equal(regenerationCalls,2);
    await taskRepository.transition(actor.workspaceId,writeTask.id,1,"paused","EXECUTION_UNCERTAIN");
    await assert.rejects(() => taskRepository.insert({ ...regenerationTask,id: `uncertain-bypass-${suffix}` }),{ code: "STATE_CONFLICT" });
    const reopenedTasks = new PostgresModelTaskRepository(app);
    assert.deepEqual((await reopenedTasks.find(actor.workspaceId,writeTask.id))!.input.regeneration,regenerationTask.input.regeneration);
    assert.deepEqual((await reopenedTasks.scanSettingsRegeneration(actor.workspaceId,"recover",{ limit: 20,cursor: null })).tasks.map(t => t.id),[writeTask.id]);
    assert.equal((await reopenedTasks.scanSettingsRegeneration("other","recover",{ limit: 20,cursor: null })).tasks.length,0);
    await assert.rejects(() => reopenedTasks.recover(actor.workspaceId,writeTask.id,2,null),{ code: "STATE_CONFLICT" });
    // Failed replacement retains the old asset; a later selected-failure retry clears only that failure.
    const failureSelection = { ...regenerationTask.input.regeneration!,expectedActiveVersionId: generatedRegeneration.id };
    const failureTask: ModelTask = { ...regenerationTask,id: `regeneration-failure-${suffix}`,input: { ...regenerationTask.input,regeneration: failureSelection } };
    await taskRepository.insert(failureTask);await taskRepository.transition(actor.workspaceId,failureTask.id,0,"running",null);
    const failingRunner = new SettingsRegenerationRunner({ repository: regenerationRepository,handoff: settingsHandoff,access: accessReader,idGenerator: () => `failed-regeneration-${suffix}`,clock: () => new Date("2026-11-04"),model: { async generate(r) {
      return { contractVersion: r.contractVersion,stage: r.stage,jobId: r.jobId,projectId,chapterId,sourceVersionId: sourceId,upstreamConfirmedVersionIds: r.upstreamConfirmedVersionIds,status: "failed",items: r.regeneration.targets.map(t => ({ scopeKey: t.scopeKey,status: "failed",error: { code: "provider",message: "private provider details",retryable: true } })) };
    } } });
    const failedRegeneration = await failingRunner.run(actor,projectId,chapterId,failureTask.id,failureSelection);
    assert.deepEqual(failedRegeneration.assets,generatedRegeneration.assets);assert.equal(failedRegeneration.regeneration!.outcome,"failed");
    assert.equal(failedRegeneration.failures[0]!.assetId,settingAsset.id);
    const retrySelection = { expectedActiveVersionId: failedRegeneration.id,assetIds: [],failureScopeKeys: [failedRegeneration.failures[0]!.scopeKey],reason: "retry selected failure" };
    const retryTask: ModelTask = { ...regenerationTask,id: `regeneration-retry-${suffix}`,input: { ...regenerationTask.input,regeneration: retrySelection } };
    await taskRepository.insert(retryTask);await taskRepository.transition(actor.workspaceId,retryTask.id,0,"running",null);
    const retriedRegeneration = await regenerationRunner.run(actor,projectId,chapterId,retryTask.id,retrySelection);
    assert.equal(retriedRegeneration.failures.length,0);assert.equal(retriedRegeneration.regeneration!.outcome,"succeeded");
    const staleResult = { ...proposed,id: `stale-regeneration-${suffix}` };
    await assert.rejects(() => regenerationRepository.saveGeneration(actor,staleResult,stableSettings.id),{ code: "VERSION_CONFLICT" });
    const formalRegeneration = await settingsReview.execute(actor,projectId,chapterId,{ kind: "confirm",requestId: "confirm-regeneration",expectedActiveVersionId: retriedRegeneration.id,reason: "reviewed" });
    const lockedRegeneration = await settingsReview.execute(actor,projectId,chapterId,{ kind: "lock",requestId: "lock-regeneration",expectedActiveVersionId: formalRegeneration.id,reason: "freeze",assetId: settingAsset.id });
    const callsBeforeLock = regenerationCalls;
    await assert.rejects(() => regenerationRunner.run(actor,projectId,chapterId,"locked-regeneration",{ ...failureSelection,expectedActiveVersionId: lockedRegeneration.id }),{ code: "LOCKED" });
    assert.equal(regenerationCalls,callsBeforeLock);
    const unlockedRegeneration = await settingsReview.execute(actor,projectId,chapterId,{ kind: "unlock",requestId: "unlock-regeneration",expectedActiveVersionId: lockedRegeneration.id,reason: "regenerate",assetId: settingAsset.id });
    const formalSelection = { ...failureSelection,expectedActiveVersionId: unlockedRegeneration.id };
    const formalTask: ModelTask = { ...regenerationTask,id: `formal-regeneration-${suffix}`,input: { ...regenerationTask.input,regeneration: formalSelection } };
    await taskRepository.insert(formalTask);await taskRepository.transition(actor.workspaceId,formalTask.id,0,"running",null);
    const capturedRunner = new SettingsRegenerationRunner({ repository: { findActive: (...args) => regenerationRepository.findActive(...args),findGeneration: (...args) => regenerationRepository.findGeneration(...args),saveGeneration: async (_a,v) => v },handoff: settingsHandoff,access: accessReader,idGenerator: () => `formal-regenerated-${suffix}`,clock: () => new Date("2026-11-04"),model: { async generate(r) {
      return { contractVersion: r.contractVersion,stage: r.stage,jobId: r.jobId,projectId,chapterId,sourceVersionId: sourceId,upstreamConfirmedVersionIds: r.upstreamConfirmedVersionIds,status: "succeeded",items: r.regeneration.targets.map(t => ({ scopeKey: t.scopeKey,status: "succeeded",value: { ...t.asset!,name: "formal revision" } })) };
    } } });
    const formalResult = await capturedRunner.run(actor,projectId,chapterId,formalTask.id,formalSelection);
    const competingRegenerations = await Promise.all([regenerationRepository.saveGeneration(actor,formalResult,unlockedRegeneration.id),regenerationRepository.saveGeneration(actor,{ ...formalResult,id: `${formalResult.id}-race` },unlockedRegeneration.id)]);
    assert.equal(competingRegenerations[0]!.id,competingRegenerations[1]!.id);
    assert.equal(competingRegenerations[0]!.revisionOfVersionId,unlockedRegeneration.id);
    assert.equal(competingRegenerations[0]!.status,"candidate");
    assert.equal((await settingsReviewRepo.findConfirmed(actor,projectId,chapterId))!.id,unlockedRegeneration.id);
    // Settings persistence constraints use the application role, not the migration owner.
    const settings = { id: `settings-${suffix}`,projectId,chapterId,sourceVersionId: sourceId,scriptVersionId: revisedFormal.id,jobId: `settings-job-${suffix}`,createdBy: actor.userId,status: "candidate",generationStatus: "succeeded",assets: [],failures: [],upstreamConfirmedVersionIds: [revisedFormal.id,confirmed.id,bibleId] };
    const settingsClient = await app.connect();
    try {
      await settingsClient.query("begin");
      await settingsClient.query("select set_config('app.current_user_id',$1,true),set_config('app.current_workspace_id',$2,true)",[actor.userId,actor.workspaceId]);
      const insertSettings = (value: typeof settings) => settingsClient.query("insert into settings_candidate_versions(workspace_id,project_id,chapter_id,id,source_version_id,script_version_id,job_id,created_by,version_json) values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)",[actor.workspaceId,projectId,chapterId,value.id,sourceId,revisedFormal.id,value.jobId,actor.userId,JSON.stringify(value)]);
      await insertSettings(settings);

      const rejectWrite = async (action: () => Promise<unknown>,code: string) => {
        await settingsClient.query("savepoint settings_constraint");
        await assert.rejects(action,{ code });
        await settingsClient.query("rollback to savepoint settings_constraint");
      };
      assert.equal((await settingsClient.query("select valid_settings_regeneration_asset(jsonb_set($1::jsonb,'{visibleDefinition}','{\"x\":1e1000}'::jsonb),$2,$3,$4) as valid",[JSON.stringify(settingAsset),projectId,chapterId,sourceId])).rows[0].valid,false);
      for (const [source,fragment,valid] of [["123","42",true],[123,"42",false],["123",42,false]]) {
        const asset = { ...settingAsset,provenance: [{ type: "source_fragment",sourceVersionId: source,fragmentId: fragment,transformation: "retained" }] };
        assert.equal((await settingsClient.query("select valid_settings_review_asset($1::jsonb,$2,$3,'123') as valid",[JSON.stringify(asset),projectId,chapterId])).rows[0].valid,valid);
      }
      for (const selection of [{ ...regenerationTask.input.regeneration,assetIds: [] },{ ...regenerationTask.input.regeneration,assetIds: [42] },{ ...regenerationTask.input.regeneration,assetIds: [settingAsset.id,settingAsset.id] }]) {
        assert.equal((await settingsClient.query("select valid_settings_regeneration_task($1::jsonb) as valid",[JSON.stringify({ ...regenerationTask.input,regeneration: selection })])).rows[0].valid,false);
      }
      for (const input of [
        { ...regenerationTask.input,sourceVersionId: "bad\nsource" },
        { ...regenerationTask.input,regeneration: { ...regenerationTask.input.regeneration,expectedActiveVersionId: ` ${"x".repeat(256)} ` } },
        { ...regenerationTask.input,regeneration: { ...regenerationTask.input.regeneration,assetIds: [` ${"x".repeat(256)} `] } },
        { ...regenerationTask.input,generationParameters: { ...regenerationTask.input.generationParameters,targetDurationSeconds: "60" } },
      ]) assert.equal((await settingsClient.query("select valid_settings_regeneration_task($1::jsonb) as valid",[JSON.stringify(input)])).rows[0].valid,false);
      assert.equal((await settingsClient.query("select valid_settings_regeneration_task(jsonb_set($1::jsonb,'{generationParameters,targetDurationSeconds}','60.0'::jsonb)) as valid",[JSON.stringify(regenerationTask.input)])).rows[0].valid,true);
      const forgeReview = (value: typeof stableSettings) => settingsClient.query("insert into settings_review_versions(workspace_id,project_id,chapter_id,id,origin_version_id,parent_review_id,created_by,version_json) values($1,$2,$3,$4,$5,$6,$7,$8::jsonb)",[actor.workspaceId,projectId,chapterId,value.id,savedSettings.id,stableSettings.id,value.createdBy,JSON.stringify(value)]);
      const forgedReview = { ...stableSettings,id: `forged-review-${suffix}`,parentVersionId: stableSettings.id,createdBy: actor.userId,operation: { requestId: "forged-review",fingerprint: "a".repeat(64),kind: "confirm" as const,targetId: stableSettings.id,reason: "forged" },status: "confirmed" as const,confirmedBy: actor.userId,confirmedAt: stableSettings.createdAt,assets: [] };
      await rejectWrite(() => forgeReview(forgedReview),"42501");
      await rejectWrite(() => settingsClient.query("update settings_review_versions set version_json='{}'"),"42501");
      await rejectWrite(() => settingsClient.query("update settings_review_heads set active_version_id=$1",[editedSettings.id]),"42501");
      await rejectWrite(() => settingsClient.query("select lock_settings_review_authority('other',$1,$2)",[projectId,chapterId]),"42501");
      await settingsClient.query("select set_config('app.current_user_id','editor',true)");
      await rejectWrite(() => forgeReview({ ...forgedReview,id: `editor-forged-${suffix}`,createdBy: "editor",confirmedBy: "editor",assets: stableSettings.assets }),"42501");
      await settingsClient.query("select set_config('app.current_user_id',$1,true)",[actor.userId]);
      await rejectWrite(() => settingsClient.query("insert into script_downstream_dependencies values($1,$2,$3,'storyboard',$4,'rain-location',$5,'action')",[actor.workspaceId,projectId,chapterId,savedSettings.id,revisedFormal.id]),"42501");
      await rejectWrite(() => settingsClient.query("insert into script_downstream_dependencies values($1,$2,$3,'settings',$4,'rain-location',$5,'action')",[actor.workspaceId,projectId,chapterId,savedSettings.id,lockedScript.id]),"42501");
      await rejectWrite(() => settingsClient.query("insert into script_downstream_dependencies values($1,$2,$3,'settings',$4,'invented-item',$5,'action')",[actor.workspaceId,projectId,chapterId,savedSettings.id,revisedFormal.id]),"42501");
      await rejectWrite(() => insertSettings({ ...settings,id: `duplicate-${suffix}` }),"23505");
      await rejectWrite(() => insertSettings({ ...settings,id: `invalid-${suffix}`,jobId: `invalid-job-${suffix}`,status: null as unknown as string }),"23514");
      await rejectWrite(() => settingsClient.query("update settings_candidate_versions set version_json='{}'"),"42501");
      await rejectWrite(() => settingsClient.query("delete from settings_candidate_heads"),"42501");
      for (const identity of [{ userId: actor.userId,workspaceId: "other" },{ userId: "outsider",workspaceId: actor.workspaceId }]) {
        await settingsClient.query("select set_config('app.current_user_id',$1,true),set_config('app.current_workspace_id',$2,true)",[identity.userId,identity.workspaceId]);
        assert.equal((await settingsClient.query("select * from settings_candidate_versions")).rowCount,0);
        assert.equal((await settingsClient.query("select * from settings_candidate_heads")).rowCount,0);
        await rejectWrite(() => insertSettings({ ...settings,id: `foreign-${suffix}`,jobId: `foreign-job-${suffix}` }),"42501");
      }
      await settingsClient.query("commit");
    } finally { await settingsClient.query("rollback");settingsClient.release(); }
    const settingsRead = await app.connect();
    try {
      await settingsRead.query("begin");
      await settingsRead.query("select set_config('app.current_user_id',$1,true),set_config('app.current_workspace_id',$2,true)",[actor.userId,actor.workspaceId]);
      assert.deepEqual((await settingsRead.query("select version_json from settings_candidate_versions where id=$1",[settings.id])).rows[0].version_json,settings);
      await settingsRead.query("commit");
    } finally { await settingsRead.query("rollback");settingsRead.release(); }
    const beforeImpact = (await settingsReviewRepo.findActive(actor,projectId,chapterId))!;
    const confirmedSetting = await settingsReview.execute(actor,projectId,chapterId,{ kind: "confirm",requestId: "impact-confirm-setting",expectedActiveVersionId: beforeImpact.id,reason: "checked" });
    const lockedSetting = await settingsReview.execute(actor,projectId,chapterId,{ kind: "lock",requestId: "impact-lock-setting",expectedActiveVersionId: confirmedSetting.id,assetId: settingAsset.id,reason: "preserve" });
    const upstreamSuggestion = await revision.execute(actor,projectId,chapterId,{ kind: "suggest",requestId: "settings-impact-suggest",reason: "节奏",expectedActiveVersionId: revisedFormal.id,elementId: "action",text: "细雨洒落庭院" });
    const upstreamCandidate = await revision.execute(actor,projectId,chapterId,{ kind: "decide",requestId: "settings-impact-accept",reason: "checked",expectedActiveVersionId: upstreamSuggestion.id,suggestionId: upstreamSuggestion.suggestions!.find(s => s.status === "pending")!.id,decision: "accepted" });
    assert.equal((await rebuilt.listSettingsImpacts(actor,projectId,chapterId,lockedSetting.id)).length,0);
    const upstreamReport = await publication.assess(actor,projectId,chapterId,{ jobId: `settings-impact-report-${suffix}`,binding: qualityBinding(upstreamCandidate,qualityContext),model: { async assess() { return { versionId: upstreamCandidate.id,events: [{ factId: "event",elementIds: ["action"],verdict: "covered" }],facts: [{ factId: "event",verdict: "consistent" }],episodes: [{ episodeId: "e",estimatedSeconds: 60 }],unsupportedCoreFactElementIds: [] }; } } });
    const upstreamConfirmed = await publication.execute(actor,projectId,chapterId,{ kind: "confirm",requestId: "settings-impact-confirm",reason: "checked",expectedActiveVersionId: upstreamCandidate.id,reportId: upstreamReport.id });
    const settingsImpacts = await new PostgresScriptContentRepository(app).listSettingsImpacts(actor,projectId,chapterId,lockedSetting.id);
    assert.deepEqual(settingsImpacts,[{ confirmed_version_id: upstreamConfirmed.id,source_version_id: revisedFormal.id,source_element_id: "action",target_stage: "settings",target_version_id: lockedSetting.id,target_item_id: settingAsset.id,status: "unreviewed" }]);
    assert.deepEqual(await settingsReviewRepo.findActive(actor,projectId,chapterId),lockedSetting);
    assert.deepEqual(await settingsReviewRepo.findConfirmed(actor,projectId,chapterId),lockedSetting);
    assert.equal((await rebuilt.listSettingsImpacts({ ...actor,workspaceId: "other" },projectId,chapterId,lockedSetting.id)).length,0);
    assert.equal((await rebuilt.listSettingsImpacts({ ...actor,userId: "outsider" },projectId,chapterId,lockedSetting.id)).length,0);
    const newHandoff = { async read() { return { version: upstreamConfirmed,sourceFragments: [{ id: "f",text: "雨落" }],upstreamConfirmedVersionIds: [confirmed.id,bibleId] }; } };
    const reconciliationRepo = new PostgresSettingsReviewRepository(app,newHandoff),reconciliation = new SettingsReconciliationService({ repository: reconciliationRepo,handoff: newHandoff,access: accessReader,idGenerator: () => `reconciliation-${suffix}-${++sequence}`,clock: () => new Date("2026-11-04") });
    const begin = { kind: "begin" as const,requestId: "begin-reconciliation",expectedActiveVersionId: lockedSetting.id,expectedUpstreamConfirmedVersionIds: [upstreamConfirmed.id,confirmed.id,bibleId],reason: "retain for new script" };
    assert.equal((await reconciliation.preview(actor,projectId,chapterId)).canBegin,true);
    await assert.rejects(() => reconciliation.execute({ ...actor,userId: "editor" },projectId,chapterId,begin),{ code: "FORBIDDEN" });
    const begun = await reconciliation.execute(actor,projectId,chapterId,begin);
    assert.equal(await reconciliationRepo.findActive({ ...actor,workspaceId: "other" },projectId,chapterId),null);
    assert.equal(begun.assets.length,0);assert.equal(begun.reconciliation!.pendingAssets.length,1);assert.deepEqual(begun.locks,lockedSetting.locks);
    assert.equal((await reconciliationRepo.findConfirmed(actor,projectId,chapterId))!.id,lockedSetting.id);
    const newReview = new SettingsReviewService({ repository: reconciliationRepo,handoff: newHandoff,access: accessReader,idGenerator: () => `new-review-${suffix}-${++sequence}`,clock: () => new Date("2026-11-04") });
    await assert.rejects(() => newReview.execute(actor,projectId,chapterId,{ kind: "confirm",requestId: "confirm-pending-reconciliation",expectedActiveVersionId: begun.id,reason: "check" }),{ code: "INVALID_STATE" });
    const retain = { ...begin,kind: "retain" as const,assetId: settingAsset.id,requestId: "retain-reconciliation",expectedActiveVersionId: begun.id };
    const rawRetain = { ...begun,id: `raw-retain-${suffix}`,parentVersionId: begun.id,assets: structuredClone(lockedSetting.assets),reconciliation: { ...begun.reconciliation!,pendingAssets: [] },operation: { requestId: "raw-retain",fingerprint: "a".repeat(64),kind: "retain" as const,targetId: settingAsset.id,reason: "retain" } };
    const rawClient = await app.connect();
    try {
      await rawClient.query("begin");await rawClient.query("select set_config('app.current_user_id',$1,true),set_config('app.current_workspace_id',$2,true)",[actor.userId,actor.workspaceId]);
      const rawInsert = (v: typeof rawRetain) => rawClient.query("insert into settings_review_versions(workspace_id,project_id,chapter_id,id,origin_version_id,parent_review_id,created_by,version_json) values($1,$2,$3,$4,$5,$6,$7,$8::jsonb)",[actor.workspaceId,projectId,chapterId,v.id,savedSettings.id,begun.id,v.createdBy,JSON.stringify(v)]);
      await rawClient.query("savepoint raw_reconciliation");await rawInsert(rawRetain);await rawClient.query("rollback to savepoint raw_reconciliation");
      await assert.rejects(() => rawInsert({ ...rawRetain,operation: { ...rawRetain.operation,kind: "regenerate",targetId: begun.id } } as never),{ code: "42501",message: /invalid regeneration task binding/ });
      await rawClient.query("rollback to savepoint raw_reconciliation");
      for (const forged of [
        { ...rawRetain,assets: [{ ...rawRetain.assets[0]!,name: "forged" }] },
        { ...rawRetain,assets: [{ ...rawRetain.assets[0]!,provenance: [] }] },
        { ...rawRetain,locks: {} },
        { ...rawRetain,assets: [] },
        { ...rawRetain,reconciliation: { ...rawRetain.reconciliation,originVersionId: "forged" } },
      ]) { await assert.rejects(() => rawInsert(forged),{ code: "42501" });await rawClient.query("rollback to savepoint raw_reconciliation"); }
      await assert.rejects(() => rawInsert({ ...rawRetain,operation: { ...rawRetain.operation,kind: "confirm",targetId: begun.id },status: "confirmed" } as never),{ code: "42501" });
      await rawClient.query("rollback to savepoint raw_reconciliation");
      await rawClient.query("select set_config('app.current_user_id','editor',true)");
      await assert.rejects(() => rawInsert({ ...rawRetain,createdBy: "editor" }),{ code: "42501" });
      await rawClient.query("rollback to savepoint raw_reconciliation");
      await assert.rejects(() => rawInsert({ ...rawRetain,scriptVersionId: lockedScript.id }),{ code: "P7001" });
      await rawClient.query("rollback to savepoint raw_reconciliation");
    } finally { await rawClient.query("rollback");rawClient.release(); }

    await admin.query("create function fail_reconciliation_dependency_test() returns trigger language plpgsql as $$ begin raise exception 'dependency failed';end $$");
    await admin.query("create trigger fail_reconciliation_dependency_test before insert on script_downstream_dependencies for each row execute function fail_reconciliation_dependency_test()");
    await assert.rejects(() => reconciliation.execute(actor,projectId,chapterId,retain),{ code: "STORAGE_UNAVAILABLE" });
    assert.equal((await reconciliationRepo.findActive(actor,projectId,chapterId))!.id,begun.id);
    assert.equal(await reconciliationRepo.findOperation(actor,projectId,chapterId,retain.requestId),null);
    await admin.query("drop trigger fail_reconciliation_dependency_test on script_downstream_dependencies;drop function fail_reconciliation_dependency_test()");
    const retainRace = await Promise.allSettled([reconciliation.execute(actor,projectId,chapterId,retain),reconciliation.execute(actor,projectId,chapterId,{ ...retain,requestId: "retain-reconciliation-race" })]);
    assert.equal(retainRace.filter(r => r.status === "fulfilled").length,1);
    const raceFailure = retainRace.find(r => r.status === "rejected") as PromiseRejectedResult;
    assert.equal(raceFailure.reason.code,"VERSION_CONFLICT");
    const retained = (retainRace.find(r => r.status === "fulfilled") as PromiseFulfilledResult<typeof begun>).value;
    assert.equal((await reconciliationRepo.findConfirmed(actor,projectId,chapterId))!.id,lockedSetting.id);
    assert.equal((await reconciliation.execute(actor,projectId,chapterId,{ ...retain,requestId: retained.operation!.requestId })).id,retained.id);
    assert.deepEqual(retained.assets,lockedSetting.assets);assert.deepEqual(retained.locks,lockedSetting.locks);assert.equal(retained.reconciliation!.pendingAssets.length,0);
    assert.deepEqual((await admin.query("select distinct script_version_id from script_downstream_dependencies where target_version_id=$1",[retained.id])).rows,[{ script_version_id: upstreamConfirmed.id }]);
    assert.equal((await new PostgresSettingsReviewRepository(app,newHandoff).findActive(actor,projectId,chapterId))!.id,retained.id);
    const reconfirmedSetting = await newReview.execute(actor,projectId,chapterId,{ kind: "confirm",requestId: "confirm-reconciled-setting",expectedActiveVersionId: retained.id,reason: "checked" });
    assert.equal((await reconciliationRepo.findConfirmed(actor,projectId,chapterId))!.id,reconfirmedSetting.id);
    const unlockedReconciled = await newReview.execute(actor,projectId,chapterId,{ kind: "unlock",requestId: "unlock-reconciled",expectedActiveVersionId: reconfirmedSetting.id,assetId: settingAsset.id,reason: "explicit" });
    assert.equal(Object.hasOwn(unlockedReconciled.locks,settingAsset.id),false);
    assert.equal((await reconciliation.execute(actor,projectId,chapterId,begin)).id,begun.id);
    assert.deepEqual(await reconciliationRepo.findVersion(actor,projectId,chapterId,lockedSetting.id),lockedSetting);

    // Seed the already-published authority for the reimport. The application role
    // executes the reconciliation itself with all transaction guards enabled.
    const crossBible = `cross-bible-${suffix}`, crossPlan = `cross-plan-${suffix}`, crossScript = `cross-script-${suffix}`;
    const crossElements = upstreamConfirmed.elements.map(element => ({
      ...element,provenance:element.provenance.map(ref => ref.type === "source_fragment" ? { ...ref,sourceVersionId:"123" } : ref),
    }));
    const seed = await admin.connect();
    try {
      await seed.query("begin");
      await seed.query("set local session_replication_role=replica");
      await seed.query("insert into story_knowledge_versions select (jsonb_populate_record(null::story_knowledge_versions,to_jsonb(v)||jsonb_build_object('id',$2::text,'source_version_id','123','extraction_job_id',$2::text,'version_json',v.version_json||jsonb_build_object('id',$2::text,'sourceVersionId','123')))).* from story_knowledge_versions v where id=$1",[bibleId,crossBible]);
      await seed.query("insert into story_bibles select (jsonb_populate_record(null::story_bibles,to_jsonb(v)||jsonb_build_object('id',$2::text,'version_id',$2::text))).* from story_bibles v where version_id=$1",[bibleId,crossBible]);
      await seed.query("insert into episode_plan_versions select (jsonb_populate_record(null::episode_plan_versions,to_jsonb(v)||jsonb_build_object('id',$2::text,'source_version_id','123','story_bible_version_id',$3::text,'version_json',v.version_json||jsonb_build_object('id',$2::text,'sourceVersionId','123','storyBibleVersionId',$3::text)))).* from episode_plan_versions v where id=$1",[confirmed.id,crossPlan,crossBible]);
      await seed.query("insert into script_content_versions select (jsonb_populate_record(null::script_content_versions,to_jsonb(v)||jsonb_build_object('id',$2::text,'source_version_id','123','plan_version_id',$3::text,'job_id',$2::text,'version_json',jsonb_set(v.version_json,'{publicationOperation,requestId}',to_jsonb($2::text))||jsonb_build_object('id',$2::text,'sourceVersionId','123','planVersionId',$3::text,'jobId',$2::text,'elements',$4::jsonb)))).* from script_content_versions v where id=$1",[upstreamConfirmed.id,crossScript,crossPlan,JSON.stringify(crossElements)]);
      await seed.query("update chapters set active_source_version_id='123' where project_id=$1 and id=$2",[projectId,chapterId]);
      await seed.query("update story_knowledge_heads set active_version_id=$2,confirmed_version_id=$2 where chapter_id=$1",[chapterId,crossBible]);
      await seed.query("update episode_plan_heads set active_version_id=$2,confirmed_version_id=$2 where chapter_id=$1",[chapterId,crossPlan]);
      await seed.query("update script_content_heads set active_version_id=$2,confirmed_version_id=$2 where chapter_id=$1",[chapterId,crossScript]);
      await seed.query("commit");
    } finally { await seed.query("rollback");seed.release(); }
    const crossHandoff = { async read() { return { version:{ ...upstreamConfirmed,id:crossScript,sourceVersionId:"123",planVersionId:crossPlan,elements:crossElements }, sourceFragments:[{ id:"f",text:"雨落" }],upstreamConfirmedVersionIds:[crossPlan,crossBible] }; } };
    const crossRepo = new PostgresSettingsReviewRepository(app,crossHandoff);
    const crossOptions = { repository:crossRepo,handoff:crossHandoff,access:accessReader,idGenerator:() => `cross-setting-${suffix}-${++sequence}`,clock:() => new Date("2026-11-05") };
    const cross = new SettingsReconciliationService({ ...crossOptions,async readEvidence() { return []; } });
    const crossBegin = { ...begin,requestId:"cross-begin",expectedActiveVersionId:unlockedReconciled.id,expectedUpstreamConfirmedVersionIds:[crossScript,crossPlan,crossBible] };
    const crossCandidate = await cross.execute(actor,projectId,chapterId,crossBegin);
    assert.equal(crossCandidate.sourceVersionId,"123");
    assert.equal(crossCandidate.assets.length,0);
    const migrationProbe = await app.connect();
    try {
      await migrationProbe.query("begin");
      await migrationProbe.query("select set_config('app.current_user_id',$1,true),set_config('app.current_workspace_id',$2,true)",[actor.userId,actor.workspaceId]);
      const migrated = { ...crossCandidate,id:"migration-probe",parentVersionId:crossCandidate.id,assets:crossCandidate.reconciliation!.pendingAssets.map(asset => ({ ...asset,provenance:asset.provenance.map(ref => ({ ...ref,sourceVersionId:"123" })) })),reconciliation:{ ...crossCandidate.reconciliation!,pendingAssets:[] },operation:{ kind:"retain",requestId:"probe",targetId:settingAsset.id,reason:"probe",fingerprint:"a".repeat(64) } };
      const insert = (result = migrated) => migrationProbe.query("insert into settings_review_versions(workspace_id,project_id,chapter_id,id,origin_version_id,parent_review_id,created_by,version_json) values($1,$2,$3,$4,$5,$6,$7,$8)",[actor.workspaceId,projectId,chapterId,result.id,savedSettings.id,crossCandidate.id,actor.userId,JSON.stringify(result)]);
      await migrationProbe.query("savepoint evidence");
      await assert.rejects(() => insert(),{code:"42501",message:/evidence migration denied/});
      await migrationProbe.query("rollback to savepoint evidence");
      await admin.query("insert into source_version_fragments values('123','f',$1,$2,2,0,2)",[projectId,chapterId]);
      await insert();
      await migrationProbe.query("rollback to savepoint evidence");
      await insert({
        ...migrated,id:"repair-probe",
        assets:[{ ...settingAsset,state:"repaired",provenance:[{ type:"source_fragment",sourceVersionId:"123",fragmentId:"42",transformation:"retained" }] }],
        operation:{ ...migrated.operation,kind:"reconcileRepair",requestId:"repair-probe" },
      });
    } finally { await migrationProbe.query("rollback");migrationProbe.release(); }
    const failedScope = { scopeKey:"unbound",code:"PROVIDER_ITEM_FAILED",retryable:false };
    const failureSeed = await admin.connect();
    try {
      await failureSeed.query("begin");
      await failureSeed.query("set local session_replication_role=replica");
      await failureSeed.query("update settings_review_versions set version_json=jsonb_set(version_json||jsonb_build_object('failures',$2::jsonb,'generationStatus','failed'),'{reconciliation,pendingFailureScopeKeys}',jsonb_build_array('unbound')) where id=$1",
        [crossCandidate.id,JSON.stringify([failedScope])]);
      await failureSeed.query("commit");
    } finally { await failureSeed.query("rollback");failureSeed.release(); }
    const decideFailure = { ...crossBegin,kind:"resolveFailure" as const,requestId:"cross-failure-decision",expectedActiveVersionId:crossCandidate.id,failureScopeKey:"unbound",reason:"no setting required" };
    const adjudicated = await cross.execute(actor,projectId,chapterId,decideFailure);
    assert.deepEqual(adjudicated.reconciliation?.failureDecisions?.[0]?.failure,failedScope);
    assert.deepEqual(adjudicated.reconciliation?.pendingFailureScopeKeys,[]);
    assert.deepEqual((await crossRepo.findVersion(actor,projectId,chapterId,crossCandidate.id))?.failures,[failedScope]);
    assert.deepEqual(await cross.execute(actor,projectId,chapterId,decideFailure),adjudicated);
    const regeneratedAsset = { ...settingAsset,state:"regenerated",provenance:[{ type:"source_fragment",sourceVersionId:"123",fragmentId:"f",transformation:"retained" }] };
    const selection = { expectedActiveVersionId:adjudicated.id,assetIds:[settingAsset.id],failureScopeKeys:[],reason:"new source evidence" };
    const pendingTask: ModelTask = { ...regenerationTask,id:`pending-regeneration-${suffix}`,input:{ ...regenerationTask.input,sourceVersionId:"123",upstreamConfirmedVersionIds:[crossScript,crossPlan,crossBible],regeneration:selection } };
    await taskRepository.insert(pendingTask);
    await taskRepository.transition(actor.workspaceId,pendingTask.id,0,"running",null);
    const pendingRepository = new PostgresSettingsRegenerationRepository(app,crossHandoff);
    let pendingCalls = 0;
    let proposedPending: Parameters<typeof pendingRepository.saveGeneration>[1] | undefined;
    const pendingRunner = new SettingsRegenerationRunner({ ...crossOptions,repository:{
      findActive: pendingRepository.findActive.bind(pendingRepository),
      findGeneration: pendingRepository.findGeneration.bind(pendingRepository),
      async saveGeneration(a,v,expected) {
        proposedPending = v;
        await assert.rejects(() => pendingRepository.saveGeneration(a,{ ...v,reconciliation:{ ...v.reconciliation!,originVersionId:"forged" } },expected),{ code:"FORBIDDEN" });
        await pendingRepository.saveGeneration(a,v,expected);
        throw new Error("lost write acknowledgement");
      },
    },model:{ async generate(r) {
      pendingCalls++;
      return { contractVersion:r.contractVersion,stage:r.stage,jobId:r.jobId,projectId,chapterId,sourceVersionId:r.sourceVersionId,upstreamConfirmedVersionIds:r.upstreamConfirmedVersionIds,status:"succeeded",items:r.regeneration.targets.map(t => ({ scopeKey:t.scopeKey,status:"succeeded",value:regeneratedAsset })) };
    } } });
    await assert.rejects(() => pendingRunner.run(actor,projectId,chapterId,pendingTask.id,selection),{ code:"EXECUTION_UNCERTAIN" });
    assert.ok(proposedPending);
    const recovered = await new PostgresSettingsRegenerationRepository(app,crossHandoff).findGeneration(actor,projectId,chapterId,pendingTask.id);
    assert.deepEqual(recovered?.assets,[regeneratedAsset]);
    assert.deepEqual(recovered?.reconciliation?.pendingAssets,[]);
    assert.equal(await pendingRepository.findGeneration({ ...actor,workspaceId:"other" },projectId,chapterId,pendingTask.id),null);
    assert.deepEqual(await pendingRunner.run(actor,projectId,chapterId,pendingTask.id,selection),recovered);
    assert.equal(pendingCalls,1);
    assert.deepEqual((await admin.query("select distinct script_version_id from script_downstream_dependencies where target_version_id=$1",[recovered!.id])).rows,[{ script_version_id:crossScript }]);
    assert.equal((await crossRepo.findConfirmed(actor,projectId,chapterId))?.id,unlockedReconciled.id);
    const confirm = { kind:"confirm" as const,requestId:"cross-confirm",expectedActiveVersionId:recovered!.id,reason:"checked" };
    const crossReview = new SettingsReviewService(crossOptions);
    await taskRepository.transition(actor.workspaceId,pendingTask.id,1,"paused","EXECUTION_UNCERTAIN");
    await assert.rejects(() => crossReview.execute(actor,projectId,chapterId,confirm),{ code:"INVALID_STATE" });
    await assert.rejects(() => taskRepository.insert({ ...pendingTask,id:"cross-unknown-bypass" }),{ code:"STATE_CONFLICT" });
    await taskRepository.recover(actor.workspaceId,pendingTask.id,2,{ candidateVersionId:recovered!.id,extractionStatus:"succeeded" });
    assert.equal((await crossReview.execute(actor,projectId,chapterId,confirm)).status,"confirmed");
    await assert.rejects(() => taskRepository.insert({ ...pendingTask,id:"cross-stale-enqueue" }),{ code:"STATE_CONFLICT" });
    await assert.rejects(() => taskRepository.insert({
      ...pendingTask,id:"cross-stale-resolved-enqueue",
      input:{ ...pendingTask.input,regeneration:{ ...selection,expectedActiveVersionId:recovered!.id } },
    }),{ code:"STATE_CONFLICT" });

    await admin.query("update chapters set active_source_version_id=null where project_id=$1 and id=$2",[projectId,chapterId]);
    const head = await content.findActive(actor,projectId,chapterId);
    await assert.rejects(() => content.save(actor,{ ...candidate,id: `stale-${suffix}`,parentVersionId: head!.id },head!.id),{ code: "CONTEXT_NOT_FOUND" });
    assert.deepEqual(await content.findGeneration(actor,projectId,chapterId,candidate.jobId),candidate);
  } finally { await app.end(); await admin.end(); }
});
