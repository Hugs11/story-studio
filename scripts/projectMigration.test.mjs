import test from 'node:test';
import assert from 'node:assert/strict';

import { migrateProjectData, normalizeProjectData, projectToRustExport, projectToSerializable } from '../src/store/projectModel.js';

test('migrates a legacy convention name to pack metadata', () => {
  const migrated = normalizeProjectData(migrateProjectData({
    name: '3+]Les_histoires_de_Mini-loup[by_funkyfoenky_V2',
    projectType: 'pack',
    globalOptions: {},
    rootEntries: [],
  }, { savePath: 'D:/packs/Mini-loup.mbah' }));

  assert.equal(migrated.projectName, 'Mini-loup');
  assert.equal(migrated.packMetadata.title, 'Les histoires de Mini-loup');
  assert.equal(migrated.packMetadata.author, 'funkyfoenky');
  assert.equal(migrated.packMetadata.version, 2);
  assert.equal(migrated.packMetadata.namingMode, 'convention');
});

test('migrates a legacy non convention name without changing export mode', () => {
  const migrated = normalizeProjectData(migrateProjectData({
    name: 'Mon pack perso',
    projectType: 'pack',
    globalOptions: {},
    rootEntries: [],
  }));

  assert.equal(migrated.projectName, 'Mon pack perso');
  assert.equal(migrated.packMetadata.title, 'Mon pack perso');
  assert.equal(migrated.packMetadata.namingMode, 'legacy');
  assert.equal(migrated.packMetadata.legacyExportName, 'Mon pack perso');
});

test('legacy fields enrich pack metadata', () => {
  const migrated = normalizeProjectData(migrateProjectData({
    name: '3+]Mini_loup',
    packVersion: 4,
    packDescription: 'Changelog',
    packMinAge: '5',
    projectType: 'pack',
    globalOptions: {},
    rootEntries: [],
  }));

  assert.equal(migrated.packMetadata.version, 4);
  assert.equal(migrated.packMetadata.description, 'Changelog');
  assert.equal(migrated.packMetadata.minAge, '5');
});

test('legacy convention without savePath keeps projectName local fallback', () => {
  const migrated = normalizeProjectData(migrateProjectData({
    name: '3+]Les_histoires_de_Mini-loup[by_funkyfoenky_V2',
    projectType: 'pack',
    globalOptions: {},
    rootEntries: [],
  }));

  assert.equal(migrated.projectName, 'nouveau-projet');
  assert.equal(migrated.packMetadata.title, 'Les histoires de Mini-loup');
});

test('new structure remains idempotent', () => {
  const source = {
    schemaVersion: 3,
    projectName: 'Mini-loup',
    packMetadata: { title: 'Mini-loup', version: 2, minAge: '3' },
    projectType: 'pack',
    globalOptions: {},
    rootEntries: [],
  };
  const migrated = normalizeProjectData(migrateProjectData(source, { savePath: 'D:/other/path.mbah' }));

  assert.equal(migrated.projectName, 'Mini-loup');
  assert.equal(migrated.packMetadata.title, 'Mini-loup');
  assert.equal(migrated.packMetadata.version, 2);
});

test('rust export injects compatibility fields without polluting serializable project', () => {
  const project = normalizeProjectData({
    projectName: 'Mini-loup',
    packMetadata: {
      title: 'Les histoires de Mini-loup',
      author: 'funkyfoenky',
      version: 2,
      minAge: '3',
      description: 'Changelog',
    },
    projectType: 'pack',
    globalOptions: {},
    rootEntries: [],
  });
  const serializable = projectToSerializable(project);
  const rustExport = projectToRustExport(project);

  assert.equal(Object.hasOwn(serializable, 'name'), false);
  assert.equal(Object.hasOwn(serializable, 'packVersion'), false);
  assert.equal(rustExport.name, '3+]Les_histoires_de_Mini-loup[by_funkyfoenky_V2');
  assert.equal(rustExport.packVersion, 2);
  assert.equal(rustExport.packDescription, 'Changelog');
});

test('rust export preserves legacy raw name', () => {
  const rustExport = projectToRustExport(normalizeProjectData({
    projectName: 'Perso',
    packMetadata: {
      title: 'Mon pack perso',
      namingMode: 'legacy',
      legacyExportName: 'Mon pack perso',
    },
    projectType: 'pack',
    globalOptions: {},
    rootEntries: [],
  }));

  assert.equal(rustExport.name, 'Mon pack perso');
});
