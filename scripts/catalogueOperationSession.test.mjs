import test from 'node:test';
import assert from 'node:assert/strict';
import { runner } from './reactHookDriver.mjs';
const { useCatalogueOperations } = await import('../src/hooks/useCatalogueOperations.js');
const { useLuniiSend } = await import('../src/hooks/useLuniiSend.js');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('two mounted trackers share actions and closing the second keeps the first subscribed', async () => {
  const snapshot = { operationId: 'send', sequence: 1, status: 'running' };
  const api = {
    subscribeOperations: async () => () => {},
    listOperations: async () => ({ items: [snapshot], retainedOperationIds: ['send'] }),
    getOperation: async () => snapshot,
  };
  const first = runner(() => useCatalogueOperations({ api }));
  const second = runner(() => useCatalogueOperations({ api }));
  try {
    first.render(); first.flush(); await tick();
    second.render(); second.flush(); await tick();
    await second.render().open('send');
    first.render().retain('pending');
    assert.equal(second.render().state.retained.pending, true);
    assert.equal(first.render().state.selected, 'send');
    const lateRelease = second.render().release;
    second.unmount();
    assert.equal(first.render().state.selected, 'send', 'closing Preferences must not close the catalogue tracker');
    lateRelease('pending');
    first.render().retain('next');
    first.render().dismiss('send');
    assert.deepEqual(first.render().state.retained, { next: true });
    assert.equal(first.render().state.dismissed.send, true);
  } finally { first.unmount(); second.unmount(); }
});

test('release between layout and passive unmount cleanups cannot be overwritten', async () => {
  let operations;
  const api = {
    // Unsubscribe runs in passive cleanup, after the layout listener is removed.
    subscribeOperations: async () => () => operations.release('pending'),
    listOperations: async () => ({ items: [], retainedOperationIds: [] }),
  };
  const mount = () => runner(() => useCatalogueOperations({ api }));
  let app = mount();
  try {
    app.render(); app.flush(); await tick();
    operations = app.render();
    operations.retain('pending');
    app.render(); app.flush();
    assert.equal(app.render().state.retained.pending, true);
    app.unmount();
    app = mount(); app.render(); app.flush(); await tick();
    assert.deepEqual(app.render().state.retained, {});
  } finally { app.unmount(); }
});

test('registry failure prevents automatic startup but still permits manual starting and opening', async () => {
  const error = new Error('registry unavailable');
  let registryReads = 0;
  const starts = [];
  const snapshots = {
    scan: { operationId: 'scan', sequence: 1, status: 'running' },
    send: { operationId: 'send', sequence: 1, status: 'running', operationKind: 'luniiSend' },
  };
  const api = {
    subscribeOperations: async () => () => {},
    listOperations: async () => { registryReads++; throw error; },
    startScan: async args => { starts.push(args); return { operationId: 'scan' }; },
    getOperation: async id => snapshots[id],
  };
  const app = runner(() => useCatalogueOperations({ api }));
  try {
    app.render(); app.flush(); await tick();
    // Recovery readiness authorizes CatalogueScreen's initial automatic scan.
    // A failed registry read must keep that authorization false.
    assert.equal(app.render().ready, false);
    assert.deepEqual(starts, []);
    assert.equal(registryReads, 1, 'failed recovery must not enqueue an empty batch and publish the error twice');
    await app.render().start(1);
    assert.equal(app.render().state.selected, 'scan');
    assert.equal(app.render().state.items.scan, snapshots.scan);
    assert.equal(starts.length, 1, 'a manual scan remains available');
    await app.render().open('send');
    assert.equal(app.render().state.selected, 'send');
    assert.equal(app.render().state.items.send, snapshots.send);
    assert.equal(app.render().state.error, error);
  } finally { app.unmount(); }
});

