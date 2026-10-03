// Garde de départ (fermeture, nouveau projet, ouverture, récents, copie vers
// graphe) après « Enregistrer » : quitter n'est permis que si la mémoire est
// tout entière dans le fichier.
//
// Les hooks `useProjectStore` et `useSaveProgress` et la garde de fermeture sont
// importés intacts et exécutés sur le vrai `projectIO` et de vrais fichiers
// temporaires. Une barrière suspend le `rename` qui remplace le fichier : le
// travail change pendant l'écriture, la sauvegarde est classée périmée, et la
// garde doit relire l'état avant de laisser jeter la mémoire.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { runner } from './reactHookDriver.mjs';
import { createDiskHarness } from './tauriDiskHarness.mjs';

const { useSaveProgress } = await import('../src/hooks/useSaveProgress.js');
const { useProjectStore } = await import('../src/store/projectStore.js');
const { createWindowCloseHandler } = await import('../src/hooks/useWindowCloseGuard.js');
const { askSaveBeforeLeave } = await import('../src/hooks/saveBeforeLeave.js');
const { createNativeGenerationLock } = await import('../src/store/nativeGenerationLock.js');
const { createAdvancedProject } = await import('../src/store/projectModel/authoring.js');
const { normalizeProjectData } = await import('../src/store/projectModel.js');

const PAYLOAD = '{"payloadVersion":1,"document":{"stageNodes":[],"actionNodes":[]},'
  + '"context":{"documentOrigin":"created","defaultValueOrigin":"authored"}}';

const noop = () => {};
const ref = (current) => ({ current });
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

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
  return {
    entered: entered.promise,
    release: () => release.resolve(),
    restore: () => { window.__TAURI_INTERNALS__.invoke = base; },
  };
}

function initialProject(nature) {
  return nature === 'free'
    ? normalizeProjectData({ projectType: 'pack', projectName: 'Avant', rootEntries: [{ id: 'C', type: 'story', name: 'C' }] })
    : createAdvancedProject({ payload: PAYLOAD, projectName: 'Avant' });
}

// Monte le travail d'une nature, enregistré une première fois, puis modifié :
// la garde demande donc bien quoi faire.
async function withWork(nature, run) {
  const harness = await createDiskHarness();
  try {
    const storeRunner = runner(() => useProjectStore());
    let store = storeRunner.render();
    store.loadProject(initialProject(nature));
    store.setSavePath(harness.dir(`${nature}.mbah`));
    store = storeRunner.render();
    const refs = {
      mediaLibraryPathsRef: ref([]),
      savedSnapshotRef: ref(null),
      autoSaveSnapshotRef: ref(null),
      isSavingRef: ref(false),
    };
    const savesRunner = runner(() => useSaveProgress({
      ...refs,
      store,
      setMediaLibraryPaths: (value) => { refs.mediaLibraryPathsRef.current = value; },
      autoSaveEnabled: false,
      autoSaveBackupLimit: 0,
      setSaveToast: noop,
      setRecentProjects: noop,
      maybeOfferTransferIntoProject: async (project) => ({ project, changed: false }),
    }));
    let api = savesRunner.render();
    const render = () => { store = storeRunner.render(); api = savesRunner.render(); };
    await api.handleSaveProject();
    render();
    store.updateProjectName('Modifié');
    render();
    // Même lecture que l'hôte : refs du dernier rendu, relues à chaque appel.
    const readWork = () => ({
      project: store.project,
      mediaLibraryPaths: refs.mediaLibraryPathsRef.current,
      mediaTags: store.mediaTags,
      savedSnapshot: refs.savedSnapshotRef.current,
      pristine: false,
    });
    await run({ get store() { return store; }, get api() { return api; }, render, readWork });
  } finally {
    await harness.dispose();
  }
}

const mutations = {
  projet: (store) => store.updateProjectName('Après'),
  tags: (store) => store.addMediaTag('C:/medias/son.wav', 'voix'),
};

