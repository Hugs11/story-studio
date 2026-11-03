// Filtres du catalogue : contraintes d'exemplaire satisfaites par un même
// exemplaire, OU dans une famille, ET entre familles, étiquettes (au moins une), familles sans donnée, récapitulatif.

import test from 'node:test';
import assert from 'node:assert/strict';
import { activeFilterSummary, evaluateCard, filterErrors, filterOptions, normalizeFilters } from '../src/store/catalogue/filters.js';
import { card } from './catalogueFixtures.mjs';

const keep = (entry, filters) => evaluateCard(entry, normalizeFilters(filters)) !== null;

// ZIP uniquement dans B, projet uniquement dans A.
const split = card({ id: 'split', exemplars: [
  { id: 'zipB', format: 'zip', sources: ['B'] },
  { id: 'projA', format: 'project', sources: ['A'] },
] });

test('ZIP + dossier A : pas de faux positif par combinaison de deux exemplaires', () => {
  assert.equal(keep(split, { formats: ['zip'], sourceIds: ['A'] }), false);
});

test('ZIP + dossier B : retenue, avec l’exemplaire qui satisfait les deux', () => {
  const result = evaluateCard(split, normalizeFilters({ formats: ['zip'], sourceIds: ['B'] }));
  assert.deepEqual(result.exemplars.map((e) => e.id), ['zipB']);
});

test('plusieurs valeurs d’une famille en OU, familles en ET', () => {
  assert.equal(keep(split, { formats: ['sevenZip', 'project'] }), true);
  assert.equal(keep(split, { formats: ['sevenZip', 'folder'] }), false);
  assert.equal(keep(split, { sourceIds: ['C', 'A'] }), true);
  const favorite = card({ favorite: true, exemplars: [{ format: 'zip', sources: ['A'] }] });
  assert.equal(keep(favorite, { formats: ['zip'], favoritesOnly: true }), true);
  assert.equal(keep(split, { formats: ['zip'], favoritesOnly: true }), false);
});

test('disponibilité au niveau de l’exemplaire ; hors ligne visibles par défaut', () => {
  const offline = card({ exemplars: [{ format: 'zip', available: false }] });
  const half = card({ exemplars: [{ format: 'zip', available: false, sources: ['B'] }, { format: 'project', available: true, sources: ['A'] }] });
  assert.equal(keep(offline, {}), true);
  assert.equal(keep(offline, { availability: 'available' }), false);
  assert.equal(keep(offline, { availability: 'all' }), true);
  assert.equal(keep(offline, { availability: 'unavailable' }), true);
  assert.equal(keep(half, { formats: ['zip'], availability: 'available' }), false, 'le ZIP disponible manque');
  assert.equal(keep(half, { formats: ['zip'], availability: 'all' }), true);
  assert.equal(keep(half, { availability: 'unavailable', sourceIds: ['A'] }), false);
});

test('étiquettes : toujours « au moins une » (plus de mode « toutes », décision volontaire)', () => {
  const tagged = card({ tags: [{ id: 'nuit', label: 'Nuit' }, { id: 'animaux', label: 'Animaux' }] });
  const single = card({ tags: [{ id: 'nuit', label: 'Nuit' }] });
  const both = { tags: { ids: ['nuit', 'animaux'] } };
  assert.equal(keep(tagged, both), true);
  assert.equal(keep(single, both), true);
  assert.equal(keep(single, { tags: { ids: ['nuit', 'animaux'], mode: 'any' } }), true);
  assert.equal(keep(card({}), { tags: { ids: ['nuit'], mode: 'any' } }), false);
});

test('langue, type de projet, état et métadonnées manquantes évalués sur des données de test', () => {
  const entry = card({
    language: 'fr', packState: 'needsRegeneration', title: 'T',
    exemplars: [{ format: 'project', projectType: 'pack' }],
  });
  assert.equal(keep(entry, { languages: ['it', 'fr'] }), true);
  assert.equal(keep(entry, { languages: ['it'] }), false);
  assert.equal(keep(entry, { projectTypes: ['menus'] }), true);
  assert.equal(keep(entry, { projectTypes: ['graph'] }), false);
  assert.equal(keep(entry, { packStates: ['needsRegeneration'] }), true);
  assert.equal(keep(entry, { missing: ['age'] }), true);
  assert.equal(keep(entry, { missing: ['title'] }), false);
  assert.equal(keep(entry, { missing: ['title', 'description'] }), true);
});

test('âge combiné aux autres familles', () => {
  const entry = card({ ageMin: 3, exemplars: [{ format: 'zip' }] });
  assert.equal(keep(entry, { age: { min: 5, max: 8 } }), false);
  assert.equal(keep(entry, { age: { min: 0, max: 8 }, formats: ['zip'] }), true);
  assert.deepEqual(filterErrors({ age: { min: 9, max: 2 } }), [{ family: 'age', key: 'catalogue:filter.age.minAboveMax', params: { min: 9, max: 2 } }]);
});

test('valeurs proposables : familles sans donnée vides', () => {
  const options = filterOptions([split, card({ exemplars: [{ format: 'folder', sources: ['C'] }] })]);
  assert.deepEqual(options.formats, ['project', 'zip', 'folder']);
  assert.deepEqual(options.sourceIds, ['A', 'B', 'C']);
  assert.deepEqual(options.languages, []);
  assert.deepEqual(options.tags, []);
  assert.deepEqual(options.packStates, []);
  assert.deepEqual(options.availability, ['available', 'unavailable', 'all']);
});

test('récapitulatif des filtres actifs en {key, params}', () => {
  assert.deepEqual(activeFilterSummary({}), []);
  assert.deepEqual(activeFilterSummary({
    age: { min: 3, max: null }, formats: ['zip'], tags: { ids: ['nuit'], mode: 'any' },
    favoritesOnly: true, availability: 'available',
  }), [
    { family: 'age', key: 'catalogue:filter.age.from', params: { count: 3 } },
    { family: 'formats', key: 'catalogue:filter.family.format', params: { values: ['zip'] } },
    { family: 'tags', key: 'catalogue:filter.tags.label', params: { values: ['nuit'] } },
    { family: 'favoritesOnly', key: 'catalogue:filter.favorites.only', params: {} },
    { family: 'availability', key: 'catalogue:filter.hideOffline', params: {} },
  ]);
});

test('masquer les histoires officielles : cochée, les fiches officielles disparaissent', () => {
  const official = { ...card({ id: 'official', title: 'Officielle' }), official: true };
  const own = card({ id: 'own', title: 'Créée' });
  assert.equal(keep(official, {}), true);
  assert.equal(keep(official, { hideOfficial: true }), false);
  assert.equal(keep(own, { hideOfficial: true }), true);
  assert.deepEqual(activeFilterSummary({ hideOfficial: true }), [{ family: 'hideOfficial', key: 'catalogue:filter.hideOfficial.label', params: {} }]);
});

test('le filtre d’étiquettes est toujours « au moins une » : un mode « all » restauré retombe sur « any »', () => {
  assert.equal(normalizeFilters({ tags: { ids: ['a'], mode: 'all' } }).tags.mode, 'any');
  assert.equal(normalizeFilters({}).tags.mode, 'any');
  const one = card({ tags: [{ id: 'a' }] });
  assert.equal(keep(one, { tags: { ids: ['a', 'b'], mode: 'all' } }), true, 'une seule étiquette sur deux suffit');
});
