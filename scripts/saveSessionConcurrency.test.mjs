// Concurrence entre une écriture lente et le travail qui continue.
//
// Les hooks `useSaveProgress` et `useWorkSession` sont importés **intacts** et
// exécutés sur le vrai `useProjectStore`, le vrai `projectIO` et de vrais
// fichiers temporaires. Les seuls doubles sont l'ordonnanceur React, la WebView,
// les dialogues et le relais IPC ; les commandes `plugin:fs|*` écrivent sur le
// disque. Une barrière suspend le `rename` qui remplace le fichier, ce qui
// laisse le test muter le travail, le catalogue ou la session pendant l'écriture
// — exactement la fenêtre dans laquelle trois pertes ont été mesurées.
//
// Chaque scénario affirme une conservation, jamais une perte : une mutation
// survivante et non déclarée enregistrée, un catalogue préservé, une session
// intacte. Un fichier valide devient toujours le chemin courant.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { runner } from './reactHookDriver.mjs';
import { createDiskHarness } from './tauriDiskHarness.mjs';

const { useSaveProgress } = await import('../src/hooks/useSaveProgress.js');
const { useWorkSession } = await import('../src/hooks/useWorkSession.js');
const { useProjectStore } = await import('../src/store/projectStore.js');
const { createAdvancedProject, withEditorState } = await import('../src/store/projectModel/authoring.js');
const { createWorkSnapshot } = await import('../src/store/projectHelpers.js');
const { KEYS } = await import('../src/store/persistentSettings.js');

const PAYLOAD = '{"payloadVersion":1,"document":{"stageNodes":[],"actionNodes":[]},'
  + '"context":{"documentOrigin":"created","defaultValueOrigin":"authored"}}';

const noop = () => {};
const ref = (current) => ({ current });
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

// Suspend le remplacement atomique du fichier : l'écriture est engagée, le
// travail continue, et rien n'est publié tant que `release` n'est pas appelé.
function suspendFileReplacement() {
  const entered = deferred();
  const release = deferred();
  const base = window.__TAURI_INTERNALS__.invoke;
  window.__TAURI_INTERNALS__.invoke = async (cmd, ...rest) => {
    if (cmd === 'plugin:fs|rename') {
      entered.resolve();
      await release.promise;
    }
    return base(cmd, ...rest);
  };
  return { entered: entered.promise, release: () => release.resolve() };
}

async function withHooks(run) {
  const harness = await createDiskHarness();
  harness.settings.setItem(KEYS.WORKSPACE_DIR, harness.workspace);
  try {
    const storeRunner = runner(() => useProjectStore());
    let store = storeRunner.render();
    store.loadProject(createAdvancedProject({ payload: PAYLOAD, projectName: 'auteur' }));
    store = storeRunner.render();
    const refs = {
      workspaceDirRef: ref(harness.workspace),
      mediaLibraryPathsRef: ref([]),
      savedSnapshotRef: ref(null),
      autoSaveSnapshotRef: ref(null),
      isSavingRef: ref(false),
    };
    const props = {
      ...refs,
      setMediaLibraryPaths: (value) => { refs.mediaLibraryPathsRef.current = value; },
      setSaveToast: noop,
      setRecentProjects: noop,
      autoSaveEnabled: true,
      autoSaveBackupLimit: 5,
      maybeOfferTransferIntoProject: async (project) => ({ project, changed: false }),
    };
    const savesRunner = runner(() => useSaveProgress({ ...props, store }));
    let api = savesRunner.render();
    const context = {
      harness,
      refs,
      props,
      get store() { return store; },
      get api() { return api; },
      render() {
        store = storeRunner.render();
        api = savesRunner.render();
        return { store, api };
      },
    };
    await run(context);
  } finally {
    await harness.dispose();
  }
}

test('un instantané ne réinstalle pas un projet antérieur à une mutation', async () => {
  await withHooks(async (c) => {
    const path = c.harness.dir('snapshot.mbah');
    const barrier = suspendFileReplacement();
    const pending = c.api.persistProjectSnapshot(c.store.project, path);
    await barrier.entered;

    c.store.setProject((project) => withEditorState(project, { version: 1, viewport: { x: 517 } }));
    c.render();
    barrier.release();
    assert.equal(await pending, path);
    c.render();

    assert.equal(
      c.store.project.authoring.editorState.viewport.x,
      517,
      'la mutation survenue pendant l’écriture reste en mémoire',
    );
    assert.notEqual(
      createWorkSnapshot(c.store.project, c.refs.mediaLibraryPathsRef.current, c.store.mediaTags),
      c.refs.savedSnapshotRef.current,
      'elle n’est pas déclarée enregistrée',
    );
    assert.equal(c.store.savePath, path, 'le fichier écrit devient bien le chemin courant');
    const written = JSON.parse(await fs.readFile(path, 'utf8'));
    assert.equal(written.authoring.editorState.viewport, undefined, 'le fichier porte l’état écrit');
  });
});