for (const nature of ['free', 'advanced']) {
  for (const [label, mutate] of Object.entries(mutations)) {
    test(`${nature} : une sauvegarde périmée (${label}) ne laisse pas quitter`, async () => {
      await withWork(nature, async (c) => {
        const calls = [];
        const choices = [];
        const dialog = async () => { choices.push('dialog'); return choices.length === 1 ? 'save' : 'cancel'; };
        const close = createWindowCloseHandler({
          lock: createNativeGenerationLock(),
          readCurrent: () => ({
            saveHandlerRef: { current: () => c.api.handleSaveProject() },
            askSaveBeforeLeave: (onSave) => askSaveBeforeLeave(c.readWork, onSave, dialog),
            beforeClose: async () => calls.push('cleanup'),
          }),
          win: { destroy: async () => calls.push('destroy') },
        });
        const barrier = suspendFileReplacement();
        try {
          const pending = close({ preventDefault: () => calls.push('prevent') });
          await barrier.entered;
          mutate(c.store);
          c.render();
          barrier.release();
          await pending;
        } finally {
          barrier.restore();
        }
        c.render();
        assert.deepEqual(calls, ['prevent'], 'ni nettoyage de session ni destruction de fenêtre');
        assert.equal(choices.length, 2, 'la garde redemande, puisque le travail reste non enregistré');
      });
    });
  }

  test(`${nature} : une sauvegarde qui porte tout le travail laisse quitter`, async () => {
    await withWork(nature, async (c) => {
      const calls = [];
      const close = createWindowCloseHandler({
        lock: createNativeGenerationLock(),
        readCurrent: () => ({
          saveHandlerRef: { current: () => c.api.handleSaveProject() },
          askSaveBeforeLeave: (onSave) => askSaveBeforeLeave(c.readWork, onSave, async () => 'save'),
          beforeClose: async () => calls.push('cleanup'),
        }),
        win: { destroy: async () => calls.push('destroy') },
      });
      await close({ preventDefault: () => calls.push('prevent') });
      c.render();
      assert.deepEqual(calls, ['prevent', 'cleanup', 'destroy']);
      const written = JSON.parse(await fs.readFile(c.store.savePath, 'utf8'));
      assert.equal(written.projectName, 'Modifié');
    });
  });
}

test('travail déjà enregistré : aucune question, départ permis', async () => {
  await withWork('free', async (c) => {
    await c.api.handleSaveProject();
    c.render();
    let asked = false;
    const allowed = await askSaveBeforeLeave(c.readWork, null, async () => { asked = true; return 'cancel'; });
    assert.equal(allowed, true);
    assert.equal(asked, false);
  });
});

// Premier enregistrement (« Enregistrer sous ») en session `project`.
// Le fichier impose son nom au projet : le projet écrit diffère du projet en
// mémoire, et aucune attente ne laisse React rendre avant la relecture. La
// garde relit comme l'hôte, l'état du **dernier rendu**.
async function firstSaveInProjectSession(duringWrite) {
  const harness = await createDiskHarness();
  try {
    const storeRunner = runner(() => useProjectStore());
    let store = storeRunner.render();
    store.loadProject(normalizeProjectData({
      projectType: 'pack', projectName: '', rootEntries: [{ id: 'C', type: 'story', name: 'C' }],
    }));
    store = storeRunner.render();
    const refs = {
      mediaLibraryPathsRef: ref([]),
      savedSnapshotRef: ref(null),
      autoSaveSnapshotRef: ref(null),
      isSavingRef: ref(false),
    };
    const session = { mode: 'project', dir: '' };
    const savesRunner = runner(() => useSaveProgress({
      ...refs,
      store,
      configuredWorkspaceDir: harness.workspace,
      useWorkspaceForNewProjects: true,
      captureWorkSession: () => session,
      isWorkSessionCurrent: (candidate) => candidate === session,
      setMediaLibraryPaths: (value) => { refs.mediaLibraryPathsRef.current = value; },
      autoSaveEnabled: false,
      autoSaveBackupLimit: 0,
      setSaveToast: noop,
      setRecentProjects: noop,
      maybeOfferTransferIntoProject: async (project) => ({ project, changed: false }),
      onProjectSaved: async () => {},
    }));
    const api = savesRunner.render();
    // Même lecture que l'hôte (`App.jsx`) : store du dernier rendu, projet lu
    // par `readProject`, aucun rendu entre l'enregistrement et la relecture.
    const readWork = () => ({
      project: store.readProject(),
      mediaLibraryPaths: refs.mediaLibraryPathsRef.current,
      mediaTags: store.mediaTags,
      savedSnapshot: refs.savedSnapshotRef.current,
      pristine: false,
    });
    harness.answerSave(harness.dir('Mon projet.mbah'));
    const choices = [];
    const barrier = duringWrite ? suspendFileReplacement() : null;
    try {
      const pending = askSaveBeforeLeave(readWork, () => api.handleSaveProjectAs(), async () => {
        choices.push('dialog');
        return choices.length === 1 ? 'save' : 'cancel';
      });
      if (barrier) {
        await barrier.entered;
        duringWrite(store);
        // L'écriture dure : React rend pendant ce temps, comme dans les cas
        // de sauvegarde périmée ci-dessus.
        store = storeRunner.render();
        savesRunner.render();
        barrier.release();
      }
      const allowed = await pending;
      const written = JSON.parse(await fs.readFile(harness.dir('Mon projet.mbah'), 'utf8'));
      return { allowed, questions: choices.length, written };
    } finally {
      barrier?.restore();
    }
  } finally {
    await harness.dispose();
  }
}

