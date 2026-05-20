import test from 'node:test';
import assert from 'node:assert/strict';

import { generateConventionName, getExportPackName, parseConventionName } from '../src/utils/packConvention.js';

test('parses a valid community convention name', () => {
  const parsed = parseConventionName('3+]Example_stories_(8_chapitres)[by_example_author_V2');

  assert.equal(parsed.minAge, '3');
  assert.equal(parsed.title, 'Example stories');
  assert.equal(parsed.bonus, '8 chapitres');
  assert.equal(parsed.author, 'example_author');
  assert.equal(parsed.version, 2);
});

test('non convention name returns null', () => {
  assert.equal(parseConventionName('Mon pack perso'), null);
});

test('generates a minimal convention name', () => {
  assert.equal(generateConventionName({ title: 'Mon pack' }), '3+]Mon_pack');
});

test('roundtrips a convention name through parse and generate', () => {
  const raw = '3+]Example_stories_(8_chapitres)[by_example_author_V2';
  assert.equal(generateConventionName(parseConventionName(raw)), raw);
});

test('roundtrips a producer with spaces and a bonus', () => {
  const raw = '3+]Example_Producer-Les_histoires_(8_chapitres)[by_Moi_V2';
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

test('convention naming mode ignores legacy export name', () => {
  assert.equal(getExportPackName({
    title: 'Mon pack perso',
    namingMode: 'convention',
    legacyExportName: 'Mon pack perso',
  }), '3+]Mon_pack_perso');
});
