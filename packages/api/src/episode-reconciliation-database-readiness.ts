import type { Pool } from "pg";

/** Read-only startup check for the login that can write only reconciliation state. */
export async function assertEpisodeReconciliationDatabase(pool:Pool):Promise<void> {
  try {
    const result=await pool.query(`select
      current_user='novel_episode_reconciliation' and current_setting('row_security')='on'
      and current_setting('session_replication_role')='origin'
      and exists(select 1 from pg_roles where rolname=session_user and rolcanlogin)
      and not exists(select 1 from pg_roles where rolname in(current_user,session_user)
        and (rolsuper or rolbypassrls or rolcreaterole or rolcreatedb or rolreplication))
      and not has_schema_privilege(session_user,'public','CREATE')
      and not exists(select 1 from pg_roles where rolname not in(session_user,current_user)
        and pg_has_role(session_user,oid,'MEMBER'))
      and (select count(*)=2 and bool_and(relrowsecurity and relforcerowsecurity
          and not pg_has_role(session_user,relowner,'MEMBER')
          and not has_table_privilege(session_user,oid,'DELETE,TRUNCATE'))
        from pg_class where oid in ('public.episode_reconciliation_checkpoints'::regclass,
          'public.episode_reconciliation_alerts'::regclass))
      and (select bool_and(has_column_privilege(current_user,relation,column_name,privilege_name))
        from (values
          ('public.episode_reconciliation_checkpoints','workspace_id','SELECT,INSERT'),
          ('public.episode_reconciliation_checkpoints','cursor','SELECT,UPDATE'),
          ('public.episode_reconciliation_alerts','workspace_id','SELECT,INSERT'),
          ('public.episode_reconciliation_alerts','task_id','SELECT,INSERT'),
          ('public.episode_reconciliation_alerts','code','SELECT,INSERT')
        ) as required(relation,column_name,privilege)
        cross join lateral unnest(string_to_array(privilege,',')) individual(privilege_name)
        where privilege_name is not null)
      and not has_any_column_privilege(session_user,'public.episode_reconciliation_alerts','UPDATE')
      and not has_any_column_privilege(session_user,'public.credit_ledger_versions','SELECT,INSERT,UPDATE')
      and not has_any_column_privilege(session_user,'public.evidence_material','SELECT,INSERT,UPDATE')
      as ready`);
    if (result.rows[0]?.ready!==true) throw new Error();
  } catch { throw new Error("EPISODE_RECONCILIATION_DATABASE_NOT_READY"); }
}
