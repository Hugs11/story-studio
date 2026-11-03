// Enregistrement automatique d'un projet déjà enregistré : discret, et sûr.
//
// La boucle `useAutosave`, `useSaveProgress`, le vrai `useProjectStore` et le
// vrai `projectIO` sont importés intacts ; les fichiers sont réellement écrits
// dans un répertoire temporaire. Le gestionnaire passé à l'autosave est câblé
// comme dans `App.jsx` : `handleSave` derrière le verrou de commandes d'auteur.
// Seuls l'ordonnanceur React, l'IPC, `setInterval` (l'échéance est déclenchée
// à la main) et la proposition de transfert (qui ouvre une question) sont
// doublés.

import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWindowsPath } from '../src/utils/fileUtils.js';
import { runner } from './reactHookDriver.mjs';
import { createDiskHarness } from './tauriDiskHarness.mjs';

const { useSaveProgress } = await import('../src/hooks/useSaveProgress.js');
const { useAutosave } = await import('../src/hooks/useAutosave.js');
const { useProjectStore } = await import('../src/store/projectStore.js');
const { useMediaTransferHandlers } = await import('../src/hooks/useMediaTransferHandlers.js');
const { createWorkSnapshot } = await import('../src/store/projectHelpers.js');
const { normalizeProjectData } = await import('../src/store/projectModel.js');
const { lockAuthorCommands } = await import('../src/store/advancedAuthoring/commandLock.js');
const { AUTOSAVE_ACTIONS, decideAutosaveAction } = await import('../src/store/autosaveDecision.js');
const { SUBSCRIPTIONS_SAVED_EVENT } = await import('../src/store/mediaSubscriptionSource.js');
const { KEYS } = await import('../src/store/persistentSettings.js');

const noop = () => {};
const ref = (current) => ({ current });
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};
const SENTINEL_DIR = '/dernier/dossier/choisi';

const baseProject = () => normalizeProjectData({
  projectType: 'pack',
  projectName: 'Renard',
  rootEntries: [{ id: 'story-1', type: 'story', name: 'Le renard' }],
  mediaSubscriptions: [{
    id: 'follow-1', source: 'podcast', url: 'https://example.com/feed.xml', title: 'Flux',
    baselineIds: ['ep-1'], enabled: true,
  }],
});

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

function suspendFirstRename() {
  const entered = deferred();
  const release = deferred();
  let first = true;
  const base = window.__TAURI_INTERNALS__.invoke;
  window.__TAURI_INTERNALS__.invoke = async (cmd, ...rest) => {
    if (cmd === 'plugin:fs|rename' && first) {
      first = false;
      entered.resolve();
      await release.promise;
    }
    return base(cmd, ...rest);
  };
  return { entered: entered.promise, release: () => release.resolve() };
}

const projectNameIn = (text) => text.match(/"projectName":\s*"([^"]+)"/)?.[1];

