import test from 'node:test';
import assert from 'node:assert/strict';
import { createLuniiDevices, luniiRows, luniiWriteRefusal } from '../src/store/catalogue/luniiDevices.js';
import { KEYS } from '../src/store/persistentSettings.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(overrides = {}, values = new Map()) {
  const calls = [];
  const timers = new Map();
  const api = {
    list: async () => [], onDevicesChanged: async callback => { api.changed = callback; return () => calls.push('unlisten'); },
    inspect: async id => { calls.push(['inspect', id]); return { id, name: 'Salon', state: 'ready', stories: [], orphans: [], banner: [] }; },
    open: async id => { calls.push(['open', id]); return { id, state: 'ready', stories: [], orphans: [], banner: [] }; },
    eject: async id => calls.push(['eject', id]), ...overrides,
  };
  const store = createLuniiDevices(api, { read: key => values.get(key), write: (key, value) => values.set(key, value) }, {
    setTimeout: (fn, delay) => { const id = { delay }; timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id),
    setInterval: fn => { api.interval = fn; return 1; }, clearInterval: () => calls.push('clearInterval'),
  });
  return { store, calls, api, values, timers };
}

test('unmounted discovery never mounts without the explicit Open gesture', async () => {
  const { store, calls } = fixture();
  store.reconcile([{ id: 'd', state: 'detected', busy: false }]);
  assert.equal(store.getSnapshot().activeLuniiId, 'd');
  assert.equal(store.getSnapshot().luniiDevices[0].state, 'detected');
  assert.deepEqual(calls, []);
  await store.inspect('d', true);
  assert.deepEqual(calls, [['open', 'd']]);
  assert.equal(store.getSnapshot().luniiDevices[0].state, 'ready');
});

test('mounted discovery inspects once; polling keeps the detailed state', async () => {
  const { store, calls } = fixture({ inspect: async id => { calls.push(['inspect', id]); return { id, state: 'damaged', banner: ['damagedTruncated'], stories: [{ key: 'a' }], orphans: [] }; } });
  const summary = [{ id: 'd', state: 'ready', busy: false }];
  store.reconcile(summary);
  assert.equal(store.getSnapshot().luniiDevices[0].state, 'opening');
  await tick();
  store.reconcile(summary);
  assert.equal(store.getSnapshot().luniiDevices[0].state, 'damaged');
  assert.deepEqual(calls, [['inspect', 'd']]);
});

test('busy ending reloads the inventory; repeated busy notifications do not inspect', async () => {
  const { store, calls } = fixture();
  store.reconcile([{ id: 'd', state: 'ready', busy: true }]);
  store.reconcile([{ id: 'd', state: 'ready', busy: true }]);
  assert.deepEqual(calls, []);
  store.reconcile([{ id: 'd', state: 'ready', busy: false }]);
  await tick();
  assert.deepEqual(calls, [['inspect', 'd']]);
});

test('disconnect invalidates a late inspection and closes after its announcement', async () => {
  let finish;
  const { store, timers } = fixture({ inspect: () => new Promise(resolve => { finish = resolve; }) });
  store.reconcile([{ id: 'd', state: 'ready' }]);
  store.select('lunii', ['a']);
  store.reconcile([]);
  finish({ id: 'd', state: 'ready' });
  await tick();
  assert.equal(store.getSnapshot().luniiDevices[0].state, 'disconnected');
  assert.deepEqual(store.getSnapshot().selection, { side: 'lunii', ids: [] });
  [...timers.values()][0]();
  assert.deepEqual(store.getSnapshot().luniiDevices, []);
});

test('reconnection cancels the departure timer and inspects anew', async () => {
  const { store, timers, calls } = fixture();
  store.reconcile([{ id: 'd', state: 'ready' }]); await tick();
  store.reconcile([]);
  store.reconcile([{ id: 'd', state: 'ready' }]); await tick();
  assert.equal(timers.size, 0);
  assert.equal(store.getSnapshot().luniiDevices[0].state, 'ready');
  assert.equal(calls.length, 2);
});

for (const state of ['ready', 'readOnly', 'damaged', 'unsupported', 'detected']) test(`eject is available in ${state}, and no write command is exposed`, async () => {
  const { store, calls } = fixture({ inspect: async id => ({ id, state, stories: [], orphans: [] }) });
  store.reconcile([{ id: 'd', state: state === 'detected' ? 'detected' : 'ready' }]); await tick();
  await store.eject('d');
  assert.equal(store.getSnapshot().luniiDevices[0].state, 'ejected');
  assert.ok(calls.some(c => c[0] === 'eject'));
  for (const action of ['send', 'hide', 'reorder', 'repair', 'restore', 'remove', 'orphan', 'nameStory', 'repatriate']) assert.equal(store[action], undefined);
  // D38: the ejected device survives its disappearance from the inventory (S18 stays).
  store.reconcile([]);
  assert.equal(store.getSnapshot().luniiDevices[0].state, 'ejected');
});