test('un instantané dont le projet a été remplacé ne publie rien', async () => {
  await withHooks(async (c) => {
    const path = c.harness.dir('remplace.mbah');
    const barrier = suspendFileReplacement();
    const pending = c.api.persistProjectSnapshot(c.store.project, path);
    await barrier.entered;

    c.store.loadProject(createAdvancedProject({ payload: PAYLOAD, projectName: 'suivant' }));
    c.render();
    barrier.release();
    await pending;
    c.render();

    assert.equal(c.store.project.projectName, 'suivant');
    assert.equal(c.store.savePath, null, 'le chemin écrit n’est pas attribué au projet installé');
    assert.equal(c.refs.savedSnapshotRef.current, null);
  });
});

test('un instantané qui porte le travail courant l’installe et le déclare enregistré', async () => {
  await withHooks(async (c) => {
    const path = c.harness.dir('courant.mbah');
    await c.api.persistProjectSnapshot(c.store.project, path);
    c.render();

    assert.equal(c.store.savePath, path);
    assert.equal(
      createWorkSnapshot(c.store.project, c.refs.mediaLibraryPathsRef.current, c.store.mediaTags),
      c.refs.savedSnapshotRef.current,
      'la mémoire est exactement ce qui vient d’être écrit',
    );
  });
});

test('une copie sous ne réinstalle pas un catalogue périmé sur un média ajouté', async () => {
  await withHooks(async (c) => {
    const ancien = await c.harness.writeFile('ancien.wav', 'ancien');
    const nouveau = await c.harness.writeFile('nouveau.wav', 'nouveau');
    c.refs.mediaLibraryPathsRef.current = [ancien];
    c.harness.answerSave(c.harness.dir('copie.mbah'));

    const barrier = suspendFileReplacement();
    const pending = c.api.handleSaveProjectAs();
    await barrier.entered;

    c.refs.mediaLibraryPathsRef.current = [ancien, nouveau];
    c.render();
    barrier.release();
    await pending;
    c.render();

    assert.ok(
      c.refs.mediaLibraryPathsRef.current.includes(nouveau),
      'le média ajouté pendant l’écriture reste au catalogue',
    );
    assert.notEqual(
      createWorkSnapshot(c.store.project, c.refs.mediaLibraryPathsRef.current, c.store.mediaTags),
      c.refs.savedSnapshotRef.current,
      'et le travail reste non enregistré, puisque le fichier ne le porte pas',
    );
  });
});

test('un enregistrement explicite préserve une mutation concurrente', async () => {
  await withHooks(async (c) => {
    c.store.setSavePath(c.harness.dir('explicite.mbah'));
    c.render();
    const barrier = suspendFileReplacement();
    const pending = c.api.handleSaveProject();
    await barrier.entered;

    c.store.setProject((project) => withEditorState(project, { version: 1, viewport: { x: 712 } }));
    c.render();
    barrier.release();
    await pending;
    c.render();

    assert.equal(c.store.project.authoring.editorState.viewport.x, 712);
    assert.notEqual(
      createWorkSnapshot(c.store.project, [], {}),
      c.refs.savedSnapshotRef.current,
    );
  });
});

