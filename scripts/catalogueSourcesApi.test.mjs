import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createCatalogueApi } from '../src/store/catalogue/catalogueApi.js';
import { INITIAL_OPERATIONS, operationReducer } from '../src/store/catalogue/operationView.js';
test('additive source contract and source commands preserve revisions', async () => {
  const source=JSON.parse(await readFile(new URL('./fixtures/catalogue/source.json',import.meta.url),'utf8'));
  const calls=[];
  const api=createCatalogueApi({listen:async()=>()=>{},invoke:async(command,args)=>{calls.push({command,args});return command==='catalogue_list_sources'?{items:[source],sourcesRevision:3}:{sourceId:source.id,sourcesRevision:4};}});
  const list=await api.listSources('/workspace');
  assert.deepEqual(list.items[0],source);
  await api.addSource('/packs',3);await api.removeSource('source-id',4,9);await api.explainPath('/packs/file.zip');await api.getExclusions();
  assert.deepEqual(calls[1],{command:'catalogue_add_source',args:{path:'/packs',expectedSourcesRevision:3}});
  assert.deepEqual(calls[2],{command:'catalogue_remove_source',args:{sourceId:'source-id',expectedSourcesRevision:4,expectedCatalogueRevision:9}});
  assert.equal(calls[3].command,'catalogue_explain_path');
});
test('subscribe before launch, recover earlier scan, keep newest complete snapshot', async () => {
  const calls=[],handlers={};
  const live={operationId:'startup',sequence:8,status:'failed',scanComplete:false,timestamp:5};
  const api=createCatalogueApi({listen:async(event,handler)=>{calls.push(event);handlers[event]=handler;return ()=>calls.push('release');},invoke:async(command,args)=>{calls.push(command);if(command==='catalogue_list_operations')return {items:[{...live,sequence:7,status:'running'}]};return {operationId:'new',requestId:args.requestId};}});
  let state=INITIAL_OPERATIONS;
  const stop=await api.subscribeOperations((snapshot)=>{state=operationReducer(state,{type:'snapshot',snapshot});});
  handlers['catalogue-operation-finished']({payload:live});
  for(const snapshot of (await api.listOperations()).items)state=operationReducer(state,{type:'snapshot',snapshot});
  await api.startScan({requestId:'new-request',expectedSourcesRevision:3,paths:['/packs/broken.zip']});
  assert.deepEqual(calls.slice(0,4),['catalogue-operation-progress','catalogue-operation-finished','catalogue_list_operations','catalogue_start_scan']);
  assert.equal(state.items.startup.status,'failed');
  stop();await Promise.resolve();assert.equal(calls.filter(c=>c==='release').length,2);
});
test('partially installed subscription cleans itself when the next listener fails', async () => {
  let installed=0,released=0;
  const api=createCatalogueApi({invoke:async()=>{},listen:async()=>{if(++installed===2)throw new Error('offline');return ()=>released++;}});
  await assert.rejects(()=>api.subscribeOperations(()=>{}));assert.equal(released,1);
});
test('duplicate identity has its own notice', async()=>{
  const {sourceAddResult}=await import('../src/store/catalogue/sourceView.js');
  const items=[{id:'same',status:'active',path:'/alias'}];
  assert.equal(sourceAddResult(items,{sourceId:'same'}).alreadyActive,true);
  assert.equal(sourceAddResult(items,{sourceId:'same'}).notice.key,'catalogue:sources.duplicate.message');
});
test('a folder added inside an active source is explained with the enclosing path', async()=>{
  const {sourceAddResult}=await import('../src/store/catalogue/sourceView.js');
  const before=[{id:'parent',status:'active',path:'/packs'}];
  const after=[...before,{id:'child',status:'active',path:'/packs/B',includedIn:'parent'}];
  assert.deepEqual(sourceAddResult(before,{sourceId:'child'},after).notice,{key:'catalogue:sources.nested.message',params:{path:'/packs'}});
  assert.equal(sourceAddResult(before,{sourceId:'other'},[...before,{id:'other',status:'active',path:'/elsewhere',includedIn:null}]).notice.key,'catalogue:sources.added.message');
  assert.equal(sourceAddResult(before,{sourceId:'child'}).notice.key,'catalogue:sources.added.message');
});
test('operation and explanation fixtures travel unchanged across IPC',async()=>{
  const operations=JSON.parse(await readFile(new URL('./fixtures/catalogue/operations.json',import.meta.url),'utf8'));
  const explanation=JSON.parse(await readFile(new URL('./fixtures/catalogue/path-explanation.json',import.meta.url),'utf8'));
  const api=createCatalogueApi({listen:async()=>()=>{},invoke:async(command)=>command==='catalogue_list_operations'?operations:explanation});
  assert.deepEqual(await api.listOperations(),operations);
  assert.deepEqual(await api.explainPath('/packs/broken.zip'),explanation);
});

test('source removal preview and confirmed card erasure carry the snapshot revision', async () => {
  const calls = [];
  const api = createCatalogueApi({ listen: async () => () => {}, invoke: async (command, args) => { calls.push({ command, args }); return { catalogueRevision: 12, sourcesRevision: 3, count: 2, remaining: 1 }; } });
  const preview = await api.previewRemoveSource('A');
  await api.removeSource('A', preview.sourcesRevision, preview.catalogueRevision);
  assert.deepEqual(calls, [
    { command: 'catalogue_preview_remove_source', args: { sourceId: 'A' } },
    { command: 'catalogue_remove_source', args: { sourceId: 'A', expectedSourcesRevision: 3, expectedCatalogueRevision: 12 } },
  ]);
});

test('removal preview reports a coded conflict without stringifying the error', async () => {
  const api = createCatalogueApi({ listen: async () => () => {}, invoke: async () => { throw { code: 'CATALOG_REVISION_CONFLICT', params: {} }; } });
  await assert.rejects(api.previewRemoveSource('A'), error => error.code === 'CATALOG_REVISION_CONFLICT');
});

test('hidden empty technical source duplicate keeps the duplicate notice', async () => {
  const { sourceAddResult } = await import('../src/store/catalogue/sourceView.js');
  assert.equal(sourceAddResult([], { sourceId: 'new', sourcesRevision: 5 }, [], 4).alreadyActive, false);
  for (const visible of [false, true]) {
    const items = visible ? [{ id: 'technical', status: 'active', origin: 'repatriated' }] : [];
    assert.deepEqual(sourceAddResult(items, { sourceId: 'technical', sourcesRevision: 4 }, items, 4), {
      alreadyActive: true,
      notice: { key: 'catalogue:sources.duplicate.message', params: {} },
    });
  }
});
