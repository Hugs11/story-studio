import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'rolldown/experimental';
import { runner } from './reactHookDriver.mjs';
import { createLuniiDevices, LUNII_CANCEL_LIMIT_MS, LUNII_COMMAND_LIMIT_MS, LUNII_COMMAND_PER_STORY_MS, LUNII_OPERATION_SILENCE_MS, LUNII_SILENCE_NOTICE_MS } from '../src/store/catalogue/luniiDevices.js';
registerHooks({ load(url, context, next) {
  if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
  if (url.endsWith('.jsx')) return { format: 'module', source: `import * as InteractionReact from '${new URL('../node_modules/react/index.js', import.meta.url).href}';\n` + transformSync(fileURLToPath(url), readFileSync(fileURLToPath(url), 'utf8'), { jsx: { runtime: 'classic', pragma: 'InteractionReact.createElement', pragmaFrag: 'InteractionReact.Fragment' } }).code, shortCircuit: true };
  return next(url, context);
} });

// Fake clock: short delays (polls, retries) run at once; the bounds wait until fired by hand.
// No test waits for real time.
function clock() {
  const pending = [];
  return {
    timers: {
      setTimeout(fn, ms) { const timer = { fn, ms, live: true }; if (ms <= 500) queueMicrotask(() => { if (timer.live) fn(); }); else pending.push(timer); return timer; },
      clearTimeout(timer) { if (timer) timer.live = false; },
    },
    armed: ms => pending.filter(timer => timer.live && timer.ms === ms).length,
    fire(ms) { for (const timer of pending.filter(timer => timer.live && timer.ms === ms)) { timer.live = false; timer.fn(); } },
  };
}
const tick = async (n = 5) => { for (let i = 0; i < n; i += 1) await new Promise(resolve => setImmediate(resolve)); };
const detail = (name = 'Chambre') => ({ id: 'd', name, state: 'ready', busy: false, inspected: true, stories: [{ key: 'a', title: 'A' }], orphans: [], banner: [] });
async function fixture(overrides = {}) {
  const time = clock();
  const calls = [];
  const api = {
    list: async () => [{ id: 'd', busy: false }],
    inspect: async () => { calls.push('inspect'); return detail(); },
    getOperation: async () => ({ status: 'success' }),
    rename: async (id, name) => { calls.push(['rename', name]); return { device: detail(name) }; },
    ...overrides,
  };
  const store = createLuniiDevices(api, { read() {}, write() {} }, time.timers, async () => '/w');
  store.reconcile([{ id: 'd', state: 'detected' }]);
  await store.inspect('d'); calls.length = 0;
  const seen = [];
  store.subscribe(() => seen.push(!!store.getSnapshot().luniiDevices[0]?.unresponsive));
  return { store, api, calls, time, seen };
}
const device = () => (store => store.getSnapshot().luniiDevices[0]);
const report = store => store.getQueueReport().d.map(entry => entry.state);

test('the bounds are the ones decided: 10 min of silence, 2 min to cancel or to answer, notice at 1 min', () => {
  assert.equal(LUNII_OPERATION_SILENCE_MS, 10 * 60 * 1000);
  assert.equal(LUNII_CANCEL_LIMIT_MS, 2 * 60 * 1000);
  assert.equal(LUNII_COMMAND_LIMIT_MS, 2 * 60 * 1000);
  assert.equal(LUNII_SILENCE_NOTICE_MS, 60 * 1000);
});

