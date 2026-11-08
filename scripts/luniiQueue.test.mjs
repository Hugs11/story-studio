import test from 'node:test';
import assert from 'node:assert/strict';
import { createLuniiQueue } from '../src/store/catalogue/luniiQueue.js';
import { createLuniiDevices, luniiWriteRefusal } from '../src/store/catalogue/luniiDevices.js';
import { createLuniiActivity } from '../src/store/luniiCloseGuard.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const detail = id => ({ id, state: 'ready', busy: false, inspected: true, stories: [{ key: 'a', title: 'A', ageMin: 5 }, { key: 'hidden', title: 'Hidden', hidden: true }, { key: 'b', title: 'B' }], orphans: [], banner: [] });
const settings = { read() {}, write() {} };
// Real short delays, but the waiting bounds of the Lunii (1 min and more) never fire on their
// own: several tests leave an entry blocked on purpose, and none may wait for real time.
const realTimers = { setTimeout: (fn, ms) => (ms >= 60_000 ? null : setTimeout(fn, ms)), clearTimeout: timer => clearTimeout(timer ?? undefined) };
async function fixture(overrides = {}, timers = realTimers, workspace = async () => '/workspace') {
  const calls = [];
  const api = {
    list: async () => ['d', 'other'].map(id => ({ id, busy: false })),
    inspect: async id => { calls.push(`inspect:${id}`); return detail(id); },
    getOperation: async () => ({ status: 'success' }),
    remove: async (id, keys) => { calls.push(['remove', id, keys]); return { device: detail(id) }; },
    rename: async (id, name) => { calls.push(['rename', id, name]); return { device: detail(id) }; },
    repatriate: async (...args) => { calls.push(['repatriate', ...args]); return { operationId: 'repatriation' }; },
    ...overrides,
  };
  const store = createLuniiDevices(api, settings, timers, workspace);
  store.reconcile(['d', 'other'].map(id => ({ id, state: 'detected' })));
  await store.inspect('d'); await store.inspect('other'); calls.length = 0;
  return { store, api, calls };
}

test('three heterogeneous entries run sequentially, with one owned reread each and no inventory/quiet inspect interleaving', async () => {
  const native = deferred();
  let terminal = false, running = 0, max = 0;
  const { store, calls } = await fixture({
    getOperation: async () => { running++; max = Math.max(max, running); await native.promise; running--; return { status: 'success' }; },
  });
  const send = store.enqueueSend('d', { keys: ['sent'], title: 'Sent', dropIndex: 2 }, async () => ({ receipt: { operationId: 'send' } }), () => { terminal = true; });
  const second = store.mutate('d', 'remove', [['b']], ['b']);
  const third = store.mutate('d', 'rename', ['Bedroom']);
  await tick();
  assert.equal(store.queued(), 2);
  assert.equal(store.getSnapshot().luniiQueue.d[0].dropIndex, 2, 'hidden stories count in the complete drop order');
  assert.deepEqual(store.getSnapshot().luniiQueue.d.map(e => e.state), ['running', 'queued', 'queued']);
  store.reconcile([{ id: 'd', state: 'ready', busy: false }, { id: 'other', state: 'ready', busy: false }]);
  await store.inspect('d');
  assert.deepEqual(calls, []);
  assert.equal(store.getSnapshot().luniiDevices[0].busy, true);
  native.resolve(); await Promise.all([send.finished, second, third]);
  assert.equal(terminal, true); assert.equal(max, 1);
  assert.deepEqual(calls, ['inspect:d', ['remove', 'd', ['b']], 'inspect:d', ['rename', 'd', 'Bedroom'], 'inspect:d']);
  assert.deepEqual(store.getQueueReport().d.map(e => e.state), ['done', 'done', 'done']);
  assert.equal(store.getSnapshot().luniiDevices[0].busy, false);
});

