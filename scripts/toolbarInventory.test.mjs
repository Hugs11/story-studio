// La barre unique.
//
// La preuve centrale est une liste : les commandes atteignables dressées
// dans chaque éditeur, en deux colonnes — ce qui est commun, ce qui est propre.
// Elle se lit sans connaître le code, et ces tests la fixent.
//
// Tout est pur : aucun React, aucun Tauri, aucun disque.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildToolbarInventory,
  isCommandAvailable,
  SUSPENDED_BY_EXPORT,
  SUSPENDED_BY_GESTURE,
  toolbarAvailability,
  TOOLBAR_GROUPS,
  TOOLBAR_SCOPE_STRUCTURAL,
  TOOLBAR_SCOPE_UNIVERSAL,
} from '../src/store/toolbarModel.js';
import {
  WORKSPACE_MODE_ADVANCED,
  WORKSPACE_MODE_HIERARCHICAL,
  WORKSPACE_MODE_HOME,
} from '../src/store/projectWorkState.js';

const LABELS = {
  newProject: 'Ctrl+N',
  openProject: 'Ctrl+O',
  openPack: 'Ctrl+Maj+P',
  saveProject: 'Ctrl+S',
  saveAs: 'Ctrl+Maj+S',
  undo: 'Ctrl+Z',
  redo: 'Ctrl+Maj+Z',
  tabOptions: 'Ctrl+Maj+O',
  generate: 'Ctrl+G',
  storySettings: 'Ctrl+,',
  toggleTree: 'Ctrl+1',
  toggleSettings: 'Ctrl+2',
  toggleDiagram: 'Ctrl+3',
  toggleValidation: 'Ctrl+Maj+E',
};

function inventory(workspaceMode, state = {}) {
  return buildToolbarInventory({
    workspaceMode,
    shortcutLabels: LABELS,
    canUndo: true,
    canRedo: true,
    ...state,
  });
}

const ids = (entries) => entries.map((entry) => entry.id);
const scoped = (entries, scope) => entries.filter((entry) => entry.scope === scope);

test('sans projet ouvert, il n’y a pas de barre du tout', () => {
  assert.deepEqual(buildToolbarInventory({ workspaceMode: WORKSPACE_MODE_HOME }), []);
  assert.deepEqual(buildToolbarInventory({}), []);
});

// ── Les deux colonnes ────────────────────────────────────────────────────────

test('les commandes universelles sont exactement les mêmes des deux côtés', () => {
  const free = scoped(inventory(WORKSPACE_MODE_HIERARCHICAL), TOOLBAR_SCOPE_UNIVERSAL);
  const graph = scoped(inventory(WORKSPACE_MODE_ADVANCED), TOOLBAR_SCOPE_UNIVERSAL);

  assert.deepEqual(ids(free), [
    'newProject', 'openProject', 'openPack', 'saveProject', 'saveProjectAs',
    'undo', 'redo',
    // Le tiroir d'options du pack sert les deux éditeurs : ils fabriquent le
    // même pack pour le même appareil, et le graphe n'a pas de second jeu de
    // réglages audio dans son tiroir d'export.
    'openPackOptions',
    // La liste « à corriger » a la place du Libre et le contenu riche du
    // graphe. Elle est universelle, au même rang.
    'toggleValidation',
    // La production est universelle — même identifiant, même libellé,
    // même rang des deux côtés. Seule sa réponse dépend de la chaîne.
    'generate',
    'openPreferences',
  ]);
  // Mêmes commandes, mêmes libellés, mêmes raccourcis, **et le même ordre** :
  // c'est l'ordre qui tient la promesse « un bouton universel ne bouge pas de
  // place entre les deux éditeurs ».
  assert.deepEqual(graph, free);
});

test('seuls les groupes liés à la structure changent', () => {
  const free = scoped(inventory(WORKSPACE_MODE_HIERARCHICAL), TOOLBAR_SCOPE_STRUCTURAL);
  const graph = scoped(inventory(WORKSPACE_MODE_ADVANCED), TOOLBAR_SCOPE_STRUCTURAL);

  assert.deepEqual(ids(free), [
    // La passerelle vers le graphe : l'arbre seul la porte, sans chemin inverse.
    'continueInGraph',
    'toggleTree', 'toggleSettings', 'toggleDiagram',
  ]);
  // Créer un Écran, une Action ou une construction dérivée ne passe plus par
  // cette barre : ces commandes vivent dans l'en-tête du panneau Graphe, à
  // portée de la surface qu'elles peuplent, et n'ont donc plus d'entrée ici.
  assert.deepEqual(ids(graph), ['toggleNodeList', 'toggleInspector']);

  // Aucune commande propre à un éditeur n'apparaît dans l'autre.
  const shared = ids(free).filter((id) => ids(graph).includes(id));
  assert.deepEqual(shared, []);
});

