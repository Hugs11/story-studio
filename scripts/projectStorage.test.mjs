import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sanitizeProjectFolder, createProjectStorage, normalizeProjectStorage, ensureProjectStorage, resolveProjectFolderName } from '../src/store/projectStorage.js';
import { normalizeBaseProject, projectToRustExport } from '../src/store/projectModel/schema.js';
import { decodeProjectFile, encodeProjectFile, readProjectFilePreview } from '../src/store/projectModel/codec.js';
import { createAdvancedProject } from '../src/store/projectModel/authoring.js';
import { graphCopyProject } from '../src/store/graphCopy.js';

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/projectFolders.json', import.meta.url)));
test('folder validation shared with Rust, preserves whole Unicode characters', () => {
  for (const [input, expected] of fixtures) {
    assert.equal(sanitizeProjectFolder(input), expected, input);
    assert.equal(sanitizeProjectFolder(expected), expected, `idempotence: ${input}`);
    assert.ok(Array.from(expected).length <= 60, input);
  }
});
test('resolution inspects all five categories and never adopts a foreign or unmarked folder', () => {
  const storage = createProjectStorage();
  assert.equal(resolveProjectFolderName('Azuro', storage.workId, [{ 'azuro': null }, {}, {}, {}, {}]), 'Azuro (2)');
  assert.equal(resolveProjectFolderName('Azuro', storage.workId, [{ Azuro: storage.workId }, {}, {}, {}, {}]), 'Azuro');
  assert.equal(resolveProjectFolderName('Azuro', storage.workId, [{ azuro: storage.workId }, {}, {}, {}, {}]), 'azuro');
  assert.throws(() => resolveProjectFolderName('Azuro', storage.workId, [{ Azuro: storage.workId, azuro: storage.workId }, {}, {}, {}, {}]), /même nom normalisé/);
  assert.equal(resolveProjectFolderName('Été', storage.workId, [{}, {}, {}, {}, { 'ÉTÉ': 'foreign' }]), 'Été (2)');
});
const collisions = JSON.parse(readFileSync(new URL('./fixtures/projectFolderCollisions.json', import.meta.url)));
test('collision folding shared with Rust: per character, final sigma folded (fixtures)', () => {
  const { workId } = createProjectStorage();
  for (const [folder, existing, expected] of collisions) {
    for (const category of [0, 4]) {
      const categories = [{}, {}, {}, {}, {}];
      categories[category] = { [existing]: null };
      assert.equal(resolveProjectFolderName(folder, workId, categories), expected, `${folder} / ${existing}`);
    }
  }
});
test('resolution prefers the suffixed folder already owned over a freed first rank (Rust parity)', () => {
  const { workId } = createProjectStorage();
  const owned = { 'Azuro (2)': workId };
  assert.equal(resolveProjectFolderName('Azuro', workId, [owned, owned, {}, {}, {}]), 'Azuro (2)');
  assert.equal(resolveProjectFolderName('Azuro', workId, [{ 'azuro (3)': workId }, {}, {}, {}, {}]), 'azuro (3)');
  // An owned rank shared with a foreign folder is not valid: first free rank.
  assert.equal(resolveProjectFolderName('Azuro', workId, [owned, { 'Azuro (2)': 'foreign' }, {}, {}, {}]), 'Azuro');
  assert.equal(resolveProjectFolderName('Azuro', workId, [{ Azuro: workId, 'Azuro (2)': workId }, {}, {}, {}, {}]), 'Azuro');
  assert.equal(resolveProjectFolderName('Azuro', workId, [{ Azuro: null, azuro: null }, {}, {}, {}, {}]), 'Azuro (2)');
});
test('storage is stable, serialized in both codecs, and excluded from generation', async () => {
  const storage = createProjectStorage();
  const free = normalizeBaseProject({ projectType: 'pack', storage });
  assert.deepEqual(free.storage, storage);
  assert.equal(projectToRustExport(free).storage, undefined);
  for (const project of [free, createAdvancedProject({ payload: '{}', storage })]) {
    const { project: decoded } = await decodeProjectFile(encodeProjectFile(project), { validateAdvancedPayload: async () => ({}) });
    assert.deepEqual(decoded.storage, storage);
  }
  assert.deepEqual(graphCopyProject(free, { payload: '{}', mediaBindings: [] }).storage, storage);
});
test('old project gains a permanent identity in memory on opening; preview remains read only', async () => {
  const text = JSON.stringify({ projectType: 'pack', projectName: 'Azuro', rootEntries: [] });
  assert.equal(readProjectFilePreview(text).storage, undefined);
  const { project } = await decodeProjectFile(text, { savePath: '/tmp/Azuro.mbah' });
  assert.equal(project.storage.folder, 'Azuro');
  assert.equal(project.storage.provisional, false);
  assert.equal(ensureProjectStorage(project), project);
  const legacy = await decodeProjectFile(JSON.stringify({ projectType: 'pack', rootEntries: [] }), { savePath: '/tmp/Ancien.mbah' });
  assert.equal(legacy.project.storage.folder, 'Ancien');
  assert.notEqual(createProjectStorage().workId, createProjectStorage().workId);
});


