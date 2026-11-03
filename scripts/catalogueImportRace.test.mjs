import test from 'node:test';
import assert from 'node:assert/strict';
import { runner } from './reactHookDriver.mjs';
import './tauriDiskHarness.mjs';
import fixture from './fixtures/catalogue/backup-import.json' with { type: 'json' };
const { useCatalogueImport } = await import('../src/hooks/useCatalogueImport.js');
const { importPreviewReducer: reduce, INITIAL_IMPORT, canApplyImport } = await import('../src/store/catalogue/importPreviewState.js');
const tick = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
const deferred = () => { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const page = id => ({ ...structuredClone(fixture.preview), previewId: id });
function mount(api) {
  let hook;
  const app = runner(() => { hook = useCatalogueImport({ api }); });
  const render = () => { app.render(); app.flush(); };
  render();
  return { app, render, get hook() { return hook; } };
}

for (const returnToA of [false, true]) for (const fail of [false, true]) {
  test(`late pagination ${fail ? 'error' : 'page'} is ignored after A → B${returnToA ? ' → A' : ''}`, async () => {
    const pending = deferred(); const applied = [];
    const api = { importPage: () => pending.promise, applyImport: async args => { applied.push(args.previewId); return { operationId: 'apply' }; } };
    const b = mount(api);
    try {
      b.hook.dispatch({ type: 'path', path: 'A.zip' });
      b.hook.dispatch({ type: 'page', page: page('preview-A'), prepared: true }); b.render();
      const paging = b.hook.page(100);
      b.hook.dispatch({ type: 'path', path: 'B.zip' });
      if (returnToA) b.hook.dispatch({ type: 'path', path: 'A.zip' });
      b.render();
      if (fail) pending.reject(new Error('late A')); else pending.resolve(page('preview-A'));
      await paging; b.render();
      assert.equal(b.hook.state.path, returnToA ? 'A.zip' : 'B.zip');
      assert.equal(b.hook.state.preview, null);
      assert.equal(b.hook.state.error, null);
      assert.equal(b.hook.state.phase, 'choosing');
      await b.hook.apply(); assert.deepEqual(applied, []);
    } finally { b.app.unmount(); }
  });
}

for (const fail of [false, true]) test(`first page ${fail ? 'error' : 'response'} cannot cross a closed and reopened import`, async () => {
  const pending = deferred(); const b = mount({
    previewImport: async () => ({ operationId: 'prepare' }),
    importOperation: async () => ({ status: 'success', result: { previewId: 'preview-A' } }),
    importPage: () => pending.promise,
  });
  try {
    b.hook.dispatch({ type: 'path', path: 'A.zip' }); b.render();
    await b.hook.preview(); b.render(); await tick();
    // A failed tracking event can release the dialog while its first page is in flight.
    b.hook.dispatch({ type: 'failed', error: new Error('tracking') });
    b.hook.dispatch({ type: 'close' }); b.hook.dispatch({ type: 'open' });
    b.hook.dispatch({ type: 'path', path: 'B.zip' });
    // Resolve before effects clean up: the reducer must reject the queued response too.
    if (fail) pending.reject(new Error('late A')); else pending.resolve(page('preview-A'));
    await tick(); b.render();
    assert.equal(b.hook.state.path, 'B.zip');
    assert.equal(b.hook.state.phase, 'choosing');
    assert.equal(b.hook.state.preview, null); assert.equal(b.hook.state.error, null);
  } finally { b.app.unmount(); }
});

test('current pages and their errors still reach the current import', async () => {
  let fail = false; const applied = [];
  const api = {
    previewImport: async path => { assert.equal(path, 'B.zip'); return { operationId: 'prepare' }; },
    importOperation: async () => ({ status: 'success', result: { previewId: 'preview-B' } }),
    importPage: async id => { assert.equal(id, 'preview-B'); if (fail) throw new Error('current'); return page('preview-B'); },
    applyImport: async args => { applied.push(args.previewId); return { operationId: 'apply' }; },
  };
  const b = mount(api);
  try {
    b.hook.dispatch({ type: 'path', path: 'B.zip' }); b.render();
    await b.hook.preview(); b.render(); await tick(); b.render();
    await b.hook.page(100); b.render(); assert.equal(b.hook.state.preview.previewId, 'preview-B');
    await b.hook.apply(); assert.deepEqual(applied, ['preview-B']);
    b.hook.dispatch({ type: 'page', page: page('preview-B') }); b.render();
    fail = true; await b.hook.page(100); b.render();
    assert.equal(b.hook.state.phase, 'failed'); assert.equal(b.hook.state.error.message, 'current');
  } finally { b.app.unmount(); }
});

for (const oldFirst of [false, true]) test(`stale events ${oldFirst ? 'before' : 'after'} the current first page cannot replace its identity`, () => {
  let state = reduce(INITIAL_IMPORT, { type: 'path', path: 'A.zip' });
  const oldContext = {}; const context = {};
  state = reduce(state, { type: 'begin', mode: 'preview', context: oldContext });
  state = reduce(state, { type: 'page', page: page('preview-A'), context: oldContext });
  state = reduce(state, { type: 'path', path: 'B.zip' });
  state = reduce(state, { type: 'begin', mode: 'preview', context });
  const current = { type: 'page', page: page('preview-B'), prepared: true, context };
  if (!oldFirst) state = reduce(state, current);
  for (const event of [
    { type: 'page', page: page('preview-A') },
    { type: 'failed', error: new Error('old') },
    { type: 'trackingError', error: new Error('old tracking') },
    { type: 'receipt', receipt: { operationId: 'old' } },
  ]) assert.equal(reduce(state, { ...event, context: oldContext }), state);
  if (oldFirst) state = reduce(state, current);
  assert.equal(state.path, 'B.zip'); assert.equal(state.preview.previewId, 'preview-B');
  assert.equal(canApplyImport(state), true);
});