async function ejectedGone() {
  const f = fixture();
  f.store.reconcile([{ id: 'd', state: 'ready' }]); await tick();
  await f.store.eject('d');
  f.store.reconcile([]);
  return f;
}
test('D38: ejected device stays ejected after disappearing, with no departure timer', async () => {
  const { store, timers } = await ejectedGone();
  assert.equal(store.getSnapshot().luniiDevices[0].state, 'ejected');
  assert.equal(store.getSnapshot().activeLuniiId, 'd');
  assert.equal(timers.size, 0);
});
test('D38: the same device plugged back returns to its normal state', async () => {
  const { store } = await ejectedGone();
  store.reconcile([{ id: 'd', state: 'ready' }]); await tick();
  assert.equal(store.getSnapshot().luniiDevices.length, 1);
  assert.equal(store.getSnapshot().luniiDevices[0].state, 'ready');
});
test('D38: another device replaces the ejected one', async () => {
  const { store } = await ejectedGone();
  store.reconcile([{ id: 'e', state: 'detected' }]);
  assert.deepEqual(store.getSnapshot().luniiDevices.map(d => d.id), ['e']);
  assert.equal(store.getSnapshot().activeLuniiId, 'e');
});
test('D38: the user closing the panel removes the gone ejected device', async () => {
  const { store } = await ejectedGone();
  store.collapse(true);
  assert.deepEqual(store.getSnapshot().luniiDevices, []);
  assert.equal(store.getSnapshot().activeLuniiId, null);
});
test('D38: unplugging without ejection keeps the disconnected state', async () => {
  const { store } = fixture();
  store.reconcile([{ id: 'd', state: 'ready' }]); await tick();
  store.reconcile([]);
  assert.equal(store.getSnapshot().luniiDevices[0].state, 'disconnected');
});

test('ejection is refused while busy or reading', async () => {
  let finish;
  const { store, calls } = fixture({ inspect: () => new Promise(resolve => { finish = resolve; }) });
  store.reconcile([{ id: 'd', state: 'ready', busy: true }]);
  await store.eject('d');
  store.reconcile([{ id: 'd', state: 'ready', busy: false }]);
  await store.eject('d');
  assert.deepEqual(calls, []);
  finish({ id: 'd', state: 'ready' }); await tick();
});

test('failed opening and ejecting expose structured errors without losing the device', async () => {
  const error = { code: 'STORYTELLER_READ_ONLY', params: {} };
  const { store } = fixture({ open: async () => { throw error; }, eject: async () => { throw error; } });
  store.reconcile([{ id: 'd', state: 'detected' }]);
  await store.inspect('d', true);
  assert.equal(store.getSnapshot().error, error);
  assert.equal(store.getSnapshot().luniiDevices[0].state, 'detected');
  await store.eject('d');
  assert.equal(store.getSnapshot().luniiDevices[0].busy, false);
});

test('width, collapse and active tab survive a new controller; sides replace each other', () => {
  const { store, values } = fixture();
  store.reconcile([{ id: 'a', state: 'detected' }, { id: 'b', state: 'detected' }]);
  store.selectDevice('b'); store.collapse(true); store.resize(487);
  store.select('catalogue', ['c', 'd']); store.select('lunii', ['s']);
  assert.deepEqual(store.getSnapshot().selection, { side: 'lunii', ids: ['s'] });
  store.select('catalogue', ['x']);
  assert.deepEqual(store.getSnapshot().selection, { side: 'catalogue', ids: ['x'] });
  store.resizeFiche(530);
  const restoredStore = fixture({}, values).store;
  restoredStore.reconcile([{ id: 'a', state: 'detected' }, { id: 'b', state: 'detected' }]);
  const restored = restoredStore.getSnapshot();
  assert.equal(restored.fichePanelWidth, 530);
  assert.equal(restored.activeLuniiId, 'b'); assert.equal(restored.luniiPanelCollapsed, true); assert.equal(restored.luniiPanelWidth, 487);
  assert.equal(values.get(KEYS.LUNII_PANEL_WIDTH), '487');
  store.select('lunii', ['s']); store.selectDevice('a');
  assert.deepEqual(store.getSnapshot().selection.ids, []);
});

