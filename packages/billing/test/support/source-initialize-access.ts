import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { TestContext } from 'node:test';
import { Pool } from 'pg';
import { assertIsolatedPrivateVerificationDatabase } from './source-private-readiness.ts';

/** Isolated permission precursor only; no initialization writes or application export. */
export async function testInitializeAccess(t:TestContext,admin:Pool,inspector:Pool,url:URL){
  const role='novel_d1b_initializer',login='initialize_access_test_login';
  const schema='source_ingest_d1b_fixture_v1';
  const hiddenLogin='initialize_access_hidden_login';
  let roleCreated=false,loginCreated=false,hiddenCreated=false,wrapperCreated=false;let runtime:Pool|undefined;let hidden:Pool|undefined;
  try{
    await t.test('initializer access draft exists and installs before any write test',async()=>{
      const draft=await readFile(new URL('../../../../docs/sql-drafts/evidence-source-d1b-initialize-access.sql',import.meta.url),'utf8');
      await assert.rejects(admin.query(draft.replace(/commit;\s*$/,'select * from initialize_access_intentionally_missing; commit;')),{code:'42P01'});
      await admin.query('rollback');
      assert.equal((await admin.query('select count(*)::int n from pg_roles where rolname=$1',[role])).rows[0].n,0);
      assert.equal((await admin.query("select to_regnamespace('source_ingest_d1b_initialize_access_v1') existing")).rows[0].existing,null);
      await assertIsolatedPrivateVerificationDatabase(inspector);
      await admin.query(draft);roleCreated=true;
    });
    if(!roleCreated)return;
    const flags=(await admin.query('select rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls,rolreplication from pg_roles where rolname=$1',[role])).rows[0];
    assert.ok(Object.values(flags).every(value=>value===false));
    await admin.query(`create role ${login} login nosuperuser nocreatedb nocreaterole nobypassrls noreplication`);loginCreated=true;
    await admin.query(`select ${schema}.prepare_test_access($1,'init-collector','studio',true,true,true,array['task'],array['producer'],array['init-collector'])`,[login]);
    await admin.query(`create role ${hiddenLogin} login nosuperuser nocreatedb nocreaterole nobypassrls noreplication`);hiddenCreated=true;
    await admin.query(`select ${schema}.prepare_test_access($1,'init-hidden','studio',true,true,true,array['task'],array['other-producer'],array['init-hidden'])`,[hiddenLogin]);
    const connection=new URL(url);connection.username=login;
    runtime=new Pool({connectionString:connection.toString(),max:1,ssl:false,options:'-c search_path=pg_catalog,pg_temp -c statement_timeout=5000'});
    const hiddenConnection=new URL(connection);hiddenConnection.username=hiddenLogin;
    hidden=new Pool({connectionString:hiddenConnection.toString(),max:1,ssl:false,options:'-c search_path=pg_catalog,pg_temp -c statement_timeout=5000'});
    const command={protocolVersion:'source-ingest-v1',workspaceId:'studio',unitId:'unit',ingestId:'init-access',taskReference:{id:'task',version:'v1'},
      snapshotReference:{id:'snapshot',version:'v1'},executionReference:{id:'execution',version:'v1'}};
    await t.test('ordinary service has no table, private helper or initializer role access',async()=>{
      for(const sql of [`select * from ${schema}.task_revision`,`set role ${role}`,
        `select source_ingest_d1b_initialize_access_v1.can_read_business('studio','producer')`,
        `select source_ingest_d1b_verify_v1.verify_initialize_business('{}','init-collector','rule-v1')`])
        await assert.rejects(runtime!.query(sql),{code:'42501'});
    });
    // The wrapper is only a test invocation of the approved private verifier seam.
    // Unlike the previous administrator harness, its owner cannot bypass FORCE RLS.
    await admin.query(`begin; create schema initialize_access_test;
      revoke all on schema initialize_access_test from public;
      grant usage on schema initialize_access_test to ${role},${login},${hiddenLogin};
      create function initialize_access_test.verify(command jsonb,expected_service text) returns jsonb language sql security definer
      set search_path=pg_catalog,pg_temp as $$ select source_ingest_d1b_verify_v1.verify_initialize_business(command,expected_service,'rule-v1') $$;
      create function initialize_access_test.counts(ws text) returns integer[] language sql security definer
      set search_path=pg_catalog,pg_temp as $$ select array[
        (select count(*)::int from ${schema}.task_revision where workspace_id=ws),
        (select count(*)::int from ${schema}.fixed_snapshot where workspace_id=ws),
        (select count(*)::int from ${schema}.execution_identity where workspace_id=ws),
        (select count(*)::int from ${schema}.fixed_quote where workspace_id=ws)] $$;
      revoke all on all functions in schema initialize_access_test from public;
      alter function initialize_access_test.verify(jsonb,text) owner to ${role};
      alter function initialize_access_test.counts(text) owner to ${role};
      grant execute on all functions in schema initialize_access_test to ${login},${hiddenLogin}; commit`);wrapperCreated=true;
    const call=(input=command)=>runtime!.query('select initialize_access_test.verify($1,$2) proof',[input,'init-collector']);
    await t.test('non-bypass initializer completes exact business proof under real service RLS',async()=>{
      const result=(await call()).rows[0].proof;
      assert.equal(result.verifiedByServiceId,'init-collector');assert.equal(result.taskSource.id,'task');
      assert.equal(result.snapshotSource.id,'snapshot');assert.equal(result.binding.workspaceId,'studio');
      assert.equal('receipt' in result,false);
    });
    await t.test('RLS alone filters unauthorized workspace and all four hidden producers',async()=>{
      assert.deepEqual((await runtime!.query("select initialize_access_test.counts('studio') counts")).rows[0].counts,[1,1,1,1]);
      assert.deepEqual((await runtime!.query("select initialize_access_test.counts('parallel') counts")).rows[0].counts,[0,0,0,0]);
      assert.deepEqual((await hidden!.query("select initialize_access_test.counts('studio') counts")).rows[0].counts,[0,0,0,0]);
      await assert.rejects(hidden!.query('select initialize_access_test.verify($1,$2)',[command,'init-hidden']),{code:'P0001',message:'NOT_FOUND'});
    });
    await t.test('wrong workspace cannot pass initializer RLS authorization',async()=>{
      await assert.rejects(call({...command,workspaceId:'parallel'}),{code:'42501',message:'FORBIDDEN'});
    });
    await t.test('revocation hides all business rows from RLS and denies the verifier',async()=>{
      await admin.query(`select ${schema}.set_test_grant_enabled('studio','init-collector',1,false)`);
      try{
        assert.deepEqual((await runtime!.query("select initialize_access_test.counts('studio') counts")).rows[0].counts,[0,0,0,0]);
        await assert.rejects(call(),{code:'42501',message:'FORBIDDEN'});
      }finally{await admin.query(`select ${schema}.set_test_grant_enabled('studio','init-collector',2,true)`);}
      await call();
    });
    await t.test('all business tables retain FORCE RLS and enabled immutable guards',async()=>{
      const rows=(await admin.query(`select relforcerowsecurity forced,relrowsecurity enabled,
        (select bool_and(tgenabled='A') from pg_trigger where tgrelid=c.oid and not tgisinternal) guards
        from pg_class c where c.oid=any($1::regclass[])`,[[`${schema}.task_revision`,`${schema}.fixed_snapshot`,`${schema}.execution_identity`,`${schema}.fixed_quote`]])).rows;
      assert.equal(rows.length,4);for(const row of rows)assert.deepEqual(row,{forced:true,enabled:true,guards:true});
    });
    await t.test('initializer does not have mutation, DDL or authorization edit privileges',async()=>{
      const privileges=(await admin.query(`select
        exists(select 1 from pg_class c where c.relnamespace=$1::regnamespace and c.relkind='r'
          and has_table_privilege($2,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) mutation,
        exists(select 1 from pg_class c join pg_attribute a on a.attrelid=c.oid where c.relnamespace=$1::regnamespace and c.relkind='r'
          and a.attnum>0 and not a.attisdropped and has_column_privilege($2,c.oid,a.attnum,'INSERT,UPDATE,REFERENCES')) column_mutation,
        has_schema_privilege($2,$1,'CREATE') ddl,
        has_schema_privilege($2,'source_ingest_d1b_initialize_access_v1','CREATE') own_schema_create,
        exists(select 1 from pg_namespace n join pg_roles r on r.oid=n.nspowner where r.rolname=$2) owns_schema,
        exists(select 1 from pg_auth_members a join pg_roles r on r.oid=a.member where r.rolname=$2) member_of_role,
        has_function_privilege($2,$3,'EXECUTE') authorization_edit`,[schema,role,`${schema}.set_test_grant_enabled(text,text,bigint,boolean)`])).rows[0];
      assert.deepEqual(privileges,{mutation:false,column_mutation:false,ddl:false,own_schema_create:false,owns_schema:false,member_of_role:false,authorization_edit:false});
    });
    await t.test('old closed private profile rejects access extension instead of learning it',async()=>{
      await assert.rejects(assertIsolatedPrivateVerificationDatabase(inspector),{message:'PRIVATE_VERIFY_DATABASE_NOT_READY'});
    });
  }finally{
    const failures:string[]=[];const cleanup=async(stage:string,action:()=>Promise<unknown>)=>{try{await action();}catch{failures.push(stage);}};
    await cleanup('rollback',()=>admin.query('rollback'));
    await cleanup('runtime',async()=>runtime?.end());
    await cleanup('hidden-runtime',async()=>hidden?.end());
    if(wrapperCreated)await cleanup('wrapper',()=>admin.query('drop schema initialize_access_test cascade'));
    if(loginCreated)await cleanup('login',()=>admin.query(`drop role ${login}`));
    if(hiddenCreated)await cleanup('hidden-login',()=>admin.query(`drop role ${hiddenLogin}`));
    if(roleCreated){
      await cleanup('policies',()=>admin.query(`drop policy initializer_business_select on ${schema}.task_revision;
        drop policy initializer_business_select on ${schema}.fixed_snapshot;
        drop policy initializer_business_select on ${schema}.execution_identity;
        drop policy initializer_business_select on ${schema}.fixed_quote`));
      await cleanup('namespace',()=>admin.query('drop schema source_ingest_d1b_initialize_access_v1 cascade'));
      await cleanup('role-grants',()=>admin.query(`drop owned by ${role}`));
      await cleanup('role',()=>admin.query(`drop role ${role}`));
    }
    assert.deepEqual(failures,[],'INITIALIZE_ACCESS_TEST_CLEANUP_FAILED');
  }
  await assertIsolatedPrivateVerificationDatabase(inspector);
}
