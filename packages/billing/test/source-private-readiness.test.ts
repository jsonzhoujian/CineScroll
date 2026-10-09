import assert from 'node:assert/strict';
import test from 'node:test';
import { assertIsolatedPrivateVerificationDatabase } from './support/source-private-readiness.ts';

test('private verification gate accepts only exact true and destroys failed connections',async()=>{
  for(const ready of [true,false,null,'true']){
    const calls:string[]=[];let destroyed=false;
    const pool={async connect(){return {async query(sql:string){calls.push(sql);return {rows:[{ready}]};},release(flag?:boolean){destroyed=flag===true;}};}};
    if(ready===true){await assertIsolatedPrivateVerificationDatabase(pool);assert.equal(calls.at(-1),'commit');}
    else {await assert.rejects(assertIsolatedPrivateVerificationDatabase(pool),{message:'PRIVATE_VERIFY_DATABASE_NOT_READY'});assert.equal(calls.at(-1),'rollback');assert.equal(destroyed,true);}
  }
});

test('each private gate query fails closed on empty, multiple or thrown results',async()=>{
  for(const target of [1,2,3])for(const mode of ['empty','multiple','throw']){
    const calls:string[]=[];let destroyed=false;let count=0;
    const pool={async connect(){return {async query(sql:string){
      calls.push(sql);if(sql.startsWith('select')||sql.startsWith('with')){
        count++;if(count===target){if(mode==='throw')throw new Error('private connection diagnostic');return {rows:mode==='empty'?[]:[{ready:true},{ready:true}]};}
      }
      return {rows:[{ready:true}]};
    },release(flag?:boolean){destroyed=flag===true;}};}};
    await assert.rejects(assertIsolatedPrivateVerificationDatabase(pool),{message:'PRIVATE_VERIFY_DATABASE_NOT_READY'});
    assert.match(calls[0]!,/repeatable read read only/);assert.equal(calls.at(-1),'rollback');assert.equal(destroyed,true);
  }
});
