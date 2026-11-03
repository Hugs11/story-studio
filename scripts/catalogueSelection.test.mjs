// Sélection multiple : clic, Ctrl/Cmd, plage Maj dans les deux sens, tout
// sélectionner, vider, retrait des fiches masquées avec leur liste.

import test from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY_SELECTION, prunedAnnouncement, pruneSelection, selectionReducer } from '../src/store/catalogue/selection.js';

const order = ['a', 'b', 'c', 'd', 'e'];
const run = (actions, state = EMPTY_SELECTION) => actions.reduce(selectionReducer, state);

test('clic simple remplace la sélection', () => {
  assert.deepEqual(run([{ type: 'click', id: 'b' }, { type: 'click', id: 'd' }]), { ids: ['d'], anchor: 'd' });
});

test('Ctrl/Cmd étend puis retire', () => {
  const state = run([{ type: 'click', id: 'a' }, { type: 'toggle', id: 'c' }, { type: 'toggle', id: 'e' }]);
  assert.deepEqual(state.ids, ['a', 'c', 'e']);
  assert.deepEqual(run([{ type: 'toggle', id: 'c' }], state).ids, ['a', 'e']);
});

test('Maj sélectionne une plage sur l’ordre affiché, dans les deux sens', () => {
  assert.deepEqual(run([{ type: 'click', id: 'b' }, { type: 'range', id: 'd', order }]), { ids: ['b', 'c', 'd'], anchor: 'b' });
  assert.deepEqual(run([{ type: 'click', id: 'd' }, { type: 'range', id: 'a', order }]), { ids: ['a', 'b', 'c', 'd'], anchor: 'd' });
  // L'ancre reste fixe : une seconde plage repart d'elle.
  assert.deepEqual(run([{ type: 'click', id: 'c' }, { type: 'range', id: 'e', order }, { type: 'range', id: 'b', order }]).ids, ['b', 'c']);
  // Sans ancre visible, la plage se réduit à la fiche.
  assert.deepEqual(run([{ type: 'range', id: 'c', order }]), { ids: ['c'], anchor: 'c' });
});

test('tout sélectionner = résultats filtrés ; vider', () => {
  const filtered = ['b', 'd'];
  assert.deepEqual(run([{ type: 'selectAll', order: filtered }]).ids, ['b', 'd']);
  assert.deepEqual(run([{ type: 'click', id: 'a' }, { type: 'clear' }]), EMPTY_SELECTION);
});

test('retrait des fiches masquées, renvoyées pour l’annonce', () => {
  const state = run([{ type: 'click', id: 'a' }, { type: 'toggle', id: 'c' }, { type: 'toggle', id: 'd' }]);
  const { selection, removed } = pruneSelection(state, ['a', 'b']);
  assert.deepEqual(removed, ['c', 'd']);
  assert.deepEqual(selection, { ids: ['a'], anchor: null }, 'ancre masquée oubliée');
  assert.deepEqual(prunedAnnouncement(removed), { key: 'catalogue:selection.hidden.removed', params: { count: 2 } });
  const unchanged = pruneSelection(state, order);
  assert.equal(unchanged.selection, state);
  assert.equal(prunedAnnouncement(unchanged.removed), null);
});
