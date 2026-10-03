// Les raccourcis suivent l'éditeur ouvert.
//
// Le piège : `projectActionsVisible` veut dire « un projet est ouvert », et non
// « ce projet a un arbre ». Des raccourcis structurels — les trois bascules de
// panneaux et les options du pack — qui y seraient adossés feraient, dans
// l'éditeur graphe, écrire à `Ctrl+1/2/3` les **préférences de panneaux du
// Libre** au lieu de commander un panneau du graphe, et un panneau pourrait
// avoir disparu au retour dans l'autre éditeur.
//
// Ces tests exercent la vraie table de commandes du listener, avec la vraie
// table d'actions bâtie sur le vrai inventaire. Ce qui reste hors de leur
// portée est nommé : la frappe dans une fenêtre native part dans la recette.

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildShortcutActions } from '../src/hooks/useAppShortcutActions.js';
import { runShortcutCommand, SHORTCUT_COMMAND_IDS } from '../src/store/shortcutCommands.js';
import { buildToolbarInventory, toolbarAvailability } from '../src/store/toolbarModel.js';
import {
  WORKSPACE_MODE_ADVANCED,
  WORKSPACE_MODE_HIERARCHICAL,
} from '../src/store/projectWorkState.js';

// Les gestes structurels qu'un raccourci ne doit jamais atteindre depuis un
// éditeur qui ne les offre pas : les trois bascules écrivent les préférences de
// panneaux du Libre, qui n'existent pas côté graphe.
//
// **`storySettings` n'en fait pas partie.** Le tiroir d'options du
// pack sert les deux éditeurs : son raccourci doit donc répondre des deux
// côtés, et ne rien atteindre serait le défaut inverse.
const STRUCTURAL = ['toggleTree', 'toggleSettings', 'toggleDiagram'];

function harness({ workspaceMode, hasProjectTree, projectType }) {
  const reached = [];
  const trace = (name) => () => reached.push(name);

  const actions = buildShortcutActions({
    store: { canUndo: true, canRedo: true, addMenu: trace('addFolder') },
    modals: { open: trace('openModal'), toggle: trace('toggleModal') },
    workspaceViewState: {
      toggleTree: trace('toggleTree'),
      toggleSettings: trace('toggleSettings'),
      toggleDiagram: trace('toggleDiagram'),
      treeVisible: true,
      showDiagram: true,
    },
    setTreeSearchFocusTrigger: trace('treeSearchFocus'),
    setDiagramSearchFocusTrigger: trace('diagramSearchFocus'),
    commands: { newProject: trace('newProject'), openProject: trace('openProject'), undo: trace('undo'), redo: trace('redo') },
    handleAddStory: trace('importStories'),
    handleGenerate: trace('generate'),
    projectType,
    workspaceMode,
    advancedNodeListVisible: workspaceMode === WORKSPACE_MODE_ADVANCED,
    projectOpen: true,
    hasProjectTree,
    toolbarCommands: toolbarAvailability(buildToolbarInventory({
      workspaceMode,
      canUndo: true,
      canRedo: true,
    })),
    canImportStories: projectType === 'pack',
    canAddFolder: projectType === 'pack',
  });

  return { actions, reached };
}

const graph = () => harness({
  workspaceMode: WORKSPACE_MODE_ADVANCED,
  hasProjectTree: false,
  projectType: null,
});

const free = () => harness({
  workspaceMode: WORKSPACE_MODE_HIERARCHICAL,
  hasProjectTree: true,
  projectType: 'pack',
});

// ── Le contre-exemple : un raccourci qui atteint le Libre depuis le graphe ──

test('dans le graphe, aucun raccourci de panneau n’atteint son geste', () => {
  const { actions, reached } = graph();
  const verdicts = STRUCTURAL.map((id) => runShortcutCommand(id, actions));

  assert.deepEqual(verdicts, ['unavailable', 'unavailable', 'unavailable']);
  // Ce qui était atteint à tort (`toggleTree, toggleSettings, toggleDiagram`)
  // doit être vide.
  assert.deepEqual(reached, []);
});

