// Test-only closed verifier catalog. No runtime exports, grants or business reads.
import type { LedgerDatabasePool } from '../../src/postgres-ledger.ts';
import { codecCatalogQuery } from './source-codec-readiness.ts';
import { sourceIngestDraftRoleQuery } from '../../src/evidence-source-d1b-readiness.ts';

export const privateVerificationCatalogQuery=codecCatalogQuery.replaceAll('source_ingest_d1b_codec_v1','source_ingest_d1b_verify_v1');
export const privateVerificationCatalogFingerprint='1cd45fa2d0f30621cbc8a9cd5bc3fb8edbc32095b3ef5d8e83fc833d9ebfa536';

export async function assertIsolatedPrivateVerificationDatabase(pool:LedgerDatabasePool):Promise<void>{
  let query:((sql:string,values?:unknown[])=>Promise<{rows:Record<string,unknown>[]}>)|undefined;
  let release:((destroy?:boolean)=>void)|undefined;let failed=false;
  try{
    const client=await pool.connect();query=client.query.bind(client);release=client.release.bind(client);
    await query("begin isolation level repeatable read read only; set local statement_timeout='5s'; set local search_path=pg_catalog,pg_temp");
    const restricted=`select current_database() ~ '^d1b_[a-f0-9]{32}$' and current_setting('listen_addresses')=''
      and not has_schema_privilege(session_user,'source_ingest_d1b_verify_v1','CREATE')
      and not has_schema_privilege(current_user,'source_ingest_d1b_verify_v1','CREATE')
      and not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='source_ingest_d1b_verify_v1' and (has_function_privilege(session_user,p.oid,'EXECUTE')
          or has_function_privilege(current_user,p.oid,'EXECUTE'))) as ready`;
    for(const [sql,values] of [[sourceIngestDraftRoleQuery,[]],[restricted,[]],
      [privateVerificationCatalogQuery,[privateVerificationCatalogFingerprint]]] as const){
      const result=await query(sql,[...values]);
      if(result.rows.length!==1||result.rows[0]?.ready!==true)throw new Error();
    }
    await query('commit');
  }catch{
    failed=true;try{await query?.('rollback');}catch{/* no diagnostics */}
    throw new Error('PRIVATE_VERIFY_DATABASE_NOT_READY');
  }finally{try{release?.(failed);}catch{throw new Error('PRIVATE_VERIFY_DATABASE_NOT_READY');}}
}
