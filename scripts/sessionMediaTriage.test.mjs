// Tests du tri des médias de session à la promotion. Couvre la détection des
// orphelins (bibliothèque seulement, dans le dossier de session) et
// l'application du tri (remplacements + abandons) sur la bibliothèque et les
// tags.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applySessionMediaTriage,
  collectSessionBoundReferences,
  collectSessionOnlyMedia,
} from '../src/store/sessionMediaTriage.js';
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
    mediaLibraryPaths: ['C:\\Users\\TestUser\\Musique\\externe.mp3'],
    sessionDir: SESSION_DIR,
  });
  assert.deepEqual(orphans, []);
});

test('collectSessionOnlyMedia: ne confond pas la session avec un dossier frère préfixé', () => {
  const sibling = `${SESSION_DIR}-copy\\voix-generees\\prise1.mp3`;
  const orphans = collectSessionOnlyMedia({
    project: projectWith({}),
    mediaLibraryPaths: [sibling],
    sessionDir: SESSION_DIR,
  });
  assert.deepEqual(orphans, []);
});

test('collectSessionOnlyMedia: conserve la sensibilité à la casse des chemins POSIX', () => {
  const sessionDir = '/tmp/StoryStudioSession';
  const differentCase = '/tmp/storystudiosession/voix-generees/prise1.mp3';
  const orphans = collectSessionOnlyMedia({
    project: projectWith({}),
    mediaLibraryPaths: [differentCase],
    sessionDir,
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
  const external = 'C:\\Users\\TestUser\\Musique\\externe.mp3';

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

test('applySessionMediaTriage: un média seulement tagué et conservé rejoint la bibliothèque', () => {
  const taggedOnly = `${SESSION_DIR}\\fichiers-importes\\tagge.mp3`;
  const copied = 'C:\\Workspace\\fichiers-importes\\tagge.mp3';
  const result = applySessionMediaTriage({
    mediaLibraryPaths: [],
    mediaTags: { [taggedOnly]: ['favori'] },
    replacements: new Map([[pathKey(taggedOnly), copied]]),
    droppedPaths: [],
  });

  assert.deepEqual(result.mediaLibraryPaths, [copied]);
  assert.deepEqual(result.mediaTags, { [copied]: ['favori'] });
});

test('collectSessionOnlyMedia: une clé de tag orpheline dans la session est détectée', () => {
  const taggedOnly = `${SESSION_DIR}\\fichiers-importes\\tagge.mp3`;
  const orphans = collectSessionOnlyMedia({
    project: projectWith({}),
    mediaLibraryPaths: [],
    mediaTags: { [taggedOnly]: ['favori'] },
    sessionDir: SESSION_DIR,
  });
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].path, taggedOnly);
});

test('collectSessionOnlyMedia: les chemins déjà copiés par le transfert sont exclus', () => {
  const transferred = `${SESSION_DIR}\\voix-generees\\deja-copie.mp3`;
  const realOrphan = `${SESSION_DIR}\\voix-generees\\orphelin.mp3`;
  const excludeKeys = new Map([[pathKey(transferred), 'C:/Workspace/fichiers-importes/deja-copie.mp3']]);
  const orphans = collectSessionOnlyMedia({
    project: projectWith({}),
    mediaLibraryPaths: [transferred, realOrphan],
    sessionDir: SESSION_DIR,
    excludeKeys,
  });
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].path, realOrphan);
});

// ── Dépendances restées dans la session ──────────────────────────────────────
// Ce qu'un nettoyage de promotion détruirait. La traversée est celle de tous les
// consommateurs : une liaison média du mode Avancé y figure comme une référence
// d'arbre, et un chemin extérieur n'y figure pas.

const advancedProject = (bindings) => ({
  schemaVersion: 4,
  authoringMode: 'advanced',
  projectType: 'advanced',
  projectName: 'avance',
  rootEntries: [],
  authoring: { payload: '{"payloadVersion":1}', editorState: { version: 1 }, mediaBindings: bindings },
});

test('collectSessionBoundReferences: une liaison avancée dans la session est une dépendance', () => {
  const inside = `${SESSION_DIR}\\fichiers-importes\\a1b2c3.mp3`;
  const bound = collectSessionBoundReferences({
    project: advancedProject([
      { assetRef: 'a1b2c3.mp3', path: inside, status: 'resolved' },
      { assetRef: 'd4e5f6.png', path: 'C:\\Users\\TestUser\\Images\\couverture.png', status: 'resolved' },
    ]),
    sessionDir: SESSION_DIR,
  });
  assert.deepEqual(bound, [{ path: inside, label: 'Média avancé: a1b2c3.mp3' }]);
});

test('collectSessionBoundReferences: références Libre dédupliquées, dossier frère exclu', () => {
  const inside = `${SESSION_DIR}\\enregistrements\\intro.mp3`;
  const bound = collectSessionBoundReferences({
    project: projectWith({ rootAudio: inside, storyAudio: inside, storyImage: `${SESSION_DIR}-copy\\a.png` }),
    sessionDir: SESSION_DIR,
  });
  assert.deepEqual(bound.map((entry) => entry.path), [inside]);
});

test('collectSessionBoundReferences: sans dossier de session ni projet, aucune dépendance', () => {
  assert.deepEqual(collectSessionBoundReferences({ project: projectWith({}), sessionDir: '' }), []);
  assert.deepEqual(collectSessionBoundReferences({ project: null, sessionDir: SESSION_DIR }), []);
});

// Le tri « Médias non utilisés » d'un projet graphe : un média lié par le
// document n'est jamais proposé à l'abandon, qu'il soit encore dans la session
// ou déjà copié par le transfert. Seul un média du catalogue qu'aucune liaison
// ne désigne l'est.
test('collectSessionOnlyMedia: un média lié par le graphe n’est jamais orphelin', () => {
  const bound = `${SESSION_DIR}\\zips-extraits\\pack.zip\\a1b2c3.mp3`;
  const transferred = `${SESSION_DIR}\\zips-extraits\\pack.zip\\d4e5f6.png`;
  const unused = `${SESSION_DIR}\\fichiers-importes\\a1b2c3--1790000000000-1.mp3`;
  const copy = 'C:\\Projets\\fichiers-importes\\projet__d4e5f6.png';
  const orphans = collectSessionOnlyMedia({
    project: advancedProject([
      { assetRef: 'a1b2c3.mp3', path: bound, status: 'resolved' },
      // Après le transfert, la liaison désigne la copie du projet.
      { assetRef: 'd4e5f6.png', path: copy, status: 'resolved' },
    ]),
    mediaLibraryPaths: [bound, transferred, unused],
    sessionDir: SESSION_DIR,
    excludeKeys: new Map([[pathKey(transferred), copy]]),
  });
  assert.deepEqual(orphans.map((item) => item.path), [unused]);
});