test('une copie sous terminée dans une autre session ne promeut ni ne nettoie celle-ci', async () => {
  await withHooks(async (c) => {
    const sessionA = await c.harness.mkdirp('session-a');
    const sessionB = await c.harness.mkdirp('session-b');
    const fichierB = await c.harness.writeFile('session-b/unique.wav', 'travail B');
    let nextSession = sessionA;
    const base = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (cmd, args, ...rest) => {
      if (cmd === 'create_session_workspace') return nextSession;
      if (cmd === 'list_session_recoveries') return [];
      if (cmd === 'cleanup_session_workspace') {
        await fs.rm(args.path, { recursive: true, force: true });
        return null;
      }
      return base(cmd, args, ...rest);
    };

    const sessionsRunner = runner(() => useWorkSession({
      store: c.store,
      sdStore: { clearDone: noop },
      xttsStore: { clearDone: noop },
      showErrorDialog: noop,
      useWorkspaceForNewProjects: false,
      configuredWorkspaceDir: c.harness.workspace,
      setConfiguredWorkspaceDir: noop,
      setWorkspaceDirState: noop,
      workspaceDirRef: c.refs.workspaceDirRef,
      savedSnapshotRef: c.refs.savedSnapshotRef,
      autoSavePathRef: ref(null),
      autoSaveSnapshotRef: c.refs.autoSaveSnapshotRef,
      setAutoSavedPath: noop,
      setMediaLibraryPaths: noop,
      mediaLibraryCountRef: ref(0),
      mediaLibraryPaths: [],
      mediaTags: {},
      currentWorkSnapshot: null,
      importedPackPendingMetaRef: ref(false),
    }));

    c.store.resetProject();
    c.render();
    let session = sessionsRunner.render();
    sessionsRunner.flush();
    await nextTurn();

    // Session A : le projet à copier sous.
    await session.prepareNewWorkSession(null);
    session = sessionsRunner.render();
    sessionsRunner.flush();
    await nextTurn();
    c.store.loadProject(createAdvancedProject({ payload: PAYLOAD, projectName: 'A' }));
    c.render();
    // Même câblage que `App.jsx` : la promotion n'est pas réimplémentée ici.
    c.props.captureWorkSession = session.captureWorkSession;
    c.props.isWorkSessionCurrent = session.isWorkSessionCurrent;
    c.props.onProjectSaved = async (result, options = {}) => {
      if (!options.promote) return;
      await session.promoteSessionToProject({
        session: options.session,
        isPublicationCurrent: options.isPublicationCurrent,
        project: result?.project ?? null,
        workspaceDir: options.workspaceDir,
        cleanupSession: options.cleanupSession,
      });
    };
    c.render();
    c.harness.answerSave(c.harness.dir('a.mbah'));

    const barrier = suspendFileReplacement();
    const pending = c.api.handleSaveProjectAs();
    await barrier.entered;

    // Session B pendant l'écriture : nouveau travail, nouveau dossier, un
    // média qui ne vit que là.
    c.store.resetProject();
    c.render();
    session = sessionsRunner.render();
    nextSession = sessionB;
    await session.prepareNewWorkSession(null);
    session = sessionsRunner.render();
    sessionsRunner.flush();
    await nextTurn();
    c.store.loadProject(createAdvancedProject({
      payload: PAYLOAD,
      projectName: 'B',
      mediaBindings: [{ assetRef: 'b.wav', path: fichierB, status: 'resolved' }],
    }));
    c.render();

    barrier.release();
    await pending;
    c.render();
    session = sessionsRunner.render();

    assert.equal(await c.harness.exists(fichierB), true, 'le média unique de B survit');
    assert.equal(await c.harness.exists(sessionB), true, 'le dossier de B n’est pas supprimé');
    assert.equal(c.store.project.projectName, 'B', 'le travail B reste en mémoire');
    assert.equal(session.sessionMode, 'ephemeral', 'B reste une session éphémère');
    assert.equal(session.sessionWorkspaceDir, sessionB, 'et garde son dossier');
    assert.equal(session.sessionModeRef.current, 'ephemeral');
    assert.equal(await c.harness.exists(c.harness.dir('a.mbah')), true,
      'la copie de A est bien écrite : seule la promotion est refusée');
  });
});

