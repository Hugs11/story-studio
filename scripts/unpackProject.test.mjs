import test from 'node:test';
import assert from 'node:assert/strict';

import { buildProjectAfterZipUnpack } from '../src/store/unpackProject.js';
import { normalizeProjectData } from '../src/store/projectModel.js';

test('zip unpack promotion keeps the local mbah project name after first save', () => {
  const project = normalizeProjectData({
    projectName: 'La petite histoire de la musique classique',
    projectType: 'pack',
    packMetadata: {},
    rootEntries: [{
      id: 'zip-1',
      type: 'zip',
      name: 'Dersouzala Petite histoire de la musique Classique by Dersouzala',
      zipPath: 'C:/workspace/fichiers-importes/nouveau projet 5__Dersouzala Petite histoire de la musique Classique_by Dersouzala v1 1781861932480 1.zip',
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
      title: 'Dersouzala Petite histoire de la musique Classique by Dersouzala',
      packVersion: 1,
      rootAudio: 'C:/workspace/zips-extraits/root.mp3',
      rootImage: 'C:/workspace/zips-extraits/root.png',
    },
    savedDuringUnpack: true,
  });

  assert.equal(nextProject.projectName, 'La petite histoire de la musique classique');
  assert.equal(nextProject.packMetadata.title, 'Dersouzala Petite histoire de la musique Classique by Dersouzala');
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

test('zip unpack promotion preserves graph shared entries', () => {
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
  assert.equal(nextProject.sharedEntries.length, 1);
  assert.equal(nextProject.sharedEntries[0].id, 'hub');
});