test('Preferences resolves multi-file trash titles from the shared catalogue session', async () => {
  const listeners = [], timers = [];
  const snapshot = { operationId: 'trash', operationKind: 'trash', sequence: 2, timestamp: 1, status: 'success', outcomes: { updated: 2 } };
  const api = {
    subscribeOperations: async callback => { listeners.push(callback); return () => {}; },
    listOperations: async () => ({ items: [], retainedOperationIds: ['trash'] }),
    getOperation: async () => ({ ...snapshot, items: [{ path: '/a.zip', outcome: 'updated' }, { path: '/b.zip', outcome: 'updated' }] }),
  };
  const cards = [{ title: 'First title', exemplars: [{ path: '/a.zip' }] }, { displayTitle: 'Second title', exemplars: [{ path: '/b.zip' }] }];
  const catalogue = runner(() => useCatalogueOperations({ api, cards }));
  const preferences = runner(() => useCatalogueOperations({ api }));
  const original = globalThis.setTimeout;
  globalThis.setTimeout = fn => { timers.push(fn); return timers.length; };
  try {
    catalogue.render(); catalogue.flush(); await tick();
    preferences.render(); preferences.flush(); await tick();
    listeners[1](snapshot); timers.shift()(); await tick();
    assert.deepEqual(catalogue.render().state.items.trash.fileNames, ['First title', 'Second title']);
    listeners[0](snapshot); timers.shift()(); await tick();
    assert.deepEqual(preferences.render().state.items.trash.fileNames, ['First title', 'Second title']);
  } finally { globalThis.setTimeout = original; preferences.unmount(); catalogue.unmount(); }
});

test('opening after the last tracker unmount does not leave a stale selection', async () => {
  let resolve;
  const snapshot = { operationId: 'late', sequence: 1, status: 'running' };
  const api = {
    subscribeOperations: async () => () => {},
    listOperations: async () => ({ items: [snapshot], retainedOperationIds: ['late'] }),
    getOperation: () => new Promise(done => { resolve = done; }),
  };
  let app = runner(() => useCatalogueOperations({ api }));
  try {
    app.render(); app.flush(); await tick();
    const opening = app.render().open('late');
    app.unmount();
    resolve(snapshot); await opening;
    app = runner(() => useCatalogueOperations({ api }));
    app.render(); app.flush(); await tick();
    assert.equal(app.render().state.selected, null);
  } finally { app.unmount(); }
});

test('a buffered send terminal still settles the device when registry reads fail', async () => {
  let listener, unavailable = false;
  const ended = [], timers = [];
  const running = { operationId: 'send', operationKind: 'luniiSend', sequence: 1, status: 'running' };
  const api = {
    subscribeOperations: async callback => { listener = callback; return () => {}; },
    listOperations: async () => {
      if (unavailable) throw new Error('registry unavailable');
      return { items: [], retainedOperationIds: ['send'] };
    },
    getOperation: async () => running,
    send: async () => ({ operationId: 'send' }),
  };
  const device = { id: 'd', stories: [], mounted: true, generation: 'v2', capacity: { availableBytes: 10000000 } };
  const lunii = { luniiDevices: [device], store: { beginSend: () => null, endSend: async () => ended.push('d'), reportError: error => { throw error; } } };
  const cards = [{ id: 'c', title: 'Story', exemplars: [{ id: 'e', available: true, format: 'studio', path: '/pack.zip' }], referenceExemplarId: 'e' }];
  const app = runner(() => {
    const operations = useCatalogueOperations({ api });
    return { operations, sends: useLuniiSend({ lunii, operations, cards, revision: 1, api }) };
  });
  const original = globalThis.setTimeout;
  globalThis.setTimeout = fn => { timers.push(fn); return timers.length; };
  try {
    app.render(); app.flush(); await tick();
    await app.render().sends.sendCards('d', ['c']);
    app.render(); app.flush();
    unavailable = true;
    listener({ ...running, sequence: 2, status: 'success' });
    timers.shift()(); await tick();
    for (let i = 0; i < 4; i++) { app.render(); app.flush(); await tick(); }
    assert.equal(app.render().operations.state.items.send.status, 'success');
    assert.deepEqual(ended, ['d']);
    assert.deepEqual(app.render().operations.state.retained, {});
    assert.equal(app.render().sends.sending.size, 0);
  } finally { globalThis.setTimeout = original; app.unmount(); }
});

