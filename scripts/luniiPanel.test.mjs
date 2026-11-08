import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'rolldown/experimental';
import { runner } from './reactHookDriver.mjs';
import { createTestI18n } from './i18nTestSetup.mjs';
import { createLuniiDevices } from '../src/store/catalogue/luniiDevices.js';
registerHooks({ resolve(specifier, context, next) { return next(specifier.endsWith('/panelResize') ? specifier + '.js' : specifier, context); }, load(url, context, next) {
  if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
  if (url.endsWith('.jsx')) return { format: 'module', source: `import * as InteractionReact from '${new URL('../node_modules/react/index.js', import.meta.url).href}';\n` + transformSync(fileURLToPath(url), readFileSync(fileURLToPath(url), 'utf8'), { jsx: { runtime: 'classic', pragma: 'InteractionReact.createElement', pragmaFrag: 'InteractionReact.Fragment' } }).code, shortCircuit: true };
  if (url.endsWith('/structure/panelResize')) return next(url + '.js', context);
  return next(url, context);
} });
const { LuniiBanner } = await import('../src/components/Catalogue/lunii/LuniiBanner.jsx');
const { LuniiEmptyState } = await import('../src/components/Catalogue/lunii/LuniiEmptyState.jsx');
const { LuniiPanelHeader } = await import('../src/components/Catalogue/lunii/LuniiPanelHeader.jsx');
const { LuniiStoryRow } = await import('../src/components/Catalogue/lunii/LuniiStoryRow.jsx');
const { LuniiPanel } = await import('../src/components/Catalogue/lunii/LuniiPanel.jsx');
const { LuniiFiche } = await import('../src/components/Catalogue/lunii/LuniiFiche.jsx');
const { useCatalogueSelection } = await import('../src/hooks/useCatalogueSelection.js');
const { catalogueCardActivation } = await import('../src/store/catalogue/cardActivation.js');
const { ficheWidthBounds } = await import('../src/hooks/useCatalogueFicheWidth.js');
const { Button } = await import('../src/components/common/Button.jsx');
const { Tooltip } = await import('../src/components/common/Tooltip.jsx');
// Infobulle de l'app (et non `title` natif) qui enveloppe l'élément donné.
const tipOf = (tree, element) => elements(tree).find(e => e.type === Tooltip && [].concat(e.props.children).includes(element))?.props.text;
const elements = node => !node || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(elements) : [node, ...elements(node.props?.children)];
const text = node => typeof node === 'string' || typeof node === 'number' ? String(node) : Array.isArray(node) ? node.map(text).join(' ') : node && typeof node === 'object' ? text(node.props?.children) : '';
const render = (Component, props) => { const app = runner(() => Component(props)); try { return app.render(); } finally { app.unmount(); } };
const device = { id: 'd', state: 'ready', stories: [], orphans: [], banner: [], metadataVersion: 6, firmware: '2.22.0', totalBytes: 1000, freeBytes: 400 };

test('damaged banners distinguish startup failure from a missing choice, with inactive repair', () => {
  for (const [kind, expected, excluded] of [['damagedTruncated', /ne démarre plus/, /quand l’enfant/], ['damagedMissingStories', /error.*quand l’enfant/, /ne démarre plus/]]) {
    const tree = render(LuniiBanner, { kind, device });
    assert.match(text(tree), expected); assert.doesNotMatch(text(tree), excluded);
    assert.equal(elements(tree).find(e => e.type === Button).props.disabled, true);
  }
});

test('resume, unknown metadata, read-only volume and orphan banners explain the state', () => {
  for (const [kind, value, expected] of [
    ['resume', device, /gardé la liste d’avant/],
    ['readOnly', { ...device, metadataVersion: 9, firmware: null }, /abîmées ou inconnues/],
    // Expectation changed on purpose: the firmware version is not a read-only
    // cause; the engine's readOnlyReason is (30 Oct. 2026 incident).
    ['readOnly', { ...device, firmware: '3.1.0', readOnlyReason: 'volume' }, /doit être vérifiée.*pas été éjectée.*fsck\.vfat.*chkdsk.*Utilitaire de disque/],
    ['orphans', { ...device, orphans: [{ parked: true, complete: true, sizeBytes: 100 }] }, /hors de la liste/],
  ]) {
    const tree = render(LuniiBanner, { kind, device: value });
    assert.match(text(tree), expected);
    assert.ok(elements(tree).filter(e => e.type === Button).every(e => e.props.disabled === (kind !== 'resume')));
  }
});

test('D45: a duplicate copy is not counted as a story the child misses by the orphan banner', () => {
  const copy = { parked: true, duplicateOfListed: true, sizeBytes: 100, complete: true, knownUuid: 'b' };
  const lone = { parked: true, sizeBytes: 300, complete: true };
  const tree = render(LuniiBanner, { kind: 'orphans', device: { ...device, orphans: [copy, lone] } });
  assert.match(text(tree), /1 histoire hors de la liste/);
  assert.doesNotMatch(text(tree), /2 histoires/);
  assert.match(text(tree), /300/);
  assert.match(readFileSync('src-tauri/src/commands/lunii_device.rs', 'utf8'), /orphans\.iter\(\)\.any\(\|o\| o\["duplicateOfListed"\] != true\)/, 'only duplicates: no banner');
});

test('read-only banner follows the engine cause, never the firmware version', () => {
  for (const [reason, expected, title] of [
    ['volume', /système de fichiers est en lecture seule/, /La Lunii doit être vérifiée/],
    ['metadata', /abîmées ou inconnues/, /Lecture seule/],
    ['unavailable', /n’arrive pas à lire la liste.*Éjecte-la, rebranche-la/, /La liste de la Lunii est illisible pour l’instant/],
    [null, /disque est en lecture seule/, /Lecture seule/],
  ]) {
    const tree = render(LuniiBanner, { kind: 'readOnly', device: { ...device, firmware: '3.3.4', metadataVersion: 7, readOnlyReason: reason } });
    assert.match(text(tree), expected);
    assert.match(text(tree), title);
    assert.doesNotMatch(text(tree), /3\.3\.4|ne connaît pas/);
  }
  // A recent firmware without any cause from the engine is not called unknown.
  assert.doesNotMatch(text(render(LuniiBanner, { kind: 'readOnly', device: { ...device, firmware: '3.3.4', metadataVersion: 7 } })), /3\.3\.4|ne connaît pas/);
});