test('premier enregistrement en session projet : une seule question, départ permis', async () => {
  const { allowed, questions, written } = await firstSaveInProjectSession(null);
  assert.equal(questions, 1, 'tout est enregistré : la garde ne repose pas la question');
  assert.equal(allowed, true);
  assert.equal(written.projectName, 'Mon projet', 'le fichier a bien imposé son nom');
});

test('premier enregistrement en session projet : une modification pendant l’écriture ne laisse pas quitter', async () => {
  const { allowed, questions } = await firstSaveInProjectSession(
    (store) => store.updateItem('C', { name: 'Arrivée pendant l’écriture' }),
  );
  assert.equal(questions, 2, 'la garde redemande : le fichier ne porte pas la modification');
  assert.equal(allowed, false);
});

// Variantes de la question selon que le projet a déjà un fichier.
async function askedDialog(work) {
  let dialog = null;
  const allowed = await askSaveBeforeLeave(() => work, null, async (spec) => { dialog = spec; return 'cancel'; });
  return { allowed, dialog, labels: dialog?.actions.map((action) => action.label) };
}

test('projet jamais enregistré : question « Projet non enregistré »', async () => {
  const project = normalizeProjectData({ projectType: 'pack', projectName: 'Brouillon', rootEntries: [{ id: 'C', type: 'story', name: 'C' }] });
  const { allowed, dialog, labels } = await askedDialog({ project, savePath: null, projectName: 'Brouillon', pristine: false });
  assert.equal(allowed, false);
  assert.equal(dialog.title, 'Projet non enregistré');
  assert.equal(dialog.message, "Ton travail n'est pas enregistré et sera définitivement perdu.");
  assert.deepEqual(labels, ['Annuler', 'Quitter sans enregistrer', 'Enregistrer comme projet']);
});

test('projet déjà enregistré puis modifié : question « Modifications non enregistrées »', async () => {
  const project = normalizeProjectData({ projectType: 'pack', projectName: 'Mon pack', rootEntries: [{ id: 'C', type: 'story', name: 'C' }] });
  const { allowed, dialog, labels } = await askedDialog({
    project, savePath: 'C:/ws/Mon pack.mbah', projectName: 'Mon pack', savedSnapshot: 'autre', pristine: false,
  });
  assert.equal(allowed, false);
  assert.equal(dialog.title, 'Modifications non enregistrées');
  assert.equal(dialog.message, 'Les modifications de « Mon pack » depuis le dernier enregistrement seront perdues.');
  assert.deepEqual(labels, ['Annuler', 'Ne pas enregistrer', 'Enregistrer']);
});