test('hidden stories keep position; only visible stories count; parked orphans stay last', () => {
  const device = { stories: [{ key: 'v1' }, { key: 'h', hidden: true, parked: true }, { key: 'v2', parkingPending: true }], orphans: [{ key: 'parked:old', parked: true, complete: true }, { key: 'unfinished', complete: false }] };
  const rows = luniiRows(device);
  assert.deepEqual(rows.map(s => [s.key, s.position, s.orphan]), [['v1', 1, false], ['h', null, false], ['v2', 2, false], ['parked:old', null, true], ['unfinished', null, true]]);
  assert.equal(device.stories[0].position, undefined);
});

test('watcher, polling and in-flight requests are released on unmount', async () => {
  let finish;
  const { store, calls, api } = fixture({ list: () => new Promise(resolve => { finish = resolve; }) });
  const stop = store.start(); await tick(); stop();
  finish([{ id: 'late', state: 'ready' }]); await tick();
  api.changed([{ id: 'event', state: 'ready' }]);
  assert.deepEqual(store.getSnapshot().luniiDevices, []);
  assert.ok(calls.includes('unlisten')); assert.ok(calls.includes('clearInterval'));
});

test('catalogue changes refresh device links without restart or loss of selection', async () => {
  let changed; let removed = 0; let linked = true;
  const { store, calls } = fixture({
    list: async () => [{ id: 'd', state: 'ready', busy: false }],
    onCatalogueChanged: async callback => { changed = callback; return () => { removed++; }; },
    inspect: async id => { calls.push(['inspect', id]); return { id, state: 'ready', stories: [{ key: 'a', catalogueFicheId: linked ? 'card' : null }], orphans: [] }; },
  });
  const stop = store.start(); await tick();
  store.select('lunii', ['a']);
  assert.equal(store.getSnapshot().luniiDevices[0].stories[0].catalogueFicheId, 'card');
  linked = false; changed({ catalogueRevision: 2 });
  assert.equal(store.getSnapshot().luniiDevices[0].state, 'ready');
  await tick();
  assert.equal(store.getSnapshot().luniiDevices[0].stories[0].catalogueFicheId, null);
  assert.deepEqual(store.getSnapshot().selection, { side: 'lunii', ids: ['a'] });
  stop(); const reads = calls.length;
  changed({ catalogueRevision: 3 }); await tick();
  assert.equal(calls.length, reads); assert.equal(removed, 1);
});

test('catalogue changes during a send wait for release before rereading links', async () => {
  let changed; let linked = true; let reads = 0;
  const actual = () => ({ id: 'd', state: 'ready', busy: false, stories: [{ key: 'a', catalogueFicheId: linked ? 'card' : null }], orphans: [] });
  const { store } = fixture({
    list: async () => [{ id: 'd', state: 'ready', busy: false }],
    onCatalogueChanged: async callback => { changed = callback; return () => {}; },
    inspect: async () => { reads++; return actual(); },
  });
  const stop = store.start(); await tick();
  assert.equal(store.beginSend('d'), null);
  const before = reads;
  linked = false; changed({ catalogueRevision: 2 }); await tick();
  assert.equal(reads, before);
  await store.endSend('d'); await tick();
  assert.equal(store.getSnapshot().luniiDevices[0].stories[0].catalogueFicheId, null);
  stop();
});

test('scan catalogue bursts have one leading and one trailing read per window', async () => {
  let changed;
  const modes = [];
  const { store, timers } = fixture({
    list: async () => [{ id: 'd', state: 'ready', busy: false }],
    onCatalogueChanged: async callback => { changed = callback; return () => {}; },
    inspect: async (id, options) => { modes.push(options); return { id, state: 'ready', stories: [], orphans: [] }; },
  });
  const stop = store.start(); await tick();
  for (let revision = 1; revision <= 100; revision++) {
    changed({ catalogueRevision: revision, scope: 'entries' });
    await tick(); // Reads finish between events: in-flight coalescing alone is insufficient.
  }
  assert.deepEqual(modes, [undefined, { readOnly: true }]);
  assert.equal(timers.size, 1);
  const flushWindow = () => { const [id, callback] = [...timers][0]; timers.delete(id); callback(); };
  flushWindow(); await tick();
  assert.equal(modes.length, 3);
  for (let revision = 101; revision <= 200; revision++) changed({ catalogueRevision: revision, scope: 'entries' });
  await tick();
  assert.equal(modes.length, 3);
  flushWindow(); await tick();
  assert.equal(modes.length, 4);
  flushWindow(); await tick();
  assert.equal(modes.length, 4);
  changed({ catalogueRevision: 201 });
  changed({ catalogueRevision: 202 });
  stop();
  assert.equal(timers.size, 0);
});