test('S1 is the only empty state offering an action; S2/S19/S18/S17 have their own text', () => {
  for (const [state, expected] of [['detected', /Ta Lunii est branchée/], ['opening', /Lecture de la Lunii/], ['unsupported', /mise à jour/], ['ejected', /Tu peux débrancher/], ['disconnected', /Rien n’est perdu/]]) {
    let opened = 0;
    const tree = render(LuniiEmptyState, { state, onOpen: () => opened++ });
    assert.match(text(tree), expected);
    const buttons = elements(tree).filter(e => e.type === Button);
    assert.equal(buttons.length, state === 'detected' ? 1 : 0);
    if (buttons.length) { buttons[0].props.onClick(); assert.equal(opened, 1); }
  }
});

// Expectation changed on purpose: a busy Lunii no longer refuses
// ejection silently; the button stays active and asks what to do with the running writes.
test('damaged, read-only and busy lists permit eject; opening refuses it', () => {
  for (const [state, busy, disabled] of [['damaged', false, false], ['readOnly', false, false], ['ready', true, false], ['opening', false, true]]) {
    const tree = render(LuniiPanelHeader, { device: { ...device, state, busy } });
    const eject = elements(tree).find(e => e.type === Button && e.props['aria-label'] === 'Éjecter');
    assert.equal(eject.props.disabled, disabled);
    const gauge = elements(tree).find(e => e.type === 'progress');
    assert.equal(gauge.props.value, 600); assert.ok(gauge.props['aria-label']);
  }
});

test('rows retain hidden/official/unknown/orphan semantics; listed eyes and handles become active', () => {
  for (const story of [{ key: 'a', hidden: true, kind: 'official' }, { key: 'b', title: null, kind: 'unknown', parkingPending: true }, { key: 'parked:x', orphan: true, parked: true, complete: true }, { key: 'partial', orphan: true, complete: false }]) {
    let selected = 0;
    const tree = render(LuniiStoryRow, { story, selected: true, onSelect: () => selected++ });
    assert.equal(tree.props['aria-selected'], true);
    const select = elements(tree).find(e => e.type === 'button');
    select.props.onClick(); assert.equal(selected, 1);
    // D40 (voulu) : sur une orpheline, la poignée reste inactive, mais l'œil « Remettre dans la liste » est actif si le dossier est complet et la corbeille l'est toujours.
    for (const button of elements(tree).filter(e => e.type === Button)) {
      const label = button.props['aria-label'];
      const expected = label === 'Réordonner' ? Boolean(story.orphan)
        : label === 'Remettre dans la liste' ? !story.complete
          : false;
      assert.equal(Boolean(button.props.disabled), expected, `${story.key}: ${label}`);
    }
    assert.doesNotMatch(text(tree), /parkingPending|parked:|\.md/);
    if (story.hidden) assert.match(text(tree), /Masquée.*Officielle/);
    if (story.orphan) assert.match(text(tree), story.complete ? /Hors de la liste/ : /Envoi interrompu/);
  }
});

test('panel tabs expose selection and arrow navigation; collapsed panel offers expansion', () => {
  const state = { activeLuniiId: 'a', luniiDevices: [{ ...device, id: 'a' }, { ...device, id: 'b' }], selection: { side: 'catalogue', ids: [] }, luniiPanelWidth: 330 };
  let changed;
  const previousFrame = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = callback => callback();
  globalThis.document = { getElementById: () => ({ focus() {} }) };
  try {
    const tree = render(LuniiPanel, { lunii: { ...state, store: {} }, onDeviceChange: id => changed = id });
    const tabs = elements(tree).filter(e => e.props?.role === 'tab');
    assert.equal(tabs.length, 2); assert.equal(tabs[0].props['aria-selected'], true); assert.equal(tabs[1].props.tabIndex, -1);
    tabs[0].props.onKeyDown({ key: 'ArrowRight', preventDefault() {} }); assert.equal(changed, 'b');
    let collapsed;
    const compact = render(LuniiPanel, { lunii: { ...state, luniiPanelCollapsed: true, store: { collapse: v => collapsed = v } } });
    elements(compact).find(e => e.props?.['aria-label'] === 'Déplier le panneau Lunii').props.onClick();
    assert.equal(collapsed, false);
  } finally { delete globalThis.document; globalThis.requestAnimationFrame = previousFrame; }
});

test('Lunii fiche displays seconds-based sent date, unavailable author, note and bounded traversal', () => {
  const story = { key: 'a', title: 'Conte', position: 1, sentAt: 1793275200, sizeBytes: 1024 };
  let navigated;
  const tree = render(LuniiFiche, { story, rows: [story, { key: 'b' }], onNavigate: delta => navigated = delta });
  assert.match(text(tree), /Sur la Lunii · 1 \/ 2/); assert.match(text(tree), /2026/); assert.match(text(tree), /Pas dans ton catalogue/);
  assert.ok(elements(tree).some(e => e.type === 'dd' && e.props.children === '—'));
  const previous = elements(tree).find(e => e.props?.['aria-label'] === 'Histoire précédente');
  assert.equal(previous.props.disabled, true);
  elements(tree).find(e => e.props?.['aria-label'] === 'Histoire suivante').props.onClick(); assert.equal(navigated, 1);
});

test('catalogue activation replaces the Lunii side, while a Lunii click empties catalogue selection', async () => {
  const store = createLuniiDevices({}, { read() {}, write() {} });
  const order = ['a', 'b'];
  const app = runner(() => useCatalogueSelection(order, [], true, { store, ...store.getSnapshot() }));
  try {
    let selection = app.render(); selection.apply({ type: 'click', id: 'a' }); selection = app.render();
    store.select('lunii', ['story']); selection = app.render();
    assert.deepEqual(selection.ids, []);
    const activation = catalogueCardActivation({ selection, order, cardsById: new Map(), openFiche() {}, abandon: { current: null } });
    await activation.onItemClick({ detail: 1, ctrlKey: true }, 'b'); selection = app.render();
    assert.deepEqual(selection.ids, ['b']); assert.deepEqual(store.getSnapshot().selection, { side: 'catalogue', ids: ['b'] });
    selection.selectAll(); app.render();
    assert.deepEqual(store.getSnapshot().selection.ids, ['a', 'b']);
  } finally { app.unmount(); }
});

test('fiche preserves its minimum before reserving grid width beside the Lunii panel', () => {
  assert.deepEqual(ficheWidthBounds(1000, 1000, 330), { min: 320, max: 320 });
  assert.deepEqual(ficheWidthBounds(1000, 1000, 48), { min: 320, max: 592 });
});

