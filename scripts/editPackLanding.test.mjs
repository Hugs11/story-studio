// Atterrissage de « Modifier un pack » (Projet → Ouvrir un pack) depuis un
// éditeur déjà ouvert.
//
// Les hooks `useImportSession` et `useProjectLifecycle` et le vrai store sont
// exécutés intacts ; seuls l'ordonnanceur React, la réponse native
// `unpack_zip_to_entries` et la préparation de session sont doublés. La
// préparation fait ce que fait `prepareNewWorkSession` sur le store : chemin
// effacé, type posé hors historique.
//
// Le pack remplace entièrement le projet ouvert, comme l'atterrissage
// graphe : nouvelle époque, rien de l'ancien (entrées, avertissements, version).
// L'atterrissage n'est pas une étape d'historique, dans les deux éditeurs :
// Annuler ne vide pas le pack, et le travail reste vierge.
// Les étiquettes et la médiathèque de l'ancien projet ne passent pas dans
// le pack ; la garde de départ le laisse partir sans question.

import test from 'node:test';
import assert from 'node:assert/strict';
import { runner } from './reactHookDriver.mjs';
import './tauriDiskHarness.mjs';

const { useProjectStore } = await import('../src/store/projectStore.js');
const { useImportSession } = await import('../src/hooks/useImportSession.js');
const { useProjectLifecycle } = await import('../src/hooks/useProjectLifecycle.js');
const { useAdvancedProjectEntry } = await import('../src/hooks/useAdvancedProjectEntry.js');
const { normalizeProjectData, buildProjectIndex } = await import('../src/store/projectModel.js');
const { createAdvancedProject } = await import('../src/store/projectModel/authoring.js');
const { askSaveBeforeLeave } = await import('../src/hooks/saveBeforeLeave.js');
const { createWorkSnapshot } = await import('../src/store/projectHelpers.js');

const PAYLOAD = '{"payloadVersion":1,"document":{"stageNodes":[],"actionNodes":[]},'
  + '"context":{"documentOrigin":"created","defaultValueOrigin":"authored"}}';

const noop = () => {};

// Pack synthétique : deux histoires, une transition non modélisée.
function unpackResult() {
  return {
    rootId: 'pack-root',
    title: 'Pack ouvert',
    packVersion: 3,
    rootAudio: 'C:/ws/zips-extraits/Pack/titre.wav',
    rootImage: 'C:/ws/zips-extraits/Pack/titre.png',
    entries: [
      { id: 'p-1', type: 'story', name: 'Premiere', audio: 'C:/ws/zips-extraits/Pack/un.wav' },
      { id: 'p-2', type: 'story', name: 'Seconde', audio: 'C:/ws/zips-extraits/Pack/deux.wav' },
    ],
    advancedTransitionsDetected: true,
    unresolvedTransitions: [{ message: 'Retour à vérifier', entryId: 'p-1' }],
  };
}

// Projet par menus rempli : nom, titre, médias racine, deux histoires, un
// avertissement d'import, une version.
function filledProject() {
  return normalizeProjectData({
    projectType: 'pack',
    projectName: 'Ancien',
    packMetadata: { title: 'Ancien titre', version: 7, uuid: 'uuid-ancien' },
    rootAudio: 'C:/ancien/titre.wav',
    rootImage: 'C:/ancien/titre.png',
    importWarnings: [{ message: 'Ancien avertissement', sourceRootId: 'autre', entryId: 'a-1' }],
    rootEntries: [
      { id: 'a-1', type: 'story', name: 'Histoire A', audio: 'C:/ancien/a.wav' },
      { id: 'a-2', type: 'story', name: 'Histoire B', audio: 'C:/ancien/b.wav' },
    ],
  });
}

