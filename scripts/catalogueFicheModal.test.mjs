import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'rolldown/experimental';
import { runner } from './reactHookDriver.mjs';
import './tauriDiskHarness.mjs';
import { card } from './catalogueFixtures.mjs';
import { ficheModalAfterRemoval, ficheModalKeyStep, ficheModalPosition, escapeStep, modalEscapeStep } from '../src/store/catalogue/ficheModal.js';
import { catalogueCardActivation } from '../src/store/catalogue/cardActivation.js';
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'react') return { url: 'data:text/javascript,' + encodeURIComponent(`export { default } from '${new URL('../node_modules/react/index.js', import.meta.url).href}'; export * from '${new URL('../node_modules/react/index.js', import.meta.url).href}'; export { useState, useReducer, useRef, useId, useCallback, useMemo, useEffect, useLayoutEffect } from '${new URL('./reactHookDriver.mjs', import.meta.url).href}';`), shortCircuit: true };
  return next(specifier, context);
}, load(url, context, next) {
  if (url.startsWith('data:text/javascript,')) return { format: 'module', source: decodeURIComponent(url.slice('data:text/javascript,'.length)), shortCircuit: true };
  if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
  if (url.endsWith('.jsx')) return { format: 'module', source: `import * as InteractionReact from '${new URL('../node_modules/react/index.js', import.meta.url).href}';\n` + transformSync(fileURLToPath(url), readFileSync(fileURLToPath(url), 'utf8'), { jsx: { runtime: 'classic', pragma: 'InteractionReact.createElement', pragmaFrag: 'InteractionReact.Fragment' } }).code, shortCircuit: true };
  return next(url, context);
} });
const { FicheModal } = await import('../src/components/Catalogue/fiche/FicheModal.jsx');
const { useCatalogueShortcuts } = await import('../src/hooks/useCatalogueShortcuts.js');
const { useCatalogueSelection } = await import('../src/hooks/useCatalogueSelection.js');

const elements = node => !node || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(elements) : [node, ...elements(node.props?.children)];

test('modal position follows the filtered and sorted order and ends without wrapping', () => {
  const order = ['c', 'a', 'b']; // résultats filtrés puis triés : l'ordre de la grille, pas celui du catalogue
  assert.deepEqual(ficheModalPosition(order, 'c'), { index: 1, total: 3, previous: null, next: 'a' });
  assert.deepEqual(ficheModalPosition(order, 'a'), { index: 2, total: 3, previous: 'c', next: 'b' });
  assert.deepEqual(ficheModalPosition(order, 'b'), { index: 3, total: 3, previous: 'a', next: null });
  assert.deepEqual(ficheModalPosition(order, 'hidden'), { index: null, total: 3, previous: null, next: null }, 'a fiche filtered out has no neighbour');
});

test('modal arrows are ignored with modifiers and in text fields', () => {
  const key = (value, extra = {}) => ficheModalKeyStep({ key: value, target: { tagName: 'BUTTON' }, ...extra });
  assert.equal(key('ArrowLeft'), -1); assert.equal(key('ArrowRight'), 1); assert.equal(key('Enter'), 0);
  for (const target of [{ tagName: 'INPUT' }, { tagName: 'TEXTAREA' }, { tagName: 'SELECT' }, { isContentEditable: true }]) assert.equal(ficheModalKeyStep({ key: 'ArrowRight', target }), 0);
  for (const extra of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }, { defaultPrevented: true }]) assert.equal(key('ArrowRight', extra), 0);
});

test('Escape cascades: secondary dialog or edit, then the modal, then selection and panel', () => {
  assert.equal(modalEscapeStep({ busy: false, editing: true }), 'closeEdit');
  assert.equal(modalEscapeStep({ busy: false, editing: false }), 'close');
  assert.equal(modalEscapeStep({ busy: true, editing: false }), 'ignore', 'a running file operation is never abandoned');
  assert.equal(escapeStep({ selectionCount: 2, panelOpen: true }), 'clearSelection', 'several selected: the first Escape clears the selection');
  assert.equal(escapeStep({ selectionCount: 1, panelOpen: true }), 'clearSelectionAndClosePanel', 'one selected: a single Escape clears it and closes the panel');
  assert.equal(escapeStep({ selectionCount: 1, panelOpen: false }), 'clearSelection');
  assert.equal(escapeStep({ selectionCount: 0, panelOpen: true }), 'closePanel');
  assert.equal(escapeStep({ selectionCount: 0, panelOpen: false }), null);
});

