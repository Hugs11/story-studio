import test from 'node:test';
import assert from 'node:assert/strict';
import { openTarget } from '../src/store/catalogue/openTargets.js';
import { editWarning } from '../src/store/catalogue/editWarning.js';
import { createBrowseSession, reconcileBrowseSession, restoreScroll } from '../src/store/catalogue/browseSession.js';
import { startupPage } from '../src/store/catalogue/startupPage.js';
import { createCatalogueOpenApi } from '../src/store/catalogue/catalogueOpenApi.js';

test('editor entries preserve the explicit target and preselect the pack source', () => {
  assert.deepEqual(openTarget({kind:'project',path:'/A.mbah'}),{kind:'openProject',path:'/A.mbah'});
  assert.deepEqual(openTarget({kind:'pack',path:'/A.zip',packLabel:'A'}),{kind:'openPackFunnel',source:{path:'/A.zip',packLabel:'A'}});
  const child=openTarget({kind:'bundleChild',containerPath:'/All.zip',containerFingerprint:'fresh',childId:'opaque',packLabel:'A'});
  assert.equal(child.kind,'openBundleChild');
  assert.deepEqual(child.source,{containerPath:'/All.zip',containerFingerprint:'fresh',childId:'opaque',packLabel:'A'});
  assert.equal(openTarget({kind:'pack',format:'studioDirectory',path:'/directory.zip',packLabel:'A'}).source.kind,'folder','the observed format wins over a directory suffix');
  assert.throws(()=>openTarget({kind:'pack'}));
});
test('D70 prefers the saved project, never infers one for a project target',()=>{
  assert.equal(editWarning({kind:'pack'}),null);
  const existingProject={exemplarId:'p',path:'/A.mbah',modifiedAt:123};
  assert.equal(editWarning({kind:'project',existingProject}),null);
  const warning=editWarning({kind:'bundleChild',existingProject});
  assert.equal(warning.defaultAction,'project');
  assert.equal(warning.project,existingProject);
  assert.deepEqual(warning.message.params,{project:'/A.mbah',date:123});
});
test('browse state survives an editor round trip without sharing mutable objects',()=>{
  const session=createBrowseSession();
  const snapshot={filterState:{query:'Lune',filters:{opaque:['x']}},selection:{ids:['a','b'],anchor:'a'},scroll:{cards:540,list:72},focusedCardId:'b',expanded:['a']};
  session.save(snapshot);
  snapshot.filterState.filters.opaque.push('not saved');
  const restored=session.restore();
  assert.deepEqual(restored.filterState.filters.opaque,['x']);
  restored.expanded.push('not saved');
  assert.deepEqual(session.restore().expanded,['a']);
  assert.equal(restoreScroll(restored,'cards',200),200);
  assert.equal(restoreScroll(restored,'details'),0);
  const reconciled=reconcileBrowseSession(restored,['a']);
  assert.deepEqual(reconciled.selection,{ids:['a'],anchor:'a'});
  assert.equal(reconciled.focusToolbar,true);
  assert.equal(reconciled.announcement.params.count,1);
  session.clear();
  assert.equal(session.restore(),null);
  assert.equal(createBrowseSession().restore(),null,'restart creates no persisted browse state');
});
test('only validated startup values are admitted',()=>{
  assert.equal(startupPage('catalogue'),'catalogue');
  for(const value of ['home','Catalogue',null,{},42,'']) assert.equal(startupPage(value),'home');
});
test('editor IPC forwards the displayed identity and revision, preserving typed errors',async()=>{
  const calls=[];
  const api=createCatalogueOpenApi({invoke:async(command,args)=>{calls.push({command,args});return {kind:'project',path:'/A.mbah'};}});
  assert.equal((await api.prepareEditorEntry({exemplarId:'a',expectedRevision:4,purpose:'edit'})).kind,'project');
  assert.deepEqual(calls,[{command:'catalogue_prepare_editor_entry',args:{exemplarId:'a',expectedRevision:4,purpose:'edit'}}]);
  const failing=createCatalogueOpenApi({invoke:async()=>{throw {code:'CATALOG_TARGET_REVISION_CHANGED',params:{path:'/A.zip'}};}});
  await assert.rejects(failing.prepareEditorEntry({}),e=>e.code==='CATALOG_TARGET_REVISION_CHANGED');
});

test('editor entry contract is read through the real IPC adapter',async()=>{
  const {readFile}=await import('node:fs/promises');
  const fixture=JSON.parse(await readFile(new URL('./fixtures/catalogue/editor-entries.json',import.meta.url)));
  for(const entry of Object.values(fixture)) {
    const api=createCatalogueOpenApi({invoke:async()=>entry});
    const response=await api.prepareEditorEntry({exemplarId:'a',expectedRevision:1,purpose:'edit'});
    assert.equal(openTarget(response).kind,{project:'openProject',pack:'openPackFunnel',bundleChild:'openBundleChild'}[entry.kind]);
  }
});

test('receipt IPC preserves immutable evidence and extraction release names its owner',async()=>{
  const calls=[];
  const api=createCatalogueOpenApi({invoke:async(command,args)=>{calls.push({command,args});return {recorded:false,reason:'projectChanged'};}});
  assert.equal((await api.recordGeneration({projectPath:'/A.mbah',outputPath:'/A.zip',generatedProjectJson:'saved A'})).reason,'projectChanged');
  await api.releaseEditorExtractions('owner');
  assert.deepEqual(calls,[
    {command:'catalogue_record_generation',args:{projectPath:'/A.mbah',outputPath:'/A.zip',generatedProjectJson:'saved A'}},
    {command:'catalogue_release_editor_extractions',args:{ownerId:'owner'}},
  ]);
});

test('legacy browse filters migrate once, preserving the query and unrelated criteria', async () => {
  const { normalizeFilters } = await import('../src/store/catalogue/filters.js');
  const { filterStateReducer, initialFilterState } = await import('../src/store/catalogue/filterState.js');
  for (const [contentKind, expected] of [['project', ['project']], ['pack', ['zip', 'sevenZip', 'folder']], ['all', []], [undefined, []], ['unexpected', []]]) {
    const session = createBrowseSession();
    const legacy = { query: 'Lune', filters: { contentKind, formats: [], favoritesOnly: true }, additions: null };
    session.save({ filterState: legacy });
    const restored = session.restore().filterState;
    assert.deepEqual(restored.filters.formats, expected);
    assert.equal(restored.query, 'Lune');
    assert.equal(restored.filters.favoritesOnly, true);
    assert.equal(Object.hasOwn(restored.filters, 'contentKind'), false);
    assert.deepEqual(filterStateReducer(initialFilterState(), { type: 'restore', value: legacy }), restored);
    assert.deepEqual(normalizeFilters(restored.filters), restored.filters);
    assert.equal(legacy.filters.contentKind, contentKind, 'migration does not mutate its input');
  }
  assert.deepEqual(normalizeFilters({ contentKind: 'pack', formats: ['project'] }).formats, ['project'], 'explicit formats take precedence');
  assert.deepEqual(normalizeFilters({ contentKind: 'project' }).formats, ['project']);
  assert.deepEqual(normalizeFilters({ contentKind: 'pack' }).formats, ['zip', 'sevenZip', 'folder']);
  assert.deepEqual(normalizeFilters({}).formats, []);
  assert.deepEqual(normalizeFilters(null).formats, []);
  assert.deepEqual(filterStateReducer(initialFilterState(), { type: 'restore', value: {} }), initialFilterState());
});
