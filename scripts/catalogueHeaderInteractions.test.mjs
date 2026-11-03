import { catalogueViewFixture } from './catalogueFixtures.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'rolldown/experimental';
import { runner } from './reactHookDriver.mjs';
const { useCatalogueShortcuts } = await import('../src/hooks/useCatalogueShortcuts.js');
registerHooks({ load(url, context, next) {
  if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
  if (url.endsWith('.jsx')) return { format: 'module', source: `import * as InteractionReact from '${new URL('../node_modules/react/index.js', import.meta.url).href}';\n` + transformSync(fileURLToPath(url), readFileSync(fileURLToPath(url), 'utf8'), { jsx: { runtime: 'classic', pragma: 'InteractionReact.createElement', pragmaFrag: 'InteractionReact.Fragment' } }).code, shortCircuit: true };
  return next(url, context);
} });
const { UndoNotice } = await import('../src/components/Catalogue/UndoNotice.jsx');
const { ContentDialog } = await import('../src/components/common/ContentDialog.jsx');

test('catalogue Ctrl+Z preserves text undo and is suspended in menus/dialogues; F/A/Escape remain wired', () => {
  const previous = globalThis.window; let listener; let blocked = false;
  const calls = []; const noop = () => {};
  globalThis.window = { addEventListener: (_, fn) => { listener = fn; }, removeEventListener: noop };
  const ui = runner(() => useCatalogueShortcuts({ blocked: () => blocked, undo: () => calls.push('undo'), search: () => calls.push('search'), selectAll: () => calls.push('all'), clear: () => { calls.push('clear'); return true; } }));
  const key = (value, target = { tagName: 'BUTTON' }, ctrl = true) => {
    let prevented = false;
    listener({ key: value, code: value === 'Escape' ? 'Escape' : `Key${value.toUpperCase()}`, ctrlKey: ctrl, target, preventDefault() { prevented = true; } });
    return prevented;
  };
  try {
    ui.render(); ui.flush();
    assert.equal(key('z'), true);
    for (const target of [{ tagName: 'INPUT' }, { tagName: 'TEXTAREA' }, { isContentEditable: true }, { closest: () => ({}) }]) assert.equal(key('z', target), false);
    blocked = true; assert.equal(key('z'), false); blocked = false;
    assert.equal(key('f'), true); assert.equal(key('k'), true); assert.equal(key('a'), true); assert.equal(key('Escape', undefined, false), true);
    assert.deepEqual(calls, ['undo', 'search', 'search', 'all', 'clear']);
  } finally { ui.unmount(); globalThis.window = previous; }
});

test('undo notice lasts ten seconds for a new outcome, not for restored history', () => {
  const previousTimer = globalThis.setTimeout; const previousClear = globalThis.clearTimeout;
  let expire; let noticeToken = null; let undone = 0;
  globalThis.setTimeout = (fn, delay) => { assert.equal(delay, 10000); expire = fn; return 1; };
  globalThis.clearTimeout = () => {};
  const ui = runner(() => UndoNotice({ state: { status: 'ready', token: 'latest' }, noticeToken, busy: false, onUndo: () => undone++ }));
  try {
    assert.equal(ui.render(), null); ui.flush();
    noticeToken = 'latest'; ui.render(); ui.flush();
    const toast = ui.render(); assert.equal(toast.props.role, 'status');
    toast.props.children[2].props.onClick(); assert.equal(undone, 1);
    expire(); assert.equal(ui.render(), null);
  } finally { ui.unmount(); globalThis.setTimeout = previousTimer; globalThis.clearTimeout = previousClear; }
});

test('rich content dialog opens modally, closes on Escape and restores its trigger', () => {
  const previousWindow = globalThis.window; const previousDocument = globalThis.document;
  let escape; let closed = 0; let restored = 0; let modal = 0;
  globalThis.window = { addEventListener: (_, fn) => { escape = fn; }, removeEventListener() {} };
  globalThis.document = { activeElement: { isConnected: true, focus: () => restored++ } };
  const ui = runner(() => ContentDialog({ label: 'Catalogue', onClose: () => closed++, children: null }));
  try {
    const tree = ui.render(); tree.props.ref.current = { showModal: () => modal++, close: () => modal-- };
    ui.flush(); assert.equal(modal, 1);
    escape({ key: 'Escape', preventDefault() {} }); assert.equal(closed, 1);
    ui.unmount(); assert.equal(modal, 0); assert.equal(restored, 1);
  } finally { globalThis.window = previousWindow; globalThis.document = previousDocument; }
});

const { CatalogueToolbar } = await import('../src/components/Catalogue/CatalogueToolbar.jsx');
const { initialFilterState, filterSummary, filterStateReducer } = await import('../src/store/catalogue/filterState.js');

function descendants(node) {
  if (!node || typeof node !== 'object') return [];
  return [node, ...[node.props?.children].flat(Infinity).flatMap(descendants)];
}

