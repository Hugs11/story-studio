import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { mountSurface } from './chromeBench.mjs';
import { createTestI18n } from './i18nTestSetup.mjs';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { card } from './catalogueFixtures.mjs';
import { sourceFolderOptions } from '../src/store/catalogue/sourceView.js';
import { evaluateCard, normalizeFilters } from '../src/store/catalogue/filters.js';
import { initialFilterState, filterSummary, filterMenuValues } from '../src/store/catalogue/filterState.js';
i18next.use(initReactI18next);
const { CatalogueFilterBar, ActiveFilterSummary } = await import('../src/components/Catalogue/CatalogueFilterBar.jsx');
const folders = (...paths) => paths.map((path, index) => ({ id: `S${index}`, path, status: 'active' }));

test('libellés : dernier segment, casse respectée, homonymes désambiguïsés, sources non actives exclues', () => {
  assert.deepEqual(sourceFolderOptions(folders('/a/Histoires', '/b/ours')).map(o => o.label), ['Histoires', 'ours']);
  assert.deepEqual(sourceFolderOptions(folders('/a/Contes', '/b/Contes/', 'C:\\x\\Autre')).map(o => o.label), ['a/Contes', 'b/Contes', 'Autre']);
  assert.equal(sourceFolderOptions(folders('/a/Contes'))[0].path, '/a/Contes');
  assert.deepEqual(sourceFolderOptions([{ id: 'h', path: '/x/y', status: 'hint' }]), []);
});

test('une fiche passe le filtre si un exemplaire est dans le dossier', () => {
  const entry = card({ id: 'c', exemplars: [{ id: 'e1', sources: ['A'] }, { id: 'e2', sources: ['B'] }] });
  assert.ok(evaluateCard(entry, normalizeFilters({ sourceIds: ['B'] })));
  assert.equal(evaluateCard(entry, normalizeFilters({ sourceIds: ['C'] })), null);
});

test('l’entrée « Dossier » du menu Filtres n’apparaît qu’avec deux dossiers ou plus', () => {
  for (const [count, expected] of [[0, false], [1, false], [2, true], [3, true]]) {
    const listed = filterMenuValues(sourceFolderOptions(folders(...['/a/A', '/a/B', '/a/C'].slice(0, count))).length).map(item => item.family);
    assert.equal(listed.includes('sourceIds'), expected, `${count} dossier(s)`);
    assert.ok(listed.includes('formats') && listed.includes('languages'));
  }
});

test('le sous-menu liste exactement les dossiers ajoutés, avec chemin en infobulle', async () => {
  const engine = createTestI18n();
  await i18next.init({ ...engine.options, resources: engine.options.resources });
  await i18next.changeLanguage('fr');
  const state = initialFilterState();
  const actions = [];
  const sources = [...folders('/a/Contes', '/b/Contes', '/c/Zoo'), { id: 'H', path: '/h', status: 'hint' }];
  const surface = mountSurface(React.createElement(CatalogueFilterBar, { family: 'sourceIds', sources, cards: [], view: { ...state, summary: [], dispatch: a => actions.push(a) } }));
  const items = surface.elements.filter(e => e.props?.role === 'menuitemcheckbox');
  assert.equal(items.length, 3);
  assert.match(surface.html, /a\/Contes/); assert.match(surface.html, /b\/Contes/); assert.match(surface.html, />Zoo</);
  items[2].props.onClick();
  assert.deepEqual(actions[0], { type: 'set', family: 'sourceIds', value: ['S2'] });
});

test('le chip actif affiche le libellé court du dossier', async () => {
  const engine = createTestI18n();
  await i18next.init({ ...engine.options, resources: engine.options.resources });
  await i18next.changeLanguage('fr');
  const state = initialFilterState();
  state.filters.sourceIds = ['S1'];
  const surface = mountSurface(React.createElement(ActiveFilterSummary, { cards: [], sources: folders('/a/Contes', '/b/Zoo'), view: { ...state, summary: filterSummary(state), dispatch() {} } }));
  assert.match(surface.html, />Zoo</);
  assert.match(surface.html, />Dossier</);
  assert.doesNotMatch(surface.html, /\/b\/Zoo/);
});