test('reserved stems with extensions stay stable through storage normalization and both codecs', async () => {
  for (const folder of ['CON.txt', 'NUL.mp3', 'COM1.foo', 'LPT9.bar', `CON.${'😀'.repeat(60)}`]) {
    const storage = createProjectStorage({ folder });
    assert.deepEqual(normalizeProjectStorage(storage), storage);
    for (const original of [normalizeBaseProject({ projectType: 'pack', storage }), createAdvancedProject({ payload: '{}', storage })]) {
      let project = original;
      for (let iteration = 0; iteration < 3; iteration++) {
        ({ project } = await decodeProjectFile(encodeProjectFile(project), { validateAdvancedPayload: async () => ({}) }));
        assert.deepEqual(project.storage, storage);
      }
    }
  }
});

test('an unreadable storage descriptor is repaired on decoding: only unreadable fields are regenerated', async () => {
  const valid = createProjectStorage({ folder: 'Ancien' });
  const projects = [
    normalizeBaseProject({ projectType: 'pack', projectName: 'Azuro', storage: valid }),
    { ...createAdvancedProject({ payload: '{}', storage: valid }), projectName: 'Azuro' },
  ];
  const options = { validateAdvancedPayload: async () => ({}) };
  const cases = [
    // Future version, readable identity: nothing is lost.
    [{ ...valid, version: 2, workId: valid.workId.toUpperCase() }, { workId: valid.workId, folder: 'Ancien', provisional: true }],
    [{ version: 2, workId: valid.workId, folder: 'A/b', provisional: 'oui' }, { workId: valid.workId, folder: 'A_b', saved: false, unsaved: true }],
    // Unreadable identity: a new one, readable fields kept.
    [{ ...valid, workId: 'pas-un-uuid' }, { folder: 'Ancien', provisional: true }],
    ['texte', { folder: 'Azuro', saved: false, unsaved: true }],
  ];
  for (const project of projects) {
    for (const [storage, expected] of cases) {
      const text = JSON.stringify({ ...JSON.parse(encodeProjectFile(project)), storage });
      const { project: opened } = await decodeProjectFile(text, { ...options, savePath: '/tmp/Azuro.mbah' });
      const { project: unsaved } = await decodeProjectFile(text, options);
      assert.equal(opened.authoringMode, project.authoringMode);
      for (const result of [opened, unsaved]) assert.deepEqual(normalizeProjectStorage(result.storage), result.storage);
      if (expected.workId) assert.equal(opened.storage.workId, expected.workId);
      else assert.notEqual(opened.storage.workId, valid.workId);
      assert.equal(opened.storage.folder, expected.folder);
      assert.equal(opened.storage.provisional, expected.provisional ?? expected.saved);
      assert.equal(unsaved.storage.provisional, expected.provisional ?? expected.unsaved);
    }
  }
  // Internal constructions stay strict.
  assert.throws(() => createAdvancedProject({ payload: '{}', storage: { ...valid, version: 2 } }), /rangement/);
});
