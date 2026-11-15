// Projet de reproduction H10b C3 ; oracle option (a), décision Hugs du 13 novembre.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProjectData } from '../src/store/projectModel.js';
import { getEffectiveEndBehavior } from '../src/store/generatedNavigation.js';

function importedDirectStory(id, returnAfterPlay) {
  return {
    id, type: 'story', name: id, nativeStageId: `native-${id}`,
    audio: `C:/h10b/${id}.mp3`, itemAudio: null, itemImage: null,
    titleControlSettings: null,
    controlSettings: { autoplay: true, wheel: false, pause: true, ok: false, home: true },
    returnAfterPlay,
  };
}

test('h10b_c3 histoire importée directe : message global puis histoire suivante', () => {
  const project = normalizeProjectData({
    projectType: 'pack', projectName: 'H10b',
    packMetadata: { title: 'H10b', uuid: '11111111-2222-4333-8444-555566667777' },
    rootAudio: 'C:/h10b/root.mp3', rootImage: 'C:/h10b/root.png',
    nightModeAudio: 'C:/h10b/fin.mp3', globalOptions: { endNode: true },
    rootEntries: [importedDirectStory('a', 'story:b'), importedDirectStory('b', 'story:a')],
  });
  for (const [index, next] of [[0, 'story:b'], [1, 'story:a']]) {
    const entry = project.rootEntries[index];
    assert.equal(entry.nativeStageId, `native-${entry.id}`);
    const behavior = getEffectiveEndBehavior(entry, null, project, project.rootEntries);
    assert.equal(behavior.endStepKind, 'end-node');
    assert.equal(behavior.finalTargetId, next);
  }
});
