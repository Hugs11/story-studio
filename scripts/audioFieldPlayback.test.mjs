import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createAudioFieldWebAudioOptions,
  disposeAudioFieldWebAudio,
  needsWebAudioPlayback,
  stopAudioFieldWebAudio,
} from '../src/components/editors/audioFieldPlayback.js';

test('compact audio fields reserve Web Audio playback for FLAC files', () => {
  assert.equal(needsWebAudioPlayback('/tmp/Été sonore/Voix.FLAC'), true);
  assert.equal(needsWebAudioPlayback('/tmp/Été sonore/voix.flac?version=2'), true);
  assert.equal(needsWebAudioPlayback('/tmp/Été sonore/voix.mp3'), false);
});

test('compact FLAC playback uses the same Web Audio backend as the editor', () => {
  const options = createAudioFieldWebAudioOptions({});
  assert.equal(options.backend, 'WebAudio');
  assert.equal(options.sampleRate, 44100);
  assert.equal(options.interact, false);
});

test('compact Web Audio playback can pause, reset, and dispose deterministically', () => {
  const calls = [];
  const player = {
    pause() {
      calls.push('pause');
    },
    setTime(value) {
      calls.push(`setTime:${value}`);
    },
    destroy() {
      calls.push('destroy');
    },
  };

  stopAudioFieldWebAudio(player, true);
  disposeAudioFieldWebAudio(player);

  assert.deepEqual(calls, ['pause', 'setTime:0', 'pause', 'destroy']);
});
