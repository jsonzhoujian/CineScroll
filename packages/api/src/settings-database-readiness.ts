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
    const review = await client.query(`select
      (select count(*)=2 and bool_and(relrowsecurity and relforcerowsecurity and not pg_has_role(session_user,relowner,'MEMBER')
        and has_table_privilege(current_user,oid,'SELECT') and has_table_privilege(current_user,oid,'INSERT')
        and not has_table_privilege(current_user,oid,'UPDATE') and not has_table_privilege(current_user,oid,'DELETE'))
        from pg_class where oid in (to_regclass('public.settings_review_versions'),to_regclass('public.settings_review_heads')))
      and has_column_privilege(current_user,'public.settings_review_heads','active_version_id','UPDATE')
      and not has_column_privilege(current_user,'public.settings_review_heads','confirmed_version_id','UPDATE')
      and (select count(*)=4 from pg_constraint where conrelid in ('public.settings_review_versions'::regclass,'public.settings_review_heads'::regclass) and contype='f' and convalidated)
      and exists(select 1 from pg_constraint where conrelid='public.settings_review_versions'::regclass and contype='c' and convalidated)
      and exists(select 1 from pg_index where indexrelid=to_regclass('public.settings_review_request_idx') and indisvalid and indisunique)
      and (select count(*)=3 from pg_trigger where tgenabled in ('O','A') and ((tgrelid='public.settings_review_versions'::regclass and tgname='settings_review_immutable' and tgfoid='public.reject_immutable_change()'::regprocedure)
        or (tgrelid='public.settings_review_versions'::regclass and tgname='settings_review_transition' and tgfoid='public.guard_settings_review_version()'::regprocedure)
        or (tgrelid='public.settings_review_heads'::regclass and tgname='settings_review_head_transition' and tgfoid='public.guard_settings_review_head()'::regprocedure)))
      and (select count(*)=5 from pg_policy where (polrelid='public.settings_review_versions'::regclass and polname in ('settings_review_read','settings_review_insert'))
        or (polrelid='public.settings_review_heads'::regclass and polname in ('settings_review_heads_read','settings_review_heads_insert','settings_review_heads_update')))
      and exists(select 1 from pg_policy where polrelid='public.script_downstream_dependencies'::regclass and polname='script_settings_review_dependencies_insert' and polcmd='a')
      and has_function_privilege(current_user,'public.valid_settings_review_asset(jsonb,text,text,text)','EXECUTE')
      and exists(select 1 from pg_proc p where p.oid=to_regprocedure('public.lock_settings_review_authority(text,text,text)') and p.prosecdef
        and p.proconfig @> array['search_path=public, pg_temp'] and not pg_has_role(session_user,p.proowner,'MEMBER')
        and has_function_privilege(current_user,p.oid,'EXECUTE')
        and not exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl where acl.grantee=0 and acl.privilege_type='EXECUTE'))
      ready`);
    if (!review.rows[0]?.ready) throw new Error();
    const regeneration = await client.query(`select
      exists(select 1 from pg_constraint where conrelid='public.model_tasks'::regclass and conname='settings_regeneration_task_input_valid' and contype='c' and convalidated)
      and (select count(*)=4 from pg_index where indisvalid and indexrelid in (
        to_regclass('public.model_tasks_settings_regeneration_active_idx'),to_regclass('public.model_tasks_settings_regeneration_queued_idx'),
        to_regclass('public.model_tasks_settings_regeneration_recovery_idx'),to_regclass('public.model_tasks_settings_regeneration_chapter_idx')))
      and exists(select 1 from pg_index where indexrelid=to_regclass('public.model_tasks_settings_regeneration_active_idx') and indisvalid and indisunique)
      and exists(select 1 from pg_index where indexrelid=to_regclass('public.settings_regeneration_job_idx') and indisvalid and indisunique)
      and exists(select 1 from pg_trigger where tgrelid='public.settings_review_versions'::regclass and tgname='settings_regeneration_transition'
        and tgfoid='public.guard_settings_regeneration_version()'::regprocedure and tgenabled in ('O','A') and tgtype=7 and pg_get_triggerdef(oid)=$guard$CREATE TRIGGER settings_regeneration_transition BEFORE INSERT ON public.settings_review_versions FOR EACH ROW WHEN ((((new.version_json -> 'operation'::text) ->> 'kind'::text) = 'regenerate'::text)) EXECUTE FUNCTION guard_settings_regeneration_version()$guard$)
      and exists(select 1 from pg_trigger where tgrelid='public.settings_review_versions'::regclass and tgname='settings_review_transition'
        and tgfoid='public.guard_settings_review_version()'::regprocedure and tgenabled in ('O','A') and tgtype=7 and pg_get_triggerdef(oid)=$guard$CREATE TRIGGER settings_review_transition BEFORE INSERT ON public.settings_review_versions FOR EACH ROW WHEN ((((new.version_json -> 'operation'::text) ->> 'kind'::text) IS DISTINCT FROM 'regenerate'::text)) EXECUTE FUNCTION guard_settings_review_version()$guard$)
      and (select count(*)=2 from pg_proc p where p.oid in (to_regprocedure('public.valid_settings_regeneration_task(jsonb)'),to_regprocedure('public.valid_settings_regeneration_asset(jsonb,text,text,text)'))
        and not p.prosecdef and has_function_privilege(current_user,p.oid,'EXECUTE')
        and not exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl where acl.grantee=0 and acl.privilege_type='EXECUTE'))
      ready`);
    if (!regeneration.rows[0]?.ready) throw new Error();
    await client.query("commit");
  } catch { await client.query("rollback").catch(() => {});throw new Error("SETTINGS_DATABASE_NOT_READY"); }
  finally { client.release(); }
}
