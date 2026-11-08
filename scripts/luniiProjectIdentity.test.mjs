import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { migrateProjectData, normalizeProjectData, readSavedPackUuid } from '../src/store/projectModel/schema.js';
import { createLuniiDeviceApi } from '../src/store/catalogue/luniiDeviceApi.js';
import { catalogueFilesApi } from '../src/store/catalogue/catalogueFilesApi.js';
import { installProjectAccess, releaseActiveProjectAccess, setActiveProjectModified } from '../src/store/projectSessionAccess.js';

test('send synchronizes the current editor state before launching, including a queued send', async () => {
  const original = catalogueFilesApi.projectAccess;
  const calls = [];
  catalogueFilesApi.projectAccess = async (action, path, token) => {
    calls.push({ action, token });
    return { updated: true };
  };
  const api = createLuniiDeviceApi({ invoke: async command => { calls.push({ command }); return { operationId: 'send' }; } });
  try {
    await installProjectAccess('editor');
    setActiveProjectModified(false);
    await api.send({ deviceId: 'lunii', selection: [], requestId: 'first' });
    setActiveProjectModified(true);
    await api.send({ deviceId: 'lunii', selection: [], requestId: 'second' });
    assert.deepEqual(calls, [
      { action: 'saved', token: 'editor' }, { command: 'lunii_device_send' },
      { action: 'modified', token: 'editor' }, { command: 'lunii_device_send' },
    ]);
  } finally {
    await releaseActiveProjectAccess();
    catalogueFilesApi.projectAccess = original;
  }
});

test('failed editor synchronization cannot launch a send', async () => {
  const original = catalogueFilesApi.projectAccess;
  let invoked = false;
  const refused = { code: 'CATALOG_PROJECT_IN_USE', params: {} };
  try {
    catalogueFilesApi.projectAccess = async () => ({ updated: true });
    await installProjectAccess('editor');
    catalogueFilesApi.projectAccess = async action => {
      if (action !== 'release') throw refused;
    };
    const api = createLuniiDeviceApi({ invoke: async () => { invoked = true; } });
    await assert.rejects(api.send({ deviceId: 'lunii', selection: [], requestId: 'attempt' }), e => e === refused);
    assert.equal(invoked, false);
  } finally {
    await releaseActiveProjectAccess();
    catalogueFilesApi.projectAccess = original;
  }
});

test('install publishes a clean editor state even after a send was queued', async () => {
  const original = catalogueFilesApi.projectAccess;
  const calls = [];
  catalogueFilesApi.projectAccess = async (action, path, token) => { calls.push({ action, token }); };
  try {
    setActiveProjectModified(false);
    await installProjectAccess('new-editor');
    assert.deepEqual(calls, [{ action: 'saved', token: 'new-editor' }]);
  } finally {
    await releaseActiveProjectAccess();
    setActiveProjectModified(true);
    catalogueFilesApi.projectAccess = original;
  }
});

test('install keeps the native modified default without publishing an update', async () => {
  const original = catalogueFilesApi.projectAccess;
  const calls = [];
  catalogueFilesApi.projectAccess = async (action, path, token) => { calls.push({ action, token }); };
  try {
    setActiveProjectModified(true);
    await installProjectAccess('modified-editor');
    assert.deepEqual(calls, []);
  } finally {
    await releaseActiveProjectAccess();
    catalogueFilesApi.projectAccess = original;
  }
});

const identityCases = JSON.parse(readFileSync(new URL('../src-tauri/src/services/storyteller/send/project-identity-cases.json', import.meta.url))).cases;
for (const { name, raw, uuid } of identityCases) {
  test(`Rust/JS identity fixture: ${name}`, () => {
    assert.equal(readSavedPackUuid(raw), uuid ?? '');
    const migrated = migrateProjectData(raw);
    if (uuid) {
      assert.equal(migrated.packMetadata.uuid, uuid);
      assert.equal(normalizeProjectData(raw).packMetadata.uuid, uuid);
    }
    else assert.match(migrated.packMetadata.uuid, /^[0-9a-f-]{36}$/i);
  });
}

test('historical metadata survives the required editor migration', () => {
  const convention = migrateProjectData(identityCases[0].raw).packMetadata;
  assert.equal(convention.title, 'Example stories');
  assert.equal(convention.author, 'example author');
  assert.equal(convention.namingMode, 'convention');
  const legacy = migrateProjectData(identityCases[1].raw).packMetadata;
  assert.equal(legacy.title, 'Mon pack perso');
  assert.equal(legacy.namingMode, 'legacy');
});
