// Filtre d'âge : recouvrement inclusif des tranches, âge partiel réduit à
// [a, a], inconnus affichés par défaut, bornes vides, minimum > maximum.

import test from 'node:test';
import assert from 'node:assert/strict';
import { ageFilterSummary, evaluateAge, validateAgeFilter } from '../src/store/catalogue/ageFilter.js';
import { normalizeAge } from '../src/store/catalogue/entryModel.js';

const visible = (age, filter) => evaluateAge(normalizeAge(age), { hideUnknown: false, ...filter }).visible;
const from3 = { ageMin: 3 };

test('« dès 3 ans » : exclu de 5–8, inclus dans 0–8, 3–5, max 8, min 3 ; exclu de min 5', () => {
  assert.equal(visible(from3, { min: 5, max: 8 }), false);
  assert.equal(visible(from3, { min: 0, max: 8 }), true);
  assert.equal(visible(from3, { min: 3, max: 5 }), true);
  assert.equal(visible(from3, { min: null, max: 8 }), true);
  assert.equal(visible(from3, { min: 3, max: null }), true);
  assert.equal(visible(from3, { min: 5, max: null }), false);
});

test('FICHED : seul le minimum est comparé ; âge maximum source ignoré', () => {
  assert.equal(visible({ ageMin: 3, ageMax: 6 }, { min: 5, max: 8 }), false);
  assert.equal(visible({ ageMin: 8 }, { min: null, max: 8 }), true);
  assert.equal(visible({ ageMin: 9, ageMax: 12 }, { min: 5, max: 8 }), false);
  assert.equal(visible({ ageMax: 4 }, { min: 5, max: null }), true, 'maximum seul : âge minimum inconnu');
});

test('inconnus affichés par défaut, masqués par la case ; invalides classés à part', () => {
  assert.deepEqual(evaluateAge(normalizeAge({}), { min: 5, max: 8, hideUnknown: false }), { visible: true, outcome: 'unknown' });
  assert.deepEqual(evaluateAge(normalizeAge({}), { min: 5, max: 8, hideUnknown: true }), { visible: false, outcome: 'unknown' });
  const conflict = normalizeAge({}, { ageConflict: true });
  assert.deepEqual(evaluateAge(conflict, { min: 5, max: 8, hideUnknown: false }), { visible: true, outcome: 'invalid' });
  assert.deepEqual(evaluateAge(conflict, { min: 5, max: 8, hideUnknown: true }), { visible: false, outcome: 'invalid' });
});

test('sans filtre actif, aucune exclusion (bornes vides ou chaîne vide)', () => {
  assert.equal(visible({}, { min: null, max: null, hideUnknown: true }), true);
  assert.equal(visible({ ageMin: 3 }, { min: '', max: '' }), true);
  assert.equal(evaluateAge(normalizeAge(from3), { min: null, max: null }).outcome, 'inactive');
});

test('minimum supérieur au maximum : message local, filtre suspendu, rien d’inversé', () => {
  const validation = validateAgeFilter({ min: 8, max: 5 });
  assert.equal(validation.valid, false);
  assert.equal(validation.active, false);
  assert.deepEqual(validation.error, { key: 'catalogue:filter.age.minAboveMax', params: { min: 8, max: 5 } });
  assert.equal(validation.min, 8);
  assert.equal(validation.max, 5);
  assert.equal(visible({ ageMin: 3 }, { min: 8, max: 5 }), true);
  assert.equal(validateAgeFilter({ min: -1 }).error.key, 'catalogue:filter.age.outOfRange');
  assert.equal(validateAgeFilter({ min: 2.5 }).error.key, 'catalogue:filter.age.outOfRange');
});

test('récapitulatif du filtre d’âge en clés et paramètres', () => {
  assert.deepEqual(ageFilterSummary({ min: 5, max: 8, hideUnknown: true }), [
    { key: 'catalogue:filter.age.range', params: { min: 5, count: 8 } },
    { key: 'catalogue:filter.age.unknownHidden', params: {} },
  ]);
  assert.deepEqual(ageFilterSummary({ min: 3, max: null }), [{ key: 'catalogue:filter.age.from', params: { count: 3 } }]);
  assert.deepEqual(ageFilterSummary({ min: null, max: 8 }), [{ key: 'catalogue:palette.forAge', params: { count: 8 } }]);
  assert.deepEqual(ageFilterSummary({ min: null, max: null, hideUnknown: true }), []);
});
