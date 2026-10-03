import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';

import { KEYS } from '../src/store/persistentSettings.js';
import {
  DEFAULT_SHORTCUTS,
  SHORTCUT_DEFINITIONS,
  findShortcutAction,
  findShortcutConflict,
  formatShortcut,
  loadKeyboardShortcuts,
  scopesOverlap,
  shortcutFromEvent,
} from '../src/store/keyboardShortcuts.js';
import { commandKeyIsMeta } from '../src/utils/platformKeys.js';

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

  // Les bascules de panneaux n'existent que dans le Libre : leur portée est la
  // sienne, et l'aiguillage global la lit avec la portée générale.
  const scopes = ['general', 'libre'];
  assert.equal(findShortcutAction(event('Numpad1', '1'), loaded, scopes), 'toggleTree');
  assert.equal(findShortcutAction(event('Numpad2', '2'), loaded, scopes), 'toggleSettings');
  assert.equal(findShortcutAction(event('Numpad3', '3'), loaded, scopes), 'toggleDiagram');
});

// --- Une commande, une définition --------------------------------------------

const key = (id) => DEFAULT_SHORTCUTS[id];
const plain = (code, keyName, extra = {}) => ({
  ctrl: false, shift: false, alt: false, meta: false, code, key: keyName, ...extra,
});
const press = (keyName, code, extra = {}) => ({
  key: keyName, code, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...extra,
});

test('copier, couper, coller, supprimer : une seule définition pour les trois surfaces', () => {
  const ids = SHORTCUT_DEFINITIONS.map((definition) => definition.id);
  for (const legacy of ['treeCopy', 'treeCut', 'treePaste', 'treeDelete',
    'diagramCopy', 'diagramCut', 'diagramPaste', 'diagramDelete']) {
    assert.equal(ids.includes(legacy), false, `${legacy} a disparu`);
  }
  for (const id of ['selectionCopy', 'selectionCut', 'selectionPaste', 'selectionDelete',
    'selectionDuplicate', 'selectionRename']) {
    assert.equal(SHORTCUT_DEFINITIONS.find((definition) => definition.id === id)?.scope, 'selection', id);
  }
});

test('une personnalisation de l’arbre ou du diagramme devient celle de la commande commune', () => {
  const custom = shortcut('KeyK', 'k');
  localStorage.setItem(KEYS.KEYBOARD_SHORTCUTS, JSON.stringify({
    // L'arbre personnalisé gagne sur le diagramme personnalisé autrement.
    treeCopy: custom,
    diagramCopy: shortcut('KeyJ', 'j'),
    // Un arbre resté au défaut laisse passer la personnalisation du diagramme.
    treeDelete: plain('Delete', 'delete'),
    diagramDelete: plain('KeyD', 'd'),
    // Deux défauts : la commande commune garde le sien.
    treeCut: shortcut('KeyX', 'x'),
    diagramCut: shortcut('KeyX', 'x'),
  }));
  const loaded = loadKeyboardShortcuts();
  assert.deepEqual(loaded.selectionCopy, custom);
  assert.deepEqual(loaded.selectionDelete, plain('KeyD', 'd'));
  assert.deepEqual(loaded.selectionCut, key('selectionCut'));
  const persisted = JSON.parse(localStorage.getItem(KEYS.KEYBOARD_SHORTCUTS));
  for (const legacy of ['treeCopy', 'diagramCopy', 'treeDelete', 'diagramDelete', 'treeCut', 'diagramCut']) {
    assert.equal(legacy in persisted, false, `${legacy} est retiré du stockage`);
  }
  assert.deepEqual(persisted.selectionCopy, custom);
  // Relue, la migration ne change plus rien.
  assert.deepEqual(loadKeyboardShortcuts(), loaded);
});

