import type { LedgerDatabasePool } from "./postgres-ledger.ts";
import { sourceIngestDraftCatalogFingerprint, sourceIngestDraftCatalogQuery } from "./evidence-source-d1b-catalog.ts";

const roleQuery = `select /* source-d1b:roles */
  current_setting('server_version_num')::integer between 160000 and 169999
  and current_setting('server_encoding')='UTF8'
  and current_user='novel_d1b_inspector' and session_user<>current_user
  and current_setting('row_security')='on' and current_setting('session_replication_role')='origin'
  and exists(select 1 from pg_roles where rolname=session_user and rolcanlogin)
  and (select count(*)=6 and bool_and(not rolsuper and not rolcreatedb and not rolcreaterole and not rolbypassrls and not rolreplication)
    from pg_roles where rolname in (session_user,'novel_d1b_owner','novel_d1b_locker','novel_d1b_mutator','novel_d1b_reader','novel_d1b_inspector'))
  and (select count(*)=5 and bool_and(not rolcanlogin) from pg_roles where rolname in
    ('novel_d1b_owner','novel_d1b_locker','novel_d1b_mutator','novel_d1b_reader','novel_d1b_inspector'))
  and not exists(select 1 from pg_roles r where r.rolname not in (session_user,'novel_d1b_inspector') and pg_has_role(session_user,r.oid,'MEMBER'))
  and not exists(select 1 from pg_roles subject cross join pg_roles reachable where subject.rolname in
    ('novel_d1b_owner','novel_d1b_locker','novel_d1b_mutator','novel_d1b_reader','novel_d1b_inspector')
    and reachable.oid<>subject.oid and pg_has_role(subject.oid,reachable.oid,'MEMBER'))
  and not has_schema_privilege(session_user,'public','CREATE') and not has_schema_privilege(current_user,'public','CREATE')
  and not has_database_privilege(session_user,current_database(),'CREATE') and not has_database_privilege(current_user,current_database(),'CREATE')
  and not has_database_privilege(session_user,current_database(),'TEMP') and not has_database_privilege(current_user,current_database(),'TEMP')
  and has_schema_privilege(current_user,'source_ingest_d1b_fixture_v1','USAGE')
  and not has_schema_privilege(current_user,'source_ingest_d1b_fixture_v1','CREATE')
  and not has_schema_privilege(session_user,'source_ingest_d1b_fixture_v1','CREATE')
  and not exists(select 1 from pg_class c where c.relnamespace=to_regnamespace('source_ingest_d1b_fixture_v1') and c.relkind='r'
    and (has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or has_table_privilege(session_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or exists(select 1 from pg_attribute a where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
        and (has_column_privilege(current_user,c.oid,a.attnum,'SELECT,INSERT,UPDATE,REFERENCES')
          or has_column_privilege(session_user,c.oid,a.attnum,'SELECT,INSERT,UPDATE,REFERENCES')))))
  and not exists(select 1 from pg_proc p where p.pronamespace=to_regnamespace('source_ingest_d1b_fixture_v1')
    and (has_function_privilege(session_user,p.oid,'EXECUTE') or has_function_privilege(current_user,p.oid,'EXECUTE'))) as ready`;

/** Closed fixture profile only. Does not authenticate business sources or return a writer. */
export async function assertSourceIngestDraftDatabase(pool: LedgerDatabasePool): Promise<void> {
  let query: ((sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>) | undefined;
  let release: ((destroy?: boolean) => void) | undefined;
  let failed = false;
  try {
    const connect = pool.connect.bind(pool);
    const client = await connect();
    query = client.query.bind(client); release = client.release.bind(client);
    await query("begin read only");
    await query("set local statement_timeout='5s'");
    await query("set local search_path=pg_catalog");
    const result = await query(roleQuery);
    if (result.rows.length !== 1 || result.rows[0]?.ready !== true) throw new Error();
    const catalog = await query(sourceIngestDraftCatalogQuery, [sourceIngestDraftCatalogFingerprint]);
    if (catalog.rows.length !== 1 || catalog.rows[0]?.ready !== true) throw new Error();
    await query("commit");
  } catch {
    failed = true;
    try { await query?.("rollback"); } catch { /* Storage diagnostics stay private. */ }
    throw new Error("SOURCE_INGEST_DRAFT_DATABASE_NOT_READY");
  } finally {
    try { release?.(failed); } catch { throw new Error("SOURCE_INGEST_DRAFT_DATABASE_NOT_READY"); }
  }
}
