// Le titre d'un épisode garde sa ponctuation ; seul un titre vide reprend
// le nom du fichier, nettoyé par le téléchargeur.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { runner } from './reactHookDriver.mjs';
import { createDiskHarness } from './tauriDiskHarness.mjs';

const { useProjectStore } = await import('../src/store/projectStore.js');
const { useMediaTransferHandlers } = await import('../src/hooks/useMediaTransferHandlers.js');
const { useImportSession } = await import('../src/hooks/useImportSession.js');
const { buildProjectIndex } = await import('../src/store/projectModel.js');
const noop = () => {};

const TITLE = "L'ogre, la fée et l'enfant (épisode 3)";
// Nom rendu par le téléchargeur pour ce titre : règle de `sanitize_stem`
// (test Rust `sanitize_stem_handles_bad_chars_and_length`).
const DOWNLOADED = 'L_ogre_ la fée et l_enfant _épisode 3_.mp3';

for (const source of ['podcast', 'youtube']) {
  for (const title of [TITLE, '', '   ']) {
    test(`une histoire importée (${source}, titre ${JSON.stringify(title)}) porte le titre ou le nom du fichier`, async () => {
      const disk = await createDiskHarness({ commands: {
        download_podcast_media: () => disk.dir('cache', DOWNLOADED),
        download_youtube_audio: () => disk.dir('cache', DOWNLOADED),
      } });
      try {
        await disk.mkdirp('cache');
        await fs.writeFile(disk.dir('cache', DOWNLOADED), 'audio');
        let store; let imports;
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
            addPathsToMediaLibrary: noop,
          });
        });
        app.render(); store.setProjectType('pack'); store.updateProjectName('Contes'); app.render();
        const result = await imports.handleImportMediaEpisodes(
          [{ id: 'one', title, audioUrl: 'https://example.invalid/audio' }],
          { title: 'Flux' },
          { source, suppressDialog: true, targetMenuId: null },
        );
        app.render();
        assert.equal(result.imported, 1);
        const stories = store.project.rootEntries.filter((entry) => entry.type === 'story');
        assert.equal(stories.length, 1);
        if (title === TITLE) assert.equal(stories[0].name, TITLE);
        else assert.equal(stories[0].name, 'L ogre la fée et l enfant épisode 3');
        store.undo();
        app.render();
        assert.equal(store.project.rootEntries.length, 0, 'un seul Annuler retire l’histoire et son nom');
        store.redo();
        app.render();
        assert.equal(store.project.rootEntries[0].name, stories[0].name);
      } finally { await disk.dispose(); }
    });
  }
}
