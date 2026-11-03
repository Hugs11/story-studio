import test from 'node:test';
import assert from 'node:assert/strict';
import { readViewPrefs, writeViewPrefs } from '../src/store/catalogue/viewPrefs.js';
import { KEYS } from '../src/store/persistentSettings.js';
import { initialFilterState, filterStateReducer as reduce, filterSummary, filterControls, effectiveCriteria } from '../src/store/catalogue/filterState.js';
import { catalogueEmptyState } from '../src/store/catalogue/emptyState.js';
import { selectionReducer, pruneSelection, prunedAnnouncement } from '../src/store/catalogue/selection.js';
import { catalogueWindow, windowLayout, scrollToIndex, windowAnchor, restoreWindowAnchor } from '../src/store/catalogue/windowing.js';
import { scanAdditionIds, loadScanAdditions } from '../src/store/catalogue/scanAdditions.js';
import { catalogueShortcutsEnabled, catalogueBrowserActive } from '../src/store/catalogue/browserState.js';
import { card } from './catalogueFixtures.mjs';
test('validated view/sort/panel persist, corrupt preferences fall back', () => {
  const values = new Map();
  const settings = { read: key => values.get(key), write: (key,value) => { values.set(key,value); return true; } };
  assert.deepEqual(readViewPrefs(settings),{view:'cards',density:'normal',fichePanelVisible:true,sort:{key:'title',direction:'asc'}});
  writeViewPrefs({view:'details',sort:{key:'age',direction:'desc'},query:'never saved',filters:{min:4}},settings);
  assert.deepEqual([...values.keys()],[KEYS.CATALOGUE_VIEW,KEYS.CATALOGUE_SORT,KEYS.CATALOGUE_FICHE_PANEL_VISIBLE,KEYS.CATALOGUE_CARD_DENSITY]);
  assert.deepEqual(readViewPrefs(settings),{view:'list',density:'normal',fichePanelVisible:true,sort:{key:'age',direction:'desc'}});
  for (const bad of ['{','null','17','"hello"','{"key":"wrong","direction":"oops"}']) {
    values.set(KEYS.CATALOGUE_VIEW,'broken');values.set(KEYS.CATALOGUE_SORT,bad);
    assert.deepEqual(readViewPrefs(settings),{view:'cards',density:'normal',fichePanelVisible:true,sort:{key:'title',direction:'asc'}});
  }
});
test('reset filters, clear query and individual removal are separate', () => {
  let state=reduce(initialFilterState(),{type:'query',value:'Ours'});
  state=reduce(state,{type:'set',family:'age',value:{min:3,max:8,hideUnknown:true}});
  assert.equal(filterSummary(state).length,2);
  assert.equal(reduce(state,{type:'clearSearch'}).filters.age.min,3);
  assert.equal(reduce(state,{type:'reset'}).query,'Ours');
  assert.equal(reduce(state,{type:'remove',family:'age'}).query,'Ours');
  const additions=reduce(state,{type:'additions',ids:['a','a']});
  assert.deepEqual(additions.additions,['a']);
  assert.equal(effectiveCriteria(additions).filters.availability,'all');
  assert.deepEqual(reduce(additions,{type:'remove',family:'additions'}),state);
});
test('empty data families expose reasons and automatically become available',()=>{
  const blank=filterControls([card({})]);
  for(const family of ['tags']) assert.ok(blank.find(control=>control.family===family).unavailable);
  assert.equal(blank.find(control=>control.family==='languages').unavailable,false);
  assert.equal(blank.find(control=>control.family==='packStates').unavailable,false);
  const rich=filterControls([card({language:'fr',tags:[{id:'tag',label:'ours'}],packState:'generated'})]);
  for(const family of ['languages','tags','packStates']) assert.equal(rich.find(control=>control.family===family).unavailable,false);
  assert.deepEqual(rich.find(control=>control.family==='languages').values,['fr']);
  assert.deepEqual(rich.find(control=>control.family==='missing').values,['title','age','description','author','cover']);
});
test('empty cases have one useful action each, except the first scan',()=>{
  const active={status:'active',availability:'available'};
  for(const [context,state,action] of [
    [{},'noSources','addFolder'],[{sources:[active],scanning:true},'initialScan',null],[{sources:[active],loading:true},'loading',null],
    [{sources:[active]},'noPacks','preferences'],[{sources:[active],filtered:true},'filtered','reset'],
    [{sources:[{...active,availability:'unavailable'}],filtered:true},'offline','preferences'],
  ]) { const result=catalogueEmptyState(context);assert.equal(result.state,state);assert.equal(result.action,action);assert.ok(result.key);assert.equal(result.actionKey===null,action===null); }
});
test('new filters prune selected IDs with grouped announcement and select all is visible',()=>{
  const selected=selectionReducer(undefined,{type:'selectAll',order:['a','b','c']});
  const {selection,removed}=pruneSelection(selected,['b']);
  assert.equal(prunedAnnouncement(removed,['A','C']).params.titles,'A; C');
  assert.deepEqual(selection.ids,['b']);assert.deepEqual(removed,['a','c']);assert.equal(prunedAnnouncement(removed).params.count,2);
  assert.deepEqual(selectionReducer(selection,{type:'selectAll',order:['b','d']}).ids,['b','d']);
  assert.equal(catalogueBrowserActive('catalogue','report'),false);
  assert.equal(catalogueBrowserActive('sources',null),false);
  assert.equal(catalogueBrowserActive('catalogue',null),true);
  assert.equal(catalogueShortcutsEnabled(catalogueBrowserActive('catalogue','report'),false),false); // scan-report modal makes browser inactive
});
test('window bounds, overscan, beginning/end, distant focus and expansion slot',()=>{
  const layout=windowLayout({count:10000,columns:4,rowHeight:100,gap:10});
  const initial=catalogueWindow(layout,{viewport:300});
  assert.equal(initial.first,0);assert.equal(initial.last,8);
  const last=catalogueWindow(layout,{scrollTop:1e9,viewport:300,pinned:[0,9999]});
  assert.equal(last.last,2500);assert.ok(last.segments.some(segment=>segment.start===0));
  assert.ok(last.segments.some(segment=>segment.end===10000));
  assert.equal(scrollToIndex(layout,0,400,300),0);
  assert.equal(scrollToIndex(layout,40,0,300),910);
  assert.deepEqual(catalogueWindow(windowLayout({count:0,rowHeight:100})).segments,[]);
  const expanded=windowLayout({count:3,rowHeight:80,expanded:[1],expansionHeight:240});
  assert.deepEqual(expanded.offsets,[0,80,400,480]);
});
test('scan additions use exact member identity and all report pages',async()=>{
  const cards=[card({id:'a',exemplars:[{path:'/a.zip',member:'one'}]}),card({id:'b',exemplars:[{path:'/a.zip',member:'two'}]})];
  const report=await loadScanAdditions({getOperation:async(_,args)=>args.cursor?{items:[{path:'/a.zip',member:'two',outcome:'unchanged'}],cursor:null}:{items:[{path:'/a.zip',member:'one',outcome:'indexedNew'}],cursor:'1'}},'op');
  assert.deepEqual(scanAdditionIds(cards,report),['a']);
});

