import test from 'node:test';
import assert from 'node:assert/strict';
import { steppedKeys, createLuniiDevices, luniiRows, luniiSelectAll, luniiSelection, reorderedKeys, withKnownOrphans } from '../src/store/catalogue/luniiDevices.js';
import { createLuniiDeviceApi } from '../src/store/catalogue/luniiDeviceApi.js';
import { operationIssueItems } from '../src/store/catalogue/operationView.js';
const settings = { read() {}, write() {} };
const stories = [{ key: 'a', title: 'A', kind: 'creation' }, { key: 'b', title: 'B', kind: 'official' }, { key: 'c', title: 'C', hidden: true, kind: 'unknown' }];
const detail = () => ({ id: 'd', state: 'ready', busy: false, stories: structuredClone(stories), orphans: [], banner: [] });
async function setup(overrides = {}) {
  const calls = [];
  const actual = detail();
  const api = { inspect: async () => actual, ...overrides };
  const store = createLuniiDevices(api, settings);
  store.reconcile([{ id: 'd', state: 'detected' }]);
  await store.inspect('d');
  return { store, api, actual, calls };
}

test('all gestures use the facade argument contract; reorder receives the complete zero-based order', async () => {
  const calls = [];
  const api = createLuniiDeviceApi({ invoke: async (name, args) => { calls.push([name, args]); return name === 'lunii_device_inspect' ? detail() : { device: detail(), outcomes: [{ status: 'complete' }] }; } });
  const { store } = await setup(api); calls.length = 0;
  for (const [method, args, expected] of [
    ['hide', ['a', true], { deviceId: 'd', key: 'a', hidden: true }],
    ['hide', ['a', false], { deviceId: 'd', key: 'a', hidden: false }],
    ['reorder', [['c', 'a', 'b']], { deviceId: 'd', keys: ['c', 'a', 'b'] }],
    ['remove', [['a', 'c']], { deviceId: 'd', keys: ['a', 'c'] }],
    ['nameStory', ['c', 'Conte'], { deviceId: 'd', key: 'c', title: 'Conte' }],
    ['rename', ['Salon'], { deviceId: 'd', name: 'Salon' }],
    ['repair', [], { deviceId: 'd' }], ['restore', [], { deviceId: 'd' }],
    ['orphan', [{ deviceId: 'd', key: 'parked:ABCDEF00', restore: false }], { deviceId: 'd', key: 'parked:ABCDEF00', restore: false, knownUuid: null }],
    ['orphan', [{ deviceId: 'd', key: 'ABCDEF00', restore: true, knownUuid: 'full-id' }], { deviceId: 'd', key: 'ABCDEF00', restore: true, knownUuid: 'full-id' }],
  ]) {
    await store.mutate('d', method, args);
    const names = { nameStory: 'name_story' };
    assert.deepEqual(calls.at(-1), [`lunii_device_${names[method] ?? method}`, expected]);
  }
  assert.deepEqual(reorderedKeys(stories, ['c'], 0), ['c', 'a', 'b']);
  assert.deepEqual(reorderedKeys(stories, ['a', 'c'], 3), ['b', 'a', 'c']);
  assert.deepEqual(luniiRows(detail()).map(s => s.position), [1, 2, null]);
});

test('concurrent gestures are refused with a code; inventory polls cannot release the local reservation', async () => {
  let finish; let hides = 0; let removes = 0;
  const { store } = await setup({ hide: () => { hides++; return new Promise(resolve => finish = resolve); }, remove: () => { removes++; } });
  const first = store.mutate('d', 'hide', ['a', true], ['a']);
  assert.deepEqual(store.getSnapshot().luniiDevices[0].pendingKeys, ['a']);
  store.reconcile([{ id: 'd', state: 'ready', busy: false }]);
  assert.equal(store.getSnapshot().luniiDevices[0].busy, true);
  assert.equal(await store.mutate('d', 'remove', [['b']]), null);
  assert.equal(store.getSnapshot().error.code, 'STORYTELLER_DEVICE_BUSY');
  assert.equal(hides, 1); assert.equal(removes, 0);
  finish({ device: detail() }); await first;
  assert.equal(store.getSnapshot().luniiDevices[0].busy, false);
});

test('partial batch failure reloads actual state, including a previously completed hide', async () => {
  const actual = detail(); let reads = 0;
  const error = { code: 'STORYTELLER_NO_SPACE', params: { missingBytes: 42 } };
  const { store } = await setup({ inspect: async () => { reads++; return structuredClone(actual); }, hide: async (_id, key) => { if (key === 'c') throw error; actual.stories[0].hidden = true; return { device: structuredClone(actual) }; } });
  await store.mutate('d', 'hideMany', [true], ['a', 'c']);
  assert.equal(reads, 2); assert.equal(store.getSnapshot().luniiDevices[0].stories[0].hidden, true);
  assert.deepEqual(store.getSnapshot().error, error);
  assert.equal(store.getSnapshot().luniiDevices[0].busy, false);
});

