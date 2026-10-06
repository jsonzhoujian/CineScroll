import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PostgresScriptRepository } from "../src/postgres-episode-plan.ts";
import { ScriptUpstreamChangedError, type EpisodePlanVersion } from "../src/index.ts";

test("PostgreSQL拆集版本重建可读、CAS、权限与上游门禁", { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const { Pool } = createRequire(new URL("../../project-import/package.json", import.meta.url))("pg");
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const app = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: "-c role=novel_app" });
  const suffix = randomUUID(), actor = { userId: `owner-${suffix}`, workspaceId: `w-${suffix}` }, projectId = `p-${suffix}`, chapterId = `c-${suffix}`, sourceId = `s-${suffix}`, bibleId = `b-${suffix}`;
  try {
    for (const path of ["../../project-import/migrations/0001_project_import.sql", "../../story-knowledge/migrations/0001_story_knowledge.sql", "../migrations/0010_episode_plans.sql"]) await admin.query(await readFile(new URL(path, import.meta.url), "utf8"));
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
    const editorConnection = await app.connect();
    try {
      await editorConnection.query("begin");
      await editorConnection.query("select set_config('app.current_user_id','editor',true),set_config('app.current_workspace_id',$1,true)", [actor.workspaceId]);
      await assert.rejects(() => editorConnection.query("update episode_plan_heads set confirmed_version_id=null where workspace_id=$1 and project_id=$2 and chapter_id=$3", [actor.workspaceId,projectId,chapterId]), { code: "42501" });
    } finally { await editorConnection.query("rollback"); editorConnection.release(); }
    assert.equal((await repository.findConfirmedEpisodePlan(actor,projectId,chapterId))?.id, confirmed.id);
    const rewindConnection = await app.connect();
    try {
      await rewindConnection.query("begin");
      await rewindConnection.query("select set_config('app.current_user_id',$1,true),set_config('app.current_workspace_id',$2,true)", [actor.userId,actor.workspaceId]);
      await assert.rejects(() => rewindConnection.query("update episode_plan_heads set active_version_id=$4 where workspace_id=$1 and project_id=$2 and chapter_id=$3", [actor.workspaceId,projectId,chapterId,version.id]), { code: "42501" });
    } finally { await rewindConnection.query("rollback"); rewindConnection.release(); }
    assert.deepEqual((await new PostgresScriptRepository(app).findOperationResult(actor, projectId, chapterId, operation.key))?.version, confirmed);
    // A review head advance must not replace the generation result used for task reconciliation.
    assert.deepEqual((await new PostgresScriptRepository(app).findOperationResult(actor, projectId, chapterId, generationOperation.key))?.version, version);
    assert.equal(await repository.findOperationResult({ ...actor,userId: "outsider" },projectId,chapterId,generationOperation.key),null);
    assert.deepEqual(await repository.saveEpisodePlan(actor, { ...confirmed, id: "ignored" }, active.id, operation), confirmed);
    await assert.rejects(() => repository.saveEpisodePlan(actor, { ...next, id: "after-confirm", parentVersionId: confirmed.id }, confirmed.id), { code: "CONFIRMED_PLAN_REQUIRES_SUGGESTION" });
  } finally { await app.end(); await admin.end(); }
});