test('cancel and cancelQueued cancel only waiting entries, across devices; never native cancellation', async () => {
  const gates = { d: deferred(), other: deferred() };
  let cancelled = 0;
  const { store } = await fixture({ cancel: () => { cancelled++; } });
  const activity = createLuniiActivity(); const unregister = activity.register(store);
  const a = store.enqueueSend('d', { title: 'A' }, () => gates.d.promise);
  const b = store.enqueueSend('other', { title: 'B' }, () => gates.other.promise);
  const c = store.enqueueSend('d', { title: 'C' }, async () => assert.fail('cancelled send started'));
  const e = store.mutate('other', 'rename', ['Not started']);
  assert.equal(store.cancel(a.id), false); assert.equal(store.cancel(b.id), false);
  assert.equal(activity.snapshot().queued, 2);
  assert.equal(store.cancel(c.id), true); assert.equal(store.cancel(c.id), false);
  activity.cancelQueued();
  assert.equal(store.queued(), 0); assert.equal(cancelled, 0);
  gates.d.resolve(); gates.other.resolve(); await Promise.all([a.finished, b.finished, c.finished, e]);
  assert.equal(activity.snapshot().active, false); unregister();
  assert.deepEqual(store.getQueueReport().d.map(e => e.state), ['done', 'cancelled']);
  assert.deepEqual(store.getQueueReport().other.map(e => e.state), ['done', 'cancelled']);
});

for (const deviceFault of [true, false]) test(`command failure deviceFault=${deviceFault}: ${deviceFault ? 'stop' : 'continue'}`, async () => {
  const gate = deferred();
  const error = { code: 'STORYTELLER_WRITE_FAILED', params: {}, deviceFault };
  const { store, calls } = await fixture({ remove: async () => { await gate.promise; throw error; } });
  const first = store.mutate('d', 'remove', [['a']]);
  const second = store.mutate('d', 'rename', ['Next']);
  gate.resolve(); await Promise.all([first, second]);
  assert.deepEqual(store.getQueueReport().d.map(e => e.state), ['failed', deviceFault ? 'notStarted' : 'done']);
  assert.equal(calls.some(c => Array.isArray(c) && c[0] === 'rename'), !deviceFault);
});

for (const deviceFault of [true, false]) test(`send classification uses only item.deviceFault=${deviceFault}, ignoring reason.deviceFault`, async () => {
  const gate = deferred();
  const { store } = await fixture({ getOperation: async () => { await gate.promise; return { status: 'partial', result: { stories: [{ step: 'failed', deviceFault, reason: { code: 'STORYTELLER_WRITE_FAILED', deviceFault: !deviceFault } }] } }; } });
  const first = store.enqueueSend('d', { title: 'Pack' }, async () => ({ receipt: { operationId: 'op' } }));
  const second = store.mutate('d', 'rename', ['Next']);
  gate.resolve(); await Promise.all([first.finished, second]);
  assert.deepEqual(store.getQueueReport().d.map(e => e.state), ['failed', deviceFault ? 'notStarted' : 'done']);
});

for (const keys of [['a', 'b'], ['a']]) test(`failed queued repatriation excludes only its key from removal ${keys}`, async () => {
  const gate = deferred();
  const error = { code: 'STORYTELLER_STORY_UNREADABLE', params: {}, deviceFault: false };
  const { store, calls } = await fixture({ getOperation: async () => { await gate.promise; return { status: 'failed', error }; } });
  const first = store.mutate('d', 'repatriateMany', [], ['a']);
  const second = store.mutate('d', 'remove', [keys], keys);
  gate.resolve(); await Promise.all([first, second]);
  const report = store.getQueueReport().d;
  assert.equal(report[0].state, 'failed');
  assert.deepEqual(report[1].reason.excluded, [{ key: 'a', reason: error }]);
  assert.deepEqual(report[1].keys, keys.filter(k => k !== 'a'));
  assert.equal(report[1].state, keys.length === 1 ? 'cancelled' : 'done');
  assert.deepEqual(calls.filter(c => Array.isArray(c) && c[0] === 'remove'), keys.length === 1 ? [] : [['remove', 'd', ['b']]]);
});

