// « Ignorer cette reprise » (croix de la ligne de reprise à l'accueil).
//
// L'effet est la suppression définitive du dossier de session : instantané de
// reprise et médias de session. Le hook `useWorkSession` intact demande donc
// une confirmation, par la boîte de choix de l'app, avant tout nettoyage.
// Seuls l'ordonnanceur React, le transport IPC et la boîte sont doublés.

import test from 'node:test';
import assert from 'node:assert/strict';
import { runner } from './reactHookDriver.mjs';
import './tauriDiskHarness.mjs';

const { useProjectStore } = await import('../src/store/projectStore.js');
const { useWorkSession } = await import('../src/hooks/useWorkSession.js');

const noop = () => {};
const ref = (current) => ({ current });

function mount(answer) {
  const previousInvoke = window.__TAURI_INTERNALS__.invoke;
  const cleanups = [];
  window.__TAURI_INTERNALS__.invoke = async (command, args) => {
    if (command === 'cleanup_session_workspace') {
      cleanups.push(args.path);
      return null;
    }
    throw new Error(`commande non doublée : ${command}`);
  };
  const dialogs = [];
  const app = runner(() => {
    const store = useProjectStore();
    return useWorkSession({
      store,
      sdStore: { clearDone: noop },
      xttsStore: { clearDone: noop },
      showErrorDialog: noop,
      showChoiceDialog: async (dialog) => { dialogs.push(dialog); return answer; },
      useWorkspaceForNewProjects: false,
      configuredWorkspaceDir: 'C:/ws',
      setConfiguredWorkspaceDir: noop,
      setWorkspaceDirState: noop,
      workspaceDirRef: ref(''),
      savedSnapshotRef: ref(null),
      autoSavePathRef: ref(null),
      autoSaveSnapshotRef: ref(null),
      setAutoSavedPath: noop,
      setMediaLibraryPaths: noop,
      mediaLibraryCountRef: ref(0),
      mediaLibraryPaths: [],
      mediaTags: {},
      currentWorkSnapshot: null,
      importedPackPendingMetaRef: ref(false),
    });
  });
  return {
    session: app.render(),
    cleanups,
    dialogs,
    restore: () => { window.__TAURI_INTERNALS__.invoke = previousInvoke; },
  };
}

const recovery = { sessionDir: 'C:/sessions/ancienne', snapshotPath: 'C:/sessions/ancienne/reprise.mbah' };

test('ignorer une reprise demande confirmation ; Annuler ne supprime rien', async () => {
  const c = mount('cancel');
  try {
    await c.session.handleIgnoreSessionRecovery(recovery);
    assert.equal(c.dialogs.length, 1, 'une confirmation est demandée');
    const [dialog] = c.dialogs;
    assert.equal(dialog.message, 'Supprimer définitivement ce travail non enregistré ?');
    assert.deepEqual(dialog.actions.map((action) => action.label), ['Annuler', 'Supprimer']);
    assert.equal(dialog.cancelValue, 'cancel');
    assert.deepEqual(c.cleanups, [], 'aucune suppression sans confirmation');
  } finally {
    c.restore();
  }
});

test('confirmer « Supprimer » supprime le dossier de la session', async () => {
  const c = mount('delete');
  try {
    await c.session.handleIgnoreSessionRecovery(recovery);
    assert.equal(c.dialogs.length, 1);
    assert.deepEqual(c.cleanups, ['C:/sessions/ancienne']);
  } finally {
    c.restore();
  }
});
