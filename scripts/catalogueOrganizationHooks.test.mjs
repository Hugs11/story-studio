import test from 'node:test';
import assert from 'node:assert/strict';
import { runner } from './reactHookDriver.mjs';
const { useCatalogueSelectionActions } = await import('../src/hooks/useCatalogueSelectionActions.js');
const { useCatalogueTags } = await import('../src/hooks/useCatalogueTags.js');
const deferred = () => { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
test('visible selection, one mutation and announcement; failed action preserves selection and retry key', async () => {
 const ids = ['a', 'hidden']; const calls = []; const notices = []; const failures = []; let fail = true; let reloads = 0;
 const cards = [{ id: 'a', ficheRevision: 2, favorite: false }, { id: 'hidden', ficheRevision: 4 }];
 const hook = runner(() => useCatalogueSelectionActions({ ids, cards, visibleIds: ['a'], revision: 8,
  api: { mutate: async (mutation, expected) => { calls.push({ mutation, expected }); if (fail) throw { code: null }; return { catalogueRevision: 9, affectedCardIds: ['a'] }; } },
  onReload: () => { reloads++; }, onAnnounce: notice => notices.push(notice), onError: error => failures.push(error) }));
 let actions = hook.render(); assert.equal(await actions.favorite(), false);
 assert.deepEqual(ids, ['a', 'hidden']); assert.equal(notices.length, 0); assert.equal(failures.length, 1);
 fail = false; actions = hook.render(); assert.ok(await actions.favorite());
 assert.deepEqual(calls[0], calls[1], 'retry uses the exact same request identity');
 assert.deepEqual(calls[1].mutation.ficheIds, ['a']); assert.deepEqual(calls[1].mutation.expectedFicheRevisions, { a: 2 });
 assert.equal(notices.length, 1); assert.equal(notices[0].params.count, 1); assert.equal(reloads, 1);
 assert.deepEqual(ids, ['a', 'hidden']); hook.unmount();
});
test('conflict and label collision reload data, concurrent actions are refused, reload failure keeps success', async () => {
 for (const code of ['CATALOG_REVISION_CONFLICT', 'CATALOG_NAME_DUPLICATE']) {
  let reloads = 0; const errors = []; const ids = ['a']; const wait = deferred();
  const hook = runner(() => useCatalogueSelectionActions({ ids, cards: [{ id: 'a' }], visibleIds: ids, revision: 1,
   api: { mutate: () => wait.promise }, onReload: () => { reloads++; }, onError: e => errors.push(e) }));
  const actions = hook.render(); const first = actions.mutate({ kind: 'changeTags', ficheIds: ['a'], addLabels: ['X'], addTagIds: [], removeTagIds: [] });
  assert.equal(await actions.mutate({ kind: 'changeTags', ficheIds: ['a'], addLabels: ['Y'], addTagIds: [], removeTagIds: [] }), false);
  wait.reject({ code }); assert.equal(await first, false); assert.equal(reloads, 1); assert.equal(errors[0].code, code);
  assert.deepEqual(ids, ['a']); assert.equal(hook.render().busy, false); hook.unmount();
 }
 const errors = []; const outcome = { catalogueRevision: 2, affectedCardIds: [] };
 const hook = runner(() => useCatalogueSelectionActions({ ids: [], cards: [], visibleIds: [], revision: 1,
  api: { mutate: async () => outcome }, onReload: async () => { throw Error('refresh'); }, onError: error => errors.push(error) }));
 assert.equal(await hook.render().mutate({ kind: 'changeTags', ficheIds: ['a'], addLabels: ['X'], addTagIds: [], removeTagIds: [] }), outcome);
 assert.equal(errors.length, 1); hook.unmount();
});
for (const [useList, method] of [[useCatalogueTags, 'listTags']]) {
 test(`${method}: late list response cannot replace a newer list`, async () => {
  const calls = []; const api = { [method]: () => { const next = deferred(); calls.push(next); return next.promise; } };
  const hook = runner(() => useList(api)); let list = hook.render(); hook.flush();
  const latest = list.reload(); calls[1].resolve({ revision: 2, items: [{ id: 'new' }] }); await latest;
  calls[0].resolve({ revision: 1, items: [{ id: 'old' }] }); await Promise.resolve();
  list = hook.render(); assert.equal(list.revision, 2); assert.equal(list.items[0].id, 'new'); hook.unmount();
 });
}
