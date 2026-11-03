import test from 'node:test';
import assert from 'node:assert/strict';
import { filterValueCounts } from '../src/store/catalogue/filterValueCounts.js';
import { initialFilterState } from '../src/store/catalogue/filterState.js';
import { card } from './catalogueFixtures.mjs';

test('les comptes d’étiquettes gardent toutes les fiches malgré recherche, favoris et âge actifs', () => {
  const cards = [
    card({ id: 'a', title: 'Lune', ageMin: 3, tags: [{ id: 'nuit', label: 'Nuit' }] }),
    card({ id: 'b', title: 'Soleil', ageMin: 9, tags: [{ id: 'nuit', label: 'Nuit' }] }),
  ];
  cards[0].favorite = true;
  const view = initialFilterState();
  view.query = 'Lune';
  view.filters.favoritesOnly = true;
  view.filters.age = { min: null, max: 5, hideUnknown: false };
  assert.deepEqual(filterValueCounts(cards, view, { family: 'tags', values: cards[0].tags }), { nuit: 2 });
  assert.deepEqual(filterValueCounts(cards, view, { family: 'formats', values: ['zip', 'project'] }), { zip: 1, project: 0 });
});

test('un compte de format remplace la famille courante et conserve les autres critères', () => {
  const cards = [card({ id: 'zip', title: 'Lune', exemplars: [{ format: 'zip' }] }), card({ id: 'project', title: 'Lune', exemplars: [{ format: 'project' }] }), card({ id: 'other', title: 'Soleil', exemplars: [{ format: 'project' }] })];
  const view = initialFilterState();
  view.query = 'Lune';
  view.filters.formats = ['zip'];
  assert.deepEqual(filterValueCounts(cards, view, { family: 'formats', values: ['zip', 'project'] }), { zip: 1, project: 1 });
});

test('le compteur « Masquer les histoires officielles » donne les fiches officielles masquées', () => {
  const cards = [{ ...card({ id: 'o', title: 'Officielle' }), official: true }, card({ id: 'a', title: 'Lune' }), card({ id: 'b', title: 'Soleil' })];
  const counts = filterValueCounts(cards, initialFilterState());
  assert.equal(counts.hideOfficial, 1);
});

test('sans fiche officielle, le compteur vaut zéro', () => {
  assert.equal(filterValueCounts([card({ id: 'a', title: 'Lune' })], initialFilterState()).hideOfficial, 0);
});

test('le compteur officiel ignore sa propre bascule mais respecte recherche et autres filtres', () => {
  const official = (id, title, favorite) => ({ ...card({ id, title }), official: true, favorite });
  const cards = [official('a', 'Lune', true), official('b', 'Soleil', true), official('c', 'Lune', false), card({ id: 'd', title: 'Lune' })];
  const view = initialFilterState();
  view.query = 'Lune'; view.filters.favoritesOnly = true;
  for (const hideOfficial of [false, true]) {
    view.filters.hideOfficial = hideOfficial;
    assert.equal(filterValueCounts(cards, view).hideOfficial, 1);
  }
});
