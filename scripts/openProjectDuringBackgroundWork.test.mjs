// Ouverture de projet : la garde du travail en cours précède la sauvegarde.
//
// Un travail de fond tourne (génération en file, voix, import) sur un projet
// non enregistré, dont les médias vivent dans le dossier de session. « Retour à
// l'accueil » et « Retour au catalogue » posent d'abord la question « Un travail
// est encore en cours » (`useProjectLifecycle.leaveProject`). « Ouvrir un
// projet » (menu Projet, Ctrl+O, récents, notification d'abonnement, catalogue)
// ne la pose pas : le dossier de session est nettoyé sous le travail en cours.
//
// L'oracle suppose que la correction passe la même garde à `useProjectLoading`
// sous le nom `confirmBackgroundWork` (celui de `useProjectLifecycle`). Si elle
// prend un autre nom, adapter l'appel sans changer l'attente.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { runner } from './reactHookDriver.mjs';
import { createDiskHarness } from './tauriDiskHarness.mjs';

const { useProjectStore } = await import('../src/store/projectStore.js');
const { useProjectLoading } = await import('../src/hooks/useProjectLoading.js');
const { useProjectLifecycle } = await import('../src/hooks/useProjectLifecycle.js');
const noop = () => {};

async function mount({ backgroundAnswer }) {
  const disk = await createDiskHarness();
  const other = disk.dir('documents', 'Autre.mbah');
  await fs.writeFile(other, JSON.stringify({
    schemaVersion: 3, projectType: 'pack', projectName: 'Autre',
    packMetadata: { title: 'Autre', version: 1, uuid: '22222222-2222-4222-8222-222222222222' },
    rootEntries: [{ id: 's', type: 'story', name: 'Histoire' }],
  }));
  const calls = [];
  let store; let loading;
  const app = runner(() => {
    store = useProjectStore();
    loading = useProjectLoading({
      store, sdStore: { clearDone: noop }, xttsStore: { clearDone: noop },
      setMediaLibraryPaths: noop, setRecentProjects: noop,
      savedSnapshotRef: { current: null }, autoSavePathRef: { current: null }, autoSaveSnapshotRef: { current: null },
      setAutoSavedPath: noop, showErrorDialog: (dialog) => calls.push(['error', dialog]),
      // Projet d'import intact (« Modifier un pack ») : rien à enregistrer, la
      // garde de sauvegarde laisse partir sans question.
      confirmSaveBeforeLeaveCurrent: async () => { calls.push('saveGuard'); return true; },
      handleSaveProject: noop,
      // Le nettoyage du dossier de session (`cleanupEphemeralSession`).
      onBeforeProjectReplaced: async () => { calls.push('sessionCleaned'); },
      // La question « Un travail est encore en cours » ; l'auteur reste.
      confirmBackgroundWork: async () => { calls.push('background'); return backgroundAnswer; },
    });
  });
  app.render(); app.flush();
  return { app, calls, other, read: () => store.readProject(), loading: () => loading };
}

test('ouvrir un autre projet pendant un travail de fond pose la question avant de nettoyer la session', async () => {
  const { app, calls, other, loading } = await mount({ backgroundAnswer: false });
  try {
    const opened = await loading().handleLoadRecent(other);
    assert.deepEqual(calls.filter(call => typeof call === 'string'), ['background'],
      'la question du travail en cours précède tout, et « Rester » ne nettoie rien');
    assert.equal(opened, false, 'le projet courant reste en place');
  } finally { app.unmount(); }
});

test('témoin — sans travail de fond, le projet s’ouvre et la session est nettoyée', async () => {
  const { app, calls, other, loading, read } = await mount({ backgroundAnswer: true });
  try {
    const opened = await loading().handleLoadRecent(other);
    assert.equal(opened, true, JSON.stringify(calls));
    assert.ok(calls.includes('sessionCleaned'));
    assert.equal(read().projectName, 'Autre');
  } finally { app.unmount(); }
});

test('ouvrir par le dialogue ne propose aucune sauvegarde quand l’auteur reste', async () => {
  const { app, calls, loading, read } = await mount({ backgroundAnswer: false });
  try {
    const before = read();
    await loading().handleLoad();
    assert.deepEqual(calls, ['background']);
    assert.equal(read(), before);
  } finally { app.unmount(); }
});

test('la garde partagée des ouvertures de pack demande l’accord avant la sauvegarde', async () => {
  const calls = [];
  let answer = false;
  const app = runner(() => useProjectLifecycle({
    confirmBackgroundWork: async () => { calls.push('background'); return answer; },
    askSaveBeforeLeaveCurrent: async () => { calls.push('save'); return true; },
    setImportNotice: noop,
  }));
  try {
    const api = app.render();
    assert.equal(await api.confirmProjectReplacement(), false);
    assert.deepEqual(calls, ['background']);
    answer = true;
    calls.length = 0;
    assert.equal(await api.confirmProjectReplacement(), true);
    assert.deepEqual(calls, ['background', 'save']);
  } finally { app.unmount(); }
});