for (const moment of ['après le tri', 'pendant le contrôle des dépendances', 'aucune mutation']) {
  test(`promotion de la même session : ${moment}`, async () => withHooks(async (c) => {
    const { withMediaBindings } = await import('../src/store/projectModel/authoring.js');
    const io = await import('../src/store/projectIO.js');
    const { FICHIERS_IMPORTES } = await import('../src/store/workspaceDirs.js');
    const { useSessionMediaTriage } = await import('../src/hooks/useSessionMediaTriage.js');
    const sessionA = await c.harness.mkdirp('session-a');
    const oldFile = await c.harness.writeFile('session-a/initial.wav', 'INITIAL');
    const newFile = c.harness.dir('session-a/late.wav');
    const invoke = window.__TAURI_INTERNALS__.invoke;
    let cleanups = 0;
    window.__TAURI_INTERNALS__.invoke = async (cmd, args, ...rest) => {
      if (cmd === 'create_session_workspace') return sessionA;
      if (cmd === 'list_session_recoveries') return [];
      if (cmd === 'cleanup_session_workspace') {
        cleanups++;
        await fs.rm(args.path, { recursive: true, force: true });
        return null;
      }
      return invoke(cmd, args, ...rest);
    };
    const sessions = runner(() => useWorkSession({
      store: c.store,
      sdStore: { clearDone: noop },
      xttsStore: { clearDone: noop },
      showErrorDialog: noop,
      useWorkspaceForNewProjects: false,
      configuredWorkspaceDir: c.harness.workspace,
      setConfiguredWorkspaceDir: noop,
      setWorkspaceDirState: noop,
      workspaceDirRef: c.refs.workspaceDirRef,
      savedSnapshotRef: c.refs.savedSnapshotRef,
      autoSavePathRef: ref(null),
      autoSaveSnapshotRef: c.refs.autoSaveSnapshotRef,
      setAutoSavedPath: noop,
      setMediaLibraryPaths: noop,
      mediaLibraryCountRef: ref(0),
      mediaLibraryPaths: [],
      mediaTags: {},
      currentWorkSnapshot: null,
      importedPackPendingMetaRef: ref(false),
    }));
    c.store.resetProject();
    c.render();
    let session = sessions.render();
    sessions.flush();
    await nextTurn();
    await session.prepareNewWorkSession(null);
    session = sessions.render();
    sessions.flush();
    await nextTurn();
    c.store.loadProject(createAdvancedProject({
      payload: PAYLOAD,
      projectName: 'A',
      mediaBindings: [{ assetRef: 'initial.wav', path: oldFile, status: 'resolved' }],
    }));
    c.render();
    c.props.captureWorkSession = session.captureWorkSession;
    c.props.isWorkSessionCurrent = session.isWorkSessionCurrent;
    const addBinding = () => {
      c.store.setProject((project) => withMediaBindings(project, [
        ...project.authoring.mediaBindings,
        { assetRef: 'late.wav', path: newFile, status: 'resolved' },
      ]));
      c.render();
    };
    c.props.onProjectSaved = async (result, options = {}) => {
      if (!options.promote) return;
      const promotion = session.promoteSessionToProject({
        session: options.session,
        isPublicationCurrent: options.isPublicationCurrent,
        project: result.project,
        workspaceDir: options.workspaceDir,
        cleanupSession: options.cleanupSession,
      });
      // Le contrôle de dépendances rend la main : une mutation peut arriver
      // après l'acceptation initiale, avant l'autorisation de supprimer.
      if (moment === 'pendant le contrôle des dépendances') addBinding();
      await promotion;
    };
    c.props.maybeOfferTransferIntoProject = async (project, path, options) => {
      const result = await io.transferProjectFilesToProject(project, path,
        (source) => io.copyMediaToWorkspace(source, options.targetWorkspaceDir, FICHIERS_IMPORTES, 'A'));
      return { ...result, changed: result.copiedCount > 0 };
    };
    const triages = runner(() => useSessionMediaTriage({
      store: c.store,
      mediaLibraryPathsRef: c.refs.mediaLibraryPathsRef,
      setMediaLibraryPaths: c.props.setMediaLibraryPaths,
      showChoiceDialog: () => { throw Error('Aucun choix attendu'); },
    }));
    let triageDone = false;
    const triage = triages.render();
    c.props.triageSessionMedia = async (options) => {
      const result = await triage.triageSessionMedia(options);
      triageDone = true;
      return result;
    };
    c.render();
    await c.harness.mkdirp('projet');
    const path = c.harness.dir('projet/a.mbah');
    c.harness.answerSave(path);
    const entered = deferred();
    const release = deferred();
    const base = window.__TAURI_INTERNALS__.invoke;
    // Suspendre l'écriture du fichier du projet, qui vient après le tri : une
    // copie sous éphémère n'écrit qu'une fois, ses médias une fois copiés.
    window.__TAURI_INTERNALS__.invoke = async (cmd, ...args) => {
      if (cmd === 'plugin:fs|rename' && args[0]?.newPath === path) {
        entered.resolve();
        await release.promise;
      }
      return base(cmd, ...args);
    };
    const promise = c.api.handleSaveProjectAs();
    await entered.promise;
    assert.equal(triageDone, true, 'le tri de production a déjà fini');
    await fs.writeFile(newFile, 'NOUVEAU UNIQUE');
    if (moment === 'après le tri') addBinding();
    release.resolve();
    assert.equal(await promise, path);
    c.render();
    const changed = moment !== 'aucune mutation';
    assert.equal(cleanups, changed ? 0 : 1);
    assert.equal(await c.harness.exists(newFile), changed, 'un média récemment lié doit survivre');
    assert.equal(session.sessionModeRef.current, changed ? 'ephemeral' : 'project');
    const snapshot = createWorkSnapshot(c.store.project, c.refs.mediaLibraryPathsRef.current, c.store.mediaTags);
    if (changed) {
      assert.equal(await fs.readFile(newFile, 'utf8'), 'NOUVEAU UNIQUE');
      assert.notEqual(c.refs.savedSnapshotRef.current, snapshot);
    } else {
      assert.equal(await fs.readFile(c.store.project.authoring.mediaBindings[0].path, 'utf8'), 'INITIAL');
      assert.equal(c.refs.mediaLibraryPathsRef.current.includes(oldFile), false,
        'le catalogue ne garde pas l’ancienne adresse après transfert');
      assert.equal(c.refs.savedSnapshotRef.current, snapshot);
    }
  }));
}

for (const changeSession of [false, true]) {
  test(`tri suspendu : ${changeSession ? 'préserve la nouvelle session' : 'préserve les nouveaux tags'}`, async () => {
    await withHooks(async (c) => {
      const { useSessionMediaTriage } = await import('../src/hooks/useSessionMediaTriage.js');
      const original = await c.harness.writeFile('session-tri/ancien.wav', 'ancien');
      const added = await c.harness.writeFile('session-suivante/nouveau.wav', 'nouveau');
      const sessionDir = c.harness.dir('session-tri');
      let current = true;
      c.refs.mediaLibraryPathsRef.current = [original];
      c.store.setMediaTags({ [original]: ['ancien'] });
      c.render();
      const triages = runner(() => useSessionMediaTriage({
        store: c.store,
        mediaLibraryPathsRef: c.refs.mediaLibraryPathsRef,
        setMediaLibraryPaths: c.props.setMediaLibraryPaths,
        showChoiceDialog: noop,
      }));
      let triage = triages.render();
      const pending = triage.triageSessionMedia({
        project: c.store.project,
        sessionDir,
        targetWorkspaceDir: c.harness.workspace,
        isSessionCurrent: () => current,
      });
      triage = triages.render();
      assert.equal(triage.triageRequest.items.length, 1);
      const { resolve } = triage.triageRequest;
      current = !changeSession;
      c.refs.mediaLibraryPathsRef.current = changeSession ? [added] : [original, added];
      c.store.setMediaTags({ [original]: ['ancien'], [added]: ['nouveau'] });
      c.render();
      triages.render();
      resolve({ keptPaths: [original] });
      await pending;
      c.render();
      assert.ok(c.refs.mediaLibraryPathsRef.current.includes(added));
      assert.deepEqual(c.store.mediaTags[added], ['nouveau']);
      if (changeSession) {
        assert.deepEqual(c.refs.mediaLibraryPathsRef.current, [added]);
        assert.deepEqual(c.store.mediaTags[original], ['ancien']);
      } else {
        assert.equal(c.store.mediaTags[original], undefined);
        const copied = c.refs.mediaLibraryPathsRef.current.find((path) => path !== added);
        assert.equal(await fs.readFile(copied, 'utf8'), 'ancien');
        assert.deepEqual(c.store.mediaTags[copied], ['ancien']);
      }
    });
  });
}