async function withApp(run, { transfer = null, realTransfer = false } = {}) {
  const asked = [];
  const harness = await createDiskHarness({
    commands: {
      // Proposition de transfert : l'auteur répond « Plus tard ».
      'plugin:dialog|ask': (args) => { asked.push(args); return false; },
    },
  });
  harness.settings.setItem(KEYS.WORKSPACE_DIR, harness.workspace);
  harness.settings.setItem(KEYS.LAST_SAVE_PROJECT_DIR, SENTINEL_DIR);
  const events = [];
  const previousDispatch = window.dispatchEvent;
  const previousCustomEvent = globalThis.CustomEvent;
  const previousSetInterval = globalThis.setInterval;
  const previousClearInterval = globalThis.clearInterval;
  window.dispatchEvent = (event) => { events.push(event); return true; };
  globalThis.CustomEvent = class FakeCustomEvent {
    constructor(type, init) { this.type = type; this.detail = init.detail; }
  };
  const ticks = [];
  globalThis.setInterval = (fn) => { ticks.push(fn); return ticks.length; };
  globalThis.clearInterval = noop;
  try {
    await harness.mkdirp('projet');
    const savePath = harness.dir('projet', 'renard.mbah');
    const storeRunner = runner(() => useProjectStore());
    let store = storeRunner.render();
    const initial = baseProject();
    store.loadProject(initial);
    store.setSavePath(savePath);
    store = storeRunner.render();

    const transferCalls = [];
    const dialogs = [];
    const transfersRunner = realTransfer ? runner(() => useMediaTransferHandlers({
      store, copyImportedFilesEnabled: true, setCopyImportedFilesEnabled: noop,
      workspaceDir: harness.workspace, setWorkspaceDirState: noop, workspaceDirRef: ref(harness.workspace),
      savePathRef: ref(savePath), pathAudit: {}, dismissedTransferPromptRef: ref(null), setSaveToast: noop,
      persistProjectSnapshotRef: ref(noop), showErrorDialog: (dialog) => dialogs.push(dialog),
      addPathsToMediaLibrary: noop,
    })) : null;
    const realTransferHandler = transfersRunner?.render().maybeOfferTransferIntoProject;
    const toasts = [];
    const refs = {
      mediaLibraryPathsRef: ref([]),
      savedSnapshotRef: ref(createWorkSnapshot(store.project, [], store.mediaTags)),
      autoSaveSnapshotRef: ref(null),
      isSavingRef: ref(false),
      mediaLibraryCountRef: ref(0),
    };
    const props = {
      ...refs,
      configuredWorkspaceDir: harness.workspace,
      setMediaLibraryPaths: (value) => { refs.mediaLibraryPathsRef.current = value; },
      autoSaveEnabled: true,
      autoSaveBackupLimit: 3,
      setSaveToast: (value) => { if (value) toasts.push(value); },
      setRecentProjects: noop,
      showErrorDialog: (dialog) => dialogs.push(dialog),
      maybeOfferTransferIntoProject: async (project, path, options) => {
        transferCalls.push({ path, options });
        if (realTransferHandler) return realTransferHandler(project, path, options);
        if (transfer) return transfer(project, path, options);
        return { project, changed: false, copies: [] };
      },
    };
    const savesRunner = runner(() => useSaveProgress({ ...props, store }));
    let api = savesRunner.render();
    // Câblage de `App.jsx` : `commands.save` = `handleSave` sous le verrou
    // d'auteur, synchronisé dans `saveHandlerRef`.
    const saveHandlerRef = {
      get current() { return lockAuthorCommands({ save: api.handleSave }, () => false).save; },
    };
    const autosaveRunner = runner(() => useAutosave({
      enabled: true,
      backupLimit: 3,
      projectRef: { get current() { return store.readProject(); } },
      savedSnapshotRef: refs.savedSnapshotRef,
      savePathRef: { get current() { return store.savePath; } },
      workspaceDirRef: ref(harness.workspace),
      autoSavePathRef: ref(null),
      autoSaveSnapshotRef: refs.autoSaveSnapshotRef,
      ephemeralSnapshotPathRef: ref(null),
      ephemeralSnapshotSeedStateRef: ref(null),
      sessionModeRef: ref('project'),
      workEpochRef: store.workEpochRef,
      isSavingRef: refs.isSavingRef,
      mediaTagsRef: { get current() { return store.mediaTags; } },
      mediaLibraryPathsRef: refs.mediaLibraryPathsRef,
      mediaLibraryCountRef: refs.mediaLibraryCountRef,
      setAutoSavedPath: noop,
      setSaveToast: props.setSaveToast,
      saveHandlerRef,
    }));
    autosaveRunner.render();
    autosaveRunner.flush();
    assert.equal(ticks.length, 1, 'l’échéance périodique est installée');

    const c = {
      harness,
      savePath,
      refs,
      events,
      transferCalls,
      dialogs,
      asked,
      toasts,
      saveHandlerRef,
      get store() { return store; },
      get api() { return api; },
      render() {
        store = storeRunner.render();
        api = savesRunner.render();
        return { store, api };
      },
      async tick() {
        c.render();
        await ticks[0]();
        c.render();
      },
      isClean() {
        return createWorkSnapshot(store.project, refs.mediaLibraryPathsRef.current, store.mediaTags)
          === refs.savedSnapshotRef.current;
      },
      async addTempImage(name = 'vignette.png') {
        const image = await harness.writeFile(`cache/story_studio_images/${name}`, 'PNG');
        store.setProject((project) => ({ ...project, rootImage: image }));
        c.render();
        return image;
      },
      async fileName() {
        return projectNameIn(await harness.readFile(savePath));
      },
      async backups() {
        const fs = await import('node:fs/promises');
        const dir = `${harness.workspace}/sauvegardes/versions-securite`;
        try {
          const names = (await fs.readdir(dir)).sort();
          return Promise.all(names.map(async (name) => projectNameIn(await fs.readFile(`${dir}/${name}`, 'utf8'))));
        } catch {
          return [];
        }
      },
      async generatedImages() {
        const dir = `${harness.workspace}/images-generees`;
        if (!(await harness.exists(dir))) return [];
        const fs = await import('node:fs/promises');
        const files = [];
    const visit = async (directory) => {
      for (const entry of await fs.readdir(directory, {withFileTypes:true})) {
        if (entry.name.startsWith('.')) continue;
        const target = `${directory}/${entry.name}`;
        if (entry.isDirectory()) await visit(target); else files.push(target);
      }
    };
    await visit(dir);
    return files;
      },
    };
    await run(c);
  } finally {
    window.dispatchEvent = previousDispatch;
    globalThis.CustomEvent = previousCustomEvent;
    globalThis.setInterval = previousSetInterval;
    globalThis.clearInterval = previousClearInterval;
    await harness.dispose();
  }
}