function mount(initialProject, result = unpackResult()) {
  const previousInvoke = window.__TAURI_INTERNALS__.invoke;
  window.__TAURI_INTERNALS__.invoke = async (command) => {
    if (command === 'unpack_zip_to_entries') return result;
    throw new Error(`commande non doublée : ${command}`);
  };
  const notices = [];
  const library = { current: [] };
  const savedSnapshotRef = { current: null };
  const importedPackPendingMetaRef = { current: false };
  let store; let session; let lifecycle;
  const app = runner(() => {
    store = useProjectStore();
    session = useImportSession({
      store,
      projectIndex: buildProjectIndex(store.project),
      setImporting: noop,
      setUnpacking: noop,
      setImportNotice: noop,
      persistProjectSnapshot: async () => null,
      workspaceDirRef: { current: 'C:/ws' },
      showErrorDialog: noop,
      onImportedPackPromoted: noop,
    });
    lifecycle = useProjectLifecycle({
      store,
      askSaveBeforeLeaveCurrent: async () => true,
      handleSave: noop,
      prepareNewWorkSession: noop,
      runFunnelLanding: async (type, importFn) => {
        store.setSavePath(null);
        store.setProjectType(type);
        return importFn('C:/ws');
      },
      resetWorkSession: noop,
      unpackZipIntoBlankProject: session.unpackZipIntoBlankProject,
      savedSnapshotRef,
      autoSavePathRef: { current: null },
      autoSaveSnapshotRef: { current: null },
      importedPackPendingMetaRef,
      setMediaLibraryPaths: (paths) => { library.current = paths; },
      setAutoSavedPath: noop,
      sdStore: { clearDone: noop },
      xttsStore: { clearDone: noop },
      setEditPackOpen: noop,
      setPendingSimulateZip: noop,
      setImportNotice: (notice) => notices.push(notice),
      showErrorDialog: noop,
    });
  });
  app.render();
  if (initialProject) {
    store.loadProject(initialProject);
    app.render();
  }
  return {
    get store() { return store; },
    get lifecycle() { return lifecycle; },
    render: () => app.render(),
    notices,
    library,
    savedSnapshotRef,
    restore: () => { window.__TAURI_INTERNALS__.invoke = previousInvoke; },
  };
}

async function land(c) {
  await c.lifecycle.handleLandEditablePack({ zipPath: 'C:/packs/pack.zip', packLabel: 'Pack ouvert' });
  c.render();
}

test('depuis un projet par menus rempli, le pack remplace entièrement l’ancien projet', async () => {
  const c = mount(filledProject());
  try {
    const epochBefore = c.store.workEpochRef.current;
    await land(c);
    const project = c.store.project;
    assert.deepEqual(project.rootEntries.map((entry) => entry.name), ['Premiere', 'Seconde']);
    assert.equal(project.projectName, '');
    assert.equal(project.packMetadata.title, 'Pack ouvert');
    assert.equal(project.packMetadata.version, 3);
    assert.notEqual(project.packMetadata.uuid, 'uuid-ancien');
    assert.equal(project.rootAudio.replaceAll('\\', '/'), 'C:/ws/zips-extraits/Pack/titre.wav');
    assert.equal(project.rootImage.replaceAll('\\', '/'), 'C:/ws/zips-extraits/Pack/titre.png');
    assert.deepEqual(project.importWarnings.map((warning) => warning.message), ['Retour à vérifier']);
    assert.ok(c.store.workEpochRef.current > epochBefore, 'nouvelle époque de travail');
  } finally {
    c.restore();
  }
});

test('depuis l’accueil, l’atterrissage donne le même projet que depuis un éditeur rempli', async () => {
  const fromHome = mount(null);
  const fromEditor = mount(filledProject());
  try {
    await land(fromHome);
    await land(fromEditor);
    const strip = ({ packMetadata, storage, ...rest }) => ({ ...rest, storage: { ...storage, workId: '' }, packMetadata: { ...packMetadata, uuid: '' } });
    assert.deepEqual(strip(fromEditor.store.project), strip(fromHome.store.project));
  } finally {
    fromEditor.restore();
    fromHome.restore();
  }
});

