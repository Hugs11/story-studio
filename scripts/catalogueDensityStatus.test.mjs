import './chromeBench.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import i18next from 'i18next';
import { mountSurface } from './chromeBench.mjs';
import { createTestI18n } from './i18nTestSetup.mjs';
import { catalogueViewFixture } from './catalogueFixtures.mjs';
import { CARD_DENSITIES } from '../src/store/catalogue/windowing.js';
import { setCatalogueDensity, CATALOGUE_DENSITY } from '../e2e/lib/actions.mjs';
const { CatalogueStatusBar } = await import('../src/components/Catalogue/CatalogueStatusBar.jsx');
const { CatalogueViewControls } = await import('../src/components/Catalogue/CatalogueViewControls.jsx');
const { measureCatalogueToolbar } = await import('../src/components/Catalogue/CatalogueChrome.jsx');
const { ScanSummary } = await import('../src/components/Catalogue/operations/ScanSummary.jsx');

test('le bilan rend au plus trois titres et une ligne de reste, sans afficher les titres suivants', () => {
  const snapshot = { operationId: 'file', operationKind: 'trash', status: 'success', outcomes: { updated: 6 }, fileNames: ['Lune', 'Soleil', 'Étoiles', 'Titre hors limite'] };
  for (const embedded of [false, true]) {
    const surface = mountSurface(React.createElement(ScanSummary, { snapshot, embedded }));
    const list = surface.elements.find(e => e.props.className === 'catalogue-operation-names');
    assert.ok(list);
    assert.equal(React.Children.toArray(list.props.children).length, 4);
    assert.match(surface.html, /Lune/); assert.match(surface.html, /Soleil/); assert.match(surface.html, /Étoiles/);
    assert.doesNotMatch(surface.html, /Titre hors limite/);
  }
});

test('la barre bascule selon la largeur mesurée des contrôles dépliés, même après une traduction', () => {
  const classes = new Set(['is-compact']);
  let required = 1400;
  const element = {
    classList: { add: name => classes.add(name), remove: name => classes.delete(name), toggle: (name, active) => active ? classes.add(name) : classes.delete(name) },
    get scrollWidth() { assert.equal(classes.has('is-measuring'), true); assert.equal(classes.has('is-compact'), false); return required; },
    clientWidth: 1280,
  };
  for (const width of [1280, 1366, 1440, 1920]) {
    element.clientWidth = width; measureCatalogueToolbar(element);
    assert.equal(classes.has('is-compact'), required > width);
    assert.equal(classes.has('is-measuring'), false);
  }
  required = 2000; measureCatalogueToolbar(element);
  assert.equal(classes.has('is-compact'), true, 'aucun seuil constant ne masque le besoin après traduction');
});

test('FR/EN/IT : les trois crans natifs affichent la densité et écrivent les valeurs historiques', async () => {
  const engine = createTestI18n();
  await i18next.init({ ...engine.options, resources: engine.options.resources });
  for (const lng of ['fr', 'en', 'it']) {
    await i18next.changeLanguage(lng);
    for (const [index, level] of CARD_DENSITIES.entries()) {
      const changes = [];
      const view = { ...catalogueViewFixture(), view: 'cards', density: level.id, setDensity: value => changes.push(value) };
      const surface = mountSurface(React.createElement(CatalogueStatusBar, { view }));
      const input = surface.elements.find(e => e.type === 'input' && e.props.type === 'range');
      assert.ok(input);
      assert.equal(input.props.value, index);
      assert.equal(input.props.min, '0'); assert.equal(input.props.max, '2'); assert.equal(input.props.step, '1');
      assert.equal(input.props.disabled, false);
      assert.equal(input.props['aria-label'], engine.t('catalogue:toolbar.density.label', { lng }));
      assert.equal(input.props['aria-valuetext'], engine.t(level.labelKey, { lng }));
      // Les événements input/change produits par pointeur et clavier suivent le même chemin.
      for (const target of [0, 1, 2]) input.props.onChange({ target: { value: String(target) } });
      assert.deepEqual(changes, ['compact', 'normal', 'large']);
      assert.equal(input.props.onKeyDown, undefined, 'aucun gestionnaire ne bloque les flèches natives');
      assert.match(surface.html, /catalogue-density-ticks/);
      assert.doesNotMatch(mountSurface(React.createElement(CatalogueViewControls, { view })).html, /catalogue-card-density/);
    }
  }
});

test('en liste, le curseur reste rendu, grisé, désactivé et ne modifie pas la préférence', async () => {
  for (const lng of ['fr', 'en', 'it']) {
    await i18next.changeLanguage(lng);
    const changes = [];
    const view = { ...catalogueViewFixture(), view: 'list', density: 'large', setDensity: value => changes.push(value) };
    const surface = mountSurface(React.createElement(CatalogueStatusBar, { view }));
    const input = surface.elements.find(e => e.type === 'input' && e.props.type === 'range');
    assert.ok(input); assert.equal(input.props.disabled, true); assert.equal(input.props.value, 2);
    assert.match(surface.html, /catalogue-density is-disabled/);
    assert.ok(surface.elements.some(e => e.props.text === i18next.t('catalogue:toolbar.density.gridOnly')));
    input.props.onChange({ target: { value: '0' } });
    assert.deepEqual(changes, []);
  }
});

test('helper E2E : Home et deux flèches sont des gestes clavier natifs sur le curseur du bas', async () => {
  const calls = [];
  const page = {
    locator: selector => ({ waitFor: async () => calls.push(selector) }),
    evaluate: async (_fn, selector) => calls.push(selector),
    keyboard: { press: async key => calls.push(key) },
  };
  await setCatalogueDensity(page, 2);
  assert.deepEqual(calls, [CATALOGUE_DENSITY, CATALOGUE_DENSITY, 'Home', 'ArrowRight', 'ArrowRight']);
  const native = [];
  page.client = { command: async (_method, _path, body) => native.push(body.actions[0].actions) };
  page.drain = async () => {};
  await setCatalogueDensity(page, 1);
  assert.deepEqual(native.map(actions => actions.map(action => action.value)), [['\uE011', '\uE011'], ['\uE014', '\uE014']]);
});
