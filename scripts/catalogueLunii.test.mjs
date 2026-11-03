import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalizeEntry } from '../src/store/catalogue/entryModel.js';
import { matchCard, searchWords } from '../src/store/catalogue/search.js';
test('official database has no manual or network configuration API', () => {
  const commands = fs.readFileSync(new URL('../src-tauri/src/commands/catalogue_lunii.rs', import.meta.url), 'utf8');
  for (const name of ['refresh', 'status', 'import', 'network']) assert.equal(commands.includes(`fn catalogue_lunii_${name}`), false);
  assert.equal(fs.existsSync(new URL('../src/store/catalogue/catalogueLuniiApi.js', import.meta.url)), false);
});
test('derived titles, subtitles, description, keywords and age join the existing pipeline', () => {
  const card = normalizeEntry({ values: { title: 'Lune', ageMin: 5 }, subtitle: 'Voyage', description: 'Aventure', keywords: ['étoiles'], titleConflict: true });
  for (const query of ['lune', 'voyage', 'aventure', 'etoiles']) assert.notEqual(matchCard(card, searchWords(query)), null);
  assert.equal(matchCard(card, searchWords('voyage'))[0].key, 'catalogue:search.match.subtitle');
  assert.equal(card.titleConflict, true); assert.equal(card.age.min, 5);
});

test('a cleared title remains empty while the header uses the filename supplied by Rust', () => {
  const card = normalizeEntry({ values: {}, displayTitle: 'Filename', corrections: { title: 'cleared' } });
  assert.equal(card.title, null);
  assert.equal(card.displayTitle, 'Filename');
  assert.equal(card.corrections.title, 'cleared');
});

import { evaluateCard, normalizeFilters } from '../src/store/catalogue/filters.js';
import { detailsRow } from '../src/store/catalogue/detailsRow.js';

test('missing title uses real metadata while display and search retain the filename', () => {
  for (const corrections of [{}, { title: 'cleared' }]) {
    const card = normalizeEntry({ values: {}, displayTitle: 'Fallback', corrections, exemplars: [{ id: 'file', format: 'zip', state: 'available', locator: {path:'/pack.zip'} }] });
    assert.equal(card.title, null);
    assert.equal(detailsRow(card).titleMissing, true);
    assert.equal(detailsRow(card).title.value, 'Fallback');
    assert.notEqual(evaluateCard(card, normalizeFilters({ missing: ['title'], availability: 'all' })), null);
    assert.notEqual(matchCard(card, searchWords('fallback')), null);
  }
  const official = normalizeEntry({ values: {title:'Lune'}, exemplars: [{id:'file',format:'zip'}] });
  assert.equal(evaluateCard(official, normalizeFilters({missing:['title'], availability:'all'})), null);
});