test('panel display reserves catalogue and open fiche minima without changing preference', async () => {
  const { useLuniiPanelWidth, luniiPanelMaxWidth } = await import('../src/hooks/useLuniiPanelWidth.js');
  assert.equal(luniiPanelMaxWidth(1000, true), 330);
  assert.equal(luniiPanelMaxWidth(1000, false), 640);
  assert.equal(luniiPanelMaxWidth(680, true), 330);
  assert.equal(luniiPanelMaxWidth(1400, true), 720);
  const previous = globalThis.ResizeObserver; const previousRaf = globalThis.requestAnimationFrame; const previousCaf = globalThis.cancelAnimationFrame;
  let measure;
  globalThis.requestAnimationFrame = callback => { callback(); return 1; }; globalThis.cancelAnimationFrame = () => {};
  globalThis.ResizeObserver = class { constructor(callback) { measure = callback; } observe() {} disconnect() {} };
  const parent = { clientWidth: 1000 };
  const app = runner(() => useLuniiPanelWidth(800, true, true));
  try {
    let width = app.render(); width.panelRef.current = { parentElement: parent }; app.flush();
    width = app.render(); assert.equal(width.value, 330);
    assert.deepEqual(ficheWidthBounds(1000, 1000, width.value), { min: 320, max: 320 });
    parent.clientWidth = 920; measure(); width = app.render();
    assert.equal(width.value, 330);
    assert.deepEqual(ficheWidthBounds(920, 920, width.value), { min: 320, max: 320 });
    assert.equal(920 - width.value - 320, 270, 'the grid gives the missing width to the fiche');
    parent.clientWidth = 1600; measure(); width = app.render(); assert.equal(width.value, 800);
  } finally { app.unmount(); globalThis.ResizeObserver = previous; globalThis.requestAnimationFrame = previousRaf; globalThis.cancelAnimationFrame = previousCaf; }
});

test('panel ref detachment remembers focused content before removal and restores search', () => {
  const previousDocument = globalThis.document;
  const previousFrame = globalThis.requestAnimationFrame;
  const frames = [];
  let focused = 0;
  const button = {};
  globalThis.document = { activeElement: button, getElementById: id => id === 'catalogue-search' ? { focus() { focused++; } } : null };
  globalThis.requestAnimationFrame = callback => frames.push(callback);
  const lunii = { luniiDevices: [device], selection: { side: 'catalogue', ids: [] }, luniiPanelWidth: 330, store: {} };
  const app = runner(() => LuniiPanel({ lunii }));
  try {
    const tree = app.render(); tree.props.ref({ contains: element => element === button }); app.flush();
    tree.props.ref(null);
    app.unmount();
    globalThis.document.activeElement = {};
    frames.forEach(callback => callback());
    assert.equal(focused, 1);
  } finally { globalThis.document = previousDocument; globalThis.requestAnimationFrame = previousFrame; }
});

test('S18 uses the success disk and CircleCheck', async () => {
  const { CircleCheck } = await import('../src/components/icons/LucideLocal.jsx');
  const tree = render(LuniiEmptyState, { state: 'ejected' });
  assert.ok(elements(tree).some(e => e.props?.className?.includes('lunii-empty-icon--success')));
  assert.ok(elements(tree).some(e => e.type === CircleCheck));
});

test('panel keyboard selects creations, reorders from zero-based boundaries and confirms Delete through the shared gesture', () => {
  const stories = [{ key: 'a', title: 'A', kind: 'creation' }, { key: 'b', title: 'B', kind: 'official' }, { key: 'c', title: 'C', kind: 'unknown', hidden: true }];
  const calls = []; let ids;
  const lunii = { luniiDevices: [{ ...device, stories }], activeLuniiId: 'd', selection: { side: 'lunii', ids: ['c'] }, store: {}, gestures: { move: (...args) => calls.push(['move', ...args]), remove: (...args) => calls.push(['remove', ...args]) } };
  const tree = render(LuniiPanel, { lunii, onSelect: next => ids = next });
  const key = (key, extra = {}) => tree.props.onKeyDown({ key, target: { closest() { return false; } }, preventDefault() {}, ...extra });
  key('a', { ctrlKey: true }); assert.deepEqual(ids, ['a', 'c']);
  key('ArrowUp', { altKey: true }); assert.deepEqual(calls[0].slice(2), [['c'], -1]);
  key('Delete'); assert.equal(calls[1][0], 'remove'); assert.equal(calls[1][3], true);
  key('Escape'); assert.deepEqual(ids, []);
});

test('eye uses explicit hidden value, pending rows show busy, and naming submits the field', async () => {
  const story = { key: 'c', kind: 'unknown', hidden: true };
  const calls = [];
  const gestures = { hide: (...args) => calls.push(['hide', ...args]), name: (...args) => calls.push(['name', ...args]) };
  const row = render(LuniiStoryRow, { device: { ...device, pendingKeys: ['c'] }, story, gestures });
  assert.equal(row.props['aria-busy'], true);
  elements(row).find(e => e.type === Button && e.props['aria-label'] === 'Afficher').props.onClick();
  assert.equal(calls[0][0], 'hide'); assert.equal(calls[0][2], story);
  const fiche = render(LuniiFiche, { device, story, rows: [story], gestures });
  elements(fiche).find(e => e.type === 'form').props.onSubmit({ preventDefault() {}, currentTarget: { elements: { title: { value: 'Mon conte' } } } });
  assert.deepEqual(calls[1], ['name', device, story, 'Mon conte']);
});

test('official menu prints the repatriation refusal underneath the disabled item', async () => {
  const { LuniiStoryMenu } = await import('../src/components/Catalogue/lunii/LuniiStoryMenu.jsx');
  const { MenuItem } = await import('../src/components/layout/MenuPopover.jsx');
  const tree = render(LuniiStoryMenu, { device, story: { key: 'b', kind: 'official', title: 'B' } });
  const item = elements(tree).find(e => e.type === MenuItem && e.props.label === 'Rapatrier');
  assert.equal(item.props.disabled, true); assert.match(item.props.detail, /application Lunii/);
});

