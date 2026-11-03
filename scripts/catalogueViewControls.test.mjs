import { catalogueViewFixture } from './catalogueFixtures.mjs';
import './chromeBench.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { mountSurface } from './chromeBench.mjs';
import { createTestI18n } from './i18nTestSetup.mjs';
import i18next from 'i18next';
import { CATALOGUE_COLUMNS } from '../src/store/catalogue/listColumns.js';
import { card } from './catalogueFixtures.mjs';
const { CatalogueColumnChoices } = await import('../src/components/Catalogue/ColumnPicker.jsx');
const { CatalogueViewControls } = await import('../src/components/Catalogue/CatalogueViewControls.jsx');
const { CatalogueRow } = await import('../src/components/Catalogue/views/CatalogueRow.jsx');
const { ListView } = await import('../src/components/Catalogue/views/ListView.jsx');
const { CatalogueToolbar } = await import('../src/components/Catalogue/CatalogueToolbar.jsx');
const { CatalogueCard } = await import('../src/components/Catalogue/views/CatalogueCard.jsx');
const noop = () => {};

test('FR/EN/IT density is a three-step status bar slider, visible and disabled in List, absent from the top controls', async () => {
  const engine = createTestI18n(); await i18next.init({ ...engine.options, resources: engine.options.resources });
  const { CatalogueStatusBar } = await import('../src/components/Catalogue/CatalogueStatusBar.jsx');
  for (const language of ['fr', 'en', 'it']) {
    await i18next.changeLanguage(language);
    const changes = [];
    const view = { ...catalogueViewFixture(), view: 'cards', density: 'compact', setDensity: value => changes.push(value) };
    for (const mode of ['cards', 'list']) {
      const controls = mountSurface(React.createElement(CatalogueViewControls, { view: { ...view, view: mode } }));
      assert.doesNotMatch(controls.html, /catalogue-card-density/);
      for (const [index, level] of ['compact', 'normal', 'large'].entries()) {
        const status = mountSurface(React.createElement(CatalogueStatusBar, { view: { ...view, view: mode, density: level } }));
        const footer = status.elements.find(e => e.type === 'footer');
        assert.match(footer.props.className, /catalogue-statusbar/);
        const sliders = status.elements.filter(e => e.type === 'input' && e.props.id === 'catalogue-card-density');
        assert.equal(sliders.length, 1);
        const slider = sliders[0];
        assert.equal(slider.props.type, 'range');
        assert.deepEqual([slider.props.min, slider.props.max, slider.props.step], ['0', '2', '1']);
        assert.equal(slider.props.value, index);
        assert.equal(slider.props['aria-label'], engine.t('catalogue:toolbar.density.label', { lng: language }));
        assert.equal(slider.props['aria-valuetext'], engine.t(`catalogue:toolbar.density.${level}`, { lng: language }));
        assert.equal(slider.props.disabled, mode === 'list');
        assert.match(status.html, mode === 'list' ? /catalogue-density is-disabled/ : /class="catalogue-density"/);
        slider.props.onChange({ target: { value: String(index) } });
      }
    }
    assert.deepEqual(changes, ['compact', 'normal', 'large'], 'List keeps the slider visible but cannot change density');
  }
});

test('4b keeps tags/favorite in the corners and age/duration/actions/formats below the overlay title', async () => {
  const engine = createTestI18n(); await i18next.init({ ...engine.options, resources: engine.options.resources });
  const c = card({ id: 'all-formats', title: 'Une histoire avec tous les formats', ageMin: 3, tags: [{ id: 'a', label: 'Animaux' }], exemplars: ['project', 'zip', 'sevenZip', 'folder'].map((format, index) => ({ id: String(index), format })) });
  const favorites = []; const formats = []; const labels = []; const ages = [];
  const surface = mountSurface(React.createElement(CatalogueCard, { item: { card: c, exemplars: c.exemplars }, index: 0, view: { activeId: c.id, selected: new Set(), onFavorite: card => favorites.push(card.id), onFormatClick: (event, id, format) => formats.push(format), onFilterTag: id => labels.push(id), onFilterAge: age => ages.push(age) } }));
  const age = surface.elements.find(e => e.type === 'button' && e.props?.className?.includes('catalogue-card-age'));
  assert.ok(age); age.props.onClick({ detail: 1, stopPropagation() {} }); assert.deepEqual(ages, [3]);
  assert.ok(surface.html.indexOf('catalogue-card-age') > surface.html.indexOf('catalogue-card-meta'), '4b moves the age filter into the bottom metadata line');
  const actions = surface.elements.find(e => e.props?.className === 'catalogue-card-actions');
  assert.ok(actions);
  assert.ok(surface.html.indexOf('catalogue-card-simulate') > surface.html.indexOf('catalogue-card-meta'), 'Simulate is no longer centered on the cover');
  assert.ok(surface.html.indexOf('catalogue-card-edit') > surface.html.indexOf('catalogue-card-meta'));
  assert.ok(surface.html.indexOf('catalogue-star') < surface.html.indexOf('catalogue-card-info'));
  assert.doesNotMatch(surface.html, /catalogue-card-overlay/);
  const visual = surface.elements.find(e => e.props?.className === 'catalogue-card-visual');
  assert.ok(React.Children.toArray(visual.props.children).some(child => child.props?.className === 'catalogue-card-info'));
  assert.ok(surface.html.indexOf('catalogue-card-title') < surface.html.indexOf('catalogue-card-meta'));
  assert.doesNotMatch(surface.html, /catalogue-card-footer/);
  assert.ok(surface.html.indexOf('Animaux') < surface.html.indexOf('catalogue-card-info'));
  const star = surface.elements.find(e => e.type === 'button' && e.props.className === 'catalogue-star');
  star.props.onClick({ stopPropagation() {} }); assert.deepEqual(favorites, [c.id]);
  const badges = surface.elements.filter(e => e.type === 'button' && e.props.className?.startsWith('catalogue-format-tag catalogue-format-tag--'));
  assert.equal(badges.length, 4);
  badges.forEach(badge => badge.props.onClick({ detail: 1, stopPropagation() {} }));
  assert.deepEqual(formats, ['project', 'zip', 'sevenZip', 'folder']);
  const label = surface.elements.find(e => e.type === 'button' && e.props.className?.includes('catalogue-card-tag-indicator--single'));
  label.props.onClick({ stopPropagation() {} }); assert.deepEqual(labels, ['a']);
  const withoutLabels = mountSurface(React.createElement(CatalogueCard, { item: { card: { ...c, tags: [] }, exemplars: c.exemplars }, index: 0, view: { activeId: c.id, selected: new Set() } }));
  assert.doesNotMatch(withoutLabels.html, /catalogue-card-footer/);
  assert.match(withoutLabels.html, /catalogue-card-visual/);
});

