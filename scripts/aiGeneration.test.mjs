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
