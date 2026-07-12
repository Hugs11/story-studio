import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildLocalEndDraftFields,
  createLocalEndDraft,
  selectLocalEndDraftAudio,
} from '../src/store/localEndDraft.js';

test('le brouillon local est isole : le projet reste intact jusqu a application', () => {
  const project = {
    nightModeAudio: 'global.mp3',
    nightModeReturn: 'menu:fin',
    nightModeHomeReturn: null,
  };
  const snapshot = structuredClone(project);
  const draft = selectLocalEndDraftAudio(createLocalEndDraft(project), 'choisi.mp3');

  assert.deepEqual(project, snapshot);
  assert.deepEqual(buildLocalEndDraftFields(draft, draft.audio), {
    afterPlaybackPromptAudio: 'choisi.mp3',
    afterPlaybackPromptOkTarget: 'menu:fin',
    afterPlaybackPromptHomeTarget: null,
    afterPlaybackPromptHomeNone: true,
    afterPlaybackSequence: [],
    afterPlaybackHomeStep: null,
  });
});