test('ejection drains a failed quiet read and discards its queued reread', async () => {
  let changed, rejectRead;
  let reads = 0, ejections = 0;
  const { store, timers } = fixture({
    list: async () => [{ id: 'd', state: 'ready', busy: false }],
    onCatalogueChanged: async callback => { changed = callback; return () => {}; },
    inspect: async id => {
      reads++;
      if (reads > 1) return new Promise((_, reject) => { rejectRead = reject; });
      return { id, state: 'ready', stories: [{ key: 'a' }], orphans: [] };
    },
    eject: async () => { ejections++; },
  });
  const stop = store.start(); await tick();
  changed({ catalogueRevision: 2 });
  changed({ catalogueRevision: 3 });
  const [timer, callback] = [...timers][0]; timers.delete(timer); callback();
  const eject = store.eject('d');
  await tick();
  assert.equal(ejections, 0);
  await store.inspect('d');
  assert.equal(reads, 2);
  rejectRead(new Error('disconnected during read'));
  await eject; await tick();
  assert.equal(ejections, 1);
  assert.equal(reads, 2);
  assert.equal(store.getSnapshot().luniiDevices[0].state, 'ejected');
  assert.equal(store.getSnapshot().error, null);
  stop();
});

test('eject stays exclusive across polling and preserves the catalogue selection', async () => {
  let finish;
  const { store, calls } = fixture({ eject: id => { calls.push(['eject', id]); return new Promise(resolve => { finish = resolve; }); } });
  store.reconcile([{ id: 'd', state: 'detected' }]);
  store.select('catalogue', ['catalogue-card']);
  const pending = store.eject('d');
  store.reconcile([{ id: 'd', state: 'detected', busy: false }]);
  await store.eject('d');
  assert.equal(calls.length, 1);
  assert.equal(store.getSnapshot().luniiDevices[0].busy, true);
  finish(); await pending;
  assert.deepEqual(store.getSnapshot().selection, { side: 'catalogue', ids: ['catalogue-card'] });
});

test('a late listener installation from a previous mount cannot remain attached', async () => {
  const registrations = [];
  let removed = 0;
  const { store } = fixture({ onDevicesChanged: callback => new Promise(resolve => registrations.push({ callback, resolve })) });
  const stop = store.start(); stop();
  const stopAgain = store.start();
  registrations[0].resolve(() => removed++);
  registrations[0].callback([{ id: 'obsolete', state: 'detected' }]);
  await tick();
  assert.equal(removed, 1);
  assert.deepEqual(store.getSnapshot().luniiDevices, []);
  registrations[1].resolve(() => removed++); await tick(); stopAgain();
  assert.equal(removed, 2);
});

test('poll responses and failures from a stopped session cannot affect its replacement', async () => {
  for (const fail of [false, true]) {
    const pending = [];
    const { store } = fixture({ list: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) });
    const stop = store.start(); stop();
    const stopAgain = store.start();
    assert.equal(pending.length, 2);
    pending[1].resolve([]); await tick();
    if (fail) pending[0].reject(new Error('obsolete'));
    else pending[0].resolve([{ id: 'unplugged', state: 'detected' }]);
    await tick();
    assert.deepEqual(store.getSnapshot().luniiDevices, []);
    assert.equal(store.getSnapshot().error, null);
    stopAgain();
  }
});

test('a volume made read-only by the system refuses writes with its own cause', () => {
  const device = { id: 'd', state: 'readOnly', banner: ['readOnly'], stories: [], orphans: [] };
  assert.equal(luniiWriteRefusal({ ...device, readOnlyReason: 'volume' }, 'remove'), 'STORYTELLER_VOLUME_READ_ONLY');
  assert.equal(luniiWriteRefusal({ ...device, readOnlyReason: 'metadata' }, 'remove'), 'STORYTELLER_READ_ONLY');
  assert.equal(luniiWriteRefusal({ ...device, readOnlyReason: 'volume' }, 'repatriateMany'), null);
});