// Atterrissage graphe : `useAdvancedProjectEntry` intact, acquisition doublée.
function mountAdvanced(initialProject, overrides = {}) {
  const library = { current: [] };
  const savedSnapshotRef = { current: null };
  let store; let entry;
  const app = runner(() => {
    store = useProjectStore();
    entry = useAdvancedProjectEntry({
      store,
      runFunnelLanding: async (_type, importFn) => {
        store.setSavePath(null);
        return importFn('C:/ws');
      },
      savedSnapshotRef,
      setMediaLibraryPaths: (paths) => { library.current = paths; },
      importedPackPendingMetaRef: { current: false },
      acquire: async () => createAdvancedProject({ payload: PAYLOAD, projectName: 'Pack graphe' }),
      prepareImported: async (project) => project,
      ...overrides,
    });
  });
  app.render();
  if (initialProject) {
    store.loadProject(initialProject);
    app.render();
  }
  return {
    get store() { return store; },
    get entry() { return entry; },
    render: () => app.render(),
    restore: () => app.unmount(),
    library,
    savedSnapshotRef,
  };
}

test('juste après l’atterrissage par menus, Annuler n’a rien à défaire et le travail reste vierge', async () => {
  const c = mount(null);
  try {
    await land(c);
    assert.equal(c.store.canUndo, false);
    assert.equal(c.store.isPristine(), true);
    c.store.undo();
    c.render();
    assert.deepEqual(c.store.project.rootEntries.map((entry) => entry.name), ['Premiere', 'Seconde']);
    assert.equal(c.store.isPristine(), true);
  } finally {
    c.restore();
  }
});

test('même règle pour l’atterrissage graphe', async () => {
  const c = mountAdvanced(null);
  await c.entry.landAdvancedPack({ zipPath: 'C:/packs/pack.zip', packLabel: 'Pack graphe' });
  c.render();
  assert.equal(c.store.canUndo, false);
  assert.equal(c.store.isPristine(), true);
  assert.equal(c.store.project.projectName, 'Pack graphe');
});

// Ancien projet enregistré, avec une étiquette et un média de bibliothèque.
function withOldMedia(c) {
  c.store.setMediaTags({ 'C:/ancien/voix.mp3': ['loup'] });
  c.library.current = ['C:/ancien/voix.mp3'];
  c.render();
  c.savedSnapshotRef.current = createWorkSnapshot(c.store.project, c.library.current, c.store.mediaTags);
}

async function leavesWithoutQuestion(c) {
  const questions = [];
  const canLeave = await askSaveBeforeLeave(() => ({
    project: c.store.project,
    mediaLibraryPaths: c.library.current,
    mediaTags: c.store.mediaTags,
    savedSnapshot: c.savedSnapshotRef.current,
    pristine: c.store.isPristine(),
  }), noop, async (dialog) => { questions.push(dialog.title); return 'cancel'; });
  return { canLeave, questions };
}

test('l’atterrissage par menus remet à zéro étiquettes et médiathèque de l’ancien projet', async () => {
  const c = mount(filledProject());
  try {
    withOldMedia(c);
    await land(c);
    assert.deepEqual(c.store.mediaTags, {});
    assert.deepEqual(c.library.current, []);
    assert.deepEqual(await leavesWithoutQuestion(c), { canLeave: true, questions: [] });
  } finally {
    c.restore();
  }
});

test('l’atterrissage graphe remet à zéro étiquettes et médiathèque de l’ancien projet', async () => {
  const c = mountAdvanced(createAdvancedProject({ payload: PAYLOAD, projectName: 'Ancien graphe' }));
  withOldMedia(c);
  await c.entry.landAdvancedPack({ zipPath: 'C:/packs/pack.zip', packLabel: 'Pack graphe' });
  c.render();
  assert.deepEqual(c.store.mediaTags, {});
  assert.deepEqual(c.library.current, []);
  assert.deepEqual(await leavesWithoutQuestion(c), { canLeave: true, questions: [] });
});