test('scan publication preserves the visible anchor after an insertion',()=>{
  const before=windowLayout({count:3,rowHeight:80});
  const anchor=windowAnchor(before,['a','b','c'],85);
  const after=windowLayout({count:4,rowHeight:80});
  assert.equal(restoreWindowAnchor(after,['new','a','b','c'],anchor),165);
  assert.equal(restoreWindowAnchor(after,['new','a','c','d'],anchor,85),85);
});

test('removing the audience age chip clears the whole age criterion',()=>{
  const state=reduce(initialFilterState(),{type:'set',family:'age',value:{min:3,max:8,hideUnknown:true}});
  const unknownCleared=reduce(state,{type:'remove',family:'age',key:'catalogue:filter.age.unknownHidden'});
  assert.deepEqual(unknownCleared.filters.age,{min:null,max:null,hideUnknown:false});
  const boundsCleared=reduce(state,{type:'remove',family:'age',key:'catalogue:filter.age.range'});
  assert.deepEqual(boundsCleared.filters.age,{min:null,max:null,hideUnknown:false});
});

test('unknown sort values reset the complete sort and failed storage stays explicit',()=>{
  assert.deepEqual(readViewPrefs({read:key=>key===KEYS.CATALOGUE_VIEW?'list':'{"key":"unknown","direction":"desc"}'}),{view:'list',density:'normal',fichePanelVisible:true,sort:{key:'title',direction:'asc'}});
  assert.equal(writeViewPrefs({view:'cards',density:'normal',fichePanelVisible:true,sort:{key:'title',direction:'asc'}},{write:()=>false}),false);
});

test('each active family produces a removable summary with translation keys',()=>{
  let state=initialFilterState();
  for(const [family,value] of Object.entries({languages:['fr'],formats:['zip'],projectTypes:['menus'],sourceIds:['A'],tags:{ids:['tag'],mode:'any'},packStates:['generated'],missing:['cover'],availability:'unavailable'})) {
    state=reduce(state,{type:'set',family,value});
    assert.ok(filterSummary(state).some(item=>item.family===family && item.key.startsWith('catalogue:')));
    const removed=reduce(state,{type:'remove',family});
    assert.ok(!filterSummary(removed).some(item=>item.family===family));
  }
});

test('show missing clears conflicting criteria and additions; its chip is removable and resettable', () => {
  const previous = { query: 'Ours', filters: { formats: ['project'], availability: 'available', favoritesOnly: true }, additions: ['other'] };
  const state = reduce(previous, { type: 'showMissing' });
  assert.equal(state.query, '');
  assert.equal(state.additions, null);
  assert.deepEqual(effectiveCriteria(state), { query: '', filters: state.filters });
  assert.deepEqual(filterSummary(state), [{ family: 'missingFilesOnly', key: 'catalogue:filter.missingFiles.label', params: {} }]);
  assert.deepEqual(reduce(state, { type: 'remove', family: 'missingFilesOnly' }), initialFilterState());
  assert.deepEqual(reduce(state, { type: 'reset' }), initialFilterState());
});

test('panel visibility defaults to true, false survives storage, invalid values fall back', () => {
  const values = new Map();
  const settings = { read: key => values.get(key), write: (key, value) => { values.set(key, value); return true; } };
  assert.equal(readViewPrefs(settings).fichePanelVisible, true);
  writeViewPrefs({ view: 'cards', fichePanelVisible: false }, settings);
  assert.equal(readViewPrefs(settings).fichePanelVisible, false);
  values.set(KEYS.CATALOGUE_FICHE_PANEL_VISIBLE, 'invalid');
  assert.equal(readViewPrefs(settings).fichePanelVisible, true);
});