test('autosave d’un projet enregistré : silencieux de bout en bout, image temporaire rangée, suivis annoncés', async () => withApp(async (c) => {
  const temp = await c.addTempImage();
  assert.equal(c.isClean(), false);

  await c.tick();

  assert.equal(c.transferCalls.length, 1);
  assert.equal(c.transferCalls[0].options?.silent, true, 'la proposition de transfert reçoit le mode silencieux');
  assert.equal(c.api.saveProgress, null, 'aucune barre de progression');
  assert.deepEqual(c.dialogs, [], 'aucune boîte');
  assert.equal(c.harness.countCalls('plugin:dialog|save'), 0, 'aucun dialogue de fichier');
  assert.equal(c.harness.settings.getItem(KEYS.LAST_SAVE_PROJECT_DIR), SENTINEL_DIR, 'dernier dossier inchangé');

  const written = await c.harness.readFile(c.savePath);
  assert.match(written, /images-generees/, 'le fichier désigne la copie durable');
  assert.doesNotMatch(written, /story_studio_images/, 'jamais le cache de l’application');
  assert.match(c.store.project.rootImage, /images-generees/, 'la mémoire désigne la même copie');
  assert.equal(await c.harness.exists(c.store.project.rootImage), true);
  assert.equal(await c.harness.exists(temp), true, 'l’original temporaire n’est pas touché');
  assert.equal(c.store.savePath, c.savePath);
  assert.equal(c.isClean(), true, 'tout est dans le fichier : le projet est enregistré');

  const announced = c.events.filter((event) => event.type === SUBSCRIPTIONS_SAVED_EVENT);
  assert.equal(announced.length, 1, 'les suivis sont annoncés');
  assert.equal(announced[0].detail.projectPath, c.savePath);

  await c.tick();
  assert.equal(c.transferCalls.length, 1, 'rien n’a changé : la boucle n’écrit plus');
}));

test('autosave avec transfert à proposer : écrit, mais le projet reste modifié et n’est pas réécrit à l’identique', async () => withApp(async (c) => {
  c.store.setProject((project) => ({ ...project, projectName: 'Renard roux' }));
  c.render();

  await c.tick();
  const writesAfterFirst = c.harness.countCalls('plugin:fs|write_text_file');
  assert.equal(writesAfterFirst, 1, 'le travail est écrit');
  assert.match(await c.harness.readFile(c.savePath), /Renard roux/);
  assert.equal(c.store.savePath, c.savePath);
  assert.equal(c.isClean(), false, 'la décision de transfert reste due : projet modifié');
  assert.deepEqual(c.dialogs, []);

  await c.tick();
  assert.equal(c.harness.countCalls('plugin:fs|write_text_file'), writesAfterFirst,
    'même travail, même fichier : aucune réécriture qui pousserait les versions de sécurité');

  c.store.setProject((project) => ({ ...project, projectName: 'Renard gris' }));
  c.render();
  await c.tick();
  assert.equal(c.harness.countCalls('plugin:fs|write_text_file'), writesAfterFirst + 1,
    'une nouvelle modification est de nouveau écrite');
}, {
  transfer: (project, _path, options) => ({ project, changed: false, copies: [], deferred: options?.silent === true }),
}));

