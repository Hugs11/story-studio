import { ficheDraftChanges } from '../src/store/catalogue/ficheEditing.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'rolldown/experimental';
import { runner } from './reactHookDriver.mjs';
import './tauriDiskHarness.mjs';
import { catalogueCardActivation } from '../src/store/catalogue/cardActivation.js';

import { choiceItems, choiceReducer, CLOSED_CHOICE, choiceKeyAction } from '../src/store/catalogue/exemplarChoice.js';
import { simulationAvailability } from '../src/store/catalogue/simulationAvailability.js';
import { card } from './catalogueFixtures.mjs';
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'react') return { url: 'data:text/javascript,' + encodeURIComponent(`export { default } from '${new URL('../node_modules/react/index.js', import.meta.url).href}'; export * from '${new URL('../node_modules/react/index.js', import.meta.url).href}'; export { useContext, useState, useReducer, useRef, useId, useCallback, useMemo, useEffect, useLayoutEffect } from '${new URL('./reactHookDriver.mjs', import.meta.url).href}';`), shortCircuit: true };
  return next(specifier, context);
}, load(url, context, next) {
  if (url.startsWith('data:text/javascript,')) return { format: 'module', source: decodeURIComponent(url.slice('data:text/javascript,'.length)), shortCircuit: true };
  if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
  if (url.endsWith('.jsx')) return { format: 'module', source: `import * as InteractionReact from '${new URL('../node_modules/react/index.js', import.meta.url).href}';\n` + transformSync(fileURLToPath(url), readFileSync(fileURLToPath(url), 'utf8'), { jsx: { runtime: 'classic', pragma: 'InteractionReact.createElement', pragmaFrag: 'InteractionReact.Fragment' } }).code, shortCircuit: true };
  return next(url, context);
} });
const { useCatalogueSelection } = await import('../src/hooks/useCatalogueSelection.js');
const { FicheDialog, FicheSelectionSummary, FichePanel, FicheExemplars, FICHE_WIDTH } = await import('../src/components/Catalogue/fiche/FicheDialog.jsx');
const { FavoriteStar } = await import('../src/components/Catalogue/FavoriteStar.jsx');
const { SelectionAction, SelectionPanelActions } = await import('../src/components/Catalogue/fiche/SelectionPanel.jsx');
const { ExemplarOpenAction, ExemplarOpenActions } = await import('../src/components/Catalogue/fiche/ExemplarOpenActions.jsx');
const { KEYS, read, write } = await import('../src/store/persistentSettings.js');
const { useCatalogueFicheWidth, ficheWidthBounds } = await import('../src/hooks/useCatalogueFicheWidth.js');
const { PanelResizeHandle } = await import('../src/components/structure/PanelResizeHandle.jsx');
const elements = node => !node || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(elements) : [node, ...elements(node.props?.children), ...(['FicheExemplarRow', 'FicheOverview'].includes(node.type?.name) ? (() => { const row = runner(() => node.type(node.props)); try { return elements(row.render()); } finally { row.unmount(); } })() : [])];
const textContent = node => typeof node === 'string' ? node : Array.isArray(node) ? node.map(textContent).join('') : node && typeof node === 'object' ? textContent(node.props?.children) : '';
const find = (tree, predicate) => { const found = elements(tree).find(predicate); assert.ok(found); return found; };

test('compact fiche keeps all supplied metadata visible for rich packs and projects', () => {
  for (const format of ['zip', 'project']) {
    const c = { ...card({ title: 'Un titre très long pour vérifier une fiche riche', exemplars: [{ id: 'a', format }, { id: 'b', format }] }), language: 'fr', author: 'Auteur renseigné', producer: 'Producteur renseigné', bonus: 'Bonus renseigné', age: { min: 5 }, uuids: ['visible-uuid'] };
    const app = runner(() => FichePanel({ card: c, onEditField() {}, onEdit() {}, onSimulate() {} }));
    try {
      const tree = app.render();
      const values = elements(tree).filter(e => e.type === 'dd');
      // La langue est affichée par son nom, jamais par son code.
      for (const value of ['Français', 'Auteur renseigné', 'Producteur renseigné', 'Bonus renseigné']) assert.ok(values.some(e => textContent(e) === value));
      assert.ok(elements(tree).some(e => e.type?.name === 'CopyUuid' && e.props.uuids[0] === 'visible-uuid'));
      assert.equal(find(tree, e => e.props?.id === 'catalogue-fiche-simulate').props.variant, 'primary-violet');
      assert.ok(!elements(tree).filter(e => e.type === 'details').some(e => elements(e).some(child => child.type === 'dd')));
    } finally { app.unmount(); }
  }
});

test('version shortcuts use the selected row for every format, never the reference or a chooser', async () => {
  for (const format of ['project', 'zip', 'sevenZip', 'folder']) {
    const c = card({ exemplars: [{ id: 'reference', format }, { id: 'target', format }] });
    c.referenceExemplarId = 'reference';
    const calls = [];
    const props = { card: c, exemplar: c.exemplars[1], onEdit: (command, trigger) => calls.push({ kind: 'edit', command, trigger }), onSimulate: (command, trigger) => calls.push({ kind: 'simulate', command, trigger }) };
    const app = runner(() => ExemplarOpenActions(props));
    try {
      const shortcuts = elements(app.render()).filter(e => e.type === ExemplarOpenAction);
      assert.deepEqual(shortcuts.map(e => e.props.id), ['catalogue-fiche-copy-target-simulate', 'catalogue-fiche-copy-target-edit']);
      for (const shortcut of shortcuts) {
        assert.equal(shortcut.props.command.enabled, true);
        assert.equal(shortcut.props.command.exemplarId, 'target');
        assert.ok(!shortcut.props.command.choice);
        const buttonApp = runner(() => ExemplarOpenAction(shortcut.props));
        try {
          const button = find(buttonApp.render(), e => e.props?.id === shortcut.props.id);
          const trigger = { id: shortcut.props.id };
          await button.props.onClick({ detail: 1, currentTarget: trigger, stopPropagation() {} });
          assert.equal(calls.at(-1).trigger, trigger);
          assert.equal(calls.at(-1).command.exemplarId, 'target');
        } finally { buttonApp.unmount(); }
      }
      assert.deepEqual(calls.map(call => call.kind), ['simulate', 'edit']);
    } finally { app.unmount(); }
  }
});

test('version shortcuts explain unavailable targets and never call the guard or launch', async () => {
  for (const state of ['missing', 'unavailable', 'corruptArchive', 'invalidStructure', 'unsupportedFormat']) {
    const c = card({ exemplars: [{ id: 'blocked', format: 'zip', state, available: false }] });
    let attempts = 0;
    const app = runner(() => ExemplarOpenActions({ card: c, exemplar: c.exemplars[0], beforeAction: () => { attempts++; return true; }, onEdit: () => attempts++, onSimulate: () => attempts++ }));
    try {
      for (const shortcut of elements(app.render()).filter(e => e.type === ExemplarOpenAction)) {
        assert.equal(shortcut.props.command.enabled, false);
        const buttonApp = runner(() => ExemplarOpenAction(shortcut.props));
        try {
          const tree = buttonApp.render(); const button = find(tree, e => e.props?.id === shortcut.props.id);
          assert.equal(button.props['aria-disabled'], true);
          const reason = find(tree, e => e.props?.id === button.props['aria-describedby']);
          assert.ok(reason.props.children); assert.doesNotMatch(reason.props.children, /catalogue:/);
          await button.props.onClick({ detail: 1, stopPropagation() {} });
        } finally { buttonApp.unmount(); }
      }
      assert.equal(attempts, 0);
    } finally { app.unmount(); }
  }
});

test('version shortcut guards drafts, preserves the exact return-focus trigger after await and blocks double launch', async () => {
  let finish; const calls = []; let checks = 0;
  const command = { id: 'simulate', enabled: true, exemplarId: 'second' };
  const props = { id: 'shortcut', command, label: 'Simuler cette version', Icon: () => null,
    beforeAction: () => { checks++; return new Promise(resolve => { finish = resolve; }); }, onOpen: (command, trigger) => calls.push({ command, trigger }) };
  const app = runner(() => ExemplarOpenAction(props));
  try {
    const trigger = { id: 'shortcut' }; let button = find(app.render(), e => e.props?.id === 'shortcut');
    const event = { detail: 1, currentTarget: trigger, stopPropagation() {} };
    const pending = button.props.onClick(event); event.currentTarget = null;
    await button.props.onClick({ detail: 1, currentTarget: trigger, stopPropagation() {} });
    assert.equal(checks, 1); assert.equal(calls.length, 0);
    finish(false); await pending; assert.equal(calls.length, 0, 'refusing to abandon the draft cancels the shortcut');
    props.beforeAction = async () => true; button = find(app.render(), e => e.props?.id === 'shortcut');
    const accepted = { detail: 1, currentTarget: trigger, stopPropagation() {} };
    const launched = button.props.onClick(accepted); accepted.currentTarget = null; await launched;
    assert.deepEqual(calls, [{ command, trigger }]);
    await button.props.onClick({ detail: 2, currentTarget: trigger, stopPropagation() {} }); assert.equal(calls.length, 1);
    props.busy = true; button = find(app.render(), e => e.props?.id === 'shortcut');
    await button.props.onClick({ detail: 1, currentTarget: trigger, stopPropagation() {} }); assert.equal(calls.length, 1);
  } finally { app.unmount(); }
});

test('fiche passes version actions and the inline draft guard to its exemplar rows', () => {
  const c = card({ id: 'fiche', exemplars: [{ id: 'one' }, { id: 'two' }] });
  const onEdit = () => {}; const onSimulate = () => {}; const beforeAction = () => true;
  const app = runner(() => FichePanel({ card: c, onEdit, onSimulate, beforeAction }));
  try {
    const list = find(app.render(), e => e.type === FicheExemplars);
    assert.equal(list.props.onEdit, onEdit); assert.equal(list.props.onSimulate, onSimulate); assert.equal(list.props.beforeAction, beforeAction);
    const rows = runner(() => FicheExemplars(list.props));
    try {
      const shortcuts = elements(rows.render()).filter(e => e.type === ExemplarOpenActions);
      assert.deepEqual(shortcuts.map(e => e.props.exemplar.id), ['one', 'two']);
      shortcuts.forEach(shortcut => { assert.equal(shortcut.props.onEdit, onEdit); assert.equal(shortcut.props.onSimulate, onSimulate); assert.equal(shortcut.props.beforeAction, beforeAction); });
    } finally { rows.unmount(); }
  } finally { app.unmount(); }
});