// Une copie sous depuis une session éphémère n'écrit son fichier qu'une fois
// les médias copiés. Un transfert incomplet abandonne l'opération : aucun
// fichier ne doit désigner le dossier de session, et un fichier que l'auteur
// avait choisi d'écraser reste intact.
for (const existing of [false, true]) {
  test(`copie sous éphémère abandonnée : ${existing ? 'le fichier écrasé reste intact' : 'aucun fichier écrit'}`, async () => withHooks(async (c) => {
    const sessionA = await c.harness.mkdirp('session-a');
    const target = c.harness.dir('copie.mbah');
    if (existing) await c.harness.writeFile('copie.mbah', 'ANCIEN PROJET');
    const base = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (cmd, args, ...rest) => {
      if (cmd === 'create_session_workspace') return sessionA;
      if (cmd === 'list_session_recoveries') return [];
      if (cmd === 'cleanup_session_workspace') return null;
      return base(cmd, args, ...rest);
    };
    const sessionsRunner = runner(() => useWorkSession({
      store: c.store,
      sdStore: { clearDone: noop },
      xttsStore: { clearDone: noop },
      showErrorDialog: noop,
      useWorkspaceForNewProjects: false,
      configuredWorkspaceDir: c.harness.workspace,
      setConfiguredWorkspaceDir: noop,
      setWorkspaceDirState: noop,
      workspaceDirRef: c.refs.workspaceDirRef,
      savedSnapshotRef: c.refs.savedSnapshotRef,
      autoSavePathRef: ref(null),
      autoSaveSnapshotRef: c.refs.autoSaveSnapshotRef,
      setAutoSavedPath: noop,
      setMediaLibraryPaths: noop,
      mediaLibraryCountRef: ref(0),
      mediaLibraryPaths: [],
      mediaTags: {},
      currentWorkSnapshot: null,
      importedPackPendingMetaRef: ref(false),
    }));
    c.store.resetProject();
    c.render();
    let session = sessionsRunner.render();
    sessionsRunner.flush();
    await nextTurn();
    await session.prepareNewWorkSession(null);
    session = sessionsRunner.render();
    sessionsRunner.flush();
    await nextTurn();
    c.store.loadProject(createAdvancedProject({ payload: PAYLOAD, projectName: 'A' }));
    c.render();
    c.props.captureWorkSession = session.captureWorkSession;
    c.props.isWorkSessionCurrent = session.isWorkSessionCurrent;
    c.props.maybeOfferTransferIntoProject = async (project) => ({
      project,
      changed: false,
      copies: [],
      errors: [{ label: 'Image bibliothèque', error: 'forbidden path' }],
    });
    c.render();
    c.harness.answerSave(target);

    const saved = await c.api.handleSaveProjectAs();

    assert.equal(saved, null, 'l’opération est abandonnée');
    if (existing) {
      assert.equal(await fs.readFile(target, 'utf8'), 'ANCIEN PROJET', 'le fichier écrasé reste intact');
    } else {
      assert.equal(await c.harness.exists(target), false, 'aucun fichier n’est posé');
    }
    assert.equal(session.sessionModeRef.current, 'ephemeral', 'la session reste éphémère');
    assert.equal(await c.harness.exists(sessionA), true, 'et garde son dossier');
  }));
}

// Une opération qui ne pose pas son fichier ne laisse aucune copie derrière
// elle : ni images temporaires copiées d'avance, ni médias transférés avant
// une erreur, ni copies d'une écriture qui échoue. Une copie que l'état en
// mémoire a reprise reste, elle, à sa place.
const { FICHIERS_IMPORTES, IMAGES_GENEREES } = await import('../src/store/workspaceDirs.js');
const io = await import('../src/store/projectIO.js');

async function managedCopies(c) {
  const found = [];
  for (const category of [IMAGES_GENEREES, FICHIERS_IMPORTES]) {
    const entries = await fs.readdir(`${c.harness.workspace}/${category}`, { withFileTypes: true })
      .catch(() => []);
    found.push(...entries.filter((entry) => entry.isFile()).map((entry) => `${category}/${entry.name}`));
  }
  return found;
}