test('a removed fiche gives way to its next neighbour, else its previous one', () => {
  assert.equal(ficheModalAfterRemoval(['a', 'c'], ['a', 'b', 'c'], 'b', false), 'c');
  assert.equal(ficheModalAfterRemoval(['a', 'b'], ['a', 'b', 'c'], 'c', false), 'b');
  assert.equal(ficheModalAfterRemoval([], ['a'], 'a', false), null);
  assert.equal(ficheModalAfterRemoval(['a', 'b'], ['a', 'b'], 'b', true), 'b');
});

test('Ctrl+A selects every filtered result outside text fields and leaves fields alone', () => {
  const previous = globalThis.window; let listener; const calls = []; const noop = () => {};
  globalThis.window = { addEventListener: (_, fn) => { listener = fn; }, removeEventListener: noop };
  const ui = runner(() => useCatalogueShortcuts({ blocked: () => false, undo: noop, search: noop, selectAll: () => calls.push('all'), clear: () => false }));
  const press = target => { let prevented = false; listener({ key: 'a', code: 'KeyA', ctrlKey: true, target, preventDefault() { prevented = true; } }); return prevented; };
  try {
    ui.render(); ui.flush();
    assert.equal(press({ tagName: 'DIV' }), true);
    for (const target of [{ tagName: 'INPUT' }, { tagName: 'TEXTAREA' }, { isContentEditable: true }]) assert.equal(press(target), false);
    assert.deepEqual(calls, ['all']);
  } finally { ui.unmount(); globalThis.window = previous; }
});

test('selectAll targets the filtered order only', () => {
  const order = ['b', 'a']; let selection;
  const app = runner(() => { selection = useCatalogueSelection(order, ['a', 'b', 'hidden'].map(id => card({ id }))); });
  try { app.render(); selection.selectAll(); app.render(); assert.deepEqual([...selection.ids].sort(), ['a', 'b']); } finally { app.unmount(); }
});

test('Enter and double click open the modal through the draft guard, never the simulation', async () => {
  const cards = ['a', 'b'].map(id => card({ id })); const order = ['a', 'b'];
  const opened = [], launches = []; const abandon = { current: null }; let selection, events;
  const app = runner(() => {
    selection = useCatalogueSelection(order, cards);
    events = catalogueCardActivation({ selection, order, cardsById: new Map(cards.map(c => [c.id, c])), openFiche() {}, abandon, simulate: request => launches.push(request), openModal: id => opened.push(id), revision: 1 });
  });
  try {
    app.render();
    await events.onOpenModal('a');
    abandon.current = async () => false; await events.onOpenModal('b');
    assert.deepEqual(opened, ['a']); assert.equal(launches.length, 0);
  } finally { app.unmount(); }
});

test('modal exposes dialog semantics, a labelled title, bounds-aware arrows and a close button', () => {
  const c = card({ id: 'b', title: 'Lune', exemplars: [{ id: 'one' }] });
  const render = position => { const app = runner(() => FicheModal({ card: c, position, onStep() {}, onClose() {}, onEdit() {}, onSimulate() {} })); try { return elements(app.render()); } finally { app.unmount(); } };
  const middle = render({ index: 2, total: 3, previous: 'a', next: 'c' });
  const dialog = middle.find(e => e.props?.role === 'dialog');
  assert.equal(dialog.props['aria-modal'], 'true');
  const title = middle.find(e => e.props?.id === dialog.props['aria-labelledby']);
  assert.equal(title.type, 'h2'); assert.equal(title.props.tabIndex, -1);
  const labels = els => els.map(e => e.props?.['aria-label']).filter(Boolean);
  assert.ok(labels(middle).includes('Fermer (Échap)'));
  assert.ok(labels(middle).includes('Fiche précédente') && labels(middle).includes('Fiche suivante'));
  assert.ok(!labels(render({ index: 1, total: 3, previous: null, next: 'b' })).includes('Fiche précédente'));
  assert.ok(!labels(render({ index: 3, total: 3, previous: 'b', next: null })).includes('Fiche suivante'));
  assert.ok(middle.some(e => typeof e.props?.children === 'string' && e.props.children === '2 / 3'));
});