test('failed reinspection locks writing; damaged and read-only writes never call IPC', async () => {
  let writes = 0;
  const { store, api } = await setup({ hide: async () => { writes++; throw { code: 'STORYTELLER_WRITE_FAILED' }; } });
  api.inspect = async () => { throw new Error('gone'); };
  await store.mutate('d', 'hide', ['a', true]);
  await store.mutate('d', 'rename', ['X']);
  assert.equal(writes, 1); assert.equal(store.getSnapshot().error.code, 'STORYTELLER_READ_ONLY');
  for (const state of ['readOnly', 'damaged']) {
    const { store } = await setup({ inspect: async () => ({ ...detail(), state }), rename: () => writes++ });
    await store.mutate('d', 'rename', ['X']); assert.equal(writes, 1);
  }
});

test('show conflict points to the content orphan and preserves the facade refusal', async () => {
  const key = '12345678-1234-1234-1234-1234abcdef00';
  const actual = { ...detail(), orphans: [{ key: 'ABCDEF00', complete: true }] };
  const error = { code: 'STORYTELLER_STORY_DUPLICATE', params: { position: null } };
  const { store } = await setup({ inspect: async () => actual, hide: async () => { throw error; } });
  await store.mutate('d', 'hide', [key, false]);
  assert.equal(store.getSnapshot().conflictKey, 'ABCDEF00'); assert.equal(store.getSnapshot().error, error);
});

test('Ctrl+A excludes official and orphan stories; Ctrl and Shift selection remain ordered', () => {
  const rows = [...stories, { key: 'o', orphan: true }];
  assert.deepEqual(luniiSelectAll(rows), ['a', 'c']);
  assert.deepEqual(luniiSelection(rows, ['a'], 'c', { ctrlKey: true }), ['a', 'c']);
  assert.deepEqual(luniiSelection(rows, ['a'], 'c', { shiftKey: true }, 'a'), ['a', 'b', 'c']);
  assert.deepEqual(luniiSelection(rows, ['a', 'b'], 'a', { ctrlKey: true }), ['b']);
});

test('restoration needs a unique independent full identity, including parked orphans', () => {
  const id = '12345678-1234-1234-1234-1234abcdef00';
  const devices = [{ ...detail(), orphans: [{ key: 'parked:ABCDEF00' }] }];
  assert.equal(withKnownOrphans(devices, [])[0].orphans[0].knownUuid, null);
  assert.equal(withKnownOrphans(devices, [{ uuids: [id] }])[0].orphans[0].knownUuid, id);
  assert.equal(withKnownOrphans(devices, [{ uuids: [id, '99999999-1234-1234-1234-1234abcdef00'] }])[0].orphans[0].knownUuid, null);
});

test('parking warning in any item of a hide batch is displayed at the gesture', async () => {
  const { store } = await setup({ hide: async (_id, key) => ({ device: detail(), outcomes: [{ status: key === 'a' ? 'stateWarning' : 'complete' }] }) });
  await store.mutate('d', 'hideMany', [true], ['a', 'c']);
  assert.equal(store.getSnapshot().error.code, 'STORYTELLER_STORY_PARKING_FAILED');
});

test('repatriation holds the device reservation until every receipt releases it', async () => {
  const calls = [], callbacks = [];
  let inventories = 0;
  const store = createLuniiDevices({ inspect: async () => detail(), repatriate: async (...args) => { calls.push(args); return { operationId: 'op' }; }, list: async () => [{ id: 'd', busy: ++inventories === 1 }] }, settings, { setTimeout: callback => callbacks.push(callback) });
  store.reconcile([{ id: 'd', state: 'detected' }]); await store.inspect('d');
  const pending = store.mutate('d', 'repatriateMany', [], ['a', 'c']);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(store.getSnapshot().luniiDevices[0].busy, true); assert.equal(calls.length, 1);
  callbacks[0](); await pending;
  assert.deepEqual(calls.map(args => args.slice(0, 2)), [['d', 'a'], ['d', 'c']]);
  assert.notEqual(calls[0][2], calls[1][2]); assert.equal(store.getSnapshot().luniiDevices[0].busy, false);
  const error = { code: 'STORYTELLER_STORY_UNREADABLE', detail: 'repatriation: decrypt-index-li' };
  for (const [index, title] of ['A', 'C'].entries()) {
    assert.deepEqual(operationIssueItems({ items: [], error }, { requestId: calls[index][2] }), [{ path: title, outcome: 'refused', detail: error }]);
  }
  assert.deepEqual(operationIssueItems({ items: [] }, { error }), [{ path: '', outcome: 'refused', detail: error }]);
  const journal = [{ path: '/already-reported', reason: 'accessDenied' }];
  assert.equal(operationIssueItems({ items: journal }, { error }), journal);
  assert.deepEqual(operationIssueItems({ items: [] }, {}), []);
});


