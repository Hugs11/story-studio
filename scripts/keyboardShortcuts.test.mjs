import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';

import { KEYS } from '../src/store/persistentSettings.js';
import {
  findShortcutAction,
  loadKeyboardShortcuts,
} from '../src/store/keyboardShortcuts.js';

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

test('loadKeyboardShortcuts migrates a customized tabDiagram to toggleDiagram', () => {
  globalThis.localStorage.setItem(KEYS.KEYBOARD_SHORTCUTS, JSON.stringify({
    tabDiagram: { ctrl: true, shift: true, key: 'd', code: 'KeyD' },
  }));

  const loaded = loadKeyboardShortcuts();
  const persisted = JSON.parse(globalThis.localStorage.getItem(KEYS.KEYBOARD_SHORTCUTS));

  assert.deepEqual(loaded.toggleDiagram, shiftShortcut('KeyD', 'd'));
  assert.deepEqual(persisted.toggleDiagram, shiftShortcut('KeyD', 'd'));
  assert.equal(persisted.tabDiagram, undefined);
});

test('loadKeyboardShortcuts migrates a customized tabEdit to toggleSettings', () => {
  globalThis.localStorage.setItem(KEYS.KEYBOARD_SHORTCUTS, JSON.stringify({
    tabEdit: { ctrl: true, shift: true, key: 'k', code: 'KeyK' },
  }));

  const loaded = loadKeyboardShortcuts();
  const persisted = JSON.parse(globalThis.localStorage.getItem(KEYS.KEYBOARD_SHORTCUTS));

  assert.deepEqual(loaded.toggleSettings, shiftShortcut('KeyK', 'k'));
  assert.deepEqual(persisted.toggleSettings, shiftShortcut('KeyK', 'k'));
  assert.equal(persisted.tabEdit, undefined);
});

test('loadKeyboardShortcuts keeps an existing new panel shortcut over its legacy value', () => {
  globalThis.localStorage.setItem(KEYS.KEYBOARD_SHORTCUTS, JSON.stringify({
    tabDiagram: { ctrl: true, shift: true, key: 'd', code: 'KeyD' },
    toggleDiagram: { ctrl: true, shift: true, key: 'g', code: 'KeyG' },
  }));

  const loaded = loadKeyboardShortcuts();
  const persisted = JSON.parse(globalThis.localStorage.getItem(KEYS.KEYBOARD_SHORTCUTS));

  assert.deepEqual(loaded.toggleDiagram, shiftShortcut('KeyG', 'g'));
  assert.deepEqual(persisted.toggleDiagram, { ctrl: true, shift: true, key: 'g', code: 'KeyG' });
  assert.equal(persisted.tabDiagram, undefined);
});

test('loadKeyboardShortcuts migrates both customized legacy panel shortcuts', () => {
  globalThis.localStorage.setItem(KEYS.KEYBOARD_SHORTCUTS, JSON.stringify({
    tabEdit: { ctrl: true, shift: true, key: 'k', code: 'KeyK' },
    tabDiagram: { ctrl: true, shift: true, key: 'd', code: 'KeyD' },
  }));

  const loaded = loadKeyboardShortcuts();

  assert.deepEqual(loaded.toggleSettings, shiftShortcut('KeyK', 'k'));
  assert.deepEqual(loaded.toggleDiagram, shiftShortcut('KeyD', 'd'));
});

test('loadKeyboardShortcuts does not introduce a hidden conflict with tabOptions', () => {
  globalThis.localStorage.setItem(KEYS.KEYBOARD_SHORTCUTS, JSON.stringify({
    tabDiagram: { ctrl: true, key: 'p', code: 'KeyP' },
    tabOptions: { ctrl: true, key: 'p', code: 'KeyP' },
  }));

  const loaded = loadKeyboardShortcuts();

  assert.deepEqual(loaded.tabOptions, shortcut('KeyP', 'p'));
  assert.deepEqual(loaded.toggleDiagram, shortcut('Digit3', '3'));
});

test('loadKeyboardShortcuts migration is idempotent', () => {
  globalThis.localStorage.setItem(KEYS.KEYBOARD_SHORTCUTS, JSON.stringify({
    tabEdit: { ctrl: true, shift: true, key: 'k', code: 'KeyK' },
    tabDiagram: { ctrl: true, shift: true, key: 'd', code: 'KeyD' },
    tabOptions: { ctrl: true, key: '3', code: 'Digit3' },
  }));

  const first = loadKeyboardShortcuts();
  const firstPersisted = globalThis.localStorage.getItem(KEYS.KEYBOARD_SHORTCUTS);
  const second = loadKeyboardShortcuts();
  const secondPersisted = globalThis.localStorage.getItem(KEYS.KEYBOARD_SHORTCUTS);

  assert.deepEqual(second, first);
  assert.equal(secondPersisted, firstPersisted);
});

test('loadKeyboardShortcuts falls back safely for partial or invalid stored values', () => {
  globalThis.localStorage.setItem(KEYS.KEYBOARD_SHORTCUTS, JSON.stringify({
    tabEdit: 'invalid',
    toggleDiagram: {},
    saveProject: 42,
  }));

  const loaded = loadKeyboardShortcuts();

  assert.deepEqual(loaded.toggleSettings, shortcut('Digit2', '2'));
  assert.deepEqual(loaded.toggleDiagram, shortcut('Digit3', '3'));
  assert.deepEqual(loaded.saveProject, shortcut('KeyS', 's'));
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

test('findShortcutAction still recognizes the default Numpad panel aliases', () => {
  const loaded = loadKeyboardShortcuts();
  const event = (code, key) => ({
    ctrlKey: true,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    code,
    key,
  });

  assert.equal(findShortcutAction(event('Numpad1', '1'), loaded, 'general'), 'toggleTree');
  assert.equal(findShortcutAction(event('Numpad2', '2'), loaded, 'general'), 'toggleSettings');
  assert.equal(findShortcutAction(event('Numpad3', '3'), loaded, 'general'), 'toggleDiagram');
});
