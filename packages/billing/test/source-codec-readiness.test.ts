import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { assertIsolatedCodecDatabase, codecCatalogFingerprint, codecCatalogQuery } from "./support/source-codec-readiness.ts";

test("frozen codec metadata is checked read-only without learning or returning executable authority", async () => {
  const calls: { sql: string; values: unknown[] | undefined }[]=[];
  let released: boolean | undefined;
  const pool={async connect(){return {async query(sql:string,values?:unknown[]){calls.push({sql,values});return {rows:sql.startsWith('select')||sql.startsWith('with')?[{ready:true}]:[]};},release(destroy?:boolean){released=destroy;}};}};
  assert.equal(await assertIsolatedCodecDatabase(pool),undefined);
  assert.deepEqual(calls.find(c=>c.sql===codecCatalogQuery)?.values,[codecCatalogFingerprint]);
  assert.match(calls[0]!.sql,/begin read only/);
  assert.equal(calls.at(-1)!.sql,'commit');assert.equal(released,false);
  const fixture=JSON.parse(readFileSync(new URL('../../../docs/fixtures/source-codec-catalog-v1.json',import.meta.url),'utf8'));
  assert.equal(fixture.fingerprint,codecCatalogFingerprint);
  assert.ok(fixture.snapshot.acl.some((a:{identity:string})=>a.identity.startsWith('budget_bytes(')&&a.identity.length>63));
});

test("codec readiness rejects non-boolean results and destroys failed clients without diagnostics",async()=>{
  for(const ready of [false,'true',1,undefined]){
    let destroyed=false,rolledBack=false;
    const pool={async connect(){return {async query(sql:string){if(sql==='rollback')rolledBack=true;return {rows:[{ready}]};},release(value?:boolean){destroyed=value===true;}};}};
    await assert.rejects(assertIsolatedCodecDatabase(pool),{message:'CODEC_DATABASE_NOT_READY'});
    assert.equal(destroyed,true);assert.equal(rolledBack,true);
  }
});

test('catalog or release failure is sanitized and never returns a codec handle',async()=>{
  for(const fault of ['catalog','release']){
    const pool={async connect(){return {async query(sql:string){if(fault==='catalog'&&sql===codecCatalogQuery)throw new Error('private diagnostics');return {rows:[{ready:true}]};},release(){if(fault==='release')throw new Error('private release');}};}};
    await assert.rejects(assertIsolatedCodecDatabase(pool),{message:'CODEC_DATABASE_NOT_READY'});
  }
});
