import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register, registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'rolldown/experimental';
import { runner } from './reactHookDriver.mjs';

register('./nodeSourceResolver.mjs', import.meta.url);
const doubles = new Map([
  ['react/jsx-runtime', 'export function jsx(type, props, key) { return { type, props, key }; } export const jsxs = jsx;'],
  ['../common/Button', 'export function Button() { return null; }'],
  ['../../hooks/useEscapeKey', 'export function useEscapeKey() {}'],
]);
registerHooks({
  resolve(specifier, context, next) {
    if (doubles.has(specifier)) {
      return { url: `data:text/javascript,${encodeURIComponent(doubles.get(specifier))}`, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
    if (url.endsWith('.jsx')) {
      const path = fileURLToPath(url);
      return {
        format: 'module', shortCircuit: true,
        source: transformSync(path, readFileSync(path, 'utf8'), { jsx: { runtime: 'automatic' } }).code,
      };
    }
    return next(url, context);
  },
});
const { KeyboardShortcutsModal } = await import('../src/components/StorySettingsModal/KeyboardShortcutsModal.jsx');
const { useAppShortcuts } = await import('../src/hooks/useAppShortcuts.js');
const { DEFAULT_SHORTCUTS, findShortcutAction } = await import('../src/store/keyboardShortcuts.js');

function elements(node) {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== 'object' || !node.props) return [];
  return [node, ...elements(node.props.children)];
}

function pressM() {
  return {
    key: 'm', code: 'KeyM', ctrlKey: true,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() {},
    stopImmediatePropagation() { this.immediateStopped = true; },
  };
}

test('la modale garde la capture ouverte et annonce Options du pack pour Ctrl+M', (t) => {
  let shortcuts = DEFAULT_SHORTCUTS;
  const changes = [];
  const modal = runner(() => KeyboardShortcutsModal({
    shortcuts, onChange: (next) => { changes.push(next); }, onClose() {},
  }));
  t.after(() => modal.unmount());
  const capture = () => elements(modal.render()).find((element) => element.key === 'selectionCopy').props.children[1];
  capture().props.onClick();
  const event = pressM();
  capture().props.onKeyDown(event);
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(changes, []);
  assert.match(capture().props.className, /is-capturing/);
  const message = elements(modal.render()).find((element) => element.props.className === 'keyboard-shortcuts-message');
  assert.match(message.props.children, /Options du pack.*Général/);

  shortcuts = { ...shortcuts, storySettings: { ctrl: true, shift: true, key: 'k', code: 'KeyK' } };
  capture().props.onKeyDown(pressM());
  assert.equal(changes.length, 1);
  assert.equal(changes[0].selectionCopy.key, 'm');
  assert.doesNotMatch(capture().props.className, /is-capturing/);
});

test('dispatch global puis sélection : un alias actif prend la frappe, un alias libéré laisse copier', (t) => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  let listener;
  globalThis.window = {
    addEventListener(type, handler) { assert.equal(type, 'keydown'); listener = handler; },
    removeEventListener() { listener = null; },
  };
  globalThis.document = { querySelector: () => null };
  const calls = [];
  const shortcuts = { current: { ...DEFAULT_SHORTCUTS, selectionCopy: { ctrl: true, key: 'm', code: 'KeyM' } } };
  const hook = runner(() => useAppShortcuts({
    keyboardShortcutsRef: shortcuts,
    actionsRef: { current: { canOpenPackOptions: true, openPackOptions: () => calls.push('pack') } },
    saveHandlerRef: { current: null }, saveAsHandlerRef: { current: null },
  }));
  t.after(() => {
    hook.unmount(); globalThis.window = previousWindow; globalThis.document = previousDocument;
  });
  hook.render();
  hook.flush();
  function dispatch() {
    const event = pressM();
    listener(event);
    if (!event.immediateStopped && findShortcutAction(event, shortcuts.current, 'selection') === 'selectionCopy') {
      calls.push('copy');
    }
  }
  dispatch();
  assert.deepEqual(calls, ['pack']);
  shortcuts.current = {
    ...shortcuts.current, storySettings: { ctrl: true, shift: true, key: 'k', code: 'KeyK' },
  };
  dispatch();
  assert.deepEqual(calls, ['pack', 'copy']);
});