test('repatriation keeps technical keys for IPC and remembers missing titles without exposing them', async () => {
  const key = '5364042f-cf80-4d5d-b1a0-123456789abc';
  for (const title of [undefined, '', '   ', 'Known title']) {
    const calls = [];
    const store = createLuniiDevices({
      inspect: async () => ({ ...detail(), stories: [{ key, title, kind: 'creation' }] }),
      repatriate: async (...args) => { calls.push(args); return { operationId: 'op' }; },
      list: async () => [{ id: 'd', busy: false }],
    }, settings);
    store.reconcile([{ id: 'd', state: 'detected' }]); await store.inspect('d');
    await store.mutate('d', 'repatriateMany', [], [key]);
    assert.deepEqual(calls[0].slice(0, 2), ['d', key]);
    assert.ok(calls[0][2], 'request identity remains available');
    const items = operationIssueItems({ items: [] }, { requestId: calls[0][2], error: { code: 'STORYTELLER_STORY_UNREADABLE' } });
    assert.equal(items[0].path, title === 'Known title' ? title : '');
    assert.equal(Boolean(items[0].untitledStory), title !== 'Known title');
    assert.ok(!JSON.stringify(items).includes(key));
  }
});

test('Alt movement preserves separated selected blocks and handles boundaries', () => {
  const rows = ['a', 'b', 'c', 'd', 'e'].map(key => ({ key }));
  assert.deepEqual(steppedKeys(rows, ['b', 'd'], -1), ['b', 'a', 'd', 'c', 'e']);
  assert.deepEqual(steppedKeys(rows, ['b', 'd'], 1), ['a', 'c', 'b', 'e', 'd']);
  assert.deepEqual(steppedKeys(rows, ['a', 'b'], -1), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(steppedKeys(rows, ['b', 'c'], -1), ['b', 'c', 'a', 'd', 'e']);
});

test('orphans take the title and cover of the catalogue card holding their full UUID', () => {
  const id = '12345678-1234-1234-1234-1234abcdef00';
  const card = { id: 'fiche', title: 'Le loup', displayTitle: 'Le loup', coverSignature: 'sig', uuids: [id] };
  const devices = [{ ...detail(), orphans: [{ key: 'ABCDEF00', knownUuid: id, title: null }, { key: 'ABCDEF01', knownUuid: null, title: null }] }];
  const [known, unknown] = withKnownOrphans(devices, [card])[0].orphans;
  assert.equal(known.title, 'Le loup'); assert.equal(known.catalogueFicheId, 'fiche'); assert.equal(known.catalogueCoverSignature, 'sig');
  assert.equal(unknown.title, null); assert.equal(unknown.catalogueFicheId, undefined);
  // A title or cover already resolved by the device is kept.
  const own = withKnownOrphans([{ ...detail(), orphans: [{ key: 'ABCDEF00', knownUuid: id, title: 'Sur la Lunii', coverPath: '/d/x' }] }], [card])[0].orphans[0];
  assert.equal(own.title, 'Sur la Lunii'); assert.equal(own.catalogueFicheId, undefined);
});

test('« Tout remettre dans la liste » sends complete identified orphans in display order, in one command', async () => {
  const calls = [];
  const api = createLuniiDeviceApi({ invoke: async (name, args) => { calls.push([name, args]); return name === 'lunii_device_inspect' ? detail() : { device: detail(), outcomes: [{ status: 'complete' }] }; } });
  const { store } = await setup(api); calls.length = 0;
  const items = [{ key: '00000005', knownUuid: 'e' }, { key: '00000003', knownUuid: 'c' }];
  await store.mutate('d', 'restoreOrphans', [items], items.map(i => i.key));
  assert.deepEqual(calls, [['lunii_device_orphans_restore', { deviceId: 'd', items }]]);
});

test('a contradicted orphan identity is never completed from the catalogue', () => {
  const id = '12345678-1234-1234-1234-1234abcdef00';
  const card = { id: 'fiche', title: 'Le loup', uuids: [id] };
  const story = withKnownOrphans([{ ...detail(), orphans: [{ key: 'ABCDEF00', knownUuid: null, identityConflict: true, title: null }] }], [card])[0].orphans[0];
  assert.equal(story.knownUuid, null); assert.equal(story.title, null); assert.equal(story.catalogueFicheId, undefined);
});
