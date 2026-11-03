import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProjectData, projectToRustExport, projectToSerializable, encodeProjectFile, decodeProjectFile } from '../src/store/projectModel.js';
import { createAdvancedProject } from '../src/store/projectModel/authoring.js';
import { buildProjectAfterZipUnpack } from '../src/store/unpackProject.js';
import { graphCopyProject } from '../src/store/graphCopy.js';
import { advancedFieldGovernance, advancedMetadataMembers, advancedPackMetadataDraft } from '../src/store/packMetadataModel.js';
import { askImportedUuidRevision } from '../src/hooks/importedUuidRevision.js';
import { readPackIdentityLock } from '../src/store/officialProvenance.js';

const uuid = '00000000-0000-4000-8000-00000000000a';
function free() { return normalizeProjectData({ projectType: 'pack', packMetadata: { uuid }, rootEntries: [] }); }

test('Libre import records official provenance and preserves it through mbah and Rust DTO', async () => {
  const { project } = buildProjectAfterZipUnpack({ project: free(), menuId: null, itemId: 'source', entries: [], result: { title: 'Synthetic', uuid, officialProvenance: 'official' } });
  assert.equal(project.officialProvenance, 'official');
  const reopened = (await decodeProjectFile(encodeProjectFile(project))).project;
  assert.equal(reopened.officialProvenance, 'official');
  assert.equal(projectToSerializable(reopened).officialProvenance, 'official');
  assert.equal(projectToRustExport(reopened).officialProvenance, 'official');
  assert.equal(reopened.packMetadata.uuid, uuid);
});

test('historical Libre project defaults to unknown without consulting originalUuid', async () => {
  const project = free();
  delete project.officialProvenance;
  project.packMetadata.originalUuid = uuid;
  assert.equal(projectToSerializable(project).officialProvenance, 'unknown');
  const reopened = (await decodeProjectFile(JSON.stringify(project))).project;
  assert.equal(reopened.officialProvenance, 'unknown');
  assert.equal(projectToRustExport(reopened).packUuid, uuid);
});

test('graphCopyProject preserves provenance in the advanced envelope and mbah', async () => {
  const original = { ...free(), officialProvenance: 'official' };
  const copied = graphCopyProject(original, { payload: 'opaque payload', mediaBindings: [] });
  assert.equal(copied.officialProvenance, 'official');
  const reopened = await decodeProjectFile(encodeProjectFile(copied), { validateAdvancedPayload: async () => ({ officialProvenance: 'official' }) });
  assert.equal(reopened.project.officialProvenance, 'official');
  assert.equal(reopened.project.authoring.payload, 'opaque payload');
});

test('old advanced payload without provenance reads unknown', async () => {
  const old = createAdvancedProject({ payload: 'historical opaque payload' });
  delete old.officialProvenance;
  const reopened = await decodeProjectFile(JSON.stringify(old), { validateAdvancedPayload: async () => ({}) });
  assert.equal(reopened.project.officialProvenance, 'unknown');
});

test('UI governance reflects the Rust lock and never requests an identity mutation', () => {
  for (const origin of ['created', 'imported-studio', 'imported-fs']) {
    assert.equal(advancedFieldGovernance(origin, true).uuid.editable, false);
    assert.equal(advancedFieldGovernance(origin, true).uuid.reason, null);
    assert.equal(advancedFieldGovernance(origin, false).uuid.editable, true);
  }
  const view = { documentOrigin: 'imported-studio', identityLocked: true, packIdentity: { value: uuid }, metadata: {} };
  const draft = advancedPackMetadataDraft(view);
  assert.equal(draft.identityLocked, true);
  assert.equal(advancedMetadataMembers(view, { ...draft, uuid: 'new identity' }), null);
});

test('official automatic renewal is neutralized by the engine result', async () => {
  const draft = { uuid, originalUuid: uuid };
  const noDialog = () => assert.fail('official UUID must not prompt');
  assert.equal(await askImportedUuidRevision(draft, noDialog, async () => true), draft);
  assert.equal(await askImportedUuidRevision({ ...draft, identityLocked: true }, noDialog).then((value) => value.uuid), uuid);
  const nonOfficial = await askImportedUuidRevision(draft, async () => 'renew', async () => false);
  assert.notEqual(nonOfficial.uuid, uuid);
});

test('Libre field lock asks Rust with current identity and explicit provenance', async () => {
  let args;
  const locked = await readPackIdentityLock(uuid, 'official', async (command, value) => { args = { command, value }; return true; });
  assert.equal(locked, true);
  assert.deepEqual(args, { command: 'read_pack_identity_lock', value: { uuid, officialProvenance: 'official' } });
});

test('aggregation keeps each imported child provenance through serialization', async () => {
  const { buildAggregateProject } = await import('../src/components/AggregatePacks/aggregateProject.js');
  const project = buildAggregateProject({ packs: [{ name: 'Synthetic', path: '/synthetic.zip', packUuid: uuid, officialProvenance: 'official', officialOriginUuid: uuid }], rootAudio: null, rootImage: null, metadata: { title: 'Assembly', uuid } });
  const reopened = (await decodeProjectFile(encodeProjectFile(project))).project;
  assert.equal(reopened.containsOfficialContent, true);
  assert.equal(reopened.officialProvenance, 'unknown');
  assert.equal(reopened.rootEntries[0].packUuid, uuid);
  assert.equal(reopened.rootEntries[0].officialOriginUuid, uuid);
  assert.equal(projectToRustExport(reopened).rootEntries[0].officialOriginUuid, uuid);
  assert.equal(reopened.rootEntries[0].officialProvenance, 'official');
  assert.equal(projectToRustExport(reopened).rootEntries[0].officialProvenance, 'official');
});

