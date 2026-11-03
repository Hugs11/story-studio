// Behavioural cases adapted from STUdio Perso batchProgress.test.js (MPL-2.0).
import test from 'node:test';
import assert from 'node:assert/strict';
import { INITIAL_OPERATIONS, operationReducer, operationView, shouldAnnounce, summaryLifetime, emptyCatalogueState, createProgressBuffer, groupReport, recentOperations } from '../src/store/catalogue/operationView.js';
const snapshot = (extra = {}) => ({ operationId: 'scan', sequence: 1, timestamp: 10, status: 'running', phase: 'analysis', outcomes: {}, roots: {total: 1}, ...extra });
test('closing the tracker never cancels; completion recreates a summary', () => {
  let state = operationReducer(INITIAL_OPERATIONS, {type:'snapshot',snapshot:snapshot()});
  state = operationReducer(state, {type:'closeTracker',id:'scan'});
  assert.equal(state.items.scan.status, 'running');
  assert.equal(state.hidden.scan, true);
  state = operationReducer(state, {type:'snapshot',snapshot:snapshot({sequence:2,status:'cancelled'})});
  assert.equal(state.hidden.scan, false);
  assert.equal(operationView(state.items.scan).incomplete, true);
});
test('old sequences ignored; recovered operations can be reopened', () => {
  let state = operationReducer(INITIAL_OPERATIONS, {type:'snapshot',snapshot:snapshot({sequence:4,status:'failed'})});
  assert.equal(operationReducer(state,{type:'snapshot',snapshot:snapshot({sequence:3})}),state);
  state=operationReducer(state,{type:'dismiss',id:'scan'});
  assert.equal(state.dismissed.scan,true);
  state=operationReducer(state,{type:'open',id:'scan'});
  assert.equal(state.selected,'scan');
  assert.equal(state.dismissed.scan,false);
  assert.equal(recentOperations(state)[0].status,'failed');
});
test('unchanged automatic scan produces no notification; errors persist', () => {
  assert.equal(shouldAnnounce(snapshot({status:'success',scanComplete:true,outcomes:{unchanged:22}})),false);
  assert.equal(shouldAnnounce(snapshot({status:'success',outcomes:{refused:1}})),true);
  assert.equal(summaryLifetime(snapshot({status:'success',outcomes:{refused:1}})),null);
  assert.equal(summaryLifetime(snapshot({status:'failed'})),null);
  assert.equal(summaryLifetime(snapshot({status:'success',outcomes:{indexedNew:1}})),10000);
});
test('fixed-window buffer limits refreshes to four per second without starving discovery', () => {
  let scheduled, delays=[], calls=[], stopped=0;
  const buffer=createProgressBuffer({deliver:(items)=>calls.push(items),setTimer:(fn,delay)=>{scheduled=fn;delays.push(delay);return 1;},clearTimer:()=>stopped++});
  for(let sequence=1;sequence<=100;sequence++) buffer.push(snapshot({sequence}));
  assert.deepEqual(delays,[250]); scheduled();
  assert.equal(calls.length,1);assert.equal(calls[0][0].sequence,100);
  buffer.push(snapshot({sequence:101}));buffer.dispose();scheduled();
  assert.equal(calls.length,1);assert.equal(stopped,1);
});
test('unknown totals, provisional denominators and root errors use real counters', () => {
  const view=operationView(snapshot({candidates:{discovered:300,processed:125},roots:{total:2,completed:1,failed:1}}));
  assert.equal(view.progress.total,null);assert.equal(view.progress.percent,null);
  assert.deepEqual(view.progressLine.params,{analysed:125,count:300});
  assert.deepEqual(view.rootsLine.params,{completed:2,total:2});
  assert.equal(operationView(snapshot({status:'partial',scanComplete:false,roots:{failed:1}})).incomplete,true);
});
test('distinct empty states and report groups', () => {
  const active={status:'active',availability:'available'};
  assert.equal(emptyCatalogueState({}), 'noSources');
  assert.equal(emptyCatalogueState({sources:[active],scanning:true}), 'initialScan');
  assert.equal(emptyCatalogueState({sources:[active],loading:true}), 'loading');
  assert.equal(emptyCatalogueState({sources:[active],loading:true,scanning:true}), 'loading');
  assert.equal(emptyCatalogueState({sources:[active]}),'noPacks');
  assert.equal(emptyCatalogueState({sources:[{...active,availability:'unavailable'}]}),'offline');
  assert.equal(emptyCatalogueState({sources:[active],filtered:true}),'filtered');
  assert.equal(emptyCatalogueState({sources:[active],count:1}),'ready');
  const groups=groupReport([{path:'a',outcome:'refused',reason:'corruptArchive'},{path:'b',outcome:'refused',reason:'protectedArchive'}]);
  assert.equal(groups.length,2);assert.equal(groups[0].items.length,1);
});
test('summary visibility delegates expiration to the pausable timer, including parent rerenders', async()=>{
  const {summaryVisible}=await import('../src/store/catalogue/operationView.js');
  const success=snapshot({status:'success',timestamp:1000,outcomes:{indexedNew:1}});
  assert.equal(summaryVisible(success,INITIAL_OPERATIONS,10999),true);
  assert.equal(summaryVisible(success,INITIAL_OPERATIONS,11000),true);
  assert.equal(summaryVisible({...success,status:'failed'},INITIAL_OPERATIONS,999999),true);
  assert.equal(summaryVisible(success,{...INITIAL_OPERATIONS,selected:'scan'},999999),true);
});
test('summary lifetime pauses on interaction and resumes the remaining time',async()=>{
  const {createSummaryTimer}=await import('../src/store/catalogue/operationView.js');
  let clock=0,scheduled,delays=[],closed=0;
  const timer=createSummaryTimer({duration:10000,expire:()=>closed++,now:()=>clock,setTimer:(fn,delay)=>{scheduled=fn;delays.push(delay);return 1;},clearTimer:()=>{}});
  timer.resume();clock=4000;timer.pause();clock=100000;timer.resume();
  assert.deepEqual(delays,[10000,6000]);scheduled();assert.equal(closed,1);timer.dispose();
});

