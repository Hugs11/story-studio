import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeProjectData,
  projectToRustExport,
  projectToSerializable,
} from '../src/store/projectModel.js';

const LEGACY_ROOT_FIELDS = ['rootItems', 'menus'];
const RUST_EXPORT_FIELDS = ['name', 'packVersion', 'packDescription'];
const EXPECTED_MBAH_FIELDS = [
  'projectName',
  'packMetadata',
  'globalOptions',
  'nightModeAudio',
  'rootEntries',
];

function assertNoLegacyRootFields(snapshot, label) {
  for (const field of LEGACY_ROOT_FIELDS) {
    assert.equal(
      Object.hasOwn(snapshot, field),
      false,
      `${label} ne doit pas exposer ${field} à la racine`,
    );
  }
}

function buildSampleProject() {
  return normalizeProjectData({
    projectName: 'Mini-loup',
    packMetadata: {
      title: 'Les histoires de Mini-loup',
      author: 'funkyfoenky',
      version: 2,
      minAge: '3',
      description: 'Changelog',
    },
    projectType: 'pack',
    globalOptions: { autoNext: true, nightMode: false },
    nightModeAudio: 'D:/projet/audio/nightmode.mp3',
    mediaLibraryPaths: ['D:/projet/media-1.png', 'D:/projet/media-2.mp3'],
    mediaTags: { 'D:/projet/media-1.png': ['cover'] },
    rootEntries: [
      {
        id: 'menu-1',
        type: 'menu',
        name: 'Menu A',
        audio: 'D:/projet/menu-a.mp3',
        image: 'D:/projet/menu-a.png',
        children: [
          { id: 'story-1', type: 'story', name: 'Histoire 1', audio: 'D:/projet/story-1.mp3' },
          { id: 'zip-1', type: 'zip', name: 'Pack zip', zipPath: 'D:/projet/pack.zip' },
        ],
      },
      { id: 'story-root', type: 'story', name: 'Histoire racine', audio: 'D:/projet/root.mp3' },
    ],
  });
}

test('projectToSerializable ne produit ni rootItems ni menus à la racine', () => {
  const project = buildSampleProject();
  const serializable = projectToSerializable(project);

  assertNoLegacyRootFields(serializable, 'projectToSerializable');
});

test('projectToRustExport ne produit ni rootItems ni menus à la racine', () => {
  const project = buildSampleProject();
  const rustExport = projectToRustExport(project);

  assertNoLegacyRootFields(rustExport, 'projectToRustExport');
});

test("projectToSerializable conserve l'arbre rootEntries complet après normalisation", () => {
  const serializable = projectToSerializable(buildSampleProject());

  assert.equal(Array.isArray(serializable.rootEntries), true);
  assert.equal(serializable.rootEntries.length, 2);

  const [firstMenu, rootStory] = serializable.rootEntries;
  assert.equal(firstMenu.type, 'menu');
  assert.equal(firstMenu.id, 'menu-1');
  assert.equal(firstMenu.children.length, 2);
  assert.equal(firstMenu.children[0].type, 'story');
  assert.equal(firstMenu.children[0].id, 'story-1');
  assert.equal(firstMenu.children[1].type, 'zip');
  assert.equal(firstMenu.children[1].id, 'zip-1');
  assert.equal(firstMenu.children[1].zipPath, 'D:\\projet\\pack.zip');

  assert.equal(rootStory.type, 'story');
  assert.equal(rootStory.id, 'story-root');
});

test('projectToSerializable conserve les métadonnées attendues', () => {
  const serializable = projectToSerializable(buildSampleProject());

  for (const field of EXPECTED_MBAH_FIELDS) {
    assert.equal(Object.hasOwn(serializable, field), true, `champ attendu absent: ${field}`);
  }
  assert.equal(serializable.projectName, 'Mini-loup');
  assert.equal(serializable.packMetadata.title, 'Les histoires de Mini-loup');
  assert.equal(serializable.packMetadata.version, 2);
  assert.equal(serializable.globalOptions.autoNext, true);
  assert.equal(serializable.nightModeAudio, 'D:\\projet\\audio\\nightmode.mp3');
});

test('projectToRustExport ne contient pas les champs internes mbah-only spécifiques au modèle', () => {
  const rustExport = projectToRustExport(buildSampleProject());

  for (const field of RUST_EXPORT_FIELDS) {
    assert.equal(Object.hasOwn(rustExport, field), true, `champ Rust attendu absent: ${field}`);
  }
  assert.equal(rustExport.name, '3+]Les_histoires_de_Mini-loup[by_funkyfoenky_V2');
  assert.equal(rustExport.packVersion, 2);
  assert.equal(rustExport.packDescription, 'Changelog');
});

test('projectToSerializable est idempotent pour un projet vierge sans entrées', () => {
  const empty = normalizeProjectData({
    projectName: '',
    packMetadata: {},
    projectType: null,
    globalOptions: {},
    rootEntries: [],
  });

  const serializable = projectToSerializable(empty);
  assertNoLegacyRootFields(serializable, 'projectToSerializable (projet vierge)');
  assert.equal(Array.isArray(serializable.rootEntries), true);
  assert.equal(serializable.rootEntries.length, 0);
  assert.equal(serializable.projectType, null);
  assert.equal(Object.hasOwn(serializable, 'packMetadata'), true);
  assert.equal(Object.hasOwn(serializable, 'globalOptions'), true);
});

test('projectToRustExport accepte un projet vierge sans crash', () => {
  const empty = normalizeProjectData({
    projectName: '',
    packMetadata: {},
    projectType: null,
    globalOptions: {},
    rootEntries: [],
  });

  const rustExport = projectToRustExport(empty);
  assert.equal(typeof rustExport.name, 'string');
  assert.equal(rustExport.packVersion, 1);
  assert.equal(rustExport.packDescription, '');
  assertNoLegacyRootFields(rustExport, 'projectToRustExport (projet vierge)');
});
