import type { Pool } from "pg";
import { assertStoryTaskDatabase } from "./story-task-database-readiness.ts";

/** Read-only preflight; never provisions policies, capacity or migrations. */
export async function assertEpisodeTaskDatabase(pool: Pool, workspaceIds: readonly string[]): Promise<void> {
  try { await assertStoryTaskDatabase(pool,workspaceIds); }
  catch { throw new Error("EPISODE_TASK_DATABASE_NOT_READY"); }
  const client = await pool.connect().catch(() => { throw new Error("EPISODE_TASK_DATABASE_NOT_READY"); });
  try {
    await client.query("begin");
    await client.query("set local statement_timeout='5s'");
    const tables = await client.query(`select bool_and(c.relrowsecurity and c.relforcerowsecurity
      and not pg_has_role(session_user,c.relowner,'MEMBER')
      and not exists(select 1 from unnest(string_to_array(privileges,',')) required(privilege)
        where not has_table_privilege(current_user,name,privilege))) as ready
      from (values ('public.episode_plan_versions','SELECT,INSERT'),('public.episode_plan_heads','SELECT,INSERT'),
        ('public.episode_plan_operations','SELECT,INSERT'),('public.story_bibles','SELECT')) prerequisites(name,privileges)
      join pg_class c on c.oid=to_regclass(name) having count(*)=4`);
    if (!tables.rows[0]?.ready) throw new Error();
    const guards = await client.query(`select
      has_column_privilege(current_user,'public.episode_plan_heads','active_version_id','UPDATE')
      and has_column_privilege(current_user,'public.episode_plan_heads','confirmed_version_id','UPDATE')
      and not has_table_privilege(current_user,'public.episode_plan_versions','UPDATE,DELETE')
      and not has_table_privilege(current_user,'public.episode_plan_operations','UPDATE,DELETE')
      and (select count(*)=3 from pg_index where indrelid='public.model_tasks'::regclass and indisvalid
        and indexrelid in (to_regclass('public.model_tasks_episode_chapter_idx'),to_regclass('public.model_tasks_episode_queued_scan_idx'),to_regclass('public.model_tasks_episode_recovery_scan_idx')))
      and (select count(*)=3 from pg_trigger where tgenabled in ('O','A') and not tgisinternal and
        ((tgrelid='public.episode_plan_versions'::regclass and tgname='episode_plan_versions_immutable' and tgfoid='public.reject_immutable_change()'::regprocedure)
        or (tgrelid='public.episode_plan_operations'::regclass and tgname='episode_plan_operations_immutable' and tgfoid='public.reject_immutable_change()'::regprocedure)
        or (tgrelid='public.episode_plan_heads'::regclass and tgname='episode_plan_head_transition' and tgfoid='public.guard_episode_plan_head()'::regprocedure)))
      and (select count(*)=2 and bool_and(not prosecdef and not pg_has_role(session_user,proowner,'MEMBER'))
        from pg_proc where oid in ('public.reject_immutable_change()'::regprocedure,'public.guard_episode_plan_head()'::regprocedure)) as ready`);
    if (!guards.rows[0]?.ready) throw new Error();
    await client.query("commit");
  } catch {
    await client.query("rollback").catch(() => {});
    throw new Error("EPISODE_TASK_DATABASE_NOT_READY");
  } finally { client.release(); }
}
