import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { runner } from './reactHookDriver.mjs';

register('./nodeSourceResolver.mjs', import.meta.url);
const { useAppShortcuts } = await import('../src/hooks/useAppShortcuts.js');
const { useCatalogueShortcuts } = await import('../src/hooks/useCatalogueShortcuts.js');
const { DEFAULT_SHORTCUTS, setCurrentShortcuts, getCurrentShortcuts } = await import('../src/store/keyboardShortcuts.js');
const { focusCatalogueSearch } = await import('../src/store/catalogue/searchFocus.js');

function setup(t, { reverse = false, active = true, treeVisible = false, modal = false, blocked = false, shortcuts = DEFAULT_SHORTCUTS, mac = false } = {}) {
  const previous = { window: globalThis.window, document: globalThis.document, navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'), shortcuts: getCurrentShortcuts() };
  const listeners = [];
  const search = { tagName: 'INPUT', isConnected: true, closest: () => null, focus() { document.activeElement = this; } };
  let searches = 0; let treeSearches = 0; const calls = [];
  globalThis.window = {
    addEventListener(type, fn, capture = false) { listeners.push({ type, fn, capture }); },
    removeEventListener(type, fn) { const index = listeners.findIndex(item => item.type === type && item.fn === fn); if (index >= 0) listeners.splice(index, 1); },
  };
  const catalogueSurface = { dataset: { modalSurface: 'catalogue' } };
  globalThis.document = { querySelector: selector => modal ? {} : active && selector.includes('[data-modal-surface]') ? catalogueSurface : null, activeElement: null };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { platform: mac ? 'MacIntel' : 'Win32' } });
  setCurrentShortcuts(shortcuts);
  const app = runner(() => useAppShortcuts({
    actionsRef: { current: { treeSearchVisible: treeVisible, focusTreeSearch() { treeSearches++; } } },
    keyboardShortcutsRef: { current: shortcuts }, saveHandlerRef: {}, saveAsHandlerRef: {},
  }));
  const catalogue = runner(() => useCatalogueShortcuts({
    blocked: () => blocked, search() { searches++; focusCatalogueSearch(search, fn => fn()); },
    selectAll() { calls.push('all'); }, undo() { calls.push('undo'); }, clear() { calls.push('clear'); return true; },
  }, { active }));
  for (const hook of reverse ? [catalogue, app] : [app, catalogue]) { hook.render(); hook.flush(); }
  t.after(() => {
    app.unmount(); catalogue.unmount();
    globalThis.window = previous.window; globalThis.document = previous.document;
    if (previous.navigator) Object.defineProperty(globalThis, 'navigator', previous.navigator); else delete globalThis.navigator;
    setCurrentShortcuts(previous.shortcuts);
  });
  return {
    search, calls, get searches() { return searches; }, get treeSearches() { return treeSearches; },
    press(key = 'f', target = { tagName: 'BUTTON' }, local = () => {}) {
      document.activeElement = target;
      const event = {
        key, code: key === 'Escape' ? 'Escape' : `Key${key.toUpperCase()}`, ctrlKey: key !== 'Escape' && !mac, metaKey: key !== 'Escape' && mac, target, defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; },
        stopPropagation() { this.stopped = true; },
        stopImmediatePropagation() { this.stopped = true; this.immediateStopped = true; },
      };
      // Window capture -> target -> window bubble, independent of registration order.
      for (const { fn } of listeners.filter(item => item.capture)) { fn(event); if (event.immediateStopped) break; }
      if (!event.stopped) local(event);
      if (!event.stopped) for (const { fn } of listeners.filter(item => !item.capture)) { fn(event); if (event.immediateStopped) break; }
      return event;
    },
  };
}

test('Ctrl+F in catalogue focuses its search through global capture', t => {
  const ui = setup(t);
  assert.equal(ui.press().defaultPrevented, true);
  assert.equal(document.activeElement, ui.search);
  assert.equal(ui.searches, 1);
  assert.equal(ui.treeSearches, 0);
});

test('Ctrl+F, Ctrl+K, Ctrl+A, Ctrl+Z and Escape respond despite the catalogue modal surface', t => {
  const ui = setup(t);
  assert.equal(document.querySelector('[data-modal-surface]').dataset.modalSurface, 'catalogue');
  for (const key of ['f', 'k', 'a', 'z', 'Escape']) assert.equal(ui.press(key).defaultPrevented, true, key);
  assert.equal(ui.searches, 2);
  assert.deepEqual(ui.calls, ['all', 'undo', 'clear']);
});