test('file notifications name the completed action and preserve partial failure counts', () => {
  for (const [operationKind, result] of [['trash', 'trashed'], ['deletePermanently', 'deleted']]) {
    const success = operationView(snapshot({ operationKind, status: 'success', outcomes: { updated: 1 } }));
    assert.equal(success.isScan, false);
    assert.equal(success.hasIssues, false);
    assert.deepEqual(success.lines, [{ key: `catalogue:operation.${result}`, params: { count: 1 } }]);
    const partial = operationView(snapshot({ operationKind, status: 'partial', outcomes: { updated: 8, error: 2 } }));
    assert.equal(partial.hasIssues, true);
    assert.deepEqual(partial.lines.map(item => item.params.count).filter(Boolean), [8, 2]);
    assert.ok(partial.lines.every(item => !item.key.includes('scan') && !item.key.includes('indexedNew')));
    for (const status of ['failed', 'cancelled']) {
      const failure = operationView(snapshot({ operationKind, status, outcomes: { error: 1, notProcessed: 9 } }));
      assert.equal(failure.lines[0].key, `catalogue:operation.${status}`);
      assert.equal(failure.lines.some(item => item.key === `catalogue:operation.${result}`), false);
    }
  }
  assert.equal(operationView(snapshot({ status: 'success', outcomes: { refused: 1 } })).hasIssues, true);
});

test('scan summaries omit zero counters', () => {
  const view = operationView(snapshot({ status: 'success', scanComplete: true, outcomes: { updated: 1 } }));
  assert.equal(view.isScan, true);
  assert.ok(view.lines.every(item => !Object.hasOwn(item.params, 'count') || item.params.count > 0));
});

test('un retrait seul annonce le bilan dans la pastille d’activité', () => {
  const removed = snapshot({ status: 'success', scanComplete: true, outcomes: { removed: 1 } });
  assert.equal(shouldAnnounce(removed), true);
  const view = operationView(removed);
  assert.equal(view.hasIssues, false);
  assert.ok(view.lines.some(line => line.key === 'catalogue:summary.count.removed' && line.params.count === 1));
});