test('une valeur déjà posée sur la commande commune reste la source de vérité', () => {
  const current = shortcut('KeyL', 'l');
  localStorage.setItem(KEYS.KEYBOARD_SHORTCUTS, JSON.stringify({
    selectionPaste: current,
    treePaste: shortcut('KeyB', 'b'),
  }));
  assert.deepEqual(loadKeyboardShortcuts().selectionPaste, current);
});

test('une personnalisation migrée ne crée pas de conflit caché', () => {
  // Ctrl+Z est Annuler, commande générale active en même temps que la sélection.
  localStorage.setItem(KEYS.KEYBOARD_SHORTCUTS, JSON.stringify({ treeCopy: shortcut('KeyZ', 'z') }));
  assert.deepEqual(loadKeyboardShortcuts().selectionCopy, key('selectionCopy'));
});

test('un conflit se juge entre commandes actives en même temps', () => {
  // Général, Sélection et Éditeur graphe s'entendent : `M` ne peut pas servir
  // la vue d'ensemble et une commande générale.
  assert.equal(scopesOverlap('general', 'graph'), true);
  assert.equal(scopesOverlap('selection', 'graph'), true);
  assert.equal(scopesOverlap('selection', 'libre'), true);
  const conflict = findShortcutConflict(DEFAULT_SHORTCUTS, 'graphToggleOverview', key('undo'));
  assert.equal(conflict?.id, 'undo');
  assert.equal(findShortcutConflict(DEFAULT_SHORTCUTS, 'graphCreateStage', key('selectionCopy'))?.id, 'selectionCopy');
  // Le Libre et le graphe ne sont jamais actifs ensemble, l'éditeur audio non
  // plus : leurs touches se recoupent sans conflit.
  assert.equal(scopesOverlap('libre', 'graph'), false);
  assert.equal(scopesOverlap('audioEditor', 'selection'), false);
  assert.equal(findShortcutConflict(DEFAULT_SHORTCUTS, 'graphArrange', key('toggleTree')), null);
  assert.equal(findShortcutConflict(DEFAULT_SHORTCUTS, 'selectionCut', key('audioCutSelection')), null);
});

test('aucune touche par défaut ne contredit une autre commande active en même temps', () => {
  for (const definition of SHORTCUT_DEFINITIONS.filter((item) => !item.readOnly)) {
    const conflict = findShortcutConflict(DEFAULT_SHORTCUTS, definition.id, DEFAULT_SHORTCUTS[definition.id]);
    assert.equal(conflict, null, `${definition.id} contredit ${conflict?.id}`);
  }
});

for (const ownerId of ['storySettings', 'toggleTree', 'toggleSettings', 'toggleDiagram', 'selectionDelete', 'graphFit']) {
  const owner = SHORTCUT_DEFINITIONS.find((definition) => definition.id === ownerId);
  for (const alias of owner.aliases) {
    test(`la capture refuse l'alias actif de ${ownerId} (${alias.code}) puis l'accepte quand il est inactif`, () => {
      const candidate = shortcutFromEvent(press(alias.key, alias.code, {
        ctrlKey: !!alias.ctrl, shiftKey: !!alias.shift, altKey: !!alias.alt,
      }));
      const conflict = findShortcutConflict(DEFAULT_SHORTCUTS, 'selectionCopy', candidate);
      assert.equal(conflict?.id, ownerId);
      assert.equal(findShortcutAction(press(alias.key, alias.code, {
        ctrlKey: !!alias.ctrl, shiftKey: !!alias.shift,
      }), DEFAULT_SHORTCUTS, owner.scope), ownerId);
      const customized = { ...DEFAULT_SHORTCUTS, [ownerId]: shiftShortcut('KeyK', 'k') };
      assert.equal(findShortcutConflict(customized, 'selectionCopy', candidate), null);
      const accepted = { ...customized, selectionCopy: candidate };
      const event = press(alias.key, alias.code, { ctrlKey: !!alias.ctrl, shiftKey: !!alias.shift });
      assert.equal(findShortcutAction(event, accepted, ['general', 'libre']), null);
      assert.equal(findShortcutAction(event, accepted, 'selection'), 'selectionCopy');
    });
  }
}

