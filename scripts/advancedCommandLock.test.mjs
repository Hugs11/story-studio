// Le verrou d'auteur appliqué aux commandes.
//
// Tout est **pur** : ni React, ni DOM, ni Tauri. Ces tests éprouvent un défaut
// réel : la barre avancée désactivait ses boutons pendant un export, mais la
// table globale exposait `store.undo`, `store.redo` et leurs disponibilités
// brutes, et `useAppShortcuts` les invoquait sans rien consulter. L'export est
// un panneau, pas une modale : la garde des modales ne bloquait pas ce chemin.
//
// Deux choses sont donc vérifiées ensemble : la commande est tenue, et la table
// l'annonce indisponible. Une seule des deux laisserait soit un raccourci qui
// agit, soit un bouton actif qui ne répond pas.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AUTHOR_LOCKED_COMMANDS,
  isAuthorLockedCommand,
  lockAuthorCommands,
} from '../src/store/advancedAuthoring/commandLock.js';
import { buildShortcutActions } from '../src/hooks/useAppShortcutActions.js';
import { buildToolbarInventory, toolbarAvailability } from '../src/store/toolbarModel.js';
import { WORKSPACE_MODE_ADVANCED } from '../src/store/projectWorkState.js';

function tracer() {
  const calls = [];
  const command = (name) => (...args) => { calls.push([name, ...args]); return `${name}-fait`; };
  return { calls, command };
}

test('les commandes qui changent le document ou le projet sont tenues, les autres non', () => {
  assert.deepEqual([...AUTHOR_LOCKED_COMMANDS].sort(), [
    'newProject', 'openPack', 'openProject', 'openRecentProject', 'redo', 'save', 'saveAs', 'undo',
  ]);
  // La vue et la sortie de l'export ne sont pas des mutations : les tenir ferait
  // du verrou d'auteur un verrou d'écran.
  for (const free of ['toggleDiagram', 'focusTreeSearch', 'cancelExport', 'openReview']) {
    assert.equal(isAuthorLockedCommand(free), false, `${free} doit rester libre`);
  }
});

test('pendant le verrou, une commande tenue ne part pas et rend null', () => {
  const { calls, command } = tracer();
  let locked = false;
  const refused = [];
  const guarded = lockAuthorCommands(
    {
      undo: command('undo'),
      redo: command('redo'),
      save: command('save'),
      saveAs: command('saveAs'),
      newProject: command('newProject'),
      openProject: command('openProject'),
      openPack: command('openPack'),
      openRecentProject: command('openRecentProject'),
      toggleDiagram: command('toggleDiagram'),
    },
    () => locked,
    (name) => refused.push(name),
  );

  assert.equal(guarded.undo(), 'undo-fait');
  calls.length = 0;

  locked = true;
  for (const name of AUTHOR_LOCKED_COMMANDS) {
    assert.equal(guarded[name](), null, `${name} doit être refusée pendant l'export`);
  }
  assert.deepEqual(calls, [], 'aucune commande tenue n’a été exécutée');
  assert.deepEqual(refused, [...AUTHOR_LOCKED_COMMANDS]);

  // La vue reste libre pendant ce temps.
  assert.equal(guarded.toggleDiagram(), 'toggleDiagram-fait');

  locked = false;
  assert.equal(guarded.save('chemin'), 'save-fait');
  assert.deepEqual(calls, [['toggleDiagram'], ['save', 'chemin']]);
});

test('le verrou est relu à chaque appel, jamais capturé', () => {
  const { calls, command } = tracer();
  let locked = false;
  const guarded = lockAuthorCommands({ undo: command('undo') }, () => locked);
  // La table est construite avant l'export ; le verrou est pris ensuite, et une
  // frappe peut arriver avant le rendu suivant.
  locked = true;
  assert.equal(guarded.undo(), null);
  assert.deepEqual(calls, []);
});

test('ce qui n’est pas une fonction traverse la table inchangé', () => {
  const guarded = lockAuthorCommands({ undo: null, canUndo: true }, () => true);
  assert.equal(guarded.undo, null);
  assert.equal(guarded.canUndo, true);
});

// ── La table que les listeners clavier lisent ────────────────────────────────

function shortcutTable({ locked }) {
  const { calls, command } = tracer();
  const commands = lockAuthorCommands(
    {
      undo: command('undo'),
      redo: command('redo'),
      newProject: command('newProject'),
      openProject: command('openProject'),
    },
    () => locked,
  );
  const actions = buildShortcutActions({
    store: { canUndo: true, canRedo: true, addMenu: command('addMenu') },
    modals: { open: command('openModal'), toggle: command('toggleModal') },
    workspaceViewState: {
      toggleTree: command('toggleTree'),
      toggleSettings: command('toggleSettings'),
      toggleDiagram: command('toggleDiagram'),
      treeVisible: true,
      showDiagram: true,
    },
    setTreeSearchFocusTrigger: command('treeSearchFocus'),
    setDiagramSearchFocusTrigger: command('diagramSearchFocus'),
    commands,
    // Les disponibilités communes viennent de l'inventaire de la barre unique
    // — la même source que les boutons. Le test éprouve ainsi la **parité**
    // bouton/clavier, et non une table clavier recalculée de son côté.
    toolbarCommands: toolbarAvailability(buildToolbarInventory({
      workspaceMode: WORKSPACE_MODE_ADVANCED,
      canUndo: true,
      canRedo: true,
      editingLocked: locked,
    })),
    projectOpen: true,
    handleAddStory: command('addStory'),
    handleGenerate: command('generate'),
    projectType: null,
    canImportStories: false,
    canAddFolder: false,
    totalIssues: 0,
  });
  return { actions, calls };
}

test('hors export, la table clavier annonce et exécute Annuler et Rétablir', () => {
  const { actions, calls } = shortcutTable({ locked: false });
  assert.equal(actions.canUndo, true);
  assert.equal(actions.canRedo, true);
  actions.undo();
  actions.redo();
  assert.deepEqual(calls, [['undo'], ['redo']]);
});

test('pendant un export, le clavier ne contourne plus le verrou', () => {
  const { actions, calls } = shortcutTable({ locked: true });
  // La disponibilité dit la même chose que la commande : `useAppShortcuts`
  // s'arrête sur `canUndo`, et la commande refuserait de toute façon.
  assert.equal(actions.canUndo, false);
  assert.equal(actions.canRedo, false);
  assert.equal(actions.undo(), null);
  assert.equal(actions.redo(), null);
  assert.equal(actions.newProject(), null);
  assert.equal(actions.openProject(), null);
  assert.deepEqual(calls, [], 'rien n’a atteint le store ni les transitions de projet');
});

test('la navigation de vue reste atteignable au clavier pendant un export', () => {
  const { actions, calls } = shortcutTable({ locked: true });
  actions.toggleDiagram();
  actions.toggleTree();
  actions.toggleSettings();
  assert.deepEqual(calls, [['toggleDiagram'], ['toggleTree'], ['toggleSettings']],
    'le verrou d’auteur n’est pas un verrou d’écran');
});
