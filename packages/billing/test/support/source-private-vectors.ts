import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import type { Pool } from 'pg';
import { sourceBusinessFixture } from './source-business-fixture.ts';
import { prepareSourceBusinessFixture } from '../../src/source-business-fixture.ts';
import { fixtureBusinessColumns,businessFixtureTables } from './source-business-loader.ts';

const business='source_ingest_d1b_fixture_v1';
const codec='source_ingest_d1b_codec_v1';
type Kind='task'|'snapshot'|'execution'|'quote';
type ProofContext={admin:Pool;login:string;command:unknown;call:()=>Promise<{rows:Record<string,unknown>[]}>;baseline:unknown};

/** Every schema column is deliberately enumerated, including selector columns. */
export const privateColumnManifest:Record<Kind,string[]>={
  task:['workspace_id','id','version','task_id','unit_id','binding','producer_service_id','recorded_at','document','canonical','business_fingerprint','revision','predecessor_version','scope_keys','snapshot_id','snapshot_version','execution_id','execution_version'],
  snapshot:['workspace_id','id','version','task_id','unit_id','binding','producer_service_id','recorded_at','document','canonical','business_fingerprint','task_anchor_version','execution_id','execution_version','quote_record_id','quote_record_version','quote_id','price_version','responsibility','reserved'],
  execution:['workspace_id','id','version','task_id','unit_id','binding','producer_service_id','recorded_at','document','canonical','business_fingerprint','task_anchor_version','snapshot_id','snapshot_version'],
  quote:['workspace_id','id','version','task_id','unit_id','binding','producer_service_id','recorded_at','document','canonical','business_fingerprint','task_anchor_version','execution_id','execution_version','quote_id','price_version','responsibility','reserved','pricing_rule_version'],
};

async function probe(context:ProofContext,mutation:(client:import('pg').PoolClient)=>Promise<void>,expected:string|null){
  const client=await context.admin.connect();
  try{
    await client.query('begin; set constraints all deferred');
    await mutation(client);
    await client.query(`set session authorization ${context.login}`);
    const call=()=>client.query('select private_verify_test.call($1,$2,$3) result',[context.command,'verify-collector','rule-v1']);
    if(expected)await assert.rejects(call(),{code:'P0001',message:expected});else await call();
  }finally{try{await client.query('rollback; reset session authorization');}finally{client.release(true);}}
  assert.deepEqual((await context.call()).rows[0]?.result,context.baseline);
}

async function relaxStoredChecks(client:import('pg').PoolClient,table:string){
  await client.query(`alter table ${business}.${table} disable trigger test_business_row`);
  const checks=(await client.query("select conname from pg_constraint where conrelid=$1::regclass and contype='c'",[`${business}.${table}`])).rows;
  for(const row of checks)await client.query(`alter table ${business}.${table} drop constraint "${String(row.conname).replaceAll('"','""')}"`);
}

export async function testPrivateColumns(t:TestContext,context:ProofContext){
  for(const record of prepareSourceBusinessFixture(sourceBusinessFixture()).records){
    const kind=record.kind as Kind,table=businessFixtureTables[kind];
    const columns=fixtureBusinessColumns(record);
    assert.deepEqual(Object.keys(columns).sort(),[...privateColumnManifest[kind]].sort());
    const actual=(await context.admin.query('select attname from pg_attribute where attrelid=$1::regclass and attnum>0 and not attisdropped order by attname',[`${business}.${table}`])).rows.map(row=>row.attname);
    assert.deepEqual(actual,[...privateColumnManifest[kind]].sort());
    for(const column of privateColumnManifest[kind])await t.test(`single stored column ${kind}.${column}`,async()=>{
      const original=columns[column];
      const changed=column==='canonical'?Buffer.from('damaged'):column==='business_fingerprint'?'0'.repeat(64)
        :column==='recorded_at'?'2026-10-08T00:00:00.001Z':column==='document'?{}
        :column==='binding'?{...(original as object),projectId:'other'}:column==='scope_keys'?['other']
        :typeof original==='number'?original+1:'damaged';
      const hidden=['workspace_id','id','version','producer_service_id'].includes(column);
      await probe(context,async client=>{
        // Isolated same-transaction fault injection bypasses CHECKs only; rollback restores all DDL.
        await relaxStoredChecks(client,table);
        const value=['document','binding'].includes(column)?JSON.stringify(changed):changed;
        await client.query(`update ${business}.${table} set ${column}=$1 where workspace_id='studio'`,[value]);
      },hidden&&kind!=='quote'?'NOT_FOUND':'INTEGRITY_CONFLICT');
    });
  }
}

