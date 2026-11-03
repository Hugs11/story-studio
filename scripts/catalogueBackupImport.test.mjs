import test from 'node:test';
import assert from 'node:assert/strict';
import fixture from './fixtures/catalogue/backup-import.json' with { type: 'json' };
import { createCatalogueBackupApi } from '../src/store/catalogue/catalogueBackupApi.js';
import { importPage, importResult, INITIAL_IMPORT, importPreviewReducer as reduce, canApplyImport } from '../src/store/catalogue/importPreviewState.js';
import { conflictChoice, choicePayload, reusableChoices } from '../src/store/catalogue/importConflicts.js';
const planned = () => reduce({ ...INITIAL_IMPORT, phase: 'preparing' }, { type: 'page', page: structuredClone(fixture.preview) });
test('manual contract fixture validates and adapter sends exact command arguments', async () => {
 const calls = [];
 const api = createCatalogueBackupApi({ invoke: async (command, args) => {
  calls.push([command, args]);
  if (command === 'catalogue_get_import_preview') return fixture.preview;
  if (command === 'catalogue_get_operation') return { ...fixture.receipt, sequence: 1, status: 'success', result: fixture.result };
  return fixture.receipt;
 } });
 assert.deepEqual(await api.previewImport('/backup.zip', 'request'), fixture.receipt);
 assert.deepEqual(await api.importPage('preview'), fixture.preview);
 const args = { previewId: 'preview', choices: { 'favorite-conflict': 'incoming' }, associations: {}, expectedCatalogueRevision: 7, requestId: 'apply' };
 assert.deepEqual(await api.applyImport(args), fixture.receipt);
 assert.deepEqual((await api.importOperation('operation', 'apply')).result, fixture.result);
 assert.deepEqual(calls.slice(0, 3), [
  ['catalogue_preview_import', { path: '/backup.zip', requestId: 'request', associations: {} }],
  ['catalogue_get_import_preview', { previewId: 'preview', offset: 0, limit: 100 }],
  ['catalogue_apply_import', args],
 ]);
});
for (const suffix of ['INVALID', 'VERSION_UNSUPPORTED', 'LIMIT_EXCEEDED', 'PREVIEW_EXPIRED', 'SOURCE_CHANGED', 'ASSOCIATION_INVALID', 'FAILED']) {
 test(`adapter preserves CATALOG_IMPORT_${suffix}`, async () => {
  const code = `CATALOG_IMPORT_${suffix}`;
  const api = createCatalogueBackupApi({ invoke: async () => { throw { code, params: {} }; } });
  await assert.rejects(api.previewImport('/backup.zip', 'request'), error => error.code === code && error.userMessage.code === code);
 });
}
test('hostile DTOs never reach the presentation', () => {
 for (const patch of [{ formatVersion: 2 }, { backupDigest: 'x' }, { expectedCatalogueRevision: -1 }, { limit: 101 }, { conflicts: { total: 1, items: [] } }, { unresolved: { total: 1, items: [{ id: 'x', reason: 'unknown' }] } }]) assert.throws(() => importPage({ ...fixture.preview, ...patch }));
 for (const patch of [{ imported: -1 }, { catalogueRevision: 2.5 }, { reportId: null }]) assert.throws(() => importResult({ ...fixture.result, ...patch }));
});
test('local default, global switch and individual override coexist', () => {
 let state = planned(); const conflict = state.preview.conflicts.items[0];
 assert.equal(conflictChoice(state, conflict), 'local');
 state = reduce(state, { type: 'global', choice: 'incoming' }); assert.equal(conflictChoice(state, conflict), 'incoming');
 state = reduce(state, { type: 'choice', id: conflict.id, choice: 'local' }); assert.equal(conflictChoice(state, conflict), 'local');
 assert.deepEqual(choicePayload(state, [conflict]), { 'favorite-conflict': 'local' });
 assert.equal(Object.keys(reusableChoices(state.choices, [conflict])).length, 1);
 assert.equal(Object.keys(reusableChoices(state.choices, [{ ...conflict, local: 99 }])).length, 0);
 assert.equal(conflictChoice(state, { ...conflict, incoming: 2 }), 'incoming');
 assert.equal(reduce(state, { type: 'choice', id: 'foreign', choice: 'incoming' }), state);
});
test('an association blocks application until another preview is reviewed', () => {
 let state = planned(); assert.equal(canApplyImport(state), true);
 state = reduce(state, { type: 'associate', id: 'remote-card', target: 'local-card' });
 assert.equal(canApplyImport(state), false);
 state = reduce(state, { type: 'page', page: fixture.preview, prepared: true }); assert.equal(canApplyImport(state), true);
});
test('busy state cannot close or change the file', () => {
 const state = reduce(planned(), { type: 'begin', mode: 'apply' });
 assert.equal(reduce(state, { type: 'close' }), state); assert.equal(reduce(state, { type: 'path', path: '/other.zip' }), state);
});
test('stale and foreign operation events are ignored and success validates result', () => {
 let state = reduce(reduce(planned(), { type: 'begin', mode: 'apply' }), { type: 'receipt', receipt: fixture.receipt });
 state = reduce(state, { type: 'progress', progress: { operationId: 'operation', sequence: 3, status: 'running' } });
 assert.equal(reduce(state, { type: 'progress', progress: { operationId: 'operation', sequence: 2, status: 'success' } }), state);
 assert.equal(reduce(state, { type: 'progress', progress: { operationId: 'foreign', sequence: 4, status: 'success' } }), state);
 state = reduce(state, { type: 'progress', progress: { operationId: 'operation', sequence: 4, status: 'success', result: fixture.result } });
 assert.equal(state.phase, 'success'); assert.deepEqual(state.result, fixture.result);
});
for (const status of ['failed', 'partial', 'cancelled']) test(`terminal ${status} keeps choices and never claims an applied result`, () => {
 let state = reduce(planned(), { type: 'begin', mode: 'apply' }); state = reduce(state, { type: 'receipt', receipt: fixture.receipt });
 state = reduce(state, { type: 'progress', progress: { operationId: 'operation', sequence: 1, status, error: { code: 'CATALOG_REVISION_CONFLICT' } } });
 assert.equal(state.phase, status === 'cancelled' ? 'cancelled' : 'failed'); assert.equal(state.result, null); assert.equal(state.error.code, 'CATALOG_REVISION_CONFLICT');
});
test('paging cannot validate a pending association and a fresh preview resets the global override', () => {
 let state = reduce(planned(), { type: 'global', choice: 'incoming' });
 state = reduce(state, { type: 'associate', id: 'remote-card', target: 'local-card' });
 state = reduce(state, { type: 'page', page: fixture.preview }); assert.equal(canApplyImport(state), false);
 state = reduce(state, { type: 'begin', mode: 'preview' }); assert.equal(state.globalChoice, 'local');
 state = reduce(state, { type: 'page', page: fixture.preview, prepared: true }); assert.equal(canApplyImport(state), true);
});
test('a lost tracking response keeps the operation busy and its outcome unknown', () => {
 const running = reduce(reduce(planned(), { type: 'begin', mode: 'apply' }), { type: 'receipt', receipt: fixture.receipt });
 const state = reduce(running, { type: 'trackingError', error: new Error('transport') });
 assert.equal(state.phase, 'applying'); assert.equal(state.result, null); assert.equal(reduce(state, { type: 'close' }), state);
});

