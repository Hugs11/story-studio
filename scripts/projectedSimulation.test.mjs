import test from 'node:test';
import assert from 'node:assert/strict';

import { runner } from './reactHookDriver.mjs';
const { useProjectedSimulation } = await import('../src/hooks/useProjectedSimulation.js');
const { normalizeProjectData, projectToRustExport } = await import('../src/store/projectModel/schema.js');

const settle = () => new Promise((resolve) => setImmediate(resolve));

function projectFixture(projectType, title = 'Le voyage') {
  return normalizeProjectData({
    projectType,
    projectName: 'Mon histoire',
    packMetadata: {
      title, version: 4, description: 'Une aventure',
      uuid: '11111111-1111-4111-8111-111111111111', namingMode: 'legacy',
    },
    rootAudio: 'C:\\travail\\couverture.wav',
    rootImage: '/travail/couverture.png',
    rootEntries: [{ id: 's1', type: 'story', name: 'Histoire', audio: '/travail/lecture.wav' }],
  });
}

function projectionFixture(project) {
  return {
    story: {
      title: project.name || 'Story Studio',
      stageNodes: [{ uuid: 'cover', squareOne: true, audio: 'cover.mp3', image: 'cover.png' }],
      actionNodes: [],
    },
    media: [
      { assetName: 'cover.mp3', kind: 'disk', path: project.rootAudio },
      { assetName: 'cover.png', kind: 'disk', path: project.rootImage },
    ],
  };
}

for (const [type, title] of [['simple', 'Le voyage'], ['pack', 'Le voyage'], ['simple', '']]) {
  test(`la projection ${type} reçoit le DTO de génération (titre ${title || 'de repli'}) et garde les chemins`, async () => {
    const project = projectFixture(type, title);
    const before = structuredClone(project);
    const expected = projectToRustExport(project);
    let received;
    const projectStory = async (dto) => {
      received = dto;
      return projectionFixture(dto);
    };
    const launch = { nodeId: 'root' };
    const hook = runner(() => useProjectedSimulation({ project, launch, projectStory }));
    hook.render();
    hook.flush();
    await settle();
    const state = hook.render();

    assert.equal(state.status, 'ready');
    assert.equal(state.graph.title, expected.name);
    assert.deepEqual(received, expected);
    assert.equal(state.graph.stages.get('cover').audio.path, expected.rootAudio);
    assert.equal(state.graph.stages.get('cover').image.path, expected.rootImage);
    assert.equal(received.rootEntries[0].audio, '/travail/lecture.wav');
    assert.deepEqual(project, before);
    hook.unmount();
  });
}
