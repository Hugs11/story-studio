import './chromeBench.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import i18next from 'i18next';
import { mountSurface } from './chromeBench.mjs';
import { createTestI18n } from './i18nTestSetup.mjs';
import { initialFilterState, filterStateReducer, filterSummary } from '../src/store/catalogue/filterState.js';
import { runPipeline } from '../src/store/catalogue/pipeline.js';
import { card } from './catalogueFixtures.mjs';
const { CatalogueFilterBar, ActiveFilterSummary } = await import('../src/components/Catalogue/CatalogueFilterBar.jsx');

async function language(lng) {
  const engine = createTestI18n();
  await i18next.init({ ...engine.options, resources: engine.options.resources, lng });
  return engine;
}

const cards = [
  card({ id: 'multi', title: 'Lune', favorite: true, exemplars: [{ format: 'project' }, { format: 'zip' }, { format: 'zip' }, { format: 'sevenZip' }, { format: 'folder' }] }),
  card({ id: 'zip', title: 'Lune', favorite: true }),
  card({ id: 'other', title: 'Soleil', exemplars: [{ format: 'folder' }] }),
];

test('Format checkboxes count fiches per format, support multiple choices and keep the editor open', async () => {
  await language('fr');
  let state = initialFilterState();
  state.query = 'lune'; state.filters.favoritesOnly = true;
  let closed = 0;
  const render = (available = cards, family = 'formats') => mountSurface(React.createElement(CatalogueFilterBar, {
    view: { ...state, dispatch: action => { state = filterStateReducer(state, action); } },
    cards: available, family, onClose: () => closed++,
  }));
  const buttons = surface => surface.elements.filter(e => e.type === 'button');
  let surface = render();
  assert.deepEqual(buttons(surface).map(e => e.props.children[0]), ['Projet', 'ZIP', '7z', 'Dossier']);
  assert.deepEqual(buttons(surface).map(e => e.props.children[1].props.children), [1, 2, 1, 1]);
  assert.ok(buttons(surface).every(e => e.props.role === 'menuitemcheckbox' && e.props['aria-checked'] === false));
  buttons(surface)[0].props.onClick();
  surface = render();
  buttons(surface)[1].props.onClick();
  surface = render();
  assert.deepEqual(state.filters.formats, ['project', 'zip']);
  assert.deepEqual(buttons(surface).map(e => e.props['aria-checked']), [true, true, false, false]);
  assert.deepEqual(buttons(surface).map(e => e.props.children[1].props.children), [1, 2, 1, 1]);
  assert.deepEqual(runPipeline(cards, { query: state.query, filters: state.filters }).ids.sort(), ['multi', 'zip']);
  const summary = mountSurface(React.createElement(ActiveFilterSummary, { view: { ...state, summary: filterSummary(state) }, cards }));
  assert.match(summary.html, /Projet, ZIP/);
  buttons(surface)[0].props.onClick();
  assert.deepEqual(state.filters.formats, ['zip']);
  assert.equal(closed, 0);
  surface = render([]);
  assert.deepEqual(buttons(surface).map(e => e.props.children[1].props.children), [0, 0, 0, 0]);
  // Language uses the same checkbox and counter presentation.
  const languages = buttons(render([{ ...cards[0], language: 'fr' }, { ...cards[1], language: 'it' }], 'languages'));
  assert.deepEqual(languages.map(e => [e.props.role, e.props.children[1].props.children]), [['menuitemcheckbox', 1], ['menuitemcheckbox', 1]]);
});
