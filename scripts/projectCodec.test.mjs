import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeProjectFile, encodeProjectFile, readProjectEnvelope, ProjectFormatError,
  normalizeProjectData, migrateProjectData, projectToSerializable, projectPreviewThumbnail,
} from '../src/store/projectModel.js';
import { shouldPromptRegenerateImportedUuid } from '../src/store/projectHelpers.js';

const advanced = () => ({
  schemaVersion: 4, authoringMode: 'advanced', projectType: 'advanced', rootEntries: [],
  projectName: 'Projet', authoring: {
    payload: '{"payloadVersion":1,"opaque":9007199254740993}',
    editorState: { version: 1, viewport: { x: 120.5, y: -3.25, zoom: 0.75 }, selection: { stages: ['/stageNodes/@uuid=removed#0'] } },
    mediaBindings: [{ assetRef: 'opaque.mp3', path: './media/audio.mp3', status: 'missing' }],
  },
});

test('graph preview falls back to the resolved entry-stage image', () => {
  const project = advanced();
  project.authoring.payload = JSON.stringify({
    payloadVersion: 1,
    document: {
      stageNodes: [
        { uuid: 'other', squareOne: false, image: 'other.png' },
        { uuid: 'entry', squareOne: true, image: 'cover.png' },
      ],
    },
  });
  project.authoring.mediaBindings = [
    { assetRef: 'cover.png', path: './fichiers-importes/cover.png', status: 'resolved' },
  ];

  assert.equal(projectPreviewThumbnail(project), './fichiers-importes/cover.png');
  project.thumbnailImage = './vignette-explicite.png';
  assert.equal(projectPreviewThumbnail(project), './vignette-explicite.png');
});

test('envelope compatibility matrix accepts only explicit known combinations', () => {
  for (const version of [undefined, -1, 0, 1, 2, 3, 4]) {
    for (const mode of [undefined, 'free', 'advanced']) {
      for (const block of [false, true]) {
        const raw = {};
        if (version !== undefined) raw.schemaVersion = version;
        if (mode !== undefined) raw.authoringMode = mode;
        if (block) raw.authoring = advanced().authoring;
        if (mode === 'advanced') Object.assign(raw, { projectType: 'advanced', rootEntries: [] });
        const free = mode !== 'advanced' && !block && (version !== 4 || mode === 'free');
        const adv = version === 4 && mode === 'advanced' && block;
        if (free || adv) assert.equal(readProjectEnvelope(raw).authoringMode, adv ? 'advanced' : 'free');
        else assert.throws(() => readProjectEnvelope(raw), ProjectFormatError);
      }
    }
  }
});

test('bad types and future versions never reach the Libre normalizer', () => {
  const cases = [
    [null, 'INVALID_PROJECT_SHAPE'], [[], 'INVALID_PROJECT_SHAPE'],
    [{ schemaVersion: 99 }, 'UNSUPPORTED_SCHEMA_VERSION'],
    ...[null, '4', 4.2, true, {}, []].map(schemaVersion => [{ schemaVersion }, 'INVALID_SCHEMA_VERSION']),
    ...[null, 'assisted', 4, true, {}, []].map(authoringMode => [{ authoringMode }, 'INVALID_AUTHORING_MODE']),
    ...[null, 'payload', 1, true, []].map(authoring => [{ authoring }, 'INVALID_AUTHORING_BLOCK']),
  ];
  for (const [raw, code] of cases) {
    for (const read of [readProjectEnvelope, normalizeProjectData, migrateProjectData]) {
      assert.throws(() => read(raw), error => error.code === code);
    }
  }
});

test('advanced envelope rejects contradictory semantic projections and missing payload', () => {
  for (const mutate of [
    p => { p.rootEntries = [{}]; }, p => { p.projectType = 'pack'; },
    p => { p.nativeGraph = { document: {} }; }, p => { p.rootItems = [{}]; },
    p => { p.authoring.payload = {}; }, p => { delete p.authoring.payload; },
    p => { p.authoring.mediaBindings = null; }, p => { p.authoring.editorState = []; },
    p => { p.authoring.nodes = []; }, p => { p.authoring.editorState.edges = []; },
  ]) {
    const raw = advanced(); mutate(raw);
    assert.throws(() => readProjectEnvelope(raw), ProjectFormatError);
  }
  const raw = advanced(); delete raw.authoring.editorState;
  assert.equal(readProjectEnvelope(raw).authoringMode, 'advanced');
  assert.throws(() => normalizeProjectData(raw), error => error.code === 'ADVANCED_CODEC_REQUIRED');
});

