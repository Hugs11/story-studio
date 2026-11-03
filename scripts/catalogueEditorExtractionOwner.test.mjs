import test from 'node:test';
import assert from 'node:assert/strict';
import { createEditorExtractionOwner } from '../src/store/catalogue/editorExtractionOwner.js';

for (const outcome of ['success', 'cancelled', 'error']) test(`extraction owner releases after ${outcome}`, async () => {
  const released=[];
  const owner=createEditorExtractionOwner({ownerId:'funnel',release:async id=>released.push(id)});
  const result=owner.run(async()=>{if(outcome==='error')throw new Error('import failed');return {status:outcome};});
  if(outcome==='error')await assert.rejects(result,/import failed/);else assert.equal((await result).status,outcome);
  assert.deepEqual(released,[],'a displayed verdict still owns its source');
  owner.close();owner.close();
  await Promise.resolve();
  assert.deepEqual(released,['funnel']);
  let started=false;
  assert.deepEqual(await owner.run(()=>{started=true;}),{status:'cancelled'});
  assert.equal(started,false,'late work cannot recreate a closed owner');
});

test('closing during native import retains the source until the late consumer settles',async()=>{
  const released=[];let finish;
  const owner=createEditorExtractionOwner({ownerId:'pending',release:async id=>released.push(id)});
  const operation=owner.run(()=>new Promise(resolve=>{finish=resolve;}));
  owner.close();await Promise.resolve();
  assert.deepEqual(released,[]);
  finish({status:'success'});await operation;await Promise.resolve();
  assert.deepEqual(released,['pending']);
});

test('cleanup errors are best effort and do not reject successful import',async()=>{
  const owner=createEditorExtractionOwner({ownerId:'retry-at-startup',release:async()=>{throw new Error('locked file');}});
  assert.equal(await owner.run(async()=>42),42);
  owner.close();await new Promise(resolve=>setImmediate(resolve));
});

const { createEditPackOperationLifecycle, runEditPackBundleChildOperation } = await import('../src/components/EditPack/editPackOperationLifecycle.js');
for(const outcome of ['landed','choice-cancelled','error']) test(`real bundle child operation retains its owner through ${outcome}`,async()=>{
  const released=[];
  const owner=createEditorExtractionOwner({ownerId:'child',release:async id=>released.push(id)});
  const lifecycle=createEditPackOperationLifecycle();lifecycle.activate();
  const result=await owner.run(()=>runEditPackBundleChildOperation({
    lifecycle,containerPath:'/bundle.zip',containerFingerprint:'fresh',childId:'catalogue:child',
    extractChild:async()=>'/owned/pack.zip',
    classify:async()=>{assert.deepEqual(released,[]);return {authoringEditable:true};},
    chooseEditor:async()=>outcome==='choice-cancelled'?null:'free',
    landAdvanced:async()=>{},
    land:async()=>{assert.deepEqual(released,[]);if(outcome==='error')throw new Error('failed import');},
  }));
  assert.equal(result.status,outcome);
  owner.close();await Promise.resolve();
  assert.deepEqual(released,['child']);
});
