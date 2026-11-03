import test from 'node:test';
import assert from 'node:assert/strict';
import { CRITERIA, compactTagLabel, paletteSuggestions, paletteCards, paletteKey, suggestionAction } from '../src/store/catalogue/filterPalette.js';
import { initialFilterState, filterStateReducer, filterSummary } from '../src/store/catalogue/filterState.js';
import { evaluateCard } from '../src/store/catalogue/filters.js';
import { card } from './catalogueFixtures.mjs';
const tags = [{ id: 'n', label: 'Noël' }, { id: 'a', label: 'Animaux' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }];

test('text suggests audience ages, accent-insensitive tags and translated filter vocabulary', () => {
  assert.deepEqual(paletteSuggestions('', tags), []);
  for (const value of ['0', 'pour 5 ans', '18']) assert.equal(paletteSuggestions(value)[0].family, 'age');
  for (const value of ['19', '100', '-1']) assert.ok(!paletteSuggestions(value).some(item => item.family === 'age'));
  assert.deepEqual(paletteSuggestions('NOEL', tags)[0].value, { ids: ['n'], mode: 'any' });
  for (const [value, family] of [['favori', 'favoritesOnly'], ['favorite', 'favoritesOnly'], ['preferiti', 'favoritesOnly'], ['compléter', 'incompleteOnly'], ['projet', 'formats'], ['ZIP', 'formats'], ['7z', 'formats'], ['dossier', 'formats'], ['introuvable', 'missingFilesOnly']]) assert.equal(paletteSuggestions(value)[0].family, family);
});
test('palette finds at most six cards using the existing search semantics', () => {
  const cards = Array.from({ length: 9 }, (_, i) => card({ id: String(i), title: 'Lune Noël' }));
  assert.equal(paletteCards(cards, 'noel lune').length, 6);
  assert.equal(paletteCards(cards, 'soleil').length, 0);
  assert.equal(paletteCards(cards, '').length, 0);
});
test('each criterion adds one chip, removes independently, resets; tag suggestions accumulate with OR', () => {
  let state = initialFilterState();
  for (const criterion of CRITERIA) {
    const suggestion = criterion.family === 'tags' ? paletteSuggestions('noel', tags)[0] : criterion.family === 'formats' ? paletteSuggestions('projet')[0] : criterion;
    state = filterStateReducer(state, suggestionAction(suggestion, state.filters));
  }
  assert.equal(filterSummary(state).length, 6);
  state = filterStateReducer(state, suggestionAction(paletteSuggestions('animaux', tags)[0], state.filters));
  assert.deepEqual(state.filters.tags, { ids: ['n', 'a'], mode: 'any' });
  assert.equal(compactTagLabel(['n', 'a', 'b', 'c'], tags), 'Noël, Animaux +2');
  for (const item of [...filterSummary(state)]) state = filterStateReducer(state, { type: 'remove', family: item.family, key: item.key });
  assert.deepEqual(filterSummary(state), []);
  state = filterStateReducer(state, { type: 'set', family: 'favoritesOnly', value: true });
  state = filterStateReducer(state, { type: 'reset' });
  assert.deepEqual(state.filters, initialFilterState().filters);
});
test('audience includes unknown ages, incomplete is cover OR unknown age, formats are multiple choices', () => {
  const keep = (c, suggestion) => {
    const state = filterStateReducer(initialFilterState(), suggestionAction(suggestion, initialFilterState().filters));
    return !!evaluateCard(c, state.filters);
  };
  const age = paletteSuggestions('5')[0];
  for (const minimum of [0, 3, 5, undefined]) assert.equal(keep(card({ ageMin: minimum }), age), true);
  assert.equal(keep(card({ ageMin: 6 }), age), false);
  const complete = { ...card({ ageMin: 3 }), cover: 'cover' };
  const incomplete = paletteSuggestions('compléter')[0];
  assert.equal(keep(complete, incomplete), false);
  assert.equal(keep({ ...complete, cover: null }, incomplete), true);
  assert.equal(keep({ ...complete, age: { kind: 'unknown', min: null } }, incomplete), true);
  const project = card({ exemplars: [{ format: 'project' }] });
  assert.equal(keep(project, paletteSuggestions('projet')[0]), true);
  assert.equal(keep(project, paletteSuggestions('ZIP')[0]), false);
  assert.equal(keep(complete, paletteSuggestions('ZIP')[0]), true);
  assert.equal(keep({ ...complete, favorite: true }, paletteSuggestions('favori')[0]), true);
  assert.equal(keep(complete, paletteSuggestions('favori')[0]), false);
  assert.equal(keep({ ...complete, offlineReason: 'missing' }, paletteSuggestions('introuvable')[0]), true);
  assert.equal(keep(complete, paletteSuggestions('introuvable')[0]), false);
  assert.equal(keep({ ...complete, tags: [tags[0]] }, { family: 'tags', value: { ids: ['n', 'a'], mode: 'any' } }), true);
});
test('palette keyboard wraps, opens first/last, activates the first option and escapes in two steps', () => {
  assert.deepEqual(paletteKey('ArrowUp', { open: false, active: -1, count: 3 }), { command: 'move', active: 2 });
  assert.deepEqual(paletteKey('ArrowDown', { open: true, active: 2, count: 3 }), { command: 'move', active: 0 });
  assert.deepEqual(paletteKey('Enter', { open: true, active: -1, count: 3 }), { command: 'choose', active: 0 });
  assert.equal(paletteKey('Enter', { open: false, active: 0, count: 3 }), null);
  assert.equal(paletteKey('ArrowUp', { open: true, active: -1, count: 0 }), null);
  assert.deepEqual(paletteKey('Escape', { open: true }), { command: 'close' });
  assert.deepEqual(paletteKey('Escape', { open: false }), { command: 'clear' });
});

test('format suggestions select concrete formats and accumulate with OR', () => {
  let state = initialFilterState();
  for (const [query, value] of [['projet', 'project'], ['ZIP', 'zip'], ['7z', 'sevenZip'], ['dossier', 'folder']]) {
    const suggestion = paletteSuggestions(query)[0];
    assert.deepEqual(suggestion.value, [value]);
    state = filterStateReducer(state, suggestionAction(suggestion, state.filters));
  }
  assert.deepEqual(state.filters.formats, ['project', 'zip', 'sevenZip', 'folder']);
  assert.equal(filterSummary(state).length, 1);
  state = filterStateReducer(state, suggestionAction(paletteSuggestions('ZIP')[0], state.filters));
  assert.deepEqual(state.filters.formats, ['project', 'zip', 'sevenZip', 'folder']);
  assert.deepEqual(paletteSuggestions('pack'), []);
});
