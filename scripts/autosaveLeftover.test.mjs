// Régression : nettoyage de la copie automatique d'un nouveau projet.
//
// Option « Utiliser l'emplacement de travail pour les nouveaux projets » : un
// nouveau projet jamais enregistré reçoit, à l'échéance de l'enregistrement
// automatique (5 min), une copie `sauvegardes/<nom>_<date>.mbah`
// (`useAutosave` → `autoSaveNewProject`). Quand l'auteur enregistre ensuite son
// projet ou le quitte volontairement, cette copie doit être retirée.
//
// Store, sauvegarde, session et `projectIO` intacts, sur de vrais fichiers.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { runner } from './reactHookDriver.mjs';
import { createDiskHarness } from './tauriDiskHarness.mjs';

const { useProjectStore } = await import('../src/store/projectStore.js');
const { useSaveProgress } = await import('../src/hooks/useSaveProgress.js');
const { useWorkSession } = await import('../src/hooks/useWorkSession.js');
const { useProjectLifecycle } = await import('../src/hooks/useProjectLifecycle.js');
const { useProjectLoading } = await import('../src/hooks/useProjectLoading.js');
const { askSaveBeforeLeave } = await import('../src/hooks/saveBeforeLeave.js');
const { autoSaveNewProject, discardProjectAutosave } = await import('../src/store/projectIO.js');
const { normalizeProjectData } = await import('../src/store/projectModel.js');
const { decideAutosaveAction, AUTOSAVE_ACTIONS } = await import('../src/store/autosaveDecision.js');
const { createWorkSnapshot } = await import('../src/store/projectHelpers.js');
const { KEYS } = await import('../src/store/persistentSettings.js');

const noop = () => {};
const ref = (current) => ({ current });

test('après « Enregistrer », la copie automatique d’un nouveau projet ne reste pas dans sauvegardes/', async () => {
  const harness = await createDiskHarness({ commands: { list_session_recoveries: () => [] } });
  try {
    harness.settings.setItem(KEYS.WORKSPACE_DIR, harness.workspace);
    const storeRunner = runner(() => useProjectStore());
    let store = storeRunner.render();
    const refs = {
      workspaceDirRef: ref(harness.workspace), mediaLibraryPathsRef: ref([]), savedSnapshotRef: ref(null),
      autoSavePathRef: ref(null), autoSaveSnapshotRef: ref(null), isSavingRef: ref(false),
      mediaLibraryCountRef: ref(0), importedPackPendingMetaRef: ref(false),
    };
    const sessions = runner(() => useWorkSession({
      ...refs, store,
      sdStore: { clearDone: noop }, xttsStore: { clearDone: noop }, showErrorDialog: noop,
      useWorkspaceForNewProjects: true, configuredWorkspaceDir: harness.workspace,
      setConfiguredWorkspaceDir: noop, setWorkspaceDirState: noop, setAutoSavedPath: noop, setMediaLibraryPaths: noop,
      mediaLibraryPaths: [], mediaTags: {}, currentWorkSnapshot: null,
    }));
    let session = sessions.render();
    await session.prepareNewWorkSession(null, { applyProjectType: false });
    session = sessions.render();
    const audio = await harness.writeFile('ailleurs/histoire.wav', 'audio');
    store.loadProject(normalizeProjectData({
      projectType: 'pack', projectName: 'Mon projet',
      // Comme `setProjectType` à la création : l'identité existe dès le départ.
      packMetadata: { uuid: '55555555-5555-4555-8555-555555555555' },
      rootEntries: [{ id: 's1', type: 'story', name: 'Histoire', audio }],
    }));
    store = storeRunner.render();

    // Échéance de l'enregistrement automatique : la décision réelle, puis
    // l'écriture qu'elle commande (corps de `useAutosave`).
    const action = decideAutosaveAction({
      currentSnapshot: createWorkSnapshot(store.project, [], {}), savedSnapshot: null, isDirty: true,
      savePath: null, workspaceDir: harness.workspace, autoSavePath: null, sessionMode: 'project',
    });
    assert.equal(action.kind, AUTOSAVE_ACTIONS.AUTOSAVE_NEW);
    const automatic = await autoSaveNewProject(store.project, action.workspaceDir, { backupLimit: 0 });
    refs.autoSavePathRef.current = automatic.path;
    assert.match(automatic.path.replace(/\\/g, '/'), /\/sauvegardes\/mon-projet_[^/]+\.mbah$/);

    // L'auteur enregistre son projet.
    const saves = runner(() => useSaveProgress({
      ...refs, store, useWorkspaceForNewProjects: true, configuredWorkspaceDir: harness.workspace,
      setMediaLibraryPaths: (value) => { refs.mediaLibraryPathsRef.current = value; },
      setSaveToast: noop, setRecentProjects: noop, autoSaveEnabled: true, autoSaveBackupLimit: 0,
      // Médias hors de l'emplacement de travail, copie désactivée : rien à transférer.
      maybeOfferTransferIntoProject: async (project) => ({ project, changed: false, copies: [], errors: [] }),
      captureWorkSession: session.captureWorkSession, isWorkSessionCurrent: session.isWorkSessionCurrent,
      onProjectSaved: async (result, opts) => {
        store = storeRunner.render();
        session = sessions.render();
        if (opts?.promote) await session.promoteSessionToProject({ ...opts, project: result.project });
      },
    }));
    const api = saves.render();
    const explicit = harness.dir('workspace', 'sauvegardes', 'Mon projet.mbah');
    harness.answerSave(explicit);
    assert.ok(await api.handleSaveProjectAs(), 'le projet est enregistré');

    const projects = (await fs.readdir(harness.dir('workspace', 'sauvegardes'))).filter(name => name.endsWith('.mbah')).sort();
    const identities = await Promise.all(projects.map(async name => {
      const raw = JSON.parse(await fs.readFile(harness.dir('workspace', 'sauvegardes', name), 'utf8'));
      return `${name} uuid=${raw.packMetadata?.uuid || '(aucun)'} titre=${raw.packMetadata?.title || raw.projectName}`;
    }));
    assert.deepEqual(projects, ['Mon projet.mbah'], `un seul fichier de projet dans le dossier que suit le catalogue ; trouvé : ${identities.join(' | ')}`);
  } finally {
    await harness.dispose();
  }
});

