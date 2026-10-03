// Sélectionner un nœud ouvre-t-il son panneau d'édition ? Une règle et une
// préférence communes aux deux éditeurs.

import assert from 'node:assert/strict';
import test from 'node:test';

const memory = new Map();
globalThis.localStorage = {
  getItem: (key) => (memory.has(key) ? memory.get(key) : null),
  setItem: (key, value) => { memory.set(key, String(value)); },
  removeItem: (key) => { memory.delete(key); },
};

const { KEYS } = await import('../src/store/persistentSettings.js');
const {
  DEFAULT_SELECTION_OPENS_SETTINGS,
  readSelectionOpensSettings,
  resetSelectionOpensSettingsCache,
  shouldOpenSettingsForSelection,
  subscribeSelectionOpensSettings,
  writeSelectionOpensSettings,
} = await import('../src/store/selectionOpensSettings.js');

function fresh() {
  memory.clear();
  resetSelectionOpensSettingsCache();
}

test('sans préférence retenue, sélectionner ouvre le panneau', () => {
  fresh();
  assert.equal(DEFAULT_SELECTION_OPENS_SETTINGS, true);
  assert.equal(readSelectionOpensSettings(), true);
});

test('la préférence est retenue, relue et annoncée', () => {
  fresh();
  let heard = 0;
  const unsubscribe = subscribeSelectionOpensSettings(() => { heard += 1; });
  writeSelectionOpensSettings(false);
  assert.equal(heard, 1);
  assert.equal(memory.get(KEYS.SELECTION_OPENS_SETTINGS), 'false');
  resetSelectionOpensSettingsCache();
  assert.equal(readSelectionOpensSettings(), false);
  unsubscribe();
  writeSelectionOpensSettings(true);
  assert.equal(heard, 1);
});

test('une sélection non vide ouvre un panneau fermé, si la préférence le permet', () => {
  fresh();
  // Un nœud ou plusieurs : le panneau agit aussi sur une sélection multiple.
  assert.equal(shouldOpenSettingsForSelection(1, { panelOpen: false }), true);
  assert.equal(shouldOpenSettingsForSelection(12, { panelOpen: false }), true);
  // Rien à ouvrir : déjà ouvert, ou un clic dans le vide.
  assert.equal(shouldOpenSettingsForSelection(1, { panelOpen: true }), false);
  assert.equal(shouldOpenSettingsForSelection(0, { panelOpen: false }), false);
  // Refusé par l'auteur.
  writeSelectionOpensSettings(false);
  assert.equal(shouldOpenSettingsForSelection(1, { panelOpen: false }), false);
});
