import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import './chromeBench.mjs';
import { runner } from './reactHookDriver.mjs';
import { openNotebook, closeNotebook } from './chromeBenchJsx.mjs';
import { createDiskHarness } from './tauriDiskHarness.mjs';
import { createTestI18n } from './i18nTestSetup.mjs';
import { deleteWorkspaceMediaDiskDouble } from './workspaceDeletionDiskDouble.mjs';

const { setI18n } = await import('react-i18next');
const testI18n = createTestI18n();
setI18n(testI18n);

const { ZipEditor } = await import('../src/components/editors/ZipEditor.jsx');
const { useProjectStore } = await import('../src/store/projectStore.js');
const { useWorkSession } = await import('../src/hooks/useWorkSession.js');
const { useSaveProgress } = await import('../src/hooks/useSaveProgress.js');
const { useMediaTransferHandlers } = await import('../src/hooks/useMediaTransferHandlers.js');
const { useProjectContextValue } = await import('../src/hooks/useProjectContextValue.js');
const { ProjectContext } = await import('../src/store/ProjectContext.js');
const { createWorkSnapshot } = await import('../src/store/projectHelpers.js');
const { isProjectMediaOutputBusy } = await import('../src/store/projectMediaOutput.js');
const { KEYS } = await import('../src/store/persistentSettings.js');

const noop = () => {};
const ref = current => ({ current });
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