test('l’éditeur graphe atteint les préférences, que seul le tiroir d’options portait', () => {
  // Les préférences ne passent pas que par la passerelle du tiroir d'options
  // du pack — un groupe structurel que le graphe n'a pas.
  const graph = inventory(WORKSPACE_MODE_ADVANCED);
  const preferences = graph.find((entry) => entry.id === 'openPreferences');
  assert.equal(preferences.scope, TOOLBAR_SCOPE_UNIVERSAL);
  assert.equal(preferences.group, TOOLBAR_GROUPS.PREFERENCES);
  assert.equal(preferences.available, true);
  assert.equal(preferences.shortcut, LABELS.tabOptions);
});

test('l’éditeur libre gagne Annuler et Rétablir', () => {
  const free = inventory(WORKSPACE_MODE_HIERARCHICAL);
  assert.equal(isCommandAvailable(free, 'undo'), true);
  assert.equal(isCommandAvailable(free, 'redo'), true);

  const empty = inventory(WORKSPACE_MODE_HIERARCHICAL, { canUndo: false, canRedo: false });
  assert.equal(isCommandAvailable(empty, 'undo'), false);
  assert.equal(isCommandAvailable(empty, 'redo'), false);
});

// ── Suspendre n'est pas masquer ─────────────────────────────────────────────

test('pendant un export, les commandes tenues restent listées et disent pourquoi', () => {
  const locked = inventory(WORKSPACE_MODE_ADVANCED, { editingLocked: true });
  const table = toolbarAvailability(locked);

  for (const id of ['newProject', 'openProject', 'openPack', 'saveProject', 'saveProjectAs', 'undo', 'redo']) {
    assert.equal(table[id].available, false, `${id} doit être suspendue pendant un export`);
    assert.equal(table[id].unavailableReason, SUSPENDED_BY_EXPORT, `${id} doit dire pourquoi`);
  }

  // Masquer serait le défaut : l'auteur doit voir la commande et sa raison.
  assert.deepEqual(ids(locked), ids(inventory(WORKSPACE_MODE_ADVANCED)));

  // La vue reste libre : ce verrou n'est pas un verrou d'écran.
  assert.equal(table.openPreferences.available, true);

  // **La production aussi est suspendue.** L'édition est bloquée du
  // clic jusqu'à l'archive, attente dans la file comprise : un second départ
  // trouverait l'auteur déjà bloqué et capturerait la même révision une seconde
  // fois. La commande reste listée et dit pourquoi, comme les autres.
  assert.equal(table.generate.available, false);
  assert.equal(table.generate.unavailableReason, SUSPENDED_BY_EXPORT);
});

test('le Libre n’a pas de verrou : sa production ne se suspend jamais', () => {
  // `editingLocked` est un état, pas une branche par éditeur. La chaîne Libre
  // n'a pas de verrou d'auteur et enfile autant de travaux que l'auteur en
  // demande ; la valeur ne doit rien changer pour elle.
  const table = toolbarAvailability(inventory(WORKSPACE_MODE_HIERARCHICAL, { editingLocked: true }));
  assert.equal(table.generate.available, true);
});

test('un geste en vol et un export en cours ne se disent pas pareil', () => {
  const busy = toolbarAvailability(inventory(WORKSPACE_MODE_ADVANCED, { gestureBusy: true }));
  assert.equal(busy.undo.unavailableReason, SUSPENDED_BY_GESTURE);
  const locked = toolbarAvailability(inventory(WORKSPACE_MODE_ADVANCED, { editingLocked: true }));
  assert.equal(locked.undo.unavailableReason, SUSPENDED_BY_EXPORT);
  // Un geste dure un aller-retour : il ne retient pas le fichier, seulement
  // l'édition du document.
  assert.equal(busy.saveProject.available, true);
  assert.equal(busy.undo.available, false);
});

test('une commande disponible ne porte jamais de raison d’indisponibilité', () => {
  for (const mode of [WORKSPACE_MODE_HIERARCHICAL, WORKSPACE_MODE_ADVANCED]) {
    for (const entry of inventory(mode)) {
      if (entry.available) assert.equal(entry.unavailableReason, null, entry.id);
      else assert.ok(entry.unavailableReason, `${entry.id} doit dire pourquoi`);
    }
  }
});

// ── Un seul bouton de production ─────────────────────────────────────────────