test('bounded operation sessions survive remount and ignore expired and retired deliveries', async () => {
  const registry = new Map();
  let listener;
  const api = {
    subscribeOperations: async callback => { listener = callback; return () => {}; },
    listOperations: async () => ({ items: [...registry.values()].slice(-20), retainedOperationIds: [...registry.keys()] }),
  };
  const mount = () => runner(() => useCatalogueOperations({ api }));
  let app = mount();
  const timers = [], original = globalThis.setTimeout;
  globalThis.setTimeout = fn => { timers.push(fn); return timers.length; };
  try {
    app.render(); app.flush(); await tick();
    for (let i = 0; i < 500; i++) {
      const value = { operationId: `op-${i}`, timestamp: i, sequence: 1, status: 'success', outcomes: { updated: 1 } };
      registry.set(value.operationId, value);
      if (registry.size > 32) registry.delete(registry.keys().next().value);
      listener(value); timers.shift()(); await tick();
      const operations = app.render(); app.flush();
      operations.dismiss(value.operationId);
      app.render(); app.flush();
    }
    let state = app.render().state;
    assert.equal(Object.keys(state.items).length, 20);
    assert.equal(Object.keys(state.dismissed).length, 20);
    assert.ok(Object.keys(state.retired).length <= 32);
    app.unmount(); app = mount(); app.render(); app.flush(); await tick();
    for (const id of ['op-0', 'op-468']) {
      listener({ operationId: id, sequence: 9999, timestamp: 9999, status: 'running' });
      timers.shift()(); await tick();
    }
    state = app.render().state;
    assert.equal(state.items['op-0'], undefined);
    assert.equal(state.items['op-468'], undefined);
    assert.equal(Object.keys(state.items).length, 20);
    assert.equal(Object.keys(state.dismissed).length, 20);
  } finally {
    globalThis.setTimeout = original;
    app.unmount();
  }
});

test('send reservation is released once before an evicted context is forgotten', async () => {
  const log = [];
  const operations = {
    state: { items: {}, dismissed: {} },
    retain: id => log.push(['retain', id]),
    release: id => log.push(['release', id]),
    open: async () => {},
  };
  const device = { id: 'd', stories: [], mounted: true, generation: 'v2', capacity: { availableBytes: 10000000 } };
  const lunii = { luniiDevices: [device], store: { beginSend: () => null, endSend: async () => log.push(['end', 'd']), reportError: error => { throw error; } } };
  const cards = [{ id: 'c', title: 'Story', exemplars: [{ id: 'e', available: true, format: 'studio', path: '/pack.zip' }], referenceExemplarId: 'e' }];
  const api = { send: async () => ({ operationId: 'send' }) };
  const app = runner(() => useLuniiSend({ lunii, operations, cards, revision: 1, api }));
  try {
    const context = await app.render().sendCards('d', ['c']);
    const requestId = context.requestId;
    assert.deepEqual(log, [['retain', requestId]]);
    operations.state.items.send = { operationId: 'send', operationKind: 'luniiSend', status: 'success' };
    app.render(); app.flush(); await tick();
    assert.deepEqual(log, [['retain', requestId], ['end', 'd'], ['release', requestId]]);
    delete operations.state.items.send;
    app.render(); app.flush();
    const send = app.render(); app.flush();
    assert.equal(send.contextFor('send'), null);
    assert.equal(send.sending.size, 0);
    assert.deepEqual(log, [['retain', requestId], ['end', 'd'], ['release', requestId]]);
  } finally { app.unmount(); }
});

