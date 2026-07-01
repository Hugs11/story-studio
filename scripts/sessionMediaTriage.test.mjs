// Tests du tri des médias de session à la promotion (plan 22, D51).
// Couvre la détection des orphelins (bibliothèque seulement, dans le dossier
// de session) et l'application du tri (remplacements + abandons) sur la
// bibliothèque et les tags.

import test from 'node:test';
import assert from 'node:assert/strict';
import { collectSessionOnlyMedia, applySessionMediaTriage } from '../src/store/sessionMediaTriage.js';
import { pathKey } from '../src/utils/fileUtils.js';

const SESSION_DIR = 'C:\\Temp\\story_studio_session_1234_5678_0';

function projectWith(paths = {}) {
  return {
    projectType: 'pack',
    rootAudio: paths.rootAudio ?? null,
    rootEntries: [
      {
        id: 's1',
        type: 'story',
        name: 'Histoire',
        audio: paths.storyAudio ?? null,
        itemImage: paths.storyImage ?? null,
      },
    ],
  };
}

test('collectSessionOnlyMedia: ignore les chemins hors session', () => {
  const orphans = collectSessionOnlyMedia({
    project: projectWith({}),
    mediaLibraryPaths: ['C:\\Users\\hugs\\Musique\\externe.mp3'],
    sessionDir: SESSION_DIR,
  });
  assert.deepEqual(orphans, []);
});

test('collectSessionOnlyMedia: ignore les fichiers de session référencés par un nœud', () => {
  const inSession = `${SESSION_DIR}\\voix-generees\\prise1.mp3`;
  const orphans = collectSessionOnlyMedia({
    project: projectWith({ storyAudio: inSession }),
    mediaLibraryPaths: [inSession],
    sessionDir: SESSION_DIR,
  });
  assert.deepEqual(orphans, []);
});

test('collectSessionOnlyMedia: détecte les fichiers de session non référencés', () => {
  const kept = `${SESSION_DIR}\\voix-generees\\prise1.mp3`;
  const orphan = `${SESSION_DIR}\\voix-generees\\prise2.mp3`;
  const orphans = collectSessionOnlyMedia({
    project: projectWith({ storyAudio: kept }),
    mediaLibraryPaths: [kept, orphan],
    sessionDir: SESSION_DIR,
  });
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].path, orphan);
  assert.equal(orphans[0].filename, 'prise2.mp3');
});

test('collectSessionOnlyMedia: la comparaison de chemins est insensible casse/séparateurs et dédupliquée', () => {
  const orphanBackslash = `${SESSION_DIR}\\images-generees\\Visuel.png`;
  const orphanForward = orphanBackslash.replace(/\\/g, '/').toUpperCase();
  const orphans = collectSessionOnlyMedia({
    project: projectWith({}),
    mediaLibraryPaths: [orphanBackslash, orphanForward],
    sessionDir: SESSION_DIR.replace(/\\/g, '/'),
  });
  assert.equal(orphans.length, 1);
});

test('collectSessionOnlyMedia: référence via séquence de fin comptée comme utilisée', () => {
  const inSequence = `${SESSION_DIR}\\voix-generees\\fin.mp3`;
  const project = {
    projectType: 'pack',
    rootEntries: [{
      id: 's1',
      type: 'story',
      name: 'Histoire',
      afterPlaybackSequence: [{ id: 'seq1', audio: inSequence }],
    }],
  };
  const orphans = collectSessionOnlyMedia({
    project,
    mediaLibraryPaths: [inSequence],
    sessionDir: SESSION_DIR,
  });
  assert.deepEqual(orphans, []);
});

test('collectSessionOnlyMedia: sans dossier de session, aucun orphelin', () => {
  const orphans = collectSessionOnlyMedia({
    project: projectWith({}),
    mediaLibraryPaths: [`${SESSION_DIR}\\fichiers-importes\\a.mp3`],
    sessionDir: '',
  });
  assert.deepEqual(orphans, []);
});

test('applySessionMediaTriage: remplace les conservés, retire les abandonnés, garde le reste', () => {
  const keptOld = `${SESSION_DIR}\\voix-generees\\prise2.mp3`;
  const keptNew = 'C:\\Workspace\\fichiers-importes\\prise2.mp3';
  const droppedPath = `${SESSION_DIR}\\images-generees\\brouillon.png`;
  const external = 'C:\\Users\\hugs\\Musique\\externe.mp3';

  const result = applySessionMediaTriage({
    mediaLibraryPaths: [keptOld, droppedPath, external],
    mediaTags: {
      [keptOld]: ['voix'],
      [droppedPath]: ['brouillon'],
      [external]: ['musique'],
    },
    replacements: new Map([[pathKey(keptOld), keptNew]]),
    droppedPaths: [droppedPath],
  });

  assert.deepEqual(result.mediaLibraryPaths, [keptNew, external]);
  assert.deepEqual(result.mediaTags, {
    [keptNew]: ['voix'],
    [external]: ['musique'],
  });
});

test('applySessionMediaTriage: sans tri, tout est conservé tel quel', () => {
  const paths = ['C:\\a.mp3', 'C:\\b.png'];
  const tags = { 'C:\\a.mp3': ['t'] };
  const result = applySessionMediaTriage({
    mediaLibraryPaths: paths,
    mediaTags: tags,
    replacements: new Map(),
    droppedPaths: [],
  });
  assert.deepEqual(result.mediaLibraryPaths, paths);
  assert.deepEqual(result.mediaTags, tags);
});