async function openEphemeralSession(c, project) {
  const sessionDir = await c.harness.mkdirp('session-a');
  const base = window.__TAURI_INTERNALS__.invoke;
  window.__TAURI_INTERNALS__.invoke = async (cmd, args, ...rest) => {
    if (cmd === 'create_session_workspace') return sessionDir;
    if (cmd === 'list_session_recoveries') return [];
    if (cmd === 'cleanup_session_workspace') return null;
    return base(cmd, args, ...rest);
  };
  const sessionsRunner = runner(() => useWorkSession({
    store: c.store,
    sdStore: { clearDone: noop },
    xttsStore: { clearDone: noop },
    showErrorDialog: noop,
    useWorkspaceForNewProjects: false,
    configuredWorkspaceDir: c.harness.workspace,
    setConfiguredWorkspaceDir: noop,
    setWorkspaceDirState: noop,
    workspaceDirRef: c.refs.workspaceDirRef,
    savedSnapshotRef: c.refs.savedSnapshotRef,
    autoSavePathRef: ref(null),
    autoSaveSnapshotRef: c.refs.autoSaveSnapshotRef,
    setAutoSavedPath: noop,
    setMediaLibraryPaths: noop,
    mediaLibraryCountRef: ref(0),
    mediaLibraryPaths: [],
    mediaTags: {},
    currentWorkSnapshot: null,
    importedPackPendingMetaRef: ref(false),
  }));
  c.store.resetProject();
  c.render();
  let session = sessionsRunner.render();
  sessionsRunner.flush();
  await nextTurn();
  await session.prepareNewWorkSession(null);
  session = sessionsRunner.render();
  sessionsRunner.flush();
  await nextTurn();
  c.store.loadProject(project);
  c.render();
  c.props.captureWorkSession = session.captureWorkSession;
  c.props.isWorkSessionCurrent = session.isWorkSessionCurrent;
  c.props.maybeOfferTransferIntoProject = async (current, path, options) => {
    const result = await io.transferProjectFilesToProject(current, path,
      (source) => io.copyMediaToWorkspace(source, options.targetWorkspaceDir, FICHIERS_IMPORTES, 'A'));
    return { ...result, changed: result.copiedCount > 0 };
  };
  c.render();
  return { sessionDir, session: () => sessionsRunner.render() };
}

async function projectWithTempImageAndMedia(c) {
  // Le fichier cible vit dans son propre dossier : la session n'y est pas.
  await c.harness.mkdirp('projet');
  const vignette = await c.harness.writeFile('cache/story_studio_images/vignette.png', 'PNG');
  const un = await c.harness.writeFile('session-a/un.wav', 'UN');
  const deux = await c.harness.writeFile('session-a/deux.wav', 'DEUX');
  return {
    vignette,
    un,
    project: createAdvancedProject({
      payload: PAYLOAD,
      projectName: 'A',
      thumbnailImage: vignette,
      mediaBindings: [
        { assetRef: 'un.wav', path: un, status: 'resolved' },
        { assetRef: 'deux.wav', path: deux, status: 'resolved' },
      ],
    }),
  };
}

test('copie sous éphémère abandonnée : aucune copie ne reste, image ni média transféré', async () => withHooks(async (c) => {
  const { vignette, project } = await projectWithTempImageAndMedia(c);
  const { session } = await openEphemeralSession(c, project);
  c.harness.injectFailure({ cmd: 'plugin:fs|copy_file', match: 'deux.wav', message: 'forbidden path' });
  c.harness.answerSave(c.harness.dir('projet/copie.mbah'));

  const saved = await c.api.handleSaveProjectAs();

  assert.equal(saved, null, 'l’opération est abandonnée');
  assert.deepEqual(await managedCopies(c), [],
    'ni l’image temporaire ni le média copié avant l’erreur ne restent');
  assert.equal(await c.harness.exists(vignette), true, 'l’image temporaire d’origine reste en place');
  assert.equal(session().sessionModeRef.current, 'ephemeral');
}));

test('copie sous éphémère dont l’écriture échoue : aucune copie ne reste', async () => withHooks(async (c) => {
  const { project } = await projectWithTempImageAndMedia(c);
  await openEphemeralSession(c, project);
  const dialogs = [];
  c.props.showErrorDialog = (dialog) => dialogs.push(dialog);
  c.render();
  const target = c.harness.dir('projet/copie.mbah');
  c.harness.injectFailure({ cmd: 'plugin:fs|write_text_file', match: 'copie.mbah' });
  c.harness.answerSave(target);

  const saved = await c.api.handleSaveProjectAs();

  assert.equal(saved, null);
  assert.equal(c.harness.countCalls('plugin:fs|copy_file'), 3, 'l’image et les deux médias ont été copiés');
  assert.equal(await c.harness.exists(target), false, 'aucun fichier n’est posé');
  assert.deepEqual(await managedCopies(c), [], 'les copies faites pour ce fichier sont retirées');
  assert.equal(dialogs.at(-1)?.title, 'Enregistrement impossible');
}));

