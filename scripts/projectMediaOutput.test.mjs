import test from 'node:test';
import assert from 'node:assert/strict';
import { beginProjectMediaOutput, isProjectMediaOutputBusy } from '../src/store/projectMediaOutput.js';
import { createProjectStorage } from '../src/store/projectStorage.js';

test('workspace destination is captured before a late job and blocks provisional moves', async () => {
  const storage = createProjectStorage();
  const context = { root: '/workspace/A', storage, ephemeral: false };
  const calls = [];
  const output = beginProjectMediaOutput(context, { invokeCommand: async (cmd, args) => { calls.push({cmd,args}); return 'Projet sans titre (2)'; } });
  assert.equal(isProjectMediaOutputBusy(storage.workId), true);
  context.root = '/workspace/B'; context.storage = createProjectStorage();
  assert.equal(await output.directory('voix-generees'), '/workspace/A/voix-generees/Projet sans titre (2)');
  assert.deepEqual(await output.arguments(), { workspaceDir: '/workspace/A', projectDestination: { folder: storage.folder, workId: storage.workId } });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], { cmd: 'resolve_project_folder', args: { root: '/workspace/A', folder: storage.folder, workId: storage.workId, create: true, category: 'voix-generees' } });
  output.release(); output.release();
  assert.equal(isProjectMediaOutputBusy(storage.workId), false);
});

test('job arguments create no folders; direct writes reserve only their own category', async () => {
  const storage = createProjectStorage();
  const calls = [];
  const output = beginProjectMediaOutput({ root: '/workspace', storage }, { invokeCommand: async (cmd, args) => {
    calls.push({ cmd, args });
    return args.category === 'images-generees' ? 'Projet sans titre' : 'Projet sans titre (2)';
  } });
  try {
    await output.arguments();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args.category, undefined);
    assert.equal(await output.directory('images-generees'), '/workspace/images-generees/Projet sans titre');
    assert.equal(await output.directory('voix-generees'), '/workspace/voix-generees/Projet sans titre (2)');
    await output.directory('images-generees');
    assert.deepEqual(calls.map(({ args }) => args.category), [undefined, 'images-generees', 'voix-generees']);
  } finally { output.release(); }
});
test('ephemeral outputs remain flat and never reserve workspace folders', async () => {
  const storage = createProjectStorage();
  const output = beginProjectMediaOutput({ root: '/cache/session', storage, ephemeral: true }, { invokeCommand: () => { throw new Error('unexpected disk call'); } });
  assert.equal(await output.directory('images-generees'), '/cache/session/images-generees');
  assert.deepEqual(await output.arguments(), { workspaceDir: '/cache/session', projectDestination: null });
  output.release();
});