for (const scenario of ['discard', 'pristine', 'cancel', 'remove-failed']) {
  test(`retour au catalogue : ${scenario}, seul le fichier automatique courant est visé`, async () => {
    const declarations = [];
    const harness = await createDiskHarness({ commands: {
      catalogue_begin_write: (args) => { declarations.push(args); return 'write'; },
      catalogue_finish_write: () => {},
    } });
    const storeRunner = runner(() => useProjectStore());
    let store = storeRunner.render();
    const refs = {
      workspaceDirRef: ref(harness.workspace), mediaLibraryPathsRef: ref([]), savedSnapshotRef: ref(null),
      autoSavePathRef: ref(null), autoSaveSnapshotRef: ref(null), mediaLibraryCountRef: ref(0),
      importedPackPendingMetaRef: ref(false),
    };
    const common = {
      ...refs, sdStore: { clearDone: noop }, xttsStore: { clearDone: noop },
      setMediaLibraryPaths: noop, setAutoSavedPath: noop, showErrorDialog: noop,
    };
    const sessions = runner(() => useWorkSession({
      ...common, store, useWorkspaceForNewProjects: true, configuredWorkspaceDir: harness.workspace,
      setConfiguredWorkspaceDir: noop, setWorkspaceDirState: noop,
      mediaLibraryPaths: [], mediaTags: {}, currentWorkSnapshot: null,
    }));
    let lifecycle;
    try {
      let session = sessions.render();
      await session.prepareNewWorkSession('pack');
      store.addStory(null, 'Histoire');
      store = storeRunner.render();
      session = sessions.render();
      const automatic = await autoSaveNewProject(store.project, harness.workspace, { backupLimit: 0 });
      refs.autoSavePathRef.current = automatic.path;
      const other = await harness.writeFile('workspace/sauvegardes/autre-projet.mbah', 'autre projet');
      const declarationCount = declarations.length;
      if (scenario === 'remove-failed') {
        harness.injectFailure({ cmd: 'plugin:fs|remove', match: automatic.path });
      }
      let questions = 0;
      let opened = false;
      lifecycle = runner(() => useProjectLifecycle({
        ...common, store, setImportNotice: noop, handleSave: () => assert.fail('aucun enregistrement attendu'),
        resetWorkSession: session.resetWorkSession,
        onOpenCatalogue: () => { opened = true; },
        askSaveBeforeLeaveCurrent: async onSave => {
          const canLeave = await askSaveBeforeLeave(() => ({
            project: store.project, savePath: null, savedSnapshot: null,
            mediaLibraryPaths: [], mediaTags: {}, pristine: scenario === 'pristine',
          }), onSave, async () => { questions++; return scenario === 'cancel' ? 'cancel' : 'discard'; });
          if (canLeave) await session.cleanupEphemeralSession();
          return canLeave;
        },
      }));
      const api = lifecycle.render();
      assert.equal(await api.handleReturnToCatalogue(), scenario !== 'cancel');
      assert.equal(opened, scenario !== 'cancel');
      assert.equal(questions, scenario === 'pristine' ? 0 : 1);
      assert.equal(await harness.exists(automatic.path), ['cancel', 'remove-failed'].includes(scenario));
      assert.equal(refs.autoSavePathRef.current, scenario === 'cancel' ? automatic.path : null);
      assert.equal(await harness.readFile(other), 'autre projet', 'un autre fichier de sauvegardes reste intact');
      assert.deepEqual(declarations.slice(declarationCount), scenario === 'cancel' ? [] : [
        { kind: 'projectSave', paths: [automatic.path], temporaries: [], subtrees: [] },
      ]);
      const removals = harness.calls.filter(call => call.cmd === 'plugin:fs|remove');
      assert.deepEqual(removals.map(call => call.target), scenario === 'cancel' ? [] : [automatic.path]);
    } finally {
      lifecycle?.unmount();
      sessions.unmount();
      storeRunner.unmount();
      await harness.dispose();
    }
  });
}

