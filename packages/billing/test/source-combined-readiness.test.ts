import assert from 'node:assert/strict';
import test from 'node:test';
import { assertIsolatedCombinedSourceDatabase } from './support/source-combined-readiness.ts';
import { businessFixtureCatalogQuery } from './support/source-business-readiness.ts';
import { codecCatalogQuery } from './support/source-codec-readiness.ts';

test('combined source readiness checks both fixed catalogs on one read-only snapshot',async()=>{
  const calls:string[]=[];let releases=0;
  const pool={async connect(){return {async query(sql:string){calls.push(sql);return {rows:[{ready:true}]};},release(){releases++;}};}};
  await assertIsolatedCombinedSourceDatabase(pool);
  assert.match(calls[0]!,/repeatable read read only/);
  assert.equal(calls.filter(s=>s===businessFixtureCatalogQuery||s===codecCatalogQuery).length,2);
  assert.equal(calls.at(-1),'commit');assert.equal(releases,1);
});

test('either combined catalog failure rolls back and destroys the connection without repair',async()=>{
  for(const target of [businessFixtureCatalogQuery,codecCatalogQuery]){
    const calls:string[]=[];let destroyed=false;
    const pool={async connect(){return {async query(sql:string){calls.push(sql);return {rows:[{ready:sql!==target}]};},release(flag?:boolean){destroyed=flag===true;}};}};
    await assert.rejects(assertIsolatedCombinedSourceDatabase(pool),{message:'COMBINED_SOURCE_DATABASE_NOT_READY'});
    assert.equal(calls.at(-1),'rollback');assert.equal(destroyed,true);assert.equal(calls.includes('commit'),false);
  }
});