test('la production porte le même identifiant, le même libellé et le même rang des deux côtés', () => {
  const free = inventory(WORKSPACE_MODE_HIERARCHICAL);
  const graph = inventory(WORKSPACE_MODE_ADVANCED);
  const freeGenerate = free.find((entry) => entry.id === 'generate');
  const graphGenerate = graph.find((entry) => entry.id === 'generate');

  assert.equal(freeGenerate.label, 'Générer le pack');
  // Même libellé : l'auteur rencontre **une** commande, pas deux noms pour la
  // même intention.
  assert.deepEqual(graphGenerate, freeGenerate);
  assert.equal(graphGenerate.group, TOOLBAR_GROUPS.PRODUCTION);
  assert.equal(graphGenerate.scope, TOOLBAR_SCOPE_UNIVERSAL);
  assert.equal(graphGenerate.shortcut, LABELS.generate);

  // Le rang : la production est la dernière avant les préférences des deux
  // côtés. C'est lui qui tient « au même endroit ».
  assert.equal(ids(free).at(-2), 'generate');
  assert.equal(ids(graph).at(-2), 'generate');
  assert.equal(ids(free).at(-1), 'openPreferences');
  assert.equal(ids(graph).at(-1), 'openPreferences');
});

test('l’ancienne commande d’export du graphe n’existe plus nulle part', () => {
  for (const mode of [WORKSPACE_MODE_HIERARCHICAL, WORKSPACE_MODE_ADVANCED]) {
    assert.equal(inventory(mode).some((entry) => entry.id === 'exportPack'), false);
  }
});

test('la production est indisponible dans les deux éditeurs quand des corrections sont requises', () => {
  const blockedFree = toolbarAvailability(inventory(WORKSPACE_MODE_HIERARCHICAL, { generateDisabled: true }));
  assert.equal(blockedFree.generate.available, false);

  const graph = toolbarAvailability(inventory(WORKSPACE_MODE_ADVANCED, { generateDisabled: true }));
  assert.equal(graph.generate.available, false);
  assert.match(graph.generate.unavailableReason, /à corriger/);
});

test('le graphe attend une qualification courante avant de proposer la production', () => {
  const pending = toolbarAvailability(inventory(WORKSPACE_MODE_ADVANCED, { generatePending: true }));
  assert.equal(pending.generate.available, false);
  assert.match(pending.generate.unavailableReason, /Vérification/);
});

test('côté graphe, la production attend que le document ait été lu une fois', () => {
  // La fiche du pack et la qualification lisent toutes deux le document, chargé
  // paresseusement. Avant sa première lecture, la production n'aurait ni fiche
  // à ouvrir ni qualification à interroger.
  const unread = toolbarAvailability(inventory(WORKSPACE_MODE_ADVANCED, { documentUnread: true }));
  assert.equal(unread.generate.available, false);
  assert.match(unread.generate.unavailableReason, /Lecture du document/);

  const read = toolbarAvailability(inventory(WORKSPACE_MODE_ADVANCED));
  assert.equal(read.generate.available, true);
  assert.equal(read.generate.unavailableReason, null);

  // Et cet état-là ne traverse pas non plus : le Libre n'a pas de document
  // chargé paresseusement, sa porte reste la liste des problèmes.
  const free = toolbarAvailability(inventory(WORKSPACE_MODE_HIERARCHICAL, { documentUnread: true }));
  assert.equal(free.generate.available, true);
});

// ── Les verrous propres au libre ────────────────────────────────────────────

test('la production libre reste tenue par la liste des problèmes', () => {
  const blocked = toolbarAvailability(inventory(WORKSPACE_MODE_HIERARCHICAL, { generateDisabled: true }));
  assert.equal(blocked.generate.available, false);
  assert.match(blocked.generate.unavailableReason, /à corriger/);
});

test('la liste à corriger reste ouvrable à zéro dans les deux éditeurs', () => {
  const clean = toolbarAvailability(inventory(WORKSPACE_MODE_HIERARCHICAL));
  const graph = toolbarAvailability(inventory(WORKSPACE_MODE_ADVANCED));
  assert.equal(clean.toggleValidation.available, true);
  assert.equal(graph.toggleValidation.available, true);
  assert.equal(clean.toggleValidation.unavailableReason, null);
  assert.equal(graph.toggleValidation.unavailableReason, null);
});

test('chaque commande universelle porte son raccourci, identique des deux côtés', () => {
  const free = toolbarAvailability(inventory(WORKSPACE_MODE_HIERARCHICAL));
  const graph = inventory(WORKSPACE_MODE_ADVANCED);
  assert.ok(free.saveProject);
  for (const entry of scoped(graph, TOOLBAR_SCOPE_UNIVERSAL)) {
    assert.ok(entry.shortcut, `${entry.id} doit porter un raccourci`);
  }
});
