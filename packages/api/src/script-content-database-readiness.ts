import type { Pool } from "pg";
import { assertEpisodeTaskDatabase } from "./episode-task-database-readiness.ts";
/** Read-only startup guard; never installs migrations or enables charging. */
export async function assertScriptContentDatabase(pool: Pool,workspaceIds: readonly string[]) {
  try { await assertEpisodeTaskDatabase(pool,workspaceIds); } catch { throw new Error("SCRIPT_CONTENT_DATABASE_NOT_READY"); }
  const client = await pool.connect().catch(() => { throw new Error("SCRIPT_CONTENT_DATABASE_NOT_READY"); });
  try {
    await client.query("begin read only"); await client.query("set local statement_timeout='5s'");
    const result = await client.query(`select count(*)=4 and bool_and(c.relrowsecurity and c.relforcerowsecurity
      and not pg_has_role(session_user,c.relowner,'MEMBER')
      and has_table_privilege(current_user,c.oid,'SELECT') and has_table_privilege(current_user,c.oid,'INSERT')
      and not has_table_privilege(current_user,c.oid,'DELETE')
      and not has_table_privilege(current_user,c.oid,'UPDATE')) ready
      from pg_class c where c.oid in (to_regclass('public.script_content_versions'),to_regclass('public.script_content_heads'),to_regclass('public.script_content_generations'),to_regclass('public.script_quality_reports'))`);
    if (!result.rows[0]?.ready) throw new Error();
    const revision = await client.query(`select
      exists(select 1 from pg_attribute where attrelid='public.script_content_heads'::regclass and attname='confirmed_version_id' and not attisdropped)
      and exists(select 1 from pg_index where indexrelid=to_regclass('public.script_revision_request_idx') and indisvalid and indisunique)
      and (select count(*)=2 from pg_constraint where conrelid='public.script_content_versions'::regclass and conname in ('script_revision_operation_valid','script_revision_target_valid') and convalidated)
      and (select count(*)=2 and bool_and(relrowsecurity and relforcerowsecurity and has_table_privilege(current_user,oid,'SELECT') and not has_table_privilege(current_user,oid,'UPDATE') and not has_table_privilege(current_user,oid,'DELETE')) from pg_class where oid in (to_regclass('public.script_downstream_dependencies'),to_regclass('public.script_impact_links')))
      and exists(select 1 from pg_trigger where tgrelid='public.script_content_versions'::regclass and tgname='script_impacts_on_confirmation' and tgenabled in ('O','A') and tgfoid='public.record_script_impacts()'::regprocedure)
      and (select count(*)=2 from pg_trigger where tgenabled in ('O','A') and tgfoid='public.reject_immutable_change()'::regprocedure and ((tgrelid=to_regclass('public.script_downstream_dependencies') and tgname='script_dependencies_immutable') or (tgrelid=to_regclass('public.script_impact_links') and tgname='script_impacts_immutable'))) ready`);
    if (!revision.rows[0]?.ready) throw new Error();
    const guards = await client.query(`select exists(select 1 from pg_index where indexrelid=to_regclass('public.model_tasks_script_quality_active_idx') and indisvalid and indisunique)
      and exists(select 1 from pg_index where indexrelid=to_regclass('public.model_tasks_script_quality_scan_idx') and indisvalid)
      and exists(select 1 from pg_index where indexrelid=to_regclass('public.script_publication_request_idx') and indisvalid and indisunique)
      and exists(select 1 from pg_constraint where conrelid='public.script_content_versions'::regclass and conname='script_publication_operation_valid' and convalidated)
      and exists(select 1 from pg_trigger where tgrelid='public.script_quality_reports'::regclass and tgname='script_quality_reports_immutable' and tgenabled in ('O','A') and tgfoid='public.reject_immutable_change()'::regprocedure)
      and exists(select 1 from pg_trigger where tgrelid='public.script_content_versions'::regclass and tgname='script_publication_guard' and tgenabled in ('O','A') and tgfoid='public.guard_script_publication()'::regprocedure)
      and exists(select 1 from pg_index where indexrelid=to_regclass('public.model_tasks_script_retry_active_idx') and indisvalid and indisunique)
      and exists(select 1 from pg_constraint where conrelid='public.script_content_versions'::regclass and conname='script_content_retry_valid' and convalidated)
      and exists(select 1 from pg_index where indexrelid=to_regclass('public.script_content_review_request_idx') and indisvalid and indisunique)
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
