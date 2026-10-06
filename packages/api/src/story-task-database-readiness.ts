import type { Pool } from "pg";

/** Readiness only: migrations and capacity/policy provisioning belong to a trusted administrator. */
export async function assertStoryTaskDatabase(pool: Pool, workspaceIds: readonly string[]): Promise<void> {
  const client = await pool.connect().catch(() => { throw new Error("STORY_TASK_DATABASE_NOT_READY"); });
  try {
    await client.query("begin");
    await client.query("set local statement_timeout='5s'");
    const tables = await client.query(`select bool_and(c.relrowsecurity
      and (c.relforcerowsecurity or name in ('public.projects','public.project_members'))
      and not pg_has_role(session_user,c.relowner,'MEMBER')
      and not exists(select 1 from unnest(string_to_array(privileges,',')) required(privilege)
        where not has_table_privilege(current_user,name,privilege))) as ready
      from (values ('public.model_tasks','SELECT,INSERT'),('public.workspace_task_limits','SELECT'),
        ('public.projects','SELECT'),('public.project_members','SELECT'),('public.chapters','SELECT'),
        ('public.source_versions','SELECT'),('public.source_fragments','SELECT'),('public.source_version_fragments','SELECT'),
        ('public.story_knowledge_versions','SELECT,INSERT'),('public.story_knowledge_heads','SELECT,INSERT,UPDATE'),
        ('public.project_generation_policy','SELECT'),('public.source_generation_policy','SELECT')) prerequisites(name,privileges)
      join pg_class c on c.oid=to_regclass(name) having count(*)=12`);
    if (!tables.rows[0]?.ready) throw new Error();
    const guards = await client.query(`select
      has_function_privilege(current_user,'public.generation_allowed_locked(text,text,text,text)','EXECUTE')
      and has_column_privilege(current_user,'public.model_tasks','state','UPDATE')
      and has_column_privilege(current_user,'public.model_tasks','revision','UPDATE')
      and has_column_privilege(current_user,'public.model_tasks','reason','UPDATE')
      and has_column_privilege(current_user,'public.model_tasks','result_json','UPDATE')
      and has_column_privilege(current_user,'public.model_tasks','lease_expires_at','UPDATE')
      and not has_table_privilege(current_user,'workspace_task_limits','INSERT,UPDATE,DELETE')
      and not has_table_privilege(current_user,'project_generation_policy','INSERT,UPDATE,DELETE')
      and not has_table_privilege(current_user,'source_generation_policy','INSERT,UPDATE,DELETE')
      and exists(select 1 from pg_trigger where tgrelid='public.model_tasks'::regclass and tgname='model_task_capacity'
        and tgenabled in ('O','A') and tgfoid='public.enforce_workspace_task_limits()'::regprocedure)
      and exists(select 1 from pg_trigger where tgrelid='public.model_tasks'::regclass and tgname='model_task_transition'
        and tgenabled in ('O','A') and tgfoid='public.guard_model_task_transition()'::regprocedure)
      and (select count(*)=3 from pg_index where indrelid='public.model_tasks'::regclass and indisvalid
        and indexrelid in (to_regclass('public.model_tasks_story_chapter_idx'),to_regclass('public.model_tasks_story_queued_scan_idx'),to_regclass('public.model_tasks_story_recovery_scan_idx')))
      and exists(select 1 from pg_constraint where conrelid='public.model_tasks'::regclass
        and conname='model_task_reason_valid' and pg_get_constraintdef(oid) like '%POLICY_RESTRICTED%') as ready`);
    if (!guards.rows[0]?.ready) throw new Error();
    const functions = await client.query(`select count(*)=3 and bool_and(
      not pg_has_role(session_user,p.proowner,'MEMBER')
      and case when p.oid='public.guard_model_task_transition()'::regprocedure then not p.prosecdef
        else p.prosecdef and p.proconfig @> array['search_path=pg_catalog']::text[] end) as ready
      from pg_proc p where p.oid in ('public.generation_allowed_locked(text,text,text,text)'::regprocedure,
        'public.enforce_workspace_task_limits()'::regprocedure,'public.guard_model_task_transition()'::regprocedure)`);
    if (!functions.rows[0]?.ready) throw new Error();
    await client.query("select result_json,lease_expires_at from public.model_tasks limit 0");
    for (const workspaceId of workspaceIds) {
      await client.query("select set_config('app.model_workspace_id',$1,true)", [workspaceId]);
      const quota = await client.query("select max_queued,max_executing from workspace_task_limits where workspace_id=$1", [workspaceId]);
      if (!quota.rows[0] || quota.rows[0].max_queued <= 0 || quota.rows[0].max_executing <= 0) throw new Error();
    }
    await client.query("commit");
  } catch {
    await client.query("rollback").catch(() => {});
    throw new Error("STORY_TASK_DATABASE_NOT_READY");
  } finally { client.release(); }
}
