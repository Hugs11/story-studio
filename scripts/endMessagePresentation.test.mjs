import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyEndMessagePresentation,
  summarizeEndMessagePlayback,
} from '../src/store/endMessagePresentation.js';
import { getGeneratedEndMessageControls } from '../src/store/generatedPlayback.js';
import { getEffectiveEndMessageControlState } from '../src/store/endMessagePresentation.js';

const globalHome = { kind: 'none', effectiveTargetId: null };

test('une projection liee reste globale malgre des controles de lecture differents', () => {
  const result = classifyEndMessagePresentation({
    entry: {
      afterPlaybackPromptAudio: 'audio/fin.mp3',
      afterPlaybackPromptHomeNone: true,
      afterPlaybackPromptControlSettings: { autoplay: false, pause: true },
    },
    globalActive: true,
    globalAudio: 'audio/fin.mp3',
    promptOkTargetId: 'story:suivante',
    globalOkTargetId: 'story:suivante',
    promptHome: globalHome,
    globalHome,
  });

  assert.equal(result.presentationKind, 'global');
  assert.deepEqual(result.controlDifferences.sort(), ['autoplay', 'pause']);
});

test('une divergence audio, OK ou Home rend le prompt entier local', () => {
  const base = {
    entry: { afterPlaybackPromptAudio: 'fin.mp3' },
    globalActive: true,
    globalAudio: 'fin.mp3',
    promptOkTargetId: 'menu:a',
    globalOkTargetId: 'menu:a',
    promptHome: globalHome,
    globalHome,
  };

  assert.equal(classifyEndMessagePresentation({ ...base, globalAudio: 'autre.mp3' }).presentationKind, 'local_prompt');
  assert.equal(classifyEndMessagePresentation({ ...base, promptOkTargetId: 'menu:b' }).presentationKind, 'local_prompt');
  assert.equal(classifyEndMessagePresentation({
    ...base,
    promptHome: { kind: 'follow-ok', effectiveTargetId: 'menu:a' },
  }).presentationKind, 'local_prompt');
});

test('sequence, absence de global et absence de comportement ont chacune leur presentation', () => {
  assert.equal(classifyEndMessagePresentation({
    entry: { afterPlaybackSequence: [{ id: 'etape' }] },
    globalActive: true,
  }).presentationKind, 'local_sequence');
  assert.equal(classifyEndMessagePresentation({
    entry: { afterPlaybackPromptAudio: 'fin.mp3' },
  }).presentationKind, 'local_prompt');
  assert.equal(classifyEndMessagePresentation({ entry: {} }).presentationKind, 'none');
});

test('les controles effectifs du message global sans projection suivent Rust', () => {
  assert.deepEqual(getGeneratedEndMessageControls({}), {
    wheel: false,
    ok: true,
    home: true,
    pause: false,
    autoplay: true,
  });
  assert.equal(getGeneratedEndMessageControls({}, { globalAutoplay: false }).autoplay, false);
});

test('le resume de lecture distingue auto, attente et mixte importe', () => {
  const auto = { playback: 'autoplay', home: 'target' };
  const wait = { playback: 'wait-ok', home: 'target' };
  assert.deepEqual(summarizeEndMessagePlayback([], false), {
    mode: 'wait', mixed: false, autoPlay: 0, waitingOk: 0, stays: 0, total: 0,
  });
  assert.equal(summarizeEndMessagePlayback([auto, auto]).mode, 'auto');
  assert.equal(summarizeEndMessagePlayback([wait, wait]).mode, 'wait');
  assert.deepEqual(summarizeEndMessagePlayback([
    ...Array.from({ length: 145 }, () => wait),
    ...Array.from({ length: 9 }, () => auto),
  ]), {
    mode: 'mixed', mixed: true, autoPlay: 9, waitingOk: 145, stays: 0, total: 154,
  });
});

test('le resume distingue attente OK, absence de sortie et Accueil desactive', () => {
  assert.deepEqual(getEffectiveEndMessageControlState(
    { autoplay: false, ok: true, home: true }, globalHome,
  ), { playback: 'wait-ok', home: 'pack-start' });
  assert.deepEqual(getEffectiveEndMessageControlState(
    { autoplay: false, ok: false, home: false }, { kind: 'target', effectiveTargetId: 'menu:fin' },
  ), { playback: 'stays', home: 'disabled' });
});