test('two file cycles preserve the opaque string, view and missing media; summary stays derived', async () => {
  const raw = advanced();
  const original = structuredClone(raw);
  const calls = [];
  const validateAdvancedPayload = async payload => {
    calls.push(payload);
    return { payloadVersion: 1, identityStatus: 'requires-generation', stageCount: 0 };
  };
  let current = raw;
  for (let cycle = 0; cycle < 2; cycle++) {
    const text = encodeProjectFile(current);
    const result = await decodeProjectFile(text, { validateAdvancedPayload });
    assert.equal(result.summary.identityStatus, 'requires-generation');
    assert.equal(Object.hasOwn(result.project, 'summary'), false);
    assert.deepEqual(result.project, original);
    current = structuredClone(result.project);
  }
  assert.deepEqual(calls, [raw.authoring.payload, raw.authoring.payload]);
  assert.deepEqual(raw, original);
});

test('validation rejection names the file and never installs a project', async () => {
  const raw = advanced();
  await assert.rejects(decodeProjectFile(encodeProjectFile(raw), {
    fileName: 'test.mbah',
    validateAdvancedPayload: async () => { throw {
      code: 'UNSUPPORTED_PAYLOAD_VERSION', path: '/payloadVersion', found: '2', expected: '1',
    }; },
  }), error => error.fileName === 'test.mbah' && error.code === 'UNSUPPORTED_PAYLOAD_VERSION' && error.message.includes('2'));
  await assert.rejects(decodeProjectFile('{'), error => error.code === 'INVALID_PROJECT_JSON');
  let called = false;
  await assert.rejects(decodeProjectFile('{"schemaVersion":99}', {
    validateAdvancedPayload: () => { called = true; },
  }));
  assert.equal(called, false);
});

test('legacy Libre keeps its nativeGraph oracle and canonical schema without source mutation', async () => {
  const legacy = normalizeProjectData({
    projectName: 'Libre', rootEntries: [{ id: 'story', type: 'story', name: 'Histoire' }],
    nativeGraph: { preserveForRoundTrip: true, document: { title: 'Oracle', stageNodes: [{ uuid: 's' }], actionNodes: [] } },
  });
  delete legacy.authoringMode;
  legacy.mediaTags = { './a.mp3': ['conte'] };
  legacy.mediaLibraryPaths = ['./a.mp3'];
  const original = structuredClone(legacy);
  assert.ok(original.nativeGraph?.document);
  for (const source of [legacy, { ...legacy, schemaVersion: 4, authoringMode: 'free' }]) {
    const { project } = await decodeProjectFile(JSON.stringify(source), {
      validateAdvancedPayload: () => assert.fail('Libre ne consulte pas Rust'),
    });
    assert.equal(project.authoringMode, 'free');
    assert.deepEqual(project.mediaTags, original.mediaTags);
    assert.deepEqual(project.mediaLibraryPaths, original.mediaLibraryPaths);
    assert.equal(project.schemaVersion, 3);
    assert.deepEqual(project.nativeGraph, original.nativeGraph);
    assert.deepEqual(project.rootEntries, original.rootEntries);
    assert.equal(JSON.parse(encodeProjectFile(project)).authoringMode, 'free');
    assert.equal(projectToSerializable(project).schemaVersion, 3);
  }
  assert.deepEqual(legacy, original);
});

// En mode avancé, `packMetadata.uuid` est inerte. L'identité du pack vit dans
// le payload Rust ; l'enveloppe Libre ne la porte pas, ne la fabrique pas et ne
// la synchronise pas.
test('advanced mode never derives, creates or renews a pack identity from packMetadata', async () => {
  const summary = { payloadVersion: 1, identityStatus: 'resolved', stageCount: 1 };
  const validateAdvancedPayload = async () => summary;

  // Aucune identité d'enveloppe fabriquée là où le normaliseur Libre en crée une.
  const bare = advanced();
  assert.equal(Object.hasOwn(bare, 'packMetadata'), false);
  const decodedBare = await decodeProjectFile(encodeProjectFile(bare), { validateAdvancedPayload });
  assert.equal(Object.hasOwn(decodedBare.project, 'packMetadata'), false);
  assert.equal(decodedBare.summary.identityStatus, 'resolved');

  // Une identité d'enveloppe héritée traverse deux cycles sans être lue ni renouvelée.
  const inherited = { ...advanced(), packMetadata: { title: 'Le renard', uuid: 'e3b0-hérité', originalUuid: 'e3b0-hérité', version: 1 } };
  assert.equal(shouldPromptRegenerateImportedUuid(inherited.packMetadata), true);
  let current = inherited;
  for (let cycle = 0; cycle < 2; cycle++) {
    const { project } = await decodeProjectFile(encodeProjectFile(current), { validateAdvancedPayload });
    assert.deepEqual(project, inherited);
    assert.equal(project.packMetadata.uuid, 'e3b0-hérité');
    current = structuredClone(project);
  }

  // Le même projet en Libre reçoit bien, lui, une identité d'enveloppe : c'est
  // la différence de traitement qui prouve l'inertie, pas un simple silence.
  const free = normalizeProjectData(migrateProjectData({ projectName: 'Libre', rootEntries: [] }));
  assert.match(free.packMetadata.uuid, /\S/);
});