test('copie sous éphémère dont l’écriture échoue : une copie reprise par le catalogue reste', async () => withHooks(async (c) => {
  const { project } = await projectWithTempImageAndMedia(c);
  await openEphemeralSession(c, project);
  // Le tri re-pointe le catalogue en mémoire vers les copies du transfert :
  // l'état vivant les désigne, les retirer le casserait.
  c.props.triageSessionMedia = async ({ transferCopies }) => {
    const mediaLibraryPaths = transferCopies.map(({ to }) => to);
    c.refs.mediaLibraryPathsRef.current = mediaLibraryPaths;
    return { changed: true, mediaLibraryPaths };
  };
  c.render();
  c.harness.injectFailure({ cmd: 'plugin:fs|write_text_file', match: 'copie.mbah' });
  c.harness.answerSave(c.harness.dir('projet/copie.mbah'));

  assert.equal(await c.api.handleSaveProjectAs(), null);

  const kept = c.refs.mediaLibraryPathsRef.current;
  assert.equal(kept.length, 2);
  for (const path of kept) {
    assert.equal(await c.harness.exists(path), true, 'la copie reprise par le catalogue reste');
  }
  assert.deepEqual(
    (await managedCopies(c)).filter((entry) => entry.startsWith(IMAGES_GENEREES)),
    [],
    'l’image que seul le fichier aurait désignée est retirée',
  );
}));

test('enregistrement dont l’écriture échoue : l’image temporaire copiée est retirée', async () => withHooks(async (c) => {
  const vignette = await c.harness.writeFile('cache/story_studio_images/vignette.png', 'PNG');
  c.store.loadProject(createAdvancedProject({ payload: PAYLOAD, projectName: 'A', thumbnailImage: vignette }));
  c.store.setSavePath(c.harness.dir('projet.mbah'));
  const dialogs = [];
  c.props.showErrorDialog = (dialog) => dialogs.push(dialog);
  c.render();
  c.harness.injectFailure({ cmd: 'plugin:fs|write_text_file', match: 'projet.mbah' });

  assert.equal(await c.api.handleSaveProject(), null);

  assert.deepEqual(await managedCopies(c), []);
  assert.equal(await c.harness.exists(vignette), true);
  assert.equal(c.store.project.thumbnailImage, vignette, 'le projet garde son image temporaire');
  assert.equal(dialogs.at(-1)?.title, 'Enregistrement impossible');
}));

test('la promotion attend l’instantané parti pendant le contrôle des dépendances', async () => withHooks(async (c) => {
  // Relevé dans l'application : après « Enregistrer comme projet », un
  // instantané anti-crash créait son fichier temporaire dans le dossier de
  // session que la promotion venait de supprimer — « Aucun fichier ou dossier ».
  // Il était parti pendant le contrôle des dépendances, quand la session
  // semblait encore éphémère.
  const { withMediaBindings } = await import('../src/store/projectModel/authoring.js');
  const sessionA = await c.harness.mkdirp('session-a');
  const absent = c.harness.dir('session-a/absent.wav');
  const base = window.__TAURI_INTERNALS__.invoke;
  let cleanups = 0;
  let pauseCheck = null;
  let holdSnapshot = null;
  window.__TAURI_INTERNALS__.invoke = async (cmd, args, ...rest) => {
    if (cmd === 'create_session_workspace') return sessionA;
    if (cmd === 'list_session_recoveries') return [];
    if (cmd === 'cleanup_session_workspace') {
      cleanups++;
      await fs.rm(args.path, { recursive: true, force: true });
      return null;
    }
    if (cmd === 'plugin:fs|exists' && pauseCheck && String(args?.path).endsWith('absent.wav')) {
      const pause = pauseCheck;
      pauseCheck = null;
      pause.entered.resolve();
      await pause.release.promise;
    }
    if (cmd === 'plugin:fs|rename' && holdSnapshot
      && String(args?.newPath).endsWith('.session-recovery.mbah')) {
      const hold = holdSnapshot;
      holdSnapshot = null;
      hold.entered.resolve();
      await hold.release.promise;
    }
    return base(cmd, args, ...rest);
  };

  let workSnapshot = 'avant';
  const sessions = runner(() => useWorkSession({
    store: c.store,
    sdStore: { clearDone: noop },
    xttsStore: { clearDone: noop },
    showErrorDialog: noop,
    useWorkspaceForNewProjects: false,
    configuredWorkspaceDir: c.harness.workspace,
    setConfiguredWorkspaceDir: noop,
    setWorkspaceDirState: noop,
    workspaceDirRef: c.refs.workspaceDirRef,
    savedSnapshotRef: c.refs.savedSnapshotRef,
    autoSavePathRef: ref(null),
    autoSaveSnapshotRef: c.refs.autoSaveSnapshotRef,
    setAutoSavedPath: noop,
    setMediaLibraryPaths: noop,
    mediaLibraryCountRef: ref(0),
    mediaLibraryPaths: [],
    mediaTags: {},
    currentWorkSnapshot: workSnapshot,
    importedPackPendingMetaRef: ref(false),
  }));
  let session = sessions.render();
  sessions.flush();
  await nextTurn();
  await session.prepareNewWorkSession(null, { applyProjectType: false });
  // Un média lié dans la session, déjà sorti du disque : le contrôle des
  // dépendances l'interroge, puis autorise la suppression.
  c.store.setProject((project) => withMediaBindings(project, [
    { assetRef: 'absent.wav', path: absent, status: 'resolved' },
  ]));
  c.render();
  session = sessions.render();
  sessions.flush();
  // Le premier instantané de la session se termine avant la promotion.
  const snapshotPath = c.harness.dir('session-a/.session-recovery.mbah');
  for (let turn = 0; turn < 200 && !(await c.harness.exists(snapshotPath)); turn++) await nextTurn();
  assert.equal(await c.harness.exists(snapshotPath), true, 'le premier instantané est écrit');

  pauseCheck = { entered: deferred(), release: deferred() };
  const checking = pauseCheck;
  const promotion = session.promoteSessionToProject({
    session: session.captureWorkSession(),
    isPublicationCurrent: () => true,
    project: c.store.project,
  });
  await checking.entered.promise;

  // Pendant le contrôle, le travail change : un instantané part, et il reste
  // suspendu au moment de remplacer son fichier.
  holdSnapshot = { entered: deferred(), release: deferred() };
  const held = holdSnapshot;
  workSnapshot = 'pendant';
  c.store.setProject((project) => withEditorState(project, { version: 1, viewport: { x: 42 } }));
  c.render();
  session = sessions.render();
  sessions.flush();
  await held.entered.promise;

  checking.release.resolve();
  for (let turn = 0; turn < 20; turn++) await nextTurn();
  assert.equal(cleanups, 0, 'le dossier n’est pas supprimé sous un instantané en vol');
  assert.equal(await c.harness.exists(sessionA), true);

  held.release.resolve();
  await promotion;
  assert.equal(cleanups, 1, 'la session est nettoyée une fois l’instantané terminé');
  assert.equal(await c.harness.exists(sessionA), false);
  assert.equal(session.sessionModeRef.current, 'project');
}));

