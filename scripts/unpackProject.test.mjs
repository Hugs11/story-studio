import test from 'node:test';
import assert from 'node:assert/strict';

import { buildProjectAfterZipUnpack, getUnpackedPackDetails } from '../src/store/unpackProject.js';
import { normalizeProjectData } from '../src/store/projectModel.js';

test('unpack derives a clean title from a non-prefixed filename (no story title)', () => {
  const { packMetadata } = getUnpackedPackDetails({
    result: {},
    zipPath: "C:/tmp/session/fichiers-importes/3+ Example story part à l'aventure.zip",
  });
  // Pas de préfixe « nouveau projet » injecté, et l'âge libre « 3+ » remonte vers minAge.
  assert.equal(packMetadata.title, "Example story part à l'aventure");
  assert.equal(packMetadata.minAge, '3');
});

test('unpack does not lift a leading number that is not an age token', () => {
  const { packMetadata } = getUnpackedPackDetails({
    result: {},
    zipPath: 'C:/tmp/session/fichiers-importes/3+5 choses.zip',
  });
  assert.equal(packMetadata.title, '3+5 choses');
});

test('unpack keeps the pack uuid read from the story doc', () => {
  const { packMetadata } = getUnpackedPackDetails({
    result: { title: "3+]Example_story[by_Studio_V2", uuid: '11111111-2222-4333-8444-555555555555' },
    zipPath: 'C:/x/3+]Example.zip',
  });
  assert.equal(packMetadata.title, 'Example story');
  assert.equal(packMetadata.minAge, '3');
  assert.equal(packMetadata.uuid, '11111111-2222-4333-8444-555555555555');
});

test('zip unpack promotion keeps the local mbah project name after first save', () => {
  const project = normalizeProjectData({
    projectName: 'Example local project',
    projectType: 'pack',
    packMetadata: {},
    rootEntries: [{
      id: 'zip-1',
      type: 'zip',
      name: 'Example classic story by Example Author',
      zipPath: 'C:/workspace/fichiers-importes/example-classic-story.zip',
    }],
  });

  const { project: nextProject } = buildProjectAfterZipUnpack({
    project,
    menuId: null,
    itemId: 'zip-1',
    entries: [{ id: 'story-1', type: 'story', name: 'Ouverture', audio: 'C:/workspace/zips-extraits/audio.mp3' }],
    zipPath: project.rootEntries[0].zipPath,
    zipName: project.rootEntries[0].name,
    result: {
      title: 'Example classic story by Example Author',
      packVersion: 1,
      uuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      rootAudio: 'C:/workspace/zips-extraits/root.mp3',
      rootImage: 'C:/workspace/zips-extraits/root.png',
    },
    savedDuringUnpack: true,
  });

  assert.equal(nextProject.projectName, 'Example local project');
  assert.equal(nextProject.packMetadata.title, 'Example classic story by Example Author');
  assert.equal(nextProject.packMetadata.uuid, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  assert.equal(nextProject.rootEntries.length, 1);
  assert.equal(nextProject.rootEntries[0].id, 'story-1');
  assert.equal(nextProject.rootAudio, 'C:/workspace/zips-extraits/root.mp3');
});

test('zip unpack inside an existing project only replaces the zip entry', () => {
  const project = normalizeProjectData({
    projectName: 'Projet parent',
    projectType: 'pack',
    packMetadata: { title: 'Projet parent', version: 1, minAge: '3' },
    rootEntries: [
      { id: 'story-existing', type: 'story', name: 'Déjà là' },
      { id: 'zip-1', type: 'zip', name: 'Pack enfant', zipPath: 'C:/packs/pack-enfant.zip' },
    ],
  });

  const { project: nextProject } = buildProjectAfterZipUnpack({
    project,
    menuId: null,
    itemId: 'zip-1',
    entries: [{ id: 'story-new', type: 'story', name: 'Extraite' }],
    zipPath: project.rootEntries[1].zipPath,
    zipName: project.rootEntries[1].name,
    result: { title: 'Pack enfant' },
  });

  assert.equal(nextProject.projectName, 'Projet parent');
  assert.equal(nextProject.packMetadata.title, 'Projet parent');
  assert.deepEqual(nextProject.rootEntries.map((entry) => entry.id), ['story-existing', 'story-new']);
});

test('zip unpack promotion ignores graph shared entries', () => {
  const project = normalizeProjectData({
    projectName: '',
    projectType: null,
    rootEntries: [{ id: 'zip-1', type: 'zip', name: 'Pack enfant', zipPath: 'C:/packs/pack.zip' }],
  });

  const { project: nextProject } = buildProjectAfterZipUnpack({
    project,
    menuId: null,
    itemId: 'zip-1',
    entries: [{ id: 'ref-hub', type: 'ref', target: 'story:hub' }],
    sharedEntries: [{ id: 'hub', type: 'story', name: 'Hub', audio: 'C:/packs/hub.mp3' }],
    zipPath: project.rootEntries[0].zipPath,
    zipName: project.rootEntries[0].name,
    result: { title: 'Pack enfant' },
    savedDuringUnpack: true,
  });

  assert.equal(nextProject.rootEntries[0].target, 'story:hub');
  assert.equal(Object.hasOwn(nextProject, 'sharedEntries'), false);
});

function blankProjectWithZip(uuid) {
  return normalizeProjectData({
    projectType: 'pack',
    packMetadata: { uuid },
    rootEntries: [{ id: 'zip-1', type: 'zip', name: 'Pack', zipPath: '/packs/pack.zip' }],
  });
}

function promote(project, result) {
  return buildProjectAfterZipUnpack({
    project,
    menuId: null,
    itemId: 'zip-1',
    entries: [{ id: 'story-1', type: 'story', name: 'Ouverture', audio: '/x/audio.mp3' }],
    zipPath: '/packs/pack.zip',
    zipName: 'Pack',
    result,
  });
}

test('zip unpack promotion keeps the project identity when the pack brings none', () => {
  const projectUuid = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
  const { project: nextProject, promoted } = promote(blankProjectWithZip(projectUuid), { title: 'Pack' });

  assert.equal(promoted, true);
  assert.equal(nextProject.packMetadata.uuid, projectUuid);
  assert.equal(nextProject.packMetadata.originalUuid, '');
});

test('zip unpack promotion never leaves the project without identity', () => {
  const { project: nextProject } = promote(blankProjectWithZip(''), { title: 'Pack' });

  assert.match(nextProject.packMetadata.uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(nextProject.packMetadata.originalUuid, '');
});

test('zip unpack promotion takes the identity the pack brings', () => {
  const packUuid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const { project: nextProject } = promote(
    blankProjectWithZip('bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'),
    { title: 'Pack', uuid: packUuid },
  );

  assert.equal(nextProject.packMetadata.uuid, packUuid);
  assert.equal(nextProject.packMetadata.originalUuid, packUuid);
});