for (const held of [true, false]) test(`a synchronous command silent for 2 min fails as a stopped Lunii; its late answer changes nothing (reservation ${held ? 'still held' : 'released'})`, async () => {
  let answer;
  const { store, api, calls, time } = await fixture();
  api.rename = (id, name) => { calls.push(['rename', name]); return new Promise(resolve => { answer = resolve; }); };
  api.list = async () => [{ id: 'd', busy: held }];
  const first = store.mutate('d', 'rename', ['Salon']);
  const second = store.mutate('d', 'rename', ['Cuisine']);
  await tick();
  assert.equal(time.armed(LUNII_COMMAND_LIMIT_MS), 1);
  time.fire(LUNII_SILENCE_NOTICE_MS);
  assert.equal(device()(store).unresponsive, true, 'after 1 min the panel says it');
  assert.deepEqual(report(store), ['running', 'queued'], 'nothing stops at the notice');
  time.fire(LUNII_COMMAND_LIMIT_MS);
  await Promise.all([first, second]);
  assert.deepEqual(report(store), ['failed', 'notStarted']);
  const reason = store.getQueueReport().d[0].reason;
  assert.equal(reason.code, 'STORYTELLER_DEVICE_UNRESPONSIVE'); assert.equal(reason.deviceFault, true);
  assert.equal(store.getQueueReport().d[1].reason.code, 'STORYTELLER_DEVICE_UNRESPONSIVE');
  assert.equal(store.getSnapshot().error.code, 'STORYTELLER_DEVICE_UNRESPONSIVE');
  assert.equal(device()(store).unresponsive, false, 'the error replaces the notice');
  // Held reservation: no reread, the list is no longer trusted. Released: one reread.
  assert.deepEqual(calls.filter(call => call === 'inspect').length, held ? 0 : 1);
  assert.equal(device()(store).state, held ? 'readOnly' : 'ready');
  const before = { report: store.getQueueReport(), device: device()(store), inspects: calls.filter(call => call === 'inspect').length };
  answer({ device: detail('Salon') });
  await tick();
  assert.equal(device()(store).name, before.device.name, 'the late answer is not accepted');
  assert.equal(calls.filter(call => call === 'inspect').length, before.inspects, 'no second reread');
  assert.equal(store.getQueueReport(), before.report, 'the queue stays stopped');
  assert.deepEqual(calls.filter(call => call[0] === 'rename'), [['rename', 'Salon']], 'the next entry never ran');
});

test('a send that keeps making progress is never cut, however long it lasts', async () => {
  let sequence = 0;
  const reads = LUNII_OPERATION_SILENCE_MS / 500 + 300;
  const { store } = await fixture({ getOperation: async () => (++sequence > reads ? { status: 'success', sequence } : { status: 'running', sequence, result: { stories: [{ step: 'copying', progress: 70 }] } }) });
  await store.enqueueSend('d', {}, async () => ({ receipt: { operationId: 'slow' } })).finished;
  assert.ok(sequence > reads);
  assert.deepEqual(report(store), ['done']);
});

test('a send silent for 10 min fails as a stopped Lunii, after saying so from the first minute', async () => {
  let reads = 0;
  const { store, seen } = await fixture({ getOperation: async () => { reads++; return { status: 'running', sequence: 7 }; } });
  const send = store.enqueueSend('d', {}, async () => ({ receipt: { operationId: 'silent' } }));
  const next = store.mutate('d', 'rename', ['Next']);
  await Promise.all([send.finished, next]);
  assert.equal(reads, LUNII_OPERATION_SILENCE_MS / 500);
  assert.deepEqual(report(store), ['failed', 'notStarted']);
  assert.equal(store.getQueueReport().d[0].reason.code, 'STORYTELLER_DEVICE_UNRESPONSIVE');
  assert.equal(store.getQueueReport().d[0].reason.deviceFault, true);
  assert.ok(seen.includes(true), 'the notice was shown'); assert.equal(seen.at(-1), false);
});

test('a cancellation that does not end within 2 min fails, even while the engine still reports', async () => {
  let sequence = 0;
  const { store } = await fixture({ getOperation: async () => ({ status: 'cancelling', sequence: ++sequence }) });
  await store.enqueueSend('d', {}, async () => ({ receipt: { operationId: 'cancelling' } })).finished;
  assert.equal(sequence, LUNII_CANCEL_LIMIT_MS / 500);
  assert.equal(store.getQueueReport().d[0].reason.code, 'STORYTELLER_DEVICE_UNRESPONSIVE');
});

test('an operation IPC that never answers expires after 10 min of silence, by timer', async () => {
  const { store, time } = await fixture({ getOperation: () => new Promise(() => {}) });
  const send = store.enqueueSend('d', {}, async () => ({ receipt: { operationId: 'mute' } }));
  await tick();
  assert.equal(time.armed(LUNII_OPERATION_SILENCE_MS), 1);
  time.fire(LUNII_OPERATION_SILENCE_MS);
  await send.finished;
  assert.deepEqual(report(store), ['failed']);
  assert.equal(store.getQueueReport().d[0].reason.code, 'STORYTELLER_DEVICE_UNRESPONSIVE');
  assert.equal(time.armed(LUNII_OPERATION_SILENCE_MS), 0, 'timers cleared');
});