// Composant, hooks, store et copies de production. Seuls React, les dialogues
// et l'IPC sont doublés ; le disque est réel et la promotion passe par Save As.
async function withEditor(run) {
  const cleanupEntered = deferred();
  const cleanupRelease = deferred();
  const pickerEntered = deferred();
  const pickerRelease = deferred();
  let holdPicker = false;
  let harness;
  let producedPath;
  let deletes = 0;
  harness = await createDiskHarness({ commands: {
    create_session_workspace: () => harness.mkdirp('session'),
    list_session_recoveries: async () => [],
    convert_folder_pack_to_named_zip: () => harness.writeFile('staging/.Histoire été.zip', 'archive'),
    cleanup_session_workspace: async ({ path }) => {
      if (path === harness.dir('staging')) {
        cleanupEntered.resolve();
        await cleanupRelease.promise;
      }
      await fs.rm(path, { recursive: true, force: true });
    },
    delete_workspace_media_file: async args => {
      const { path, workspaceDir } = args;
      assert.equal(path, producedPath, 'seule la sortie créée est supprimable');
      assert.equal(workspaceDir, harness.dir('session'), 'la racine capturée est conservée');
      deletes++;
      await deleteWorkspaceMediaDiskDouble(args);
    },
  } });
  const transport = window.__TAURI_INTERNALS__.invoke;
  window.__TAURI_INTERNALS__.invoke = async (command, args, ...rest) => {
    if (command === 'plugin:fs|remove' && args.path.endsWith('/.Histoire été.zip')) {
      assert.fail('le retrait du fichier caché doit passer par la commande native');
    }
    const result = await transport(command, args, ...rest);
    if (command === 'plugin:dialog|open' && holdPicker) {
      pickerEntered.resolve();
      await pickerRelease.promise;
    }
    if (command === 'copy_project_media' && args.sourcePath === harness.dir('staging/.Histoire été.zip')) {
      producedPath = result.path;
    }
    return result;
  };
  harness.settings.setItem(KEYS.WORKSPACE_DIR, harness.workspace);
  const workspaceDirRef = ref(harness.workspace);
  const mediaStorageRef = ref(null);
  const savePathRef = ref(null);
  const mediaLibraryPathsRef = ref([]);
  const savedSnapshotRef = ref(null);
  const autoSaveSnapshotRef = ref(null);
  const isSavingRef = ref(false);
  const promotions = [];
  let store;
  let session;
  let saves;
  let context;
  let nodeId;
  let updates = 0;
  const app = runner(() => {
    store = useProjectStore();
    session = useWorkSession({
      store, sdStore: { clearDone: noop }, xttsStore: { clearDone: noop },
      showErrorDialog: assert.fail, useWorkspaceForNewProjects: false,
      configuredWorkspaceDir: harness.workspace, setConfiguredWorkspaceDir: noop,
      setWorkspaceDirState: noop, workspaceDirRef, savedSnapshotRef,
      autoSavePathRef: ref(null), autoSaveSnapshotRef,
      setAutoSavedPath: noop, setMediaLibraryPaths: noop,
      mediaLibraryCountRef: ref(0), mediaLibraryPaths: [], mediaTags: store.mediaTags,
      currentWorkSnapshot: createWorkSnapshot(store.project, [], store.mediaTags),
      importedPackPendingMetaRef: ref(false),
    });
    mediaStorageRef.current = {
      root: workspaceDirRef.current, storage: store.project.storage,
      ephemeral: session.sessionModeRef.current === 'ephemeral',
    };
    savePathRef.current = store.savePath;
    const transfers = useMediaTransferHandlers({
      store, mediaStorageRef, sessionModeRef: session.sessionModeRef,
      workspaceDir: workspaceDirRef.current, workspaceDirRef, savePathRef,
      setWorkspaceDirState: noop, setSaveToast: noop,
    });
    context = useProjectContextValue({
      mediaStorage: mediaStorageRef.current, project: store.project,
      keepFolderPack: transfers.keepFolderPack,
      sdStore: {}, xttsStore: {},
    });
    saves = useSaveProgress({
      store, configuredWorkspaceDir: harness.workspace,
      mediaLibraryPathsRef, setMediaLibraryPaths: next => { mediaLibraryPathsRef.current = next; },
      autoSaveEnabled: false, autoSaveBackupLimit: 0, savedSnapshotRef,
      autoSaveSnapshotRef, isSavingRef, setSaveToast: noop, setRecentProjects: noop,
      captureWorkSession: session.captureWorkSession,
      isWorkSessionCurrent: session.isWorkSessionCurrent,
      maybeOfferTransferIntoProject: async project => ({ project, changed: false }),
      onProjectSaved: async (result, options) => {
        promotions.push(options.promote);
        if (options.promote) await session.promoteSessionToProject({
          session: options.session, isPublicationCurrent: options.isPublicationCurrent,
          project: result.project, workspaceDir: options.workspaceDir,
          cleanupSession: options.cleanupSession,
        });
      },
    });
  });
  const editor = runner(() => ZipEditor({
    node: store.project.rootEntries.find(entry => entry.id === nodeId),
    onUpdate: changes => {
      assert.equal(isProjectMediaOutputBusy(store.project.storage.workId), true,
        'la réservation couvre encore l’affectation au nœud');
      updates++;
      store.updateItem(nodeId, changes);
    },
    onDelete: noop,
  }));
  const renderApp = () => { app.render(); app.flush(); };
  const renderEditor = () => {
    ProjectContext._currentValue = context;
    openNotebook();
    editor.render();
    editor.flush();
    return closeNotebook();
  };
  try {
    renderApp();
    await session.prepareNewWorkSession('pack');
    store.updateProjectName('Projet été');
    nodeId = store.addZip(null, '', 'Inclus');
    renderApp();
    await session.ephemeralSnapshotSeedStateRef.current.writeChain;
    const elements = renderEditor();
    const chooseFolder = elements.find(element => element.props.onClick
      && element.props.children === testI18n.t('tree:zip.folder.choose'));
    assert.ok(chooseFolder, 'le bouton dossier est branché');
    harness.answerOpen(harness.dir('.Histoire été'));
    await run({
      harness, workspaceDirRef, promotions, cleanupEntered, cleanupRelease,
      pickerEntered, pickerRelease,
      get store() { return store; }, get session() { return session; },
      get saves() { return saves; }, get producedPath() { return producedPath; },
      get updates() { return updates; }, get deletes() { return deletes; },
      start: () => chooseFolder.props.onClick(),
      holdPicker: () => { holdPicker = true; },
      render() { renderApp(); renderEditor(); },
    });
  } finally {
    cleanupRelease.resolve();
    pickerRelease.resolve();
    editor.unmount();
    app.unmount();
    await session.ephemeralSnapshotSeedStateRef.current.writeChain;
    await harness.dispose();
  }
}

