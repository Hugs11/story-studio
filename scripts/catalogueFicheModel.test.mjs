import test from 'node:test';
import assert from 'node:assert/strict';
import { card } from './catalogueFixtures.mjs';
import { detailsRow, durationCell, storiesCell } from '../src/store/catalogue/detailsRow.js';
import { LIST_COLUMNS } from '../src/store/catalogue/listColumns.js';
import { ficheModel } from '../src/store/catalogue/ficheModel.js';
import { memoizePipeline } from '../src/store/catalogue/pipeline.js';
test('details columns, missing data and reliable durations/stories only', () => {
  assert.deepEqual(LIST_COLUMNS.map(c => c.id), ['cover','title','age','duration','formats','tags','summary','stories','language','author','producer','bonus']);
  const row = detailsRow(card({ title: 'Lune' }));
  for (const key of ['summary','age','language','duration','stories','author','producer','bonus','version','modifiedAt']) assert.equal(row[key].kind, 'missing', key);
  assert.equal(durationCell(null).kind, 'missing');
  assert.equal(storiesCell(1.5).kind, 'missing');
  assert.equal(durationCell(120).params.count, 2);
});
test('unavailable reference preserves values, age provenance/conflict and all paths', () => {
  const c = card({ title: 'Lune', description: 'Dernier résumé', referenceUnavailable: true, ageMin: 3, ageFromName: 3, ageConflict: true, exemplars: [{ id: 'ref', path: '/Packs/old.zip', available: false }, { id: 'other' }] });
  c.referenceExemplarId = 'ref';
  const model = ficheModel(c);
  assert.equal(model.reference.unavailable, true);
  assert.equal(model.reference.exemplarId, 'ref');
  assert.equal(model.fields.find(f => f.id === 'description').cell.value, 'Dernier résumé');
  assert.equal(model.exemplars.length, 2);
  assert.equal(model.exemplars.find(e => e.id === 'ref').path.value, '/Packs/old.zip');
  assert.equal(model.fields.find(f => f.id === 'age').notes.length, 2);
});
test('memoized single pipeline reused across two view changes and identical criteria', () => {
  const cards = [card({ id: 'z', title: 'Zèbre' }), card({ id: 'a', title: 'Abeille' })];
  const memo = memoizePipeline();
  const a = memo(cards);
  assert.deepEqual(a.items.map(i => i.card.id), ['a','z']);
  for (const view of ['cards','list']) assert.equal(memo(cards, { view }), a);
  assert.notEqual(memo(cards, { query: 'Zèbre' }), a);
});