test('click opens inspector, Ctrl/Shift selects multiple; closing stays closed; double click and Enter open the large fiche without simulating', async () => {
  const cards = ['a', 'b', 'c'].map(id => card({ id })); const order = cards.map(c => c.id);
  let fiche = null, selection, events; const launches = [], modals = []; const abandon = { current: null };
  const app = runner(() => {
    selection = useCatalogueSelection(order, cards);
    events = catalogueCardActivation({ selection, order, cardsById: new Map(cards.map(c => [c.id,c])), openFiche: id => { fiche = id; }, abandon, simulate: request => launches.push(request), openModal: id => modals.push(id), revision: 7 });
  });
  try {
    app.render(); await events.onItemClick({ detail: 1 }, 'a'); app.render();
    assert.deepEqual(selection.ids, ['a']); assert.equal(fiche, 'a');
    await events.onItemClick({ detail: 1, ctrlKey: true }, 'b'); app.render();
    assert.deepEqual(selection.ids, ['a', 'b']); assert.equal(fiche, 'b');
    fiche = null; app.render(); assert.equal(fiche, null, 'selection rerender never reopens a closed inspector');
    await events.onItemClick({ detail: 1, shiftKey: true }, 'c'); app.render();
    assert.ok(selection.ids.includes('b') && selection.ids.includes('c')); assert.equal(fiche, 'c');
    await events.onItemClick({ detail: 1 }, 'a'); app.render();
    await events.onItemClick({ detail: 2 }, 'a'); await events.onOpenModal('a'); app.render();
    assert.deepEqual(selection.ids, ['a']); assert.deepEqual(modals, ['a']); assert.equal(launches.length, 0, 'double click never simulates');
    await events.onOpenModal('b'); assert.deepEqual(modals, ['a', 'b'], 'Enter uses the same opening');
    await events.onSimulate('a'); assert.equal(launches.length, 1); assert.equal(launches[0].card.id, 'a'); assert.equal(launches[0].revision, 7);
    abandon.current = async () => false;
    await events.onItemClick({ detail: 1 }, 'b'); assert.equal(fiche, 'a', 'draft guard protects changes');
    await events.onOpenModal('c'); assert.deepEqual(modals, ['a', 'b'], 'draft guard also protects opening the large fiche');
  } finally { app.unmount(); }
});

test('empty results space clears single and multiple selections, closes the inspector and protects drafts', async () => {
  const cards = ['a', 'b'].map(id => card({ id })); const order = cards.map(c => c.id);
  let fiche = null, selection, events; const abandon = { current: null };
  const background = { target: { closest: () => null }, currentTarget: { contains: () => true } };
  const app = runner(() => {
    selection = useCatalogueSelection(order, cards);
    events = catalogueCardActivation({ selection, order, openFiche: id => { fiche = id; }, abandon });
  });
  try {
    app.render();
    for (const multiple of [false, true]) {
      await events.onItemClick({ detail: 1 }, 'a'); app.render();
      if (multiple) { await events.onItemClick({ detail: 1, ctrlKey: true }, 'b'); app.render(); }
      const selected = [...selection.ids]; const opened = fiche;
      for (const selector of ['[data-card-id]', '[data-focus-card-id]', 'thead', 'button', 'a', 'input', 'select', 'textarea', '[role="button"]']) {
        await events.onBackgroundClick({ ...background, target: { closest: query => query.includes(selector) ? {} : null } });
        app.render(); assert.deepEqual(selection.ids, selected); assert.equal(fiche, opened);
      }
      await events.onBackgroundClick({ ...background, currentTarget: { contains: () => false } });
      app.render(); assert.deepEqual(selection.ids, selected, 'portal content is outside the results');
      abandon.current = async () => false;
      await events.onBackgroundClick(background); app.render();
      assert.deepEqual(selection.ids, selected); assert.equal(fiche, opened);
      abandon.current = async () => true;
      await events.onBackgroundClick(background); app.render();
      assert.deepEqual(selection.ids, []); assert.equal(selection.snapshot.anchor, null); assert.equal(fiche, null);
      assert.ok(order.includes(selection.activeId), 'keyboard navigation retains its entry point');
      abandon.current = null;
    }
  } finally { app.unmount(); }
});

test('panel uses shared resize handle, clamps and persists width across remounts; field editing is on demand', async () => {
  const props = { card: card({ id: 'a' }), onClose() {} };
  const app = runner(() => FicheDialog(props));
  let saved;
  try {
    let tree = app.render(); assert.equal(tree.type, 'aside');
    assert.equal(tree.props['aria-modal'], undefined);
    const handle = find(tree, e => e.props?.panelClass === '.catalogue-fiche');
    assert.equal(tree.props.style.maxWidth, `min(100%, ${handle.props.maxWidth}px)`, 'the rendered CSS cap follows the same bounds as the resize handle');
    handle.props.onResize(9999); tree = app.render(); assert.equal(tree.props.style.width, FICHE_WIDTH.max);
    handle.props.onResize(1); tree = app.render(); assert.equal(tree.props.style.width, FICHE_WIDTH.min);
    handle.props.onResize(511); saved = read(KEYS.CATALOGUE_FICHE_WIDTH); assert.equal(saved, '511');
    assert.ok(!elements(tree).some(e => e.props?.label === 'Modifier les informations'));
    const content = find(tree, e => e.type === FichePanel);
    await content.props.onEditField('age', { id: 'catalogue-fiche-pencil-age' }); tree = app.render();
    assert.equal(find(tree, e => e.type === FichePanel).props.editing, 'age');
    assert.ok(find(tree, e => e.type === FichePanel).props.editor, 'only the chosen field receives the editor');
  } finally { app.unmount(); }
  const again = runner(() => FicheDialog(props));
  try { assert.equal(again.render().props.style.width, Number(saved)); } finally { again.unmount(); }
});

test('multiple selection summary exposes bounded covers, duration and non-filtering shared/mixed tag membership', () => {
  const cards = [{ ...card({ id: 'a', durationSeconds: 120 }), tagIds: ['x','y'] }, { ...card({ id: 'b', durationSeconds: 180 }), tagIds: ['x'] }];
  const app = runner(() => FicheSelectionSummary({ cards, tags: [{ id: 'x', label: 'Shared' }, { id: 'y', label: 'Mixed' }], onClose() {}, onTags() {}, onFilterTag() {} }));
  try {
    const tree = app.render(); const all = elements(tree);
    const tagSection = all.find(e => e.type?.name === 'SelectionTags');
    const tagUI = runner(() => tagSection.type(tagSection.props));
    all.push(...elements(tagUI.render())); tagUI.unmount();
    assert.ok(all.some(e => e.type === 'h2' && e.props.children === '2 packs sélectionnés'));
    assert.equal(find(tree, e => e.props?.id === 'catalogue-fiche-title').props.tabIndex, -1, 'toolbar can return focus to the panel heading');
    assert.ok(all.some(e => e.type === 'p' && e.props.children.includes?.('5 min au total')));
    assert.equal(all.filter(e => e.props?.ficheId).length, 2);
    const tags = all.filter(e => e.props?.className?.startsWith('catalogue-selection-tag ')); assert.equal(tags.length, 2);
    assert.equal(tags[1].props.children[1].props.children, '1/2');
    assert.ok(tags.every(e => !e.props.onFilterTag), 'tag actions update membership without filtering');
    assert.ok(!all.some(e => e.props?.onSimulate || e.props?.onEdit));
  } finally { app.unmount(); }
});

test('panel width announces actual bounds, keyboard resize starts at visible width, window resize preserves preference', () => {
  assert.deepEqual(ficheWidthBounds(1000, 1000), { min: 320, max: 640 });
  assert.deepEqual(ficheWidthBounds(280, 800), { min: 280, max: 280 });
  assert.deepEqual(ficheWidthBounds(800, 900), { min: 320, max: 720 });
  const previousWindow = globalThis.window; const previousObserver = globalThis.ResizeObserver;
  const previousRaf = globalThis.requestAnimationFrame; const previousCaf = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = callback => { callback(); return 1; }; globalThis.cancelAnimationFrame = () => {};
  const previousPreference = read(KEYS.CATALOGUE_FICHE_WIDTH);
  const listeners = new Map(); let parentWidth = 1000; let resize; let disconnected = false;
  globalThis.window = { ...previousWindow, innerWidth: 1100, addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) };
  globalThis.ResizeObserver = class { constructor(fn) { resize = fn; } observe() {} disconnect() { disconnected = true; } };
  write(KEYS.CATALOGUE_FICHE_WIDTH, '720');
  const app = runner(() => useCatalogueFicheWidth(true));
  try {
    let width = app.render(); width.panelRef.current = { parentElement: { getBoundingClientRect: () => ({ width: parentWidth }) } };
    app.flush(); width = app.render();
    assert.equal(width.value, 640); assert.equal(width.max, 640);
    assert.equal(read(KEYS.CATALOGUE_FICHE_WIDTH), '720', 'layout constraints do not replace preference');
    parentWidth = 1400; resize(); width = app.render();
    assert.equal(width.value, 720, 'preferred width returns when space allows');
    parentWidth = 1000; resize(); width = app.render();
    const handle = runner(() => PanelResizeHandle({ value: width.value, minWidth: width.min, maxWidth: width.max, direction: -1, onResize: width.onResize }));
    try {
      const separator = handle.render();
      assert.equal(separator.props['aria-valuenow'], 640);
      assert.equal(separator.props['aria-valuemax'], 640);
      separator.props.onKeyDown({ key: 'ArrowRight', preventDefault() {} });
    } finally { handle.unmount(); }
    width = app.render(); assert.equal(width.value, 624, 'first arrow moves the visibly constrained panel');
    assert.equal(read(KEYS.CATALOGUE_FICHE_WIDTH), '624', 'only user gesture updates preference');
    globalThis.window.innerWidth = 800; parentWidth = 280; listeners.get('resize')(); width = app.render();
    assert.equal(width.value, 280); assert.equal(width.min, 280); assert.equal(width.max, 280);
    assert.equal(read(KEYS.CATALOGUE_FICHE_WIDTH), '624');
  } finally {
    app.unmount(); assert.ok(disconnected); assert.equal(listeners.size, 0);
    globalThis.window = previousWindow; globalThis.ResizeObserver = previousObserver;
    globalThis.requestAnimationFrame = previousRaf; globalThis.cancelAnimationFrame = previousCaf;
    write(KEYS.CATALOGUE_FICHE_WIDTH, previousPreference);
  }
});

test('collective actions honor refusal, labels expose scope, and clear selection accompanies close', () => {
  const calls = [];
  for (const enabled of [false, true]) {
    const app = runner(() => SelectionAction({ action: { id: 'assemble', enabled, labelKey: 'catalogue:assembly.title', reasonKey: enabled ? null : 'catalogue:assembly.preparing' }, onAction: id => calls.push(id) }));
    try {
      const tree = app.render();
      const button = find(tree, e => e.props?.onClick);
      button.props.onClick();
      if (!enabled) {
        assert.equal(calls.length, 0);
        assert.equal(button.props['aria-disabled'], true);
        assert.ok(button.props['aria-describedby']);
      }
    } finally { app.unmount(); }
  }
  assert.deepEqual(calls, ['assemble']);
  const cards = [{ id: 'a', favorite: true }, { id: 'b', favorite: false }];
  const props = { cards, actions: [{ id: 'favorite', enabled: true }], onAction: id => calls.push(id), onClose: () => calls.push('close') };
  const app = runner(() => FicheSelectionSummary(props));
  try {
    let tree = app.render();
    let rows = elements(tree).find(e => e.type?.name === 'SelectionPanelActions');
    const rowUI = runner(() => rows.type(rows.props));
    let favorite = find(rowUI.render(), e => e.type === FavoriteStar);
    assert.equal(favorite.props.favorite, false);
    assert.equal(favorite.props.label, 'Ajouter les 2 packs aux favoris');
    find(tree, e => e.props?.['aria-label'] === 'Fermer la fiche').props.onClick();
    assert.equal(elements(tree).some(e => e.props?.children === 'Tout désélectionner'), false);
    assert.deepEqual(calls.slice(-1), ['close']);
    props.cards = cards.map(card => ({ ...card, favorite: true }));
    tree = app.render(); rows = elements(tree).find(e => e.type?.name === 'SelectionPanelActions');
    favorite = find(rowUI.render(), e => e.type === FavoriteStar);
    assert.equal(favorite.props.favorite, true);
    assert.equal(favorite.props.label, 'Retirer les 2 packs des favoris'); rowUI.unmount();
  } finally { app.unmount(); }
});

