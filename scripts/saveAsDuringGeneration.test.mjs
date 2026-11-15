// Sauvegarde pendant une génération en file : conservation des médias sources.
//
// Projet par menus non enregistré : ses médias vivent dans le dossier de
// session (pack ouvert par « Modifier un pack », voix, enregistrements, imports
// podcast ou YouTube). L'auteur lance « Générer le pack » : le travail entre en
// file avec les chemins de la session (`usePackGeneration.handleGenerate`,
// `projectToRustExport`). Pendant la génération, il enregistre le projet
// (« Enregistrer comme projet ») : la promotion copie les médias dans
// l'emplacement de travail puis supprime le dossier de session, sans regarder
// la file de rendu. Le travail en file lit alors des fichiers disparus.
//
// Store, sauvegarde, session, transfert et `projectIO` intacts, sur de vrais
// fichiers (banc repris de `undoAfterPromotion.test.mjs`).
//
// L'oracle : après l'enregistrement, tout média que désigne le travail en file
// existe encore. La file n'est connue ni de `useWorkSession` ni de
// `useSaveProgress` : selon la correction (nettoyage différé tant qu'un travail
// actif cite la session, ou chemins du travail repointés), brancher la file
// dans ce banc sans changer l'attente.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { runner } from './reactHookDriver.mjs';
import { createDiskHarness } from './tauriDiskHarness.mjs';

const { useProjectStore } = await import('../src/store/projectStore.js');
const { useSaveProgress } = await import('../src/hooks/useSaveProgress.js');
const { useWorkSession } = await import('../src/hooks/useWorkSession.js');
const { useMediaTransferHandlers } = await import('../src/hooks/useMediaTransferHandlers.js');
const { normalizeProjectData, projectToRustExport } = await import('../src/store/projectModel.js');
const { isActiveStatus } = await import('../src/store/production/renderQueueWork.js');
const { useRenderQueueStore } = await import('../src/store/renderQueueStore.js');
const { captureProjectMediaJob, isProjectMediaOutputBusy } = await import('../src/store/projectMediaOutput.js');
const { KEYS } = await import('../src/store/persistentSettings.js');

const noop = () => {};
const ref = (current) => ({ current });

function jobMediaPaths(job) {
  const found = [];
  const visit = (value) => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (['audio', 'image', 'rootAudio', 'rootImage', 'itemAudio', 'itemImage'].includes(key) && typeof child === 'string' && child) found.push(child);
        else visit(child);
      }
    }
  };
  visit(JSON.parse(job.projectJson));
  return found;
}

