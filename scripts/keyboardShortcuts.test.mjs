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

test('loadKeyboardShortcuts migrates the old simulator tab gap', () => {
  globalThis.localStorage.setItem(KEYS.KEYBOARD_SHORTCUTS, JSON.stringify({
    tabEdit: { ctrl: true, key: '1', code: 'Digit1' },
    tabDiagram: { ctrl: true, key: '3', code: 'Digit3' },
    tabOptions: { ctrl: true, key: '4', code: 'Digit4' },
    saveProject: { ctrl: true, key: 's', code: 'KeyS' },
  }));

  const loaded = loadKeyboardShortcuts();
  const persisted = JSON.parse(globalThis.localStorage.getItem(KEYS.KEYBOARD_SHORTCUTS));

  assert.deepEqual(loaded.tabEdit, shortcut('Digit1', '1'));
  assert.deepEqual(loaded.tabDiagram, shortcut('Digit2', '2'));
  assert.deepEqual(loaded.tabOptions, shortcut('Digit3', '3'));
  assert.deepEqual(persisted.tabDiagram, shortcut('Digit2', '2'));
  assert.deepEqual(persisted.tabOptions, shortcut('Digit3', '3'));
  assert.deepEqual(loaded.saveProject, shortcut('KeyS', 's'));
});

test('loadKeyboardShortcuts preserves customized tab shortcuts', () => {
  const customShortcuts = {
    tabEdit: { ctrl: true, key: '1', code: 'Digit1' },
    tabDiagram: { ctrl: true, key: '5', code: 'Digit5' },
    tabOptions: { ctrl: true, key: '4', code: 'Digit4' },
  };
  globalThis.localStorage.setItem(KEYS.KEYBOARD_SHORTCUTS, JSON.stringify(customShortcuts));

  const loaded = loadKeyboardShortcuts();
  const persisted = JSON.parse(globalThis.localStorage.getItem(KEYS.KEYBOARD_SHORTCUTS));

  assert.deepEqual(loaded.tabDiagram, shortcut('Digit5', '5'));
  assert.deepEqual(loaded.tabOptions, shortcut('Digit4', '4'));
  assert.deepEqual(persisted, customShortcuts);
});