test('disconnect marks waiting entries notStarted, retains titles/reasons after card removal, and never restarts on reconnect', async () => {
  const timers = { ...globalThis, setTimeout: (fn, ms) => ms === 4000 ? (timers.depart = fn) : realTimers.setTimeout(fn, ms), clearTimeout() {} };
  const gate = deferred();
  const { store, calls } = await fixture({}, timers);
  const first = store.enqueueSend('d', { title: 'Current' }, () => gate.promise);
  const second = store.mutate('d', 'remove', [['a']], ['a']);
  store.reconcile([{ id: 'other', state: 'ready', busy: false }]);
  assert.equal(store.getQueueReport().d[1].state, 'notStarted');
  timers.depart(); assert.equal(store.getSnapshot().luniiDevices.some(d => d.id === 'd'), false);
  assert.equal(store.getQueueReport().d[1].title, 'A');
  store.reconcile([{ id: 'd', state: 'ready', busy: false }, { id: 'other', state: 'ready', busy: false }]);
  gate.resolve(); await Promise.all([first.finished, second]);
  assert.equal(calls.some(c => Array.isArray(c) && c[0] === 'remove'), false);
  assert.equal(store.getQueueReport().d[1].state, 'notStarted');
});

test('busy never released is bounded to 40 inventory reads and stops the device queue', async () => {
  let reads = 0, delays = 0;
  const gate = deferred();
  // The waiting bounds (1 min and more) are armed but never fire here; only the retry delays run.
  const { store } = await fixture({ list: async () => { reads++; return [{ id: 'd', busy: true }]; } }, { setTimeout: (fn, ms) => { if (ms > 500) return 0; delays++; fn(); }, clearTimeout() {} });
  const first = store.enqueueSend('d', { title: 'Stuck' }, () => gate.promise);
  const second = store.mutate('d', 'rename', ['Next']);
  gate.resolve(); await Promise.all([first.finished, second]);
  assert.equal(reads, 40); assert.equal(delays, 40);
  assert.deepEqual(store.getQueueReport().d.map(e => e.state), ['failed', 'notStarted']);
  assert.equal(store.getQueueReport().d[0].reason.deviceFault, true);
});

test('two devices have independent runners', async () => {
  const gate = deferred();
  const { store } = await fixture();
  const first = store.enqueueSend('d', { title: 'Slow' }, () => gate.promise);
  await store.mutate('other', 'rename', ['Independent']);
  assert.equal(store.getQueueReport().d[0].state, 'running');
  assert.equal(store.getQueueReport().other[0].state, 'done');
  gate.resolve(); await first.finished;
});

test('repatriation captures workspace and archive title at enqueue, before settings change', async () => {
  let workspace = '/first';
  const gate = deferred();
  const { store, calls } = await fixture({}, realTimers, async () => workspace);
  const first = store.enqueueSend('d', { title: 'Slow' }, () => gate.promise);
  const second = store.mutate('d', 'repatriateMany', [], ['a']);
  workspace = '/second';
  store.getSnapshot().luniiDevices[0].stories[0].title = 'Changed';
  gate.resolve(); await Promise.all([first.finished, second]);
  assert.deepEqual(calls.find(c => Array.isArray(c) && c[0] === 'repatriate').slice(4), ['/first', '5+]A']);
});

test('native terminal precedes busy release, which precedes the next entry', async () => {
  const terminal = deferred(), busyRelease = deferred();
  let busy = true, reads = 0;
  const { store, calls } = await fixture({
    getOperation: async () => { await terminal.promise; return { status: 'success' }; },
    list: async () => { reads++; if (busy) { await busyRelease.promise; busy = false; } return [{ id: 'd', busy }]; },
  });
  const first = store.enqueueSend('d', { title: 'Send' }, async () => ({ receipt: { operationId: 'op' } }));
  const second = store.mutate('d', 'rename', ['Next']);
  await tick(); assert.equal(reads, 0);
  terminal.resolve(); await tick(); assert.equal(reads, 1); assert.deepEqual(calls, []);
  busyRelease.resolve(); await Promise.all([first.finished, second]);
  assert.deepEqual(calls, ['inspect:d', ['rename', 'd', 'Next'], 'inspect:d']);
});