test('palette focus, text, keyboard, outside dismissal and criterion menus stay wired', () => {
  const previousDocument = globalThis.document;
  const listeners = new Map();
  globalThis.document = { addEventListener: (key, fn) => listeners.set(key, fn), removeEventListener: key => listeners.delete(key) };
  let state = initialFilterState(); const opened = [];
  const props = { searchRef: { current: null }, cards: [{ id: 'pack', title: 'Lune', exemplars: [], tags: [] }], onOpenFiche: id => opened.push(id) };
  const ui = runner(() => CatalogueToolbar({ ...props, view: { ...catalogueViewFixture(), ...state, summary: filterSummary(state), sort: { key: 'title', direction: 'asc' }, view: 'cards', setQuery: value => { state = { ...state, query: value }; }, dispatch: action => { state = filterStateReducer(state, action); } } }));
  const render = () => {
    const tree = ui.render(); tree.props.ref.current = { contains: target => target === 'inside' }; ui.flush();
    const nodes = descendants(tree);
    return { nodes, search: nodes.find(node => node.props?.id === 'catalogue-search'), palette: nodes.find(node => node.props?.id === 'catalogue-palette'), menu: nodes.find(node => node.type?.name === 'MenuPopover' && node.props.trigger().props.className?.includes('catalogue-filter-trigger')) };
  };
  const key = value => { const event = { key: value, preventDefault() {}, stopPropagation() {} }; render().search.props.onKeyDown(event); };
  try {
    let surface = render(); assert.equal(surface.palette, undefined);
    surface.search.props.onFocus(); surface.search.props.onChange({ target: { value: 'Lune' } });
    surface = render(); assert.equal(surface.search.props['aria-expanded'], true);
    key('ArrowDown'); assert.equal(render().search.props['aria-activedescendant'], 'catalogue-palette-0');
    key('Enter'); assert.deepEqual(opened, ['pack']); assert.equal(render().palette, undefined);
    render().search.props.onFocus(); key('Escape'); assert.equal(render().palette, undefined); assert.equal(state.query, 'Lune');
    key('Escape'); assert.equal(state.query, '');
    render().search.props.onChange({ target: { value: '5' } }); key('ArrowUp'); key('Enter');
    assert.equal(state.filters.age.max, 5); assert.equal(state.query, ''); assert.equal(render().palette, undefined);
    render().search.props.onChange({ target: { value: 'Lune' } });
    listeners.get('pointerdown')({ target: 'inside' }); assert.ok(render().palette);
    listeners.get('pointerdown')({ target: 'outside' }); assert.equal(render().palette, undefined);
    surface = render(); surface.menu.props.trigger().props.onClick(); surface = render(); assert.equal(surface.menu.props.open, true);
    const criterion = descendants(surface.menu.props.children).find(node => node.key === 'favoritesOnly');
    criterion.props.onClick({ currentTarget: {} }); surface = render();
    assert.equal(state.filters.favoritesOnly, true);
    // Boolean filters toggle directly while the menu stays open.
    assert.equal(surface.menu.props.open, true);
    const summary = surface.nodes.find(node => node.type?.name === 'ActiveFilterSummary');
    assert.equal(summary.props.editingFamily, null);
    assert.equal(summary.props.renderEditor('favoritesOnly').props.family, 'favoritesOnly');
    summary.props.onClose();
    assert.equal(render().nodes.find(node => node.type?.name === 'ActiveFilterSummary').props.editingFamily, null);
  } finally { ui.unmount(); globalThis.document = previousDocument; }
});

