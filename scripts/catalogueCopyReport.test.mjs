import { runner } from './reactHookDriver.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogueFilesApi } from '../src/store/catalogue/catalogueFilesApi.js';

test('duplicate diagnostics load once after a flat terminal operation page', async () => {
  const { useCatalogueDuplicates } = await import('../src/hooks/useCatalogueDuplicates.js');
  const { catalogueApi, createCatalogueApi } = await import('../src/store/catalogue/catalogueApi.js');
  const api = catalogueApi(); const originalOperation = api.getOperation; const originalFiles = { ...catalogueFilesApi };
  const result = { exactGroups: [{ digest: 'sha', exemplarIds: ['e1', 'e2'] }], olderVersions: [], issues: [], cursor: null };
  let loaded = 0;
  api.getOperation = createCatalogueApi({ invoke: async () => ({ status: 'success', error: null, items: [], cursor: null }), listen: async () => () => {} }).getOperation;
  catalogueFilesApi.findDuplicates = async () => ({ operationId: 'duplicates', state: 'queued' });
  catalogueFilesApi.duplicateResults = async () => { loaded++; return result; };
  catalogueFilesApi.releaseDuplicateResults = async () => {};
  const hooks = runner(() => useCatalogueDuplicates());
  try {
    let flow = hooks.render(); hooks.flush(); await flow.start(); hooks.render(); hooks.flush();
    await new Promise(resolve => setImmediate(resolve)); flow = hooks.render();
    assert.equal(flow.state.phase, 'success'); assert.equal(loaded, 1); assert.deepEqual(flow.state.results, result);
  } finally { hooks.unmount(); api.getOperation = originalOperation; Object.assign(catalogueFilesApi, originalFiles); }
});
