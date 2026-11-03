import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogueFilesApi } from '../src/store/catalogue/catalogueFilesApi.js';
import { installProjectAccess, releaseActiveProjectAccess } from '../src/store/projectSessionAccess.js';

test('a saved-project lease arriving after a session replacement leaves the active editor protected', async () => {
  const original = catalogueFilesApi.projectAccess; const events = []; let current = true;
  catalogueFilesApi.projectAccess = async (action, path, token) => { events.push([action, token]); if (action === 'bind') current = false; };
  try {
    await installProjectAccess('current-editor');
    await installProjectAccess('late-save', { storage: { workId: 'saved-work' } }, () => current);
    assert.deepEqual(events, [['bind', 'late-save'], ['release', 'late-save']]);
    await releaseActiveProjectAccess();
    assert.deepEqual(events.at(-1), ['release', 'current-editor']);
  } finally { await releaseActiveProjectAccess(); catalogueFilesApi.projectAccess = original; }
});

test('a binding failure releases the acquired native editor lease', async () => {
  const original = catalogueFilesApi.projectAccess; const events = [];
  catalogueFilesApi.projectAccess = async (action, path, token) => { events.push([action, token]); if (action === 'bind') throw new Error('bind refused'); };
  try {
    await assert.rejects(installProjectAccess('acquired', { storage: { workId: 'work' } }), /bind refused/);
    assert.deepEqual(events, [['bind', 'acquired'], ['release', 'acquired']]);
  } finally { catalogueFilesApi.projectAccess = original; }
});

test('catalogue admission failure leaves editor opening and saving usable; other refusals still block', async () => {
  const { claimProjectAccess, withProjectSaveAccess } = await import('../src/store/projectSessionAccess.js');
  const original = catalogueFilesApi.projectAccess;
  const previousTauri = globalThis.isTauri;
  globalThis.isTauri = true;
  try {
    catalogueFilesApi.projectAccess = async () => { throw { code: 'CATALOG_STORE_UNAVAILABLE' }; };
    assert.equal(await claimProjectAccess('open', '/project.mbah'), null);
    assert.equal(await withProjectSaveAccess('/project.mbah', async () => 'saved'), 'saved');
    catalogueFilesApi.projectAccess = async () => { throw { code: 'CATALOG_FILE_RECOVERY_REQUIRED' }; };
    let saved = false;
    await assert.rejects(withProjectSaveAccess('/project.mbah', async () => { saved = true; }), { code: 'CATALOG_FILE_RECOVERY_REQUIRED' });
    assert.equal(saved, false);
  } finally {
    catalogueFilesApi.projectAccess = original;
    if (previousTauri === undefined) delete globalThis.isTauri; else globalThis.isTauri = previousTauri;
  }
});