test('handle drops the selected group only on an explicit drop, using an insertion boundary', async () => {
  // The HTML5 handlers (onDragStart/onDrop on the row) are gone: the pointer drag is dnd-kit's,
  // read through the data attributes the rows carry. Same rule, same expected call.
  const { useLuniiDnd } = await import('../src/hooks/useLuniiDnd.js');
  const stories = [{ key: 'a' }, { key: 'b' }, { key: 'c' }];
  const calls = [];
  const lunii = { activeLuniiId: 'd', luniiDevices: [{ ...device, stories }], selection: { side: 'lunii', ids: ['a', 'c'] }, store: {}, gestures: { reorder: (...args) => calls.push(args) } };
  const panel = render(LuniiPanel, { lunii });
  const rowOf = key => render(LuniiStoryRow, elements(panel).find(e => e.type === LuniiStoryRow && e.props.story.key === key).props);
  const under = root => ({ closest: () => ({ dataset: { luniiDrop: root.props['data-lunii-drop'], deviceId: root.props['data-device-id'], rowKey: root.props['data-row-key'] } }) });
  let hovered = under(rowOf('b'));
  const app = runner(() => useLuniiDnd({ lunii, sendUi: null, elementAt: () => hovered }));
  try {
    const moved = { activatorEvent: { clientX: 5, clientY: 5 }, delta: { x: 0, y: 20 } };
    let dnd = app.render();
    dnd.handlers.onDragStart({ active: { data: { current: { kind: 'lunii-row', deviceId: 'd', key: 'a', title: 'A' } } } });
    dnd = app.render();
    assert.deepEqual(dnd.reorder, { deviceId: 'd', keys: ['a', 'c'] });
    dnd.handlers.onDragMove(moved); dnd = app.render();
    assert.equal(dnd.insertion, 'b');
    assert.equal(calls.length, 0, 'nothing is written while dragging');
    dnd.handlers.onDragEnd(moved); dnd = app.render();
    assert.deepEqual(calls[0], [lunii.luniiDevices[0], ['a', 'c'], 1]);
    assert.equal(dnd.reorder, null);
    // Cancelling writes nothing.
    dnd.handlers.onDragStart({ active: { data: { current: { kind: 'lunii-row', deviceId: 'd', key: 'a', title: 'A' } } } });
    dnd.handlers.onDragCancel(); dnd = app.render();
    assert.equal(calls.length, 1); assert.equal(dnd.reorder, null);
    // The unselected handle moves alone, to the end when released on the header.
    hovered = { closest: () => ({ dataset: { luniiDrop: 'header', deviceId: 'd' } }) };
    dnd.handlers.onDragStart({ active: { data: { current: { kind: 'lunii-row', deviceId: 'd', key: 'b', title: 'B' } } } });
    dnd.handlers.onDragEnd(moved);
    assert.deepEqual(calls[1], [lunii.luniiDevices[0], ['b'], 3]);
    // Released elsewhere (no Lunii surface): nothing is written.
    hovered = null;
    dnd.handlers.onDragStart({ active: { data: { current: { kind: 'lunii-row', deviceId: 'd', key: 'b', title: 'B' } } } });
    dnd.handlers.onDragEnd(moved);
    assert.equal(calls.length, 2);
  } finally { app.unmount(); }
});

test('a focused checkbox keeps panel shortcuts; text entry does not; Delete includes stories to tidy', () => {
  const stories = [{ key: 'a', title: 'A', kind: 'creation' }, { key: 'b', title: 'B', kind: 'creation' }];
  const orphans = [{ key: 'parked:ABCDEF00', title: 'Perle' }];
  const calls = []; let ids;
  const lunii = { luniiDevices: [{ ...device, stories, orphans }], activeLuniiId: 'd', selection: { side: 'lunii', ids: ['b', 'parked:ABCDEF00'] }, store: {}, gestures: { move: (...args) => calls.push(['move', ...args]), remove: (...args) => calls.push(['remove', ...args]) } };
  const tree = render(LuniiPanel, { lunii, onSelect: next => ids = next });
  const field = (tagName, type) => ({ closest: () => ({ tagName, type }) });
  const key = (key, target, extra = {}) => tree.props.onKeyDown({ key, target, preventDefault() {}, ...extra });
  const checkbox = field('INPUT', 'checkbox');
  key('a', checkbox, { ctrlKey: true }); assert.deepEqual(ids, ['a', 'b']);
  key('Delete', checkbox);
  assert.equal(calls[0][0], 'remove'); assert.deepEqual(calls[0][2].map(s => s.key), ['b', 'parked:ABCDEF00']); assert.equal(calls[0][3], true);
  key('ArrowUp', checkbox, { altKey: true }); key('ArrowDown', checkbox, { altKey: true });
  assert.deepEqual(calls.slice(1).map(c => [c[0], c[3]]), [['move', -1], ['move', 1]]);
  ids = undefined;
  for (const target of [field('INPUT', 'text'), field('TEXTAREA')]) {
    key('a', target, { ctrlKey: true }); key('Delete', target); key('ArrowUp', target, { altKey: true });
  }
  assert.equal(ids, undefined); assert.equal(calls.length, 3);
});

test('selection panel deletes stories to tidy and removes mixed selections through one gesture', async () => {
  const { LuniiSelectionPanel } = await import('../src/components/Catalogue/lunii/LuniiSelectionPanel.jsx');
  const listedStory = { key: 'a', title: 'A', kind: 'creation', sizeBytes: 1 };
  const orphan = { key: 'parked:ABCDEF00', title: 'Perle', orphan: true, sizeBytes: 2 };
  for (const [stories, label] of [[[orphan, { ...orphan, key: 'ABCDEF01' }], 'Supprimer'], [[listedStory, orphan], 'Retirer de la Lunii…']]) {
    const calls = [];
    const tree = render(LuniiSelectionPanel, { device, stories, gestures: { remove: (...args) => calls.push(args) } });
    const button = elements(tree).find(e => e.type === Button && e.props.className === 'lunii-remove');
    assert.equal(text(button), label); assert.equal(button.props.disabled, false);
    button.props.onClick();
    tree.props.onKeyDown({ key: 'Delete', preventDefault() {} });
    assert.deepEqual(calls, [[device, stories, true], [device, stories, true]]);
  }
});

