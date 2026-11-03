// MPL-2.0: tri-state/reset/rebase cases adapted from STUdio Perso
// utils/overridesDraft.test.js. D49 partial-age semantics are Story Studio's.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createDraft, draftChanges, draftReducer, mergeDraft, dirtyDraft, validateDraft, protectDraft } from '../src/store/catalogue/metadataDraft.js';
import { cardModel, fieldId } from '../src/store/catalogue/cardModel.js';
import { compareExemplars } from '../src/store/catalogue/compareExemplars.js';
import { LANGUAGE_OPTIONS, validLanguage } from '../src/store/catalogue/languageOptions.js';
import { createCatalogueDataApi, REVISION_CONFLICT } from '../src/store/catalogue/catalogueDataApi.js';
import { normalizeEntry } from '../src/store/catalogue/entryModel.js';
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/catalogue/card-detail.json', import.meta.url)));
const outcome = JSON.parse(fs.readFileSync(new URL('./fixtures/catalogue/mutation-outcome.json', import.meta.url)));
const key = name => fieldId({ field: name });
const edit = (d, field, patch) => draftReducer(d, { type: 'edit', id: key(field), patch });
test('three states, explicit reset, equal correction remains defined, age batch', () => {
  let d = createDraft(fixture); assert.equal(dirtyDraft(d), false);
  d = edit(d, 'title', { state: 'defined', value: 'Source' });
  d = edit(d, 'ageMin', { state: 'cleared' });
  assert.ok(dirtyDraft(d)); assert.deepEqual(draftChanges(d).find(c => c.field === 'title'), { field: 'title', state: 'defined', value: 'Source' });
  assert.deepEqual(draftChanges(d).find(c => c.field === 'ageMin'), { field: 'ageMin', state: 'cleared' });
  const stored = structuredClone(fixture); stored.fields[0].correction = { state: 'defined', value: 'Personal' };
  d = edit(createDraft(stored), 'title', { state: 'source', value: 'ignored' });
  assert.deepEqual(draftChanges(d), [{ field: 'title', state: 'source' }]);
});
test('rebase preserves user edits, adopts untouched fields and exposes side-by-side conflict', () => {
  const d = edit(createDraft(fixture), 'title', { state: 'defined', value: 'Ours' });
  const fresh = structuredClone(fixture); fresh.ficheRevision++; fresh.catalogueRevision++;
  fresh.fields[0].correction = { state: 'defined', value: 'Theirs' };
  fresh.fields[1].correction = { state: 'defined', value: 4 };
  const rebased = mergeDraft(d, fresh);
  assert.equal(rebased.entries[key('title')].value, 'Ours'); assert.equal(rebased.entries[key('ageMin')].value, '4');
  assert.equal(rebased.conflicts[key('title')].theirs.value, 'Theirs');
  const resolved = draftReducer(rebased, { type: 'conflict', id: key('title'), keep: 'server' });
  assert.equal(dirtyDraft(resolved), false);
});
test('display validation catches invalid integer and inherited age interval', () => {
  let d = edit(createDraft(fixture), 'ageMin', { state: 'defined', value: '-1' }); assert.ok(validateDraft(d)[key('ageMin')]);
  const card = structuredClone(fixture); card.fields[2].referenceValue = { value: 3 }; card.fields[2].effective = { value: 3, origin: 'reference' };
  d = edit(createDraft(card), 'ageMin', { state: 'defined', value: '8' }); assert.equal(validateDraft(d)[key('ageMin')], 'catalogue:fiche.edit.ageInterval');
});
test('localized drafts do not replace another language', () => {
  let d = draftReducer(createDraft(fixture), { type: 'addLanguage', language: 'it' });
  const id = fieldId({ field: 'description', language: 'it' });
  d = draftReducer(d, { type: 'edit', id, patch: { state: 'defined', value: 'Italiano' } });
  const rebased = mergeDraft(d, fixture); assert.equal(rebased.entries[id].value, 'Italiano');
  assert.equal(draftChanges(rebased)[0].language, 'it');
  assert.deepEqual(rebased.conflicts, {});
  for (const field of ['title', 'description', 'bonus', 'keywords']) assert.ok(rebased.entries[fieldId({ field, language: 'it' })]);
  const concurrent = structuredClone(fixture);
  concurrent.fields.push({ field: 'description', language: 'it', correction: { state: 'defined', value: 'Server' }, effective: { value: 'Server', origin: 'correction' } });
  const conflict = mergeDraft(d, concurrent);
  assert.equal(conflict.conflicts[id].theirs.value, 'Server');
  const vanished = mergeDraft(conflict, fixture);
  const resolved = draftReducer(vanished, { type: 'conflict', id, keep: 'server' });
  assert.equal(resolved.entries[id].state, 'source');
  assert.deepEqual(validateDraft(resolved), {});
  assert.deepEqual(draftChanges(resolved), []);
});
test('comparison marks differences and keeps ages inside their exemplar', () => {
  const copies = [{ fields: { ageMin: { value: 3, validity: 'valid', presence: 'present' } } }, { fields: { ageMax: { value: 8, validity: 'valid', presence: 'present' } } }];
  const rows = compareExemplars(copies); assert.ok(rows.find(r => r.field === 'ageMin').different);
  assert.equal(rows.find(r => r.field === 'ageMin').cells[1], null); assert.equal(rows.find(r => r.field === 'ageMax').cells[0], null);
});
test('display model covers origins, unavailable reference and prefix conflict', () => {
  for (const origin of ['correction', 'reference', 'filename', 'cleared', 'none']) {
    const card = structuredClone(fixture); card.fields[1].effective = { value: null, origin }; card.reference.state = 'unavailable'; card.fields[1].derived = { filename: '3+Titre.zip', conflict: [{ filename: '7+Titre.zip', value: 7 }] };
    const model = cardModel(card); assert.ok(model.unavailable); assert.equal(model.fields[1].originKey, `catalogue:fiche.edit.origin.${origin}`); assert.ok(model.fields[1].conflictKey); assert.equal(model.fields[1].filename, ['reference', 'filename'].includes(origin) ? '3+Titre.zip' : '');
  }
});
test('languages are short lowercase codes and entry model retains corrections', () => {
  assert.ok(LANGUAGE_OPTIONS.every(([code]) => validLanguage(code))); for (const code of ['FR', '[FR]', 'fr-FR', '', 'abcd']) assert.equal(validLanguage(code), false);
  const entry = normalizeEntry({ values: {}, language: 'it', durationSeconds: 65, storyCount: 2, ficheRevision: 3, corrections: { description: 'defined' } });
  assert.equal(entry.language, 'it'); assert.equal(entry.ficheRevision, 3); assert.deepEqual(entry.corrections, { description: 'defined' });
});
test('IPC contract, staged image and revision-conflict code remain recognizable', async () => {
  const calls = [];
  const api = createCatalogueDataApi({ invoke: async (command, args) => { calls.push([command, args]); if (command === 'catalogue_get_card') return fixture; if (command === 'catalogue_mutate') return outcome; return { coverStagingId: 'staged' }; } });
  assert.deepEqual(await api.getCard('card'), fixture); assert.deepEqual(await api.mutate({ kind: 'setMetadataBatch', requestKey: 'r' }, 1), outcome);
  assert.equal((await api.stageCover('/image.png')).coverStagingId, 'staged'); await api.discardCovers(['staged']);
  assert.equal(calls[0][1].ficheId, 'card'); assert.equal(calls[1][1].expectedCatalogueRevision, 1);
  const failing = createCatalogueDataApi({ invoke: async () => { throw { code: REVISION_CONFLICT, params: {} }; } }); await assert.rejects(failing.getCard('card'), e => e.code === REVISION_CONFLICT);
  // Only an opened fiche asks the engine to read its archives.
  assert.deepEqual(calls[0][1], { ficheId: 'card' });
  await api.getCard('card', { inspectArchives: true });
  assert.deepEqual(calls.at(-1), ['catalogue_get_card', { ficheId: 'card', inspectArchives: true }]);
});