test('a terminal arriving before its send receipt survives eviction and catalogue remount', async () => {
  const registry = new Map(), ended = [];
  let listener, accept, requestId;
  const api = {
    subscribeOperations: async callback => { listener = callback; return () => {}; },
    listOperations: async () => ({ items: [...registry.values()].slice(-20), retainedOperationIds: [...registry.keys()] }),
    getOperation: async id => { if (!registry.has(id)) throw new Error('expired'); return registry.get(id); },
    send: args => { requestId = args.requestId; return new Promise(resolve => { accept = resolve; }); },
  };
  const device = { id: 'd', stories: [], mounted: true, generation: 'v2', capacity: { availableBytes: 10000000 } };
  const lunii = { luniiDevices: [device], store: { beginSend: () => null, endSend: async () => ended.push('d'), reportError: error => { throw error; } } };
  const cards = [{ id: 'c', title: 'Story', exemplars: [{ id: 'e', available: true, format: 'studio', path: '/pack.zip' }], referenceExemplarId: 'e' }];
  const mount = () => runner(() => {
    const operations = useCatalogueOperations({ api });
    const sends = useLuniiSend({ lunii, operations, cards, revision: 1, api });
    return { operations, sends };
  });
  const timers = [], original = globalThis.setTimeout;
  globalThis.setTimeout = fn => { timers.push(fn); return timers.length; };
  let app = mount();
  try {
    app.render(); app.flush(); await tick();
    const sending = app.render().sends.sendCards('d', ['c']);
    await tick(); app.render(); app.flush();
    app.unmount(); app = mount(); app.render(); app.flush(); await tick();
    for (let i = 0; i < 50; i++) {
      const value = { operationId: i === 0 ? 'send' : `other-${i}`, requestId: i === 0 ? requestId : `other-request-${i}`, operationKind: i === 0 ? 'luniiSend' : undefined, timestamp: i, sequence: 1, status: 'success' };
      registry.set(value.operationId, value);
      if (registry.size > 32) registry.delete(registry.keys().next().value);
      listener(value); timers.shift()(); await tick();
      app.render(); app.flush();
    }
    assert.equal(registry.has('send'), false, 'the engine has already expired this operation');
    assert.equal(app.render().operations.state.items.send.status, 'success');
    accept({ operationId: 'send' }); await sending;
    for (let i = 0; i < 5; i++) { app.render(); app.flush(); await tick(); }
    const result = app.render();
    assert.deepEqual(ended, ['d']);
    assert.deepEqual(result.operations.state.retained, {});
    assert.equal(result.operations.state.items.send, undefined);
    assert.equal(result.sends.contexts.length, 0);
  } finally {
    globalThis.setTimeout = original;
    app.unmount();
  }
});

test('a rejected send releases its pending retention after leaving the catalogue', async () => {
  let reject;
  const ended = [], errors = [];
  const api = {
    subscribeOperations: async () => () => {},
    listOperations: async () => ({ items: [], retainedOperationIds: [] }),
    send: () => new Promise((resolve, fail) => { reject = fail; }),
  };
  const device = { id: 'd', stories: [], mounted: true, generation: 'v2', capacity: { availableBytes: 10000000 } };
  const lunii = { luniiDevices: [device], store: { beginSend: () => null, endSend: async () => ended.push('d'), reportError: error => errors.push(error) } };
  const cards = [{ id: 'c', exemplars: [{ id: 'e', available: true, format: 'studio', path: '/pack.zip' }], referenceExemplarId: 'e' }];
  const mount = () => runner(() => {
    const operations = useCatalogueOperations({ api });
    return { operations, sends: useLuniiSend({ lunii, operations, cards, revision: 1, api }) };
  });
  let app = mount();
  app.render(); app.flush(); await tick();
  const sending = app.render().sends.sendCards('d', ['c']);
  await tick(); app.render(); app.flush();
  assert.equal(Object.keys(app.render().operations.state.retained).length, 1);
  app.unmount();
  reject(new Error('send refused')); await sending;
  app = mount(); app.render(); app.flush(); await tick();
  assert.deepEqual(app.render().operations.state.retained, {});
  assert.deepEqual(ended, ['d']);
  assert.equal(errors.length, 1);
  app.unmount();
});