test('enregistrer le projet pendant sa génération ne retire pas les médias du travail en file', async () => {
  let sessionDir;
  const cleanups = [];
  const harness = await createDiskHarness({
    commands: {
      list_session_recoveries: () => [],
      create_session_workspace: async () => { sessionDir = await harness.mkdirp('session'); return sessionDir; },
      cleanup_session_workspace: async ({ path }) => {
        if (resolve(path) !== resolve(sessionDir)) throw new Error('Unexpected cleanup target');
        cleanups.push(path);
        await fs.rm(resolve(path), { recursive: true, force: true });
      },
    },
  });
  try {
    harness.settings.setItem(KEYS.WORKSPACE_DIR, harness.workspace);
    const storeRunner = runner(() => useProjectStore());
    let store = storeRunner.render();
    const refs = {
      workspaceDirRef: ref(''), mediaLibraryPathsRef: ref([]), savedSnapshotRef: ref(null),
      autoSavePathRef: ref(null), autoSaveSnapshotRef: ref(null), isSavingRef: ref(false),
      mediaLibraryCountRef: ref(0), importedPackPendingMetaRef: ref(false),
    };
    const sessions = runner(() => useWorkSession({
      ...refs, store,
      sdStore: { clearDone: noop }, xttsStore: { clearDone: noop }, showErrorDialog: noop,
      useWorkspaceForNewProjects: false, configuredWorkspaceDir: harness.workspace,
      setConfiguredWorkspaceDir: noop, setWorkspaceDirState: noop, setAutoSavedPath: noop, setMediaLibraryPaths: noop,
      mediaLibraryPaths: [], mediaTags: {}, currentWorkSnapshot: null,
    }));
    let session = sessions.render();
    await session.prepareNewWorkSession(null, { applyProjectType: false });
    session = sessions.render();
    // Comme un pack extrait par « Modifier un pack » : tout est dans la session.
    const title = await harness.writeFile('session/zips-extraits/Pack/titre.wav', 'audio-titre');
    const story = await harness.writeFile('session/zips-extraits/Pack/histoire.wav', 'audio-histoire');
    store.loadProject(normalizeProjectData({
      projectType: 'pack', projectName: 'Pack', rootAudio: title,
      packMetadata: { title: 'Pack', version: 1, uuid: '33333333-3333-4333-8333-333333333333' },
      rootEntries: [{ id: 's1', type: 'story', name: 'Histoire', audio: story }],
    }));
    store = storeRunner.render();
    session = sessions.render();

    // « Générer le pack » : le travail entre en file, tel que `handleGenerate` le pose.
    const queueRunner = runner(() => useRenderQueueStore());
    const queue = queueRunner.render();
    queue.addJob({
      mediaOutput: await captureProjectMediaJob({ root: sessionDir, storage: store.project.storage, ephemeral: true }),
      id: 'job-1', createdAt: Date.now(), projectName: store.project.projectName, savePath: null,
      projectJson: JSON.stringify(projectToRustExport(store.project)), outputFolder: harness.dir('sortie'),
    });
    const job = queueRunner.render().jobs[0];
    assert.ok(isActiveStatus(job.status), 'le travail est en attente ou en cours');
    const queued = jobMediaPaths(job);
    assert.deepEqual(queued.map(existsSync), [true, true], 'les médias du travail sont lisibles au départ');

    // Pendant la génération : « Enregistrer comme projet ».
    const transfers = runner(() => useMediaTransferHandlers({
      store, copyImportedFilesEnabled: true, setCopyImportedFilesEnabled: noop,
      workspaceDir: sessionDir, setWorkspaceDirState: noop, workspaceDirRef: refs.workspaceDirRef,
      savePathRef: ref(null), pathAudit: {}, dismissedTransferPromptRef: ref(null), setSaveToast: noop,
      persistProjectSnapshotRef: ref(noop), showErrorDialog: noop, addPathsToMediaLibrary: noop,
    }));
    const transfer = transfers.render();
    const saves = runner(() => useSaveProgress({
      ...refs, store, useWorkspaceForNewProjects: false, configuredWorkspaceDir: harness.workspace,
      setMediaLibraryPaths: (value) => { refs.mediaLibraryPathsRef.current = value; },
      setSaveToast: noop, setRecentProjects: noop, autoSaveEnabled: false, autoSaveBackupLimit: 0,
      maybeOfferTransferIntoProject: transfer.maybeOfferTransferIntoProject,
      captureWorkSession: session.captureWorkSession, isWorkSessionCurrent: session.isWorkSessionCurrent,
      onProjectSaved: async (result, opts) => {
        store = storeRunner.render();
        session = sessions.render();
        if (opts.promote) await session.promoteSessionToProject({ ...opts, project: result.project });
      },
    }));
    const api = saves.render();
    await harness.mkdirp('saved');
    harness.answerSave(harness.dir('saved/project.mbah'));
    const saved = await api.handleSaveProjectAs();
    assert.ok(saved, 'le projet est enregistré');

    const missing = jobMediaPaths(job).filter(path => !existsSync(path));
    assert.deepEqual(missing, [], `le travail en file désigne des fichiers supprimés par l'enregistrement (nettoyages : ${cleanups.length})`);
    await session.cleanupEphemeralSession();
    assert.equal(cleanups.length, 0, 'un remplacement accepté conserve aussi la session lue par la file');
    queue.cancelJob(job.id);
    await session.cleanupEphemeralSession();
    assert.equal(cleanups.length, 1, 'la session peut être nettoyée après annulation du travail en attente');
  } finally {
    await harness.dispose();
  }
});

