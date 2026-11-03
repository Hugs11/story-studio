import test from 'node:test';
import assert from 'node:assert/strict';
import { runner } from './reactHookDriver.mjs';
const {useCatalogueOpen}=await import('../src/hooks/useCatalogueOpen.js');
const tick=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
function bench({exemplars,prepare,onWarning=async()=>null}) {
  let revision=1;
  let cardsById=new Map([['c',{id:'c',exemplars}]]);
  const opened=[],errors=[],requests=[];
  let hook;
  const app=runner(()=>{hook=useCatalogueOpen({api:{prepareEditorEntry:async args=>{requests.push(args);return prepare(args);}},cardsById,revision,onOpen:async target=>opened.push(target),onError:error=>errors.push(error),onWarning,onRefresh:async()=>{revision++;cardsById=new Map([['c',{id:'c',exemplars:[...exemplars].reverse()}]]);return revision;}});});
  const render=()=>{app.render();app.flush();};
  render();
  return {app,render,opened,errors,requests,get hook(){return hook;},get card(){return cardsById.get('c');}};
}
const exemplar=(id,format='project')=>({id,format,available:true,state:'available'});
test('D69 always asks for editing, then opens the exact chosen exemplar',async()=>{
  const b=bench({exemplars:[exemplar('a'),exemplar('b')],prepare:async({exemplarId})=>({kind:'project',path:`/${exemplarId}.mbah`})});
  b.hook.edit({card:b.card,revision:1});b.render();
  assert.equal(b.hook.choice.state.open,true);
  assert.equal(b.requests.length,0);
  b.hook.choice.choose(b.hook.choice.items.find(i=>i.id==='b'));
  await tick();b.render();
  assert.equal(b.opened[0].path,'/b.mbah');
  assert.deepEqual(b.requests,[{exemplarId:'b',expectedRevision:1,purpose:'edit'}]);
  b.app.unmount();
});
test('rescan during a choice reopens the choice without opening another file',async()=>{
  let refuse=true;
  const b=bench({exemplars:[exemplar('a'),exemplar('b')],prepare:async args=>{if(refuse){refuse=false;throw {code:'CATALOG_TARGET_REVISION_CHANGED'};}return {kind:'project',path:`/${args.exemplarId}.mbah`};}});
  b.hook.edit({card:b.card,revision:1});b.render();
  b.hook.choice.choose(b.hook.choice.items[1]);await tick();b.render();b.render();
  assert.equal(b.opened.length,0);
  assert.equal(b.errors.length,1);
  assert.equal(b.hook.choice.state.open,true);
  assert.equal(b.hook.choice.state.revision,2);
  b.hook.choice.choose(b.hook.choice.items.find(i=>i.id==='b'));await tick();
  assert.equal(b.opened[0].path,'/b.mbah');
  assert.equal(b.requests[1].expectedRevision,2);
  b.app.unmount();
});
test('a single exemplar refused for a stale revision is opened again at the reloaded revision, without a choice',async()=>{
  let refuse=true;
  const b=bench({exemplars:[exemplar('a')],prepare:async args=>{if(refuse){refuse=false;throw {code:'CATALOG_TARGET_REVISION_CHANGED'};}return {kind:'project',path:`/${args.exemplarId}.mbah`};}});
  b.hook.edit({card:b.card,revision:1});await tick();b.render();
  assert.equal(b.hook.choice.state.open,false);
  assert.equal(b.errors.length,0);
  assert.deepEqual(b.requests.map(r=>[r.exemplarId,r.expectedRevision]),[['a',1],['a',2]]);
  assert.equal(b.opened[0].path,'/a.mbah');
  b.app.unmount();
});
test('a direct opening refused twice reports the error and offers the choice, never another exemplar',async()=>{
  const b=bench({exemplars:[exemplar('a'),exemplar('b')],prepare:async()=>{throw {code:'CATALOG_TARGET_REVISION_STALE'};}});
  b.hook.edit({card:b.card,exemplar:b.card.exemplars[1],revision:1});await tick();b.render();
  assert.deepEqual(b.requests.map(r=>[r.exemplarId,r.expectedRevision]),[['b',1],['b',2]]);
  assert.equal(b.opened.length,0);
  assert.equal(b.errors.length,1);
  assert.equal(b.hook.choice.state.open,true);
  b.app.unmount();
});
for(const decision of [null,'project','pack'])test(`D70 revalidates the explicit decision: ${decision}`,async()=>{
  const pack=exemplar('z','zip');
  const b=bench({exemplars:[pack],onWarning:async()=>decision,prepare:async({exemplarId})=>exemplarId==='p'?{kind:'project',path:'/p.mbah'}:{kind:'pack',path:'/z.zip',existingProject:{exemplarId:'p',path:'/p.mbah',modifiedAt:123}}});
  b.hook.edit({card:b.card,revision:1});await tick();
  assert.equal(b.opened.length,decision===null?0:1);
  assert.equal(b.requests.length,decision===null?1:2);
  if(decision!==null)assert.equal(b.requests[1].exemplarId,decision==='project'?'p':'z');
  b.app.unmount();
});
