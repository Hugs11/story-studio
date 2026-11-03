import './chromeBench.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import i18next from 'i18next';
import { mountSurface } from './chromeBench.mjs';
import { createTestI18n } from './i18nTestSetup.mjs';
import { initialFilterState, filterSummary, filterStateReducer } from '../src/store/catalogue/filterState.js';
import { runPipeline } from '../src/store/catalogue/pipeline.js';
import { card } from './catalogueFixtures.mjs';
const { CatalogueToolbar } = await import('../src/components/Catalogue/CatalogueToolbar.jsx');
const { CatalogueEmptyState } = await import('../src/components/Catalogue/CatalogueEmptyState.jsx');
const { CatalogueViewControls } = await import('../src/components/Catalogue/CatalogueViewControls.jsx');
const { CatalogueStatusBar } = await import('../src/components/Catalogue/CatalogueStatusBar.jsx');
const { ListView } = await import('../src/components/Catalogue/views/ListView.jsx');
const { CATALOGUE_COLUMNS } = await import('../src/store/catalogue/listColumns.js');

async function language(lng = 'fr') {
  const engine = createTestI18n();
  await i18next.init({ ...engine.options, resources: engine.options.resources, lng });
  return engine;
}

test('filtered emptiness cites query and filters and removes each criterion independently in FR/EN/IT', async () => {
  for (const lng of ['fr', 'en', 'it']) {
    const engine = await language(lng);
    let state = initialFilterState();
    state.query = 'badabodo'; state.filters.favoritesOnly = true; state.filters.age = { min: null, max: 5, hideUnknown: false };
    let cleared = 0;
    const view = { ...state, summary: filterSummary(state), dispatch: action => { state = filterStateReducer(state, action); }, setQuery: value => { state.query = value; } };
    const surface = mountSurface(React.createElement(CatalogueEmptyState, { view, sources: [{ status: 'active', availability: 'available' }], filtered: true, onClearFilters: () => cleared++ }));
    assert.match(surface.html, /data-empty-state="filtered"/);
    assert.match(surface.html, /badabodo/);
    assert.ok(surface.html.includes(engine.t('catalogue:empty.filtered.title', { lng })));
    const buttons = surface.elements.filter(e => e.type === 'button');
    assert.equal(buttons.length, 4);
    buttons[1].props.onClick(); assert.equal(state.filters.age.max, null); assert.equal(state.filters.favoritesOnly, true);
    buttons[2].props.onClick(); assert.equal(state.filters.favoritesOnly, false); assert.equal(state.query, 'badabodo');
    buttons[0].props.onClick(); assert.equal(state.query, '');
    buttons[3].props.onClick(); assert.equal(cleared, 1);
  }
});

test('search and filtered counts use N/total and the status counts copies separately', async () => {
  await language();
  const state = initialFilterState(); state.filters.favoritesOnly = true;
  const cards = [card({ id: 'a', favorite: true }), card({ id: 'b' })]; cards[0].favorite = true;
  const view = { ...state, summary: filterSummary(state), filtered: true, total: 78, result: { counts: { fiches: 12, exemplaires: 15 } }, sort: { key: 'title', direction: 'asc' }, view: 'cards' };
  const toolbar = mountSurface(React.createElement(CatalogueToolbar, { view, cards, searchRef: { current: null } }));
  assert.match(toolbar.html, /<span class="catalogue-result-number">12<\/span> sur 78/); // seul le nombre est en mono
  const status = mountSurface(React.createElement(CatalogueStatusBar, { view, cards })); assert.match(status.html, /12 sur 78/);
  const unfiltered = mountSurface(React.createElement(CatalogueStatusBar, { view: { ...view, filtered: false, result: { counts: { fiches: 78, exemplaires: 81 } } } })); assert.match(unfiltered.html, /78 fiches · 81 exemplaires/);
  const search = mountSurface(React.createElement(CatalogueToolbar, { view: { ...view, query: 'badabodo' }, cards, searchRef: { current: null } })); assert.match(search.html, /<span class="catalogue-result-number">12<\/span> résultats pour/); assert.match(search.html, /badabodo/);
  assert.equal(runPipeline(cards, { filters: { favoritesOnly: true } }).counts.fiches, 1);
});