test('dans le graphe, le raccourci du tiroir d’options du pack répond', () => {
  const { actions, reached } = graph();
  assert.equal(runShortcutCommand('storySettings', actions), 'ran');
  assert.deepEqual(reached, ['openModal']);
});

test('dans le libre, ces mêmes raccourcis répondent', () => {
  const { actions, reached } = free();
  for (const id of ['storySettings', ...STRUCTURAL]) {
    assert.equal(runShortcutCommand(id, actions), 'ran', id);
  }
  assert.deepEqual(reached, ['openModal', 'toggleTree', 'toggleSettings', 'toggleDiagram']);
});

test('la recherche de structure vise la liste des nœuds dans le graphe', () => {
  const graphHarness = graph();
  assert.equal(graphHarness.actions.treeSearchVisible, true);
  assert.equal(free().actions.treeSearchVisible, true);
  graphHarness.actions.focusTreeSearch();
  assert.deepEqual(graphHarness.reached, ['treeSearchFocus']);
});

// ── Ce que la table garantit au-delà du cas signalé ─────────────────────────

test('chaque commande de la table lit une disponibilité, et une indisponible n’avale pas la touche', () => {
  const { actions } = graph();
  for (const id of SHORTCUT_COMMAND_IDS) {
    const verdict = runShortcutCommand(id, actions);
    assert.ok(['ran', 'unavailable'].includes(verdict), `${id} → ${verdict}`);
  }
  // Un identifiant hors table est rendu tel quel : le listener ne le neutralise
  // pas et laisse la touche à qui la veut.
  assert.equal(runShortcutCommand('saveProject', actions), 'unknown');
  assert.equal(runShortcutCommand('treeSearch', actions), 'unknown');
});

test('les commandes universelles répondent des deux côtés, les propres d’un seul', () => {
  for (const build of [graph, free]) {
    const { actions } = build();
    assert.equal(actions.canOpenPreferences, true);
    assert.equal(actions.canUndo, true);
    assert.equal(actions.canRedo, true);
  }
  // La production est universelle. Son raccourci répond des deux côtés, parce
  // que son bouton y est rendu des deux côtés — et il appelle la même action
  // gardée que lui.
  assert.equal(graph().actions.canGenerate, true);
  assert.equal(free().actions.canGenerate, true);
  // La liste « à corriger » et son raccourci sont communs. Ils restent
  // ouvrables à zéro pour montrer un compteur honnête et, côté graphe,
  // conserver la qualification dans la même surface.
  assert.equal(graph().actions.canToggleValidation, true);
  assert.equal(free().actions.canToggleValidation, true);
  assert.equal(runShortcutCommand('toggleValidation', graph().actions), 'ran');
  assert.equal(runShortcutCommand('toggleValidation', free().actions), 'ran');
});

test('pendant un export, le graphe tient l’historique et laisse les préférences', () => {
  const locked = harness({
    workspaceMode: WORKSPACE_MODE_ADVANCED,
    hasProjectTree: false,
    projectType: null,
  });
  const held = buildShortcutActions({
    ...{
      store: { canUndo: true, canRedo: true, addMenu: () => {} },
      modals: { open: () => {}, toggle: () => {} },
      workspaceViewState: {
        toggleTree: () => {}, toggleSettings: () => {}, toggleDiagram: () => {},
        treeVisible: true, showDiagram: true,
      },
      setTreeSearchFocusTrigger: () => {},
      setDiagramSearchFocusTrigger: () => {},
      commands: { undo: () => {}, redo: () => {} },
      handleAddStory: () => {},
      handleGenerate: () => {},
      projectType: null,
      projectOpen: true,
      hasProjectTree: false,
      canImportStories: false,
      canAddFolder: false,
    },
    toolbarCommands: toolbarAvailability(buildToolbarInventory({
      workspaceMode: WORKSPACE_MODE_ADVANCED,
      canUndo: true,
      canRedo: true,
      editingLocked: true,
    })),
  });

  assert.equal(locked.actions.canUndo, true, 'hors export, Annuler répond');
  assert.equal(held.canUndo, false);
  assert.equal(held.canRedo, false);
  // La vue reste libre : le verrou d'auteur n'est pas un verrou d'écran.
  assert.equal(held.canOpenPreferences, true);
});
