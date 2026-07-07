import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';

import { KEYS } from '../src/store/persistentSettings.js';
import { loadKeyboardShortcuts } from '../src/store/keyboardShortcuts.js';

function shortcut(code, key) {
  return {
    ctrl: true,
    shift: false,
    alt: false,
    meta: false,
    code,
    key,
  };
}

function shiftShortcut(code, key) {
  return {
    ctrl: true,
    shift: true,
    alt: false,
    meta: false,
    code,
    key,
  };
}

function createLocalStorageMock() {
  const values = new Map();
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}

beforeEach(() => {
  globalThis.localStorage = createLocalStorageMock();
});

test('loadKeyboardShortcuts migrates the wave-1 tab model to panel toggles', () => {
  globalThis.localStorage.setItem(KEYS.KEYBOARD_SHORTCUTS, JSON.stringify({
    tabEdit: { ctrl: true, key: '1', code: 'Digit1' },
    tabDiagram: { ctrl: true, key: '2', code: 'Digit2' },
    tabOptions: { ctrl: true, key: '3', code: 'Digit3' },
    saveProject: { ctrl: true, key: 's', code: 'KeyS' },
  }));

  const loaded = loadKeyboardShortcuts();
  const persisted = JSON.parse(globalThis.localStorage.getItem(KEYS.KEYBOARD_SHORTCUTS));

  assert.deepEqual(loaded.toggleTree, shortcut('Digit1', '1'));
  assert.deepEqual(loaded.toggleSettings, shortcut('Digit2', '2'));
  assert.deepEqual(loaded.toggleDiagram, shortcut('Digit3', '3'));
  assert.deepEqual(loaded.tabOptions, shiftShortcut('KeyO', 'o'));
  assert.deepEqual(loaded.saveProject, shortcut('KeyS', 's'));

  // Ids morts purgés, nouvelles bascules et tabOptions déménagé persistés.
  assert.equal(persisted.tabEdit, undefined);
  assert.equal(persisted.tabDiagram, undefined);
  assert.deepEqual(persisted.toggleTree, shortcut('Digit1', '1'));
  assert.deepEqual(persisted.toggleDiagram, shortcut('Digit3', '3'));
  assert.deepEqual(persisted.tabOptions, shiftShortcut('KeyO', 'o'));
});

test('loadKeyboardShortcuts migrates the legacy simulator-gap blob', () => {
  globalThis.localStorage.setItem(KEYS.KEYBOARD_SHORTCUTS, JSON.stringify({
    tabEdit: { ctrl: true, key: '1', code: 'Digit1' },
    tabDiagram: { ctrl: true, key: '3', code: 'Digit3' },
    tabOptions: { ctrl: true, key: '4', code: 'Digit4' },
  }));

  const loaded = loadKeyboardShortcuts();
  const persisted = JSON.parse(globalThis.localStorage.getItem(KEYS.KEYBOARD_SHORTCUTS));

  assert.deepEqual(loaded.toggleTree, shortcut('Digit1', '1'));
  assert.deepEqual(loaded.toggleSettings, shortcut('Digit2', '2'));
  assert.deepEqual(loaded.toggleDiagram, shortcut('Digit3', '3'));
  assert.deepEqual(loaded.tabOptions, shiftShortcut('KeyO', 'o'));

  assert.equal(persisted.tabEdit, undefined);
  assert.equal(persisted.tabDiagram, undefined);
  assert.deepEqual(persisted.tabOptions, shiftShortcut('KeyO', 'o'));
});

test('loadKeyboardShortcuts preserves a genuinely customized tabOptions', () => {
  globalThis.localStorage.setItem(KEYS.KEYBOARD_SHORTCUTS, JSON.stringify({
    tabOptions: { ctrl: true, key: 'p', code: 'KeyP' },
  }));

  const loaded = loadKeyboardShortcuts();
  const persisted = JSON.parse(globalThis.localStorage.getItem(KEYS.KEYBOARD_SHORTCUTS));

  // Personnalisation réelle : conservée (pas déplacée vers Ctrl+Maj+O).
  assert.deepEqual(loaded.tabOptions, shortcut('KeyP', 'p'));
  assert.deepEqual(persisted.tabOptions, { ctrl: true, key: 'p', code: 'KeyP' });
  // Les bascules absentes sont créées avec leur défaut.
  assert.deepEqual(persisted.toggleDiagram, shortcut('Digit3', '3'));
});

test('loadKeyboardShortcuts leaves storySettings untouched', () => {
  globalThis.localStorage.setItem(KEYS.KEYBOARD_SHORTCUTS, JSON.stringify({
    tabOptions: { ctrl: true, key: '3', code: 'Digit3' },
    storySettings: { ctrl: true, key: ',', code: 'Comma' },
  }));

  const loaded = loadKeyboardShortcuts();
  const persisted = JSON.parse(globalThis.localStorage.getItem(KEYS.KEYBOARD_SHORTCUTS));

  assert.deepEqual(loaded.storySettings, shortcut('Comma', ','));
  assert.deepEqual(persisted.storySettings, { ctrl: true, key: ',', code: 'Comma' });
  // tabOptions a bien déménagé sans toucher storySettings (Ctrl+, reste « Options du pack »).
  assert.deepEqual(loaded.tabOptions, shiftShortcut('KeyO', 'o'));
});
