// Ordre des écritures du fichier de reprise d'une session éphémère.
//
// Deux producteurs écrivent le même fichier : l'instantané immédiat de
// `useWorkSession` (à chaque nouvelle signature) et la tick périodique de
// `useAutosave`. Hooks, store, `projectIO` et fichiers réels ; seuls le minuteur
// (tick appelée à la main) et l'ordre des réponses disque (premier `rename`
// retenu) sont contrôlés.
//
// Attendu : une vieille tick lente ne remplace jamais un instantané plus récent,
// sur le disque comme dans l'état de référence.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { runner } from './reactHookDriver.mjs';
import { createDiskHarness } from './tauriDiskHarness.mjs';

const { useProjectStore } = await import('../src/store/projectStore.js');
const { useWorkSession } = await import('../src/hooks/useWorkSession.js');
const { useAutosave } = await import('../src/hooks/useAutosave.js');
const { createWorkSnapshot } = await import('../src/store/projectHelpers.js');
const { normalizeProjectData } = await import('../src/store/projectModel.js');

const noop = () => {};
const ref = (current) => ({ current });
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

async function readName(path) {
  try {
    return JSON.parse(await fs.readFile(path, 'utf8')).projectName;
  } catch {
    return null;
  }
}

async function waitFor(check) {
  for (let i = 0; i < 100; i += 1) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

test('une tick périodique ancienne ne remplace pas l’instantané immédiat plus récent', async () => {
  let sessionDir;
  const harness = await createDiskHarness({
    commands: {
      list_session_recoveries: () => [],
      create_session_workspace: async () => { sessionDir = await harness.mkdirp('session'); return sessionDir; },
    },
  });
  let tick;
  const setIntervalOriginal = globalThis.setInterval;
  const clearIntervalOriginal = globalThis.clearInterval;
  globalThis.setInterval = (callback) => { tick = callback; return 1; };
  globalThis.clearInterval = noop;
  const base = window.__TAURI_INTERNALS__.invoke;
  try {
    const storeRunner = runner(() => useProjectStore());
    let store = storeRunner.render();
    store.loadProject(normalizeProjectData({ projectType: 'pack', projectName: '', rootEntries: [] }));
    store = storeRunner.render();
    const refs = {
      workspaceDirRef: ref(''),
      savedSnapshotRef: ref(null),
      autoSavePathRef: ref(null),
      autoSaveSnapshotRef: ref(null),
      mediaLibraryCountRef: ref(0),
      importedPackPendingMetaRef: ref(false),
    };
    const props = {
      ...refs,
      sdStore: { clearDone: noop },
      xttsStore: { clearDone: noop },
      showErrorDialog: noop,
      useWorkspaceForNewProjects: false,
      configuredWorkspaceDir: harness.workspace,
      setConfiguredWorkspaceDir: noop,
      setWorkspaceDirState: noop,
      setAutoSavedPath: noop,
      setMediaLibraryPaths: noop,
      mediaLibraryPaths: [],
      mediaTags: {},
    };
    const sessions = runner(() => useWorkSession({
      ...props, store, currentWorkSnapshot: createWorkSnapshot(store.project, [], {}),
    }));
    let session = sessions.render();
    sessions.flush();
    await session.prepareNewWorkSession('pack');
    store = storeRunner.render();
    session = sessions.render();
    sessions.flush();
    store.updateProjectName('Avant');
    store = storeRunner.render();
    session = sessions.render();

    const projectRef = ref(store.project);
    const autosave = runner(() => useAutosave({
      enabled: true,
      backupLimit: 0,
      projectRef,
      savedSnapshotRef: refs.savedSnapshotRef,
      savePathRef: ref(null),
      workspaceDirRef: refs.workspaceDirRef,
      autoSavePathRef: refs.autoSavePathRef,
      autoSaveSnapshotRef: refs.autoSaveSnapshotRef,
      ephemeralSnapshotPathRef: session.ephemeralSnapshotPathRef,
      ephemeralSnapshotSeedStateRef: session.ephemeralSnapshotSeedStateRef,
      sessionModeRef: session.sessionModeRef,
      workEpochRef: store.workEpochRef,
      isSavingRef: ref(false),
      mediaTagsRef: ref({}),
      mediaLibraryPathsRef: ref([]),
      mediaLibraryCountRef: refs.mediaLibraryCountRef,
      setAutoSavedPath: noop,
      setSaveToast: noop,
      saveHandlerRef: ref(noop),
    }));
    autosave.render();
    autosave.flush();

    // La tick part du travail « Avant » ; son remplacement de fichier est retenu.
    const entered = deferred();
    const release = deferred();
    let held = false;
    window.__TAURI_INTERNALS__.invoke = async (cmd, ...rest) => {
      if (cmd === 'plugin:fs|rename' && !held) {
        held = true;
        entered.resolve();
        await release.promise;
      }
      return base(cmd, ...rest);
    };
    const periodic = tick();
    await entered.promise;

    // L'auteur poursuit : l'instantané immédiat part avec « Après ».
    store.updateProjectName('Après');
    store = storeRunner.render();
    projectRef.current = store.project;
    session = sessions.render();
    sessions.flush();
    const snapshotPath = join(sessionDir, '.session-recovery.mbah');
    // Laisse à l'instantané immédiat le temps d'aboutir s'il n'attend pas la tick.
    await waitFor(async () => (await readName(snapshotPath)) === 'Après');

    release.resolve();
    await periodic;
    await session.ephemeralSnapshotSeedStateRef.current.writeChain?.catch(() => {});
    await waitFor(async () => (await readName(snapshotPath)) === 'Après');

    assert.equal(await readName(snapshotPath), 'Après', 'le disque reste sur le travail le plus récent');
    assert.equal(
      session.ephemeralSnapshotSeedStateRef.current.savedSnapshot,
      createWorkSnapshot(store.project, [], {}),
      'l’état de référence désigne le travail le plus récent',
    );
    autosave.unmount();
    sessions.unmount();
  } finally {
    window.__TAURI_INTERNALS__.invoke = base;
    globalThis.setInterval = setIntervalOriginal;
    globalThis.clearInterval = clearIntervalOriginal;
    await harness.dispose();
  }
});
