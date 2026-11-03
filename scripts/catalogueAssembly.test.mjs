import test from 'node:test';
import assert from 'node:assert/strict';
import fixture from './fixtures/catalogue/assembly-preparation.json' with { type: 'json' };
import { assemblySelection, assemblyPacks } from '../src/store/catalogue/assemblySelection.js';
import { INITIAL_ASSEMBLY, assemblyReducer, followAssemblyOperation } from '../src/store/catalogue/assemblyState.js';
import { createCatalogueAssemblyApi } from '../src/store/catalogue/catalogueAssemblyApi.js';
test('selection freezes visible displayed order and fiche revisions', () => {
  const cards = [{id:'c',ficheRevision:3},{id:'a',ficheRevision:4},{id:'b',ficheRevision:2}];
  const selection = assemblySelection(['a','hidden','c'], cards);
  assert.deepEqual(selection,[{ficheId:'c',expectedFicheRevision:3},{ficheId:'a',expectedFicheRevision:4}]);
  cards.reverse(); cards[2].ficheRevision=9;
  assert.equal(selection[0].expectedFicheRevision,3);
  assert.deepEqual(assemblySelection([],cards),[]);
});
test('preparation preserves corrected names, covers and provenance', () => {
  const [pack] = assemblyPacks(fixture);
  assert.equal(pack.path,'/owned/0.zip'); assert.equal(pack.name,'Titre corrigé');
  assert.equal(pack.coverImage,'/owned/0.jpg'); assert.equal(pack.provenance[0].effective.origin,'correction');
});
test('reducer handles receipts, ready, error and repeated close', () => {
  let state = assemblyReducer(INITIAL_ASSEMBLY,{type:'start'});
  state=assemblyReducer(state,{type:'receipt',receipt:{operationId:'op'}});
  assert.equal(state.operationId,'op');
  state=assemblyReducer(state,{type:'ready',preparation:fixture});
  assert.equal(state.phase,'ready'); assert.equal(state.preparation.excluded.length,1);
  assert.equal(assemblyReducer(state,{type:'error',error:'failure'}).error,'failure');
  assert.deepEqual(assemblyReducer(assemblyReducer(state,{type:'close'}),{type:'close'}),INITIAL_ASSEMBLY);
});
test('assembly adapter transports native arguments and preserves coded errors', async () => {
  const calls=[]; const api=createCatalogueAssemblyApi({invoke:async(command,args)=>{calls.push([command,args]);return command==='catalogue_get_operation'?{status:'success',result:fixture,items:[],totalMatching:0,cursor:null}:{operationId:'op'};}});
  const request={orderedSelection:[{ficheId:'card-a',expectedFicheRevision:3}],exemplarChoices:{},requestId:'request'};
  await api.prepare(request); assert.deepEqual(calls[0],['catalogue_prepare_assembly',request]);
  assert.deepEqual((await api.operation('op')).result,fixture);
  await api.cancel('op'); await api.release('owned-preparation');
  assert.deepEqual(calls[3],['catalogue_release_assembly',{preparationId:'owned-preparation'}]);
  const broken=createCatalogueAssemblyApi({invoke:async()=>{throw {code:'CATALOG_ASSEMBLY_SOURCE_CHANGED',params:{}};}});
  await assert.rejects(broken.prepare(request),error=>error.code==='CATALOG_ASSEMBLY_SOURCE_CHANGED');
});

test('operation pages open success, report errors and release late results after closing', async () => {
  for (const status of ['success', 'failed', 'cancelled', 'partial']) {
    const events = [];
    const task = { operationId: 'op', closed: false };
    const api = { operation: async () => ({status, result: status === 'success' ? fixture : null, error: {code:'failure'}, items:[], totalMatching:0, cursor:null}) };
    await followAssemblyOperation(api, task, event => events.push(event));
    assert.equal(events[0].type, status === 'success' ? 'ready' : 'error');
  }
  const released = []; const events = [];
  const task = { operationId:'op', closed:false };
  let polls = 0;
  await followAssemblyOperation({
    operation: async () => (++polls === 1 ? {status:'running',items:[]} : {status:'success',result:fixture,items:[]}),
    release: async id => released.push(id),
  }, task, event => events.push(event), async () => { task.closed = true; });
  assert.deepEqual(released, [fixture.preparationId]);
  assert.deepEqual(events, [{ type: 'progress', progress: { status: 'running', items: [] } }]);
});

test('running assembly exposes real counters without dispatch after closing', async () => {
  const events = [];
  let polls = 0;
  const progress = { status: 'running', candidates: { processed: 2, total: 5 } };
  await followAssemblyOperation({ operation: async () => ++polls === 1 ? progress : {status:'success',result:fixture} }, {operationId:'op'}, e => events.push(e), async () => {});
  assert.deepEqual(events[0], { type: 'progress', progress });
  assert.deepEqual(assemblyReducer(INITIAL_ASSEMBLY, events[0]).progress, progress);
});

test('context assembly uses the same availability as the selection bar', async () => {
  const { assemblyAction, assemblyMenuEntries } = await import('../src/store/catalogue/assemblySelection.js');
  for (const count of [0,2]) for (const phase of ['idle','preparing','ready']) {
    if (count > 1) assert.deepEqual(assemblyMenuEntries([], {kind:'card'}, count, phase)[0].action, assemblyAction(count,phase));
    else assert.deepEqual(assemblyMenuEntries([], {kind:'card'}, count, phase), [], 'FICHEB: single-card context has a fixed menu');
    assert.deepEqual(assemblyMenuEntries([], {kind:'card',step:{action:'edit'}},count,phase), []);
    assert.deepEqual(assemblyMenuEntries([], {kind:'exemplar'},count,phase), []);
  }
});

test('assembly official child origin reaches the project and survives serialization', async () => {
  const { buildAggregateProject } = await import('../src/components/AggregatePacks/aggregateProject.js');
  const { encodeProjectFile, decodeProjectFile } = await import('../src/store/projectModel.js');
  const uuid = fixture.entries[0].packUuid;
  const packs = assemblyPacks({ ...fixture, entries: [{ ...fixture.entries[0], officialProvenance: 'official', officialOriginUuid: uuid }] });
  assert.equal(packs[0].officialOriginUuid, uuid);
  const project = buildAggregateProject({ packs, metadata: { title: 'Assembly', uuid: 'author' } });
  const reopened = (await decodeProjectFile(encodeProjectFile(project))).project;
  assert.equal(reopened.rootEntries[0].officialOriginUuid, uuid);
  assert.equal(reopened.containsOfficialContent, true);
});
