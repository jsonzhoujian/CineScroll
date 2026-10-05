import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { setTimeout } from "node:timers/promises";

import { Pool, type PoolClient } from "pg";

import type { StoryBible, StoryKnowledgeVersion } from "../src/index.ts";
import { StoryKnowledgeSourceChangedError } from "../src/index.ts";
import { PostgresStoryKnowledgeRepository } from "../src/postgres-repository.ts";
import { PostgresGenerationPolicyReader } from "../src/generation-policy.ts";

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
      "../migrations/0002_extraction_recovery.sql",
      "../migrations/0003_generation_policy.sql",
      "../migrations/0004_generation_policy_audit.sql",
    ]) {
      await adminPool.query(await readFile(new URL(path, import.meta.url), "utf8"));
    }
    await resetFixture(adminPool);
    await adminPool.query("drop role if exists novel_story_test");
    await adminPool.query("create role novel_story_test login password 'test-only-password' in role novel_app");
    const auditStart = (await adminPool.query("select coalesce(max(id),0) as id from generation_policy_audit")).rows[0].id;
    await seedProject(adminPool);
    await seedPolicy(adminPool);
    const audit = await adminPool.query("select target,operation,old_state,new_state,session_actor,effective_actor from generation_policy_audit where project_id='prj_story' and id>$1 order by id", [auditStart]);
    assert.deepEqual(audit.rows.map(row => [row.target,row.operation,row.old_state,row.new_state]), [["project","INSERT",null,"allowed"],["source","INSERT",null,"allowed"]]);
    const dbActor = (await adminPool.query("select session_user,current_user")).rows[0];
    assert.equal(audit.rows[0].session_actor, dbActor.session_user); assert.equal(audit.rows[0].effective_actor, dbActor.current_user);
    await adminPool.query(
      "insert into project_members (project_id, workspace_id, user_id, role) values ('prj_story',$1,'usr_story_reviewer','reviewer')",
      [actor.workspaceId],
    );

    const applicationUrl = new URL(databaseUrl!);
    applicationUrl.username = "novel_story_test";
    applicationUrl.password = "test-only-password";
    applicationPool = new Pool({ connectionString: applicationUrl.toString(), max: 4 });
    const repository = new PostgresStoryKnowledgeRepository(applicationPool);
    const policies = new PostgresGenerationPolicyReader(applicationPool);
    assert.equal(await policies.isAllowed(actor, "prj_story", "chp_story", "srcv_story"), true);
    assert.equal(await new PostgresGenerationPolicyReader(applicationPool).isAllowed(actor, "prj_story", "chp_story", "srcv_story"), true);
    assert.equal(await policies.isAllowed({ ...actor, workspaceId: "other" }, "prj_story", "chp_story", "srcv_story"), false);
    assert.equal(await policies.isAllowed({ ...actor, userId: "outsider" }, "prj_story", "chp_story", "srcv_story"), false);
    assert.equal(await policies.isAllowed(actor, "prj_story", "chp_guard", "srcv_guard"), false);
    for (const state of ["pending", "blocked"]) {
      await adminPool.query("update source_generation_policy set state=$1 where source_version_id='srcv_story'", [state]);
      assert.equal(await policies.isAllowed(actor, "prj_story", "chp_story", "srcv_story"), false);
    }
    await adminPool.query("update source_generation_policy set state='allowed' where source_version_id='srcv_story'");
    for (const state of ["complaint_suspended", "content_blocked"]) {
      await adminPool.query("update project_generation_policy set state=$1 where project_id='prj_story'", [state]);
      assert.equal(await policies.isAllowed(actor, "prj_story", "chp_story", "srcv_story"), false);
    }
    await adminPool.query("update project_generation_policy set state='allowed' where project_id='prj_story'");
    const changes = await adminPool.query("select target,operation,old_state,new_state,occurred_at,transaction_id from generation_policy_audit where id>$1 order by id", [auditStart]);
    assert.deepEqual(changes.rows.map(row => [row.target,row.operation,row.old_state,row.new_state]), [
      ["project","INSERT",null,"allowed"], ["source","INSERT",null,"allowed"],
      ["source","UPDATE","allowed","pending"], ["source","UPDATE","pending","blocked"], ["source","UPDATE","blocked","allowed"],
      ["project","UPDATE","allowed","complaint_suspended"], ["project","UPDATE","complaint_suspended","content_blocked"], ["project","UPDATE","content_blocked","allowed"],
    ]);
    assert.ok(changes.rows.every(row => row.occurred_at instanceof Date && BigInt(row.transaction_id) > 0n));
    await adminPool.query("update project_generation_policy set state='allowed' where project_id='prj_story'");
    assert.equal((await adminPool.query("select count(*) from generation_policy_audit where id>$1", [auditStart])).rows[0].count, "8");
    await adminPool.query("alter table generation_policy_audit add constraint audit_failure_fixture check (new_state is distinct from 'content_blocked') not valid");
    try {
      await assert.rejects(() => adminPool.query("update project_generation_policy set state='content_blocked' where project_id='prj_story'"), { code: "23514" });
      assert.equal(await policies.isAllowed(actor, "prj_story", "chp_story", "srcv_story"), true);
      assert.equal((await adminPool.query("select count(*) from generation_policy_audit where id>$1", [auditStart])).rows[0].count, "8");
    } finally { await adminPool.query("alter table generation_policy_audit drop constraint audit_failure_fixture"); }
    await adminPool.query("delete from source_generation_policy where source_version_id='srcv_story'");
    const removed = (await adminPool.query("select operation,old_state,new_state from generation_policy_audit where id>$1 order by id desc limit 1", [auditStart])).rows[0];
    assert.deepEqual(removed, { operation: "DELETE", old_state: "allowed", new_state: null });
    assert.equal(await policies.isAllowed(actor, "prj_story", "chp_story", "srcv_story"), false);
    await adminPool.query("insert into source_generation_policy(workspace_id,project_id,chapter_id,source_version_id,state) values($1,'prj_story','chp_story','srcv_story','allowed')", [actor.workspaceId]);
    for (const sql of ["update generation_policy_audit set new_state='allowed'", "delete from generation_policy_audit", "truncate generation_policy_audit", "truncate project_generation_policy", "truncate source_generation_policy"]) {
      await assert.rejects(() => adminPool.query(sql), { code: "42501" });
    }
    for (const sql of ["insert into generation_policy_audit(workspace_id,project_id,target,operation,new_state,session_actor,effective_actor) values('w','p','project','INSERT','allowed','fake','fake')", "update generation_policy_audit set new_state='allowed'", "delete from generation_policy_audit", "truncate generation_policy_audit"]) {
      await assert.rejects(() => withStoryContext(applicationPool!, actor, "candidate", client => client.query(sql)), { code: "42501" });
    }
    const visible = await withStoryContext(applicationPool, actor, "candidate", client => client.query("select id from generation_policy_audit where id>$1", [auditStart]));
    assert.equal(visible.rowCount, 10);
    const hidden = await withStoryContext(applicationPool, { ...actor, workspaceId: "other" }, "candidate", client => client.query("select id from generation_policy_audit"));
    assert.equal(hidden.rowCount, 0);
    // Trusted maintenance role only in this disposable database. Its audit write
    // privileges are explicit; the application never receives this role.
    await adminPool.query("create role novel_policy_audit_test nologin bypassrls");
    try {
      await adminPool.query("grant select,update on project_generation_policy to novel_policy_audit_test");
      await adminPool.query("grant insert on generation_policy_audit to novel_policy_audit_test");
      await adminPool.query("grant usage on sequence generation_policy_audit_id_seq to novel_policy_audit_test");
      const maintenance = await adminPool.connect();
      try {
        await maintenance.query("begin");
        await maintenance.query("set local role novel_policy_audit_test");
        await maintenance.query("update project_generation_policy set state='complaint_suspended' where project_id='prj_story'");
        await maintenance.query("commit");
      } finally { await maintenance.query("rollback"); maintenance.release(); }
      const identity = (await adminPool.query("select session_actor,effective_actor from generation_policy_audit order by id desc limit 1")).rows[0];
      assert.equal(identity.session_actor, dbActor.session_user); assert.equal(identity.effective_actor, "novel_policy_audit_test");
      await adminPool.query("revoke insert on generation_policy_audit from novel_policy_audit_test");
      const noAudit = await adminPool.connect();
      try {
        await noAudit.query("begin"); await noAudit.query("set local role novel_policy_audit_test");
        await assert.rejects(() => noAudit.query("update project_generation_policy set state='allowed' where project_id='prj_story'"), { code: "42501" });
      } finally { await noAudit.query("rollback"); noAudit.release(); }
      assert.equal(await policies.isAllowed(actor, "prj_story", "chp_story", "srcv_story"), false);
      await adminPool.query("update project_generation_policy set state='allowed' where project_id='prj_story'");
    } finally {
      await adminPool.query("revoke all on project_generation_policy,generation_policy_audit from novel_policy_audit_test");
      await adminPool.query("revoke all on sequence generation_policy_audit_id_seq from novel_policy_audit_test");
      await adminPool.query("drop role novel_policy_audit_test");
    }
    for (const sql of ["update project_generation_policy set state='allowed'", "delete from project_generation_policy", "update source_generation_policy set state='allowed'", "insert into project_generation_policy(workspace_id,project_id,state) values('w','p','allowed')"]) {
      await assert.rejects(() => withStoryContext(applicationPool!, actor, "candidate", client => client.query(sql)), { code: "42501" });
    }
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
    assert.deepEqual(await repository.findInitialExtraction(actor, "prj_story", "chp_story", "job_story"), candidate);
    assert.equal(await repository.findInitialExtraction({ userId: "usr_other", workspaceId: actor.workspaceId }, "prj_story", "chp_story", "job_story"), null);
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
    assert.deepEqual(await restarted.findInitialExtraction(actor, "prj_story", "chp_story", "job_story"), candidate);
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
    await repository.saveCandidate(actor, version("skv_ambiguous_initial"), confirmed.id);
    await assert.rejects(() => repository.findInitialExtraction(actor, "prj_story", "chp_story", "job_story"), { code: "VERSION_CONFLICT" });
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
      "../migrations/0002_extraction_recovery.sql",
      "../migrations/0003_generation_policy.sql",
      "../migrations/0004_generation_policy_audit.sql",
    ]) await adminPool.query(await readFile(new URL(path, import.meta.url), "utf8"));
    await resetFixture(adminPool);
    await adminPool.query("drop role if exists novel_story_test");
    await adminPool.query("create role novel_story_test login password 'test-only-password' in role novel_app");
    await seedProject(adminPool);
    await seedPolicy(adminPool);
    const applicationUrl = new URL(databaseUrl!);
    applicationUrl.username = "novel_story_test";
    applicationUrl.password = "test-only-password";
    applicationPool = new Pool({ connectionString: applicationUrl.toString(), max: 4 });
    const repository = new PostgresStoryKnowledgeRepository(applicationPool);
    const restriction = await adminPool.connect();
    try {
      await restriction.query("begin");
      await restriction.query("update project_generation_policy set state='complaint_suspended' where project_id='prj_story'");
      const rejected = assert.rejects(repository.saveCandidate(actor, version("skv_restricted"), null, true), { code: "FORBIDDEN" });
      let waiting = false;
      for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
        await restriction.query("select pg_stat_clear_snapshot()");
        const activity = await restriction.query("select 1 from pg_stat_activity where usename='novel_story_test' and wait_event_type='Lock' and query like '%generation_allowed_locked%'");
        waiting = activity.rowCount === 1;
        if (!waiting) await setTimeout(10);
      }
      await restriction.query("commit");
      await rejected;
      assert.equal(waiting, true, "候选必须等待未提交的投诉限制");
      assert.equal(await repository.findActive(actor, "prj_story", "chp_story"), null);
      await restriction.query("update project_generation_policy set state='allowed' where project_id='prj_story'");
    } finally { await restriction.query("rollback"); restriction.release(); }
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
      await assert.rejects(() => repository.saveCandidate(actor, current, null, true), { code: "FORBIDDEN" });
      await reimport.query("insert into source_generation_policy(workspace_id,project_id,chapter_id,source_version_id,state) values($1,'prj_story','chp_story','srcv_new','allowed')", [actor.workspaceId]);
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

async function seedPolicy(pool: Pool) {
  await pool.query("insert into project_generation_policy(workspace_id,project_id,state) values($1,'prj_story','allowed')", [actor.workspaceId]);
  await pool.query("insert into source_generation_policy(workspace_id,project_id,chapter_id,source_version_id,state) values($1,'prj_story','chp_story','srcv_story','allowed')", [actor.workspaceId]);
}

/** Disposable test DB only. Existing immutable source triggers require TRUNCATE
 * for fixture reset; remove policies through audited DELETE first, then narrowly
 * disable only the policy TRUNCATE guards inside a rollback-safe admin transaction. */
async function resetFixture(pool: Pool) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("delete from source_generation_policy");
    await client.query("delete from project_generation_policy");
    await client.query("alter table project_generation_policy disable trigger generation_policy_no_truncate");
    await client.query("alter table source_generation_policy disable trigger generation_policy_no_truncate");
    await client.query("truncate table projects cascade");
    await client.query("alter table project_generation_policy enable trigger generation_policy_no_truncate");
    await client.query("alter table source_generation_policy enable trigger generation_policy_no_truncate");
    await client.query("commit");
  } catch (error) { await client.query("rollback"); throw error; }
  finally { client.release(); }
}

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