test('only catalogue search accepts an already prevented event', t => {
  const ui = setup(t);
  for (const key of ['f', 'k', 'a', 'z', 'Escape']) ui.press(key, undefined, event => event.preventDefault());
  assert.equal(ui.searches, 2);
  assert.deepEqual(ui.calls, []);
});

for (const reverse of [false, true]) {
  for (const mac of [false, true]) {
    test(`catalogue search and alias work from fields (reverse=${reverse}, mac=${mac})`, t => {
      const ui = setup(t, { reverse, mac });
      const targets = [ui.search, { tagName: 'INPUT' }, { tagName: 'TEXTAREA' }, { isContentEditable: true }];
      for (const target of targets) for (const key of ['f', 'k']) {
        assert.equal(ui.press(key, target).defaultPrevented, true);
        assert.equal(document.activeElement, ui.search);
      }
      assert.equal(ui.searches, 8);
      assert.equal(ui.treeSearches, 0);
    });
  }
}

for (const mac of [false, true]) {
  for (const context of [
    { name: 'catalogue', active: true },
    { name: 'visible editor', active: false, treeVisible: true },
    { name: 'hidden editor', active: false },
    { name: 'blocked catalogue', active: true, blocked: true },
  ]) {
    test(`native F/G stay blocked in ${context.name} (mac=${mac})`, t => {
      const ui = setup(t, { ...context, mac });
      for (const key of ['f', 'g']) assert.equal(ui.press(key).defaultPrevented, true);
      assert.equal(ui.searches, context.name === 'catalogue' ? 1 : 0);
      assert.equal(ui.treeSearches, context.treeVisible ? 1 : 0);
    });
  }
  test(`modal receives F/G without global searches (mac=${mac})`, t => {
    const ui = setup(t, { modal: true, blocked: true, treeVisible: true, mac });
    const received = [];
    // Even when focus has not yet moved inside the modal, no global search runs.
    for (const key of ['f', 'g', 'k']) {
      const event = ui.press(key, undefined, event => received.push(event.key));
      assert.equal(event.defaultPrevented, key !== 'k');
      assert.equal(event.stopped, undefined);
    }
    assert.deepEqual(received, ['f', 'g', 'k']);
    assert.equal(ui.searches, 0); assert.equal(ui.treeSearches, 0);
  });
}

const custom = key => ({ ctrl: true, key, code: `Key${key.toUpperCase()}` });
test('custom catalogue search releases F and its K alias and accepts G despite native prevention', t => {
  const ui = setup(t, { shortcuts: { ...DEFAULT_SHORTCUTS, catalogueSearch: custom('g') } });
  assert.equal(ui.press('f').defaultPrevented, true);
  ui.press('k'); assert.equal(ui.searches, 0);
  assert.equal(ui.press('g').defaultPrevented, true);
  assert.equal(document.activeElement, ui.search); assert.equal(ui.searches, 1);
});

test('a hidden customized tree search leaves the catalogue K alias available', t => {
  const ui = setup(t, { shortcuts: { ...DEFAULT_SHORTCUTS, treeSearch: custom('k') } });
  ui.press('k');
  assert.equal(document.activeElement, ui.search);
  assert.equal(ui.searches, 1); assert.equal(ui.treeSearches, 0);
});

test('custom tree search works in the editor and releases F', t => {
  const ui = setup(t, { active: false, treeVisible: true, shortcuts: { ...DEFAULT_SHORTCUTS, treeSearch: custom('k') } });
  assert.equal(ui.press('f').defaultPrevented, true); assert.equal(ui.treeSearches, 0);
  assert.equal(ui.press('k', { tagName: 'INPUT' }).defaultPrevented, true);
  assert.equal(ui.treeSearches, 1); assert.equal(ui.searches, 0);
});

test('hidden customized tree search stays inactive', t => {
  const ui = setup(t, { active: false, shortcuts: { ...DEFAULT_SHORTCUTS, treeSearch: custom('k') } });
  ui.press('f'); ui.press('k');
  assert.equal(ui.treeSearches, 0); assert.equal(ui.searches, 0);
});

for (const role of ['dialog', 'menu']) {
  test(`catalogue ${role} keeps its keys`, t => {
    const ui = setup(t);
    const target = { closest: selector => selector.includes(`[role="${role}"]`) ? {} : null };
    const received = [];
    for (const key of ['f', 'k', 'a', 'z', 'Escape']) {
      const event = ui.press(key, target, event => received.push(event.key));
      assert.equal(event.stopped, undefined);
    }
    assert.deepEqual(received, ['f', 'k', 'a', 'z', 'Escape']);
    assert.equal(ui.searches, 0);
    assert.deepEqual(ui.calls, []);
  });
}
