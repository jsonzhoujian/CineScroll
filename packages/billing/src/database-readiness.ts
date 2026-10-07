import { PostgresCreditLedgerRepository, type LedgerDatabasePool } from "./postgres-ledger.ts";

const scope = "(workspace_id = current_setting('app.billing_workspace_id'::text, true))";
// SHA-256 of exact function bodies in migrations/0001_credit_ledger.sql; drift fails closed.
const immutableHash = "b0069445ad8aee3ca78ddf250e5b2f2a2e7c909c462d25943ffb4ac4af6b1eee";
const transitionHash = "38b22b6fc260f364dd9c25cca0a07ee8b71078fa269457201d96ca8ad88624d0";

/** Read-only PostgreSQL 16 preflight. Never provisions roles, schema, grants or ledger rows. */
export async function assertCreditLedgerDatabase(pool: LedgerDatabasePool): Promise<void> {
  const client = await pool.connect().catch(() => { throw new Error("BILLING_DATABASE_NOT_READY"); });
  try {
    await client.query("begin read only");
    await client.query("set local statement_timeout='5s'");
    await client.query("set local search_path=pg_catalog");
    const role = await client.query(`select current_user='novel_billing'
      and current_setting('session_replication_role')='origin'
      and not has_schema_privilege(current_user,'public','CREATE')
      and not exists(select 1 from pg_roles where rolname in (session_user,current_user)
        and (rolsuper or rolcreaterole or rolcreatedb or rolbypassrls or rolreplication))
      and exists(select 1 from pg_roles where rolname=session_user and rolcanlogin)
      and not exists(select 1 from pg_roles where rolname not in (session_user,'novel_billing')
        and pg_has_role(session_user,oid,'MEMBER')) as ready`);
    if (role.rows[0]?.ready !== true) throw new Error();
    const tables = await client.query(`select count(*)=2 and bool_and(c.relkind='r' and c.relrowsecurity and c.relforcerowsecurity
      and not pg_has_role(session_user,c.relowner,'MEMBER')
      and has_table_privilege(current_user,c.oid,'SELECT') and has_table_privilege(current_user,c.oid,'INSERT')
      and not has_table_privilege(current_user,c.oid,'DELETE,TRUNCATE,REFERENCES,TRIGGER')
      and not exists(select 1 from pg_attribute a where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
        and not (c.oid=to_regclass('public.credit_ledger_heads') and a.attname='active_revision')
        and has_column_privilege(current_user,c.oid,a.attnum,'UPDATE'))
      and (select count(*)=1 and bool_and(p.polcmd='*' and p.polpermissive and p.polroles=array[to_regrole('novel_billing')::oid]
        and pg_get_expr(p.polqual,p.polrelid)=$1 and pg_get_expr(p.polwithcheck,p.polrelid)=$1)
        from pg_policy p where p.polrelid=c.oid)) as ready
      from pg_class c where c.oid in (to_regclass('public.credit_ledger_heads'),to_regclass('public.credit_ledger_versions'))`,[scope]);
    if (tables.rows[0]?.ready !== true) throw new Error();
    const schema = await client.query(`select
      has_column_privilege(current_user,'public.credit_ledger_heads','active_revision','UPDATE')
      and (select count(*)=5 and bool_and(a.atttypid=to_regtype(expected.type) and a.attnotnull=expected.required)
        from (values ('public.credit_ledger_heads','workspace_id','text',true),
          ('public.credit_ledger_heads','active_revision','bigint',false),
          ('public.credit_ledger_versions','workspace_id','text',true),('public.credit_ledger_versions','revision','bigint',true),
          ('public.credit_ledger_versions','state_json','jsonb',true)) expected(relation,name,type,required)
        join pg_attribute a on a.attrelid=to_regclass(expected.relation) and a.attname=expected.name and not a.attisdropped)
      and (select count(*)=2 and bool_and(i.indisprimary and i.indisunique and i.indisvalid and i.indisready
        and i.indpred is null and i.indexprs is null and
          array(select a.attname::text from unnest(i.indkey) with ordinality k(number,ordinal)
            join pg_attribute a on a.attrelid=i.indrelid and a.attnum=k.number order by k.ordinal)=expected.keys)
        from (values ('public.credit_ledger_heads','public.credit_ledger_heads_pkey',array['workspace_id']),
          ('public.credit_ledger_versions','public.credit_ledger_versions_pkey',array['workspace_id','revision'])) expected(relation,index,keys)
        join pg_index i on i.indrelid=to_regclass(expected.relation) and i.indexrelid=to_regclass(expected.index))
      and (select count(*)=7 and bool_and(c.convalidated and encode(sha256(convert_to(pg_get_constraintdef(c.oid),'UTF8')),'hex')=expected.hash)
        from (values ('public.credit_ledger_heads','credit_ledger_heads_pkey','c3b8f357352086cea3a069968094b0c1dc0c8a86217e4cba2fc00c4ec90865e3'),
          ('public.credit_ledger_heads','credit_ledger_heads_workspace_id_check','38221c1c30fb3fe389e60bc77cc0cea5bc20cd0dcb25feeab862855c0659910c'),
          ('public.credit_ledger_heads','credit_ledger_heads_active_revision_check','a37e1c1310d4d076f4c6440b067760dd8311918fdd272a52e45b1c63e144fe70'),
          ('public.credit_ledger_versions','credit_ledger_versions_pkey','f6861210d8679c48a6e56e27a50e04b713c7dbe97c0dc49f8d9a010cfee7a974'),
          ('public.credit_ledger_versions','credit_ledger_versions_revision_check','5e594462d39e0aeb900691169c6393229aad6ec11f4c3dafddb0b0653efb479e'),
          ('public.credit_ledger_versions','credit_ledger_versions_check','c29b02f4cf03b4643ca7e656f57c02655b183c97a068c39e3fa8842dc6be6c64'),
          ('public.credit_ledger_versions','credit_ledger_versions_workspace_id_fkey','79ae2398ac683c301ca0d7e115b8b2d64c23fd67cd53c10c19cbb01d8afe20b7')) expected(relation,name,hash)
        join pg_constraint c on c.conrelid=to_regclass(expected.relation) and c.conname=expected.name) as ready`);
    if (schema.rows[0]?.ready !== true) throw new Error();
    const guards = await client.query(`select count(*)=2 and bool_and(t.tgenabled in ('O','A') and not t.tgisinternal
      and t.tgtype=expected.events and t.tgqual is null and t.tgnargs=0
      and p.prorettype='trigger'::regtype and not p.prosecdef and p.proconfig is null
      and not pg_has_role(session_user,p.proowner,'MEMBER')
      and not has_function_privilege(current_user,p.oid,'EXECUTE')
      and encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=expected.hash) as ready
      from (values ('public.credit_ledger_versions','credit_ledger_versions_immutable','public.reject_credit_ledger_change()',27,$1),
        ('public.credit_ledger_heads','credit_ledger_head_transition','public.guard_credit_ledger_head()',23,$2)) expected(relation,name,fn,events,hash)
      join pg_trigger t on t.tgrelid=to_regclass(expected.relation) and t.tgname=expected.name and t.tgfoid=to_regprocedure(expected.fn)
      join pg_proc p on p.oid=t.tgfoid`,[immutableHash,transitionHash]);
    if (guards.rows[0]?.ready !== true) throw new Error();
    await client.query("select workspace_id,active_revision from public.credit_ledger_heads limit 0");
    await client.query("select workspace_id,revision,state_json from public.credit_ledger_versions limit 0");
    await client.query("commit");
  } catch {
    await client.query("rollback").catch(() => {});
    throw new Error("BILLING_DATABASE_NOT_READY");
  } finally { client.release(); }
}

/** Caller owns pool lifetime; no repository is returned on failed readiness. */
export async function createCheckedCreditLedgerRepository(pool: LedgerDatabasePool): Promise<PostgresCreditLedgerRepository> {
  await assertCreditLedgerDatabase(pool);
  return new PostgresCreditLedgerRepository(pool);
}
