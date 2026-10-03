// Annuler / rétablir après la promotion d'une session (première sauvegarde
// durable). La promotion copie les médias de session dans le projet, repointe le
// projet courant, puis supprime le dossier de session : aucune étape de
// l'historique ne doit ensuite restaurer un chemin qui n'existe plus.
//
// Store, sauvegarde, session, transfert et `projectIO` intacts, sur de vrais
// fichiers ; ordonnanceur React, dialogues et IPC doublés. La suppression de
// session est réellement exécutée, sur le seul dossier synthétique du banc.

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
const { normalizeProjectData } = await import('../src/store/projectModel.js');
const { createAdvancedProject } = await import('../src/store/projectModel/authoring.js');
const { walkProjectMediaReferences } = await import('../src/store/projectModel/index.js');
const { KEYS } = await import('../src/store/persistentSettings.js');

const PAYLOAD = '{"payloadVersion":1,"document":{"stageNodes":[],"actionNodes":[]},'
  + '"context":{"documentOrigin":"created","defaultValueOrigin":"authored"}}';
const noop = () => {};
const ref = (current) => ({ current });

function initialProject(nature, audio) {
  return nature === 'free'
    ? normalizeProjectData({ projectType: 'pack', projectName: 'Avant', rootEntries: [{ id: 's1', type: 'story', name: 'S1', audio }] })
    : createAdvancedProject({
      projectName: 'Avant',
      payload: PAYLOAD,
      mediaBindings: [{ assetRef: 'source.wav', path: audio, status: 'resolved' }],
    });
}

// Pose un second média de session puis le retire : l'historique garde une
// étape qui le désigne alors que le projet courant ne l'utilise plus.
function withExtraMedia(nature, project, audio) {
  if (nature === 'free') {
    return { ...project, rootEntries: [...project.rootEntries, { id: 's2', type: 'story', name: 'S2', audio }] };
  }
  return {
    ...project,
    authoring: {
      ...project.authoring,
      mediaBindings: [...project.authoring.mediaBindings, { assetRef: 'extra.wav', path: audio, status: 'resolved' }],
    },
  };
}

function mediaPaths(project) {
  return [...walkProjectMediaReferences(project)].map((r) => r.path).filter(Boolean);
}

async function promotedSession(nature, run, { undoBeforeSave = false } = {}) {
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
      workspaceDirRef: ref(''),
      mediaLibraryPathsRef: ref([]),
      savedSnapshotRef: ref(null),
      autoSavePathRef: ref(null),
      autoSaveSnapshotRef: ref(null),
      isSavingRef: ref(false),
      mediaLibraryCountRef: ref(0),
      importedPackPendingMetaRef: ref(false),
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
    const source = await harness.writeFile('session/fichiers-importes/source.wav', 'audio-a');
    const extra = await harness.writeFile('session/fichiers-importes/extra.wav', 'audio-b');
    store.loadProject(initialProject(nature, source));
    store = storeRunner.render();
    // Étapes d'auteur : un média ajouté puis retiré, puis un renommage.
    const base = store.project;
    store.setProject(withExtraMedia(nature, base, extra));
    store = storeRunner.render();
    store.setProject(base);
    store = storeRunner.render();
    store.updateProjectName('Après');
    store = storeRunner.render();
    if (undoBeforeSave) {
      // Enregistrer depuis un état annulé : la pile rétablir porte l'étape.
      store.undo();
      store = storeRunner.render();
    }
    session = sessions.render();

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
    const path = harness.dir('saved/project.mbah');
    harness.answerSave(path);
    await api.handleSaveProjectAs();
    store = storeRunner.render();
    await run({
      get store() { return store; },
      render: () => { store = storeRunner.render(); return store; },
      cleanups,
      source,
    });
  } finally {
    await harness.dispose();
  }
}

for (const nature of ['free', 'advanced']) {
  test(`${nature} : après promotion, annuler et rétablir ne restaurent que des médias lisibles`, async () => {
    await promotedSession(nature, async (c) => {
      assert.equal(c.cleanups.length, 1, 'la session a bien été promue et supprimée');
      assert.equal(existsSync(c.source), false);
      const current = mediaPaths(c.store.project);
      assert.ok(current.length > 0 && current.every(existsSync), 'le projet courant désigne les copies durables');
      const savedName = c.store.project.projectName;

      let undone = 0;
      while (c.store.canUndo) {
        c.store.undo();
        c.render();
        undone += 1;
        const paths = mediaPaths(c.store.project);
        assert.ok(paths.every(existsSync), `annuler n°${undone} restaure un média supprimé : ${paths.filter((p) => !existsSync(p))}`);
      }
      assert.ok(undone >= 1, 'le renommage d’après la dernière étape média reste annulable');
      assert.equal(c.store.project.projectName, 'Avant');

      let redone = 0;
      while (c.store.canRedo) {
        c.store.redo();
        c.render();
        redone += 1;
        const paths = mediaPaths(c.store.project);
        assert.ok(paths.every(existsSync), `rétablir n°${redone} restaure un média supprimé`);
      }
      assert.equal(c.store.project.projectName, savedName, 'rétablir revient au travail enregistré');
      assert.deepEqual(mediaPaths(c.store.project), current);
    });
  });
}

for (const nature of ['free', 'advanced']) {
  test(`${nature} : enregistré depuis un état annulé, rétablir reste lisible`, async () => {
    await promotedSession(nature, async (c) => {
      assert.equal(c.cleanups.length, 1);
      assert.equal(c.store.canRedo, true);
      c.store.redo();
      c.render();
      const paths = mediaPaths(c.store.project);
      assert.ok(paths.length > 0 && paths.every(existsSync), `rétablir restaure un média supprimé : ${paths}`);
      assert.equal(c.store.project.projectName, 'Après');
    }, { undoBeforeSave: true });
  });
}