test('la réservation du rendu suit les travaux en attente et en cours jusqu’à leur état terminal', async (t) => {
  const { createProjectStorage } = await import('../src/store/projectStorage.js');
  for (const status of ['done', 'error', 'canceled']) {
    await t.test(status, async () => {
      const storage = createProjectStorage();
      const queueRunner = runner(() => useRenderQueueStore(), { doubleInvokeStateUpdaters: true });
      const queue = queueRunner.render();
      const mediaOutput = await captureProjectMediaJob({ root: '/cache/session', storage, ephemeral: true });
      const id = queue.addJob({ projectName: 'Pack', projectJson: '{}', outputFolder: '/sortie', mediaOutput });
      assert.equal(isProjectMediaOutputBusy(storage.workId), true);
      queue.updateJob(id, { status: 'running' });
      queue.cancelJob(id);
      assert.equal(isProjectMediaOutputBusy(storage.workId), true, 'demander une annulation ne libère pas les médias en cours de lecture');
      queue.appendLog(id, 'progress');
      queue.updateJob(id, { status });
      assert.equal(isProjectMediaOutputBusy(storage.workId), false);
      queue.clearDone();
      assert.equal(queueRunner.render().jobs.length, 0);
    });
  }
});

// Variante « emplacement de travail pour les nouveaux projets » : pas de
// session, mais un dossier de médias provisoire (« Projet sans titre ») que le
// premier enregistrement manuel renomme au nom du projet. Un producteur de
// médias actif diffère déjà ce renommage (`projectStorageSave.test.mjs`,
// « active producer defers first naming ») ; une génération en file, qui lit
// ces mêmes fichiers, ne le diffère pas.
test('le premier enregistrement ne renomme pas le dossier de médias que lit une génération en file', async () => {
  const { prepareProjectStorageSave } = await import('../src/store/projectStorageSave.js');
  const { createProjectStorage } = await import('../src/store/projectStorage.js');
  const from = '/workspace/enregistrements/Projet sans titre';
  const project = normalizeProjectData({
    projectType: 'pack', projectName: 'Azuro', storage: createProjectStorage(),
    packMetadata: { title: 'Azuro', version: 1, uuid: '44444444-4444-4444-8444-444444444444' },
    rootEntries: [{ id: 's1', type: 'story', name: 'Histoire', audio: `${from}/histoire.wav` }],
  });
  const queueRunner = runner(() => useRenderQueueStore());
  const queue = queueRunner.render();
  queue.addJob({
    mediaOutput: await captureProjectMediaJob({ root: '/workspace', storage: project.storage, ephemeral: true }),
    id: 'job-2', createdAt: Date.now(), projectName: project.projectName, savePath: null,
    projectJson: JSON.stringify(projectToRustExport(project)), outputFolder: '/sortie',
  });
  const job = queueRunner.render().jobs[0];
  const renamed = [];
  const transaction = await prepareProjectStorageSave({ project, root: '/workspace', path: '/workspace/sauvegardes/Azuro.mbah', invokeCommand: async (cmd, args) => {
    if (cmd === 'resolve_project_folder') return args.folder;
    renamed.push({ from, to: '/workspace/enregistrements/Azuro' });
    return renamed;
  } });
  try {
    const stale = jobMediaPaths(job).filter(path => renamed.some(move => path.startsWith(`${move.from}/`)));
    assert.deepEqual(stale, [], `le renommage n'est pas différé (deferred=${transaction.deferred}) : le travail en file lit un dossier qui n'existe plus`);
  } finally { transaction.release?.(); queue.cancelJob(job.id); }
});