test('conflict presentation translates field, state and scalar values without technical IDs', async () => {
 const { importKindLabel, importValueLines } = await import('../src/store/catalogue/importConflictPresentation.js');
 const translate = (key, params = {}) => ({ 'catalogue:fiche.edit.field.title': 'TITLE', 'catalogue:fiche.edit.mode.cleared': 'CLEARED', 'catalogue:fiche.edit.mode.source': 'SOURCE', 'catalogue:backupImport.yes': 'YES', 'catalogue:backupImport.no': 'NO' }[key] ?? JSON.stringify({ key, ...params }));
 assert.equal(importKindLabel(translate, 'corrections', 'title:fr'), 'TITLE');
 for (const [state, expected] of [['cleared', 'CLEARED'], ['source', 'SOURCE']]) {
  const lines = importValueLines(translate, 'corrections', { field: 'title', language: 'fr', state, value: null });
  assert.match(lines.join(' '), new RegExp(expected)); assert.doesNotMatch(lines.join(' '), /title:fr|import-/);
 }
 assert.deepEqual(importValueLines(translate, 'favorite', 1), ['YES']);
 assert.deepEqual(importValueLines(translate, 'favorite', 0), ['NO']);
});

test('failed initial page retrieval releases completed preview for closing or retrying', () => {
 let state = reduce({ ...INITIAL_IMPORT, path: '/backup.zip' }, { type: 'begin', mode: 'preview' });
 state = reduce(state, { type: 'receipt', receipt: fixture.receipt });
 state = reduce(state, { type: 'failed', error: { code: 'CATALOG_IMPORT_PREVIEW_EXPIRED' } });
 assert.equal(state.phase, 'failed');
 assert.equal(state.result, null);
 assert.equal(reduce(state, { type: 'close' }), INITIAL_IMPORT);
 assert.equal(reduce(state, { type: 'begin', mode: 'preview' }).phase, 'preparing');
});

test('global changes preserve explicit choices on all pages with unchanged fingerprints', () => {
 let state = planned(); const conflict = state.preview.conflicts.items[0];
 state = reduce(state, { type: 'choice', id: conflict.id, choice: 'incoming' });
 const explicit = state.choices;
 state = reduce(state, { type: 'global', choice: 'incoming' });
 state = reduce(state, { type: 'global', choice: 'local' });
 assert.deepEqual(state.choices, explicit);
 assert.equal(conflictChoice(state, conflict), 'incoming');
 assert.equal(conflictChoice(state, { ...conflict, incoming: 99 }), 'local');
});
test('unavailable replacement needs an individual choice even under global incoming', () => {
 let state = planned();
 const conflict = { ...state.preview.conflicts.items[0], target: { kind: 'referenceBundle', requiresIndividualChoice: true } };
 state = { ...state, preview: { ...state.preview, conflicts: { total: 1, items: [conflict] } } };
 state = reduce(state, { type: 'global', choice: 'incoming' });
 assert.equal(conflictChoice(state, conflict), 'local');
 assert.equal(choicePayload(state, [conflict])[conflict.id], 'local');
 state = reduce(state, { type: 'choice', id: conflict.id, choice: 'incoming' });
 assert.equal(conflictChoice(state, conflict), 'incoming');
 assert.equal(conflictChoice(state, { ...conflict, incoming: 99 }), 'local');
});

test('preview carries a complete forgetting count independently of pagination', () => {
  assert.equal(importPage({ ...fixture.preview, forgottenCount: 600 }).forgottenCount, 600);
  assert.throws(() => importPage({ ...fixture.preview, forgottenCount: -1 }));
});
