// Isolated combined fixture only. Both old catalog fingerprints remain unchanged.
import type { LedgerDatabasePool } from '../../src/postgres-ledger.ts';
import { sourceIngestDraftRoleQuery } from '../../src/evidence-source-d1b-readiness.ts';
import { businessFixtureExtensionRolesQuery, businessFixtureCatalogQuery, businessFixtureCatalogFingerprint } from './source-business-readiness.ts';
import { codecCatalogQuery, codecCatalogFingerprint } from './source-codec-readiness.ts';

export async function assertIsolatedCombinedSourceDatabase(pool:LedgerDatabasePool):Promise<void>{
  let query:((sql:string,values?:unknown[])=>Promise<{rows:Record<string,unknown>[]}>)|undefined;
  let release:((destroy?:boolean)=>void)|undefined;let failed=false;
  try{
    const client=await pool.connect.bind(pool)();query=client.query.bind(client);release=client.release.bind(client);
    await query("begin isolation level repeatable read read only; set local statement_timeout='5s'; set local search_path=pg_catalog,pg_temp");
    const codecPrivilegeQuery=`select current_database() ~ '^d1b_[a-f0-9]{32}$' and current_setting('listen_addresses')=''
      and not has_schema_privilege(session_user,'source_ingest_d1b_codec_v1','CREATE')
      and not has_schema_privilege(current_user,'source_ingest_d1b_codec_v1','CREATE')
      and not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='source_ingest_d1b_codec_v1' and (has_function_privilege(session_user,p.oid,'EXECUTE')
          or has_function_privilege(current_user,p.oid,'EXECUTE'))) as ready`;
    for(const [sql,values] of [[sourceIngestDraftRoleQuery,[]],[businessFixtureExtensionRolesQuery,[]],[codecPrivilegeQuery,[]],
      [businessFixtureCatalogQuery,[businessFixtureCatalogFingerprint]],[codecCatalogQuery,[codecCatalogFingerprint]]] as const){
      const r=await query(sql,[...values]);if(r.rows.length!==1||r.rows[0]?.ready!==true)throw new Error();
    }
    await query('commit');
  }catch{
    failed=true;try{await query?.('rollback');}catch{/* no diagnostics */}
    throw new Error('COMBINED_SOURCE_DATABASE_NOT_READY');
  }finally{try{release?.(failed);}catch{throw new Error('COMBINED_SOURCE_DATABASE_NOT_READY');}}
}