test('transfert réel à proposer : l’autosave ne pose aucune question et le laisse au prochain enregistrement manuel', async () => withApp(async (c) => {
  const external = await c.harness.writeFile('externe/son.mp3', 'MP3');
  c.store.setProject((project) => ({
    ...project,
    rootEntries: project.rootEntries.map((entry) => ({ ...entry, audio: external })),
  }));
  c.render();

  await c.tick();
  assert.deepEqual(c.asked, [], 'aucune question en silencieux');
  assert.deepEqual(c.dialogs, []);
  assert.ok(c.harness.countCalls('plugin:fs|write_text_file') >= 1, 'le travail est écrit');
  assert.equal(c.store.project.rootEntries[0].audio, normalizeWindowsPath(external), 'le fichier reste lié à son emplacement');
  assert.equal(c.isClean(), false, 'le projet reste modifié tant que la question est due');

  assert.equal(await c.saveHandlerRef.current(), c.savePath);
  c.render();
  assert.equal(c.asked.length, 1, 'l’enregistrement manuel pose la question');
  assert.equal(c.isClean(), true, 'l’auteur a répondu : le projet est enregistré');
}, { realTransfer: true }));

test('Ctrl+S et le bouton restent un enregistrement manuel complet', async () => withApp(async (c) => {
  await c.addTempImage();
  // Ctrl+S : `saveHandlerRef.current?.()` sans argument (useAppShortcuts).
  assert.equal(await c.saveHandlerRef.current(), c.savePath);
  c.render();
  assert.equal(c.transferCalls[0].options.silent, false, 'la proposition de transfert est faite normalement');
  assert.equal(c.transferCalls[0].options.mediaStorage.storage.provisional, false);
  assert.ok(c.api.saveProgress?.lines?.length > 0, 'la progression est affichée');
  assert.equal(
    c.harness.settings.getItem(KEYS.LAST_SAVE_PROJECT_DIR).replace(/\\/g, '/'),
    c.harness.dir('projet'),
    'le dernier dossier suit l’enregistrement manuel',
  );

  // Bouton : un événement de clic reçu en argument n’en fait pas un silencieux.
  c.store.setProject((project) => ({ ...project, projectName: 'Autre' }));
  c.render();
  await c.api.handleSave({ type: 'click', silent: 'oui' });
  assert.equal(c.transferCalls[1].options.silent, false);
}));

test('autosave en échec : journalisé et signalé par la pastille, sans boîte ni copie orpheline', async () => withApp(async (c) => {
  const temp = await c.addTempImage();
  c.harness.injectFailure({ cmd: 'plugin:fs|write_text_file', match: 'renard.mbah' });

  await c.tick();

  assert.deepEqual(c.dialogs, [], 'aucune boîte modale');
  assert.deepEqual(c.toasts, ['error'], 'la pastille signale l’échec');
  assert.equal(c.isClean(), false, 'le projet reste modifié');
  assert.equal(c.store.project.rootImage, normalizeWindowsPath(temp), 'la mémoire n’a pas bougé');
  assert.deepEqual(await c.generatedImages(), [], 'la copie faite pour ce fichier est retirée');

  c.harness.injectFailure({ cmd: 'plugin:fs|write_text_file', match: 'renard.mbah' });
  await c.saveHandlerRef.current();
  assert.equal(c.dialogs.length, 1, 'un enregistrement manuel en échec, lui, ouvre la boîte');
}));

test('un enregistrement manuel arrivé pendant un autosave l’attend puis s’exécute', async () => withApp(async (c) => {
  c.store.setProject((project) => ({ ...project, projectName: 'Pendant' }));
  c.render();
  const barrier = suspendFileReplacement();
  const autosave = c.tick();
  await barrier.entered;

  const manual = c.saveHandlerRef.current();
  barrier.release();
  await autosave;

  assert.equal(await manual, c.savePath, 'le Ctrl+S n’est pas perdu');
  assert.deepEqual(c.transferCalls.map((call) => call.options?.silent ?? false), [true, false]);
  assert.deepEqual(c.dialogs, []);
}));

test('un « Enregistrer sous » en cours tient la boucle à l’écart', async () => withApp(async (c) => {
  c.store.setProject((project) => ({ ...project, projectName: 'Copie' }));
  c.render();
  const target = c.harness.dir('projet', 'copie.mbah');
  c.harness.answerSave(target);
  const barrier = suspendFileReplacement();
  const saveAs = c.api.handleSaveProjectAs();
  await barrier.entered;

  const transfersBefore = c.transferCalls.length;
  await c.tick();
  assert.equal(c.transferCalls.length, transfersBefore, 'l’autosave ne démarre pas pendant la copie');

  barrier.release();
  assert.equal(await saveAs, target);
  c.render();
  assert.equal(c.store.savePath, target, 'le chemin choisi par l’auteur reste le chemin courant');
  assert.equal(c.refs.isSavingRef.current, false);
}));