test('catalogue chrome contains search and view controls without redundant pack or selection counters', async () => {
  const engine = createTestI18n(); await i18next.init({ ...engine.options, resources: engine.options.resources });
  const { CatalogueChrome } = await import('../src/components/Catalogue/CatalogueChrome.jsx');
  const view = { ...catalogueViewFixture(), view: 'cards', query: '', summary: [], sort: { key: 'title', direction: 'asc' } };
  const toolbar = mountSurface(React.createElement(CatalogueToolbar, { view, selectedCount: 3, cards: [], renderChrome: controls => React.createElement(CatalogueChrome, { ...controls }) }));
  assert.doesNotMatch(toolbar.html, /catalogue-selection-trigger|catalogue-filter-line/);
  assert.ok(toolbar.html.indexOf('chrome-toolbar-center') < toolbar.html.indexOf('id="catalogue-search"'));
  assert.ok(toolbar.html.indexOf('chrome-toolbar-right') < toolbar.html.indexOf('id="catalogue-sort"'));
  assert.equal(toolbar.elements.filter(e => e.type === 'input' && e.props.id === 'catalogue-search').length, 1);
  const { CatalogueStatusBar } = await import('../src/components/Catalogue/CatalogueStatusBar.jsx');
  const status = mountSurface(React.createElement(CatalogueStatusBar, { view: { ...view, result: { counts: { fiches: 14, exemplaires: 16 } } }, selected: 3 }));
  assert.ok(status.html.includes('14 fiches · 16 exemplaires'));
  assert.doesNotMatch(status.html, /sélectionné/);
});

test('FR/EN/IT three permanent named view buttons on the results row; ten fiche columns selectable in List', async () => {
  const engine = createTestI18n(); await i18next.init({ ...engine.options, resources: engine.options.resources });
  for (const language of ['fr', 'en', 'it']) {
    await i18next.changeLanguage(language);
    for (const mode of ['cards', 'list']) {
      const changes = [];
      const view = { ...catalogueViewFixture(), view: mode, setView: mode => changes.push(mode), query: '', summary: [], sort: { key: 'title', direction: 'asc' }, listColumns: { visibleCols: new Set(CATALOGUE_COLUMNS.defaultVisible) } };
      const surface = mountSurface(React.createElement(CatalogueViewControls, { view }));
      const toggles = surface.elements.filter(e => e.type === 'button' && typeof e.props['aria-pressed'] === 'boolean');
      assert.equal(toggles.length, 3);
      assert.deepEqual(toggles.map(e => e.props['aria-label']), [engine.t('catalogue:toolbar.view.cards', { lng: language }), engine.t('catalogue:toolbar.view.list', { lng: language }), engine.t('catalogue:toolbar.panel.hide', { lng: language })]);
      assert.equal(toggles.filter(e => e.props['aria-pressed']).length, 2);
      toggles[0].props.onClick(); toggles[1].props.onClick(); assert.deepEqual(changes, ['cards', 'list']);
      assert.equal(surface.elements.filter(e => e.type === 'button' && e.props['aria-haspopup'] === 'dialog').length, 0);
      assert.doesNotMatch(surface.html, /catalogue:|<details|data-toolbar-id/);
      const toolbar = mountSurface(React.createElement(CatalogueToolbar, { view, searchRef: { current: null } }));
      // Le compteur, le tri et les vues partagent maintenant la ligne des résultats.
      assert.ok(toolbar.html.indexOf('catalogue-results-controls') < toolbar.html.indexOf('id="catalogue-sort"'));
      assert.ok(toolbar.html.indexOf('id="catalogue-sort"') < toolbar.html.indexOf('catalogue-view-group'));
      assert.ok(toolbar.html.indexOf('catalogue-results-controls') < toolbar.html.indexOf('catalogue-view-group'));
    }

    const changes = [];
    const picker = mountSurface(React.createElement(CatalogueColumnChoices, { columns: { visibleCols: new Set(CATALOGUE_COLUMNS.defaultVisible), toggleCol: id => changes.push(id) } }));
    const inputs = picker.elements.filter(e => e.type === 'input');
    assert.equal(inputs.length, 12); assert.equal(inputs.filter(e => e.props.checked).length, 10);
    assert.equal(inputs.filter(e => e.props.disabled).length, 1);
    inputs[10].props.onChange(); inputs[11].props.onChange(); assert.deepEqual(changes, ['producer', 'bonus']);

  }
});

