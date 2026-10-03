import test from 'node:test';
import assert from 'node:assert/strict';

import { bumpPackVersion, generateConventionName, getExportPackName, parseConventionName } from '../src/utils/packConvention.js';

test('bumpPackVersion suggests the next version (and V2 when none)', () => {
  assert.equal(bumpPackVersion(undefined), 2);
  assert.equal(bumpPackVersion(null), 2);
  assert.equal(bumpPackVersion(''), 2);
  assert.equal(bumpPackVersion(1), 2);
  assert.equal(bumpPackVersion('v1'), 2);
  assert.equal(bumpPackVersion(3), 4);
  // La version bumpée donne bien un suffixe de convention.
  assert.equal(
    generateConventionName({ title: 'Mon pack', minAge: '5', version: bumpPackVersion(1) }),
    '5+]Mon_pack_V2',
  );
});

test('parses a valid community convention name', () => {
  const parsed = parseConventionName('3+]Example_stories_(8_chapitres)[by_example_author_V2');

  assert.equal(parsed.minAge, '3');
  assert.equal(parsed.title, 'Example stories');
  assert.equal(parsed.bonus, '8 chapitres');
  assert.equal(parsed.author, 'example author');
  assert.equal(parsed.version, 2);
});

test('non convention name returns null', () => {
  assert.equal(parseConventionName('Mon pack perso'), null);
});

test('parses a convention zip filename without keeping the extension', () => {
  const parsed = parseConventionName('4+]Example_story_V2.zip');

  assert.equal(parsed.minAge, '4');
  assert.equal(parsed.title, 'Example story');
  assert.equal(parsed.version, 2);
});

test('generates a minimal convention name', () => {
  assert.equal(generateConventionName({ title: 'Mon pack' }), '3+]Mon_pack');
});

test('generates a producer prefix even without author', () => {
  assert.equal(generateConventionName({
    title: 'Example stories',
    producer: 'Example Producer',
    version: 3,
    minAge: '3',
  }), '3+]Example_Producer-Example_stories_V3');
});

test('roundtrips a convention name through parse and generate', () => {
  const raw = '3+]Example_stories_(8_chapitres)[by_example_author_V2';
  assert.equal(generateConventionName(parseConventionName(raw)), raw);
});

test('roundtrips a custom minimum age', () => {
  const raw = '5+]Example_stories_V2';
  const parsed = parseConventionName(raw);

  assert.equal(parsed.minAge, '5');
  assert.equal(generateConventionName(parsed), raw);
});

test('roundtrips a producer with spaces and a bonus', () => {
  const raw = '3+]Example_Producer-Example_stories_(8_chapitres)[by_example_author_V2';
  const parsed = parseConventionName(raw);

  assert.equal(parsed.producer, 'Example Producer');
  assert.equal(parsed.bonus, '8 chapitres');
  assert.equal(generateConventionName(parsed), raw);
});

test('does not mistake a hyphenated title for a producer', () => {
  const parsed = parseConventionName('3+]Example_stories[by_example_author_V2');

  assert.equal(parsed.producer, '');
  assert.equal(parsed.title, 'Example stories');
});

test('legacy naming mode preserves the raw export name', () => {
  assert.equal(getExportPackName({
    title: 'Mon pack perso',
    namingMode: 'legacy',
    legacyExportName: 'Mon pack perso',
  }), 'Mon pack perso');
});

test('un nom libre vide reprend le titre sans préfixe de convention', () => {
  assert.equal(getExportPackName({
    title: 'Mon pack perso',
    minAge: '6',
    version: 2,
    namingMode: 'legacy',
    legacyExportName: '',
  }), 'Mon pack perso');
});

test('convention naming mode ignores legacy export name', () => {
  assert.equal(getExportPackName({
    title: 'Mon pack perso',
    namingMode: 'convention',
    legacyExportName: 'Mon pack perso',
  }), '3+]Mon_pack_perso');
});

test('a title that repeats the age prefix does not double it in the convention name', () => {
  assert.equal(
    generateConventionName({ title: '3+ Example-graphe', minAge: '3', version: 3 }),
    '3+]Example-graphe_V3',
  );
  assert.equal(generateConventionName({ title: '6+]Titre', minAge: '6' }), '6+]Titre');
});

test('a number that is not an age prefix stays in the title', () => {
  assert.equal(generateConventionName({ title: '3+5 Histoires', minAge: '3' }), '3+]3+5_Histoires');
  assert.equal(generateConventionName({ title: '3+Titre', minAge: '3' }), '3+]3+Titre');
});

test('without an entered age, the convention name takes the age the title carries', () => {
  // Pack importé « 5+ Titre du pack » : sans âge saisi, il sortait « 3+]… ».
  assert.equal(
    generateConventionName({ title: '5+ Titre du pack', minAge: '', version: 2 }),
    '5+]Titre_du_pack_V2',
  );
  // Un âge saisi l'emporte sur celui du titre.
  assert.equal(generateConventionName({ title: '5+ Titre', minAge: '7' }), '7+]Titre');
  // Ni l'un ni l'autre : 3, comme avant.
  assert.equal(generateConventionName({ title: 'Titre' }), '3+]Titre');
});
