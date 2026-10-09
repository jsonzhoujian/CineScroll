import assert from 'node:assert/strict';
import test from 'node:test';
import { privateColumnManifest,privateReferenceManifest } from './support/source-private-vectors.ts';

test('private coverage manifests enumerate every saved column and directional reference',()=>{
  assert.equal(Object.values(privateColumnManifest).reduce((sum,columns)=>sum+columns.length,0),71);
  assert.equal(Object.values(privateReferenceManifest).reduce((sum,references)=>sum+Object.keys(references).length,0),9);
});