test('queue busy permits all gestures; external busy, read-only and damaged refusals remain', () => {
  for (const method of ['send', 'repatriateMany', 'remove', 'reorder', 'hide', 'rename', 'repair', 'nameStory']) {
    assert.equal(luniiWriteRefusal({ ...detail('d'), busy: true, queueActive: true }, method), null);
    assert.equal(luniiWriteRefusal({ ...detail('d'), busy: true }, method), 'STORYTELLER_DEVICE_BUSY');
    if (method !== 'repatriateMany') assert.equal(luniiWriteRefusal({ ...detail('d'), state: 'readOnly' }, method), 'STORYTELLER_READ_ONLY');
    if (!['repair', 'repatriateMany'].includes(method)) assert.equal(luniiWriteRefusal({ ...detail('d'), state: 'damaged' }, method), 'STORYTELLER_PLAYLIST_DAMAGED');
  }
});

test('published entry shape and snapshots are stable, cancellable reports survive their runner', async () => {
  const gate = deferred();
  const queue = createLuniiQueue({ execute: () => gate.promise });
  const first = queue.enqueue('d', { kind: 'send', keys: ['a'], title: 'A', dropIndex: 2 });
  const before = queue.getSnapshot();
  const second = queue.enqueue('d', { kind: 'remove', keys: ['b'], title: 'B' });
  // Expectation changed on purpose: an entry also names its run, the unit of the end-of-queue report.
  assert.deepEqual(Object.keys(before.d[0]).sort(), ['dropIndex', 'id', 'keys', 'kind', 'reason', 'run', 'state', 'title']);
  queue.cancel(second.id); gate.resolve(); await Promise.all([first.finished, second.finished]);
  assert.equal(before.d[0].state, 'running');
  assert.deepEqual(queue.getSnapshot().d.map(e => e.state), ['done', 'cancelled']);
});

for (const change of ['send', 'remove']) test(`queued reorder resolves intent after ${change}`, async () => {
  const { createLuniiGestures } = await import('../src/store/catalogue/luniiGestures.js');
  const gate = deferred();
  let current = detail('d');
  const orders = [];
  const { store } = await fixture({
    inspect: async id => id === 'd' ? structuredClone(current) : detail(id),
    reorder: async (_id, keys) => { orders.push(keys); current.stories = keys.map(key => current.stories.find(story => story.key === key)); return { device: current }; },
  });
  const first = store.enqueueSend('d', {}, async () => {
    await gate.promise;
    current.stories = change === 'send' ? [{ key: 'new' }, ...current.stories] : current.stories.filter(story => story.key !== 'hidden');
  });
  const gestures = createLuniiGestures({ store }, key => key, async () => true, () => {});
  const move = gestures.reorder(store.getSnapshot().luniiDevices[0], ['b'], 0);
  gate.resolve(); await Promise.all([first.finished, move]);
  assert.deepEqual(orders, [change === 'send' ? ['new', 'b', 'a', 'hidden'] : ['b', 'a']]);
  assert.deepEqual(store.getQueueReport().d.map(entry => entry.state), ['done', 'done']);
});

for (const kind of ['send', 'repatriate']) test(`${kind} item failure stays in report; commands and device faults publish a banner`, async () => {
  for (const mode of ['refused', 'cancelled', 'command', 'device']) {
    const reason = { code: 'STORYTELLER_STORY_DUPLICATE', params: {} };
    const { store } = await fixture({
      getOperation: async () => ({ status: mode === 'cancelled' ? 'cancelled' : 'partial', result: { stories: [{ step: mode === 'cancelled' ? 'interrupted' : 'refused', reason, deviceFault: mode === 'device' }] } }),
      repatriate: async () => { if (mode === 'command') throw reason; return { operationId: 'op' }; },
    });
    const launch = () => kind === 'send' ? store.enqueueSend('d', {}, async () => { if (mode === 'command') throw reason; return { receipt: { operationId: 'op' } }; }).finished
      : store.mutate('d', 'repatriateMany', [], ['a']);
    await launch();
    assert.equal(store.getSnapshot().mutationError, ['command', 'device'].includes(mode), mode);
    assert.equal(store.getQueueReport().d[0].state, 'failed');
    assert.equal(store.getQueueReport().d[0].reason.code, reason.code);
  }
});

