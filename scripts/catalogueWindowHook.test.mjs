import test from 'node:test';
import assert from 'node:assert/strict';
import { runner } from './reactHookDriver.mjs';
import { registerHooks } from 'node:module';
// The hook driver treats layout effects as commit effects. Actual browser
// geometry is exercised separately by the offline browser benchmark.
registerHooks({resolve(specifier,context,next) {
  if (specifier === 'react' && context.parentURL?.endsWith('/useCatalogueWindow.js')) {
    return {url:'data:text/javascript,'+encodeURIComponent(`export * from '${new URL('./reactHookDriver.mjs',import.meta.url).href}'; export { useEffect as useLayoutEffect } from '${new URL('./reactHookDriver.mjs',import.meta.url).href}';`),shortCircuit:true};
  }
  return next(specifier,context);
}});
// Expected widths from the fixtures: 192px at 1024/1440px, 248px at 512px.
const normalRowHeight = 192 * 280 / 302.25 + 16;
const { useCatalogueWindow } = await import('../src/hooks/useCatalogueWindow.js');

test('density changes update DOM height, page size and keyboard scroll together', () => environment(({ root, frame }) => {
  root.clientWidth = 2554;
  const items = Array.from({ length: 400 }, (_, i) => ({ card: { id: `card-${i}` } }));
  const node = { ownerDocument: { documentElement: root }, scrollTop: 0, scrollHeight: 100000, clientHeight: 720, clientWidth: 2530,
    addEventListener() {}, removeEventListener() {} };
  const keyboardMove = { current: false };
  let density = 'normal', activeId = null;
  const hook = runner(() => useCatalogueWindow(items, 'cards', activeId, new Set(), keyboardMove, null, null, density));
  let view = hook.render(); view.viewportRef.current = node; hook.flush(); frame(); view = hook.render(); hook.flush();
  for (const [level, columns, cardWidth, pages] of [['normal', 8, 302.25, 2], ['compact', 10, 238.6, 3], ['large', 6, 2450 / 6, 1]]) {
    density = level; view = hook.render(); hook.flush();
    assert.equal(view.columns, columns);
    assert.ok(Math.abs(view.cardHeight - cardWidth * 280 / 302.25) < 1e-9);
    assert.equal(view.pageRows, pages);
    assert.ok(Math.abs(view.segments.find(s => s.kind === 'row').height - view.cardHeight - 16) < 1e-9);
  }
  density = 'compact'; activeId = 'card-120'; keyboardMove.current = true;
  view = hook.render(); hook.flush();
  const expected = 13 * (238.6 * 280 / 302.25 + 16) - 720;
  assert.ok(Math.abs(node.scrollTop - expected) < 1e-8);
  hook.unmount();
}));
function environment(run) {
  const names=['requestAnimationFrame','cancelAnimationFrame','ResizeObserver','getComputedStyle'];
  const saved=Object.fromEntries(names.map(name=>[name,globalThis[name]]));
  let callback;
  globalThis.requestAnimationFrame=fn=>{callback=fn;return 1;};
  globalThis.cancelAnimationFrame=()=>{};
  globalThis.ResizeObserver=class {observe(){} disconnect(){}};
  const root={root:true};
  globalThis.getComputedStyle=node=>({fontSize:node===root?'16px':'13px'});
  try {run({root,frame:()=>{const fn=callback;callback=null;fn?.();}});} finally {
    for(const name of names)if(saved[name]===undefined)delete globalThis[name];else globalThis[name]=saved[name];
  }
}
for(const mode of ['cards','list'])test(`${mode}: root rem is independent of inherited 13px font, including a 200% viewport`,()=>environment(({root,frame})=>{
  const items=Array.from({length:1000},(_,i)=>({card:{id:`card-${i}`}}));
  const handlers=new Map();
  const node={ownerDocument:{documentElement:root},scrollTop:0,clientHeight:720,clientWidth:1024,addEventListener:(name,fn)=>handlers.set(name,fn),removeEventListener:()=>{}};
  const hook=runner(()=>useCatalogueWindow(items,mode,'card-0',new Set(),{current:false}));
  let view=hook.render();view.viewportRef.current=node;hook.flush();frame();view=hook.render();hook.flush();
  assert.ok(Math.abs(view.segments.find(s=>s.kind==='row').height - {cards:normalRowHeight,list:44}[mode]) < 1e-9);
  // At browser page zoom 200%, the viewport has half as many CSS pixels;
  // computed root rem remains 16 CSS pixels and physical heights double.
  node.clientWidth=512;node.clientHeight=360;handlers.get('scroll')();frame();view=hook.render();hook.flush();
  assert.ok(Math.abs(view.segments.find(s=>s.kind==='row').height - {cards:248*280/302.25+16,list:44}[mode]) < 1e-9);
  if(mode==='cards'){assert.equal(view.columns,2);assert.equal(view.gridWidth,512);}
  hook.unmount();
}));
test('cards: a width change is applied at the next commit, before any animation frame',()=>environment(({root,frame})=>{
  const items=Array.from({length:1000},(_,i)=>({card:{id:`card-${i}`}}));
  root.clientWidth=1024;
  const node={ownerDocument:{documentElement:root},scrollTop:0,clientHeight:720,clientWidth:1024,addEventListener:()=>{},removeEventListener:()=>{}};
  const hook=runner(()=>useCatalogueWindow(items,'cards','card-0',new Set(),{current:false}));
  let view=hook.render();view.viewportRef.current=node;hook.flush();frame();view=hook.render();hook.flush();
  const before=view.columns;
  node.clientWidth=512; // side panel opened: no scroll/ResizeObserver frame has run yet
  view=hook.render();hook.flush();view=hook.render();
  assert.equal(view.gridWidth,512);assert.ok(view.columns<before);
  hook.unmount();
}));
for(const mode of ['list'])test(`${mode}: scrolling retains a focused exemplar in a card other than active`,()=>environment(({root,frame})=>{
  const items=Array.from({length:1000},(_,i)=>({card:{id:`card-${i}`}}));
  const handlers=new Map();
  const node={ownerDocument:{documentElement:root},scrollTop:0,clientHeight:720,clientWidth:1024,addEventListener:(name,fn)=>handlers.set(name,fn),removeEventListener:()=>{}};
  let focusedId='card-1';
  const expanded=new Set(['card-1']);
  const hook=runner(()=>useCatalogueWindow(items,mode,'card-0',expanded,{current:false},focusedId));
  let view=hook.render();view.viewportRef.current=node;hook.flush();frame();view=hook.render();hook.flush();
  node.scrollTop=50000;handlers.get('scroll')();frame();view=hook.render();hook.flush();
  assert.ok(view.segments.some(s=>s.kind==='row'&&s.start===0));
  assert.ok(view.segments.some(s=>s.kind==='row'&&s.start===1));
  focusedId=null;view=hook.render();hook.flush();
  assert.ok(!view.segments.some(s=>s.kind==='row'&&s.start===1));
  hook.unmount();
}));