test('D43: a kept official cover rereads the list quietly, without the opening screen', async () => {
  let detail = { stories: [{ key: 'a', kind: 'official' }] };
  const { store, calls } = fixture({ inspect: async id => { calls.push(['inspect', id]); return { id, state: 'readOnly', banner: [], orphans: [], ...detail }; } });
  store.reconcile([{ id: 'd', state: 'ready', busy: false, covers: 0 }]);
  await tick();
  store.reconcile([{ id: 'd', state: 'ready', busy: false, covers: 0 }]);
  assert.deepEqual(calls, [['inspect', 'd']]);
  detail = { stories: [{ key: 'a', kind: 'official', coverPath: '/d/a' }] };
  store.reconcile([{ id: 'd', state: 'ready', busy: false, covers: 1 }]);
  const during = store.getSnapshot().luniiDevices[0];
  assert.equal(during.state, 'readOnly');
  assert.equal(during.stories.length, 1);
  await tick();
  assert.deepEqual(calls, [['inspect', 'd'], ['inspect', 'd']]);
  assert.equal(store.getSnapshot().luniiDevices[0].stories[0].coverPath, '/d/a');
  store.reconcile([{ id: 'd', state: 'ready', busy: false, covers: 1 }]);
  await tick();
  assert.equal(calls.length, 2);
});

test('D43: a cover kept during a read queues one more quiet read; a failed quiet read keeps the list', async () => {
  let finish;
  let fail = false;
  const { store, calls } = fixture({ inspect: id => { calls.push(['inspect', id]); if (fail) return Promise.reject(new Error('gone')); return new Promise(resolve => { finish = () => resolve({ id, state: 'ready', banner: [], orphans: [], stories: [{ key: 'a' }] }); }); } });
  store.reconcile([{ id: 'd', state: 'ready', busy: false, covers: 0 }]);
  finish(); await tick();
  store.reconcile([{ id: 'd', state: 'ready', busy: false, covers: 1 }]);
  store.reconcile([{ id: 'd', state: 'ready', busy: false, covers: 2 }]);
  assert.equal(calls.length, 2);
  fail = true;
  finish(); await tick(); await tick();
  assert.equal(calls.length, 3);
  const device = store.getSnapshot().luniiDevices[0];
  assert.equal(device.state, 'ready');
  assert.equal(device.stories.length, 1);
  assert.equal(store.getSnapshot().error, null);
});

// A quiet read (D43) in flight: held open by the test, resolved on demand.
async function quietReadFixture(extra = {}) {
  const pending = [];
  const { store, calls } = fixture({
    inspect: id => { calls.push(['inspect', id]); return new Promise(resolve => pending.push(detail => resolve({ id, state: 'ready', banner: [], orphans: [], stories: [], ...detail }))); },
    hide: async (id, key) => { calls.push(['hide', id, key]); return { device: { id, state: 'ready', stories: [{ key: 'w' }], orphans: [], banner: [] }, outcomes: [] }; },
    ...extra,
  });
  store.reconcile([{ id: 'd', state: 'ready', busy: false, covers: 0 }]);
  pending.shift()({ stories: [{ key: 'a' }] }); await tick();
  store.reconcile([{ id: 'd', state: 'ready', busy: false, covers: 1 }]);
  assert.equal(pending.length, 1);
  return { store, calls, pending };
}

test('D43: a write during a quiet read is neither refused nor ignored, and the stale result is dropped', async () => {
  const { store, calls, pending } = await quietReadFixture();
  const result = await store.mutate('d', 'hide', ['k', true]);
  assert.ok(result);
  assert.equal(store.getSnapshot().error, null);
  assert.ok(calls.some(c => c[0] === 'hide'));
  pending.shift()({ stories: [{ key: 'stale' }] }); await tick();
  assert.deepEqual(store.getSnapshot().luniiDevices[0].stories, [{ key: 'w' }]);
});

test('D43: a send during a quiet read is not refused; the stale result is dropped', async () => {
  const { store, pending } = await quietReadFixture();
  assert.equal(store.beginSend('d'), null);
  pending.shift()({ stories: [{ key: 'stale' }] }); await tick();
  assert.deepEqual(store.getSnapshot().luniiDevices[0].stories, [{ key: 'a' }]);
  assert.equal(store.getSnapshot().luniiDevices[0].sending, true);
});

