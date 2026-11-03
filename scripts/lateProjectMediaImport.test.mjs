import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { runner } from './reactHookDriver.mjs';
import { createDiskHarness } from './tauriDiskHarness.mjs';
const { useProjectStore } = await import('../src/store/projectStore.js');
const { useMediaTransferHandlers } = await import('../src/hooks/useMediaTransferHandlers.js');
const { useImportSession } = await import('../src/hooks/useImportSession.js');
const { buildProjectIndex } = await import('../src/store/projectModel.js');
const { isProjectMediaOutputBusy } = await import('../src/store/projectMediaOutput.js');
const noop = () => {};
for (const source of ['podcast', 'youtube']) {
  test(`late ${source} import writes under A and never mutates B or its catalogue`, async () => {
    let reply;
    const download = new Promise(resolve => { reply = resolve; });
    const disk = await createDiskHarness({ commands: {
      download_podcast_media: () => download, download_youtube_audio: () => download,
    } });
    try {
      await disk.mkdirp('cache');
      const sourcePath = disk.dir('cache', 'episode.mp3');
      await fs.writeFile(sourcePath, 'audio');
      let store; let imports;
      const catalogue = [];
      const workspaceDirRef = { current: disk.workspace };
      const sessionModeRef = { current: 'project' };
      const app = runner(() => {
        store = useProjectStore();
        const transfers = useMediaTransferHandlers({
          store, sessionModeRef, copyImportedFilesEnabled: true,
          workspaceDir: disk.workspace, workspaceDirRef, savePathRef: { current: null },
          setWorkspaceDirState: noop, setSaveToast: noop,
        });
        imports = useImportSession({
          store, workspaceDirRef, sessionModeRef, projectIndex: buildProjectIndex(store.project),
          ...transfers, extractAudioEmbeddedImage: async () => null,
          setImporting: noop, setUnpacking: noop, setImportNotice: noop, showErrorDialog: noop,
          addPathsToMediaLibrary: paths => catalogue.push(...paths),
        });
      });
      app.render(); store.setProjectType('pack'); store.updateProjectName('A'); app.render();
      const workId = store.project.storage.workId;
      const request = imports.handleImportMediaEpisodes([{ title: 'Episode', audioUrl: 'https://example.com/audio', id: 'one' }], {}, { source, suppressDialog: true });
      assert.equal(isProjectMediaOutputBusy(workId), true);
      store.loadProject({ projectType: 'pack', projectName: 'B', rootEntries: [] }); app.render();
      const before = structuredClone(store.project);
      reply(sourcePath);
      const result = await request; app.render();
      assert.deepEqual(store.project, before);
      assert.deepEqual(catalogue, []);
      assert.equal(result.imported, 0);
      assert.equal(isProjectMediaOutputBusy(workId), false);
      assert.equal(await disk.exists(`${disk.workspace}/fichiers-importes/Projet sans titre/episode.mp3`), true);
      const marker = JSON.parse(await fs.readFile(`${disk.workspace}/fichiers-importes/Projet sans titre/.story-studio-dossier.json`, 'utf8'));
      assert.equal(marker.workId, workId);
    } finally { await disk.dispose(); }
  });
}