const engineT = createTestI18n().getFixedT('fr');
// D40: the row has no "…" nor context menu; the eye and the bin are direct.
test('row: eye and bin only, the bin runs the same removal as the menu entry, orphans get put-back and delete', async () => {
  const { storyMenuEntries } = await import('../src/components/Catalogue/lunii/LuniiStoryMenu.jsx');
  const story = { key: 'a', title: 'A', kind: 'creation' };
  const calls = [];
  const gestures = { remove: (...args) => calls.push(['remove', ...args]), hide: (...args) => calls.push(['hide', ...args]) };
  const row = render(LuniiStoryRow, { device, story, gestures });
  const buttons = elements(row).filter(e => e.type === Button);
  assert.deepEqual(buttons.map(b => b.props['aria-label']).filter(l => l !== 'Réordonner'), ['Masquer', 'Retirer de la Lunii…']);
  assert.ok(!elements(row).some(e => e.props?.['aria-label'] === 'Actions de l’histoire'), 'the "…" button is gone');
  buttons.find(b => b.props['aria-label'] === 'Retirer de la Lunii…').props.onClick();
  assert.deepEqual(calls, [['remove', device, [story]]]);
  // The menu entry runs the very same gesture with the same arguments.
  storyMenuEntries({ device, story, gestures, t: engineT }).find(e => e.key === 'remove').run();
  assert.deepEqual(calls[1], calls[0]);
  const orphanCalls = [];
  const orphanGestures = { orphan: (...args) => orphanCalls.push(['orphan', ...args]), remove: (...args) => orphanCalls.push(['remove', ...args]) };
  const parked = { key: 'parked:x', orphan: true, complete: true };
  const orphanRow = render(LuniiStoryRow, { device, story: parked, gestures: orphanGestures });
  elements(orphanRow).find(e => e.type === Button && e.props['aria-label'] === 'Remettre dans la liste').props.onClick();
  elements(orphanRow).find(e => e.type === Button && e.props['aria-label'] === 'Supprimer').props.onClick();
  assert.deepEqual(orphanCalls, [['orphan', device, parked], ['remove', device, [parked]]]);
  const partial = render(LuniiStoryRow, { device, story: { key: 'partial', orphan: true, complete: false }, gestures: orphanGestures });
  const partialButtons = elements(partial).filter(e => e.type === Button);
  assert.equal(partialButtons.find(e => e.props['aria-label'] === 'Remettre dans la liste').props.disabled, true);
  assert.equal(partialButtons.find(e => e.props['aria-label'] === 'Supprimer').props.disabled, false);
  // Read-only device: the bin is disabled with the reason.
  const locked = render(LuniiStoryRow, { device, story, gestures, disabledReason: 'Lecture seule' });
  const bin = elements(locked).find(e => e.type === Button && e.props['aria-label'] === 'Retirer de la Lunii…');
  assert.equal(bin.props.disabled, true); assert.equal(bin.props.title, undefined, 'plus de title natif'); assert.equal(tipOf(locked, bin), 'Lecture seule');
  assert.equal(row.props.onContextMenu, undefined, 'no context menu on the row');
});