test('une lettre se reconnaît au caractère tapé, sur un AZERTY comme ailleurs', () => {
  // AZERTY : la touche de code `KeyW` tape `z`, celle de code `KeyZ` tape `w`.
  assert.equal(findShortcutAction(press('z', 'KeyW', { ctrlKey: true }), DEFAULT_SHORTCUTS, 'general'), 'undo');
  assert.equal(findShortcutAction(press('w', 'KeyZ', { ctrlKey: true }), DEFAULT_SHORTCUTS, 'general'), null);
  // Un alphabet non latin garde sa position : Ctrl+Я sur la touche de Z annule.
  assert.equal(findShortcutAction(press('я', 'KeyZ', { ctrlKey: true }), DEFAULT_SHORTCUTS, 'general'), 'undo');
  // Un chiffre se reconnaît à sa position : sur un AZERTY, la touche 1 tape `&`.
  assert.equal(findShortcutAction(press('&', 'Digit1', { ctrlKey: true }), DEFAULT_SHORTCUTS, 'libre'), 'toggleTree');
});

test('les libellés montrent le caractère tapé et les touches nommées', () => {
  assert.equal(formatShortcut(key('graphZoomIn')), '+');
  assert.equal(formatShortcut(key('graphVisitBack')), 'Alt+←');
  assert.equal(formatShortcut(key('selectionDelete')), 'Suppr');
  // Capturé sur un AZERTY, un `A` reste un `A`, pas la lettre de la position.
  assert.equal(formatShortcut(plain('KeyQ', 'a')), 'A');
  assert.equal(formatShortcut(plain('Equal', '+', { shift: true })), 'Shift++');
});

// --- La touche de commande sous macOS --------------------------------------

function withPlatform(platform, run) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { platform }, configurable: true });
  try {
    run();
  } finally {
    if (previous) Object.defineProperty(globalThis, 'navigator', previous);
    else delete globalThis.navigator;
  }
}

test('sous macOS, Cmd est la touche de commande ; ailleurs, c’est Ctrl', () => {
  assert.equal(commandKeyIsMeta({ platform: 'MacIntel' }), true);
  assert.equal(commandKeyIsMeta({ platform: 'Win32' }), false);
  assert.equal(commandKeyIsMeta({ platform: 'Linux x86_64' }), false);
  assert.equal(commandKeyIsMeta({ userAgentData: { platform: 'macOS' } }), true);

  withPlatform('MacIntel', () => {
    assert.equal(findShortcutAction(press('s', 'KeyS', { metaKey: true }), DEFAULT_SHORTCUTS, 'general'), 'saveProject');
    assert.equal(findShortcutAction(press('c', 'KeyC', { metaKey: true }), DEFAULT_SHORTCUTS, 'selection'), 'selectionCopy');
    assert.equal(formatShortcut(key('undo')), '⌘+Z');
    // Capturé sur Mac, Cmd+K devient la commande partagée, pas une touche Meta.
    assert.deepEqual(
      shortcutFromEvent(press('k', 'KeyK', { metaKey: true })),
      { ctrl: true, shift: false, alt: false, meta: false, code: 'KeyK', key: 'k' },
    );
  });
  withPlatform('Win32', () => {
    // Sous Windows, la touche Windows n'est pas la commande.
    assert.equal(findShortcutAction(press('s', 'KeyS', { metaKey: true }), DEFAULT_SHORTCUTS, 'general'), null);
    assert.equal(findShortcutAction(press('s', 'KeyS', { ctrlKey: true }), DEFAULT_SHORTCUTS, 'general'), 'saveProject');
    assert.equal(formatShortcut(key('undo')), 'Ctrl+Z');
  });
});
