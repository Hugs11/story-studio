// Une histoire importée directe joue le message global avant la suivante.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProjectData } from '../src/store/projectModel.js';
import { getEffectiveEndBehavior } from '../src/store/generatedNavigation.js';

function importedDirectStory(id, returnAfterPlay) {
  return {
    id, type: 'story', name: id, nativeStageId: `native-${id}`,
    audio: `C:/message-fin/${id}.mp3`, itemAudio: null, itemImage: null,
    titleControlSettings: null,
    controlSettings: { autoplay: true, wheel: false, pause: true, ok: false, home: true },
    returnAfterPlay,
  };
}

test('histoire importée directe : message global puis histoire suivante', () => {
  const project = normalizeProjectData({
    projectType: 'pack', projectName: 'Message de fin',
    packMetadata: { title: 'Message de fin', uuid: '11111111-2222-4333-8444-555566667777' },
    rootAudio: 'C:/message-fin/root.mp3', rootImage: 'C:/message-fin/root.png',
    nightModeAudio: 'C:/message-fin/fin.mp3', globalOptions: { endNode: true },
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