test('Save As pendant le nettoyage : la session reste réservée jusqu’à l’affectation du ZIP', { timeout: 15000 }, async () => {
  await withEditor(async c => {
    const workId = c.store.project.storage.workId;
    const converting = c.start();
    await c.cleanupEntered.promise;
    assert.equal(isProjectMediaOutputBusy(workId), true);
    assert.equal(await c.harness.exists(c.producedPath), true);
    c.harness.answerSave(c.harness.dir('projet.mbah'));
    assert.equal(await c.saves.handleSaveProjectAs(), c.harness.dir('projet.mbah'));
    assert.deepEqual(c.promotions, [false], 'la sauvegarde ne supprime pas la session du producteur');
    assert.equal(c.session.sessionModeRef.current, 'ephemeral');
    c.render();
    c.cleanupRelease.resolve();
    await converting;
    c.render();
    const zip = c.store.project.rootEntries.find(entry => entry.type === 'zip');
    assert.equal(zip.zipPath, c.producedPath);
    assert.equal(await c.harness.exists(zip.zipPath), true);
    assert.equal(c.updates, 1);
    assert.equal(c.deletes, 0);
    assert.equal(isProjectMediaOutputBusy(workId), false);
  });
});

test('promotion pendant le dialogue : aucune conversion dans l’ancienne destination', { timeout: 15000 }, async () => {
  await withEditor(async c => {
    const workId = c.store.project.storage.workId;
    c.holdPicker();
    const choosing = c.start();
    await c.pickerEntered.promise;
    c.harness.answerSave(c.harness.dir('avant-conversion.mbah'));
    assert.equal(await c.saves.handleSaveProjectAs(), c.harness.dir('avant-conversion.mbah'));
    assert.deepEqual(c.promotions, [true]);
    assert.equal(c.session.sessionModeRef.current, 'project');
    assert.equal(await c.harness.exists(c.harness.dir('session')), false);
    // Le composant est encore celui du rendu précédant la promotion.
    c.pickerRelease.resolve();
    await choosing;
    assert.equal(c.harness.countCalls('convert_folder_pack_to_named_zip'), 0);
    assert.equal(c.updates, 0);
    assert.equal(await c.harness.exists(c.harness.dir('session')), false);
    assert.equal(isProjectMediaOutputBusy(workId), false);
  });
});

for (const change of ['session', 'destination', 'projet']) {
  test(`changement de ${change} pendant le nettoyage : retrait natif du seul ZIP caché produit`, { timeout: 15000 }, async () => {
    await withEditor(async c => {
      const workId = c.store.project.storage.workId;
      const sibling = await c.harness.writeFile('session/fichiers-importes/.Autre.zip', 'à conserver');
      const original = await c.harness.writeFile('session/fichiers-importes/.Histoire été.original.zip', 'original préexistant');
      const original2 = await c.harness.writeFile('session/fichiers-importes/.Histoire été.original-2.zip', 'second original préexistant');
      const converting = c.start();
      await c.cleanupEntered.promise;
      if (change === 'session') c.session.sessionModeRef.current = 'project';
      if (change === 'destination') c.workspaceDirRef.current = c.harness.workspace;
      if (change === 'projet') c.store.loadProject(c.store.project);
      // Les refs et l'époque sont contrôlées même avant le prochain rendu React.
      c.cleanupRelease.resolve();
      await converting;
      assert.equal(c.updates, 0);
      assert.equal(c.deletes, 1);
      assert.equal(await c.harness.exists(c.producedPath), false);
      assert.equal(await fs.readFile(sibling, 'utf8'), 'à conserver');
      assert.equal(await fs.readFile(original, 'utf8'), 'original préexistant');
      assert.equal(await fs.readFile(original2, 'utf8'), 'second original préexistant');
      assert.equal(isProjectMediaOutputBusy(workId), false);
    });
  });
}