export async function testPrivateFacts(t:TestContext,context:ProofContext){
  for(const kind of Object.keys(privateColumnManifest) as Kind[])for(const field of ['workspaceId','taskId','unitId','projectId','chapterId','sourceVersionId','upstreamVersionIds']){
    const value=field==='upstreamVersionIds'?['outline','knowledge']:'changed';
    await t.test(`self-consistent ${kind}.binding.${field} mismatch`,()=>probe(context,async client=>{
      const table=businessFixtureTables[kind];await relaxStoredChecks(client,table);
      await client.query(`with changed as(select jsonb_set(document,$1::text[],$2::jsonb) d from ${business}.${table} where workspace_id='studio'),
        encoded as(select d,${codec}.encode_document($3,d) b from changed)
        update ${business}.${table} set document=d,binding=d->'binding',canonical=b,business_fingerprint=encode(sha256(b),'hex'),
          workspace_id=d#>>'{binding,workspaceId}',task_id=d#>>'{binding,taskId}',unit_id=d#>>'{binding,unitId}'
        from encoded where workspace_id='studio'`,[['binding',field],JSON.stringify(value),kind+'Business']);
      await client.query(`select source_ingest_d1b_verify_v1.verify_business_row($1,to_jsonb(a)||jsonb_build_object('canonical',chr(92)||'x'||encode(a.canonical,'hex')))
        from ${business}.${table} a where workspace_id=$2`,[kind,field==='workspaceId'?'changed':'studio']);
    },field==='workspaceId'&&kind!=='quote'?'NOT_FOUND':'INTEGRITY_CONFLICT'));
  }
  for(const kind of ['snapshot','quote'] as const)for(const field of ['quoteId','priceVersion','reserved','responsibility']){
    const value=field==='reserved'?8:field==='responsibility'?'byok':'changed';
    const table=businessFixtureTables[kind];
    await t.test(`self-consistent ${kind}.${field} pricing mismatch`,()=>probe(context,async client=>{
      await relaxStoredChecks(client,table);
      await client.query(`with changed as(select case when $3::boolean then jsonb_set(jsonb_set(document,$1::text[],$2::jsonb),'{reserved}','0')
        else jsonb_set(document,$1::text[],$2::jsonb) end d from ${business}.${table} where workspace_id='studio'),
        encoded as(select d,${codec}.encode_document($4,d) b from changed)
        update ${business}.${table} set document=d,canonical=b,business_fingerprint=encode(sha256(b),'hex'),
          quote_id=d->>'quoteId',price_version=d->>'priceVersion',reserved=(d->>'reserved')::bigint,responsibility=d->>'responsibility'
        from encoded where workspace_id='studio'`,[[field],JSON.stringify(value),field==='responsibility',kind+'Business']);
      await client.query(`select source_ingest_d1b_verify_v1.verify_business_row($1,to_jsonb(a)||jsonb_build_object('canonical',chr(92)||'x'||encode(a.canonical,'hex')))
        from ${business}.${table} a where workspace_id='studio'`,[kind]);
    },'INTEGRITY_CONFLICT'));
  }
  await t.test('self-consistent task revision two cannot initialize',()=>probe(context,async client=>{
    await relaxStoredChecks(client,'task_revision');
    await client.query(`with changed as(select jsonb_set(document,'{revision}','2') d from ${business}.task_revision where workspace_id='studio'),
      encoded as(select d,${codec}.encode_document('taskBusiness',d) b from changed)
      update ${business}.task_revision set revision=2,document=d,canonical=b,business_fingerprint=encode(sha256(b),'hex') from encoded where workspace_id='studio'`);
  },'INTEGRITY_CONFLICT'));
}

export const privateReferenceManifest:Record<Kind,Record<string,string[]>>={
  task:{snapshotReference:['snapshot_id','snapshot_version'],executionReference:['execution_id','execution_version']},
  snapshot:{taskAnchorReference:['task_id','task_anchor_version'],executionReference:['execution_id','execution_version'],quoteReference:['quote_record_id','quote_record_version']},
  execution:{taskAnchorReference:['task_id','task_anchor_version'],snapshotReference:['snapshot_id','snapshot_version']},
  quote:{taskAnchorReference:['task_id','task_anchor_version'],executionReference:['execution_id','execution_version']},
};

export async function testPrivateRelationships(t:TestContext,context:ProofContext){
  for(const kind of Object.keys(privateReferenceManifest) as Kind[])for(const [reference,columns] of Object.entries(privateReferenceManifest[kind])){
    for(const [index,field] of ['id','version'].entries())await t.test(`self-consistent ${kind}.${reference}.${field} mismatch`,async()=>{
      const table=businessFixtureTables[kind];
      await probe(context,async client=>{
        await client.query(`alter table ${business}.${table} disable trigger test_business_row`);
        await client.query(`with changed as(select case when $3::boolean then jsonb_set(jsonb_set(document,$1::text[],'"missing"'),'{binding,taskId}','"missing"')
          else jsonb_set(document,$1::text[],'"missing"') end d from ${business}.${table} where workspace_id='studio'),
          encoded as(select d,${codec}.encode_document($2,d) b from changed)
          update ${business}.${table} set document=encoded.d,binding=encoded.d->'binding',canonical=b,business_fingerprint=encode(sha256(b),'hex'),${columns[index]}='missing'
          from encoded where workspace_id='studio'`,[[reference,field],kind+'Business',reference==='taskAnchorReference'&&field==='id']);
        // Assert each mutated row still passes its complete private consistency check.
        await client.query(`select source_ingest_d1b_verify_v1.verify_business_row($1,to_jsonb(a)||jsonb_build_object('canonical',chr(92)||'x'||encode(a.canonical,'hex')))
          from ${business}.${table} a where workspace_id='studio'`,[kind]);
      },'INTEGRITY_CONFLICT');
    });
  }
}