test('panel toggle stays available when hidden, and column picker belongs to the list header', async () => {
  await language();
  let toggled = 0;
  for (const mode of ['cards', 'list']) {
    const view = { view: mode, fichePanelVisible: false, toggleFichePanel: () => toggled++, listColumns: { visibleCols: new Set(CATALOGUE_COLUMNS.defaultVisible), colWidths: {} } };
    const controls = mountSurface(React.createElement(CatalogueViewControls, { view }));
    const toggles = controls.elements.filter(e => e.type === 'button' && typeof e.props['aria-pressed'] === 'boolean');
    assert.equal(toggles.length, 3); assert.equal(toggles[2].props['aria-pressed'], false); assert.equal(toggles[2].props['aria-label'], 'Afficher le panneau'); toggles[2].props.onClick();
    assert.doesNotMatch(controls.html, /me-col-picker/);
    const list = mountSurface(React.createElement(ListView, { items: [], view }));
    assert.match(list.html, /<thead>[\s\S]*me-col-picker[\s\S]*<\/thead>/);
  }
  assert.equal(toggled, 2);
});

test('age trigger describes the applied maximum, precise range and open minimum in FR/EN/IT', async () => {
  for (const lng of ['fr', 'en', 'it']) {
    const engine = await language(lng);
    for (const [age, key, params] of [
      [{ min: null, max: 5 }, 'palette.forAge', { count: 5 }],
      [{ min: 3, max: 7 }, 'age.range', { min: 3, count: 7 }],
      [{ min: 3, max: null }, 'palette.minimumAge', { count: 3 }],
    ]) {
      const state = initialFilterState(); state.filters.age = { ...age, hideUnknown: false };
      const view = { ...state, summary: filterSummary(state), result: { counts: { fiches: 1 } }, sort: { key: 'title', direction: 'asc' }, view: 'cards' };
      const surface = mountSurface(React.createElement(CatalogueToolbar, { view, cards: [], searchRef: { current: null } }));
      const trigger = surface.elements.find(e => e.type === 'button' && e.props['aria-haspopup'] === 'menu' && (Array.isArray(e.props.children) ? e.props.children[0] : e.props.children) === engine.t(`catalogue:${key}`, { ...params, lng })); // le libellé est suivi du chevron
      assert.ok(trigger, `${lng}: ${key}`);
    }
  }
});

const { TagMenuEntries } = await import('../src/components/Catalogue/tags/TagSubmenu.jsx');
test('le sous-menu du filtre d’étiquettes n’offre plus de choix « Au moins une / Toutes » ; cocher produit toujours le mode any', async () => {
  await language();
  const changes = [];
  for (const filterValue of [{ ids: [], mode: 'any' }, { ids: ['a'], mode: 'all' }]) {
    const surface = mountSurface(React.createElement(TagMenuEntries, { tags: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], cards: [], targets: [], filterValue, onFilterChange: value => changes.push(value) }));
    assert.deepEqual(surface.elements.filter(e => e.props?.role === 'menuitemradio'), [], 'aucune bascule de mode');
    assert.equal(surface.elements.filter(e => e.props?.role === 'menuitem').length, 0, 'le filtre ne propose plus de panneau de gestion');
    surface.elements.find(e => e.props?.role === 'menuitemcheckbox' && e.props.children?.some?.(c => c?.props?.children === 'B')).props.onClick();
  }
  assert.deepEqual(changes.map(change => change.mode), ['any', 'any'], 'un état « all » restauré ne se propage pas');
});

test('l’état vide filtré donne les phrases de la maquette, avec le bon accord, et « Tout effacer » en ghost', async () => {
  const engine = await language();
  let state = initialFilterState(); state.query = 'dodo'; state.filters.favoritesOnly = true; state.filters.age = { min: null, max: 3, hideUnknown: false };
  const view = { ...state, summary: filterSummary(state), dispatch: () => {}, setQuery: () => {} };
  const surface = mountSurface(React.createElement(CatalogueEmptyState, { view, filtered: true, sources: [{ id: 'A', status: 'active' }], count: 0, cards: [], onClearFilters: () => {} }));
  assert.match(surface.html.replace(/<[^>]+>/g, ''), /Rien pour « dodo » avec les filtres « .+ » et « .+ »\. Retire un filtre pour élargir la recherche\./);
  assert.match(surface.html, /btn-ghost">Tout effacer/);
  assert.ok(engine);
});

test('le résultat de recherche s’accorde au singulier et au pluriel', async () => {
  const engine = await language();
  for (const [count, text] of [[0, '0 résultat pour « x »'], [1, '1 résultat pour « x »'], [2, '2 résultats pour « x »']]) assert.equal(engine.t('catalogue:filters.searchResults', { count, query: 'x', lng: 'fr' }), text);
  assert.equal(engine.t('catalogue:filters.searchResults', { count: 1, query: 'x', lng: 'en' }), '1 result for “x”');
});