for (const mode of ['cards','list']) test(`${mode}: screen scrolling accounts for controls above the grid and preserves keyboard navigation`,()=>environment(({root,frame})=>{
  const items=Array.from({length:1000},(_,i)=>({card:{id:`card-${i}`}}));
  const handlers=new Map();
  const screen={scrollTop:0,scrollHeight:100000,clientHeight:600,clientTop:0,getBoundingClientRect:()=>({top:0}),addEventListener:(name,fn)=>handlers.set(name,fn),removeEventListener:()=>{}};
  let offset=900;
  const node={ownerDocument:{documentElement:root},closest:()=>screen,parentElement:{},clientWidth:1024,getBoundingClientRect:()=>({top:offset-screen.scrollTop})};
  const keyboardMove={current:false};
  const scrollPositions={current:{}};
  let activeId=null;
  const expanded=new Set();
  const hook=runner(()=>useCatalogueWindow(items,mode,activeId,expanded,keyboardMove,null,scrollPositions));
  let view=hook.render();view.viewportRef.current=node;hook.flush();frame();view=hook.render();hook.flush();
  assert.equal(view.first,0);
  // Scrolling through the controls leaves the grid at its first row.
  screen.scrollTop=800;handlers.get('scroll')();frame();view=hook.render();hook.flush();
  assert.equal(view.first,0);
  screen.scrollTop=900+5000;handlers.get('scroll')();frame();view=hook.render();hook.flush();
  assert.equal(view.first,Math.floor(5000/({cards:normalRowHeight,list:44}[mode]))-5);
  assert.equal(scrollPositions.current[mode],5900);
  // Collapsing controls changes the grid origin without changing its scroll owner.
  offset=300;handlers.get('scroll')();frame();view=hook.render();hook.flush();
  assert.equal(view.first,Math.floor(5600/({cards:normalRowHeight,list:44}[mode]))-5);
  activeId='card-0';keyboardMove.current=true;view=hook.render();hook.flush();
  assert.equal(screen.scrollTop,300);
  assert.equal(node.scrollTop,undefined);
  hook.unmount();
}));

for (const mode of ['cards','list']) test(`${mode}: five neighbouring rows preload covers with a bounded DOM for 400 fiches`, () => environment(({root,frame}) => {
  const items = Array.from({length:400}, (_,i) => ({card:{id:`cover-${i}`}}));
  const handlers = new Map();
  const node = {ownerDocument:{documentElement:root},scrollTop:0,clientHeight:720,clientWidth:1440,
    addEventListener:(name,fn)=>handlers.set(name,fn),removeEventListener:()=>{}};
  const hook = runner(() => useCatalogueWindow(items,mode,null,new Set(),{current:false}));
  let view = hook.render(); view.viewportRef.current=node; hook.flush(); frame(); view=hook.render(); hook.flush();
  node.scrollTop=5000; handlers.get('scroll')(); frame(); view=hook.render(); hook.flush();
  const rowHeight = {cards:normalRowHeight,list:44}[mode];
  assert.equal(view.first,Math.floor(5000/rowHeight)-5);
  assert.equal(view.last,Math.floor((5000+720)/rowHeight)+6);
  const mounted = view.segments.filter(s=>s.kind==='row').reduce((n,s)=>n+s.end-s.start,0);
  assert.ok(mounted <= (Math.ceil(720/rowHeight)+11)*view.columns);
  if (mode === 'cards') assert.equal(mounted, 105, 'shorter cards mount 15 rows of seven cards, including overscan');
  else assert.ok(mounted < 100, `only ${mounted}/400 cards mounted`);
  assert.ok(view.segments.some(s=>s.kind==='spacer'));
  hook.unmount();
}));