test('autosave sans fichier : jamais de dialogue « Enregistrer sous »', async () => withApp(async (c) => {
  c.store.setSavePath(null);
  c.render();
  assert.equal(await c.saveHandlerRef.current({ silent: true }), null);
  assert.equal(c.harness.countCalls('plugin:dialog|save'), 0);
  assert.deepEqual(c.dialogs, []);
}));

test('decideAutosaveAction : projet enregistré resté en session éphémère → instantané de session', () => {
  const action = decideAutosaveAction({
    currentSnapshot: 'b',
    savedSnapshot: 'a',
    isDirty: true,
    savePath: '/p/x.mbah',
    workspaceDir: '/session',
    sessionMode: 'ephemeral',
    ephemeralSnapshotPath: '/session/snapshot.mbah',
  });
  assert.equal(action.kind, AUTOSAVE_ACTIONS.AUTOSAVE_EPHEMERAL);
  assert.equal(action.path, '/session/snapshot.mbah');
});

test('decideAutosaveAction : travail déjà écrit en place sans être déclaré enregistré → rien', () => {
  const input = {
    currentSnapshot: 'b', savedSnapshot: 'a', isDirty: true, savePath: '/p/x.mbah',
  };
  const memo = { path: '/p/x.mbah', snapshot: 'b', savedSnapshot: 'a' };
  assert.equal(decideAutosaveAction({ ...input, lastExplicitAutosave: memo }).kind,
    AUTOSAVE_ACTIONS.SKIP_UNCHANGED);
  assert.equal(decideAutosaveAction({ ...input, lastExplicitAutosave: { ...memo, path: '/p/autre.mbah' } }).kind,
    AUTOSAVE_ACTIONS.SAVE_EXPLICIT);
  assert.equal(decideAutosaveAction({ ...input, lastExplicitAutosave: { ...memo, snapshot: 'c' } }).kind,
    AUTOSAVE_ACTIONS.SAVE_EXPLICIT);
  assert.equal(decideAutosaveAction({ ...input, lastExplicitAutosave: { ...memo, savedSnapshot: 'z' } }).kind,
    AUTOSAVE_ACTIONS.SAVE_EXPLICIT, 'un enregistrement survenu depuis rend la main');
});

const deferTransfer = {
  transfer: (project, _path, options) => ({ project, changed: false, copies: [], deferred: options?.silent === true }),
};

test('M1 — un instantané d’import attend l’autosave en vol : le fichier finit avec l’import', async () => withApp(async (c) => {
  c.store.setProject((p) => ({ ...p, projectName: 'A' }));
  c.render();
  const barrier = suspendFirstRename();
  const autosave = c.tick();
  await barrier.entered;

  c.store.setProject((p) => ({ ...p, projectName: 'IMPORT' }));
  c.render();
  const snapshot = c.api.persistProjectSnapshot(c.store.project, c.savePath);
  // Sans sérialisation, l'instantané écrit et renomme pendant ce délai, avant
  // que le `rename` suspendu de l'autosave ne reprenne.
  await Promise.race([snapshot, new Promise((resolve) => setTimeout(resolve, 100))]);
  barrier.release();
  await autosave;
  assert.equal(await snapshot, c.savePath);
  c.render();

  assert.equal(await c.fileName(), 'IMPORT', 'l’écriture partie plus tôt ne recouvre pas l’import');
  assert.equal(c.store.project.projectName, 'IMPORT');
  assert.equal(c.isClean(), true, 'mémoire et fichier concordent');
}));

test('M2 — une mutation pas encore rendue pendant l’autosave n’est ni écrasée ni déclarée enregistrée', async () => withApp(async (c) => {
  c.store.setProject((p) => ({ ...p, projectName: 'avant' }));
  c.render();
  const barrier = suspendFirstRename();
  const autosave = c.tick();
  await barrier.entered;
  // Fin d'une génération : `setProject` sans rendu React entre-temps.
  c.store.setProject((p) => ({ ...p, projectName: 'GENERATION' }));
  barrier.release();
  await autosave;
  c.render();

  assert.equal(await c.fileName(), 'avant', 'le fichier porte l’état écrit');
  assert.equal(c.store.project.projectName, 'GENERATION', 'la mutation reste en mémoire');
  assert.equal(c.isClean(), false, 'elle n’est pas déclarée enregistrée');
  assert.equal(c.store.savePath, c.savePath);
}));

