import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createAudioEditorWaveformOptions,
  disposeAudioEditorWaveform,
} from '../src/components/AudioEditorModal/audioEditorWaveform.js';
import { MIME } from '../src/utils/mimeTypes.js';

test('FLAC object URLs use an audio MIME type understood by WebKitGTK', () => {
  assert.equal(MIME.flac, 'audio/flac');
});

test('audio editor cleanup pauses playback before destroying WaveSurfer', () => {
  const calls = [];
  disposeAudioEditorWaveform({
    pause() {
      calls.push('pause');
    },
    destroy() {
      calls.push('destroy');
    },
  });
  assert.deepEqual(calls, ['pause', 'destroy']);
});

test('audio editor keeps a single WebAudio backend for waveform and playback', () => {
  const options = createAudioEditorWaveformOptions({
    container: {},
    url: 'blob:test',
    plugins: [],
  });
  assert.equal(options.backend, 'WebAudio');
  assert.equal(options.sampleRate, 44100);
});
