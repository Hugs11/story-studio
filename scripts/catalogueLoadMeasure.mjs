// Synthetic collections, never a user's corpus. SSR measurements are a
// reproducible lower bound for full rendering; browser paint/scroll require
// the companion interactive harness and are reported separately.
import './chromeBench.mjs';
import './i18nTestSetup.mjs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { performance } from 'node:perf_hooks';
import { cpus, totalmem, platform, arch } from 'node:os';
import { syntheticCards } from './catalogueSynthetic.mjs';
import { catalogueWindow, windowLayout, gridCardHeight, WINDOW_HEIGHTS } from '../src/store/catalogue/windowing.js';
import { memoizePipeline } from '../src/store/catalogue/pipeline.js';
const { CardGridView } = await import('../src/components/Catalogue/views/CardGridView.jsx');
const { ListView } = await import('../src/components/Catalogue/views/ListView.jsx');
const noop = () => {};
const view = { activeId: 'synthetic-0', selected: new Set(), expanded: new Set(), menu: { open: false }, setActiveId: noop, onItemClick: noop, onOpenModal: noop, onItemKeyDown: noop, onCardMenu: noop, onFormatClick: noop, onExemplarMenu: noop, onToggleExpanded: noop };
const percentile = (values, p) => [...values].sort((a,b)=>a-b)[Math.ceil(values.length*p)-1];
const result = { machine: { cpu: cpus()[0].model, threads: cpus().length, ramBytes: totalmem(), platform: platform(), arch: arch(), node: process.version }, rows: [] };
for (const count of [250,1000,10000]) {
  const cards = syntheticCards(count);
  const pipeline = memoizePipeline();
  let started = performance.now();
  const items = pipeline(cards, {}).items;
  const indexMs = performance.now()-started;
  const timings = [];
  for (let i=0;i<40;i++) {
    started=performance.now();
    pipeline(cards, { query: i%2 ? 'aventures' : 'Ours', sort: { key: i%3 ? 'title':'age', direction: i%2 ? 'asc':'desc' }, filters: { age: { min: i%8, max: i%8+3 } } });
    timings.push(performance.now()-started);
  }
  for (const [name, View] of Object.entries({ cards: CardGridView, list: ListView })) {
    const render=[];
    const renderView = process.argv.includes('--windowed') ? { ...view, window: { ...catalogueWindow(windowLayout({ count: items.length, columns: name === 'cards' ? 4 : 1, rowHeight: name === 'cards' ? gridCardHeight({ width: 1024, rem: 16, columns: 4 }) : WINDOW_HEIGHTS[name]*16, gap: name === 'cards' ? 16 : 0 })), columns: name === 'cards' ? 4 : 1, gridWidth: 1024, cardHeight: gridCardHeight({ width: 1024, rem: 16, columns: 4 }) } } : view;
    let html;
    global.gc?.();
    const before=process.memoryUsage().heapUsed;
    for(let i=0;i<5;i++) { started=performance.now(); html=renderToStaticMarkup(React.createElement(View,{items,view:renderView})); render.push(performance.now()-started); }
    const heapMiB=(process.memoryUsage().heapUsed-before)/1024/1024;
    result.rows.push({ count, view:name, indexMs, firstRenderMs:render[0], renderP95Ms:percentile(render,.95), pipelineP50Ms:percentile(timings,.5), pipelineP95Ms:percentile(timings,.95), markupElements:(html.match(/<[a-z][^>]*>/g)??[]).length, nodeHeapDeltaMiB:heapMiB });
  }
}
process.stdout.write(JSON.stringify(result,null,2)+'\n');