// Après réouverture, le drapeau d’import est faux : la fiche peut être sautée.
test('menus : nom libre sauvegardé puis rouvert, générer n’impose plus les métadonnées', async () => {
  const { encodeProjectFile, decodeProjectFile } = await import('../src/store/projectModel/codec.js');
  const { usePackGeneration } = await import('../src/hooks/usePackGeneration.js');
  const c = mount(null);
  try {
    await land(c);
    const source = { ...c.store.project, packMetadata: { ...c.store.project.packMetadata, namingMode: 'legacy', legacyExportName: 'Mon export', minAge: '' } };
    const { project } = await decodeProjectFile(encodeProjectFile(source));
    const dialogs = [];
    let api;
    const generation = runner(() => {
      api = usePackGeneration({
        store: { project }, renderQueue: {}, pathAudit: {}, pathAuditPending: true,
        workspaceDirRef: { current: '' }, importedPackPendingMetaRef: { current: false },
        showErrorDialog: dialog => dialogs.push(dialog),
      });
    });
    generation.render();
    await api.handleGenerate();
    generation.render();
    assert.equal(api.packMetadata.open, false);
    assert.equal(dialogs.length, 1, 'la garde de vérification est atteinte');
    assert.deepEqual(dialogs[0].title, { key: 'production:generation.checking.title' });
    assert.equal(project.packMetadata.namingMode, 'legacy');
    assert.equal(project.packMetadata.legacyExportName, 'Mon export');
    assert.equal(project.packMetadata.minAge, '');
  } finally { c.restore(); }
});


test('menus : après import dans la même session, le nom libre garde la question UUID', async () => {
  const { usePackGeneration } = await import('../src/hooks/usePackGeneration.js');
  const c = mount(null);
  try {
    await land(c);
    const project = { ...c.store.project, packMetadata: { ...c.store.project.packMetadata, namingMode: 'legacy', legacyExportName: 'Mon export' } };
    let api;
    const generation = runner(() => {
      api = usePackGeneration({
        store: { project }, renderQueue: {}, pathAudit: {}, pathAuditPending: true,
        workspaceDirRef: { current: '' }, importedPackPendingMetaRef: { current: true },
        showErrorDialog: () => assert.fail('la fiche précède les gardes de génération'),
      });
    });
    generation.render();
    await api.handleGenerate();
    generation.render();
    assert.equal(api.packMetadata.open, true);
  } finally { c.restore(); }
});


test('atterrissage graphe : transmet le nom visible au préparateur, crée sans titre automatique', async () => {
  const prepared = [];
  const created = [];
  const c = mountAdvanced(null, {
    prepareImported: async (project, options) => { prepared.push(options); return project; },
    acquireCreated: async options => { created.push(options); return createAdvancedProject({ payload: PAYLOAD }); },
  });
  try {
    await c.entry.landAdvancedPack({ zipPath: '/cache/member-2.zip', packLabel: '6+ Le Renard' });
    assert.deepEqual(prepared, [{ packPath: '/cache/member-2.zip', packLabel: '6+ Le Renard' }]);
    await c.entry.startAdvancedProject();
    assert.deepEqual(created, [{ title: '', projectName: '' }]);
  } finally { c.restore(); }
});

test('menus : une histoire seule sans nom reprend le titre du nom visible', async () => {
  const c = mount(null, { title: '', entries: [{ id: 'seule', type: 'story', name: '', audio: '/assets/histoire.mp3' }] });
  try {
    await c.lifecycle.handleLandEditablePack({ zipPath: '/cache/a1b2c3.zip', packLabel: '6+ Le Renard' });
    c.render();
    assert.equal(c.store.project.packMetadata.title, 'Le Renard');
    assert.equal(c.store.project.packMetadata.minAge, '6');
    assert.equal(c.store.project.rootEntries[0].name, 'Le Renard');
  } finally { c.restore(); }
});
