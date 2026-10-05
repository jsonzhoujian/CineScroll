import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { setTimeout } from "node:timers/promises";

import { Pool, type PoolClient } from "pg";

import type { StoryBible, StoryKnowledgeVersion } from "../src/index.ts";
import { StoryKnowledgeSourceChangedError } from "../src/index.ts";
import { PostgresStoryKnowledgeRepository } from "../src/postgres-repository.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integrationTest = databaseUrl ? test : test.skip;
const actor = { userId: "usr_story_owner", workspaceId: "wsp_story" } as const;

integrationTest("PostgreSQL 持久化活动版本与故事圣经，并隔离非项目成员", async () => {
  const adminPool = new Pool({ connectionString: databaseUrl, max: 1 });
  let applicationPool: Pool | undefined;
  try {
    for (const path of [
      "../../project-import/migrations/0001_project_import.sql",
      "../migrations/0001_story_knowledge.sql",
    ]) {
      await adminPool.query(await readFile(new URL(path, import.meta.url), "utf8"));
    }
    await adminPool.query("truncate table projects cascade");
    await adminPool.query("drop role if exists novel_story_test");
    await adminPool.query("create role novel_story_test login password 'test-only-password' in role novel_app");
    await seedProject(adminPool);
    await adminPool.query(
      "insert into project_members (project_id, workspace_id, user_id, role) values ('prj_story',$1,'usr_story_reviewer','reviewer')",
      [actor.workspaceId],
    );

    const applicationUrl = new URL(databaseUrl!);
    applicationUrl.username = "novel_story_test";
    applicationUrl.password = "test-only-password";
    applicationPool = new Pool({ connectionString: applicationUrl.toString(), max: 4 });
    const repository = new PostgresStoryKnowledgeRepository(applicationPool);
    const candidate = version("skv_candidate");

    const guardCandidate = { ...version("skv_guard"), chapterId: "chp_guard", sourceVersionId: "srcv_guard" };
    await withStoryContext(applicationPool, actor, "candidate", (client) => client.query(
      `insert into story_knowledge_versions
       (id, workspace_id, project_id, chapter_id, parent_version_id, source_version_id, extraction_job_id,
        created_at, created_by, extraction_status, status, version_json)
       values ($1,$2,$3,$4,null,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
      [guardCandidate.id, actor.workspaceId, guardCandidate.projectId, guardCandidate.chapterId,
        guardCandidate.sourceVersionId, guardCandidate.extractionJobId, guardCandidate.createdAt,
        guardCandidate.createdBy, guardCandidate.extractionStatus, guardCandidate.status, JSON.stringify(guardCandidate)],
    ));
    await assert.rejects(
      () => withStoryContext(applicationPool!, actor, "candidate", (client) => client.query(
        `insert into story_knowledge_heads
         (workspace_id, project_id, chapter_id, active_version_id, confirmed_version_id)
         values ($1,'prj_story','chp_guard','skv_guard','skv_guard')`,
        [actor.workspaceId],
      )),
      /only confirmation may establish/,
    );

    await repository.saveCandidate(actor, candidate, null);
    const restarted = new PostgresStoryKnowledgeRepository(applicationPool);
    assert.deepEqual(await restarted.findActive(actor, "prj_story", "chp_story"), candidate);

    const confirmed = version("skv_confirmed", candidate.id, "confirmed");
    const bible: StoryBible = {
      id: "bible:skv_confirmed", versionId: confirmed.id, projectId: "prj_story", chapterId: "chp_story",
      confirmedBy: actor.userId, confirmedAt: confirmed.confirmedAt!, facts: confirmed.facts,
    };
    const confirmation = {
      candidateVersionId: candidate.id, fingerprint: "confirm-fingerprint",
    };
    await repository.saveConfirmed(actor, confirmed, bible, candidate.id, confirmation);
    assert.deepEqual(await restarted.findConfirmedStoryBible(actor, "prj_story", "chp_story"), bible);
    assert.deepEqual(
      await restarted.saveConfirmed(actor, version("skv_ignored", candidate.id, "confirmed"), bible, candidate.id, confirmation),
      { version: confirmed, storyBible: bible },
    );
    await assert.rejects(
      () => restarted.saveConfirmed(actor, version("skv_invalid", confirmed.id, "confirmed"), bible, confirmed.id, {
        ...confirmation, fingerprint: "different",
      }),
      { code: "INVALID_CONFIRMATION" },
    );
    assert.equal(await restarted.findActive({ userId: "usr_other", workspaceId: actor.workspaceId }, "prj_story", "chp_story"), null);
    await assert.rejects(
      () => restarted.saveCandidate(
        { userId: "usr_story_reviewer", workspaceId: actor.workspaceId },
        version("skv_reviewer_candidate", confirmed.id),
        confirmed.id,
      ),
      { code: "FORBIDDEN" },
    );
    await assert.rejects(
      () => restarted.saveConfirmed(actor, confirmed, { ...bible, versionId: "skv_wrong" }, confirmed.id),
      { code: "INVALID_CONFIRMATION" },
    );
    await assert.rejects(
      () => restarted.saveConfirmed(actor, confirmed, { ...bible, confirmedBy: "usr_tampered" }, confirmed.id),
      { code: "INVALID_CONFIRMATION" },
    );
    await assert.rejects(
      () => restarted.saveCandidate(actor, version("skv_fake_confirmed", confirmed.id, "confirmed"), confirmed.id),
      { code: "FORBIDDEN" },
    );
    await assert.rejects(
      () => withStoryContext(applicationPool!, actor, "candidate", (client) => client.query(
        `update story_knowledge_heads set confirmed_version_id = null
         where workspace_id = $1 and project_id = 'prj_story' and chapter_id = 'chp_story'`,
        [actor.workspaceId],
      )),
      /only confirmation may change/,
    );
  } finally {
    await applicationPool?.end();
    await adminPool.end();
  }
});

integrationTest("PostgreSQL 以事务保证 CAS 与局部重试幂等", async () => {
  const adminPool = new Pool({ connectionString: databaseUrl, max: 1 });
  let applicationPool: Pool | undefined;
  try {
    for (const path of [
      "../../project-import/migrations/0001_project_import.sql",
      "../migrations/0001_story_knowledge.sql",
    ]) await adminPool.query(await readFile(new URL(path, import.meta.url), "utf8"));
    await adminPool.query("truncate table projects cascade");
    await adminPool.query("drop role if exists novel_story_test");
    await adminPool.query("create role novel_story_test login password 'test-only-password' in role novel_app");
    await seedProject(adminPool);
    const applicationUrl = new URL(databaseUrl!);
    applicationUrl.username = "novel_story_test";
    applicationUrl.password = "test-only-password";
    applicationPool = new Pool({ connectionString: applicationUrl.toString(), max: 4 });
    const repository = new PostgresStoryKnowledgeRepository(applicationPool);
    // Hold a reimport uncommitted while a candidate write is started: the writer must
    // wait, then compare the committed current source rather than its old snapshot.
    const reimport = await adminPool.connect();
    try {
      await reimport.query("begin");
      await reimport.query(`insert into source_versions
        (id, project_id, chapter_id, ordinal, created_at, created_by, character_count, source_text)
        values ('srcv_new','prj_story','chp_story',2,now(),$1,4,'新版原文')`, [actor.userId]);
      await reimport.query("update chapters set active_source_version_id='srcv_new' where id='chp_story'");
      const saving = repository.saveCandidate(actor, version("skv_stale"), null, true);
      const rejected = assert.rejects(saving, error => error instanceof StoryKnowledgeSourceChangedError && error.code === "VERSION_CONFLICT");
      let waiting = false;
      for (let attempt = 0; attempt < 100 && !waiting; attempt += 1) {
        // Statistics are otherwise cached for this admin transaction.
        await reimport.query("select pg_stat_clear_snapshot()");
        const activity = await reimport.query(`select 1 from pg_stat_activity
          where usename='novel_story_test' and wait_event_type='Lock'
          and query like 'select active_source_version_id from chapters%'`);
        waiting = activity.rowCount === 1;
        if (!waiting) await setTimeout(10);
      }
      await reimport.query("commit");
      await rejected;
      assert.equal(waiting, true, "候选写入必须等待未提交的原文变更");
      assert.equal(await repository.findActive(actor, "prj_story", "chp_story"), null);
      const current = { ...version("skv_current"), sourceVersionId: "srcv_new" };
      await repository.saveCandidate(actor, current, null, true);
      assert.equal((await repository.findActive(actor, "prj_story", "chp_story"))?.id, "skv_current");
      // Restore fixture head via a separate chapter for the remaining CAS cases.
      await reimport.query("delete from story_knowledge_heads where project_id='prj_story' and chapter_id='chp_story'");
      await reimport.query("update chapters set active_source_version_id='srcv_story' where id='chp_story'");
    } finally { await reimport.query("rollback"); reimport.release(); }
    await assert.rejects(
      () => repository.saveCandidate(actor, { ...version("skv_dangling"), sourceVersionId: "srcv_missing" }, null),
      { code: "SOURCE_VERSION_NOT_FOUND" },
    );
    await assert.rejects(
      () => repository.saveCandidate(actor, version("skv_orphan", "skv_missing_parent"), null),
      { code: "VERSION_CONFLICT" },
    );
    await repository.saveCandidate(actor, version("skv_base"), null);

    const results = await Promise.allSettled([
      repository.saveCandidate(actor, version("skv_a", "skv_base"), "skv_base"),
      repository.saveCandidate(actor, version("skv_b", "skv_base"), "skv_base"),
    ]);
    assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
    assert.equal(results.filter(({ status }) => status === "rejected").length, 1);
    const rejected = results.find(({ status }) => status === "rejected");
    assert.equal(rejected?.status === "rejected" && (rejected.reason as { code?: string }).code, "VERSION_CONFLICT");

    const active = await repository.findActive(actor, "prj_story", "chp_story");
    const retry = version("skv_retry", active!.id);
    const first = await repository.saveRetryCandidate(actor, retry, active!.id, "retry:job-2", "same");
    const repeated = await repository.saveRetryCandidate(actor, version("skv_ignored", active!.id), active!.id, "retry:job-2", "same");
    assert.deepEqual(repeated, first);
    await assert.rejects(
      () => repository.saveRetryCandidate(actor, version("skv_invalid", first.id), first.id, "retry:job-2", "different"),
      { code: "INVALID_RETRY" },
    );
  } finally {
    await applicationPool?.end();
    await adminPool.end();
  }
});

async function seedProject(pool: Pool): Promise<void> {
  await pool.query(
    `insert into projects (id, workspace_id, owner_user_id, title, aspect_ratio, target_duration_seconds, narrative_mode, created_at)
     values ('prj_story',$1,$2,'故事项目','16:9',180,'dialogue','2026-09-29T00:00:00.000Z')`,
    [actor.workspaceId, actor.userId],
  );
  await pool.query("insert into project_members (project_id, workspace_id, user_id, role) values ('prj_story',$1,$2,'owner')", [actor.workspaceId, actor.userId]);
  await pool.query("insert into chapters (id, project_id, title, active_source_version_id) values ('chp_story','prj_story','第一章',null)");
  await pool.query("insert into chapters (id, project_id, title, active_source_version_id) values ('chp_guard','prj_story','守卫测试章',null)");
  await pool.query(
    `insert into source_versions
     (id, project_id, chapter_id, ordinal, created_at, created_by, character_count, source_text)
     values ('srcv_story','prj_story','chp_story',1,'2026-09-29T00:00:00.000Z',$1,4,'原文内容')`,
    [actor.userId],
  );
  await pool.query("update chapters set active_source_version_id = 'srcv_story' where id = 'chp_story'");
  await pool.query(
    `insert into source_versions
     (id, project_id, chapter_id, ordinal, created_at, created_by, character_count, source_text)
     values ('srcv_guard','prj_story','chp_guard',1,'2026-09-29T00:00:00.000Z',$1,4,'守卫原文')`,
    [actor.userId],
  );
  await pool.query("update chapters set active_source_version_id = 'srcv_guard' where id = 'chp_guard'");
}

function version(id: string, parentVersionId: string | null = null, status: StoryKnowledgeVersion["status"] = "candidate"): StoryKnowledgeVersion {
  const confirmed = status === "confirmed";
  return {
    id, parentVersionId, projectId: "prj_story", chapterId: "chp_story", sourceVersionId: "srcv_story",
    extractionJobId: "job_story", createdAt: "2026-09-29T08:00:00.000Z", createdBy: actor.userId,
    extractionStatus: "succeeded", status,
    ...(confirmed ? { confirmedBy: actor.userId, confirmedAt: "2026-09-29T09:00:00.000Z" } : {}),
    facts: [{
      id: "fact_1", factType: "event", statement: "少年觉醒", assertionKind: "explicit",
      resolutionStatus: "resolved", resolutionGroupId: null,
      evidence: [{ sourceVersionId: "srcv_story", fragmentId: "frag_story" }],
      ...(confirmed ? { decision: { outcome: "accepted" as const, decidedBy: actor.userId, decidedAt: "2026-09-29T09:00:00.000Z", reason: "确认" }, locked: false, lockHistory: [] } : {}),
    }],
    failures: [],
  };
}

async function withStoryContext<T>(
  pool: Pool,
  requestActor: { userId: string; workspaceId: string },
  operation: "candidate" | "retry" | "confirm",
  action: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.current_user_id', $1, true)", [requestActor.userId]);
    await client.query("select set_config('app.current_workspace_id', $1, true)", [requestActor.workspaceId]);
    await client.query("select set_config('app.story_knowledge_operation', $1, true)", [operation]);
    const result = await action(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
