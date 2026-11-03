import test from 'node:test';
import assert from 'node:assert/strict';
import { captureMenuTarget, menuRevealRequest, catalogueShortcutsEnabled, closeFicheState, reconcileFicheState, selectionPanelTarget } from '../src/store/catalogue/browserState.js';
import { createCatalogueApi } from '../src/store/catalogue/catalogueApi.js';
import { card } from './catalogueFixtures.mjs';
import { menuEntries } from '../src/store/catalogue/cardActions.js';
import { memoizePipeline } from '../src/store/catalogue/pipeline.js';

test('opened menu keeps its target/revision through refresh: reveal is rejected, reopening succeeds', async () => {
  const original = card({ id: 'a', exemplars: [{ id: 'zip', path: '/Packs/original.zip' }] });
  const snapshot = captureMenuTarget({ card: original, exemplars: original.exemplars }, 7);
  const refreshed = card({ id: 'a', exemplars: [{ id: 'zip', path: '/Packs/replaced.zip' }] });
  const currentRevision = 8;
  const calls = [];
  const api = createCatalogueApi({ listen: async () => () => {}, invoke: async (command, args) => {
    calls.push({ command, args });
    if (args.expectedRevision !== currentRevision) throw { code: 'CATALOG_TARGET_REVISION_CHANGED', params: { path: '/Packs/original.zip' } };
    return { revealed: true, fallbackParentOpened: false };
  } });
  const entry = menuEntries({ open: true, kind: 'exemplar', scope: 'zip' }, snapshot.card, snapshot.exemplars).find(e => e.action.id === 'reveal');
  assert.equal(entry.exemplar.path, '/Packs/original.zip');
  await assert.rejects(api.revealExemplar(menuRevealRequest(snapshot, entry.exemplar)), { code: 'CATALOG_TARGET_REVISION_CHANGED' });
  assert.deepEqual(calls[0], { command: 'catalogue_reveal_exemplar', args: { exemplarId: 'zip', expectedRevision: 7 } });
  const reopened = captureMenuTarget({ card: refreshed, exemplars: refreshed.exemplars }, currentRevision);
  assert.equal((await api.revealExemplar(menuRevealRequest(reopened, reopened.exemplars[0]))).revealed, true);
  assert.equal(snapshot.revision, 7);
});

for (const command of ['search', 'selectAll', 'clear']) test(`Sources suspends ${command}; returning to Catalogue preserves criteria and re-enables it`, () => {
  const cards = [card({ id: 'a', title: 'Abeille' }), card({ id: 'b', title: 'Zèbre' })];
  const criteria = { query: 'Abeille', sort: { key: 'title', direction: 'desc' } };
  const memo = memoizePipeline();
  const result = memo(cards, criteria);
  assert.equal(catalogueShortcutsEnabled(true, false), true);
  assert.equal(catalogueShortcutsEnabled(false, false), false);
  assert.equal(catalogueShortcutsEnabled(false, true), false);
  assert.equal(memo(cards, criteria), result);
  assert.equal(catalogueShortcutsEnabled(true, false), true);
  assert.deepEqual(result.result.ids, ['a']);
});

test('a reconciled-away fiche closes, chooses a remaining focus target and unblocks shortcuts', () => {
  const transition = reconcileFicheState('gone', new Map([['b', {}], ['c', {}]]), ['b', 'c'], 'gone');
  assert.deepEqual(transition, { ficheId: null, focusId: 'b' });
  assert.equal(catalogueShortcutsEnabled(true, transition.ficheId !== null), true);
  assert.deepEqual(reconcileFicheState('gone', new Map([['b', {}], ['c', {}]]), ['b', 'c'], 'c'), { ficheId: null, focusId: 'c' });
  assert.equal(reconcileFicheState(transition.ficheId, new Map(), [], null), null);
});
test('no remaining result returns to search; filtering alone never closes an existing fiche', () => {
  assert.deepEqual(reconcileFicheState('gone', new Map(), [], 'gone'), { ficheId: null, focusId: null });
  assert.equal(reconcileFicheState('kept', new Map([['kept', {}]]), [], null), null);
  assert.deepEqual(closeFicheState('kept', ['kept', 'b'], 'b'), { ficheId: null, focusId: 'kept' });
});

test('selection panel follows mouse and keyboard selection without keeping a removed target', () => {
  const order = ['a', 'b', 'c'];
  const selected = { ids: ['a', 'b'], anchor: 'a' };
  assert.equal(selectionPanelTarget(selected, { type: 'toggle', id: 'b' }, order, 'b'), 'a');
  assert.equal(selectionPanelTarget({ ids: ['a'], anchor: 'a' }, { type: 'toggle', id: 'a' }, order, 'a'), null);
  assert.equal(selectionPanelTarget(selected, { type: 'range', id: 'c' }, order, 'c'), 'c');
  assert.equal(selectionPanelTarget(selected, { type: 'click', id: 'c' }, order, 'c'), 'c');
  // Ctrl+A uses only visible results, including when the previous focus is hidden.
  assert.equal(selectionPanelTarget(selected, { type: 'selectAll' }, ['b', 'c'], 'a'), 'b');
  assert.equal(selectionPanelTarget(selected, { type: 'selectAll' }, [], 'a'), null);
  assert.deepEqual(selected, { ids: ['a', 'b'], anchor: 'a' });
});
