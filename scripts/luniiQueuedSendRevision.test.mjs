import test from 'node:test';
import assert from 'node:assert/strict';
import { runner } from './reactHookDriver.mjs';
import { createLuniiDevices } from '../src/store/catalogue/luniiDevices.js';
const { useLuniiSend } = await import('../src/hooks/useLuniiSend.js');

const stories = [{ key: 'a', title: 'A', kind: 'creation' }];
const device = () => ({ id: 'd', name: 'Lunii', state: 'ready', busy: false, stories, orphans: [], banner: [], totalBytes: 1000, freeBytes: 400 });
const card = id => ({ id, displayTitle: id.toUpperCase(), uuids: [], coverSignature: 's', referenceExemplarId: `${id}-x`, exemplars: [{ id: `${id}-x`, available: true, sizeBytes: 100 }] });
const tick = () => new Promise(resolve => setImmediate(resolve));

test('a send waiting in the queue is sent with the catalogue revision current when it starts', async () => {
  const sent = [], gates = new Map();
  const api = {
    list: async () => [{ id: 'd', state: 'ready', busy: false }],
    inspect: async () => device(),
    send: async args => { sent.push(args.selection.map(s => s.expectedRevision)); return { operationId: args.requestId }; },
    getOperation: id => new Promise(resolve => gates.set(id, resolve)),
  };
  const store = createLuniiDevices(api, { read() {}, write() {} });
  store.reconcile([{ id: 'd', state: 'detected' }]); await store.inspect('d');
  const operations = { state: { items: {} }, open: async id => { operations.state.items[id] = { operationId: id, status: 'running' }; }, cancel: () => true, release() {}, retain() {} };
  let revision = 1;
  const app = runner(() => useLuniiSend({ lunii: { ...store.getSnapshot(), store }, operations, cards: [card('x'), card('y')], revision, api }));
  app.render(); app.flush();
  const first = app.render().sendCards('d', ['x'], null); await tick();
  const second = app.render().sendCards('d', ['y'], null); await tick();
  assert.deepEqual(sent, [[1]], 'the first send runs, the second waits');
  // The catalogue moves while the second send waits (favourite, scan, repatriation, cover…).
  revision = 2; app.render(); app.flush();
  gates.values().next().value({ status: 'success', result: { stories: [{ step: 'done', deviceFault: false }] } });
  await first; await tick(); await tick();
  assert.equal(sent.length, 2, 'the second send started');
  [...gates.values()].at(-1)({ status: 'success', result: { stories: [{ step: 'done', deviceFault: false }] } });
  await second;
  app.unmount();
  assert.deepEqual(sent[1], [2], 'the engine refuses expectedRevision 1 once the catalogue is at revision 2');
});