test('unpacking an official child preserves author origin, records containment and survives mbah and graph copy', async () => {
  const parent = { ...free(), officialProvenance: 'notOfficial', packMetadata: { uuid: 'author', title: 'Author' }, rootEntries: [{ id: 'zip', type: 'zip' }] };
  const { project, promoted } = buildProjectAfterZipUnpack({ project: parent, itemId: 'zip', menuId: null, entries: [{ id: 'child', type: 'story', name: 'Child' }], result: { uuid, officialProvenance: 'official', officialOriginUuid: uuid } });
  assert.equal(promoted, false);
  assert.equal(project.officialProvenance, 'notOfficial');
  assert.equal(project.packMetadata.uuid, 'author');
  assert.equal(project.officialOriginUuid, undefined);
  assert.equal(project.containsOfficialContent, true);
  const reopened = (await decodeProjectFile(encodeProjectFile(project))).project;
  assert.equal(reopened.containsOfficialContent, true);
  assert.equal(projectToRustExport(reopened).containsOfficialContent, true);
  const copied = graphCopyProject(reopened, { payload: 'opaque', mediaBindings: [] });
  const advanced = (await decodeProjectFile(encodeProjectFile(copied), { validateAdvancedPayload: async () => ({ officialProvenance: 'notOfficial', containsOfficialContent: true }) })).project;
  assert.equal(advanced.officialProvenance, 'notOfficial');
  assert.equal(advanced.containsOfficialContent, true);
});

test('official source identity survives Libre and graph envelopes independently of current UUID', async () => {
  const { project } = buildProjectAfterZipUnpack({ project: free(), menuId: null, entries: [], result: { uuid, officialProvenance: 'official', officialOriginUuid: uuid } });
  project.packMetadata.uuid = 'edited-current';
  const reopened = (await decodeProjectFile(encodeProjectFile(project))).project;
  assert.equal(reopened.officialOriginUuid, uuid);
  assert.equal(projectToRustExport(reopened).officialOriginUuid, uuid);
  const copied = graphCopyProject(reopened, { payload: 'opaque', mediaBindings: [] });
  assert.equal(copied.officialOriginUuid, uuid);
  const advanced = (await decodeProjectFile(encodeProjectFile(copied), { validateAdvancedPayload: async () => ({ officialProvenance: 'official', officialOriginUuid: uuid }) })).project;
  assert.equal(advanced.officialOriginUuid, uuid);
});

test('document origin alone does not become nested official content on a non-official unpack', () => {
  const parent = { ...free(), officialProvenance: 'official', officialOriginUuid: uuid, packMetadata: { uuid, title: 'Official' }, rootEntries: [{ id: 'zip', type: 'zip' }] };
  const { project } = buildProjectAfterZipUnpack({ project: parent, itemId: 'zip', menuId: null, entries: [], result: { officialProvenance: 'notOfficial' } });
  assert.equal(project.officialProvenance, 'official');
  assert.equal(project.officialOriginUuid, uuid);
  assert.equal(project.containsOfficialContent, false);
});

for (const unpack of [false, true]) test(`official ${unpack ? 'unpacked subtree' : 'ZIP'} containment clears after removal and mbah reopening`, async () => {
  const parent = { ...free(), packMetadata: { uuid: 'author', title: 'Author' }, rootEntries: [{ id: 'zip', type: 'zip', officialProvenance: 'official', officialOriginUuid: uuid, zipPath: '/official.zip' }] };
  const imported = unpack ? buildProjectAfterZipUnpack({ project: parent, menuId: null, itemId: 'zip', entries: [
    { id: 'menu', type: 'menu', children: [{ id: 'story', type: 'story' }] },
    { id: 'second', type: 'story' },
  ], result: { officialProvenance: 'official', officialOriginUuid: uuid } }).project : parent;
  const reopened = (await decodeProjectFile(encodeProjectFile(imported))).project;
  assert.equal(reopened.containsOfficialContent, true);
  for (const entry of reopened.rootEntries) {
    assert.equal(entry.officialProvenance, 'official');
    assert.equal(entry.officialOriginUuid, uuid);
  }
  if (unpack) {
    const partial = normalizeProjectData({ ...reopened, rootEntries: reopened.rootEntries.slice(1) });
    assert.equal(partial.containsOfficialContent, true, 'each imported root carries provenance');
  }
  const removed = normalizeProjectData({ ...reopened, rootEntries: [] });
  assert.equal(removed.containsOfficialContent, false);
  const savedAgain = (await decodeProjectFile(encodeProjectFile(removed))).project;
  assert.equal(savedAgain.containsOfficialContent, false);
  assert.equal(projectToRustExport(savedAgain).containsOfficialContent, false);
  assert.equal(graphCopyProject(savedAgain, { payload: 'opaque' }).containsOfficialContent, undefined);
});