test('single fiche excludes collective commands and the redundant clear button', () => {
  const actions = ['favorite', 'tags', 'assemble', 'copySelection'].map(id => ({ id, enabled: true }));
  const app = runner(() => FichePanel({ card: card({ id: 'single' }), actions, onSelectionAction() {} }));
  try {
    const tree = app.render();
    assert.equal(find(tree, e => e.props?.id === 'catalogue-fiche-title').props.tabIndex, -1);
    assert.equal(elements(tree).some(e => e.props?.children === 'Tout désélectionner'), false);
    assert.equal(elements(tree).some(e => e.type === SelectionPanelActions), false);
    assert.equal(elements(tree).some(e => e.type === SelectionAction), false);
  } finally { app.unmount(); }
});

test('copy choice starts on reference even when it is not first, then keyboard can select another exact copy', () => {
  const c = card({ exemplars: [{ id: 'first' }, { id: 'reference' }, { id: 'gone', available: false }] });
  const items = choiceItems(c.exemplars, simulationAvailability);
  let choice = choiceReducer(CLOSED_CHOICE, { type: 'open', cardId: c.id, command: 'simulate', referenceExemplarId: 'reference', items });
  assert.equal(items[choice.activeIndex].id, 'reference'); assert.deepEqual(choiceKeyAction('Enter'), { type: 'activate' });
  choice = choiceReducer(choice, choiceKeyAction('ArrowDown')); assert.equal(choice.activeIndex, (items.findIndex(e => e.id === 'reference') + 1) % items.length);
  choice = choiceReducer(choice, { type: 'close' }); assert.equal(choice.open, false);
});

test('Escape closes the inspector and stops listening after it closes', () => {
  const previous = globalThis.window; const listeners = new Map(); let closed = 0; let current = card();
  globalThis.window = { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) };
  const app = runner(() => FicheDialog({ card: current, onClose: () => { closed++; current = null; } }));
  try {
    app.render(); app.flush();
    const event = { key: 'Escape', defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    listeners.get('keydown')(event); assert.equal(closed, 1); assert.equal(event.defaultPrevented, true);
    assert.equal(app.render(), null); app.flush(); assert.equal(listeners.has('keydown'), false);
  } finally { app.unmount(); globalThis.window = previous; }
});

const awaitCompact = await import('../src/components/Catalogue/open/CompactExemplar.jsx');
const { Select } = await import('../src/components/common/Select.jsx');
const { FieldEditor } = await import('../src/components/Catalogue/fiche/FieldEditor.jsx');
const { FicheEditSurface } = await import('../src/components/Catalogue/fiche/FicheEditPanel.jsx');
const { createDraft, draftReducer, draftChanges, validateDraft } = await import('../src/store/catalogue/metadataDraft.js');
const { fieldId } = await import('../src/store/catalogue/cardModel.js');
const { editableFields } = await import('../src/store/catalogue/ficheEditing.js');
const { cardMenuActions, exemplarActions } = await import('../src/store/catalogue/cardActions.js');
const detailFixture = JSON.parse(readFileSync(new URL('./fixtures/catalogue/card-detail.json', import.meta.url)));

test('FICHED edits in place without correction marks; FICHEE typing the source value back is no correction', () => {
  const c = structuredClone(detailFixture);
  let draft = createDraft(c); const id = fieldId({ field: 'title' });
  const f = editableFields(c).find(f => f.id === id);
  const app = runner(() => FieldEditor({ field: f, entry: draft.entries[id], original: draft.original[id], onChange: patch => { draft = draftReducer(draft, { type: 'edit', id, patch }); } }));
  try {
    let tree = app.render();
    const input = find(tree, e => e.type === 'input'); assert.equal(input.props.value, 'Source');
    input.props.onChange({ target: { value: 'Corrected' } }); tree = app.render();
    assert.deepEqual(draftChanges(draft), [{ field: 'title', state: 'defined', value: 'Corrected' }]);
    assert.ok(!elements(tree).some(e => e.props?.children?.includes?.('modifié dans le catalogue')));
    assert.ok(!elements(tree).some(e => e.props?.children === 'rétablir'));
    // FICHEE (29 oct., revue): back to the shown source value, the field stays on its source.
    find(tree, e => e.type === 'input').props.onChange({ target: { value: 'Source' } });
    assert.deepEqual(draftChanges(draft), []);
  } finally { app.unmount(); }
});

test('FICHED edits only ageMin and preserves absent maximum, hidden fields and localized variants', () => {
  const c = structuredClone(detailFixture);
  for (const [field, language] of [['subtitle', ''], ['keywords', ''], ['title', 'en']]) c.fields.push({ field, language, effective: { value: 'Retained', origin: 'reference' }, correction: { state: 'none' } });
  let draft = createDraft(c); const maximum = structuredClone(draft.entries[fieldId({ field: 'ageMax' })]);
  const app = runner(() => FicheEditSurface({ card: c, field: 'age', draft, dispatch: action => { draft = draftReducer(draft, action); } }));
  try {
    const tree = app.render();
    assert.ok(!elements(tree).some(e => e.type === 'fieldset'));
    const ages = elements(tree).filter(e => e.type === FieldEditor); assert.equal(ages.length, 1);
    ages[0].props.onChange({ state: 'defined', value: '18' });
    assert.deepEqual(ficheDraftChanges(draft), [{ field: 'ageMin', state: 'defined', value: 18 }, { field: 'ageMax', state: 'cleared' }]);
    assert.deepEqual(validateDraft(draft, { singleAge: true }), {});
    assert.deepEqual(draft.entries[fieldId({ field: 'ageMax' })], maximum);
    assert.equal(draft.entries[fieldId({ field: 'title', language: 'en' })].state, 'source');
    for (const value of ['19', '-1', '1.5']) {
      ages[0].props.onChange({ state: 'defined', value });
      assert.ok(Object.keys(validateDraft(draft, { singleAge: true })).length);
    }
  } finally { app.unmount(); }
});

test('FICHEC removes FICHEB global modification from fixed card menu; copy actions have explicit order, with no conversion nor copy-path entry', () => {
  for (const count of [1, 3]) {
    const c = card({ exemplars: Array.from({ length: count }, (_, i) => ({ id: String(i), format: 'zip', state: 'available' })) });
    assert.deepEqual(cardMenuActions(c, c.exemplars).map(a => a.id), ['simulate', 'tags', 'favorite', 'reveal', 'edit', 'checkPack', 'copyUuid', 'removeFromCatalogue']);
    assert.deepEqual(exemplarActions(c, c.exemplars[0]).map(a => a.id), ['editPack', 'simulate', 'checkPack', 'trash', 'reveal', 'copyUuid']);
  }
});

test('FICHEB checker keeps the same translated product name as Home', async () => {
  const fr = JSON.parse(readFileSync(new URL('../src/locales/fr/catalogue.json', import.meta.url)));
  assert.equal(fr['diagnostics.checker'], 'Vérifier un pack');
  assert.ok(!Object.values(fr).some(value => value === 'Vérifier pour la Lunii'));
});

test('FICHEB copy rows no longer open any menu by right click or keyboard', () => {
  const c = card({ exemplars: [{ id: 'a' }, { id: 'b' }] }); c.referenceExemplarId = 'a';
  const app = runner(() => FicheExemplars({ card: c }));
  try {
    const tree = app.render(); const rows = elements(tree).filter(e => e.type === 'li'); assert.equal(rows.length, 2);
    for (const row of rows) { assert.equal(row.props.onContextMenu, undefined); assert.equal(row.props.onKeyDown, undefined); }
  } finally { app.unmount(); }
});

test('FICHEMENU the fiche has no overflow button; removal shows only when every file is missing', () => {
  const lines = tree => elements(tree).filter(e => e.type === 'button' || e.props?.id).map(e => e.props?.id);
  const present = { id: 'ok', available: true, tags: [], exemplars: [{ id: 'a', format: 'zip', state: 'available' }] };
  const gone = { id: 'gone', tags: [], available: false, offlineReason: 'missing', exemplars: [{ id: 'a', format: 'zip', state: 'missing', available: false }] };
  const unplugged = { id: 'disk', tags: [], available: false, offlineReason: 'unavailable', exemplars: [{ id: 'a', format: 'zip', state: 'unavailable', available: false }] };
  const removed = [];
  const render = (c, onAction = id => removed.push(id)) => { const app = runner(() => FichePanel({ card: c, onAction, onEditField() {} })); try { return { tree: app.render(), ids: lines(app.render()) }; } finally { app.unmount(); } };
  for (const c of [present, gone, unplugged]) assert.ok(!render(c).ids.includes('catalogue-fiche-menu'));
  assert.ok(!render(present).ids.includes('catalogue-fiche-remove'));
  assert.ok(!render(unplugged).ids.includes('catalogue-fiche-remove'));
  const { tree, ids } = render(gone);
  assert.ok(ids.includes('catalogue-fiche-remove'));
  assert.ok(elements(tree).some(e => e.props?.children === 'Introuvable au dernier emplacement connu.'));
  find(tree, e => e.props?.id === 'catalogue-fiche-remove').props.onClick();
  assert.deepEqual(removed, ['removeFromCatalogue']);
});

test('FICHEMENU a missing file offers no action on its row, an unplugged disk keeps reveal', () => {
  const c = { id: 'mixed', tags: [], exemplars: [{ id: 'a', format: 'zip', state: 'available', path: '/P/a.zip' }, { id: 'b', format: 'zip', state: 'missing', available: false, path: '/P/b.zip' }] };
  const everyGone = { id: 'all', tags: [], available: false, offlineReason: 'missing', exemplars: [{ id: 'a', format: 'zip', state: 'missing', available: false, path: '/P/a.zip' }, { id: 'b', format: 'zip', state: 'missing', available: false, path: '/P/b.zip' }] };
  const ids = (card_) => { const app = runner(() => FicheExemplars({ card: card_ })); try { return elements(app.render()).map(e => e.type?.name === 'ExemplarTrashButton' ? `trash-${e.props.exemplar.id}` : e.props?.id).filter(Boolean); } finally { app.unmount(); } };
  const mixed = ids(c);
  assert.ok(mixed.includes('catalogue-fiche-copy-a-reveal') && mixed.includes('trash-a'));
  assert.ok(!mixed.some(id => id.startsWith('catalogue-fiche-copy-b-') || id === 'trash-b'));
  // Changement voulu : un fichier introuvable n'offre plus 📂, même si toute la fiche l'est (l'avis suffit).
  assert.ok(!ids(everyGone).some(id => /-reveal$|^trash-/.test(id)));
  const unplugged = { id: 'disk', tags: [], available: false, offlineReason: 'unavailable', exemplars: [{ id: 'a', format: 'zip', state: 'unavailable', available: false, path: '/P/a.zip' }] };
  assert.ok(ids(unplugged).includes('catalogue-fiche-copy-a-reveal'));
});

