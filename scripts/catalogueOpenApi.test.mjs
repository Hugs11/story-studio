import test from 'node:test';
import assert from 'node:assert/strict';
import fixture from './fixtures/catalogue/consultation.json' with { type: 'json' };
import { createCatalogueOpenApi, CONSULTATION_EXPIRED } from '../src/store/catalogue/catalogueOpenApi.js';
import { presentCatalogueError } from '../src/store/catalogue/catalogueApi.js';

test('consultation fixture: opaque target in, handle and closing out', async () => {
  const calls = [];
  const replies = { catalogue_open_consultation: fixture.handle, catalogue_read_consultation_asset: new Uint8Array([1, 2, 3]).buffer, catalogue_close_consultation: fixture.closed };
  const api = createCatalogueOpenApi({ invoke: async (command, args) => { calls.push({ command, args }); return replies[command]; } });
  const handle = await api.openConsultation({ consultationId: 'token', exemplarId: 'exemplar-zip', expectedRevision: 12 });
  assert.deepEqual(handle, fixture.handle);
  assert.deepEqual([...await api.readConsultationAsset({ consultationId: 'token', mediaId: 'm3f9a12bc04de-1' })], [1, 2, 3]);
  assert.deepEqual(await api.closeConsultation('token'), { ...fixture.closed, cleanup: null });
  assert.deepEqual(calls.map(call => call.command), ['catalogue_open_consultation', 'catalogue_read_consultation_asset', 'catalogue_close_consultation']);
  // No command receives a path: the target is the published exemplar and revision.
  assert.deepEqual(calls[0].args, { consultationId: 'token', exemplarId: 'exemplar-zip', expectedRevision: 12, projectJson: null });
  assert.deepEqual(calls[1].args, { consultationId: 'token', mediaId: 'm3f9a12bc04de-1' });
  assert.deepEqual(calls[2].args, { consultationId: 'token' });
});

test('partial replies keep guaranteed fields', async () => {
  const api = createCatalogueOpenApi({ invoke: async (command) => (command === 'catalogue_close_consultation' ? { closed: true, cleanupFailed: true, cleanup: { code: 'CATALOG_CLEANUP_FAILED', params: { path: '/cache' } } } : { kind: 'other', mediaTypes: { a: 1, b: 'image/png' } }) });
  const handle = await api.openConsultation({ consultationId: 't', exemplarId: 'e', expectedRevision: 0 });
  assert.equal(handle.kind, 'pack');
  assert.deepEqual(handle.mediaTypes, { b: 'image/png' });
  assert.equal(handle.mediaCount, 0);
  const closed = await api.closeConsultation('t');
  assert.equal(closed.cleanupFailed, true);
  assert.equal(closed.cleanup.code, 'CATALOG_CLEANUP_FAILED');
});

for (const [code, params] of [[CONSULTATION_EXPIRED, {}], ['CATALOG_SIMULATION_UNSUPPORTED', { path: '/Packs/broken.7z' }], ['CATALOG_TARGET_REVISION_CHANGED', { path: '/Packs/a.zip' }], ['CATALOG_FILE_DISAPPEARED', { path: '/Packs/a.zip' }], ['CATALOG_CLEANUP_FAILED', { path: '/cache' }]]) {
  test(`${code} is presentable in FR`, async () => {
    const api = createCatalogueOpenApi({ invoke: async () => { throw { code, params }; } });
    await assert.rejects(api.openConsultation({ consultationId: 't', exemplarId: 'e', expectedRevision: 0 }), (error) => {
      assert.equal(error.code, code);
      const message = presentCatalogueError(error).message;
      assert.doesNotMatch(message, /\[object Object\]|rust:|undefined/);
      if (params.path) assert.match(message, new RegExp(params.path.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')));
      return true;
    });
  });
}