test('List renders default headers, chosen widths and two tags plus overflow; tag click filters only', () => {
  const c = card({ id: 'tagged', title: 'Ours', description: '<Résumé>' });
  c.language = 'fr'; c.author = 'Camille'; c.producer = 'Studio Lune'; c.bonus = 'Chanson finale';
  c.tags = [{ id: 'a', label: 'Aventure' }, { id: 'b', label: 'Animaux' }, { id: 'c', label: 'Nuit' }];
  const item = { card: c, exemplars: c.exemplars, representative: c.exemplars[0] };
  const filters = []; let stopped = 0;
  const view = { selected: new Set(), activeId: c.id, expanded: new Set(), onFilterTag: id => filters.push(id), onItemClick: noop, onOpenModal: noop, onItemKeyDown: noop, onCardMenu: noop, onFormatClick: noop, onToggleExpanded: noop };
  const surface = mountSurface(React.createElement(ListView, { items: [item], view }));
  assert.equal(surface.elements.filter(e => e.type === 'th').length, 11); // ten fiche columns + actions
  assert.equal(surface.elements.filter(e => e.type === 'button' && e.props.className?.includes('catalogue-card-tag')).length, 2);
  assert.match(surface.html, /\+1/);
  for (const text of ['fr', 'Camille', 'Studio Lune', 'Chanson finale']) assert.ok(surface.html.includes(text));
  assert.match(surface.html, /min-width:100%/);
  assert.doesNotMatch(surface.html, /&lt;Résumé&gt;/);
  surface.elements.find(e => e.type === 'button' && e.props.children === 'Aventure').props.onClick({ stopPropagation: () => { stopped++; } });
  assert.deepEqual(filters, ['a']); assert.equal(stopped, 1);
  const listColumns = { visibleCols: new Set(['title', 'producer', 'bonus']), colWidths: { title: 321 }, startResize: (event, id) => filters.push(id) };
  const chosen = mountSurface(React.createElement(ListView, { items: [item], view: { ...view, listColumns } }));
  assert.equal(chosen.elements.filter(e => e.type === 'th').length, 4);
  assert.match(chosen.html, /width:321px/); assert.doesNotMatch(chosen.html, /&lt;Résumé&gt;/);
  chosen.elements.find(e => e.type === 'th' && e.props.className === 'catalogue-cell--title').props.children.find(e => e?.props?.className === 'me-col-resize').props.onPointerDown({});
  assert.equal(filters.at(-1), 'title');
  let clicked = 0, opened = 0, simulated = 0;
  const row = mountSurface(React.createElement(CatalogueRow, { item, index: 1, columns: CATALOGUE_COLUMNS.columns, view: { ...view, onItemClick: () => clicked++, onOpenModal: () => opened++, onSimulate: () => simulated++ } }));
  const main = row.elements.find(e => e.type === 'tr' && e.props['data-card-id'] === c.id);
  main.props.onClick({}); assert.equal(main.props.onDoubleClick, undefined, 'double click is the second click, handled by the activation'); assert.equal(clicked, 1); assert.equal(opened, 0); assert.equal(simulated, 0, 'a double click never simulates');
});

test('4b omits unknown age and takes duration from the newest exemplar even under format filters', async () => {
  const engine = createTestI18n(); await i18next.init({ ...engine.options, resources: engine.options.resources });
  const c = card({ id: 'duration', ageMin: 7 });
  c.exemplars = [{ ...c.exemplars[0], modifiedAt: 10, durationSeconds: 600 }, { ...c.exemplars[0], id: 'new', modifiedAt: 20, durationSeconds: 2520 }];
  const render = current => mountSurface(React.createElement(CatalogueCard, { item: { card: current, exemplars: [c.exemplars[0]] }, index: 0, view: { activeId: c.id, selected: new Set() } }));
  assert.match(render(c).html, /42 min/);
  const unknown = render({ ...c, age: null });
  assert.doesNotMatch(unknown.html, /catalogue-card-age| · |—/);
  assert.match(unknown.html, /42 min/);
  c.exemplars[1].durationSeconds = null;
  assert.doesNotMatch(render(c).html, /10 min|42 min/, 'never borrow older duration');
});