test('file action chooser keeps the reference and exact copy without an all-copies entry', async () => {
  const { FileExemplarChoice } = await import('../src/components/Catalogue/open/FileExemplarChoice.jsx');
  const c = { ...detailFixture, referenceExemplarId: 'b', exemplars: [{ id: 'a' }, { id: 'b' }, { id: 'gone', available: false }] };
  let chosen, closed = 0;
  const app = runner(() => FileExemplarChoice({ card: c, command: 'reveal', availability: e => ({ enabled: e.available !== false }), onChoose: copies => { chosen = copies; }, onClose: () => { closed++; } }));
  try {
    const tree = app.render();
    assert.equal(tree.props.items.length, 3);
    assert.equal(tree.props.items[tree.props.choice.activeIndex].id, 'b');
    tree.props.onChoose(tree.props.items[2]); assert.equal(chosen, undefined);
    tree.props.onChoose(tree.props.items[1]); assert.deepEqual(chosen, [c.exemplars[1]]);
    tree.props.onCancel(); assert.equal(closed, 1);
  } finally { app.unmount(); }
});

test('TRI badges in cards and List select one card, open its fiche and request its copies without a badge menu', async () => {
  const { CatalogueCard } = await import('../src/components/Catalogue/views/CatalogueCard.jsx');
  const { CatalogueRow } = await import('../src/components/Catalogue/views/CatalogueRow.jsx');
  const { CardFormatTags } = await import('../src/components/Catalogue/views/CardFormatTags.jsx');
  const { FormatTag, FormatTagRow } = await import('../src/components/Catalogue/FormatTag.jsx');
  const c = card({ id: 'copies', exemplars: [{ id: 'a' }, { id: 'b' }] });
  const requests = [], launches = [], contexts = [], modals = []; let fiche, selection, activation;
  const abandon = { current: null };
  const app = runner(() => {
    selection = useCatalogueSelection([c.id], [c]);
    activation = catalogueCardActivation({ selection, order: [c.id], cardsById: new Map([[c.id, c]]), openFiche: id => { fiche = id; }, focusExemplars: request => requests.push(request), abandon, simulate: request => launches.push(request), openModal: id => modals.push(id) });
  });
  try {
    app.render();
    for (const Component of [CatalogueCard, CatalogueRow]) {
      const view = { ...activation, selected: new Set(), expanded: new Set(), activeId: c.id, onCardMenu: event => contexts.push(event.key), onItemKeyDown() {} };
      const surface = runner(() => Component({ item: { card: c, exemplars: c.exemplars }, index: 0, view, columns: [{ id: 'formats' }] }));
      try {
        const tree = surface.render();
        const Row = Component === CatalogueCard ? CardFormatTags : FormatTagRow;
        const tags = find(tree, e => e.type === Row);
        const tagRow = runner(() => Row(tags.props));
        const tagElement = find(tagRow.render(), e => e.type === FormatTag && e.props.onActivate); tagRow.unmount();
        const tag = runner(() => FormatTag(tagElement.props));
        try {
          const badge = find(tag.render(), e => e.type === 'button');
          assert.equal(badge.props['aria-haspopup'], undefined); assert.equal(badge.props['aria-expanded'], undefined);
          assert.equal(badge.props.onContextMenu, undefined, 'right click bubbles to the card');
          assert.equal(badge.props.onDoubleClick, undefined, 'double click bubbles to the card');
          let stopped = 0;
          await badge.props.onClick({ detail: 1, stopPropagation() { stopped++; } }); app.render();
          assert.equal(stopped, 1); assert.deepEqual(selection.ids, [c.id]); assert.equal(fiche, c.id);
          assert.deepEqual(requests.at(-1), { id: c.id, format: 'zip' });
          const count = requests.length;
          await badge.props.onClick({ detail: 2, stopPropagation() {} }); assert.equal(requests.length, count);
          const cardElement = find(tree, e => e.props?.['data-card-id'] === c.id); assert.equal(cardElement.props.onDoubleClick, undefined); await cardElement.props.onClick({ detail: 1 }); await cardElement.props.onClick({ detail: 2 }); assert.equal(modals.at(-1), c.id); assert.equal(launches.length, 0, 'double click never simulates');
          badge.props.onKeyDown({ key: 'F10', shiftKey: true, preventDefault() {}, stopPropagation() {} });
          assert.equal(contexts.at(-1), 'F10');
          abandon.current = async () => false;
          await badge.props.onClick({ detail: 1, stopPropagation() {} }); assert.equal(requests.length, count);
          abandon.current = null;
        } finally { tag.unmount(); }
      } finally { surface.unmount(); }
    }
  } finally { app.unmount(); }
});

test('CORB rows hide ineligible trash and preserve exact reveal target and folder identity', () => {
  const c = card({ id: 'copies', exemplars: [{ id: 'a', path: '/Packs/First/a.zip', state: 'available' }, { id: 'b', path: 'C:\\Packs\\Second\\b.zip', state: 'available' }, { id: 'gone', path: '/Packs/Offline/gone.zip', available: false }] });
  const calls = [];
  const app = runner(() => FicheExemplars({ card: c, onAction: (exemplar, action, trigger) => calls.push({ exemplar, action, trigger }) }));
  try {
    const tree = app.render();
    const trash = elements(tree).filter(e => e.type?.name === 'ExemplarTrashButton');
    assert.deepEqual(trash.map(e => e.props.exemplar.id), ['a', 'b']);
    for (const exemplar of c.exemplars) {
      const button = find(tree, e => e.props?.id === `catalogue-fiche-copy-${exemplar.id}-reveal`);
      const trigger = { id: button.props.id };
      button.props.onClick({ stopPropagation() {}, currentTarget: trigger });
      assert.equal(calls.at(-1).exemplar, exemplar); assert.equal(calls.at(-1).action.id, 'reveal'); assert.equal(calls.at(-1).trigger, trigger);
    }
    const { CompactExemplar } = awaitCompact;
    const copies = elements(tree).filter(e => e.type === CompactExemplar).map(e => { const row = runner(() => CompactExemplar(e.props)); try { return row.render(); } finally { row.unmount(); } });
    const folders = copies.flatMap(elements).filter(e => e.props?.className === 'catalogue-fiche-copy-folder');
    assert.deepEqual(folders.map(e => e.props.children).sort(), ['First', 'Offline', 'Second']);
    assert.equal(find(copies, e => e.props?.text === 'C:\\Packs\\Second').props.children.props.children, 'Second');
  } finally { app.unmount(); }
});

test('TRI badge request focuses and scrolls the copy list; a fresh request repeats focus and refreshed count follows the card', () => {
  let c = card({ id: 'copies', exemplars: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] });
  let request = { id: c.id, format: 'zip' }; const events = [];
  const app = runner(() => FicheExemplars({ card: c, request }));
  try {
    let tree = app.render();
    find(tree, e => e.type === 'ul').props.ref.current = { focus: options => events.push(['focus', options]), scrollIntoView: options => events.push(['scroll', options]) };
    app.flush(); tree = app.render();
    assert.deepEqual(events, [['focus', { preventScroll: true }], ['scroll', { block: 'nearest' }]]);
    assert.ok(elements(tree).filter(e => e.type === 'li').every(e => e.props.className.trim() === 'catalogue-fiche-exemplar-row catalogue-fiche-copy--highlight'));
    request = { ...request }; app.render(); app.flush(); assert.equal(events.length, 4);
    c = { ...c, exemplars: c.exemplars.slice(1) }; tree = app.render();
    assert.equal(find(tree, e => e.type === 'h3').props.children[0], 'Exemplaires');
    assert.equal(find(tree, e => e.props?.className === 'catalogue-fiche-copies-count').props.children, 2);
    assert.equal(elements(tree).filter(e => e.type === 'li').length, 2);
  } finally { app.unmount(); }
});

const { descriptionText } = await import('../src/store/catalogue/descriptionText.js');
const { FicheDescription } = await import('../src/components/Catalogue/fiche/FicheDescription.jsx');

test('FICHEC description converts every br spelling and strips other markup without interpreting HTML', () => {
  assert.equal(descriptionText('A<br>B<BR/>C<br />D'), 'A\nB\nC\nD');
  assert.equal(descriptionText('<b>Story</b><img src=x onerror="evil()"><script>evil()</script>'), 'Storyevil()');
  assert.equal(descriptionText(null), '');
  assert.equal(descriptionText('<p>Text</p><unfinished'), 'Text');
  assert.equal(descriptionText('&lt;b&gt;literal&lt;/b&gt;'), '<b>literal</b>');
});

test('FICHEC pack and project share the same fixed empty template, field pencils and one-copy section', async () => {
  const { catalogueDataApi } = await import('../src/store/catalogue/catalogueDataApi.js');
  const original = catalogueDataApi.getCard;
  catalogueDataApi.getCard = async () => ({ fields: [] });
  let expected;
  try {
    for (const format of ['zip', 'project']) {
      const c = { id: 'empty', exemplars: [{ id: 'only', format }], tags: [] };
      const app = runner(() => FichePanel({ card: c, onEditField() {} }));
      try {
        app.render(); app.flush(); await new Promise(resolve => setTimeout(resolve, 0));
        const tree = app.render(); const all = elements(tree);
        const rows = all.filter(e => e.type === 'dt').map(e => e.props.children);
        assert.deepEqual(rows, ['Âge', 'Langue', 'Auteur', 'Producteur', 'Bonus']);
        const values = all.filter(e => e.type === 'dd');
        const text = e => elements(e).flatMap(n => n.props?.children ?? []).filter(v => typeof v === 'string').join(' ');
        assert.match(text(values[0]), /—/); assert.match(text(values[1]), /—/);
        assert.match(text(values[2]), /—/);
        // FICHEE (29 oct.): language, author, producer, bonus and description gain the same pencil.
        const pencils = all.filter(e => e.props?.id?.startsWith('catalogue-fiche-pencil-'));
        assert.deepEqual(pencils.map(e => e.props.id).sort(), ['age', 'author', 'bonus', 'language', 'producer', 'title'].map(field => `catalogue-fiche-pencil-${field}`));
        assert.equal(find(tree, e => e.type === FicheDescription).props.pencil.props.children.props.id, 'catalogue-fiche-pencil-description');
        assert.ok(all.some(e => e.type?.name === 'CoverPencil'));
        assert.equal(textContent(values[3]), '—non renseigné'); assert.equal(textContent(values[4]), '—non renseigné');
        const copies = find(tree, e => e.type === FicheExemplars); assert.equal(copies.props.card.exemplars.length, 1);
        const tagsAction = all.find(e => e.props?.className === 'catalogue-fiche-add-tag');
        assert.ok(tagsAction);
        assert.equal(tagsAction.props.children[1], 'Ajouter');
        assert.equal(tagsAction.props['aria-haspopup'], 'menu');
        assert.ok(!all.some(e => e.props?.className === 'catalogue-fiche-section-action'));
        assert.ok(!all.some(e => ['catalogue-fiche-modify','catalogue-fiche-reveal','catalogue-fiche-location'].includes(e.props?.id)));
        const shape = all.map(e => typeof e.type === 'string' ? e.type : e.type?.name ?? 'component');
        if (expected) assert.deepEqual(shape, expected); else expected = shape;
      } finally { app.unmount(); }
      const copies = runner(() => FicheExemplars({ card: c }));
      try { const tree = copies.render(); assert.equal(find(tree, e => e.type === 'h3').props.children[0], 'Exemplaires'); assert.equal(find(tree, e => e.props?.className === 'catalogue-fiche-copies-count').props.children, 1); assert.equal(elements(tree).filter(e => e.type === 'li').length, 1); } finally { copies.unmount(); }
    }
  } finally { catalogueDataApi.getCard = original; }
});

