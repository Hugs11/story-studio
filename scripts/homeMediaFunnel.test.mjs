import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { runner, useRef } from './reactHookDriver.mjs';
import { createDiskHarness } from './tauriDiskHarness.mjs';

const { useProjectStore } = await import('../src/store/projectStore.js');
const { useWorkSession } = await import('../src/hooks/useWorkSession.js');
const { useMediaImport } = await import('../src/hooks/useMediaImport.js');
const { useMediaTransferHandlers } = await import('../src/hooks/useMediaTransferHandlers.js');
const { authoringWorkspaceMode } = await import('../src/store/projectWorkState.js');
const { buildProjectIndex } = await import('../src/store/projectModel.js');
const { createWorkSnapshot } = await import('../src/store/projectHelpers.js');
const { mediaOutputWorkspaceDir } = await import('../src/store/workspaceDirs.js');
// Exécuter le câblage réel de l'hôte : sa ref média est distincte de la ref
// mise à jour synchroniquement par useWorkSession (le premier test l'omettait).
const host = await fs.readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
const start = host.indexOf('  const mediaWorkspaceDir =');
const end = host.indexOf('  const preferredExportWorkspaceDir =', start);
assert.ok(start >= 0 && end > start);
const wireMedia = new Function('useRef', 'mediaOutputWorkspaceDir', 'sessionMode', 'sessionWorkspaceDir', 'configuredWorkspaceDir', 'store',
  `${host.slice(start, end)}\nreturn { mediaWorkspaceDirRef, mediaStorageRef };`);
const noop = () => {};
const ref = current => ({ current });

