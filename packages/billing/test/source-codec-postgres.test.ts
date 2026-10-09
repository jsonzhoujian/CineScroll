import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Pool } from "pg";
import { sourceBusinessFixture } from "./support/source-business-fixture.ts";
import { prepareSourceBusinessFixture } from "../src/source-business-fixture.ts";

test("isolated PG16 pure codec matches fixed bytes and fails closed", { skip: !process.env.TEST_CODEC_SOCKET }, async t => {
  const socket = process.env.TEST_CODEC_SOCKET!;
  assert.match(socket, /^\/private\/tmp\/source-codec\.[A-Za-z0-9]{6}$/);
  const pool = new Pool({ host: socket, port: 55439, user: "codec_admin", database: "postgres", max: 1 });
  const schema = "source_ingest_d1b_codec_v1";
  const golden = JSON.parse(readFileSync(new URL("../../../docs/fixtures/source-initialize-vectors-v1.json", import.meta.url), "utf8"));
  const values = new Map<string, Record<string, unknown>>(golden.vectors.map((v: { name: string; canonical: string }) => [v.name, JSON.parse(v.canonical)]));
  const encode = (name: string, value: unknown) => pool.query(`select ${schema}.encode_document($1,$2::jsonb) as bytes`, [name, JSON.stringify(value)]);
  try {
    const profile = await pool.query("select current_setting('server_version_num')::int/10000 as version,current_setting('listen_addresses') as tcp,current_setting('data_directory') as dir,current_setting('server_encoding') as encoding,session_user as actor");
    assert.deepEqual(profile.rows[0], { version: 16, tcp: "", dir: `${socket}/data`, encoding: "UTF8", actor: "codec_admin" });
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
      const probe=new Pool({host:socket,port:55439,user:'codec_probe',database:'postgres',max:1});
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
  } finally { await pool.end(); }
});
