import type { LedgerDatabasePool } from "./postgres-ledger.ts";
import { sourceDraftTables, sourceDraftConstraints, sourceDraftIndexes, sourceDraftFunctions } from "./evidence-source-draft-shape.ts";

const columnsJson = JSON.stringify(sourceDraftTables.flatMap(table => table.columns.map(column => ({ table: table.name, ...column }))));
const constraintsJson = JSON.stringify(sourceDraftConstraints), indexesJson = JSON.stringify(sourceDraftIndexes), functionsJson = JSON.stringify(sourceDraftFunctions);

/** Closed D1a draft catalog only. Does not return a repository or certify a writer barrier. */
export async function assertEvidenceSourceDatabase(pool: LedgerDatabasePool): Promise<void> {
  let query: ((sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>) | undefined;
  let release: ((destroy?: boolean) => void) | undefined;
  let failed = false;
  try {
    const connect = pool.connect.bind(pool);
    const client = await connect();
    release = client.release.bind(client);
    query = client.query.bind(client);
    await query("begin read only");
    await query("set local statement_timeout='5s'");
    await query("set local search_path=pg_catalog");
    const result = await query(`select /* source-d1a:roles */
      current_setting('server_version_num')::integer between 160000 and 169999
      and current_setting('server_encoding')='UTF8'
      and current_user='novel_source_inspector' and session_user<>current_user
      and current_setting('row_security')='on' and current_setting('session_replication_role')='origin'
      and exists(select 1 from pg_roles where rolname=session_user and rolcanlogin)
      and (select count(*)=3 and bool_and(not rolsuper and not rolcreatedb and not rolcreaterole and not rolbypassrls and not rolreplication)
        from pg_roles where rolname in (session_user,current_user,'novel_source_draft_owner'))
      and (select count(*)=2 and bool_and(not rolcanlogin) from pg_roles where rolname in ('novel_source_inspector','novel_source_draft_owner'))
      and not exists(select 1 from pg_roles where rolname not in (session_user,'novel_source_inspector') and pg_has_role(session_user,oid,'MEMBER'))
      and not exists(select 1 from pg_roles where rolname<>'novel_source_draft_owner' and pg_has_role('novel_source_draft_owner',oid,'MEMBER'))
      and not has_schema_privilege(session_user,'public','CREATE') and not has_schema_privilege(current_user,'public','CREATE')
      and not has_database_privilege(session_user,current_database(),'CREATE')
      and not has_database_privilege(current_user,current_database(),'CREATE') as ready`);
    if (result.rows.length !== 1 || result.rows[0]?.ready !== true) throw new Error();
    const tables = await query(`select /* source-d1a:tables */
      (select count(*)=4 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='evidence_source_draft' and c.relkind='r')
      and not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='evidence_source_draft' and c.relkind not in ('r','i'))
      and
      (select count(*)=1 and bool_and(n.nspowner=to_regrole('novel_source_draft_owner')
        and has_schema_privilege(current_user,n.oid,'USAGE') and not has_schema_privilege(current_user,n.oid,'CREATE')
        and not has_schema_privilege(session_user,n.oid,'CREATE')) from pg_namespace n where n.nspname='evidence_source_draft')
      and count(*)=4 and bool_and(c.relkind='r' and not c.relispartition and c.relrowsecurity and c.relforcerowsecurity
        and c.relowner=to_regrole('novel_source_draft_owner') and not pg_has_role(session_user,c.relowner,'MEMBER')
        and not has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        and not has_table_privilege(session_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        and not exists(select 1 from pg_attribute a where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
          and (has_column_privilege(current_user,c.oid,a.attnum,'SELECT,INSERT,UPDATE,REFERENCES')
            or has_column_privilege(session_user,c.oid,a.attnum,'SELECT,INSERT,UPDATE,REFERENCES')))
        and not exists(select 1 from pg_policy p where p.polrelid=c.oid)) as ready
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='evidence_source_draft' and c.relname in ('collection','version','seal','seal_member')`);
    if (tables.rows.length !== 1 || tables.rows[0]?.ready !== true) throw new Error();
    const structure = await query(`select /* source-d1a:structure */
      (select count(*)=jsonb_array_length($1::jsonb) and bool_and(a.atttypid=to_regtype(e.type) and a.attnotnull=e.required
        and a.attgenerated='' and a.attidentity='' and not a.atthasdef
        and (a.atttypid<>'text'::regtype or a.attcollation='"C"'::regcollation))
        from jsonb_to_recordset($1::jsonb) e("table" text,name text,type text,required boolean)
        join pg_attribute a on a.attrelid=to_regclass('evidence_source_draft.'||e."table") and a.attname=e.name and a.attnum>0 and not a.attisdropped)
      and (select count(*)=jsonb_array_length($1::jsonb) from pg_attribute a join pg_class c on c.oid=a.attrelid
        join pg_namespace n on n.oid=c.relnamespace where n.nspname='evidence_source_draft' and c.relkind='r' and a.attnum>0 and not a.attisdropped)
      and (select count(*)=jsonb_array_length($2::jsonb) and bool_and(c.contype::text=e.type and c.convalidated
        and not c.condeferrable and not c.condeferred and c.conislocal and c.coninhcount=0 and not c.connoinherit
        and (case when e.type='c' then pg_get_constraintdef(c.oid)=e.definition else
          array(select a.attname::text from unnest(c.conkey) with ordinality k(num,ord)
            join pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.num order by k.ord)=e.keys end)
        and (e.type<>'f' or (c.confrelid=to_regclass('evidence_source_draft.'||e."refTable")
          and c.confupdtype='a' and c.confdeltype='a' and c.confmatchtype='s'
          and array(select a.attname::text from unnest(c.confkey) with ordinality k(num,ord)
            join pg_attribute a on a.attrelid=c.confrelid and a.attnum=k.num order by k.ord)=e."refKeys")))
        from jsonb_to_recordset($2::jsonb) e("table" text,name text,type text,keys text[],"refTable" text,"refKeys" text[],definition text)
        join pg_constraint c on c.conrelid=to_regclass('evidence_source_draft.'||e."table") and c.conname=e.name)
      and (select count(*)=jsonb_array_length($2::jsonb) from pg_constraint c join pg_namespace n on n.oid=c.connamespace where n.nspname='evidence_source_draft')
      and (select count(*)=jsonb_array_length($3::jsonb) and bool_and(i.indisvalid and i.indisready and i.indislive
        and i.indisunique=e."unique" and i.indisprimary=e."primary" and not i.indisexclusion and i.indimmediate
        and i.indpred is null and i.indexprs is null and i.indnatts=i.indnkeyatts and am.amname='btree'
        and array(select a.attname::text from unnest(i.indkey) with ordinality k(num,ord)
          join pg_attribute a on a.attrelid=i.indrelid and a.attnum=k.num order by k.ord)=e.keys
        and not exists(select 1 from unnest(i.indoption) opt(value) where opt.value<>0)
        and not exists(select 1 from unnest(i.indclass) with ordinality op(oid,ord)
          join pg_opclass cls on cls.oid=op.oid join pg_attribute a on a.attrelid=i.indrelid and a.attnum=i.indkey[op.ord::integer-1]
          where not cls.opcdefault or cls.opcintype<>a.atttypid or cls.opcmethod<>am.oid or i.indcollation[op.ord::integer-1]<>a.attcollation))
        from jsonb_to_recordset($3::jsonb) e("table" text,name text,keys text[],"unique" boolean,"primary" boolean)
        join pg_index i on i.indrelid=to_regclass('evidence_source_draft.'||e."table") and i.indexrelid=to_regclass('evidence_source_draft.'||e.name)
        join pg_class idx on idx.oid=i.indexrelid join pg_am am on am.oid=idx.relam)
      and (select count(*)=jsonb_array_length($3::jsonb) from pg_index i join pg_class c on c.oid=i.indrelid
        join pg_namespace n on n.oid=c.relnamespace where n.nspname='evidence_source_draft') as ready`, [
      columnsJson, constraintsJson, indexesJson,
    ]);
    if (structure.rows.length !== 1 || structure.rows[0]?.ready !== true) throw new Error();
    const guards = await query(`select /* source-d1a:guards */
      (select count(*)=jsonb_array_length($1::jsonb) and bool_and(p.prokind='f' and p.prorettype=to_regtype(e.result)
        and p.provolatile::text=e.volatility and not p.prosecdef and not p.proisstrict and not p.proretset
        and not p.proleakproof and p.proparallel='u' and p.prosupport=0 and p.pronargdefaults=0 and p.prosqlbody is null
        and p.proconfig=array['search_path=pg_catalog'] and p.prosrc=e.body and l.lanname=e.language
        and p.proowner=to_regrole('novel_source_draft_owner')
        and not has_function_privilege(current_user,p.oid,'EXECUTE') and not has_function_privilege(session_user,p.oid,'EXECUTE')
        and not exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee<>p.proowner))
        from jsonb_to_recordset($1::jsonb) e(signature text,language text,result text,volatility text,body text)
        join pg_proc p on p.oid=to_regprocedure('evidence_source_draft.'||e.signature) join pg_language l on l.oid=p.prolang)
      and (select count(*)=jsonb_array_length($1::jsonb) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='evidence_source_draft')
      and (select count(*)=8 and bool_and(t.tgenabled='A' and not t.tgisinternal and t.tgqual is null and t.tgnargs=0
        and t.tgfoid=to_regprocedure('evidence_source_draft.deny_source_write()')
        and ((t.tgname='source_closed_row' and t.tgtype=31) or (t.tgname='source_closed_truncate' and t.tgtype=34)))
        from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='evidence_source_draft' and not t.tgisinternal) as ready`, [functionsJson]);
    if (guards.rows.length !== 1 || guards.rows[0]?.ready !== true) throw new Error();
    await query("commit");
  } catch {
    failed = true;
    try { await query?.("rollback"); } catch { /* Do not expose storage diagnostics. */ }
    throw new Error("EVIDENCE_SOURCE_DATABASE_NOT_READY");
  } finally {
    try { release?.(failed); } catch { throw new Error("EVIDENCE_SOURCE_DATABASE_NOT_READY"); }
  }
}