test('abandon protection keeps drafts on cancel or failed save and covers simulation', async () => {
 const draft = edit(createDraft(fixture), 'title', { state: 'defined', value: 'Draft' });
 for (const choice of ['stay', 'save', 'discard']) {
   let called = 0;
   const allowed = await protectDraft(draft, { ask: async () => choice, save: async () => { called++; return false; } });
   assert.equal(allowed, choice === 'discard'); assert.equal(called, choice === 'save' ? 1 : 0);
   assert.equal(draft.entries[key('title')].value, 'Draft');
 }
 assert.equal(await protectDraft(draft, { ask: async () => 'save', save: async () => true }), true);
 assert.equal(await protectDraft(draft, { busy: true }), false);
});

test('comparison preserves simultaneous language candidates and their diagnostics', () => {
 const localized = (language, value, validity = 'valid', presence = 'present') => ({ field: 'description', language, value, validity, presence, diagnostic: language });
 const fr = fieldId({ field: 'description', language: 'fr' });
 const it = fieldId({ field: 'description', language: 'it' });
 const rows = compareExemplars([{ fields: { description: localized('', null, 'unknown', 'absent'), [fr]: localized('fr', 'Bonjour'), [it]: localized('it', 42, 'invalid') } }, { fields: { [fr]: localized('fr', 'Salut'), [it]: localized('it', 'Ciao') } }]);
 assert.equal(rows.find(r => r.id === fr).different, true);
 assert.equal(rows.find(r => r.id === fr).cells[0].value, 'Bonjour');
 assert.equal(rows.find(r => r.id === it).cells[0].diagnostic, 'it');
 assert.equal(rows.find(r => r.id === it).different, true);
});
test('reference change during editing preserves correction and exposes effective server value', () => {
 const draft = edit(createDraft(fixture), 'title', { state: 'defined', value: 'Ours' });
 const fresh = structuredClone(fixture);
 fresh.fields[0].referenceValue = { value: 'New reference', provenanceId: 'new' };
 fresh.fields[0].effective = { value: 'New reference', origin: 'reference' };
 const merged = mergeDraft(draft, fresh);
 assert.equal(merged.entries[key('title')].value, 'Ours');
 assert.equal(merged.conflicts[key('title')].theirs.state, 'source');
 assert.equal(merged.conflicts[key('title')].theirs.effective, 'New reference');
});

