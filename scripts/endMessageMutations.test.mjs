import test from 'node:test';
import assert from 'node:assert/strict';

import {
  attachStoryEndToGlobalProject,
  removeGlobalEndMessageProject,
  updateGlobalEndMessageProject,
} from '../src/store/endMessageMutations.js';

function baseProject() {
  const linkedControls = { autoplay: false, ok: true, home: true, pause: true, wheel: false };
  return {
    nightModeAudio: 'global.mp3',
    nightModeReturn: 'menu:menu',
    nightModeHomeReturn: null,
    globalOptions: { nightMode: true, endNode: true },
    rootEntries: [{
      id: 'menu', type: 'menu', children: [
        {
          id: 'linked', type: 'story', afterPlaybackPromptAudio: 'global.mp3',
          afterPlaybackPromptOkTarget: 'menu:menu', afterPlaybackPromptHomeNone: true,
          afterPlaybackPromptControlSettings: linkedControls,
        },
        {
          id: 'local', type: 'story', afterPlaybackPromptAudio: 'global.mp3',
          afterPlaybackPromptOkTarget: 'menu:menu', afterPlaybackPromptHomeTarget: 'root',
          afterPlaybackPromptHomeNone: false,
          afterPlaybackPromptControlSettings: { autoplay: false, ok: false, home: false, pause: true, wheel: true },
        },
      ],
    }],
  };
}

function stories(project) {
  return project.rootEntries[0].children;
}

test('mise a jour globale propage seulement les projections liees et preserve les controles', () => {
  const project = baseProject();
  const next = updateGlobalEndMessageProject(project, { nightModeAudio: 'nouveau.mp3' });
  const [linked, local] = stories(next);

  assert.equal(next.nightModeAudio, 'nouveau.mp3');
  assert.equal(linked.afterPlaybackPromptAudio, 'nouveau.mp3');
  assert.equal(local.afterPlaybackPromptAudio, 'global.mp3');
  assert.deepEqual(linked.afterPlaybackPromptControlSettings, project.rootEntries[0].children[0].afterPlaybackPromptControlSettings);
  assert.equal(project.nightModeAudio, 'global.mp3');
});

test('rattachement aligne les trois dimensions sans modifier les controles locaux', () => {
  const project = baseProject();
  const next = attachStoryEndToGlobalProject(project, 'local');
  const local = stories(next)[1];

  assert.equal(local.afterPlaybackPromptAudio, 'global.mp3');
  assert.equal(local.afterPlaybackPromptOkTarget, 'menu:menu');
  assert.equal(local.afterPlaybackPromptHomeNone, true);
  assert.equal(local.afterPlaybackPromptHomeTarget, null);
  assert.deepEqual(local.afterPlaybackPromptControlSettings, project.rootEntries[0].children[1].afterPlaybackPromptControlSettings);
});

test('suppression globale retire les projections liees et conserve les fins locales', () => {
  const project = baseProject();
  const next = removeGlobalEndMessageProject(project);
  const [linked, local] = stories(next);

  assert.equal(next.nightModeAudio, null);
  assert.equal(next.globalOptions.nightMode, false);
  assert.equal(linked.afterPlaybackPromptAudio, null);
  assert.deepEqual(linked.afterPlaybackSequence, []);
  assert.equal(local.afterPlaybackPromptAudio, 'global.mp3');
  assert.equal(local.afterPlaybackPromptHomeTarget, 'root');
});