for (const source of ['path', 'dialog']) {
  test(`ouvrir la copie automatique (${source}) puis abandonner conserve le fichier ouvert`, async () => {
    const harness = await createDiskHarness({ commands: { list_session_recoveries: () => [] } });
    const storeRunner = runner(() => useProjectStore());
    let store = storeRunner.render();
    const refs = {
      workspaceDirRef: ref(harness.workspace), savedSnapshotRef: ref(null),
      autoSavePathRef: ref(null), autoSaveSnapshotRef: ref(null), mediaLibraryCountRef: ref(0),
      importedPackPendingMetaRef: ref(false),
    };
    const common = {
      ...refs, sdStore: { clearDone: noop }, xttsStore: { clearDone: noop },
      setMediaLibraryPaths: noop, setAutoSavedPath: noop,
      showErrorDialog: error => assert.fail(JSON.stringify(error)),
    };
    const sessions = runner(() => useWorkSession({
      ...common, store, useWorkspaceForNewProjects: true, configuredWorkspaceDir: harness.workspace,
      setConfiguredWorkspaceDir: noop, setWorkspaceDirState: noop,
      mediaLibraryPaths: [], mediaTags: {}, currentWorkSnapshot: null,
    }));
    let loading;
    try {
      let session = sessions.render();
      await session.prepareNewWorkSession('pack');
      store.addStory(null, 'Histoire à conserver');
      store = storeRunner.render();
      session = sessions.render();
      const automatic = await autoSaveNewProject(store.project, harness.workspace, { backupLimit: 0 });
      refs.autoSavePathRef.current = automatic.path;
      const content = await harness.readFile(automatic.path);
      let questions = 0;
      loading = runner(() => useProjectLoading({
        ...common, store, setRecentProjects: noop,
        handleSaveProject: () => assert.fail('aucun enregistrement attendu'),
        confirmSaveBeforeLeaveCurrent: onSave => askSaveBeforeLeave(() => ({
          project: store.project, savePath: null, savedSnapshot: null,
          mediaLibraryPaths: [], mediaTags: {}, pristine: false,
        }), onSave, async () => { questions++; return 'discard'; }),
        onBeforeProjectReplaced: session.cleanupEphemeralSession,
        onProjectLoaded: session.enterProjectMode,
      }));
      const api = loading.render();
      if (source === 'dialog') {
        harness.answerOpen(automatic.path);
        await api.handleLoad();
      } else {
        assert.equal(await api.openProjectFromPath(automatic.path), true);
      }
      store = storeRunner.render();
      assert.equal(questions, 1);
      assert.equal(store.savePath, automatic.path);
      assert.equal(await harness.readFile(automatic.path), content, 'le contenu ouvert reste sur disque');
      assert.equal(harness.countCalls('plugin:fs|remove'), 0);
      assert.equal(refs.autoSavePathRef.current, null);
    } finally {
      loading?.unmount();
      sessions.unmount();
      storeRunner.unmount();
      await harness.dispose();
    }
  });
}

test('enregistrer sur le chemin de la copie automatique conserve le fichier enregistré', async () => {
  const harness = await createDiskHarness();
  try {
    const path = await harness.writeFile('workspace/sauvegardes/projet.mbah', 'enregistrement manuel');
    await discardProjectAutosave(path, path);
    assert.equal(await harness.readFile(path), 'enregistrement manuel');
    assert.equal(harness.countCalls('plugin:fs|remove'), 0);
  } finally {
    await harness.dispose();
  }
});
