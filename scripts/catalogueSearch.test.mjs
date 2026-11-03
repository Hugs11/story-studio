// Recherche du catalogue : accents, ligatures, casse, tous les mots, champs
// multiples, UUID, noms de fichiers des variantes et explication.

import test from 'node:test';
import assert from 'node:assert/strict';
import { matchCard, searchWords } from '../src/store/catalogue/search.js';
import { card } from './catalogueFixtures.mjs';

const lune = card({
  id: 'lune',
  title: 'La Lune et le Hérisson',
  description: 'Une œuvre douce pour s’endormir',
  keywords: ['Nuit'],
  tags: [{ id: 't1', label: 'Animaux' }],
  exemplars: [
    { id: 'zip', format: 'zip', path: '/B/lune-integrale.zip', uuid: 'bda17862-0d71-41f6-974a-111111111111' },
    { id: 'child', format: 'zip', path: '/A/compil.zip', member: 'packs/Bonus-Noël' },
  ],
});

const words = (query) => searchWords(query);

test('accents, ligatures et casse ignorés', () => {
  assert.deepEqual(matchCard(lune, words('HERISSON')), []);
  assert.deepEqual(matchCard(lune, words('herisson lune')), []);
  assert.equal(matchCard(lune, words('oeuvre'))[0].field, 'description');
  assert.equal(matchCard(lune, words('ŒUVRE'))[0].field, 'description');
});

test('tous les mots sont requis', () => {
  assert.equal(matchCard(lune, words('lune dragon')), null);
  assert.notEqual(matchCard(lune, words('lune nuit')), null);
  assert.deepEqual(searchWords('  '), []);
  assert.deepEqual(matchCard(lune, []), []);
});

test('champs multiples : mots-clés, étiquettes, UUID, noms de fichiers de toutes les variantes', () => {
  assert.equal(matchCard(lune, words('nuit'))[0].key, 'catalogue:search.match.keywords');
  assert.equal(matchCard(lune, words('animaux'))[0].key, 'catalogue:search.match.tags');
  assert.equal(matchCard(lune, words('974a-1111'))[0].key, 'catalogue:search.match.uuid');
  const [fromVariant] = matchCard(lune, words('integrale'));
  assert.deepEqual(fromVariant, { key: 'catalogue:search.match.fileName', params: { name: 'lune-integrale.zip' }, field: 'fileName', exemplarId: 'zip' });
  const [fromChild] = matchCard(lune, words('noel'));
  assert.equal(fromChild.exemplarId, 'child', 'variante d’archive expliquée');
  assert.equal(fromChild.params.name, 'Bonus-Noël');
});

test('pas d’explication quand le titre suffit ; explications dédupliquées sinon', () => {
  assert.deepEqual(matchCard(lune, words('lune')), []);
  const explanations = matchCard(lune, words('lune douce endormir'));
  assert.equal(explanations.length, 1);
  assert.equal(explanations[0].field, 'description');
});

test('une fiche sans titre reste cherchable par ses fichiers', () => {
  const untitled = card({ exemplars: [{ path: '/x/Mon-Pack.zip' }] });
  assert.equal(matchCard(untitled, words('mon-pack'))[0].field, 'fileName');
});
