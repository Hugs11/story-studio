// Tris du catalogue : stables, valeurs manquantes en dernier dans les deux
// sens, départage par titre puis identifiant.

import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSort, sortEntries } from '../src/store/catalogue/sort.js';
import { card } from './catalogueFixtures.mjs';

const entry = (spec, representative = {}) => {
  const value = card(spec);
  return { card: value, representative: { ...value.exemplars[0], ...representative } };
};
const ids = (entries) => entries.map((item) => item.card.id);

test('titre : collation sans casse ni accents, nombres naturels, manquant en dernier', () => {
  const entries = [
    entry({ id: 'c', title: 'Zèbre' }),
    entry({ id: 'n', title: undefined }),
    entry({ id: 'b', title: 'éléphant' }),
    entry({ id: 'a', title: 'Conte 10' }),
    entry({ id: 'd', title: 'Conte 9' }),
  ];
  assert.deepEqual(ids(sortEntries(entries, { key: 'title', direction: 'asc' })), ['d', 'a', 'b', 'c', 'n']);
  assert.deepEqual(ids(sortEntries(entries, { key: 'title', direction: 'desc' })), ['c', 'b', 'a', 'd', 'n']);
});

test('taille et date de l’exemplaire représentatif ; manquants en dernier dans les deux sens', () => {
  const entries = [
    entry({ id: 'big', title: 'B' }, { sizeBytes: 900, modifiedAt: 3 }),
    entry({ id: 'none', title: 'A' }, { sizeBytes: null, modifiedAt: null }),
    entry({ id: 'small', title: 'C' }, { sizeBytes: 100, modifiedAt: 5 }),
  ];
  assert.deepEqual(ids(sortEntries(entries, { key: 'size', direction: 'asc' })), ['small', 'big', 'none']);
  assert.deepEqual(ids(sortEntries(entries, { key: 'size', direction: 'desc' })), ['big', 'small', 'none']);
  assert.deepEqual(ids(sortEntries(entries, { key: 'modifiedAt', direction: 'desc' })), ['small', 'big', 'none']);
  assert.deepEqual(ids(sortEntries(entries, { key: 'modifiedAt', direction: 'asc' })), ['big', 'small', 'none']);
});

test('FICHED âge : minimum seul ; une ancienne tranche inversée garde son minimum', () => {
  const entries = [
    entry({ id: 'unknown', title: 'U' }),
    entry({ id: 'r36', title: 'R', ageMin: 3, ageMax: 6 }),
    entry({ id: 'p3', title: 'P', ageMin: 3 }),
    entry({ id: 'bad', title: 'X', ageMin: 9, ageMax: 2 }),
    entry({ id: 'p7', title: 'Q', ageMin: 7 }),
  ];
  assert.deepEqual(ids(sortEntries(entries, { key: 'age', direction: 'asc' })), ['p3', 'r36', 'p7', 'bad', 'unknown']);
  assert.deepEqual(ids(sortEntries(entries, { key: 'age', direction: 'desc' })), ['bad', 'p7', 'p3', 'r36', 'unknown']);
});

test('ajout au catalogue et durée ; départage par titre puis identifiant, quel que soit l’ordre d’entrée', () => {
  const entries = [
    entry({ id: 'b', title: 'Même', addedAt: 10 }),
    entry({ id: 'a', title: 'Même', addedAt: 10 }),
    entry({ id: 'c', title: 'Autre', addedAt: 10 }),
    entry({ id: 'd', title: 'Zed', addedAt: 20, durationSeconds: 60 }),
  ];
  const expected = ['c', 'a', 'b', 'd'];
  assert.deepEqual(ids(sortEntries(entries, { key: 'addedAt' })), expected);
  assert.deepEqual(ids(sortEntries([...entries].reverse(), { key: 'addedAt' })), expected);
  assert.deepEqual(ids(sortEntries(entries, { key: 'addedAt', direction: 'desc' })), ['d', 'c', 'a', 'b']);
  assert.deepEqual(ids(sortEntries(entries, { key: 'duration', direction: 'desc' })), ['d', 'c', 'a', 'b']);
});

test('tri inconnu ramené au titre croissant', () => {
  assert.deepEqual(normalizeSort({ key: 'bogus', direction: 'up' }), { key: 'title', direction: 'asc' });
});

test('format : meilleur rang des exemplaires présentés, puis titre ; sans format en dernier', () => {
  const withFormats = (id, title, formats) => {
    const value = entry({ id, title });
    return { ...value, matching: formats.map((format) => ({ format })), representative: { format: formats[0] } };
  };
  const entries = [
    withFormats('d', 'Dossier', ['folder']),
    withFormats('p2', 'Zeta', ['project']),
    withFormats('multi', 'Multi', ['folder', 'zip']),
    withFormats('p1', 'Alpha', ['sevenZip', 'project']),
    withFormats('z', 'Zip', ['zip']),
    { ...entry({ id: 'none', title: 'A' }), matching: [], representative: { format: null } },
  ];
  assert.deepEqual(ids(sortEntries(entries, { key: 'format', direction: 'asc' })), ['p1', 'p2', 'multi', 'z', 'd', 'none']);
  assert.deepEqual(ids(sortEntries(entries, { key: 'format', direction: 'desc' })), ['d', 'multi', 'z', 'p1', 'p2', 'none']);
  assert.equal(normalizeSort({ key: 'format', direction: 'desc' }).key, 'format');
});

test('sens naturel : texte et nombres croissants, dates et taille décroissants', async () => {
  const { naturalDirection, COLUMN_SORT_KEYS, SORT_KEYS } = await import('../src/store/catalogue/sort.js');
  for (const key of ['title', 'age', 'duration', 'format', 'stories', 'language', 'author', 'producer']) assert.equal(naturalDirection(key), 'asc', key);
  for (const key of ['addedAt', 'modifiedAt', 'size']) assert.equal(naturalDirection(key), 'desc', key);
  for (const key of Object.values(COLUMN_SORT_KEYS)) assert.ok(SORT_KEYS.includes(key), key);
});

test('langue, auteur, producteur et nombre d’histoires : manquants en dernier dans les deux sens', () => {
  const withFields = (spec, fields) => { const item = entry(spec); Object.assign(item.card, fields); return item; };
  const entries = [
    withFields({ id: 'b', title: 'B', author: 'Zoé', language: 'fr' }, { producer: 'Studio B', storyCount: 10 }),
    entry({ id: 'none', title: 'N' }),
    withFields({ id: 'a', title: 'A', author: 'alice', language: 'en' }, { producer: 'Studio A', storyCount: 2 }),
  ];
  for (const [key] of [['author'], ['language'], ['producer'], ['stories']]) {
    assert.deepEqual(ids(sortEntries(entries, { key, direction: 'asc' })), ['a', 'b', 'none'], `${key} asc`);
    assert.deepEqual(ids(sortEntries(entries, { key, direction: 'desc' })), ['b', 'a', 'none'], `${key} desc`);
  }
});

test('langue : tri sur le nom affiché, pas sur le code', () => {
  const entries = [entry({ id: 'en', title: 'X', language: 'en' }), entry({ id: 'ar', title: 'X', language: 'ar' }), entry({ id: 'de', title: 'X', language: 'de' })];
  for (const item of entries) item.card.language = item.card.id;
  assert.deepEqual(ids(sortEntries(entries, { key: 'language', direction: 'asc' })), ['de', 'en', 'ar']);
});
