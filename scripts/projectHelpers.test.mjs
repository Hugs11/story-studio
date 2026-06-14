import test from 'node:test';
import assert from 'node:assert/strict';

import { markEntryAudioSkipSilence } from '../src/store/projectHelpers.js';

test('markEntryAudioSkipSilence marks all extracted story audios including end steps', () => {
  const entry = markEntryAudioSkipSilence({
    type: 'story',
    audio: 'story.mp3',
    afterPlaybackSequence: [{ audio: 'end-1.mp3' }],
    afterPlaybackHomeStep: { audio: 'home.mp3' },
  });

  assert.equal(entry.audioProcessing.audio.skipSilence, true);
  assert.equal(entry.audioProcessing.__allAudio.skipSilence, true);
});