test('FICHEC exposes only the chosen editable field and Enter saves a valid draft', () => {
  const c = structuredClone(detailFixture);
  c.fields.splice(1, 0, { field: 'cover', effective: { value: null, origin: 'none' }, correction: { state: 'none' } });
  c.fields.reverse(); // Backend field order must not invert De / À.
  const draft = createDraft(c); let saves = 0;
  assert.deepEqual(editableFields(c).map(f => f.field), ['title','cover','ageMin']);
  for (const [field, names] of [['title',['title']], ['age',['ageMin']]]) {
    const app = runner(() => FicheEditSurface({ card: c, field, draft, dirty: true, onSave: () => saves++ }));
    try {
      const tree = app.render(); assert.deepEqual(elements(tree).filter(e => e.type === FieldEditor).map(e => e.props.field.field), names);
      tree.props.onKeyDown({ key: 'Enter', target: { tagName: 'INPUT' }, preventDefault() {} });
      tree.props.onKeyDown({ key: 'Enter', target: { tagName: 'BUTTON' }, preventDefault() { assert.fail('buttons keep their own Enter action'); } });
    } finally { app.unmount(); }
  }
  assert.equal(saves, 2);
});

test('FICHEC description clamps to four rendered lines and Read more/Show less keeps its control', () => {
  const previousStyle = globalThis.getComputedStyle; const previousObserver = globalThis.ResizeObserver;
  globalThis.getComputedStyle = () => ({ lineHeight: '20px' });
  let resize; globalThis.ResizeObserver = class { constructor(fn) { resize = fn; } observe() {} disconnect() {} }; globalThis.requestAnimationFrame = fn => { fn(); return 1; }; globalThis.cancelAnimationFrame = () => {};
  const app = runner(() => FicheDescription({ text: 'First<br>Second' }));
  try {
    let tree = app.render(); const paragraph = find(tree, e => e.type === 'p');
    assert.equal(paragraph.props.children, 'First\nSecond');
    paragraph.props.ref.current = { scrollHeight: 120 }; app.flush(); tree = app.render();
    const more = find(tree, e => e.props?.['aria-label'] === 'Lire la suite'); assert.equal(more.props['aria-expanded'], false);
    assert.equal(more.props['aria-controls'], paragraph.props.id);
    assert.equal(more.props.className, 'catalogue-fiche-description-toggle');
    assert.equal(more.props.children[0], 'Lire la suite');
    more.props.onClick(); tree = app.render(); assert.ok(!find(tree, e => e.type === 'p').props.className.includes('--short'));
    find(tree, e => e.props?.['aria-label'] === 'Réduire').props.onClick(); tree = app.render(); assert.ok(find(tree, e => e.type === 'p').props.className.includes('--short'));
    paragraph.props.ref.current.scrollHeight = 80; resize(); tree = app.render(); assert.ok(!elements(tree).some(e => e.props?.['aria-label'] === 'Lire la suite'));
  } finally { app.unmount(); globalThis.getComputedStyle = previousStyle; globalThis.ResizeObserver = previousObserver; }
  const empty = runner(() => FicheDescription({}));
  try { assert.equal(find(empty.render(), e => e.type === 'p').props.children, 'Aucune description'); } finally { empty.unmount(); }
});

test('FICHED saved corrections stay visible without a restore action', async () => {
  const { catalogueDataApi } = await import('../src/store/catalogue/catalogueDataApi.js');
  const originalGet = catalogueDataApi.getCard, originalMutate = catalogueDataApi.mutate;
  const fields = ['author','description','durationSeconds','storyCount','language'];
  const detail = { ...structuredClone(detailFixture), fields: fields.map(field => ({ field, language: '', correction: { state: 'defined', value: 'Correction' } })) };
  const mutations = []; catalogueDataApi.getCard = async () => detail;
  catalogueDataApi.mutate = async (...args) => { mutations.push(args); };
  const app = runner(() => FichePanel({ card: { id: 'card', exemplars: [], description: 'Corrected description', author: 'Corrected author', durationSeconds: 180, storyCount: 2, language: 'it' } }));
  try {
    app.render(); app.flush(); await new Promise(resolve => setTimeout(resolve, 0));
    const tree = app.render(); const restores = elements(tree).filter(e => e.props?.children === 'rétablir');
    assert.equal(restores.length, 0);
    assert.deepEqual(mutations, []);
    assert.ok(elements(tree).some(e => e.type === FicheDescription && e.props.text === 'Corrected description'));
  } finally { app.unmount(); catalogueDataApi.getCard = originalGet; catalogueDataApi.mutate = originalMutate; }
});

test('FICHED cancel and Escape discard the one-field draft and restore focus to the recreated pencil', async () => {
  const previous = { window: globalThis.window, document: globalThis.document, frame: globalThis.requestAnimationFrame };
  const listeners = new Map(), frames = [], focused = []; let allowed = false;
  globalThis.window = { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) };
  globalThis.requestAnimationFrame = callback => frames.push(callback);
  globalThis.document = { getElementById: id => ({ focus: () => focused.push(id) }) };
  const guard = { current: async () => allowed };
  const app = runner(() => FicheDialog({ card: card(), abandonGuard: guard, onClose() { assert.fail('Escape first exits editing'); } }));
  const content = () => find(app.render(), e => e.type === FichePanel);
  try {
    content(); app.flush(); allowed = true;
    content().props.onEditField('title', { id: 'catalogue-fiche-pencil-title' }); await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(content().props.editing, 'title'); allowed = false;
    content().props.editor.props.onCancel(); await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(content().props.editing, null);
    allowed = true; content().props.onEditField('title', { id: 'catalogue-fiche-pencil-title' }); await new Promise(resolve => setTimeout(resolve, 0)); allowed = false; content();
    const escape = () => listeners.get('keydown')({ key: 'Escape', defaultPrevented: false, preventDefault() {} });
    escape(); await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(content().props.editing, null);
    frames.splice(0).forEach(fn => fn()); assert.deepEqual(focused, ['catalogue-fiche-pencil-title', 'catalogue-fiche-pencil-title']);
  } finally { app.unmount(); globalThis.window = previous.window; globalThis.document = previous.document; globalThis.requestAnimationFrame = previous.frame; }
});

test('FICHED tag cross only removes that tag from the displayed fiche; label still filters', () => {
  const calls = [], filters = [];
  const c = card(); c.tags = [{ id: 'tag', label: 'Aventure' }];
  const app = runner(() => FichePanel({ card: c, onRemoveTag: id => calls.push(id), onFilterTag: id => filters.push(id) }));
  try {
    const tree = app.render();
    find(tree, e => e.props?.['aria-label'] === 'Retirer « Aventure » de cette fiche').props.onClick();
    find(tree, e => e.props?.className === 'catalogue-tag-label').props.onClick();
    assert.deepEqual(calls, ['tag']); assert.deepEqual(filters, ['tag']); assert.equal(c.tags.length, 1);
    // The handler now lives in the hook shared by the panel and the large fiche.
    const actions = readFileSync(new URL('../src/store/catalogue/ficheActionHandlers.js', import.meta.url), 'utf8');
    assert.match(actions, /onRemoveTag: tagId => data.mutate\(\{ kind: 'changeTags', ficheIds: \[card.id\], addLabels: \[\], addTagIds: \[\], removeTagIds: \[tagId\]/);
  } finally { app.unmount(); }
});

test('FICHED age stepper is typeable, bounded 0–18 and exposes no maximum', () => {
  let entry = { field: 'ageMin', state: 'defined', value: '0' };
  const app = runner(() => FieldEditor({ field: { id: 'age', labelKey: 'catalogue:fiche.inline.age' }, entry, onChange: patch => { entry = { ...entry, ...patch }; } }));
  try {
    let tree = app.render();
    assert.equal(find(tree, e => e.type === 'input').props.min, 0); assert.equal(find(tree, e => e.type === 'input').props.max, 18);
    assert.equal(find(tree, e => e.props?.['aria-label'] === 'Diminuer l’âge').props.disabled, true);
    find(tree, e => e.props?.['aria-label'] === 'Augmenter l’âge').props.onClick(); tree = app.render(); assert.equal(entry.value, '1');
    find(tree, e => e.type === 'input').props.onChange({ target: { value: '18' } }); tree = app.render();
    assert.equal(find(tree, e => e.props?.['aria-label'] === 'Augmenter l’âge').props.disabled, true);
    find(tree, e => e.props?.['aria-label'] === 'Diminuer l’âge').props.onClick(); assert.equal(entry.value, '17');
  } finally { app.unmount(); }
});

test('FICHED inline Enter and outside blur save, internal focus stays, Escape cancels', () => {
  let saves = 0, cancels = 0;
  const c = structuredClone(detailFixture);
  const app = runner(() => FicheEditSurface({ card: c, field: 'title', draft: createDraft(c), dirty: true, onSave: () => saves++, onCancel: () => cancels++ }));
  try {
    const tree = app.render();
    tree.props.onBlur({ relatedTarget: {}, currentTarget: { contains: () => true } }); assert.equal(saves, 0);
    tree.props.onBlur({ relatedTarget: {}, currentTarget: { contains: () => false } }); assert.equal(saves, 1);
    tree.props.onKeyDown({ key: 'Enter', target: { tagName: 'INPUT' }, preventDefault() {} }); assert.equal(saves, 2);
    tree.props.onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() {} }); assert.equal(cancels, 1);
    assert.ok(elements(tree).filter(e => e.type === Button).every(e => e.props.variant === 'icon'));
  } finally { app.unmount(); }
});

const { Button } = await import('../src/components/common/Button.jsx');
const { CopyUuid } = await import('../src/components/Catalogue/fiche/CopyUuid.jsx');
test('FICHED UUID copies in full, shows Copié for one second and cleans its timer', async () => {
  const oldSet = globalThis.setTimeout, oldClear = globalThis.clearTimeout;
  let callback, duration, clears = 0; const copies = [];
  globalThis.setTimeout = (fn, ms) => { callback = fn; duration = ms; return 1; };
  globalThis.clearTimeout = () => clears++;
  const app = runner(() => CopyUuid({ uuids: ['12345678-1234-4234-8234-123456789abc'], onCopy: value => copies.push(value) }));
  try {
    let tree = app.render(); app.flush(); assert.equal(tree.props.text, 'Cliquer pour copier');
    assert.equal(tree.props.children.props.tabIndex, 0);
    await tree.props.children.props.onClick(); tree = app.render();
    assert.deepEqual(copies, ['12345678-1234-4234-8234-123456789abc']); assert.equal(duration, 1000);
    assert.equal(find(tree, e => e.props?.['aria-live']).props.children, 'Copié');
    callback(); tree = app.render(); assert.equal(find(tree, e => e.props?.['aria-live']).props.children, copies[0]);
  } finally { app.unmount(); globalThis.setTimeout = oldSet; globalThis.clearTimeout = oldClear; }
  assert.ok(clears >= 2);
});

