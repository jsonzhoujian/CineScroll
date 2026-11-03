import type { Pool } from "pg";
import { assertScriptContentDatabase } from "./script-content-database-readiness.ts";
/** Opt-in, read-only guard; settings migrations are never installed by startup. */
export async function assertSettingsDatabase(pool: Pool,workspaceIds: readonly string[]) {
  try { await assertScriptContentDatabase(pool,workspaceIds); } catch { throw new Error("SETTINGS_DATABASE_NOT_READY"); }
  const client = await pool.connect().catch(() => { throw new Error("SETTINGS_DATABASE_NOT_READY"); });
  try {
    await client.query("begin read only");await client.query("set local statement_timeout='5s'");
    const tables = await client.query(`select count(*)=2 and bool_and(c.relrowsecurity and c.relforcerowsecurity
      and not pg_has_role(session_user,c.relowner,'MEMBER')
      and has_table_privilege(current_user,c.oid,'SELECT') and has_table_privilege(current_user,c.oid,'INSERT')
      and not has_table_privilege(current_user,c.oid,'UPDATE') and not has_table_privilege(current_user,c.oid,'DELETE')) ready
      from pg_class c where c.oid in (to_regclass('public.settings_candidate_versions'),to_regclass('public.settings_candidate_heads'))`);
    if (!tables.rows[0]?.ready) throw new Error();
    const guards = await client.query(`select
      (select count(*)=2 from pg_trigger where tgenabled in ('O','A') and tgfoid='public.reject_immutable_change()'::regprocedure
        and ((tgrelid='public.settings_candidate_versions'::regclass and tgname='settings_candidates_immutable')
          or (tgrelid='public.settings_candidate_heads'::regclass and tgname='settings_heads_immutable')))
      and exists(select 1 from pg_constraint where conrelid='public.settings_candidate_versions'::regclass and contype='u' and convalidated and pg_get_constraintdef(oid)='UNIQUE (workspace_id, project_id, chapter_id, job_id)')
      and (select count(*)=4 from pg_constraint where conrelid in ('public.settings_candidate_versions'::regclass,'public.settings_candidate_heads'::regclass) and contype='f' and convalidated)
      and exists(select 1 from pg_constraint where conrelid='public.settings_candidate_versions'::regclass and contype='c' and convalidated)
      and (select count(*)=4 from pg_policy where (polrelid='public.settings_candidate_versions'::regclass and polname in ('settings_candidates_read','settings_candidates_insert')) or (polrelid='public.settings_candidate_heads'::regclass and polname in ('settings_heads_read','settings_heads_insert')))
      and has_table_privilege(current_user,'public.script_downstream_dependencies','INSERT')
      and exists(select 1 from pg_policy where polrelid='public.script_downstream_dependencies'::regclass and polname='script_settings_dependencies_insert' and polcmd='a')
      and (select count(*)=3 from pg_index where indisvalid and indexrelid in (to_regclass('public.model_tasks_settings_queued_idx'),to_regclass('public.model_tasks_settings_recovery_idx'),to_regclass('public.model_tasks_settings_chapter_idx'))) ready`);
    if (!guards.rows[0]?.ready) throw new Error();
    await client.query("commit");
  } catch { await client.query("rollback").catch(() => {});throw new Error("SETTINGS_DATABASE_NOT_READY"); }
  finally { client.release(); }
}
