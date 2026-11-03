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
  assert.deepEqual(await output.arguments(), { workspaceDir: '/workspace/A', projectDestination: { folder: 'Projet sans titre (2)', workId: storage.workId } });
  assert.equal(calls.length, 1);
  output.release(); output.release();
  assert.equal(isProjectMediaOutputBusy(storage.workId), false);
});
test('ephemeral outputs remain flat and never reserve workspace folders', async () => {
  const storage = createProjectStorage();
  const output = beginProjectMediaOutput({ root: '/cache/session', storage, ephemeral: true }, { invokeCommand: () => { throw new Error('unexpected disk call'); } });
  assert.equal(await output.directory('images-generees'), '/cache/session/images-generees');
  assert.deepEqual(await output.arguments(), { workspaceDir: '/cache/session', projectDestination: null });
  output.release();
});
