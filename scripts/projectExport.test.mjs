import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeProjectData, projectToRustExport, projectToSerializable } from '../src/store/projectModel.js';

test('projectToRustExport injects Rust compatibility fields', () => {
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

  const rustExport = projectToRustExport(project);

  assert.equal(rustExport.name, '3+]Les_histoires_de_Mini-loup[by_funkyfoenky_V2');
  assert.equal(rustExport.packVersion, 2);
  assert.equal(rustExport.packDescription, 'Changelog');
});

test('projectToSerializable keeps legacy Rust fields out of the mbah model', () => {
  const serializable = projectToSerializable({
    projectName: 'Mini-loup',
    packMetadata: { title: 'Mini-loup', version: 1, minAge: '3' },
    projectType: 'pack',
    globalOptions: {},
    rootEntries: [],
  });

  assert.equal(Object.hasOwn(serializable, 'name'), false);
  assert.equal(Object.hasOwn(serializable, 'packVersion'), false);
  assert.equal(Object.hasOwn(serializable, 'packDescription'), false);
});

test('projectToRustExport preserves a legacy raw export name', () => {
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

test('projectToRustExport falls back to projectName for simple stories without packMetadata title', () => {
  const rustExport = projectToRustExport(normalizeProjectData({
    projectName: 'Le loup et l agneau',
    packMetadata: { title: '', minAge: '3', version: 1 },
    projectType: 'simple',
    globalOptions: {},
    rootEntries: [],
  }));

  assert.equal(rustExport.name, '3+]Le_loup_et_l_agneau');
});

test('projectToRustExport keeps pack mode unaffected when title is empty', () => {
  const rustExport = projectToRustExport(normalizeProjectData({
    projectName: 'Mon projet',
    packMetadata: { title: '', minAge: '3', version: 1 },
    projectType: 'pack',
    globalOptions: {},
    rootEntries: [],
  }));

  assert.equal(rustExport.name, 'Story Studio');
});