test('explicit card removal preserves preview revision through the data adapter', async () => {
  const calls = [];
  const api = createCatalogueDataApi({ invoke: async (command, args) => { calls.push({ command, args }); return { catalogueRevision: 14, count: 2 }; } });
  const preview = await api.previewRemoveCards(['A', 'B']);
  await api.removeCards(['A', 'B'], preview.catalogueRevision);
  assert.deepEqual(calls, [
    { command: 'catalogue_preview_remove_cards', args: { ficheIds: ['A', 'B'] } },
    { command: 'catalogue_remove_cards', args: { ficheIds: ['A', 'B'], expectedCatalogueRevision: 14 } },
  ]);
});

test('provider changes at equal values preserve pen edits without conflict', () => {
  const card = structuredClone(fixture);
  const title = card.fields.find(f => f.field === 'title');
  title.correction = { state: 'source' };
  title.referenceValue = { value: 'Source', provenanceId: 'observed:first' };
  title.effective = { value: 'Source', origin: 'reference', provenanceId: 'observed:first' };
  const draft = edit(createDraft(card), 'title', { state: 'defined', value: 'Ours' });
  const fresh = structuredClone(card);
  fresh.ficheRevision++; fresh.catalogueRevision++;
  fresh.fields.find(f => f.field === 'title').referenceValue.provenanceId = 'import-second';
  fresh.fields.find(f => f.field === 'title').effective.provenanceId = 'import-second';
  const rebased = mergeDraft(draft, fresh);
  assert.deepEqual(rebased.conflicts, {});
  assert.equal(rebased.entries[key('title')].value, 'Ours');
  assert.deepEqual(draftChanges(rebased), [{ field: 'title', state: 'defined', value: 'Ours' }]);
  fresh.fields.find(f => f.field === 'title').referenceValue.value = 'Changed';
  fresh.fields.find(f => f.field === 'title').effective.value = 'Changed';
  assert.ok(mergeDraft(rebased, fresh).conflicts[key('title')]);
});
