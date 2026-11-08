import { catalogueViewFixture } from './catalogueFixtures.mjs';
import './chromeBench.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import i18next from 'i18next';
import { mountSurface } from './chromeBench.mjs';
import { createTestI18n } from './i18nTestSetup.mjs';
import { ageFilterLabel, ageFilterSummary } from '../src/store/catalogue/ageFilter.js';
const { CatalogueToolbar } = await import('../src/components/Catalogue/CatalogueToolbar.jsx');

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const toolbarCss = read('src/components/Catalogue/CatalogueToolbar.css');

async function language(lng = 'fr') {
  const engine = createTestI18n();
  await i18next.init({ ...engine.options, resources: engine.options.resources, lng });
  return engine;
}

test('le menu Filtres n’a plus de champ « Filtrer par… » : ni logique, ni clé de traduction', () => {
  const source = read('src/components/Catalogue/CatalogueToolbar.jsx');
  assert.doesNotMatch(source, /filterQuery|setFilterQuery|filters\.search'/);
  assert.doesNotMatch(source, /<input value=/);
  for (const lng of ['fr', 'en', 'it']) assert.equal(Object.hasOwn(JSON.parse(read(`src/locales/${lng}/catalogue.json`)), 'filters.search'), false, lng);
  assert.equal(Object.hasOwn(JSON.parse(read('src/locales/_meta/catalogue.json')), 'filters.search'), false);
});

test('le tri est un menu de l’app : aucun <select> natif, choix exclusif avec coche', async () => {
  await language();
  const view = { ...catalogueViewFixture(), view: 'cards', query: '', summary: [], sort: { key: 'addedAt', direction: 'asc' } };
  const toolbar = mountSurface(React.createElement(CatalogueToolbar, { view, cards: [] }));
  assert.doesNotMatch(toolbar.html, /<select/);
  const trigger = toolbar.elements.find(e => e.type === 'button' && e.props.id === 'catalogue-sort');
  assert.ok(trigger, 'bouton déclencheur du tri');
  assert.equal(trigger.props['aria-haspopup'], 'menu');
  assert.equal(trigger.props['aria-expanded'], false);
  const sortMenu = read('src/components/Catalogue/CatalogueSortMenu.jsx');
  assert.match(sortMenu, /role="menuitemradio"/);
  assert.match(sortMenu, /aria-checked=\{item\.key === value\}/);
  assert.doesNotMatch(read('src/components/Catalogue/CatalogueToolbar.jsx'), /<select/);
  assert.doesNotMatch(toolbarCss, /\.catalogue-sort[^{]*select/);
});

test('les menus de critères prennent le socle .project-menu : pas de fond, bordure, rayon ni encoche réécrits', () => {
  assert.doesNotMatch(toolbarCss, /\.project-menu::before \{ display: none/);
  for (const line of toolbarCss.split('\n').filter(item => /^[^/]*\.project-menu\b[^-]/.test(item) || /\.project-menu \{/.test(item))) {
    assert.doesNotMatch(line, /background:|border-color:|border-radius:|box-shadow:/, line);
  }
  assert.doesNotMatch(toolbarCss, /project-menu-head/);
  const floating = read('src/components/Catalogue/fiche/SelectionPanel.css');
  assert.doesNotMatch(floating, /project-menu::before \{ display: none/);
});

test('âge identique aux deux bornes : « Âge : 6 ans », jamais « 6 à 6 ans » (FR/EN/IT)', async () => {
  assert.deepEqual(ageFilterSummary({ min: 6, max: 6 }), [{ key: 'catalogue:filter.age.exact', params: { count: 6 } }]);
  assert.deepEqual(ageFilterLabel({ min: 6, max: 6 }), { key: 'catalogue:details.age.exact', params: { count: 6 } });
  assert.deepEqual(ageFilterLabel({ min: 5, max: 8 }, { summary: true }), { key: 'catalogue:filter.age.range', params: { min: 5, count: 8 } });
  for (const [lng, one, other] of [['fr', 'Âge : 1 an', 'Âge : 6 ans'], ['en', 'Age: 1 year', 'Age: 6 years'], ['it', 'Età: 1 anno', 'Età: 6 anni']]) {
    const engine = await language(lng);
    assert.equal(engine.t('catalogue:filter.age.exact', { count: 1, lng }), one);
    assert.equal(engine.t('catalogue:filter.age.exact', { count: 6, lng }), other);
  }
  assert.doesNotMatch((await language('fr')).t('catalogue:filter.age.exact', { count: 6, lng: 'fr' }), / à /);
});

test('les infobulles d’aide du catalogue passent par <Tooltip>, pas par l’attribut title natif', () => {
  const offenders = [];
  const visit = dir => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) visit(path);
      else if (name.endsWith('.jsx')) {
        read(relative(process.cwd(), path).replaceAll('\\', '/')).split('\n').forEach((line, index) => {
          // `title=` d’un composant de menu ou de pastille (texte d’en-tête) n’est pas une infobulle native ;
          // `<MenuItem title>` est le socle partagé des menus de barre d’outils, hors de ce périmètre.
          if (/\btitle=\{/.test(line) && !/<MenuItem\b/.test(line) && /<(Button|button|span|div|h2|input|a)\b/.test(line)) offenders.push(`${path}:${index + 1}`);
          if (/^\s+title=\{/.test(line) && /(?:aria-label|aria-pressed)/.test(line)) offenders.push(`${path}:${index + 1}`);
        });
      }
    }
  };
  visit(fileURLToPath(new URL('../src/components/Catalogue', import.meta.url)));
  assert.deepEqual(offenders, []);
});

test('le popover Âge n’affiche plus « Appliqué en direct » : ni texte ni clé', () => {
  assert.doesNotMatch(read('src/components/Catalogue/CatalogueFilterBar.jsx'), /age\.live/);
  for (const lng of ['fr', 'en', 'it']) assert.equal(Object.hasOwn(JSON.parse(read(`src/locales/${lng}/catalogue.json`)), 'age.live'), false, lng);
  assert.equal(Object.hasOwn(JSON.parse(read('src/locales/_meta/catalogue.json')), 'age.live'), false);
});