test('M2 — un enregistrement manuel part de la dernière mutation, même pas encore rendue', async () => withApp(async (c) => {
  c.store.setProject((p) => ({ ...p, projectName: 'NON-RENDU' }));
  // Pas de rendu : Ctrl+S juste après la mutation.
  assert.equal(await c.saveHandlerRef.current(), c.savePath);
  c.render();
  assert.equal(await c.fileName(), 'NON-RENDU');
  assert.equal(c.isClean(), true);
}));

test('m1 — fichier non inscriptible : ni versions de sécurité identiques, ni nouvel essai du même travail', async () => withApp(async (c) => {
  for (const name of ['v0', 'v1', 'v2', 'v3']) {
    // Backup timestamps have millisecond precision; exercise four distinct instants.
    await new Promise((resolve) => setTimeout(resolve, 2));
    c.store.setProject((p) => ({ ...p, projectName: name }));
    c.render();
    assert.equal(await c.saveHandlerRef.current(), c.savePath);
    c.render();
  }
  assert.deepEqual(await c.backups(), ['v0', 'v1', 'v2']);
  c.store.setProject((p) => ({ ...p, projectName: 'pendant-panne' }));
  c.render();
  c.harness.injectFailure({ cmd: 'plugin:fs|write_text_file', match: 'renard.mbah', times: 100 });
  const writesBefore = c.harness.countCalls('plugin:fs|write_text_file');
  for (let i = 0; i < 4; i += 1) await c.tick();

  assert.deepEqual(await c.backups(), ['v1', 'v2', 'v3'], 'v3 sauvegardée une fois, v1 et v2 conservées');
  assert.equal(c.harness.countCalls('plugin:fs|write_text_file') - writesBefore, 1, 'un seul essai');
  assert.deepEqual(c.toasts.filter((t) => t === 'error'), ['error'], 'un seul signalement');
  assert.deepEqual(c.dialogs, []);
  assert.equal(await c.fileName(), 'v3');
}));

test('m1 — même fichier, une version de sécurité identique à la dernière n’est pas recréée', async () => withApp(async (c) => {
  c.store.setProject((p) => ({ ...p, projectName: 'v0' }));
  c.render();
  await c.saveHandlerRef.current();
  await c.saveHandlerRef.current();
  await c.saveHandlerRef.current();
  assert.deepEqual(await c.backups(), ['v0']);
}));

test('m2 — catalogue réconcilié par l’écriture : aucune réécriture à l’échéance suivante', async () => withApp(async (c) => {
  const external = await c.harness.writeFile('externe/son.mp3', 'MP3');
  c.store.setProject((project) => ({
    ...project,
    rootEntries: project.rootEntries.map((entry) => ({ ...entry, audio: external })),
  }));
  c.render();
  await c.tick();
  assert.deepEqual(c.refs.mediaLibraryPathsRef.current, [normalizeWindowsPath(external)], 'le catalogue a été réconcilié');
  const writes = c.harness.countCalls('plugin:fs|write_text_file');
  await c.tick();
  await c.tick();
  assert.equal(c.harness.countCalls('plugin:fs|write_text_file'), writes);
  assert.equal(c.isClean(), false);
}, { realTransfer: true }));

test('m3 — un enregistrement manuel rend la main à l’échéance pour un travail déjà vu', async () => withApp(async (c) => {
  c.store.setProject((p) => ({ ...p, projectName: 'S' }));
  c.render();
  await c.tick();
  assert.equal(await c.fileName(), 'S');
  c.store.setProject((p) => ({ ...p, projectName: 'S2' }));
  c.render();
  assert.equal(await c.api.handleSaveProject(), c.savePath);
  c.render();
  assert.equal(await c.fileName(), 'S2');

  c.store.setProject((p) => ({ ...p, projectName: 'S' }));
  c.render();
  await c.tick();
  assert.equal(await c.fileName(), 'S', 'le retour à un état déjà vu est bien écrit');
}, deferTransfer));