test('D45: a duplicate parked copy offers only Supprimer, never put-back, and is not counted by put-back-all', async () => {
  const { storyMenuEntries } = await import('../src/components/Catalogue/lunii/LuniiStoryMenu.jsx');
  const { restorableOrphans } = await import('../src/store/catalogue/luniiDevices.js');
  const calls = [];
  const gestures = { orphan: (...args) => calls.push(['orphan', ...args]), remove: (...args) => calls.push(['remove', ...args]) };
  const copy = { key: 'parked:x', orphan: true, parked: true, complete: true, duplicateOfListed: true, sizeBytes: 100 };
  const row = render(LuniiStoryRow, { device, story: copy, gestures });
  assert.match(text(row), /Copie en double/);
  assert.doesNotMatch(text(row), /Hors de la liste/);
  const note = elements(row).find(e => e.props?.className === 'lunii-orphan-note');
  assert.equal(tipOf(row, note), 'Cette histoire est déjà dans la liste : cette copie ne sert plus');
  const labels = elements(row).filter(e => e.type === Button).map(b => b.props['aria-label']).filter(l => l !== 'Réordonner');
  // Naming is intentionally excluded for every orphan, including duplicates.
  assert.deepEqual(labels, ['Supprimer']);
  elements(row).find(e => e.type === Button && e.props['aria-label'] === 'Supprimer').props.onClick();
  assert.deepEqual(calls, [['remove', device, [copy]]]);
  const keys = storyMenuEntries({ device, story: copy, gestures, t: engineT }).map(e => e.key);
  assert.ok(!keys.includes('putBack')); assert.ok(keys.includes('remove'));
  const lone = { ...copy, key: 'ABCDEF01', parked: false, duplicateOfListed: false, knownUuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' };
  const twin = { ...lone, key: 'ABCDEF02', duplicateOfListed: true };
  assert.deepEqual(restorableOrphans({ orphans: [lone, twin] }).map(o => o.key), ['ABCDEF01']);
});

test('repatriation is offered only for a story absent from the catalogue (menu, inspector, selection)', async () => {
  const { storyMenuEntries } = await import('../src/components/Catalogue/lunii/LuniiStoryMenu.jsx');
  const { LuniiSelectionPanel } = await import('../src/components/Catalogue/lunii/LuniiSelectionPanel.jsx');
  const absent = { key: 'a', title: 'A', kind: 'creation' };
  const present = { key: 'b', title: 'B', kind: 'creation', catalogueFicheId: 'fiche-b' };
  const official = { key: 'c', title: 'C', kind: 'official' };
  const offered = story => storyMenuEntries({ device, story, gestures: {}, t: engineT }).some(e => e.key === 'repatriate');
  assert.equal(offered(absent), true); assert.equal(offered(present), false); assert.equal(offered(official), true);
  assert.equal(storyMenuEntries({ device, story: official, gestures: {}, t: engineT }).find(e => e.key === 'repatriate').enabled, false);
  const inspector = story => render(LuniiFiche, { device, story, rows: [story], gestures: {} });
  const repatriate = story => elements(inspector(story)).find(e => e.type === Button && text(e).trim() === 'Rapatrier');
  assert.ok(repatriate(absent)); assert.equal(repatriate(present), undefined);
  const calls = [];
  const panel = stories => render(LuniiSelectionPanel, { device, stories, gestures: { repatriate: (...args) => calls.push(args) } });
  const button = tree => elements(tree).find(e => e.type === Button && /Rapatrier/.test(text(e)));
  const mixed = panel([absent, present, official]);
  assert.match(text(button(mixed)), /1 sur 3/);
  assert.match(tipOf(mixed, button(mixed)), /application Lunii/); assert.match(tipOf(mixed, button(mixed)), /Déjà dans ton catalogue/);
  button(mixed).props.onClick();
  assert.deepEqual(calls[0], [device, [absent]]);
  const allPresentTree = panel([present, { ...present, key: 'd' }]);
  const allPresent = button(allPresentTree);
  assert.equal(allPresent.props.disabled, true); assert.match(tipOf(allPresentTree, allPresent), /Déjà dans ton catalogue/);
});

test('dragging Lunii stories out to the catalogue repatriates the repatriable ones; refusals say why', async () => {
  const { useLuniiDnd } = await import('../src/hooks/useLuniiDnd.js');
  const { LuniiDragGhost } = await import('../src/components/Catalogue/lunii/LuniiDragGhost.jsx');
  const stories = [{ key: 'a', title: 'A', kind: 'creation' }, { key: 'b', title: 'B', kind: 'creation', catalogueFicheId: 'f' }, { key: 'c', title: 'C', kind: 'official' }, { key: 'd', title: 'D', kind: 'unknown' }];
  const calls = [];
  const dev = { ...device, stories };
  const lunii = { activeLuniiId: 'd', luniiDevices: [dev], selection: { side: 'lunii', ids: ['a', 'b', 'c'] }, store: {}, gestures: { repatriate: (...args) => calls.push(['repatriate', ...args]), reorder: (...args) => calls.push(['reorder', ...args]) } };
  let hovered = { closest: () => ({ dataset: { luniiDrop: 'catalogue' } }) };
  const app = runner(() => useLuniiDnd({ lunii, sendUi: null, elementAt: () => hovered }));
  const start = key => ({ active: { data: { current: { kind: 'lunii-row', deviceId: 'd', key, title: key.toUpperCase() } } } });
  const moved = { activatorEvent: { clientX: 5, clientY: 5 }, delta: { x: 400, y: 0 } };
  const ghost = active => text(render(LuniiDragGhost, { active, cardsById: new Map() }));
  try {
    let dnd = app.render();
    // The dragged story belongs to the selection: the whole selection travels; only the absent creation qualifies.
    dnd.handlers.onDragStart(start('a')); dnd = app.render();
    dnd.handlers.onDragMove(moved); dnd = app.render();
    assert.equal(dnd.repatriation.eligible.length, 1);
    assert.match(ghost(dnd.active), /3 histoires.*rapatrier 1 sur 3/);
    assert.equal(calls.length, 0, 'nothing is written while hovering');
    dnd.handlers.onDragEnd(moved); dnd = app.render();
    assert.deepEqual(calls, [['repatriate', dev, [stories[0]]]]);
    assert.equal(dnd.repatriation, null);
    // An unselected story alone, absent from the catalogue: all of it goes.
    calls.length = 0; lunii.selection = { side: 'catalogue', ids: [] };
    dnd.handlers.onDragStart(start('d')); dnd.handlers.onDragMove(moved); dnd = app.render();
    assert.match(ghost(dnd.active), /rapatrier dans le catalogue/);
    dnd.handlers.onDragEnd(moved);
    assert.deepEqual(calls, [['repatriate', dev, [stories[3]]]]);
    // Already in the catalogue / official: refused, with the reason, and nothing is written.
    for (const [key, reason] of [['b', /Déjà dans ton catalogue/], ['c', /application Lunii/]]) {
      calls.length = 0;
      dnd.handlers.onDragStart(start(key)); dnd.handlers.onDragMove(moved); dnd = app.render();
      assert.ok(dnd.repatriation.refusal); assert.match(ghost(dnd.active), reason);
      dnd.handlers.onDragEnd(moved); assert.equal(calls.length, 0);
    }
    // A Lunii that is busy refuses with its own message.
    lunii.luniiDevices = [{ ...dev, busy: true }];
    dnd.handlers.onDragStart(start('a')); dnd.handlers.onDragMove(moved); dnd = app.render();
    assert.equal(dnd.repatriation.refusal, 'write'); dnd.handlers.onDragEnd(moved); assert.equal(calls.length, 0);
    // Reordering inside the panel is unchanged: no repatriation state, no repatriate call.
    lunii.luniiDevices = [dev];
    hovered = { closest: () => ({ dataset: { luniiDrop: 'header', deviceId: 'd' } }) };
    dnd.handlers.onDragStart(start('d')); dnd.handlers.onDragMove(moved); dnd = app.render();
    assert.equal(dnd.repatriation, null);
    dnd.handlers.onDragEnd(moved);
    assert.deepEqual(calls, [['reorder', dev, ['d'], 4]]);
  } finally { app.unmount(); }
});

test('mixed orphan banner offers restoration and deletion, refused with their reasons', () => {
  const orphans = [
    { key: '00000003', complete: true, knownUuid: '00000000-0000-4000-8000-000000000003', sizeBytes: 10 },
    { key: '00000004', complete: false, knownUuid: '00000000-0000-4000-8000-000000000004', sizeBytes: 10 },
    { key: '00000005', complete: true, knownUuid: null, sizeBytes: 10 },
  ];
  const restored = [];
  const gestures = { restoreOrphans: value => restored.push(value) };
  const ready = { ...device, orphans, banner: ['orphans'] };
  let buttons = elements(render(LuniiBanner, { kind: 'orphans', device: ready, gestures })).filter(e => e.type === Button);
  assert.equal(buttons.length, 2);
  assert.match(text(buttons[0]), /^Remettre dans la liste$/);
  assert.equal(buttons[0].props.disabled, false);
  buttons[0].props.onClick(); assert.deepEqual(restored, [ready]);
  // Writing refused: disabled, with the refusal as reason.
  for (const value of [{ ...ready, state: 'readOnly' }, { ...ready, busy: true }]) {
    const refused = render(LuniiBanner, { kind: 'orphans', device: value, gestures });
    for (const button of elements(refused).filter(e => e.type === Button)) {
      assert.equal(button.props.disabled, true); assert.ok(tipOf(refused, button));
    }
  }
  // Nothing complete and identified: disabled, with its own reason.
  const none = { ...ready, orphans: orphans.slice(1) };
  const noneTree = render(LuniiBanner, { kind: 'orphans', device: none, gestures });
  const button = elements(noneTree).find(e => e.type === Button);
  assert.equal(button.props.disabled, true); assert.match(tipOf(noneTree, button), /pas identifiées.*seulement être supprimées/);
});

test('an orphan with a known title shows it instead of « Histoire sans titre »', () => {
  const tree = render(LuniiStoryRow, { story: { key: '00000003', orphan: true, complete: true, title: 'Le loup', kind: 'official' }, selected: false, onSelect() {} });
  assert.match(text(tree), /Le loup/); assert.doesNotMatch(text(tree), /sans titre/);
});

test('D42 banner: a damaged list explained by a backup, or stories outside the list', () => {
  const orphans = [1, 2, 3].map(n => ({ key: `0000000${n}`, complete: true, knownUuid: `00000000-0000-4000-8000-00000000000${n}`, sizeBytes: 10 }));
  const lost = render(LuniiBanner, { kind: 'orphans', device: { ...device, orphans, listLost: true }, gestures: {} });
  assert.match(text(lost), /La liste des histoires de la Lunii a été abîmée/);
  assert.match(text(lost), /débranchée pendant une écriture\. Les 3 histoires sont intactes, mais l’enfant ne les voit plus\./);
  assert.match(text(elements(lost).find(e => e.type === Button)), /Remettre les histoires dans la liste/);
  const outside = render(LuniiBanner, { kind: 'orphans', device: { ...device, orphans: orphans.slice(0, 1), listLost: false }, gestures: {} });
  assert.match(text(outside), /1 histoire hors de la liste/);
  assert.match(text(outside), /Elle est sur la Lunii mais l’enfant ne la voit pas \(/);
  assert.doesNotMatch(text(lost) + text(outside), /à ranger/);
});


test('an untitled story has a permanent naming action that selects like the row', () => {
  const calls = [];
  const onSelect = event => calls.push(event);
  for (const title of [null, 'Une histoire']) {
    const tree = render(LuniiStoryRow, { device, story: { key: 'story', title }, onSelect });
    const pencil = elements(tree).find(e => e.type === Button && e.props.className === 'lunii-story-name');
    if (title) { assert.equal(pencil, undefined); continue; }
    assert.equal(pencil.props['aria-label'], 'Nommer cette histoire');
    assert.equal(tipOf(tree, pencil), 'Nommer cette histoire');
    assert.equal(pencil.props.onClick, elements(tree).find(e => e.props.className === 'lunii-story-select').props.onClick);
    const event = { ctrlKey: false, shiftKey: false };
    pencil.props.onClick(event);
    assert.deepEqual(calls, [event]);
    assert.doesNotMatch(text(tree), /Nommer depuis/);
  }
});

test('Lunii minimum survives narrow parents, old preferences and a collapsed display', async () => {
  const { useLuniiPanelWidth } = await import('../src/hooks/useLuniiPanelWidth.js');
  const app = runner(() => useLuniiPanelWidth(1, true, true));
  try {
    assert.equal(app.render().value, 330);
    assert.equal(app.render().max, 330);
  } finally { app.unmount(); }
  const tree = render(LuniiPanel, { lunii: { luniiDevices: [device], selection: { side: 'catalogue', ids: [] }, luniiPanelWidth: 1, store: {} } });
  assert.equal(tree.props.style.width, 330);
  assert.equal(tree.props.style.minWidth, 330);
  const collapsed = render(LuniiPanel, { lunii: { luniiDevices: [device], selection: { side: 'catalogue', ids: [] }, luniiPanelWidth: 1, luniiPanelCollapsed: true, store: {} } });
  assert.equal(collapsed.props.style.width, 48);
  assert.equal(collapsed.props.style.minWidth, 48);
});


test('grid reserve yields first, then fiche only below the combined side-panel minima', async () => {
  const { luniiPanelMaxWidth } = await import('../src/hooks/useLuniiPanelWidth.js');
  for (const [parent, ficheWidth, gridWidth] of [[1010, 320, 360], [1000, 320, 350], [920, 320, 270], [650, 320, 0], [600, 270, 0]]) {
    const luniiWidth = luniiPanelMaxWidth(parent, true);
    const bounds = ficheWidthBounds(parent, 1100, luniiWidth);
    assert.equal(luniiWidth, 330);
    assert.deepEqual(bounds, { min: ficheWidth, max: ficheWidth });
    assert.equal(parent - luniiWidth - bounds.max, gridWidth);
  }
});

test('the dedicated zone under the last story shows the end insertion and drops through the shared gesture', async () => {
  const { useLuniiDnd } = await import('../src/hooks/useLuniiDnd.js');
  const { createLuniiGestures } = await import('../src/store/catalogue/luniiGestures.js');
  const dev = { ...device, stories: [{ key: 'a' }, { key: 'b' }, { key: 'c' }] };
  const writes = [];
  const lunii = { luniiDevices: [dev], selection: { side: 'lunii', ids: [] }, store: { mutate: async (...args) => { writes.push(args); } } };
  lunii.gestures = createLuniiGestures(lunii, () => '', async () => true, () => {});
  let target = 'end';
  const elementAt = () => ({ closest: () => ({ dataset: { luniiDrop: target, deviceId: 'd' } }) });
  const app = runner(() => useLuniiDnd({ lunii, elementAt }));
  const moved = { activatorEvent: { clientX: 5, clientY: 5 }, delta: { x: 0, y: 20 } };
  try {
    for (const key of ['a', 'c']) {
      let dnd = app.render();
      dnd.handlers.onDragStart({ active: { data: { current: { kind: 'lunii-row', deviceId: 'd', key } } } });
      dnd.handlers.onDragMove(moved); dnd = app.render();
      assert.equal(dnd.insertion, key === 'a' ? 3 : null);
      const panel = render(LuniiPanel, { lunii, dnd });
      assert.equal(elements(panel).filter(e => e.props?.className === 'lunii-insertion-end').length, key === 'a' ? 1 : 0);
      assert.ok(elements(panel).filter(e => e.type === LuniiStoryRow).every(e => !e.props.insertion));
      const zone = elements(panel).find(e => e.props?.['data-lunii-drop'] === 'end');
      assert.equal(zone.props.className, 'lunii-reorder-end');
      assert.equal(zone.props['data-device-id'], 'd');
      for (const surface of ['banner', 'list padding', 'scrollbar', 'sending row']) {
        target = 'scroll';
        dnd.handlers.onDragMove(moved); dnd = app.render();
        assert.equal(dnd.insertion, null, surface);
        dnd.handlers.onDragEnd(moved); dnd = app.render();
        assert.equal(writes.length, key === 'a' ? 0 : 1, `${surface}: no write`);
        dnd.handlers.onDragStart({ active: { data: { current: { kind: 'lunii-row', deviceId: 'd', key } } } });
      }
      target = 'end';
      dnd.handlers.onDragMove(moved); dnd = app.render();
      dnd.handlers.onDragEnd(moved); dnd = app.render();
      assert.equal(dnd.insertion, null);
    }
    assert.deepEqual(writes, [['d', 'reorder', [{ rowKey: null, index: 3 }], ['a'], { a: '' }]], 'C at the end writes nothing');
  } finally { app.unmount(); }
});

// The banner delegates to the row's removal gesture and its confirmation.
test('incomplete stories alone offer deletion only; complete stories offer restoration only', () => {
  const complete = { key: 'full', complete: true, knownUuid: 'uuid', sizeBytes: 30 };
  const incomplete = { key: '.story-studio-install-test', complete: false, sizeBytes: 20 };
  const calls = [];
  const gestures = { remove: (...args) => calls.push(args) };
  for (const orphans of [[incomplete], [complete], [complete, incomplete]]) {
    const value = { ...device, orphans };
    const tree = render(LuniiBanner, { kind: 'orphans', device: value, gestures });
    const buttons = elements(tree).filter(e => e.type === Button);
    assert.deepEqual(buttons.map(text), orphans.length === 2 ? ['Remettre dans la liste', 'Supprimer'] : orphans[0].complete ? ['Remettre dans la liste'] : ['Supprimer']);
    const remove = buttons.find(e => text(e) === 'Supprimer');
    if (remove) {
      assert.equal(text(elements(tree).filter(e => e.type === 'h3').at(-1)).trim(), 'Histoires incomplètes (20 byte)');
      remove.props.onClick();
      assert.deepEqual(calls.at(-1), [value, [{ ...incomplete, orphan: true }]]);
      for (const patch of [{ state: 'readOnly' }, { busy: true }]) {
        const refused = render(LuniiBanner, { kind: 'orphans', device: { ...value, ...patch }, gestures });
        const button = elements(refused).find(e => e.type === Button && text(e) === 'Supprimer');
        assert.equal(button.props.disabled, true);
        assert.ok(tipOf(refused, button));
      }
    } else assert.doesNotMatch(text(tree), /Histoires incomplètes/);
  }
});

test('banner removal includes parked leftovers and excludes pending removals and incomplete duplicates', () => {
  const incomplete = { key: 'partial', complete: false, title: 'Partielle', sizeBytes: 20 };
  const pending = { ...incomplete, key: 'pending', sizeBytes: 300 };
  const duplicate = { ...incomplete, key: 'duplicate', duplicateOfListed: true, sizeBytes: 4000 };
  const parked = { ...incomplete, key: 'parked:partial', parked: true, sizeBytes: 50000 };
  const calls = [];
  const gestures = { remove: (...args) => calls.push(args) };
  const value = { ...device, queueActive: true, busy: true, orphans: [incomplete, pending, duplicate, parked], banner: ['orphans'] };
  const lunii = { luniiDevices: [value], selection: { side: 'catalogue', ids: [] }, store: {}, gestures,
    luniiQueue: { d: [{ id: 'send', kind: 'send', state: 'running', keys: [] }, { id: 'remove', kind: 'remove', state: 'queued', keys: [pending.key] }] } };
  // Render the panel first to verify the queue marks reach its banner.
  const panel = render(LuniiPanel, { lunii });
  const banner = elements(panel).find(e => e.type === LuniiBanner);
  const tree = render(LuniiBanner, banner.props);
  assert.equal(text(elements(tree).find(e => e.type === 'h3')).trim(), 'Histoires incomplètes (50 kB)');
  const button = elements(tree).find(e => e.type === Button);
  assert.equal(button.props.disabled, false);
  button.props.onClick();
  assert.deepEqual(calls, [[value, [{ ...incomplete, orphan: true }, { ...parked, orphan: true }]]]);
  // Only the pending leftover remains: keep the action visible with the row's reason.
  const allWaiting = render(LuniiBanner, { ...banner.props, device: { ...value, orphans: [pending, duplicate] } });
  const disabled = elements(allWaiting).find(e => e.type === Button);
  assert.equal(text(elements(allWaiting).find(e => e.type === 'h3')).trim(), 'Histoires incomplètes (300 byte)');
  assert.equal(disabled.props.disabled, true);
  assert.equal(tipOf(allWaiting, disabled), 'Retrait en attente : annule-le d’abord pour agir sur cette histoire.');
  for (const orphans of [[parked], [duplicate, parked]]) {
    const parkedTree = render(LuniiBanner, { kind: 'orphans', device: { ...device, orphans }, gestures });
    const remove = elements(parkedTree).find(e => e.type === Button);
    assert.equal(text(remove), 'Supprimer');
    assert.equal(remove.props.disabled, false);
    remove.props.onClick();
    assert.deepEqual(calls.at(-1)[1], [{ ...parked, orphan: true }]);
  }
});

test('banner restoration excludes stories awaiting removal and explains when all candidates await removal', async () => {
  const { createLuniiGestures } = await import('../src/store/catalogue/luniiGestures.js');
  const { queuedMarks, removalPending } = await import('../src/store/catalogue/luniiQueueView.js');
  const first = { key: 'first', complete: true, knownUuid: 'uuid-first', sizeBytes: 20 };
  const pending = { ...first, key: 'pending', knownUuid: 'uuid-pending', sizeBytes: 300 };
  const writes = [];
  const gestures = createLuniiGestures({ store: { mutate: (...args) => writes.push(args) } }, engineT);
  for (const action of ['remove', 'delete']) {
    const marks = action === 'remove' ? queuedMarks([{ id: 'remove', kind: 'remove', state: 'queued', keys: [pending.key] }]) : new Map([[pending.key, [{ entryId: 'delete', action }]]]);
    assert.equal(removalPending(marks.get(pending.key)), true);
    const tree = render(LuniiBanner, { kind: 'orphans', device: { ...device, queueActive: true, busy: true, orphans: [first, pending] }, gestures, marks });
    assert.match(text(tree), /2 histoires hors de la liste/);
    assert.match(text(tree), /320 byte/);
    const button = elements(tree).find(e => e.type === Button);
    assert.equal(button.props.disabled, false);
    button.props.onClick();
    assert.deepEqual(writes.at(-1), ['d', 'restoreOrphans', [[{ key: first.key, knownUuid: first.knownUuid }]], [first.key], { [first.key]: first.title ?? '' }]);
    const allWaiting = render(LuniiBanner, { kind: 'orphans', device: { ...device, orphans: [pending] }, gestures, marks });
    assert.match(text(allWaiting), /1 histoire hors de la liste/);
    assert.match(text(allWaiting), /300 byte/);
    const disabled = elements(allWaiting).find(e => e.type === Button);
    assert.equal(disabled.props.disabled, true);
    assert.equal(tipOf(allWaiting, disabled), 'Retrait en attente : annule-le d’abord pour agir sur cette histoire.');
  }
});

test('untitled orphans never offer a naming pencil', () => {
  for (const complete of [true, false]) {
    const tree = render(LuniiStoryRow, { device, story: { key: 'orphan', orphan: true, complete }, onSelect() {} });
    assert.equal(elements(tree).find(e => e.type === Button && e.props.className === 'lunii-story-name'), undefined);
  }
});

test('engine orphan banners never render an empty section, including parked and pending stories', () => {
  for (const complete of [false, true]) for (const parked of [false, true]) for (const pending of [false, true]) {
    const story = { key: 'orphan', complete, parked, sizeBytes: 123, knownUuid: 'uuid' };
    const marks = pending ? new Map([[story.key, [{ action: 'remove' }]]]) : new Map();
    const tree = render(LuniiBanner, { kind: 'orphans', device: { ...device, orphans: [story, { ...story, key: 'duplicate', duplicateOfListed: true }] }, marks });
    assert.ok(elements(tree).some(e => e.type === 'h3' && text(e).trim()));
    assert.ok(elements(tree).some(e => e.type === Button));
    assert.doesNotMatch(text(tree), /\(0 byte\)/);
  }
});