test('three sends including a duplicate refusal keep the bilan without a red banner', async () => {
  let count = 0;
  const { store } = await fixture({ getOperation: async () => ({ status: ++count === 2 ? 'partial' : 'success', result: { stories: [{ step: count === 2 ? 'refused' : 'done', reason: { code: 'STORYTELLER_STORY_DUPLICATE' }, deviceFault: false }] } }) });
  await Promise.all([1, 2, 3].map(() => store.enqueueSend('d', {}, async () => ({ receipt: { operationId: 'op' } })).finished));
  assert.deepEqual(store.getQueueReport().d.map(entry => entry.state), ['done', 'failed', 'done']);
  assert.equal(store.getSnapshot().error, null);
  assert.equal(store.getSnapshot().mutationError, false);
});

test('terminal events avoid IPC; stalled cancelling is bounded with 500ms fallback polling', async () => {
  let reads = 0;
  const delays = [];
  const { store } = await fixture({ getOperation: async () => { reads++; return { status: 'cancelling' }; } }, { setTimeout: (fn, ms) => { if (ms === 500) { delays.push(ms); queueMicrotask(fn); } return ms; }, clearTimeout() {} });
  await store.enqueueSend('d', {}, async () => ({ receipt: { operationId: 'event' } }), undefined, () => ({ status: 'success' })).finished;
  assert.equal(reads, 0);
  const stuck = store.enqueueSend('d', {}, async () => ({ receipt: { operationId: 'stuck' } }));
  const next = store.mutate('d', 'rename', ['Next']);
  await Promise.all([stuck.finished, next]);
  // Expectation changed on purpose: a cancellation that does not end
  // fails after 2 min (240 polls of 500 ms), no longer after the former 6-hour total bound.
  assert.equal(reads, 240);
  assert.equal(delays.length, 240);
  assert.ok(delays.every(ms => ms >= 500));
  assert.deepEqual(store.getQueueReport().d.map(entry => entry.state), ['done', 'failed', 'notStarted']);
  assert.equal(store.getQueueReport().d[1].reason.deviceFault, true);
});

for (const cleanup of ['release', 'reread']) test(`failed ${cleanup} preserves original entry reason and stops the queue`, async () => {
  const reason = { code: 'STORYTELLER_STORY_DUPLICATE', params: { position: 3 } };
  const { store, api } = await fixture({}, { setTimeout: fn => queueMicrotask(fn), clearTimeout() {} });
  if (cleanup === 'release') api.list = async () => { throw { code: 'STORYTELLER_DEVICE_BUSY' }; };
  else api.inspect = async () => { throw { code: 'STORYTELLER_DEVICE_GONE' }; };
  await store.enqueueSend('d', {}, async () => { throw reason; }).finished;
  assert.deepEqual(store.getQueueReport().d[0].reason, { ...reason, deviceFault: true });
});

test('repeated ejected inventory does not republish queue disconnection', async () => {
  const { store } = await fixture();
  store.reconcile([{ id: 'd', state: 'ejected' }]);
  const report = store.getQueueReport();
  store.reconcile([{ id: 'd', state: 'ejected' }]);
  assert.equal(store.getQueueReport(), report);
});

// Expectation changed on purpose: the unanswered IPC expires after
// 10 min without any sign of life, no longer at a 6-hour total deadline.
test('an unanswered operation IPC also expires after ten minutes of silence', async () => {
  let expire, cleared = false;
  const { store } = await fixture({ getOperation: () => new Promise(() => {}) }, {
    setTimeout(fn, ms) { if (ms === 10 * 60 * 1000) expire = fn; return ms; },
    clearTimeout(timer) { if (timer === 10 * 60 * 1000) cleared = true; },
  });
  const first = store.enqueueSend('d', {}, async () => ({ receipt: { operationId: 'silent' } }));
  const second = store.mutate('d', 'rename', ['Next']);
  await tick(); expire(); await Promise.all([first.finished, second]);
  assert.equal(cleared, true);
  assert.deepEqual(store.getQueueReport().d.map(entry => entry.state), ['failed', 'notStarted']);
  assert.equal(store.getQueueReport().d[0].reason.deviceFault, true);
});