const { ExemplarChoicePanel } = await import('../src/components/Catalogue/open/ExemplarChoiceDialog.jsx');
test('FICHED chooser asks a question, story subtitle and no initial highlighted row; arrows and Enter keep exact target', () => {
  const c = card({ title: 'Mon histoire', exemplars: [{ id: 'old', modifiedAt: 1 }, { id: 'new', modifiedAt: 2 }] });
  const items = choiceItems(c.exemplars, simulationAvailability); let choice = choiceReducer(CLOSED_CHOICE, { type: 'open', items, command: 'simulate' });
  let chosen;
  const app = runner(() => ExemplarChoicePanel({ card: c, choice, items, dispatch: action => { choice = choiceReducer(choice, action); }, onChoose: item => { chosen = item; } }));
  try {
    let tree = app.render(); assert.equal(find(tree, e => e.type === 'h2').props.children, 'Quelle version veux-tu simuler ?');
    assert.equal(find(tree, e => e.props?.className === 'catalogue-choice-subtitle').props.children, 'Mon histoire');
    assert.ok(elements(tree).filter(e => e.type?.name === 'ChoiceOption').every(e => !e.props.active));
    const list = find(tree, e => e.props?.role === 'listbox');
    list.props.onKeyDown({ key: 'ArrowDown', preventDefault() {} }); tree = app.render();
    assert.equal(elements(tree).filter(e => e.type?.name === 'ChoiceOption' && e.props.active).length, 1);
    find(tree, e => e.props?.role === 'listbox').props.onKeyDown({ key: 'Enter', preventDefault() {} }); assert.equal(chosen.id, items[1].id);
    const options = elements(tree).filter(e => e.type?.name === 'ChoiceOption'); assert.equal(options.filter(e => e.props.latest).length, 1); assert.equal(options.find(e => e.props.latest).props.item.id, 'new');
  } finally { app.unmount(); }
});

test('FICHED compact file identity shares read-only grid badge, version, date, size and folder', () => {
  const { CompactExemplar } = awaitCompact;
  const c = card({ exemplars: [{ id: 'a', versionDeclared: 9, modifiedAt: 1234, sizeBytes: 2048, path: '/Packs/Stories/a.zip' }] });
  c.exemplars[0].versionDeclared = 9;
  const app = runner(() => CompactExemplar({ exemplar: c.exemplars[0], latest: true }));
  try {
    const tree = app.render(), badge = find(tree, e => e.type?.name === 'FormatTag');
    assert.equal(badge.props.onActivate, undefined); assert.equal(badge.props.tag.format, 'zip');
    assert.ok(elements(tree).some(e => e.props?.children === 'v9')); assert.ok(elements(tree).some(e => e.props?.children === 'La plus récente'));
    assert.equal(find(tree, e => e.props?.text === '/Packs/Stories').props.children.props.children, 'Stories');
    assert.match(textContent(find(tree, e => e.props?.className === 'catalogue-compact-exemplar-detail').props.children[0]), /2/);
  } finally { app.unmount(); }
});

test('FICHED French catalogue uses tu, English existing register stays; description labels/help cover all languages', () => {
  const locale = (language, ns) => JSON.parse(readFileSync(new URL(`../src/locales/${language}/${ns}.json`, import.meta.url)));
  const fr = locale('fr', 'catalogue');
  assert.ok(!Object.values(fr).some(value => /\b(vous|votre|vos)\b/i.test(value)));
  assert.equal(fr['empty.noSources.message'], 'Ajoute un dossier qui contient tes packs : ZIP, 7z, projets ou dossiers. Story Studio les indexe sans les déplacer.');
  for (const language of ['fr', 'en', 'it']) {
    const home = locale(language, 'home'), checker = locale(language, 'checker');
    assert.equal(home['packName.description.label'], language === 'it' ? 'Descrizione' : 'Description');
    assert.equal(home['packName.description.annotation'], checker['metadata.description.placeholder']);
  }
});

const { CoverPencil } = await import('../src/components/Catalogue/fiche/CoverPencil.jsx');
const { createDiskHarness } = await import('./tauriDiskHarness.mjs');
// FICHEE (29 oct.): no reset to the pack cover in the fiche, replaced or not.
test('FICHEE cover pencil always chooses an image directly, without menu or reset', async () => {
  const { catalogueDataApi } = await import('../src/store/catalogue/catalogueDataApi.js');
  const { Pencil } = await import('../src/components/icons/LucideLocal.jsx');
  const originals = { stageCover: catalogueDataApi.stageCover, discardCovers: catalogueDataApi.discardCovers, mutate: catalogueDataApi.mutate };
  const disk = await createDiskHarness();
  const mutations = []; let reloads = 0;
  const fresh = { ficheId: 'card', ficheRevision: 3, catalogueRevision: 8 };
  catalogueDataApi.stageCover = async path => { assert.equal(path, '/cover.png'); return { coverStagingId: 'staged' }; };
  catalogueDataApi.discardCovers = async () => {};
  catalogueDataApi.mutate = async (...args) => mutations.push(args);
  try {
    {
      const app = runner(() => CoverPencil({ reload: async () => { reloads++; return fresh; } }));
      try {
        const tree = app.render(); app.flush();
        assert.ok(!elements(tree).some(e => e.props?.role === 'menuitem' || e.type?.name === 'MenuPopover'));
        assert.ok(!textContent(tree).includes('Reprendre'));
        const pencil = find(tree, e => e.props?.id === 'catalogue-fiche-pencil-cover');
        assert.ok(elements(pencil).some(e => e.type === Pencil));
        assert.equal(pencil.props['aria-haspopup'], undefined);
        disk.answerOpen('/cover.png');
        await pencil.props.onClick();
        assert.deepEqual(mutations.at(-1), [{ kind: 'setMetadataBatch', ficheId: 'card', expectedFicheRevision: 3, requestKey: mutations.at(-1)[0].requestKey, changes: [{ field: 'cover', state: 'defined', coverStagingId: 'staged' }] }, 8]);
      } finally { app.unmount(); }
    }
    assert.equal(reloads, 2); assert.equal(mutations.length, 1);
  } finally { Object.assign(catalogueDataApi, originals); await disk.dispose(); }
});

test('FICHEE producer and bonus show effective source text, without author fallback, with their pencil', async () => {
  const { catalogueDataApi } = await import('../src/store/catalogue/catalogueDataApi.js');
  const original = catalogueDataApi.getCard;
  catalogueDataApi.getCard = async () => ({ fields: [
    { field: 'producer', effective: { value: 'Studio Exemple' } },
    { field: 'bonus', effective: { value: 'Une histoire de plus' } },
  ] });
  const app = runner(() => FichePanel({ card: { id: 'extra', exemplars: [], author: null }, onEditField() {} }));
  try {
    app.render(); app.flush(); await new Promise(resolve => setTimeout(resolve, 0));
    const tree = app.render(); const rows = find(tree, e => e.props?.className === 'catalogue-fiche-fields');
    assert.deepEqual(elements(rows).filter(e => e.type === 'dd').slice(-3).map(textContent), ['—non renseigné', 'Studio Exemple', 'Une histoire de plus']);
    // FICHEE (29 oct.): both are now retouchable in the catalogue.
    assert.ok(['catalogue-fiche-pencil-producer', 'catalogue-fiche-pencil-bonus'].every(id => elements(tree).some(e => e.props?.id === id)));
  } finally { app.unmount(); catalogueDataApi.getCard = original; }
});

const { useCatalogueDraft } = await import('../src/hooks/useCatalogueDraft.js');
test('FICHED2 inline draft saves both age corrections in one mutation', async () => {
  const c = structuredClone(detailFixture);
  const maximum = c.fields.find(f => f.field === 'ageMax');
  maximum.effective = { value: 4, origin: 'reference' };
  maximum.referenceValue = { value: 4 };
  const mutations = [];
  const api = { mutate: async (...args) => mutations.push(args) };
  let state;
  const app = runner(() => { state = useCatalogueDraft(c, async () => c, api, { singleAge: true }); });
  try {
    app.render(); app.flush(); app.render();
    state.dispatch({ type: 'edit', id: fieldId({ field: 'ageMin' }), patch: { state: 'defined', value: '8' } });
    app.render();
    assert.equal(await state.save(), true);
    assert.equal(mutations.length, 1);
    assert.equal(mutations[0][0].kind, 'setMetadataBatch');
    assert.deepEqual(mutations[0][0].changes, [{ field: 'ageMin', state: 'defined', value: 8 }, { field: 'ageMax', state: 'cleared' }]);
    assert.equal(mutations[0][1], c.catalogueRevision);
  } finally { app.unmount(); }
});

