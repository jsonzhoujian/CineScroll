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
      and exists(select 1 from pg_class where oid=to_regclass('public.storyboard_review_submissions')
        and relrowsecurity and relforcerowsecurity and not pg_has_role(session_user,relowner,'MEMBER')
        and has_table_privilege(current_user,oid,'SELECT') and has_column_privilege(current_user,oid,'job_id','INSERT')
        and not has_column_privilege(current_user,oid,'submitted_by','INSERT') and not has_table_privilege(current_user,oid,'UPDATE,DELETE'))
      and exists(select 1 from pg_trigger where tgrelid=to_regclass('public.storyboard_review_submissions')
        and tgname='storyboard_review_submission_guard' and tgfoid=to_regprocedure('public.guard_storyboard_review_submission()')
        and tgtype=7 and tgqual is null and tgenabled in ('O','A'))
      and exists(select 1 from pg_class where oid=to_regclass('public.storyboard_review_operations')
        and relrowsecurity and relforcerowsecurity and not pg_has_role(session_user,relowner,'MEMBER')
        and has_table_privilege(current_user,oid,'SELECT') and has_column_privilege(current_user,oid,'command','INSERT')
        and not has_column_privilege(current_user,oid,'revision','INSERT') and not has_column_privilege(current_user,oid,'publication_id','INSERT') and not has_table_privilege(current_user,oid,'UPDATE,DELETE'))
      and (select count(*)=2 from pg_trigger where tgrelid=to_regclass('public.storyboard_review_operations')
        and tgqual is null and tgenabled in ('O','A') and (tgname,tgfoid,tgtype) in (
          ('storyboard_review_operation_guard',to_regprocedure('public.guard_storyboard_review_operation()'),7),
          ('storyboard_review_operation_immutable',to_regprocedure('public.reject_immutable_change()'),27)))
      and exists(select 1 from pg_index where indexrelid=to_regclass('public.storyboard_formal_chapter_idx') and indisvalid)
      and exists(select 1 from pg_class where oid=to_regclass('public.storyboard_reconciliations')
        and relrowsecurity and relforcerowsecurity and not pg_has_role(session_user,relowner,'MEMBER')
        and has_table_privilege(current_user,oid,'SELECT') and has_column_privilege(current_user,oid,'upstream_ids','INSERT')
        and not has_column_privilege(current_user,oid,'id','INSERT') and not has_table_privilege(current_user,oid,'UPDATE,DELETE'))
      and exists(select 1 from pg_trigger where tgrelid=to_regclass('public.storyboard_reconciliations')
        and tgname='storyboard_reconciliation_guard' and tgfoid=to_regprocedure('public.guard_storyboard_reconciliation()')
        and tgtype=7 and tgqual is null and tgenabled in ('O','A'))
      and exists(select 1 from pg_class where oid=to_regclass('public.storyboard_reconciliation_retains')
        and relrowsecurity and relforcerowsecurity and not pg_has_role(session_user,relowner,'MEMBER')
        and has_table_privilege(current_user,oid,'SELECT') and has_column_privilege(current_user,oid,'shot_id','INSERT')
        and not has_column_privilege(current_user,oid,'retained_by','INSERT') and not has_table_privilege(current_user,oid,'UPDATE,DELETE'))
      and (select count(*)=2 from pg_trigger where tgrelid=to_regclass('public.storyboard_reconciliation_retains')
        and tgqual is null and tgenabled in ('O','A') and (tgname,tgfoid,tgtype) in (
          ('storyboard_reconciliation_retain_guard',to_regprocedure('public.guard_storyboard_reconciliation_retain()'),7),
          ('storyboard_reconciliation_retain_immutable',to_regprocedure('public.reject_immutable_change()'),27)))
      as ready`);
    if (!result.rows[0]?.ready) throw new Error();
  } catch { throw new Error("STORYBOARD_DATABASE_NOT_READY"); }
}
