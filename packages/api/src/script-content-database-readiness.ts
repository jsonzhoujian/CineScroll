import type { Pool } from "pg";
import { assertEpisodeTaskDatabase } from "./episode-task-database-readiness.ts";
/** Read-only startup guard; never installs migrations or enables charging. */
export async function assertScriptContentDatabase(pool: Pool,workspaceIds: readonly string[]) {
  try { await assertEpisodeTaskDatabase(pool,workspaceIds); } catch { throw new Error("SCRIPT_CONTENT_DATABASE_NOT_READY"); }
  const client = await pool.connect().catch(() => { throw new Error("SCRIPT_CONTENT_DATABASE_NOT_READY"); });
  try {
    await client.query("begin read only"); await client.query("set local statement_timeout='5s'");
    const result = await client.query(`select count(*)=3 and bool_and(c.relrowsecurity and c.relforcerowsecurity
      and not pg_has_role(session_user,c.relowner,'MEMBER')
      and has_table_privilege(current_user,c.oid,'SELECT') and has_table_privilege(current_user,c.oid,'INSERT')
      and not has_table_privilege(current_user,c.oid,'DELETE')
      and not has_table_privilege(current_user,c.oid,'UPDATE')) ready
      from pg_class c where c.oid in (to_regclass('public.script_content_versions'),to_regclass('public.script_content_heads'),to_regclass('public.script_content_generations'))`);
    if (!result.rows[0]?.ready) throw new Error();
    const guards = await client.query(`select exists(select 1 from pg_index where indexrelid=to_regclass('public.script_content_review_request_idx') and indisvalid and indisunique)
      and exists(select 1 from pg_constraint where conrelid='public.script_content_versions'::regclass and conname='script_content_review_operation_valid' and convalidated)
      and has_column_privilege(current_user,'public.script_content_heads','active_version_id','UPDATE')
      and (select count(*)=3 from pg_trigger where tgenabled in ('O','A') and not tgisinternal and
        ((tgrelid='public.script_content_versions'::regclass and tgname='script_content_versions_immutable' and tgfoid='public.reject_immutable_change()'::regprocedure)
        or (tgrelid='public.script_content_generations'::regclass and tgname='script_content_generations_immutable' and tgfoid='public.reject_immutable_change()'::regprocedure)
        or (tgrelid='public.script_content_heads'::regclass and tgname='script_content_head_transition' and tgfoid='public.guard_script_content_head()'::regprocedure)))
      and (select count(*)=3 from pg_index where indisvalid and indexrelid in (to_regclass('public.model_tasks_script_queued_idx'),to_regclass('public.model_tasks_script_recovery_idx'),to_regclass('public.model_tasks_script_chapter_idx'))) ready`);
    if (!guards.rows[0]?.ready) throw new Error();
    await client.query("commit");
  } catch { await client.query("rollback").catch(() => {}); throw new Error("SCRIPT_CONTENT_DATABASE_NOT_READY"); }
  finally { client.release(); }
}
