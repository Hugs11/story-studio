import test from 'node:test';
import assert from 'node:assert/strict';
import { runner } from './reactHookDriver.mjs';
const { browseSession }=await import('../src/store/catalogue/browseSession.js');
const { useCatalogueSelection }=await import('../src/hooks/useCatalogueSelection.js');
const { useCatalogueReturn }=await import('../src/hooks/useCatalogueReturn.js');

test('loading and StrictMode replay preserve browse selection until the loaded result is reconciled',()=>{
  const initial={view:'details',sort:{key:'title',direction:'desc'},filterState:{query:'lune',filters:{opaque:true}},selection:{ids:['a','b'],anchor:'b'},activeId:'b',focusedCardId:'b',ficheId:'b',expanded:['a'],scroll:{cards:140,details:760}};
  browseSession.save(initial);
  let ready=false,order=[];
  let selection,restored;
  const app=runner(()=>{
    selection=useCatalogueSelection(order,[],ready);
    useCatalogueReturn({...initial,selection:selection.snapshot,activeId:selection.activeId},{ready,order,onRestore:saved=>{restored=saved;selection.restore(saved.selection,saved.activeId);}});
  });
  app.render();app.flush();app.replayEffects();
  assert.deepEqual(browseSession.restore().selection,initial.selection);
  ready=true;order=['a'];app.render();app.flush();app.render();app.flush();
  assert.deepEqual(selection.ids,['a']);
  assert.equal(restored.focusToolbar,true);
  assert.equal(restored.announcement.params.count,1);
  app.unmount();
  assert.equal(browseSession.restore().scroll.details,760);
  assert.deepEqual(browseSession.restore().selection.ids,['a']);
  browseSession.clear();
});
