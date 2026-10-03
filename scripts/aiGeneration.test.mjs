import test from 'node:test';
import assert from 'node:assert/strict';

import { applyGeneratedAudioToTarget } from '../src/store/generatedAudioTarget.js';

test('la generation TTS du message global passe par la mutation de propagation', () => {
  const calls = [];
  const store = {
    updateGlobalEndMessage: (fields) => calls.push(['global', fields]),
    updateRootMedia: (...args) => calls.push(['root', args]),
  };

  applyGeneratedAudioToTarget({
    target: { kind: 'root', field: 'nightModeAudio' },
    path: 'voix-generees/fin.mp3',
    store,
    projectIndex: { entryById: new Map() },
  });

  assert.deepEqual(calls, [['global', { nightModeAudio: 'voix-generees/fin.mp3' }]]);
});

test('les autres medias racine continuent d utiliser leur mutation dediee', () => {
  const calls = [];
  const store = {
    updateGlobalEndMessage: (fields) => calls.push(['global', fields]),
    updateRootMedia: (...args) => calls.push(['root', args]),
  };

  applyGeneratedAudioToTarget({
    target: { kind: 'root', field: 'rootAudio' },
    path: 'voix-generees/accueil.mp3',
    store,
    projectIndex: { entryById: new Map() },
  });

  assert.deepEqual(calls, [['root', ['rootAudio', 'voix-generees/accueil.mp3']]]);
});

// La voix de synthèse lancée depuis un projet graphe.
test('cote graphe, une voix generee n ajoute aucune histoire au document', () => {
  const calls = [];
  const store = {
    addStory: (...args) => calls.push(['addStory', args]),
    updateItem: (...args) => calls.push(['updateItem', args]),
    updateRootMedia: (...args) => calls.push(['root', args]),
    updateGlobalEndMessage: (fields) => calls.push(['global', fields]),
  };

  applyGeneratedAudioToTarget({
    target: { kind: 'mediaLibrary' },
    path: 'voix-generees/histoire.mp3',
    store,
    projectIndex: { entryById: new Map() },
  });

  // Le fichier est dans la bibliotheque — la file de rendu IA l'y depose pour
  // tout audio genere. Le document, lui, n'a pas bouge : aucun Ecran n'est ne
  // du seul fait qu'une voix a ete produite.
  assert.deepEqual(calls, []);
});

test('une voix generee depuis les reglages rejoint l Ecran encore ouvert', async () => {
  const calls = [];
  const store = { workEpochRef: { current: 7 } };
  await applyGeneratedAudioToTarget({
    target: {
      kind: 'advancedStage',
      projectEpoch: 7,
      apply: async (path) => calls.push(path),
    },
    path: 'voix-generees/ecran.mp3',
    store,
  });
  assert.deepEqual(calls, ['voix-generees/ecran.mp3']);
});

test('une voix avancee terminee apres un changement de projet est ignoree', async () => {
  const calls = [];
  const store = { workEpochRef: { current: 8 } };
  await applyGeneratedAudioToTarget({
    target: {
      kind: 'advancedStage',
      projectEpoch: 7,
      apply: async (path) => calls.push(path),
    },
    path: 'voix-generees/ancien-ecran.mp3',
    store,
  });
  assert.deepEqual(calls, []);
});

test('cote Libre, la meme voix continue de creer son histoire dans le dossier vise', () => {
  const calls = [];
  const store = {
    addStory: (...args) => calls.push(['addStory', args]),
  };

  applyGeneratedAudioToTarget({
    target: { kind: 'newStory', menuId: 'menu-2' },
    path: 'voix-generees/histoire.mp3',
    store,
    projectIndex: { entryById: new Map() },
    getStoryName: () => 'Le renard',
  });

  assert.deepEqual(calls, [
    ['addStory', ['menu-2', 'voix-generees/histoire.mp3', { name: 'Le renard' }]],
  ]);
});