test('D43: an eject waits for the quiet read before touching the volume', async () => {
  const { store, calls, pending } = await quietReadFixture();
  const eject = store.eject('d');
  await tick();
  assert.equal(calls.some(c => c[0] === 'eject'), false);
  assert.equal(store.getSnapshot().luniiDevices[0].busy, true);
  pending.shift()({ stories: [{ key: 'stale' }] });
  await eject;
  assert.ok(calls.some(c => c[0] === 'eject'));
  assert.equal(store.getSnapshot().luniiDevices[0].state, 'ejected');
  assert.deepEqual(store.getSnapshot().luniiDevices[0].stories, [{ key: 'a' }]);
});

test('eject proceeds after three seconds when quiet IPC never finishes and ignores its late result', async () => {
  const pending = [];
  let ejections = 0;
  const { store, timers } = fixture({
    inspect: id => new Promise(resolve => pending.push(detail => resolve({ id, state: 'ready', stories: [], orphans: [], ...detail }))),
    eject: async () => { ejections++; },
  });
  store.reconcile([{ id: 'd', state: 'ready', busy: false, covers: 0 }]);
  pending.shift()({ stories: [{ key: 'a' }] }); await tick();
  store.reconcile([{ id: 'd', state: 'ready', busy: false, covers: 1 }]);
  const eject = store.eject('d');
  await tick();
  assert.equal(ejections, 0);
  assert.equal(timers.size, 1);
  const [timer, callback] = [...timers][0];
  assert.equal(timer.delay, 3000);
  timers.delete(timer); callback();
  await eject;
  assert.equal(ejections, 1);
  assert.equal(store.getSnapshot().luniiDevices[0].state, 'ejected');
  const stale = pending.shift();
  stale({ stories: [{ key: 'stale' }] }); await tick();
  assert.equal(store.getSnapshot().luniiDevices[0].state, 'ejected');
  assert.deepEqual(store.getSnapshot().luniiDevices[0].stories, [{ key: 'a' }]);
  assert.equal(timers.size, 0);
});

test('D43: a quiet result older than a normal read does not overwrite it', async () => {
  const { store, pending } = await quietReadFixture();
  store.reconcile([{ id: 'd', state: 'ready', busy: true, covers: 1 }]);
  store.reconcile([{ id: 'd', state: 'ready', busy: false, covers: 1 }]);
  await tick();
  assert.equal(pending.length, 2);
  pending[1]({ stories: [{ key: 'new' }] }); await tick();
  pending[0]({ stories: [{ key: 'stale' }] }); await tick();
  assert.deepEqual(store.getSnapshot().luniiDevices[0].stories, [{ key: 'new' }]);
});

test('D43: a cover kept during the first read schedules a quiet read afterwards', async () => {
  const pending = [];
  const { store, calls } = fixture({ inspect: id => { calls.push(['inspect', id]); return new Promise(resolve => pending.push(detail => resolve({ id, state: 'ready', banner: [], orphans: [], stories: [], ...detail }))); } });
  store.reconcile([{ id: 'd', state: 'ready', busy: false, covers: 0 }]);
  store.reconcile([{ id: 'd', state: 'ready', busy: false, covers: 1 }]);
  assert.equal(calls.length, 1);
  pending.shift()({ stories: [{ key: 'a' }] }); await tick();
  assert.equal(calls.length, 2);
  assert.equal(store.getSnapshot().luniiDevices[0].state, 'ready');
  pending.shift()({ stories: [{ key: 'a', coverPath: '/c' }] }); await tick();
  assert.equal(store.getSnapshot().luniiDevices[0].stories[0].coverPath, '/c');
});

test('D43: a departure drops the queued quiet read, and so does stop()', async () => {
  const { store, calls, pending } = await quietReadFixture();
  store.reconcile([{ id: 'd', state: 'ready', busy: false, covers: 2 }]);
  store.reconcile([]);
  pending.shift()({ stories: [] }); await tick();
  assert.equal(calls.filter(c => c[0] === 'inspect').length, 2);
  const second = await quietReadFixture();
  second.store.reconcile([{ id: 'd', state: 'ready', busy: false, covers: 2 }]);
  const stop = second.store.start();
  stop();
  second.pending.shift()({ stories: [] }); await tick();
  assert.equal(second.calls.filter(c => c[0] === 'inspect').length, 2);
});


test('an obsolete tiny saved Lunii width and new resize requests respect the minimum', () => {
  const values = new Map([[KEYS.LUNII_PANEL_WIDTH, '1']]);
  const { store } = fixture({}, values);
  assert.equal(store.getSnapshot().luniiPanelWidth, 330);
  store.resize(100);
  assert.equal(store.getSnapshot().luniiPanelWidth, 330);
  assert.equal(values.get(KEYS.LUNII_PANEL_WIDTH), '330');
});
