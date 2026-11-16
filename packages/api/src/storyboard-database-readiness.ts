import type { Pool } from "pg";
import { assertSettingsDatabase } from "./settings-database-readiness.ts";

export async function assertStoryboardDatabase(pool: Pool, workspaceIds: readonly string[]) {
  try {
    await assertSettingsDatabase(pool, workspaceIds);
    const result = await pool.query(`select
      exists(select 1 from pg_class where oid=to_regclass('public.storyboard_candidate_versions')
        and relrowsecurity and relforcerowsecurity and not pg_has_role(session_user,relowner,'MEMBER')
        and has_table_privilege(current_user,oid,'SELECT') and has_table_privilege(current_user,oid,'INSERT')
        and not has_table_privilege(current_user,oid,'UPDATE,DELETE'))
      and (select count(*)=4 from pg_trigger where tgrelid=to_regclass('public.storyboard_candidate_versions')
        and tgenabled in ('O','A') and tgqual is null and (tgname,tgfoid,tgtype) in (
          ('storyboard_candidate_task',to_regprocedure('public.guard_storyboard_task_write()'),7),
          ('storyboard_candidate_authority',to_regprocedure('public.guard_storyboard_candidate()'),7),
          ('storyboard_candidate_dependencies',to_regprocedure('public.register_storyboard_dependencies()'),5),
          ('storyboard_candidate_immutable',to_regprocedure('public.reject_immutable_change()'),27)))
      and (select count(*)=2 from pg_index where indisvalid and indexrelid in (
        to_regclass('public.model_tasks_storyboard_queued_idx'),to_regclass('public.model_tasks_storyboard_recovery_idx')))
      as ready`);
    if (!result.rows[0]?.ready) throw new Error();
  } catch { throw new Error("STORYBOARD_DATABASE_NOT_READY"); }
}
