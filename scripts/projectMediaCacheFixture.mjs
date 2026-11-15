// Fixtures disque créées par les vrais hooks/I/O, sans profil ni réseau.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { runner } from './reactHookDriver.mjs';
import { createDiskHarness } from './tauriDiskHarness.mjs';

const io = await import('../src/store/projectIO.js');
const { normalizeProjectData, buildProjectIndex } = await import('../src/store/projectModel.js');
const { useProjectStore } = await import('../src/store/projectStore.js');
const { useMediaTransferHandlers } = await import('../src/hooks/useMediaTransferHandlers.js');
const { useImportSession } = await import('../src/hooks/useImportSession.js');
const { useSaveProgress } = await import('../src/hooks/useSaveProgress.js');
const { KEYS } = await import('../src/store/persistentSettings.js');
const noop = () => {};

export async function createCacheFixture(root, kind) {
  const workspace = `${root}/workspace`;
  const cache = `${root}/cache`;
  const media = kind === 'recovery'
    ? `${cache}/story_studio_images/metadata_123.png`
    : `${cache}/podcast-media/episode.mp3`;
  const disk = await createDiskHarness({ commands: {
    download_podcast_media: async () => media,
    extract_audio_embedded_image: async () => media,
  } });
  let app;
  try {
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(media.slice(0, media.lastIndexOf('/')), { recursive: true });
    await fs.writeFile(media, 'media fixture');
    disk.settings.setItem(KEYS.WORKSPACE_DIR, workspace);
    let path;
    if (kind === 'recovery') {
      const session = `${cache}/sessions/story_studio_session_4242_1_0`;
      await fs.mkdir(`${session}/fichiers-importes`, { recursive: true });
      const audio = `${session}/fichiers-importes/conte.mp3`;
      await fs.writeFile(audio, 'audio fixture');
      path = `${session}/.session-recovery.mbah`;
      let store;
      let imports;
      const workspaceDirRef = { current: session };
      const sessionModeRef = { current: 'ephemeral' };
      app = runner(() => {
        store = useProjectStore();
        const transfers = useMediaTransferHandlers({ store, copyImportedFilesEnabled: false,
          sessionModeRef, workspaceDir: session, workspaceDirRef,
          savePathRef: { current: null }, setWorkspaceDirState: noop, setSaveToast: noop });
        imports = useImportSession({ store, ...transfers,
          projectIndex: buildProjectIndex(store.project), workspaceDirRef, sessionModeRef,
          setImporting: noop, showErrorDialog: noop,
          getImportDisplayName: p => p, isImportedPackPath: () => false });
      });
      app.render();
      store.loadProject(normalizeProjectData({ projectType: 'pack', projectName: 'Contes', rootEntries: [] }));
      app.render();
      await imports.dispatchFiles(null, [audio]);
      app.render();
      await io.autoSaveEphemeralProject(store.project, session, path);
    } else {
      // Projet déjà enregistré : pas de promotion de session au prochain Save.
      path = `${workspace}/sauvegardes/Contes.mbah`;
      await fs.mkdir(`${workspace}/sauvegardes`, { recursive: true });
      let store;
      let imports;
      let transfers;
      let saves;
      const libraryRef = { current: [] };
      const savedSnapshotRef = { current: null };
      const isSavingRef = { current: false };
      const autoSaveSnapshotRef = { current: null };
      app = runner(() => {
        store = useProjectStore();
        transfers = useMediaTransferHandlers({ store, copyImportedFilesEnabled: false,
          sessionModeRef: { current: 'project' }, workspaceDir: workspace,
          workspaceDirRef: { current: workspace }, savePathRef: { current: path },
          setWorkspaceDirState: noop, setSaveToast: noop });
        imports = useImportSession({ store, projectIndex: buildProjectIndex(store.project),
          ...transfers, extractAudioEmbeddedImage: async () => null,
          workspaceDirRef: { current: workspace }, sessionModeRef: { current: 'project' },
          setImporting: noop, setUnpacking: noop, setImportNotice: noop,
          showErrorDialog: noop, addPathsToMediaLibrary: noop });
        saves = useSaveProgress({ store, configuredWorkspaceDir: workspace,
          mediaLibraryPathsRef: libraryRef, setMediaLibraryPaths: value => { libraryRef.current = value; },
          autoSaveEnabled: false, autoSaveBackupLimit: 0, savedSnapshotRef, autoSaveSnapshotRef,
          isSavingRef, setSaveToast: noop, setRecentProjects: noop,
          maybeOfferTransferIntoProject: transfers.maybeOfferTransferIntoProject });
      });
      app.render();
      const retainedAudio = `${workspace}/fichiers-importes/conte.mp3`;
      await fs.mkdir(`${workspace}/fichiers-importes`, { recursive: true });
      await fs.writeFile(retainedAudio, 'existing audio');
      store.loadProject({ projectType: 'pack', projectName: 'Contes',
        rootEntries: [{ id: 'story', type: 'story', name: 'Conte', audio: retainedAudio }] });
      store.setSavePath(path);
      app.render();
      await io.saveProject(store.project, path);
      disk.injectFailure({ cmd: 'copy_project_media', message: 'ENOSPC: disque plein' });
      const result = await imports.handleImportMediaEpisodes(
        [{ id: 'one', title: 'Episode', audioUrl: 'https://fixture.invalid/episode.mp3' }],
        {}, { source: 'podcast', suppressDialog: true });
      assert.equal(result.imported, 0, 'la copie refusée ne compte pas comme un import réussi');
      assert.equal(result.failures, 1);
      assert.match(String(result.firstError), /ENOSPC/);
      app.render();
      assert.equal(store.project.rootEntries.length, 1, 'aucune histoire ajoutée après la copie refusée');
      const transfer = await transfers.maybeOfferTransferIntoProject(store.project, path);
      assert.equal(transfer.changed, false, 'option de copie désactivée : aucune nouvelle tentative');
      assert.equal(await saves.handleSaveProject(), path, 'le vrai Ctrl+S réussit');
      assert.ok(savedSnapshotRef.current, 'le travail est déclaré enregistré');
    }
    const written = JSON.parse(await fs.readFile(path, 'utf8'));
    const reference = kind === 'recovery' ? written.rootEntries[0].itemImage : written.rootEntries[0].audio;
    const durableMedia = resolve(dirname(path), reference).replaceAll('\\', '/');
    assert.notEqual(durableMedia, media, 'le fichier enregistré ne référence pas le cache purgeable');
    assert.equal(await fs.readFile(durableMedia, 'utf8'), kind === 'recovery' ? 'media fixture' : 'existing audio');
    return { cache, path, media, durableMedia };
  } finally {
    app?.unmount();
    await disk.dispose();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(JSON.stringify(await createCacheFixture(process.argv[2].replaceAll('\\', '/'), process.argv[3])));
}