test('header: the notice is said in the status region, with the waiting count', async () => {
  const { LuniiPanelHeader } = await import('../src/components/Catalogue/lunii/LuniiPanelHeader.jsx');
  const elements = node => !node || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(elements) : [node, ...elements(node.props?.children)];
  const text = node => typeof node === 'string' ? node : Array.isArray(node) ? node.map(text).join(' ') : node && typeof node === 'object' ? text(node.props?.children) : '';
  const app = runner(() => LuniiPanelHeader({ device: { ...detail(), totalBytes: 1, freeBytes: 1, unresponsive: true }, queue: { count: 1, marks: [] } }));
  try {
    const region = elements(app.render()).find(e => e.props?.role === 'status');
    assert.match(text(region), /La Lunii ne répond pas depuis 1 min….*1 opération en attente/);
  } finally { app.unmount(); }
});

test('the stop is told with a registered Rust message, not a raw code', async () => {
  const { presentCatalogueError } = await import('../src/store/catalogue/catalogueApi.js');
  const shown = presentCatalogueError({ code: 'STORYTELLER_DEVICE_UNRESPONSIVE', params: {}, deviceFault: true });
  assert.equal(shown.fallback, false);
  assert.equal(shown.message, 'La Lunii a cessé de répondre. Éjecte-la, débranche-la puis rebranche-la.');
});

test('a removal of several stories in one call gets 30 s more per story: 10 stories answering at 4 min are no fault', async () => {
  assert.equal(LUNII_COMMAND_PER_STORY_MS, 30 * 1000);
  let answer;
  const keys = Array.from({ length: 10 }, (_, i) => `k${i}`);
  const { store, time } = await fixture({ remove: () => new Promise(resolve => { answer = resolve; }) });
  const removal = store.mutate('d', 'remove', [keys], keys);
  await tick();
  assert.equal(time.armed(LUNII_COMMAND_LIMIT_MS + 10 * LUNII_COMMAND_PER_STORY_MS), 1, '2 min + 10 × 30 s = 7 min');
  // Four minutes pass: neither the 2-minute bound nor the 1-minute notice of other commands applies;
  // the notice moves with the bound, 1 min before it (6 min here).
  assert.equal(time.armed(LUNII_SILENCE_NOTICE_MS + 10 * LUNII_COMMAND_PER_STORY_MS), 1, 'notice at 1 min + 10 × 30 s = 6 min');
  for (const ms of [LUNII_SILENCE_NOTICE_MS, LUNII_COMMAND_LIMIT_MS, 4 * 60 * 1000]) time.fire(ms);
  assert.deepEqual(report(store), ['running']);
  assert.equal(device()(store).unresponsive ?? false, false, 'no « does not answer » notice while a long removal works');
  answer({ device: detail() });
  await removal;
  assert.deepEqual(report(store), ['done']);
  assert.equal(store.getSnapshot().error, null);
});

test('a removal of one story that never answers fails at 2 min 30 s at most', async () => {
  const { store, time } = await fixture({ remove: () => new Promise(() => {}), restoreOrphans: () => new Promise(() => {}) });
  const removal = store.mutate('d', 'remove', [['a']], ['a']);
  await tick();
  assert.equal(time.armed(LUNII_COMMAND_LIMIT_MS + LUNII_COMMAND_PER_STORY_MS), 1);
  assert.ok(LUNII_COMMAND_LIMIT_MS + LUNII_COMMAND_PER_STORY_MS <= 150 * 1000);
  time.fire(LUNII_COMMAND_LIMIT_MS + LUNII_COMMAND_PER_STORY_MS);
  await removal;
  assert.deepEqual(report(store), ['failed']);
  assert.equal(store.getQueueReport().d[0].reason.code, 'STORYTELLER_DEVICE_UNRESPONSIVE');
  // Putting 3 orphans back in one call follows the same rule; a single-story gesture keeps 2 min.
  void store.mutate('d', 'restoreOrphans', [[{ key: 'x' }, { key: 'y' }, { key: 'z' }]], ['x', 'y', 'z']);
  await tick();
  assert.equal(time.armed(LUNII_COMMAND_LIMIT_MS + 3 * LUNII_COMMAND_PER_STORY_MS), 1);
});
