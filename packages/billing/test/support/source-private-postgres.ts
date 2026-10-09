import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { TestContext } from 'node:test';
import { Pool } from 'pg';
import { assertIsolatedPrivateVerificationDatabase,privateVerificationCatalogQuery } from './source-private-readiness.ts';
import { testPrivateColumns,testPrivateRelationships,testPrivateFacts,testPrivateCapacity } from './source-private-vectors.ts';

const schema='source_ingest_d1b_verify_v1',business='source_ingest_d1b_fixture_v1';
export async function testPrivateVerification(t:TestContext,admin:Pool,inspector:Pool,url:URL){
  await admin.query(await readFile(new URL('../../../../docs/sql-drafts/evidence-source-d1b-verify.sql',import.meta.url),'utf8'));
  const catalog=(await admin.query(privateVerificationCatalogQuery,['offline-capture-only'])).rows[0];
  await t.test('closed private verifier has an independently frozen catalog',async()=>{
    const frozen=JSON.parse(await readFile(new URL('../../../../docs/fixtures/source-private-verification-catalog-v1.json',import.meta.url),'utf8'));
    assert.deepEqual(catalog.snapshot,frozen.snapshot);assert.equal(catalog.fingerprint,frozen.fingerprint);
    await assertIsolatedPrivateVerificationDatabase(inspector);
  });
  for(const [mutate,restore] of [
    [`alter function ${schema}.verify_business_row(text,jsonb) volatile`,`alter function ${schema}.verify_business_row(text,jsonb) stable`],
    [`grant usage on schema ${schema} to public`,`revoke usage on schema ${schema} from public`],
    [`grant execute on all functions in schema ${schema} to public`,`revoke execute on all functions in schema ${schema} from public`],
    [`create table ${schema}.unexpected(x int)`,`drop table ${schema}.unexpected`],
    [`alter function ${schema}.verify_business_row(text,jsonb) security definer`,`alter function ${schema}.verify_business_row(text,jsonb) security invoker`],
    [`alter function ${schema}.verify_business_row(text,jsonb) set search_path=public`,`alter function ${schema}.verify_business_row(text,jsonb) set search_path=pg_catalog,pg_temp`],
    [`alter default privileges for role codec_admin revoke execute on functions from public`,`alter default privileges for role codec_admin grant execute on functions to public`],
    [`alter role codec_inspector set application_name='drift'`,`alter role codec_inspector reset application_name`],
  ])await t.test('private catalog rejects '+mutate,async()=>{
    await admin.query(mutate!);
    try{await assert.rejects(assertIsolatedPrivateVerificationDatabase(inspector),{message:'PRIVATE_VERIFY_DATABASE_NOT_READY'});}
    finally{await admin.query(restore!);}
    await assertIsolatedPrivateVerificationDatabase(inspector);
  });
  const login='private_verify_test_login';let created=false;let wrapperCreated=false;let runtime:Pool|undefined;
  try{
    assert.equal((await admin.query("select to_regnamespace('private_verify_test') existing")).rows[0].existing,null);
    await admin.query(`create role ${login} login nosuperuser nocreatedb nocreaterole nobypassrls noreplication`);created=true;
    await admin.query(`select ${business}.prepare_test_access($1,'verify-collector','studio',true,true,true,array['task'],array['producer'],array['verify-collector'])`,[login]);
    const connection=new URL(url);connection.username=login;
    runtime=new Pool({connectionString:connection.toString(),max:1,ssl:false,options:'-c search_path=pg_catalog,pg_temp -c statement_timeout=5000'});
    const command={protocolVersion:'source-ingest-v1',workspaceId:'studio',unitId:'unit',ingestId:'verify-ingest',
      taskReference:{id:'task',version:'v1'},snapshotReference:{id:'snapshot',version:'v1'},executionReference:{id:'execution',version:'v1'}};
    await t.test('ordinary LOGIN cannot directly execute private functions',async()=>{
      await assert.rejects(runtime!.query(`select ${schema}.verify_initialize_business($1,'verify-collector','rule-v1')`,[command]),{code:'42501'});
    });
    // Explicit isolated-only privileged harness. It tests SQL semantics, not production RLS permission design.
    await admin.query(`begin; create schema private_verify_test; revoke all on schema private_verify_test from public;
      create function private_verify_test.call(command jsonb,service text,rule text) returns jsonb
      language sql security definer set search_path=pg_catalog,pg_temp as $$
        select ${schema}.verify_initialize_business(command,service,rule) $$;
      revoke all on function private_verify_test.call(jsonb,text,text) from public;
      grant usage on schema private_verify_test to ${login}; grant execute on function private_verify_test.call(jsonb,text,text) to ${login}; commit`);
    wrapperCreated=true;
    const call=(input:unknown=command,service='verify-collector',rule='rule-v1')=>runtime!.query('select private_verify_test.call($1,$2,$3) result',[input,service,rule]);
    let baseline:unknown;
    await t.test('exact saved four-record proof produces two internal sources and no receipt',async()=>{
      const result=(await call()).rows[0].result;baseline=result;
      assert.equal(result.verifiedByServiceId,'verify-collector');assert.equal(result.ruleVersion,'rule-v1');
      assert.equal(result.taskSource.id,'task');assert.equal(result.snapshotSource.id,'snapshot');
      assert.equal(result.binding.workspaceId,'studio');assert.equal(result.taskSource.payload.taskRevision,1);
      assert.equal(result.snapshotSource.payload.reserved,7);
      assert.equal('receipt' in result,false);assert.equal('executionSource' in result,false);
      const golden=JSON.parse(await readFile(new URL('../../../../docs/fixtures/source-initialize-vectors-v1.json',import.meta.url),'utf8'));
      for(const name of ['taskSource','snapshotSource']){
        const expected=golden.vectors.find((v:{name:string})=>v.name===name.replace('Source','Payload'));
        assert.equal(Buffer.from(result[name].canonicalHex,'hex').toString('utf8'),expected.canonical);
        assert.equal(result[name].payloadFingerprint,expected.sha256);
      }
    });
    await t.test('bytea_output escape preserves exact verification',async()=>{
      await runtime!.query("set bytea_output='escape'");try{assert.deepEqual((await call()).rows[0].result,baseline);}
      finally{await runtime!.query("set bytea_output='hex'");}
    });
    const tables=['task_revision','fixed_snapshot','execution_identity','fixed_quote'];
    const changes=tables.flatMap(table=>[
      [table,"canonical=convert_to(' '||convert_from(canonical,'UTF8'),'UTF8'),business_fingerprint=encode(sha256(convert_to(' '||convert_from(canonical,'UTF8'),'UTF8')),'hex')",'INTEGRITY_CONFLICT'],
      [table,"recorded_at=recorded_at+interval '1 microsecond'",'INTEGRITY_CONFLICT'],
      [table,"binding=jsonb_set(binding,'{projectId}','\"changed\"')",'INTEGRITY_CONFLICT'],
      [table,"producer_service_id='hidden'",table==='fixed_quote'?'INTEGRITY_CONFLICT':'NOT_FOUND'],
    ]);
    changes.push(['fixed_snapshot',"price_version='changed'",'INTEGRITY_CONFLICT'],
      ['execution_identity',"snapshot_version='missing'",'INTEGRITY_CONFLICT'],
      ['fixed_quote',"pricing_rule_version='changed'",'INTEGRITY_CONFLICT']);
    // Each record remains internally consistent; only the cross-record proof fails.
    for(const [table,profile,path,value,projection] of [
      ['fixed_snapshot','snapshotBusiness','binding,projectId','"changed"',"binding=changed.d->'binding'"],
      ['fixed_quote','quoteBusiness','reserved','8',"reserved=8"],
      ['execution_identity','executionBusiness','snapshotReference,version','"missing"',"snapshot_version='missing'"],
      ['fixed_snapshot','snapshotBusiness','quoteReference,version','"missing"',"quote_record_version='missing'"],
    ]){
      changes.push([table!,`document=changed.d,canonical=changed.b,business_fingerprint=encode(sha256(changed.b),'hex'),${projection}
        from (select d,source_ingest_d1b_codec_v1.encode_document('${profile}',d) b from
          (select jsonb_set(document,'{${path}}','${value}') d from ${business}.${table} where workspace_id='studio') input) changed`,'INTEGRITY_CONFLICT']);
    }
    for(const [table,change,message] of changes)await t.test(`saved ${table}: ${change}`,async()=>{
      const client=await admin.connect();
      try{
        await client.query('begin; set constraints all deferred');
        await client.query(`alter table ${business}.${table} disable trigger test_business_row`);
        await client.query(`update ${business}.${table} set ${change} where workspace_id='studio'`);
        await client.query(`set session authorization ${login}`);
        await assert.rejects(client.query('select private_verify_test.call($1,$2,$3)',[command,'verify-collector','rule-v1']),{code:'P0001',message});
      }finally{
        try{await client.query('rollback; reset session authorization');}finally{client.release(true);}
      }
      assert.deepEqual((await call()).rows[0].result,baseline);
    });
    const proofContext={admin,login,command,call,baseline};
    await testPrivateColumns(t,proofContext);
    await testPrivateRelationships(t,proofContext);
    await testPrivateFacts(t,proofContext);
    await testPrivateCapacity(t,proofContext);
    for(const [label,input,service,rule,message,code] of [
      ['extra command key',{...command,records:[]},'verify-collector','rule-v1','INVALID_COMMAND','P0001'],
      ['missing reference',{...command,taskReference:{id:'missing',version:'v1'}},'verify-collector','rule-v1','NOT_FOUND','P0001'],
      ['wrong unit',{...command,unitId:'other'},'verify-collector','rule-v1','INTEGRITY_CONFLICT','P0001'],
      ['wrong rule',command,'verify-collector','other','INTEGRITY_CONFLICT','P0001'],
      ['wrong actor assertion',command,'collector','rule-v1','FORBIDDEN','42501'],
      ['unauthorized workspace',{...command,workspaceId:'other'},'verify-collector','rule-v1','FORBIDDEN','42501'],
    ])await t.test(String(label),async()=>{await assert.rejects(call(input,String(service),String(rule)),{message,code});});
    await t.test('revoked grant denies verification and restored grant succeeds',async()=>{
      await admin.query(`select ${business}.set_test_grant_enabled('studio','verify-collector',1,false)`);
      try{await assert.rejects(call(),{code:'42501',message:'FORBIDDEN'});}
      finally{await admin.query(`select ${business}.set_test_grant_enabled('studio','verify-collector',2,true)`);}
      await call();
    });
    await t.test('verification retains authorization locks until its outer transaction ends',async()=>{
      const client=await runtime!.connect();
      try{
        await client.query('begin');
        await client.query('select private_verify_test.call($1,$2,$3)',[command,'verify-collector','rule-v1']);
        await admin.query("begin; set local lock_timeout='100ms'");
        try{await assert.rejects(admin.query(`select ${business}.set_test_grant_enabled('studio','verify-collector',3,false)`),{code:'55P03'});}
        finally{await admin.query('rollback');}
      }finally{try{await client.query('rollback');}finally{client.release(true);}}
      await call();
    });
  }finally{
    const failures:string[]=[];
    const cleanup=async(stage:string,action:()=>Promise<unknown>)=>{try{await action();}catch{failures.push(stage);}};
    await cleanup('admin-rollback',()=>admin.query('rollback'));
    await cleanup('runtime',async()=>runtime?.end());
    if(wrapperCreated)await cleanup('wrapper',()=>admin.query('drop schema private_verify_test cascade'));
    if(created)await cleanup('login',()=>admin.query(`drop role ${login}`));
    assert.deepEqual(failures,[],'PRIVATE_VERIFY_TEST_CLEANUP_FAILED');
  }
  await assertIsolatedPrivateVerificationDatabase(inspector);
}
