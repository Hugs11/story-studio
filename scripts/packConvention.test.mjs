import test from 'node:test';
import assert from 'node:assert/strict';

import { generateConventionName, getExportPackName, parseConventionName } from '../src/utils/packConvention.js';

test('parses a valid community convention name', () => {
  const parsed = parseConventionName('3+]Les_histoires_de_Mini-loup_(8_chapitres)[by_funkyfoenky_V2');

  assert.equal(parsed.minAge, '3');
  assert.equal(parsed.title, 'Les histoires de Mini-loup');
  assert.equal(parsed.bonus, '8 chapitres');
  assert.equal(parsed.author, 'funkyfoenky');
  assert.equal(parsed.version, 2);
});

test('non convention name returns null', () => {
  assert.equal(parseConventionName('Mon pack perso'), null);
});

test('generates a minimal convention name', () => {
  assert.equal(generateConventionName({ title: 'Mon pack' }), '3+]Mon_pack');
});

test('generates a producer prefix even without author', () => {
  assert.equal(generateConventionName({
    title: 'Les histoires de Mini-loup',
    producer: 'Philippe Matter',
    version: 3,
    minAge: '3',
  }), '3+]Philippe_Matter-Les_histoires_de_Mini-loup_V3');
});

test('roundtrips a convention name through parse and generate', () => {
  const raw = '3+]Les_histoires_de_Mini-loup_(8_chapitres)[by_funkyfoenky_V2';
  assert.equal(generateConventionName(parseConventionName(raw)), raw);
});

test('roundtrips a custom minimum age', () => {
  const raw = '5+]Les_histoires_de_Mini-loup_V2';
  const parsed = parseConventionName(raw);

  assert.equal(parsed.minAge, '5');
  assert.equal(generateConventionName(parsed), raw);
});

test('roundtrips a producer with spaces and a bonus', () => {
  const raw = '3+]France_Inter-Les_histoires_(8_chapitres)[by_Moi_V2';
  const parsed = parseConventionName(raw);

  assert.equal(parsed.producer, 'France Inter');
  assert.equal(parsed.bonus, '8 chapitres');
  assert.equal(generateConventionName(parsed), raw);
});

test('does not mistake a hyphenated title for a producer', () => {
  const parsed = parseConventionName('3+]Les_histoires_de_Mini-loup[by_funkyfoenky_V2');

  assert.equal(parsed.producer, '');
  assert.equal(parsed.title, 'Les histoires de Mini-loup');
});

test('legacy naming mode preserves the raw export name', () => {
  assert.equal(getExportPackName({
    title: 'Mon pack perso',
    namingMode: 'legacy',
    legacyExportName: 'Mon pack perso',
  }), 'Mon pack perso');
});

test('convention naming mode ignores legacy export name', () => {
  assert.equal(getExportPackName({
    title: 'Mon pack perso',
    namingMode: 'convention',
    legacyExportName: 'Mon pack perso',
  }), '3+]Mon_pack_perso');
});
