import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDraft, draftReducer, validateDraft } from '../src/store/catalogue/metadataDraft.js';
import { ficheDraftChanges } from '../src/store/catalogue/ficheEditing.js';
import { fieldId } from '../src/store/catalogue/cardModel.js';
import { createCatalogueDataApi } from '../src/store/catalogue/catalogueDataApi.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/catalogue/card-detail.json', import.meta.url)));
// Mirror metadata::apply_inner: a batch needs both age fields, then its
// resolved final state must satisfy min <= max (cleared masks the source).
function engineBatch(source, changes) {
  const ages = changes.filter(c => ['ageMin', 'ageMax'].includes(c.field));
  if (ages.length === 1) throw new Error('batchRequired');
  const effective = { ...source };
  for (const change of ages) effective[change.field] = change.state === 'cleared' ? null : change.state === 'source' ? source[change.field] : change.value;
  if (effective.ageMin != null && effective.ageMax != null && effective.ageMin > effective.ageMax) throw new Error('interval');
  return effective;
}
function edited(maximum, value, corrected = false) {
  const card = structuredClone(fixture);
  const max = card.fields.find(f => f.field === 'ageMax');
  max.referenceValue = { value: maximum };
  max.effective = { value: maximum, origin: corrected ? 'correction' : 'reference' };
  if (corrected) max.correction = { state: 'defined', value: maximum };
  const draft = draftReducer(createDraft(card), { type: 'edit', id: fieldId({ field: 'ageMin' }), patch: { state: value === '' ? 'cleared' : 'defined', value } });
  assert.deepEqual(validateDraft(draft, { singleAge: true }), {});
  return { card, draft };
}
for (const maximum of [0, 4, 12]) {
  for (const value of ['8', '']) {
    test(`fiche age ${value || 'cleared'} clears effective maximum ${maximum} atomically through adapter`, async () => {
      const { card, draft } = edited(maximum, value, maximum === 12);
      const before = structuredClone(card);
      const changes = ficheDraftChanges(draft);
      assert.deepEqual(changes, [value === '' ? { field: 'ageMin', state: 'cleared' } : { field: 'ageMin', state: 'defined', value: 8 }, { field: 'ageMax', state: 'cleared' }]);
      let calls = 0;
      const api = createCatalogueDataApi({ invoke: async (command, args) => {
        calls++;
        assert.equal(command, 'catalogue_mutate');
        assert.equal(args.mutation.kind, 'setMetadataBatch');
        return engineBatch({ ageMax: maximum }, args.mutation.changes);
      } });
      assert.deepEqual(await api.mutate({ kind: 'setMetadataBatch', changes }, 1), { ageMin: value === '' ? null : 8, ageMax: null });
      assert.equal(calls, 1);
      assert.deepEqual(card, before, 'source data is retained');
      assert.equal(draft.entries[fieldId({ field: 'ageMax' })].referenceValue, maximum);
    });
  }
}
for (const value of ['8', '']) {
  test(`fiche without maximum sends ageMin paired with a cleared ageMax (${value || 'cleared'}), accepted by the engine`, () => {
    const { draft } = edited(null, value);
    const changes = ficheDraftChanges(draft);
    assert.deepEqual(changes, [value === '' ? { field: 'ageMin', state: 'cleared' } : { field: 'ageMin', state: 'defined', value: 8 }, { field: 'ageMax', state: 'cleared' }]);
    assert.doesNotThrow(() => engineBatch({}, changes));
  });
}
test('engine bench rejects an unpaired age and an inverted final interval', () => {
  assert.throws(() => engineBatch({ ageMax: 4 }, [{ field: 'ageMin', state: 'defined', value: 8 }]), /batchRequired/);
  assert.throws(() => engineBatch({}, [{ field: 'ageMin', state: 'defined', value: 8 }, { field: 'ageMax', state: 'defined', value: 4 }]), /interval/);
});
test('editing another fiche field leaves its maximum untouched', () => {
  const { card } = edited(4, '8');
  const draft = draftReducer(createDraft(card), { type: 'edit', id: fieldId({ field: 'title' }), patch: { state: 'defined', value: 'New title' } });
  assert.deepEqual(ficheDraftChanges(draft), [{ field: 'title', state: 'defined', value: 'New title' }]);
});
