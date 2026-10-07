import type { LedgerDatabaseClient, LedgerDatabasePool } from "./postgres-ledger.ts";
import { PostgresEvidenceMaterialRepository } from "./postgres-evidence.ts";

// PostgreSQL 16 catalog fingerprints of migrations/0002_evidence_material.sql.
const constraints = [
  ["evidence_material_check", "d46eabcf177f40e025da7d4e17f5387a4ee43d32684c7da0c75211bf2a0013bd"],
  ["evidence_material_check1", "17c611614a3ec3842bf00271800cd8b83221cad711d69aa12aa64facd30277aa"],
  ["evidence_material_evidence_id_check", "2d7b5e0cfa26e7e89c7d2c29ec311953660237e170c9d10f4c0378c35b049021"],
  ["evidence_material_fingerprint_check", "049eb0f9b844137b70dbde6aa48cf6c4ec68ac805a745dff0f2fc3f5bb527f4d"],
  ["evidence_material_pkey", "802f28d72b5829a3c900ff5be5c6958687506f6342fcf72cc9a64fb19f1752e3"],
  ["evidence_material_workspace_id_check", "38221c1c30fb3fe389e60bc77cc0cea5bc20cd0dcb25feeab862855c0659910c"],
  ["evidence_material_workspace_id_predecessor_id_fkey", "f0c78bd66357a29dd862c07a55aee1051589593d6bdb5be3045b4f997a8a15ea"],
].map(([name, hash]) => ({ name, hash }));
const guardHash = "ae5a6e9fe5b1349b81481a722d88cec11bc257734d039e13e0cce54372bab0c8";
const scope = "(workspace_id = current_setting('app.evidence_workspace_id'::text, true))";

/** Point-in-time, read-only preflight. No schema repair, data writes or TLS/authentication proof. */
export async function assertEvidenceMaterialDatabase(pool: LedgerDatabasePool): Promise<void> {
  let client: LedgerDatabaseClient | undefined;
  try {
    client = await pool.connect();
    await client.query("begin read only"); await client.query("set local statement_timeout='5s'");
    await client.query("set local search_path=pg_catalog");
    const role = await client.query(`select current_user='novel_evidence'
      and current_setting('session_replication_role')='origin' and current_setting('row_security')='on'
      and not has_schema_privilege(current_user,'public','CREATE') and not has_schema_privilege(session_user,'public','CREATE')
      and not exists(select 1 from pg_roles where rolname in (session_user,current_user)
        and (rolsuper or rolcreaterole or rolcreatedb or rolbypassrls or rolreplication))
      and exists(select 1 from pg_roles where rolname=session_user and rolcanlogin)
      and not exists(select 1 from pg_roles where rolname not in (session_user,'novel_evidence')
        and pg_has_role(session_user,oid,'MEMBER')) as ready`);
    if (role.rows[0]?.ready !== true) throw new Error();
    const table = await client.query(`select count(*)=1 and bool_and(c.relkind='r' and c.relrowsecurity and c.relforcerowsecurity
      and not pg_has_role(session_user,c.relowner,'MEMBER')
      and has_table_privilege(current_user,c.oid,'SELECT') and has_table_privilege(current_user,c.oid,'INSERT')
      and not has_table_privilege(current_user,c.oid,'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      and not has_table_privilege(session_user,c.oid,'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      and not exists(select 1 from pg_attribute a where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
        and (has_column_privilege(current_user,c.oid,a.attnum,'UPDATE') or has_column_privilege(session_user,c.oid,a.attnum,'UPDATE')))
      and (select count(*)=1 and bool_and(p.polcmd='*' and p.polpermissive and p.polroles=array[to_regrole('novel_evidence')::oid]
        and pg_get_expr(p.polqual,p.polrelid)=$1 and pg_get_expr(p.polwithcheck,p.polrelid)=$1)
        from pg_policy p where p.polrelid=c.oid)) as ready
      from pg_class c where c.oid=to_regclass('public.evidence_material')`, [scope]);
    if (table.rows[0]?.ready !== true) throw new Error();
    const schema = await client.query(`select
      (select count(*)=5 from pg_attribute where attrelid=to_regclass('public.evidence_material') and attnum>0 and not attisdropped)
      and (select count(*)=5 and bool_and(a.atttypid=to_regtype(e.type) and a.attnotnull=e.required and a.attgenerated='' and a.attidentity='')
        from (values ('workspace_id','text',true),('evidence_id','text',true),('material','jsonb',true),('fingerprint','text',true),('predecessor_id','text',false)) e(name,type,required)
        join pg_attribute a on a.attrelid=to_regclass('public.evidence_material') and a.attname=e.name and not a.attisdropped)
      and (select count(*)=1 and bool_and(i.indisprimary and i.indisunique and i.indisvalid and i.indisready
        and i.indpred is null and i.indexprs is null and array(select a.attname::text from unnest(i.indkey) with ordinality k(number,ordinal)
          join pg_attribute a on a.attrelid=i.indrelid and a.attnum=k.number order by k.ordinal)=array['workspace_id','evidence_id'])
        from pg_index i where i.indrelid=to_regclass('public.evidence_material') and i.indexrelid=to_regclass('public.evidence_material_pkey'))
      and (select count(*)=7 and bool_and(c.convalidated and not c.condeferrable
        and encode(sha256(convert_to(pg_get_constraintdef(c.oid),'UTF8')),'hex')=e.hash)
        from jsonb_to_recordset($1::jsonb) e(name text,hash text)
        join pg_constraint c on c.conrelid=to_regclass('public.evidence_material') and c.conname=e.name) as ready`, [JSON.stringify(constraints)]);
    if (schema.rows[0]?.ready !== true) throw new Error();
    const guard = await client.query(`select count(*)=1 and bool_and(t.tgenabled in ('O','A') and not t.tgisinternal
      and t.tgtype=31 and t.tgqual is null and t.tgnargs=0
      and p.prorettype='trigger'::regtype and not p.prosecdef and p.proconfig=array['search_path=pg_catalog']
      and p.prolang=(select oid from pg_language where lanname='plpgsql')
      and not pg_has_role(session_user,p.proowner,'MEMBER')
      and not has_function_privilege(current_user,p.oid,'EXECUTE') and not has_function_privilege(session_user,p.oid,'EXECUTE')
      and encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=$1) as ready
      from pg_trigger t join pg_proc p on p.oid=t.tgfoid
      where t.tgrelid=to_regclass('public.evidence_material') and t.tgname='evidence_material_guard'
        and t.tgfoid=to_regprocedure('public.guard_evidence_material()')`, [guardHash]);
    if (guard.rows[0]?.ready !== true) throw new Error();
    await client.query("select workspace_id,evidence_id,material,fingerprint,predecessor_id from public.evidence_material limit 0");
    await client.query("commit");
  } catch {
    await client?.query("rollback").catch(() => {});
    throw new Error("EVIDENCE_DATABASE_NOT_READY");
  } finally { client?.release(); }
}

/** Host owns pool lifetime; fixes connect implementation before asynchronous preflight. */
export async function createCheckedEvidenceMaterialRepository(pool: LedgerDatabasePool): Promise<PostgresEvidenceMaterialRepository> {
  let bound: LedgerDatabasePool;
  try { bound = { connect: pool.connect.bind(pool) }; }
  catch { throw new Error("EVIDENCE_DATABASE_NOT_READY"); }
  await assertEvidenceMaterialDatabase(bound);
  return new PostgresEvidenceMaterialRepository(bound);
}