test('FICHEMENU unrolled trash keeps a fixed footprint, anchors right, uses danger tokens and honours reduced motion', () => {
  const css = readFileSync(new URL('../src/components/Catalogue/CatalogueViews.css', import.meta.url), 'utf8');
  const rule = selector => css.match(new RegExp(`${selector.replace(/[.>]/g, '\\$&')} \\{([^}]*)\\}`))?.[1] ?? '';
  assert.match(rule('.catalogue-exemplar-trash'), /width: 28px; height: 28px/);
  const open = rule('.catalogue-exemplar-trash.is-expanded > button');
  assert.match(open, /position: absolute/); assert.match(open, /right: 0/); assert.match(open, /max-width: none/);
  assert.match(open, /var\(--danger-bg\)/); assert.match(open, /var\(--danger-text\)/); assert.doesNotMatch(open, /#[\da-f]{3,8}\b/i);
  assert.match(open, /width: 100%/);
  assert.match(css, /\.catalogue-fiche-copy-actions:has\(> \.catalogue-exemplar-trash\.is-expanded\) > :not\(\.catalogue-exemplar-trash\) \{ visibility: hidden/);
  assert.match(rule('.catalogue-exemplar-trash-error'), /left: 0/);
  assert.match(css, /prefers-reduced-motion: reduce\) \{\s*\.catalogue-exemplar-trash\.is-expanded > button \{ animation: none/);
});

test('LIGNES shows only known exemplar figures and the discrete identical-copy mention', () => {
  const { CompactExemplar } = awaitCompact;
  for (const [exemplar, identicalCopy, expected] of [
    [{ storyCount: 4, durationSeconds: 3900 }, false, '4 histoires · 1 h 05'],
    [{ storyCount: 1 }, false, '1 histoire'],
    [{ durationSeconds: 90 }, false, '2 min'],
    [{}, false, null],
    [{ storyCount: 0, durationSeconds: 0 }, true, '0 histoire · 1 min · Copie identique'],
    [{}, true, 'Copie identique'],
  ]) {
    const app = runner(() => CompactExemplar({ exemplar: { format: 'zip', ...exemplar }, identicalCopy }));
    try {
      const figures = elements(app.render()).find(e => e.props?.className === 'catalogue-compact-exemplar-figures');
      assert.equal(figures ? textContent(figures) : null, expected);
      assert.deepEqual(elements(figures).filter(e => e.props?.className === 'catalogue-compact-exemplar-segment').map(e => e.props.children), expected?.split(' · ') ?? []);
    } finally { app.unmount(); }
  }
});

const { useCatalogueIdenticalCopies } = await import('../src/hooks/useCatalogueIdenticalCopies.js');
test('LIGNES cancels on close, ignores late replies and clears the previous fiche result', async () => {
  const pending = [], cancelled = [];
  const api = { identicalCopies: (id, request) => new Promise(resolve => pending.push({ id, request, resolve })), cancelIdenticalCopies: async request => cancelled.push(request) };
  let c = { id: 'a', exemplars: [{ id: 'a1' }, { id: 'a2' }] }, result;
  const app = runner(() => { result = useCatalogueIdenticalCopies(c, api); });
  try {
    app.render(); app.flush();
    pending[0].resolve(['a1']); await Promise.resolve(); app.render();
    assert.deepEqual(result, ['a1']);
    c = { id: 'b', exemplars: [] }; app.render(); assert.deepEqual(result, []); app.flush();
    // The first request already answered: changing fiche has nothing to cancel.
    assert.deepEqual(cancelled, []);
  } finally { app.unmount(); }
  assert.deepEqual(cancelled, [pending[1].request]);
  pending[1].resolve(['late']); await Promise.resolve();
});

test('LIGNES never cancels a request that already answered or failed', async () => {
  const pending = [], cancelled = [];
  const api = { identicalCopies: (id, request) => new Promise((resolve, reject) => pending.push({ request, resolve, reject })), cancelIdenticalCopies: async request => cancelled.push(request) };
  let c = { id: 'a', exemplars: [{ id: 'a1' }] };
  const app = runner(() => { useCatalogueIdenticalCopies(c, api); });
  try {
    app.render(); app.flush();
    pending[0].reject(new Error('CATALOG_OPERATION_LIMIT')); await Promise.resolve(); await Promise.resolve();
    c = { id: 'a', exemplars: [{ id: 'a1' }, { id: 'a2' }] }; app.render(); app.flush();
    pending[1].resolve(['a2']); await Promise.resolve(); app.render();
  } finally { app.unmount(); }
  assert.deepEqual(cancelled, []);
});

test('double click opens the card of the FIRST click even when the second lands elsewhere, and only within the delay', async () => {
  const cards = ['a', 'b'].map(id => card({ id })); const order = ['a', 'b'];
  const modals = []; const clicks = { current: null }; let time = 1000; let selection, events; const abandon = { current: null };
  const app = runner(() => {
    selection = useCatalogueSelection(order, cards);
    events = catalogueCardActivation({ selection, order, openFiche() {}, abandon, openModal: id => modals.push(id), clicks, now: () => time });
  });
  try {
    app.render();
    await events.onItemClick({ detail: 1 }, 'a'); time += 120; // the panel opens, the grid reflows
    await events.onItemClick({ detail: 2 }, 'b');
    assert.deepEqual(modals, ['a'], 'the card under the second click is ignored');
    await events.onItemClick({ detail: 1 }, 'a'); time += 120;
    await events.onBackgroundClick({ detail: 2, currentTarget: { contains: () => true }, target: { closest: () => null } });
    assert.deepEqual(modals, ['a', 'a'], 'a second click between cards still opens the first card');
    await events.onItemClick({ detail: 1 }, 'b'); time += 900;
    await events.onItemClick({ detail: 2 }, 'a');
    assert.deepEqual(modals, ['a', 'a'], 'a late second click opens nothing');
    abandon.current = async () => false;
    await events.onItemClick({ detail: 1 }, 'b'); await events.onItemClick({ detail: 2 }, 'a');
    assert.deepEqual(modals, ['a', 'a'], 'the draft guard protects the opening');
  } finally { app.unmount(); }
});

test('PF-F panel section order, newest-version summary and trailing Add chip', async () => {
  const { catalogueDataApi } = await import('../src/store/catalogue/catalogueDataApi.js');
  const original = catalogueDataApi.getCard;
  catalogueDataApi.getCard = async () => ({ fields: [] });
  const { latestExemplarFigures } = await import('../src/store/catalogue/ficheSummary.js');
  const { ficheModalPosition } = await import('../src/store/catalogue/ficheModal.js');
  const c = { id: 'a', tags: [{ id: 't', label: 'Contes' }], exemplars: [
    { id: 'old', format: 'zip', modifiedAt: 10, storyCount: 99, durationSeconds: 900 },
    { id: 'new', format: 'project', modifiedAt: 20, storyCount: 7, durationSeconds: 1440 },
  ] };
  assert.deepEqual(latestExemplarFigures(c).map(value => value.params.count), [7, 24]);
  assert.deepEqual(latestExemplarFigures({ ...c, exemplars: [...c.exemplars, { id: 'empty', modifiedAt: 30 }] }), [], 'never borrow figures from an older version');
  assert.deepEqual(latestExemplarFigures({ exemplars: [{ durationSeconds: 60 }] }).map(value => value.params.count), [1]);
  const moves = [], tags = [];
  const app = runner(() => FichePanel({ card: c, onTags: event => tags.push(event), position: ficheModalPosition(['c', 'a', 'b'], 'a'), onNavigate: delta => moves.push(delta) }));
  try {
    app.render(); app.flush(); await new Promise(resolve => setTimeout(resolve, 0));
    const tree = app.render();
    const direct = tree.props.children.filter(Boolean);
    assert.equal(direct[1].type, 'section');
    assert.equal(find(direct[1], e => e.type === 'h3').props.children, 'Étiquettes');
    assert.equal(direct[2].type, FicheDescription);
    assert.equal(find(direct[3], e => e.type === 'h3').props.children, 'Informations');
    const chip = find(tree, e => e.props?.className === 'catalogue-fiche-add-tag');
    const chips = find(direct[1], e => e.props?.className === 'catalogue-card-tags').props.children;
    assert.equal(chips.at(-1), chip);
    chip.props.onClick('anchor'); assert.deepEqual(tags, ['anchor']);
    find(tree, e => e.props?.id === 'catalogue-fiche-previous').props.onClick();
    find(tree, e => e.props?.id === 'catalogue-fiche-next').props.onClick();
    assert.deepEqual(moves, [-1, 1]);
    assert.ok(elements(tree).some(e => e.props?.className === 'catalogue-fiche-position' && e.props.children === '2 / 3'));
    assert.ok(elements(tree).some(e => e.props?.className === 'catalogue-fiche-summary' && e.props.children === '7 histoires · 24 min'));
  } finally { app.unmount(); catalogueDataApi.getCard = original; }
});

test('PF-F navigation uses the shared draft guard and serializes pending requests', async () => {
  const { ficheModalPosition } = await import('../src/store/catalogue/ficheModal.js');
  const order = ['c', 'a', 'b']; let id = 'a'; let resolve; const visited = [];
  const abandon = { current: () => new Promise(done => { resolve = done; }) };
  const app = runner(() => FicheDialog({ card: { id, exemplars: [] }, abandonGuard: abandon, position: ficheModalPosition(order, id), onNavigate: delta => {
    const position = ficheModalPosition(order, id);
    id = delta < 0 ? position.previous : position.next; visited.push(id);
  } }));
  try {
    const panel = find(app.render(), e => e.type === FichePanel);
    const pending = panel.props.onNavigate(1);
    await panel.props.onNavigate(-1); assert.deepEqual(visited, []);
    resolve(false); await pending; assert.equal(id, 'a');
    const accepted = panel.props.onNavigate(-1); resolve(true); await accepted;
    assert.deepEqual(visited, ['c']);
    const first = find(app.render(), e => e.type === FichePanel);
    const overview = runner(() => first.type(first.props));
    try {
      const tree = overview.render();
      assert.equal(find(tree, e => e.props?.id === 'catalogue-fiche-previous').props.disabled, true);
      assert.equal(find(tree, e => e.props?.id === 'catalogue-fiche-next').props.disabled, undefined);
    } finally { overview.unmount(); }
    id = 'b';
    const last = find(app.render(), e => e.type === FichePanel);
    const lastOverview = runner(() => last.type(last.props));
    try {
      const tree = lastOverview.render();
      assert.equal(find(tree, e => e.props?.id === 'catalogue-fiche-next').props.disabled, true);
      assert.equal(find(tree, e => e.props?.id === 'catalogue-fiche-previous').props.disabled, undefined);
    } finally { lastOverview.unmount(); }
  } finally { app.unmount(); }
});

test('FICHEE age pencil keeps editing and the shared UUID copy icon stays accessible', async () => {
  const { editableField } = await import('../src/components/Catalogue/fiche/FicheSections.jsx');
  const { ChevronDown, Pencil, Copy } = await import('../src/components/icons/LucideLocal.jsx');
  const edits = [];
  const t = key => key;
  for (const idPrefix of ['catalogue-fiche', 'catalogue-fiche-modal']) {
    const tree = editableField({ t, field: 'age', label: 'Âge', content: '5+', idPrefix, onEditField: (...args) => edits.push(args) });
    const button = find(tree, e => e.type === Button);
    assert.equal(button.props.id, `${idPrefix}-pencil-age`);
    assert.equal(button.props['aria-label'], 'catalogue:fiche.inline.editField');
    // FICHEE (29 oct.): the age uses the same pencil as every other field.
    assert.ok(elements(button).some(e => e.type === Pencil)); assert.ok(!elements(button).some(e => e.type === ChevronDown));
    const trigger = { id: button.props.id };
    button.props.onClick({ currentTarget: trigger });
    assert.deepEqual(edits.at(-1), ['age', trigger]);
    const editor = { editor: true };
    assert.equal(editableField({ field: 'age', editing: 'age', editor }), editor);
  }
  const app = runner(() => CopyUuid({ uuids: ['uuid'] }));
  try { assert.ok(elements(app.render()).some(e => e.type === Copy)); } finally { app.unmount(); }
});

test('PF-F2 pending fiche hides age and summary until its own details arrive, in panel and modal', async () => {
  const { catalogueDataApi } = await import('../src/store/catalogue/catalogueDataApi.js');
  const { FicheModal } = await import('../src/components/Catalogue/fiche/FicheModal.jsx');
  const original = catalogueDataApi.getCard;
  const oldWindow = globalThis.window;
  globalThis.window = { ...oldWindow, addEventListener() {}, removeEventListener() {} };
  const pending = [];
  catalogueDataApi.getCard = id => new Promise(resolve => pending.push({ id, resolve }));
  try {
    for (const Component of [FichePanel, FicheModal]) {
      let c = { id: 'first', age: { min: 5 }, exemplars: [{ storyCount: 7, durationSeconds: 1440 }] };
      const app = runner(() => Component({ card: c }));
      const hasAge = tree => elements(tree).some(e => e.props?.className === 'catalogue-fiche-age');
      const hasMeta = tree => elements(tree).some(e => ['catalogue-fiche-summary', 'catalogue-fiche-modal-summary'].includes(e.props?.className));
      try {
        let tree = app.render(); assert.equal(hasAge(tree), false); assert.equal(hasMeta(tree), false); app.flush();
        pending.at(-1).resolve({ fields: [] }); await new Promise(resolve => setTimeout(resolve, 0));
        tree = app.render(); assert.equal(hasAge(tree), true); assert.equal(hasMeta(tree), true);
        assert.equal(find(tree, e => e.type === 'dt' && e.props.children === 'Âge').props.className, 'catalogue-visually-hidden');
        c = { ...c, id: 'second' };
        tree = app.render(); assert.equal(hasAge(tree), false); assert.equal(hasMeta(tree), false); app.flush();
        pending.at(-1).resolve({ fields: [] }); await new Promise(resolve => setTimeout(resolve, 0));
        assert.equal(hasAge(app.render()), true);
      } finally { app.unmount(); }
    }
  } finally { catalogueDataApi.getCard = original; globalThis.window = oldWindow; }
});

test('PF-F2 segment wrapping and filled fiche chips use existing tokens; FICHEE age pencil shows on hover like the others', () => {
  const css = readFileSync(new URL('../src/components/Catalogue/CatalogueViews.css', import.meta.url), 'utf8');
  const openCss = readFileSync(new URL('../src/components/Catalogue/open/CatalogueOpen.css', import.meta.url), 'utf8');
  assert.match(openCss, /\.catalogue-compact-exemplar-segment \{ white-space: nowrap; \}/);
  assert.match(css, /\.catalogue-fiche \.catalogue-card-tag \{[^}]*min-height: 28px;[^}]*border-radius: var\(--radius-pill\);[^}]*background: var\(--bg2\);[^}]*font-family: var\(--font-sans\)/);
  assert.doesNotMatch(css, /\.catalogue-fiche-age \.catalogue-fiche-field-action/);
  assert.match(css, /\.catalogue-fiche-field-action \{[^}]*opacity: 0;/);
  assert.match(css, /\.catalogue-fiche-editable:hover \.catalogue-fiche-field-action,\n\.catalogue-fiche-editable:focus-within \.catalogue-fiche-field-action,/);
});