test('m4 — Ctrl+S pendant « Enregistrer sous » attend sa fin au lieu de rendre null', async () => withApp(async (c) => {
  c.store.setProject((p) => ({ ...p, projectName: 'Copie' }));
  c.render();
  const target = c.harness.dir('projet', 'copie.mbah');
  c.harness.answerSave(target);
  const barrier = suspendFirstRename();
  const saveAs = c.api.handleSaveProjectAs();
  await barrier.entered;
  const ctrlS = c.saveHandlerRef.current();
  barrier.release();
  assert.equal(await saveAs, target);
  assert.ok(await ctrlS, 'le Ctrl+S aboutit après la copie');
  assert.deepEqual(c.dialogs, []);
  assert.equal(c.refs.isSavingRef.current, false);
}));

test('Ctrl+S en attente d’un « Enregistrer sous » vise la copie, pas l’ancien fichier', async () => withApp(async (c) => {
  c.store.setProject((p) => ({ ...p, projectName: 'Copie' }));
  c.render();
  const originalExisted = await c.harness.exists(c.savePath);
  const target = c.harness.dir('projet', 'copie.mbah');
  c.harness.answerSave(target);
  const barrier = suspendFirstRename();
  const saveAs = c.api.handleSaveProjectAs();
  await barrier.entered;
  // Aucun rendu entre la fin de la copie et le Ctrl+S : le `savePath` rendu
  // désigne encore l'ancien fichier.
  const ctrlS = c.saveHandlerRef.current();
  barrier.release();
  assert.equal(await saveAs, target);
  assert.equal(await ctrlS, target, 'le Ctrl+S écrit la copie choisie');
  assert.equal(await c.harness.exists(c.savePath), originalExisted, 'l’ancien fichier n’est pas réécrit');
}));

test('m4 — deux Ctrl+S pendant un autosave aboutissent tous les deux', async () => withApp(async (c) => {
  c.store.setProject((p) => ({ ...p, projectName: 'Y' }));
  c.render();
  const barrier = suspendFirstRename();
  const autosave = c.tick();
  await barrier.entered;
  const first = c.saveHandlerRef.current();
  const second = c.saveHandlerRef.current();
  barrier.release();
  await autosave;
  assert.deepEqual([await first, await second], [c.savePath, c.savePath]);
  assert.equal(c.refs.isSavingRef.current, false);
}));

test('m5 — l’autosave transmet l’inventaire des médias à la garde « projet vide »', async () => withApp(async (c) => {
  // Projet sans contenu propre : seuls des médias comptent (inventaire).
  c.store.loadProject(normalizeProjectData({ projectType: 'pack', rootEntries: [] }));
  c.render();
  c.refs.mediaLibraryCountRef.current = 4;
  const outcome = await c.saveHandlerRef.current({ silent: true });
  assert.equal(outcome?.status, 'saved', 'l’écriture n’est pas refusée comme vide');
}));

test('deux écritures du même fichier dans la même milliseconde ont chacune leur temporaire', async () => {
  const fs = await import('node:fs/promises');
  // Node/libuv can reject concurrent replacements on Windows, unlike the
  // native Rust rename used by the plugin. Keep both saves concurrent and
  // serialize only the doubled publication syscall; check temporary names too.
  let publication = Promise.resolve();
  const temporaries = [];
  const harness = await createDiskHarness({ commands: {
    'plugin:fs|rename': ({ oldPath, newPath }) => {
      temporaries.push(oldPath);
      publication = publication.then(() => fs.rename(oldPath, newPath));
      return publication;
    },
  } });
  const io = await import('../src/store/projectIO.js');
  const realNow = Date.now;
  Date.now = () => 1_700_000_000_000;
  try {
    const path = harness.dir('meme-ms.mbah');
    const results = await Promise.allSettled([
      io.saveProject({ ...baseProject(), projectName: 'un' }, path, null, { autosave: true }),
      io.saveProject({ ...baseProject(), projectName: 'deux' }, path, null, { autosave: true }),
    ]);
    assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'fulfilled'], results.map(r => r.reason?.stack).filter(Boolean).join('\n'));
    assert.equal(temporaries.length, 2);
    assert.equal(new Set(temporaries).size, 2);
    assert.ok(['un', 'deux'].includes(projectNameIn(await harness.readFile(path))));
  } finally {
    Date.now = realNow;
    await harness.dispose();
  }
});