for (const source of ['youtube', 'podcast']) {
  for (const [cover, count, failure = false, changedAt = null] of [
    [false, 1], [true, 1], [false, 2], [true, 2], [true, 1, true],
    [true, 1, false, 'cover'], [false, 1, false, 'audio'],
  ]) {
    test(`Accueil ${source}, ${count} épisode(s), couverture=${cover}, échec=${failure}, changement=${changedAt}: ${changedAt ? 'abandon signalé sans toucher au nouveau projet' : failure ? 'erreur propagée et retour accueil' : 'téléchargement et histoires dans les menus'}`, async () => {
      let disk;
      let app;
      let store; let session; let media;
      const render = () => { app.render(); app.flush(); };
      const downloads = [];
      const cleanups = [];
      const copies = [];
      disk = await createDiskHarness({ commands: {
        list_session_recoveries: async () => [],
        cleanup_session_workspace: async ({ path }) => { cleanups.push(path); },
        'plugin:window|scale_factor': async () => 1,
        'plugin:event|listen': async () => 1,
        'plugin:event|unlisten': async () => {},
        create_session_workspace: async () => {
          const dir = await disk.mkdirp('session');
          render();
          return dir;
        },
        download_youtube_audio: async args => {
          downloads.push(args.videoUrl);
          render();
          if (failure) throw new Error('download failed');
          return disk.dir('cache/audio.mp3');
        },
        download_podcast_media: async args => {
          downloads.push(args.url);
          render();
          if (failure && args.url.endsWith('.mp3')) throw new Error('download failed');
          return disk.dir(args.url.endsWith('.jpg') ? 'cache/cover.jpg' : 'cache/audio.mp3');
        },
      } });
      window.__TAURI_INTERNALS__.metadata = { currentWindow: { label: 'main' } };
      window.__TAURI_INTERNALS__.transformCallback = () => 1;
      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: noop };
      try {
        await disk.mkdirp('cache');
        await fs.writeFile(disk.dir('cache/audio.mp3'), 'audio');
        await fs.writeFile(disk.dir('cache/cover.jpg'), 'image');
        const workspaceDirRef = ref(disk.workspace);
        const savedSnapshotRef = ref(null);
        const autoSavePathRef = ref(null);
        const autoSaveSnapshotRef = ref(null);
        const importedPackPendingMetaRef = ref(false);
        app = runner(() => {
          store = useProjectStore();
          session = useWorkSession({
            store, savedSnapshotRef, workspaceDirRef, autoSavePathRef, autoSaveSnapshotRef,
            importedPackPendingMetaRef, mediaLibraryPaths: [], mediaTags: {},
            mediaLibraryCountRef: ref(0), currentWorkSnapshot: createWorkSnapshot(store.project, [], {}),
            configuredWorkspaceDir: disk.workspace, useWorkspaceForNewProjects: false,
            setAutoSavedPath: noop, setConfiguredWorkspaceDir: noop, setWorkspaceDirState: noop,
          });
          const { mediaWorkspaceDirRef, mediaStorageRef } = wireMedia(useRef, mediaOutputWorkspaceDir,
            session.sessionMode, session.sessionWorkspaceDir, disk.workspace, store);
          const transfers = useMediaTransferHandlers({
            store, workspaceDirRef: mediaWorkspaceDirRef, mediaStorageRef, sessionModeRef: session.sessionModeRef,
            copyImportedFilesEnabled: true, workspaceDir: mediaWorkspaceDirRef.current,
            savePathRef: ref(null), setWorkspaceDirState: noop, setSaveToast: noop,
          });
          media = useMediaImport({
            store, workspaceDirRef: mediaWorkspaceDirRef, mediaStorageRef, sessionModeRef: session.sessionModeRef,
            importedPackPendingMetaRef, runFunnelLanding: session.runFunnelLanding,
            projectIndex: buildProjectIndex(store.project), ...transfers,
            copyGeneratedMediaToProject: async (path, options) => {
              copies.push(options.mediaStorage.root);
              const copied = await transfers.copyGeneratedMediaToProject(path, options);
              if (changedAt === (path.endsWith('.jpg') ? 'cover' : 'audio')) {
                session.resetWorkSession();
                store.resetProject();
                store.setProjectType('pack');
                store.setProject(project => ({ ...project, projectName: 'Autre projet' }));
                render();
              }
              return copied;
            },
            extractAudioEmbeddedImage: async () => null, addPathsToMediaLibrary: noop,
            setImportNotice: noop, setActiveDropZone: noop, showErrorDialog: assert.fail,
          });
        });
        render();
        assert.equal(authoringWorkspaceMode(store.project), null);
        const epoch = store.workEpochRef.current;
        const list = { title: 'Histoires', ...(cover ? { imageUrl: 'https://example.com/cover.jpg' } : {}) };
        const items = Array.from({ length: count }, (_, index) => ({ id: String(index + 1), title: `Episode ${index + 1}`, audioUrl: `https://example.com/${index + 1}.mp3`, audioLanguage: 'fr' }));
        const importing = media[source === 'youtube' ? 'handleYoutubeFunnelImport' : 'handlePodcastFunnelImport'](items, list);
        if (changedAt) {
          await assert.rejects(importing, error => {
            assert.equal(error.code, 'IMPORT_PROJECT_CHANGED');
            assert.equal(error.presentationRef.key, 'import:media.import.projectChanged');
            assert.match(error.message, /import.*interrompu/i);
            return true;
          });
          render();
          await session.ephemeralSnapshotSeedStateRef.current.writeChain;
          assert.equal(store.project.projectName, 'Autre projet');
          assert.equal(store.project.rootEntries.length, 0);
          assert.deepEqual(cleanups, [], 'ne pas abandonner la session du nouveau projet');
          if (changedAt === 'cover') assert.deepEqual(downloads, [list.imageUrl]);
          return;
        }
        if (failure) {
          await assert.rejects(importing, { code: 'IMPORT_MEDIA_BATCH_FAILED' });
          render();
          await session.ephemeralSnapshotSeedStateRef.current.writeChain;
          assert.equal(authoringWorkspaceMode(store.project), null);
          assert.equal(session.sessionModeRef.current, null);
          assert.deepEqual(cleanups, [disk.dir('session')]);
          return;
        }
        await importing;
        render();
        assert.equal(store.workEpochRef.current, epoch, 'aucun resetProject/loadProject pendant l’atterrissage');
        await session.ephemeralSnapshotSeedStateRef.current.writeChain;
        assert.equal(session.sessionModeRef.current, 'ephemeral');
        assert.equal(workspaceDirRef.current, disk.dir('session'));
        assert.equal(store.project.projectType, 'pack');
        assert.equal(authoringWorkspaceMode(store.project), 'hierarchical');
        assert.equal(store.project.rootEntries.length, count);
        assert.equal(store.project.rootName, 'Histoires');
        assert.equal(store.project.projectName, list.title);
        assert.deepEqual(store.project.rootEntries.map(story => story.name), items.map(item => item.title));
        assert.ok(copies.length > 0 && copies.every(root => root === disk.dir('session')),
          'toutes les copies utilisent la destination installée, même avant le rendu App');
        assert.deepEqual(cleanups, []);
        assert.deepEqual(downloads.filter(url => url.endsWith('.mp3')), items.map(item => item.audioUrl));
        for (const story of store.project.rootEntries) {
          assert.equal(story.type, 'story');
          assert.equal(await fs.readFile(story.audio, 'utf8'), 'audio');
          assert.ok(story.audio.replaceAll('\\', '/').startsWith(disk.dir('session')));
        }
      } finally { app?.unmount(); await disk.dispose(); }
    });
  }
}