const { TagMenuEntries } = await import('../src/components/Catalogue/tags/TagSubmenu.jsx');
const { MenuPopover } = await import('../src/components/layout/MenuPopover.jsx');
test('tag filter cascade: counted checkboxes, no search field, no any/all radios or manager entry', () => {
  const changes = [];
  let value = { ids: ['n'], mode: 'any' };
  const ui = runner(() => TagMenuEntries({ tags: [{ id: 'n', label: 'Noël' }, { id: 'a', label: 'Animaux' }], cards: [], targets: [], filterValue: value, onFilterChange: next => { value = next; changes.push(next); } }));
  const render = () => { const tree = ui.render(); ui.flush(); return descendants(tree); };
  try {
    let nodes = render();
    assert.equal(nodes.some(node => node.type === 'input'), false, 'aucun champ de recherche dans le sous-menu');
    assert.deepEqual(nodes.filter(node => node.props?.role === 'menuitemcheckbox').map(node => node.props['aria-checked']), [true, false]);
    nodes.find(node => node.props?.role === 'menuitemcheckbox' && node.props['aria-checked'] === false).props.onClick();
    assert.deepEqual(value, { ids: ['n', 'a'], mode: 'any' });
    nodes = render(); nodes.filter(node => node.props?.role === 'menuitemcheckbox')[0].props.onClick();
    assert.deepEqual(value.ids, ['a']);
    nodes = render();
    assert.deepEqual(nodes.filter(node => node.props?.role === 'menuitemradio'), [], 'plus de bascule « Au moins une / Toutes »');
    render().find(node => node.props?.role === 'menuitemcheckbox').props.onClick();
    assert.equal(value.mode, 'any', 'cocher une étiquette produit toujours « any »');
    assert.deepEqual(render().filter(node => node.props?.role === 'menuitem'), []);
    assert.equal(changes.length, 3);
  } finally { ui.unmount(); }
});
test('click menus focus their entries and support arrows for criterion radio/checkbox controls', () => {
  const previousDocument = globalThis.document; const previousWindow = globalThis.window;
  globalThis.document = { addEventListener() {}, removeEventListener() {}, activeElement: null };
  globalThis.window = { addEventListener() {}, removeEventListener() {}, innerWidth: 1000 };
  let open = false; let title = 'Add'; let focused = 0;
  const items = [0, 1].map(() => ({ focus: () => focused++ }));
  const ui = runner(() => MenuPopover({ open, title, activation: 'click', trigger: () => null, onOpenChange() {} }));
  const render = () => {
    const tree = ui.render(); tree.props.ref.current = { getBoundingClientRect: () => null, closest: () => null, querySelectorAll: selector => { assert.match(selector, /menuitemradio/); assert.match(selector, /menuitemcheckbox/); return items; } };
    const menu = descendants(tree).find(node => node.props?.role === 'menu');
    if (menu) menu.props.ref.current = { getBoundingClientRect: () => null, querySelector: () => items[0] };
    ui.flush(); return tree;
  };
  try {
    let tree = render(); assert.equal(tree.props.onFocus, undefined); assert.equal(tree.props.onPointerEnter, undefined);
    open = true; tree = render(); assert.equal(focused, 1);
    globalThis.document.activeElement = items[0]; tree.props.onKeyDown({ key: 'ArrowDown', preventDefault() {} }); assert.equal(focused, 2);
    title = 'Kind'; render(); assert.equal(focused, 3);
  } finally { ui.unmount(); globalThis.document = previousDocument; globalThis.window = previousWindow; }
});

test('Format replaces Type and opens a multi-value cascade like Language in FR/EN/IT', async () => {
  const { default: i18next } = await import('i18next');
  const { createTestI18n } = await import('./i18nTestSetup.mjs');
  for (const lng of ['fr', 'en', 'it']) {
    const engine = createTestI18n();
    await i18next.init({ ...engine.options, resources: engine.options.resources, lng });
    const state = initialFilterState();
    const ui = runner(() => CatalogueToolbar({ view: { ...catalogueViewFixture(), ...state, summary: [], sort: { key: 'title', direction: 'asc' }, view: 'cards' }, cards: [], searchRef: { current: null } }));
    const menu = () => descendants(ui.render()).find(node => node.type?.name === 'MenuPopover' && node.props.label === engine.t('catalogue:filters.title', { lng }));
    try {
      menu().props.trigger().props.onClick();
      const nodes = descendants(menu().props.children);
      const entries = nodes.filter(node => node.type === 'button' && ['menuitem', 'menuitemcheckbox'].includes(node.props.role));
      assert.deepEqual(entries.map(node => node.key), ['favoritesOnly', 'incompleteOnly', 'missingFilesOnly', 'hideOfficial']);
      assert.deepEqual(entries.map(node => node.props.children.find(child => child?.type === 'span' && !child.props.className && typeof child.props.children === 'string')?.props.children), [
        'filter.favorites.only', 'palette.incomplete', 'filter.missingFiles.label', 'filter.hideOfficial.label',
      ].map(key => engine.t(`catalogue:${key}`, { lng })));
      // Étiquettes, Format et Langue s'ouvrent en cascade à côté du menu (MenuSubmenu), jamais à sa place.
      const cascades = nodes.filter(node => node.type?.name === 'MenuSubmenu');
      assert.deepEqual(cascades.map(node => node.key), ['tags', 'formats', 'languages']);
      assert.deepEqual(cascades.map(node => node.props.label), ['filter.tags.label', 'filter.family.format', 'filter.family.language'].map(key => engine.t(`catalogue:${key}`, { lng })));
      const trigger = cascades[1].props.trigger({ ref() {}, 'aria-haspopup': 'menu', 'aria-expanded': false, onClick() {}, onKeyDown() {} });
      assert.equal(trigger.props.role, 'menuitem'); assert.equal(trigger.props['aria-haspopup'], 'menu'); assert.equal(trigger.props['aria-expanded'], false);
      assert.equal(cascades[0].props.children.type.name, 'TagMenuEntries');
      assert.equal(cascades[1].props.children.type.name, 'CatalogueFilterBar');
      assert.equal(cascades[1].props.children.props.family, 'formats');
      assert.equal(cascades[2].props.children.props.family, 'languages');
    } finally { ui.unmount(); }
  }
});