// FICHEE (29 oct.): description, language, author, producer and bonus are retouchable in place.
const descriptiveFixture = () => {
  const c = structuredClone(detailFixture);
  const source = { description: 'Ligne 1<br>Ligne 2', language: 'ru', author: 'Autrice', producer: null, bonus: 'Livret' };
  for (const [field, value] of Object.entries(source)) c.fields.push({ field, effective: { value, origin: value == null ? 'none' : 'reference' }, correction: { state: 'none' }, ...(value == null ? {} : { referenceValue: { value } }) });
  for (const field of ['durationSeconds', 'storyCount']) c.fields.push({ field, effective: { value: 60, origin: 'reference' }, correction: { state: 'none' }, referenceValue: { value: 60 } });
  return c;
};

test('FICHEE every descriptive field is editable alone; duration and story count never', () => {
  const c = descriptiveFixture();
  assert.deepEqual(editableFields(c).map(f => f.field), ['title', 'ageMin', 'description', 'language', 'author', 'producer', 'bonus']);
  for (const field of ['description', 'language', 'author', 'producer', 'bonus']) {
    const app = runner(() => FicheEditSurface({ card: c, field, draft: createDraft(c), dirty: true }));
    try { assert.deepEqual(elements(app.render()).filter(e => e.type === FieldEditor).map(e => e.props.field.field), [field]); } finally { app.unmount(); }
  }
});

test('FICHEE single-line fields save a correction, and an emptied field is cleared, catalogue only', () => {
  const c = descriptiveFixture();
  for (const [field, typed, expected] of [['author', 'Auteur corrigé', { field: 'author', state: 'defined', value: 'Auteur corrigé' }], ['producer', 'Studio', { field: 'producer', state: 'defined', value: 'Studio' }], ['bonus', '', { field: 'bonus', state: 'cleared' }]]) {
    let draft = createDraft(c); const id = fieldId({ field });
    const app = runner(() => FieldEditor({ field: editableFields(c).find(f => f.id === id), entry: draft.entries[id], onChange: patch => { draft = draftReducer(draft, { type: 'edit', id, patch }); } }));
    try {
      const input = find(app.render(), e => e.type === 'input'); assert.equal(input.props.type, 'text');
      input.props.onChange({ target: { value: typed } });
      assert.deepEqual(ficheDraftChanges(draft), [expected]);
      assert.deepEqual(validateDraft(draft, { singleAge: true }), {});
    } finally { app.unmount(); }
  }
});

test('FICHEE language is chosen from the content language list, never typed; empty clears; an unlisted code stays offered', () => {
  const c = descriptiveFixture();
  let draft = createDraft(c); const id = fieldId({ field: 'language' });
  const app = runner(() => FieldEditor({ field: editableFields(c).find(f => f.id === id), entry: draft.entries[id], onChange: patch => { draft = draftReducer(draft, { type: 'edit', id, patch }); } }));
  try {
    let tree = app.render();
    assert.ok(!elements(tree).some(e => e.type === 'input' || e.type === 'datalist'));
    const select = find(tree, e => e.type === Select); assert.equal(select.props.value, 'ru');
    const options = select.props.options;
    assert.deepEqual(options.slice(0, 3).map(e => [e.value, e.label]), [['', 'Non renseignée'], ['ru', 'ru'], ['fr', 'Français']]);
    assert.ok(!options.some(e => e.value === 'custom'));
    select.props.onChange('it'); tree = app.render();
    assert.deepEqual(ficheDraftChanges(draft), [{ field: 'language', state: 'defined', value: 'it' }]);
    find(tree, e => e.type === Select).props.onChange(''); 
    assert.deepEqual(ficheDraftChanges(draft), [{ field: 'language', state: 'cleared' }]);
  } finally { app.unmount(); }
});

test('FICHEE description edits multiline text from the displayed value; Enter breaks the line, Ctrl+Enter saves', () => {
  const c = descriptiveFixture();
  let draft = createDraft(c); const id = fieldId({ field: 'description' });
  const app = runner(() => FieldEditor({ field: editableFields(c).find(f => f.id === id), entry: draft.entries[id], onChange: patch => { draft = draftReducer(draft, { type: 'edit', id, patch }); } }));
  try {
    const area = find(app.render(), e => e.type === 'textarea'); assert.equal(area.props.value, 'Ligne 1\nLigne 2');
    area.props.onChange({ target: { value: 'Ligne 1\nLigne 3' } });
    assert.deepEqual(ficheDraftChanges(draft), [{ field: 'description', state: 'defined', value: 'Ligne 1\nLigne 3' }]);
  } finally { app.unmount(); }
  let saves = 0;
  const surface = runner(() => FicheEditSurface({ card: c, field: 'description', draft, dirty: true, onSave: () => saves++ }));
  try {
    const tree = surface.render();
    tree.props.onKeyDown({ key: 'Enter', target: { tagName: 'TEXTAREA' }, preventDefault() { assert.fail('Enter keeps its new line'); } }); assert.equal(saves, 0);
    tree.props.onKeyDown({ key: 'Enter', ctrlKey: true, target: { tagName: 'TEXTAREA' }, preventDefault() {} }); assert.equal(saves, 1);
    tree.props.onKeyDown({ key: 'Enter', metaKey: true, target: { tagName: 'TEXTAREA' }, preventDefault() {} }); assert.equal(saves, 2);
    tree.props.onKeyDown({ key: 'Enter', target: { tagName: 'SELECT' }, preventDefault() {} }); assert.equal(saves, 3);
  } finally { surface.unmount(); }
});

test('FICHEE description pencil opens the editor in place of the text, under the same heading', async () => {
  const opened = [];
  const pencil = editableFieldPencil(opened);
  const shown = runner(() => FicheDescription({ text: 'Texte', pencil }));
  try {
    const tree = shown.render();
    assert.ok(tree.props.className.includes('catalogue-fiche-editable'));
    const button = find(tree, e => e.props?.id === 'catalogue-fiche-pencil-description');
    button.props.onClick({ currentTarget: { id: button.props.id } });
    assert.deepEqual(opened, [['description', { id: 'catalogue-fiche-pencil-description' }]]);
  } finally { shown.unmount(); }
  const editor = { type: 'section', props: { id: 'editor' } };
  const editing = runner(() => FicheDescription({ text: 'Texte', pencil, editor }));
  try {
    const tree = editing.render();
    assert.ok(!elements(tree).some(e => e.type === 'p' || e.props?.id === 'catalogue-fiche-pencil-description'));
    assert.ok(elements(tree).includes(editor));
    assert.equal(find(tree, e => e.type === 'h3').props.children, 'Description');
  } finally { editing.unmount(); }
});
const { editPencil } = await import('../src/components/Catalogue/fiche/FicheSections.jsx');
function editableFieldPencil(opened) { return editPencil({ t: key => key, field: 'description', label: 'Description', onEditField: (...args) => opened.push(args) }); }

test('FICHEE no catalogue-modified mention on cards and rows, and no cover reset left in the fiche', () => {
  for (const file of ['views/CatalogueCard.jsx', 'views/CatalogueRow.jsx', 'fiche/CoverPencil.jsx', 'fiche/FicheOverview.jsx', 'fiche/FicheModal.jsx', 'fiche/FicheDialog.jsx']) {
    const source = readFileSync(new URL(`../src/components/Catalogue/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /CatalogueCorrectionNotice|data\.corrected|fiche\.cover\.restore|state: 'source'/, file);
  }
});

test('FICHEE touching a field then returning to the shown source value saves no mutation', async () => {
  const c = descriptiveFixture();
  for (const [field, kind, touched, back] of [['description', 'textarea', 'Ligne 1\nLigne 2 x', 'Ligne 1\nLigne 2'], ['author', 'input', 'Autrices', 'Autrice'], ['bonus', 'input', 'Livre', 'Livret'], ['language', 'select', 'it', 'ru']]) {
    let draft = createDraft(c); const id = fieldId({ field });
    let saves = 0;
    const editor = runner(() => FicheEditSurface({ card: c, field, draft, onSave: () => saves++, dirty: true, dispatch: action => { draft = draftReducer(draft, action); } }));
    try {
      // The surface hands the original entry to its editor; the editor is rendered from those props.
      const control = () => { const props = find(editor.render(), e => e.type === FieldEditor).props; assert.equal(props.original, draft.original[id]); const app = runner(() => FieldEditor(props)); try { return find(app.render(), e => e.type === (kind === 'select' ? Select : kind)); } finally { app.unmount(); } };
      // The app's Select reports the chosen value itself; native fields report an event.
      const change = value => control().props.onChange(kind === 'select' ? value : { target: { value } });
      change(touched);
      assert.equal(draft.entries[id].state, 'defined', field);
      change(back);
      assert.equal(draft.entries[id].state, 'source', field);
      assert.equal(control().props.value, kind === 'textarea' ? 'Ligne 1\nLigne 2' : back);
      assert.deepEqual(ficheDraftChanges(draft), [], field);
      // Blur or Ctrl+Enter go through save, which sends nothing for an empty change list (useCatalogueDraft).
      editor.render().props.onBlur({ relatedTarget: null, currentTarget: { contains: () => false } }); assert.equal(saves, 1);
    } finally { editor.unmount(); }
  }
});

test('inline editors: compact language select and no native number spinner next to the design buttons', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../src/components/Catalogue/fiche/FicheEditPanel.css', import.meta.url), 'utf8');
  const selectCss = readFileSync(new URL('../src/components/common/Select.css', import.meta.url), 'utf8');
  assert.match(selectCss, /\.select-trigger--pill \{[^}]*radius-pill/);
  assert.match(css, /input\[type="number"\]::-webkit-inner-spin-button/);
  assert.match(css, /-moz-appearance: textfield; appearance: textfield/);
});

test('inline age editor reserves its input and button widths and reflows below the cover in narrow fiches', () => {
  const css = readFileSync(new URL('../src/components/Catalogue/fiche/FicheEditPanel.css', import.meta.url), 'utf8');
  assert.match(css, /\.catalogue-inline-editor \.catalogue-field-editor:has\(input\[type="number"\]\)\s*\{[^}]*flex: 0 0 auto;/);
  assert.match(css, /\.catalogue-inline-input input\[type="number"\]\s*\{[^}]*flex: 0 0 4rem;[^}]*width: 4rem;/);
  assert.match(css, /\.catalogue-inline-editor > \.btn-icon,\s*\.catalogue-inline-input > \.btn-icon\s*\{[^}]*flex-shrink: 0;/);
  assert.match(css, /@container \(max-width: 480px\)\s*\{\s*\.catalogue-fiche-overview:has\(\.catalogue-inline-input input\[type="number"\]\) \.catalogue-fiche-intro\s*\{[^}]*display: contents;/);
  assert.match(css, /\.catalogue-fiche-overview:has\(\.catalogue-inline-input input\[type="number"\]\) \.catalogue-fiche-age,[^{]+\{[^}]*grid-column: 1 \/ -1;/);
});
