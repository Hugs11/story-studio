// Run `npm run dev`, open /scripts/catalogue-browser-bench.html. This harness
// records browser DOM/heap/paint/frames; SSR numbers are never substituted.
import React, { useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { initializeI18n } from '../src/i18n/index.js';
import { syntheticCards } from './catalogueSynthetic.mjs';
import { memoizePipeline } from '../src/store/catalogue/pipeline.js';
import { useCatalogueWindow } from '../src/hooks/useCatalogueWindow.js';
import { CardGridView } from '../src/components/Catalogue/views/CardGridView.jsx';
import { ListView } from '../src/components/Catalogue/views/ListView.jsx';
import '../src/styles/variables.css';
import '../src/components/Catalogue/CatalogueViews.css';
initializeI18n('fr');
const noop=()=>{};
const frames=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
const p=(samples,q)=>[...samples].sort((a,b)=>a-b)[Math.ceil(samples.length*q)-1];
const root=createRoot(document.getElementById('surface'));
const views={cards:CardGridView,list:ListView};
function Surface({items,mode,windowed}) {
  const keyboard=useRef(false);
  const expanded=useRef(new Set()).current;
  const window=useCatalogueWindow(items,mode,items[0]?.card.id,expanded,keyboard);
  const View=views[mode];
  const view={selected:new Set(),activeId:items[0]?.card.id,expanded,menu:{open:false},onItemClick:noop,onOpenModal:noop,onItemKeyDown:noop,onCardMenu:noop,onFormatClick:noop,onExemplarMenu:noop,onToggleExpanded:noop,setActiveId:noop,window:windowed?window:null};
  return <div className="catalogue-window" ref={window.viewportRef}><View items={items} view={view}/></div>;
}
async function run() {
  const rows=[];
  for(const count of [250,1000,10000]) {
    const cards=syntheticCards(count);
    const pipeline=memoizePipeline();
    const start=performance.now();const items=pipeline(cards,{}).items;const indexMs=performance.now()-start;
    const latency=[];
    for(let i=0;i<40;i++) {
      const start=performance.now();
      pipeline(cards,{query:i%2?'aventures':'Ours',sort:{key:i%3?'title':'age',direction:i%2?'asc':'desc'},filters:{age:{min:i%8,max:i%8+3}}});
      latency.push(performance.now()-start);
    }
    for(const mode of Object.keys(views)) for(const windowed of [false,true]) {
      flushSync(()=>root.render(null));await frames();
      globalThis.dump?.('CATALOGUE_STAGE_START '+JSON.stringify({count,mode,windowed})+'\n');
      const before=performance.memory?.usedJSHeapSize ?? null;
      const render=[];
      for(let trial=0;trial<5;trial++) {
        const start=performance.now();
        flushSync(()=>root.render(<Surface key={trial} items={items} mode={mode} windowed={windowed}/>));
        await frames();render.push(performance.now()-start);
      }
      const node=document.querySelector('.catalogue-window');
      const delta=[];
      let previous=performance.now();
      for(let frame=0;frame<120;frame++) {
        await new Promise(requestAnimationFrame);
        const now=performance.now();delta.push(now-previous);previous=now;
        node.scrollTop=(node.scrollHeight-node.clientHeight)*frame/119;
      }
      const row={count,mode,windowed,indexMs,firstPaintMs:render[0],renderP95Ms:p(render,.95),pipelineP50Ms:p(latency,.5),pipelineP95Ms:p(latency,.95),domNodes:document.querySelector('#surface').querySelectorAll('*').length,heapDeltaMiB:before===null?null:(performance.memory.usedJSHeapSize-before)/1024/1024,frameP50Ms:p(delta,.5),frameP95Ms:p(delta,.95),framesOver50Ms:delta.filter(value=>value>50).length};
      rows.push(row);document.getElementById('results').textContent=JSON.stringify({userAgent:navigator.userAgent,viewport:[innerWidth,innerHeight],devicePixelRatio,rows},null,2);
      globalThis.dump?.('CATALOGUE_ROW '+JSON.stringify(row)+'\n');
    }
  }
  globalThis.dump?.('CATALOGUE_RESULT '+JSON.stringify({userAgent:navigator.userAgent,viewport:[innerWidth,innerHeight],devicePixelRatio,rows})+'\n');
}
document.getElementById('run').addEventListener('click',()=>{document.getElementById('run').disabled=true;void run().finally(()=>{document.getElementById('run').disabled=false;});});

if(new URLSearchParams(location.search).has('auto'))void run().catch(error=>globalThis.dump?.('CATALOGUE_ERROR '+String(error.stack ?? error)+'\n'));