export async function testPrivateCapacity(t:TestContext,context:ProofContext){
  const replaceDocuments=async(client:import('pg').PoolClient,patch:string,value:unknown)=>{
    for(const kind of Object.keys(privateColumnManifest) as Kind[]){
      const table=businessFixtureTables[kind];
      await client.query(`alter table ${business}.${table} disable trigger test_business_row`);
      await client.query(`with changed as(select jsonb_set(document,$1::text[],$2::jsonb) d from ${business}.${table} where workspace_id='studio'),
        encoded as(select d,${codec}.encode_document($3,d) b from changed)
        update ${business}.${table} set document=d,binding=d->'binding',canonical=b,business_fingerprint=encode(sha256(b),'hex') from encoded where workspace_id='studio'`,[patch.split(','),JSON.stringify(value),kind+'Business']);
    }
  };
  const upstream=Array.from({length:100},(_,i)=>'中'.repeat(250)+String(i).padStart(6,'0'));
  await t.test('main verifier accepts 100 distinct Unicode IDs of 256 UTF16 units',()=>probe(context,client=>replaceDocuments(client,'binding,upstreamVersionIds',upstream),null));
  for(const [label,value] of [['101 upstream IDs',[...upstream,'overflow']],['257 UTF16 units',[...upstream.slice(0,99),'中'.repeat(257)]]])await t.test(`main verifier rejects ${label}`,async()=>{
    // Malformed document intentionally not encoded by codec: main must reject the saved input itself.
    await probe(context,async client=>{
      await client.query(`alter table ${business}.task_revision disable trigger test_business_row`);
      await client.query(`alter table ${business}.task_revision drop constraint task_revision_check1`);
      await client.query(`update ${business}.task_revision set document=jsonb_set(document,'{binding,upstreamVersionIds}',$1::jsonb) where workspace_id='studio'`,[JSON.stringify(value)]);
    },'INTEGRITY_CONFLICT');
  });
  for(const size of [2097152,2097153])await t.test(`main rejects oversized malformed business string ${size} bytes`,()=>probe(context,async client=>{
    await client.query(`alter table ${business}.task_revision disable trigger test_business_row`);
    await client.query(`alter table ${business}.task_revision drop constraint task_revision_check1`);
    await client.query(`update ${business}.task_revision set document=jsonb_set(document,'{binding,projectId}',to_jsonb(repeat('x',$1::int))) where workspace_id='studio'`,[size]);
  },'INTEGRITY_CONFLICT'));
  await t.test('fixed business profiles imply a strict sub-limit bound for all legal records',async()=>{
    const profiles=(await context.admin.query(`select ${codec}.profiles() profiles`)).rows[0].profiles;
    const bound=(shape:unknown):number=>{
      if(shape==='string')return 2+256*6; // Worst JSON escape cost per UTF16 unit.
      if(shape==='number')return 17;if(shape==='null')return 4;if(shape==='boolean')return 5;
      const object=shape as Record<string,unknown>;
      if(Object.hasOwn(object,'array'))return 2+100*(bound(object.array)+2);
      return 2+Object.entries(object).reduce((sum,[key,child])=>sum+Buffer.byteLength(JSON.stringify(key))+bound(child)+4,0);
    };
    const bounds=(['task','snapshot','execution','quote'] as const).map(kind=>bound(profiles[kind+'Business']));
    assert.ok(bounds.every(bytes=>bytes<524288));assert.ok(bounds.reduce((sum,n)=>sum+n,0)<2097152);
  });
  await t.test('main verifier accepts consistent BYOK zero reservation',()=>probe(context,async client=>{
    for(const [kind,table] of [['snapshot','fixed_snapshot'],['quote','fixed_quote']]){
      await client.query(`alter table ${business}.${table} disable trigger test_business_row`);
      await client.query(`with changed as(select jsonb_set(jsonb_set(document,'{responsibility}','"byok"'),'{reserved}','0') d from ${business}.${table} where workspace_id='studio'),
        encoded as(select d,${codec}.encode_document($1,d) b from changed)
        update ${business}.${table} set responsibility='byok',reserved=0,document=d,canonical=b,business_fingerprint=encode(sha256(b),'hex') from encoded where workspace_id='studio'`,[kind+'Business']);
    }
  },null));
}