// Destination des médias d'un projet enregistré, option « Utiliser un
// workspace pour les nouveaux projets » désactivée (réglage par défaut) et
// `.mbah` rangé hors de l'emplacement de travail : les médias vont dans
// l'emplacement de travail, jamais dans des sous-dossiers à côté du `.mbah`.
async function managedDirsBeside(c, projectDirName) {
  const found = [];
  for (const category of [IMAGES_GENEREES, FICHIERS_IMPORTES]) {
    if (await c.harness.exists(c.harness.dir(projectDirName, category))) found.push(category);
  }
  return found;
}

test('premier enregistrement d’une session : médias et image vont dans l’emplacement de travail', async () => withHooks(async (c) => {
  const { vignette, un, project } = await projectWithTempImageAndMedia(c);
  await openEphemeralSession(c, project);
  const target = c.harness.dir('projet/copie.mbah');
  c.harness.answerSave(target);

  assert.equal(await c.api.handleSaveProjectAs(), target);

  const copies = await managedCopies(c);
  assert.equal(copies.filter((entry) => entry.startsWith(`${FICHIERS_IMPORTES}/`)).length, 2,
    'les deux médias de session sont dans <workspace>/fichiers-importes');
  assert.equal(copies.filter((entry) => entry.startsWith(`${IMAGES_GENEREES}/`)).length, 1,
    'l’image temporaire est dans <workspace>/images-generees');
  assert.deepEqual(await managedDirsBeside(c, 'projet'), [],
    'aucun sous-dossier géré n’est créé à côté du .mbah');
  const written = await fs.readFile(target, 'utf8');
  for (const source of [vignette, un]) {
    assert.equal(written.includes(source.split('/').pop()), true);
  }
  assert.equal(/\.\/(fichiers-importes|images-generees)\//.test(written), false,
    'le fichier ne désigne aucun média relatif au dossier du .mbah');
}));

test('enregistrement en place d’un projet hors workspace : l’image temporaire va dans l’emplacement de travail', async () => withHooks(async (c) => {
  await c.harness.mkdirp('projet');
  const vignette = await c.harness.writeFile('cache/story_studio_images/vignette.png', 'PNG');
  c.store.loadProject(createAdvancedProject({ payload: PAYLOAD, projectName: 'A', thumbnailImage: vignette }));
  c.store.setSavePath(c.harness.dir('projet/projet.mbah'));
  c.render();

  assert.equal(await c.api.handleSaveProject(), c.harness.dir('projet/projet.mbah'));

  const copies = await managedCopies(c);
  assert.equal(copies.length, 1, 'une seule copie, dans l’emplacement de travail');
  assert.equal(copies[0].startsWith(`${IMAGES_GENEREES}/`), true);
  c.render();
  const { pathKey } = await import('../src/utils/fileUtils.js');
  assert.equal(pathKey(c.store.project.thumbnailImage).startsWith(pathKey(c.harness.workspace)), true,
    'le projet désigne la copie de l’emplacement de travail');
  assert.deepEqual(await managedDirsBeside(c, 'projet'), []);
}));
