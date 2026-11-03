import test from 'node:test';
import assert from 'node:assert/strict';
import fixture from './fixtures/catalogue/backup-export.json' with { type: 'json' };
import { createCatalogueBackupApi } from '../src/store/catalogue/catalogueBackupApi.js';
import { INITIAL_EXPORT, backupExportReducer as reduce, canExport, exportPlan, exportReceipt, exportResult } from '../src/store/catalogue/backupExportState.js';

test('independent plan, receipt and result fixtures keep all public fields', async () => {
  const calls = [];
  const api = createCatalogueBackupApi({ invoke: async (command, args) => {
    calls.push([command, args]);
    return command === 'catalogue_plan_export' ? fixture.plan : command === 'catalogue_start_export' ? fixture.receipt
      : command === 'catalogue_get_operation' ? { ...fixture.receipt, sequence: 3, status: 'success', result: fixture.result } : {};
  } });
  assert.deepEqual(await api.plan('/exports/catalogue.zip', 7), fixture.plan);
  const decisions = { summaryValidated: true, replaceExisting: false };
  assert.deepEqual(await api.start('plan', decisions, 'request'), fixture.receipt);
  assert.deepEqual((await api.operation('operation')).result, fixture.result);
  await api.cancel('operation');
  assert.deepEqual(calls, [
    ['catalogue_plan_export', { destinationPath: '/exports/catalogue.zip', expectedCatalogueRevision: 7 }],
    ['catalogue_start_export', { planId: 'plan', decisions, requestId: 'request' }],
    ['catalogue_get_operation', { operationId: 'operation', limit: 100 }],
    ['catalogue_cancel_operation', { operationId: 'operation' }],
  ]);
});
for (const code of ['CATALOG_BACKUP_EXPORT_FAILED', 'CATALOG_BACKUP_EXPORT_SOURCE_CHANGED', 'CATALOG_BACKUP_IMAGE_MISSING', 'CATALOG_BACKUP_DESTINATION_CONFLICT']) {
  test(`adapter preserves coded error ${code}`, async () => {
    const api = createCatalogueBackupApi({ invoke: async () => { throw { code, params: { sha256: 'a'.repeat(64) } }; } });
    await assert.rejects(api.plan('/path', 1), e => e.code === code && e.userMessage.params.sha256.length === 64);
  });
}
test('malformed and unsupported DTOs are refused before presentation', () => {
  for (const change of [{ counts: {} }, { estimatedBytes: -1 }, { catalogueRevision: 1.5 }, { conflicts: ['unknown'] }, { issues: ['missingImage'] }]) assert.throws(() => exportPlan({ ...fixture.plan, ...change }));
  assert.throws(() => exportReceipt({ ...fixture.receipt, operationId: null }));
  for (const change of [{ formatVersion: 2 }, { digest: 'not a digest' }, { byteSize: NaN }, { counts: null }]) assert.throws(() => exportResult({ ...fixture.result, ...change }));
});
function planned(conflicts = []) {
  return reduce(reduce(reduce(INITIAL_EXPORT, { type: 'open' }), { type: 'planning' }), { type: 'planned', plan: { ...fixture.plan, conflicts } });
}
test('summary and replacement must both be explicit; path changes invalidate plan', () => {
  let state = planned(['destinationExists']);
  assert.equal(canExport(state), false);
  state = reduce(state, { type: 'summary', value: true }); assert.equal(canExport(state), false);
  state = reduce(state, { type: 'replace', value: true }); assert.equal(canExport(state), true);
  const moved = reduce(state, { type: 'path', path: '/other.zip' });
  assert.equal(moved.plan, null); assert.equal(moved.summaryValidated, false); assert.equal(moved.replaceExisting, false);
  state = reduce(state, { type: 'starting' }); assert.equal(state.phase, 'starting');
  assert.equal(reduce(state, { type: 'close' }), state);
  assert.equal(reduce(state, { type: 'path', path: '/other.zip' }), state);
});
test('operation snapshots reject stale sequences and foreign operations', () => {
  let state = reduce(planned(), { type: 'started', receipt: fixture.receipt });
  state = reduce(state, { type: 'progress', progress: { operationId: 'operation', sequence: 3, status: 'running' } });
  assert.equal(reduce(state, { type: 'progress', progress: { operationId: 'other', sequence: 100, status: 'success' } }), state);
  assert.equal(reduce(state, { type: 'progress', progress: { operationId: 'operation', sequence: 2, status: 'failed' } }), state);
  state = reduce(state, { type: 'cancel' }); assert.equal(state.phase, 'cancelling');
  state = reduce(state, { type: 'cancelError', error: 'network' }); assert.equal(state.phase, 'running');
  state = reduce(state, { type: 'progress', progress: { operationId: 'operation', sequence: 4, status: 'success', result: fixture.result } });
  assert.equal(state.phase, 'success'); assert.deepEqual(state.result, fixture.result);
  assert.equal(reduce(state, { type: 'close' }), INITIAL_EXPORT);
});
for (const status of ['cancelled', 'failed', 'partial']) {
  test(`terminal ${status} retains error and never claims success`, () => {
    const state = reduce(reduce(planned(), { type: 'started', receipt: fixture.receipt }), { type: 'progress', progress: { operationId: 'operation', sequence: 1, status, error: { code: 'CATALOG_BACKUP_EXPORT_FAILED' } } });
    assert.equal(state.phase, status === 'cancelled' ? 'cancelled' : 'failed');
    assert.equal(state.result, null); assert.equal(state.error.code, 'CATALOG_BACKUP_EXPORT_FAILED');
  });
}
test('manual data contract preserves source/defined/cleared and language independently', () => {
  assert.deepEqual(fixture.catalogue.corrections.map(c => [c.language, c.state, c.value]), [['en', 'source', null], ['it', 'cleared', null], ['fr', 'defined', 'Titre']]);
  for (const key of ['generationReceipts', 'cache', 'operations', 'backups', 'sessions']) assert.equal(key in fixture.catalogue, false);
});

test('missing official covers warn in the result and allow reference-only backup', () => {
  const plan = exportPlan({ ...fixture.plan, issues: ['luniiImageMissing'] });
  const state = { ...INITIAL_EXPORT, phase: 'planned', plan, summaryValidated: true };
  assert.equal(canExport(state), true);
  assert.equal(exportResult({ ...fixture.result, missingLuniiImages: 1 }).missingLuniiImages, 1);
  assert.throws(() => exportResult({ ...fixture.result, missingLuniiImages: -1 }));
});
