import type { Pool } from "pg";

/** Checks the dedicated service login before the worker starts. */
export async function assertEpisodeOutboxDatabase(pool: Pool): Promise<void> {
  try {
    const result = await pool.query(`select
      not exists(select 1 from pg_roles where rolname in (current_user,session_user)
        and (rolsuper or rolbypassrls or rolcreaterole or rolcreatedb))
      and not has_schema_privilege(current_user,'public','CREATE')
      and (select bool_and(pg_has_role(current_user,role,'USAGE'))
        from unnest(array['novel_app','novel_billing','novel_episode_submission','novel_episode_outbox_consumer']) role)
      and (select count(*)=4 and bool_and(relrowsecurity and relforcerowsecurity
          and not pg_has_role(session_user,relowner,'MEMBER'))
        from pg_class where oid in ('public.model_tasks'::regclass,'public.credit_ledger_heads'::regclass,
          'public.credit_ledger_versions'::regclass,'public.episode_submission_outbox'::regclass))
      and has_column_privilege(current_user,'public.episode_submission_outbox','workspace_id','INSERT')
      and has_column_privilege(current_user,'public.episode_submission_outbox','task_id','INSERT')
      and has_column_privilege(current_user,'public.episode_submission_outbox','dispatched_at','UPDATE')
      and not has_table_privilege(current_user,'public.episode_submission_outbox','DELETE,TRUNCATE') as ready`);
    if (result.rows[0]?.ready !== true) throw new Error();
  } catch { throw new Error("EPISODE_OUTBOX_DATABASE_NOT_READY"); }
}
