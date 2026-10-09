import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Pool } from "pg";
import { sourceBusinessFixture } from "./support/source-business-fixture.ts";
import { prepareSourceBusinessFixture } from "../src/source-business-fixture.ts";
import { assertIsolatedCodecDatabase } from "./support/source-codec-readiness.ts";

test("isolated PG16 pure codec matches fixed bytes and fails closed", { skip: !process.env.TEST_CODEC_SOCKET }, async t => {
  const socket = process.env.TEST_CODEC_SOCKET!;
  assert.match(socket, /^\/private\/tmp\/source-codec\.[A-Za-z0-9]{6}$/);
  const connection={host:socket,port:55439,database:'postgres',max:1,ssl:false,
    options:'-c search_path=pg_catalog,pg_temp -c statement_timeout=10000'};
  const pool = new Pool({ ...connection, user: "codec_admin" });
  const schema = "source_ingest_d1b_codec_v1";
  const golden = JSON.parse(readFileSync(new URL("../../../docs/fixtures/source-initialize-vectors-v1.json", import.meta.url), "utf8"));
  const values = new Map<string, Record<string, unknown>>(golden.vectors.map((v: { name: string; canonical: string }) => [v.name, JSON.parse(v.canonical)]));
  const encode = (name: string, value: unknown) => pool.query(`select ${schema}.encode_document($1,$2::jsonb) as bytes`, [name, JSON.stringify(value)]);
  try {
    const profile = await pool.query("select current_setting('server_version_num')::int/10000 as version,current_setting('listen_addresses') as tcp,current_setting('data_directory') as dir,current_setting('server_encoding') as encoding,session_user as actor,current_user as active");
    assert.deepEqual(profile.rows[0], { version: 16, tcp: "", dir: `${socket}/data`, encoding: "UTF8", actor: "codec_admin", active: "codec_admin" });
    await pool.query("set statement_timeout='10s'");
    await t.test("private worker accepts exactly 16MiB output within the bounded test deadline", async () => {
      const r = await pool.query(`select octet_length(encoded) n from ${schema}.walk(to_jsonb(repeat('a',16777214)),'"string"'::jsonb,'canonical',0,50000)`);
      assert.equal(r.rows[0].n, 16777216);
    });
    await t.test("private traversal accepts depth eight and exactly 50000 shared nodes", async () => {
      let value: unknown = 'x', shape: unknown = 'string';
      for (let i=0;i<8;i++) { value=[value]; shape={array:shape}; }
      const depth=await pool.query(`select nodes from ${schema}.walk($1::jsonb,$2::jsonb,'test',0,50000)`,[JSON.stringify(value),JSON.stringify(shape)]);
      assert.equal(depth.rows[0].nodes,9);
      await assert.rejects(pool.query(`select * from ${schema}.walk($1::jsonb,$2::jsonb,'test',0,50000)`,[JSON.stringify([value]),JSON.stringify({array:shape})]),{code:'P0001',message:'INVALID_CODEC_INPUT'});
      // 1 root + 5 branches + 500 leaf arrays + 49494 scalar values = 50000.
      const leafArrays=Array.from({length:500},(_,i)=>Array.from({length:i<494?100:i===494?94:0},()=> 'x'));
      const tree=Array.from({length:5},(_,i)=>leafArrays.slice(i*100,(i+1)*100));
      const treeShape={array:{array:{array:'string'}}};
      assert.equal((await pool.query(`select nodes from ${schema}.walk($1::jsonb,$2::jsonb,'test',0,50000)`,[JSON.stringify(tree),JSON.stringify(treeShape)])).rows[0].nodes,50000);
      leafArrays[494]!.push('x');
      await assert.rejects(pool.query(`select * from ${schema}.walk($1::jsonb,$2::jsonb,'test',0,50000)`,[JSON.stringify(tree),JSON.stringify(treeShape)]),{code:'P0001',message:'INVALID_CODEC_INPUT'});
    });
    await t.test("16MiB output plus one byte rejects without changing the bound",async()=>{
      const value={canonical:'',id:'x'};
      const overhead=Buffer.byteLength(JSON.stringify(value));
      if((16777216-overhead)%2!==0)value.id+='x';
      value.canonical='a'.repeat(16777216-Buffer.byteLength(JSON.stringify(value)));
      assert.equal(Buffer.byteLength(JSON.stringify(value)),16777216);
      const shape={canonical:'string',id:'string'};
      assert.equal((await pool.query(`select octet_length(encoded) n from ${schema}.walk($1::jsonb,$2::jsonb,'test',0,50000)`,[JSON.stringify(value),JSON.stringify(shape)])).rows[0].n,16777216);
      value.id+='x';
      await assert.rejects(pool.query(`select * from ${schema}.walk($1::jsonb,$2::jsonb,'test',0,50000)`,[JSON.stringify(value),JSON.stringify(shape)]),{code:'P0001',message:'INVALID_CODEC_INPUT'});
    });
    await t.test("2MiB input-work equality passes and one extra byte rejects",async()=>{
      const source=structuredClone(values.get('taskSource')!); source.canonical='';
      let measured=(await pool.query('select octet_length(convert_to($1::jsonb::text,\'UTF8\')) n',[JSON.stringify(source)])).rows[0].n;
      if((2097152-measured)%2!==0){source.id=String(source.id)+'x';measured++;}
      source.canonical='a'.repeat(2097152-measured);
      assert.equal((await pool.query('select octet_length(convert_to($1::jsonb::text,\'UTF8\')) n',[JSON.stringify(source)])).rows[0].n,2097152);
      await encode('taskSource',source);
      source.id=String(source.id)+'x';
      await assert.rejects(encode('taskSource',source),{code:'P0001',message:'INVALID_CODEC_INPUT'});
    });
    await t.test("package and receipt byte limits accept equality and reject one-byte overflow",async()=>{
      for(const [target,index,baseline] of [[2097152,1,4321],[16384,5,4085]]){
        const rows=['collectionBase','taskSource','snapshotSource','taskLink','snapshotLink','receiptBase','member0','member1'].map(n=>structuredClone(values.get(n)!));
        const row=rows[index!]!, field=index===1?'canonical':'command_canonical';
        let delta=target!-baseline!;
        if(delta%2!==0){row[index===1?'id':'ingest_id']=String(row[index===1?'id':'ingest_id'])+'x';delta--;}
        row[field]=String(row[field])+'a'.repeat(delta);
        const call=()=>pool.query(`select ${schema}.budget_bytes($1::jsonb,$2::jsonb,$3::jsonb,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb) budget`,rows.map(r=>JSON.stringify(r)));
        assert.equal((await call()).rows[0].budget[index===1?'packageBytes':'receiptCost'],target);
        row[index===1?'id':'ingest_id']=String(row[index===1?'id':'ingest_id'])+'x';
        await assert.rejects(call(),{code:'P0001',message:'CODEC_CAPACITY'});
      }
    });
    for (const v of golden.vectors) await t.test(`fixed ${v.name} bytes and SHA256`, async () => {
      const result = await pool.query(`select b,octet_length(b) as length,encode(sha256(b),'hex') as hash from (select ${schema}.encode_document($1,$2::jsonb) b) q`, [v.name, v.canonical]);
      assert.equal(result.rows[0].b.toString("utf8"), v.canonical);
      assert.equal(result.rows[0].length, v.bytes); assert.equal(result.rows[0].hash, v.sha256);
    });
    await t.test("both reviewed source-ingest-v1 command fingerprints remain unchanged", async () => {
      const commands = [
        ['identity', '{"executionReference":{"id":"execution-1","version":"1"},"ingestId":"ingest-1","operation":"initialize","protocolVersion":"source-ingest-v1","serviceId":"collector","snapshotReference":{"id":"snapshot-1","version":"1"},"taskReference":{"id":"task-1","version":"1"},"unitId":"unit-1","workspaceId":"studio"}', 'ebd501128ae55bf1cc1e376560fa0335fb8d12b9ebf99d3e8996e71c0ff1bce5'],
        ['registerIdentity', '{"businessReference":{"id":"任务一","kind":"snapshot","version":"1"},"expectedHeadRevision":1,"ingestId":"ingest-1","operation":"register","protocolVersion":"source-ingest-v1","serviceId":"collector","unitId":"unit-1","workspaceId":"工作室"}', 'ee5a3720794a4797942b9e5c8fc2fc85427bb5a2a9f8f4f74780a258e9117130'],
      ];
      for (const [name, json, hash] of commands) {
        const r = await pool.query(`select encode(sha256(${schema}.encode_document($1,$2::jsonb)),'hex') hash`, [name,json]);
        assert.equal(r.rows[0].hash, hash);
      }
    });
    const fixture = sourceBusinessFixture();
    for (const r of prepareSourceBusinessFixture(fixture).records) await t.test(`full ${r.kind} business canonical`, async () => {
      assert.equal((await encode(`${r.kind}Business`, r.document)).rows[0].bytes.toString("utf8"), r.canonical);
    });
    for (const kind of ["task", "snapshot"]) await t.test(`${kind} projection and unified quote rule`, async () => {
      const doc = kind === "task" ? fixture.tasks[0] : fixture.snapshot;
      const result = await pool.query(`select ${schema}.project_payload($1,$2::jsonb,$3::jsonb,$4) payload`, [kind,JSON.stringify(doc),JSON.stringify(fixture.quote),"rule-v1"]);
      assert.deepEqual(result.rows[0].payload, values.get(`${kind}Payload`));
      await assert.rejects(pool.query(`select ${schema}.project_payload($1,$2::jsonb,$3::jsonb,$4)`, [kind,JSON.stringify(doc),JSON.stringify(fixture.quote),"wrong-rule"]), { code: "P0001", message: "INVALID_CODEC_INPUT" });
    });
    await t.test("logical byte budgets match initialized and already-registered golden rows", async () => {
      for (const duplicate of [false,true]) {
        const names = ['collectionBase','taskSource','snapshotSource','taskLink','snapshotLink',duplicate?'duplicateBase':'receiptBase',duplicate?'duplicateMember0':'member0',duplicate?'duplicateMember1':'member1'];
        const result = await pool.query(`select ${schema}.budget_bytes($1::jsonb,$2::jsonb,$3::jsonb,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb) budget`, names.map(n=>JSON.stringify(values.get(n))));
        assert.deepEqual(result.rows[0].budget,{packageBytes:4321,receiptCost:duplicate?4113:4085});
      }
    });
    for (const patch of [{ extra: true }, { taskRevision: 1.5 }, { taskRevision: 9007199254740992 }, { taskRevision: 0 }, { scopeKeys: [] }, { scopeKeys: ["unit","unit"] }]) await t.test(`invalid task payload ${JSON.stringify(patch)}`, async () => {
      await assert.rejects(encode("taskPayload",{...values.get("taskPayload"),...patch}), {code:"P0001",message:"INVALID_CODEC_INPUT"});
    });
    const malformed: [string,unknown][]=[['unknownProfile',{}],['identity',{...values.get('identity'),protocolVersion:'wrong'}],
      ['receipt',{...values.get('receipt'),sourceReferences:[...(values.get('receipt')!.sourceReferences as unknown[])].reverse()}],
      ['taskPayload',{...values.get('taskPayload'),taskRevision:'1'}],['taskSource',{...values.get('taskSource'),canonical:'abc'}],
      ['taskSource',{...values.get('taskSource'),payload_fingerprint:'A'.repeat(64)}],
      ['taskSource',{...values.get('taskSource'),recorded_at:'2026-02-30T00:00:00.000Z'}],
      ['taskSource',{...values.get('taskSource'),recorded_at:'2026-10-08T08:00:00.000+08:00'}],
      ['taskPayload',{scopeKeys:['unit'],taskRevision:1}]];
    for(const [name,value] of malformed)await t.test(`strict rejection ${name} ${JSON.stringify(value).slice(0,60)}`,async()=>{
      await assert.rejects(encode(name,value),{code:'P0001',message:'INVALID_CODEC_INPUT'});
    });
    await t.test('UTF16 identifier equality and DateStyle independence',async()=>{
      for(const id of ['x'.repeat(256),'😀'.repeat(128)])await encode('identity',{...values.get('identity'),workspaceId:id});
      for(const id of ['x'.repeat(257),'😀'.repeat(128)+'x',' padded ','*','bad://id'])
        await assert.rejects(encode('identity',{...values.get('identity'),workspaceId:id}),{code:'P0001',message:'INVALID_CODEC_INPUT'});
      for(const style of ['ISO, MDY','SQL, DMY']){
        await pool.query("select set_config('DateStyle',$1,false)",[style]);
        assert.equal((await pool.query(`select ${schema}.utc_millis('2026-10-08T00:00:00.000Z'::timestamptz) s`)).rows[0].s,'2026-10-08T00:00:00.000Z');
      }
      const controls=Array.from({length:31},(_,i)=>String.fromCharCode(i+1)).join('');
      assert.equal((await pool.query(`select ${schema}.quote_string($1) s`,[controls])).rows[0].s,JSON.stringify(controls));
      assert.notEqual((await pool.query(`select ${schema}.quote_string('é') s`)).rows[0].s,(await pool.query(`select ${schema}.quote_string($1) s`,['e\u0301'])).rows[0].s);
    });
    await t.test('PG JSON parser rejects NUL and unpaired surrogates before pure encoding',async()=>{
      for(const raw of ['"\\u0000"','"\\ud800"','"\\udc00"'])
        await assert.rejects(pool.query(`select ${schema}.encode_document('identity',$1::jsonb)`,[raw]),(e:unknown)=>{
          assert.ok(e&&typeof e==='object'&&'code' in e&&['22P05','22P02'].includes(String(e.code)));return true;
        });
      for(const value of ['infinity','-infinity'])
        await assert.rejects(pool.query(`select ${schema}.utc_millis($1::timestamptz)`,[value]),{code:'P0001',message:'INVALID_CODEC_INPUT'});
    });
    await t.test("integer decimal spelling is normalized without rejection",async()=>{
      const receipt=JSON.stringify(values.get("receipt")).replace('"generationAtCommit":1','"generationAtCommit":1.0');
      const r=await pool.query(`select ${schema}.encode_document('receipt',$1::jsonb) b`,[receipt]);
      assert.equal(r.rows[0].b.toString("utf8"),golden.vectors.find((v:{name:string})=>v.name==='receipt').canonical);
    });
    await t.test("UTC formatting rejects microseconds and is session-zone independent",async()=>{
      for(const zone of ['UTC','Asia/Shanghai']){
        await pool.query("select set_config('TimeZone',$1,false)",[zone]);
        assert.equal((await pool.query(`select ${schema}.utc_millis('2026-10-08T00:00:00.000Z'::timestamptz) s`)).rows[0].s,'2026-10-08T00:00:00.000Z');
      }
      await assert.rejects(pool.query(`select ${schema}.utc_millis('2026-10-08T00:00:00.000001Z'::timestamptz)`),{code:'P0001',message:'INVALID_CODEC_INPUT'});
    });
    await t.test("PUBLIC has no schema or function permissions and no data tables exist",async()=>{
      const r=await pool.query(`select count(*)::int n from pg_proc p join pg_namespace n on n.oid=p.pronamespace cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where n.nspname=$1 and a.grantee=0`,[schema]);
      assert.equal(r.rows[0].n,0);
      assert.equal((await pool.query("select count(*)::int n from pg_namespace n cross join lateral aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a where n.nspname=$1 and a.grantee=0",[schema])).rows[0].n,0);
      assert.equal((await pool.query("select count(*)::int n from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname=$1",[schema])).rows[0].n,0);
    });
    await t.test("ordinary login cannot execute the sealed codec",async()=>{
      await pool.query("create role codec_probe login nosuperuser nocreatedb nocreaterole nobypassrls noreplication");
      const probe=new Pool({...connection,user:'codec_probe'});
      try {
        await assert.rejects(probe.query(`select ${schema}.encode_document('taskPayload',$1::jsonb)`,[JSON.stringify(values.get('taskPayload'))]),{code:'42501'});
      } finally { await probe.end(); await pool.query('drop role codec_probe'); }
    });
    await t.test("private traversal rejects exhausted depth and shared node budget",async()=>{
      await assert.rejects(pool.query(`select * from ${schema}.walk('"x"'::jsonb,'"string"'::jsonb,'id',9,50000)`),{code:'P0001',message:'INVALID_CODEC_INPUT'});
      await assert.rejects(pool.query(`select * from ${schema}.walk('["x"]'::jsonb,'{"array":"string"}'::jsonb,'upstreamVersionIds',0,1)`),{code:'P0001',message:'INVALID_CODEC_INPUT'});
      await assert.rejects(encode('taskPayload',{...values.get('taskPayload'),scopeKeys:['a'.repeat(2097152)]}),{code:'P0001',message:'INVALID_CODEC_INPUT'});
    });
    await t.test("SQL string escaping preserves Chinese, non-BMP and control characters",async()=>{
      const input='中文😀"\\\n\t\u0001/';
      assert.equal((await pool.query(`select ${schema}.quote_string($1) s`,[input])).rows[0].s,JSON.stringify(input));
    });
    await t.test('fixed metadata gate accepts the healthy restricted inspector',async()=>{
      const inspector=new Pool({...connection,user:'codec_inspector'});
      try{await assertIsolatedCodecDatabase(inspector);}finally{await inspector.end();}
    });
    const quoteDefinition=(await pool.query("select pg_get_functiondef('source_ingest_d1b_codec_v1.quote_string(text)'::regprocedure) definition")).rows[0].definition as string;
    const driftCases: [string,string,string][]=[
      ['PUBLIC execute',`grant execute on function ${schema}.quote_string(text) to public`,`revoke execute on function ${schema}.quote_string(text) from public`],
      ['inspector schema usage',`grant usage on schema ${schema} to codec_inspector`,`revoke usage on schema ${schema} from codec_inspector`],
      ['owner',`alter function ${schema}.quote_string(text) owner to codec_inspector`,`alter function ${schema}.quote_string(text) owner to codec_admin`],
      ['volatility',`alter function ${schema}.quote_string(text) stable`,`alter function ${schema}.quote_string(text) immutable`],
      ['search_path',`alter function ${schema}.quote_string(text) set search_path=public`,`alter function ${schema}.quote_string(text) set search_path=pg_catalog,pg_temp`],
      ['body/language',`create or replace function ${schema}.quote_string(value text) returns text language sql immutable security invoker set search_path=pg_catalog,pg_temp as 'select $1'`,quoteDefinition],
      ['superuser','alter role codec_inspector superuser','alter role codec_inspector nosuperuser'],
      ['membership','grant codec_admin to codec_inspector','revoke codec_admin from codec_inspector'],
      ['schema default ACL',`alter default privileges in schema ${schema} grant execute on functions to codec_inspector`,`alter default privileges in schema ${schema} revoke execute on functions from codec_inspector`],
      ['global default ACL','alter default privileges grant execute on functions to codec_inspector','alter default privileges revoke execute on functions from codec_inspector'],
      ['empty global default ACL','alter default privileges revoke execute on functions from public; alter default privileges revoke execute on functions from codec_admin','alter default privileges grant execute on functions to public; alter default privileges grant execute on functions to codec_admin'],
      ['relation',`create table ${schema}.unexpected(x integer)`,`drop table ${schema}.unexpected`],
      ['extra function',`create function ${schema}.unexpected() returns int language sql as 'select 1'`,`drop function ${schema}.unexpected()`],
    ];
    for(const [name,mutate,restore] of driftCases)await t.test(`metadata drift ${name} rejects, explicit restore returns healthy`,async()=>{
      const inspector=new Pool({...connection,user:'codec_inspector'});
      try{
        await pool.query(mutate);
        try {await assert.rejects(assertIsolatedCodecDatabase(inspector),{message:'CODEC_DATABASE_NOT_READY'});}
        finally {await pool.query(restore);}
        await assertIsolatedCodecDatabase(inspector);
      }finally{await inspector.end();}
    });
  } finally { await pool.end(); }
});
