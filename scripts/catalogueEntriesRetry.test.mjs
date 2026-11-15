import test from 'node:test';
import assert from 'node:assert/strict';
import { runner } from './reactHookDriver.mjs';
const { useCatalogueEntries } = await import('../src/hooks/useCatalogueEntries.js');
const expired = { code: 'CATALOG_ENTRIES_CURSOR_EXPIRED', params: {} };
const settle = () => new Promise(resolve => setImmediate(resolve));

function fixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let change;
  let response = { cards: [{ id: 'known' }], revision: 1 };
  let calls = 0;
  const api = {
    subscribeChanges: callback => { change = callback; return () => {}; },
    listAllEntries: async () => { calls++; if (response.code) throw response; return response; },
  };
  const app = runner(() => useCatalogueEntries({ api }));
  app.render(); app.flush();
  t.after(() => app.unmount());
  return { app, change: () => change({ revision: 2 }), set: next => { response = next; }, calls: () => calls };
}

test('cursor expiry then success: retry after one second, keep cards and suppress warning', async t => {
  const f = fixture(t);
  await settle();
  const known = f.app.render().cards;
  f.set(expired); f.change(); t.mock.timers.tick(250); await settle();
  assert.equal(f.app.render().cards, known);
  assert.equal(f.app.render().error, null);
  assert.equal(f.app.render().reloading, true);
  t.mock.timers.tick(999); await settle(); assert.equal(f.calls(), 2);
  f.set({ cards: [{ id: 'updated' }], revision: 2 });
  t.mock.timers.tick(1); await settle();
  assert.deepEqual(f.app.render().cards, [{ id: 'updated' }]);
  assert.equal(f.app.render().error, null);
  assert.equal(f.app.render().reloading, false);
});

test('persistent cursor expiry: five delayed retries then warning, known cards retained', async t => {
  const f = fixture(t); await settle();
  const known = f.app.render().cards;
  f.set(expired); f.change(); t.mock.timers.tick(250); await settle();
  for (let i = 0; i < 5; i++) {
    assert.equal(f.app.render().error, null);
    assert.equal(f.app.render().cards, known);
    t.mock.timers.tick(1000); await settle();
  }
  assert.equal(f.calls(), 7);
  assert.equal(f.app.render().error, expired);
  assert.equal(f.app.render().cards, known);
  assert.equal(f.app.render().reloading, false);
});

test('store failure is reported immediately; unmount stops a scheduled retry', async t => {
  const f = fixture(t); await settle();
  const failure = { code: 'CATALOG_STORE_ERROR' };
  f.set(failure); f.change(); t.mock.timers.tick(250); await settle();
  assert.equal(f.app.render().error, failure);
  f.set(expired); f.change(); t.mock.timers.tick(250); await settle();
  assert.equal(f.app.render().error, null);
  const calls = f.calls();
  f.app.unmount(); t.mock.timers.tick(1000); await settle();
  assert.equal(f.calls(), calls);
});
