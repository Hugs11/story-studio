import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { runner } from './reactHookDriver.mjs';
import { createDiskHarness } from './tauriDiskHarness.mjs';
const { useSdStore } = await import('../src/store/sdStore.js');
const { useSDJobs } = await import('../src/hooks/useSDJobs.js');
const { createProjectStorage } = await import('../src/store/projectStorage.js');
const { captureProjectMediaJob, isProjectMediaOutputBusy } = await import('../src/store/projectMediaOutput.js');
const { prepareProjectStorageSave } = await import('../src/store/projectStorageSave.js');
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
};

for (const firstFails of [true, false]) {
  test(`ComfyUI keeps the folder reserved until every download settles (first fails: ${firstFails})`, async () => {
    let finishSlow;
    const slow = new Promise(resolve => { finishSlow = resolve; });
    const started = [];
    let slowFinished = false;
    const disk = await createDiskHarness({ commands: {
      'plugin:event|listen': () => 1,
      'plugin:event|unlisten': () => null,
      comfyui_watch_progress: () => null,
      comfyui_submit_job: () => 'prompt-id',
      comfyui_poll_job: () => ({ status: 'done', outputFiles: [
        { filename: 'fast.png', subfolder: '' }, { filename: 'slow.png', subfolder: '' },
      ] }),
      comfyui_download_output: async ({ filename, workspaceDir, projectDestination }) => {
        started.push(filename);
        if (filename === 'fast.png' && firstFails) throw new Error('fast output failed');
        if (filename === 'slow.png') await slow;
        const path = `${workspaceDir}/images-generees/${projectDestination.folder}/${filename}`;
        await fs.writeFile(path, filename);
        if (filename === 'slow.png') slowFinished = true;
        return path;
      },
    } });
    const previousInterval = globalThis.setInterval;
    const previousClear = globalThis.clearInterval;
    const previousTransform = window.__TAURI_INTERNALS__.transformCallback;
    const timers = new Set();
    globalThis.setInterval = callback => { timers.add(callback); return callback; };
    globalThis.clearInterval = callback => timers.delete(callback);
    window.__TAURI_INTERNALS__.transformCallback = () => 1;
    let app; let polling; let transaction;
    try {
      let store;
      const created = [];
      app = runner(() => {
        store = useSdStore();
        useSDJobs(store, disk.workspace, path => created.push(path));
      });
      app.render(); app.flush();
      const project = { projectName: 'Azuro', storage: createProjectStorage() };
      const mediaOutput = await captureProjectMediaJob({ root: disk.workspace, storage: project.storage, ephemeral: false });
      store.addJob('workflow', 'Images', {}, { mediaOutput });
      for (let i = 0; i < 5 && timers.size === 0; i++) {
        app.render(); app.flush(); await settle();
      }
      assert.equal(timers.size, 1);
      const tick = [...timers][0];
      polling = tick();
      await settle(); app.render();
      assert.deepEqual(started, ['fast.png', 'slow.png']);
      assert.equal(slowFinished, false);
      assert.equal(store.jobs[0].status, 'running', 'no terminal state while a native output is unfinished');
      assert.equal(isProjectMediaOutputBusy(project.storage.workId), true);
      const deferred = await prepareProjectStorageSave({ project, root: disk.workspace });
      assert.equal(deferred.deferred, true);
      assert.equal(deferred.project.storage.provisional, true);
      assert.equal(disk.countCalls('rename_project_folder'), 0);
      finishSlow();
      await polling; app.render();
      assert.equal(slowFinished, true);
      assert.equal(isProjectMediaOutputBusy(project.storage.workId), false);
      assert.equal(store.jobs[0].status, firstFails ? 'error' : 'done');
      if (firstFails) {
        assert.match(store.jobs[0].errorMessage, /fast output failed/);
        assert.deepEqual(created, []);
      } else {
        assert.deepEqual(store.jobs[0].resultPaths, ['fast.png', 'slow.png'].map(filename => `${disk.workspace}/images-generees/Projet sans titre/${filename}`));
        assert.deepEqual(created, store.jobs[0].resultPaths);
      }
      transaction = await prepareProjectStorageSave({ project, root: disk.workspace });
      assert.equal(transaction.deferred, false);
      assert.equal(transaction.finalized, true);
      assert.equal(await disk.exists(`${disk.workspace}/images-generees/Azuro/slow.png`), true);
    } finally {
      finishSlow();
      await polling;
      await transaction?.rollback();
      transaction?.release();
      app?.unmount();
      globalThis.setInterval = previousInterval;
      globalThis.clearInterval = previousClear;
      window.__TAURI_INTERNALS__.transformCallback = previousTransform;
      await disk.dispose();
    }
  });
}
