import { translateCommon as t } from '../i18n/commonPresentation.js';
// L'inventaire des commandes de la barre — un seul, pour les deux éditeurs.
//
// Une barre qui mêlerait l'universel et le structurel serait inutilisable telle
// quelle sur un projet graphe : les panneaux et les
// panneaux de validation du Libre désignent un arbre.
//
// Ce module sépare les deux, et c'est tout son objet :
//
// - **universel** — fichier, annuler/rétablir, production,
//   préférences. Ces commandes sont disponibles dans les deux éditeurs. Les
//   préférences s’ouvrent dans la barre de titre et gardent leur raccourci ;
//   les autres commandes visibles restent au même rang dans la barre.
// - **structurel** — ce qui dépend de la forme du document. L'arbre a ses
//   panneaux ; le graphe a sa liste, ses réglages et ses créations de nœuds.
//   La commande « À corriger » reste universelle, tandis que son contenu
//   s'adapte à la forme du projet.
//
// L'inventaire est une **donnée**, pas un rendu : la barre le peint, la table
// des raccourcis y lit ses disponibilités, et un test le dresse dans les deux
// éditeurs sans monter React. C'est la preuve centrale du lot — la liste des
// commandes atteignables de chaque côté, avec ce qui est commun et ce qui est
// propre.
//
// **Suspendre n'est pas masquer.** Pendant un export, les commandes qui
// changeraient le document ou le projet restent visibles et désactivées, avec
// leur raison à côté : l'auteur doit comprendre pourquoi une commande ne répond
// pas. Ce comportement vient de la barre avancée et il est conservé tel quel.

import {
  WORKSPACE_MODE_ADVANCED,
  WORKSPACE_MODE_HIERARCHICAL,
} from './projectWorkState.js';

export const TOOLBAR_SCOPE_UNIVERSAL = 'universal';
export const TOOLBAR_SCOPE_STRUCTURAL = 'structural';

// Groupes de l'inventaire, dans leur ordre. `PREFERENCES` reste ici pour
// l'état du raccourci ; son accès visuel est dans la barre de titre.
export const TOOLBAR_GROUPS = Object.freeze({
  FILE: 'file',
  HISTORY: 'history',
  PANELS: 'panels',
  ISSUES: 'issues',
  PRODUCTION: 'production',
  PREFERENCES: 'preferences',
});

// Les raisons de suspension, écrites une fois. Elles sont rendues à côté de la
// commande, jamais à la place.
// La fabrication d'un pack graphe commence au clic et se termine à l'archive,
// attente dans la file comprise : la raison le dit dans ces mots-là.
export const SUSPENDED_BY_EXPORT_KEY = 'common:toolbar.export.suspended';
export const SUSPENDED_BY_GESTURE_KEY = 'common:toolbar.gesture.suspended';
const NO_HISTORY_BACK_KEY = 'common:toolbar.undo.unavailable';
const NO_HISTORY_FORWARD_KEY = 'common:toolbar.redo.unavailable';
const ISSUES_BEFORE_GENERATE_KEY = 'common:toolbar.generate.blocked';
const CHECKING_BEFORE_GENERATE_KEY = 'common:toolbar.generate.checking';
// Côté graphe, la fiche du pack et la qualification lisent toutes deux le
// document, qui est chargé paresseusement. Tant qu'il n'a pas été lu une fois,
// la production n'aurait ni fiche à remplir ni qualification à interroger.
const DOCUMENT_NOT_READ_KEY = 'common:toolbar.document.loading';

function command(id, labelKey, scope, group, { shortcut = null, available = true, reason = null } = {}) {
  return Object.freeze({
    id,
    labelKey,
    get label() { return t(labelKey); },
    scope,
    group,
    shortcut,
    available,
    // La raison n'existe que quand la commande ne répond pas. Une raison portée
    // par une commande disponible finirait par être affichée à tort.
    get unavailableReason() { return available ? null : (reason === SUSPENDED_BY_EXPORT_KEY || reason === SUSPENDED_BY_GESTURE_KEY ? reason : t(reason)); },
  });
}

/**
 * L'inventaire complet, pour l'éditeur décrit par `workspaceMode`.
 *
 * Rend une liste **ordonnée** pour la barre et les raccourcis. Les commandes
 * visibles gardent le même rang des deux côtés ; `openPreferences` fournit
 * l'état du raccourci dont l'accès visuel est dans la barre de titre.
 *
 * Sans projet ouvert, l'inventaire est vide : il n'y a pas de barre à l'accueil.
 */
export function buildToolbarInventory({
  workspaceMode,
  shortcutLabels = {},
  canUndo = false,
  canRedo = false,
  // Vrai pendant qu'un export avancé écrit l'archive. Le mode Libre n'a pas de
  // verrou équivalent aujourd'hui et passe donc `false` : c'est un état, pas
  // une branche par éditeur.
  editingLocked = false,
  // Vrai le temps d'un aller-retour de geste d'auteur.
  gestureBusy = false,
  generateDisabled = false,
  generatePending = false,
  // Vrai tant que l'espace avancé n'a pas publié sa première lecture du
  // document. Propre au graphe, et distinct de `generateDisabled` : la porte du
  // Libre ne traverse toujours pas d'un éditeur à l'autre.
  documentUnread = false,
} = {}) {
  const hierarchical = workspaceMode === WORKSPACE_MODE_HIERARCHICAL;
  const advanced = workspaceMode === WORKSPACE_MODE_ADVANCED;
  if (!hierarchical && !advanced) return [];

  // Un geste dure un aller-retour, un export dure une archive : les deux
  // suspendent l'édition, et l'interface ne les confond pas dans son message.
  const editingSuspended = gestureBusy || editingLocked;
  const suspensionReason = editingLocked ? SUSPENDED_BY_EXPORT_KEY : SUSPENDED_BY_GESTURE_KEY;

  const commands = [];
  const universal = (id, label, group, options) => {
    commands.push(command(id, label, TOOLBAR_SCOPE_UNIVERSAL, group, options));
  };
  const structural = (id, label, group, options) => {
    commands.push(command(id, label, TOOLBAR_SCOPE_STRUCTURAL, group, options));
  };

  // ── Fichier ───────────────────────────────────────────────────────────────
  // Changer de projet pendant un export laisserait l'archive en cours sans
  // document auquel l'attribuer : ces commandes attendent la fin, ou l'arrêt.
  const fileAvailable = !editingLocked;
  universal('returnToCatalogue', 'catalogue:open.return.label', TOOLBAR_GROUPS.FILE, { shortcut: shortcutLabels.returnToCatalogue ?? null, available: fileAvailable, reason: SUSPENDED_BY_EXPORT_KEY });
  universal('newProject', 'common:project.home.label', TOOLBAR_GROUPS.FILE, {
    shortcut: shortcutLabels.newProject ?? null,
    available: fileAvailable,
    reason: SUSPENDED_BY_EXPORT_KEY,
  });
  universal('openProject', 'common:project.open.label', TOOLBAR_GROUPS.FILE, {
    shortcut: shortcutLabels.openProject ?? null,
    available: fileAvailable,
    reason: SUSPENDED_BY_EXPORT_KEY,
  });
  universal('openPack', 'common:project.openPack.label', TOOLBAR_GROUPS.FILE, {
    shortcut: shortcutLabels.openPack ?? null,
    available: fileAvailable,
    reason: SUSPENDED_BY_EXPORT_KEY,
  });
  universal('saveProject', 'common:project.save.label', TOOLBAR_GROUPS.FILE, {
    shortcut: shortcutLabels.saveProject ?? null,
    available: fileAvailable,
    reason: SUSPENDED_BY_EXPORT_KEY,
  });
  universal('saveProjectAs', 'common:project.saveAs.label', TOOLBAR_GROUPS.FILE, {
    shortcut: shortcutLabels.saveAs ?? null,
    available: fileAvailable,
    reason: SUSPENDED_BY_EXPORT_KEY,
  });
  // La passerelle vers le graphe part de l'arbre seulement : elle crée une
  // copie graphe du projet, et il n'existe pas de chemin inverse.
  if (hierarchical) {
    structural('continueInGraph', 'common:project.continueInGraph.label', TOOLBAR_GROUPS.FILE, {
      available: fileAvailable,
      reason: SUSPENDED_BY_EXPORT_KEY,
    });
  }

  // ── Historique ────────────────────────────────────────────────────────────
  universal('undo', 'common:toolbar.undo.label', TOOLBAR_GROUPS.HISTORY, {
    shortcut: shortcutLabels.undo ?? null,
    available: canUndo && !editingSuspended,
    reason: editingSuspended ? suspensionReason : NO_HISTORY_BACK_KEY,
  });
  universal('redo', 'common:toolbar.redo.label', TOOLBAR_GROUPS.HISTORY, {
    shortcut: shortcutLabels.redo ?? null,
    available: canRedo && !editingSuspended,
    reason: editingSuspended ? suspensionReason : NO_HISTORY_FORWARD_KEY,
  });

  // ── Structure ─────────────────────────────────────────────────────────────
  if (hierarchical) {
    structural('toggleTree', 'common:toolbar.tree.toggle', TOOLBAR_GROUPS.PANELS, {
      shortcut: shortcutLabels.toggleTree ?? null,
    });
    structural('toggleSettings', 'common:toolbar.settings.toggle', TOOLBAR_GROUPS.PANELS, {
      shortcut: shortcutLabels.toggleSettings ?? null,
    });
    structural('toggleDiagram', 'common:toolbar.diagram.toggle', TOOLBAR_GROUPS.PANELS, {
      shortcut: shortcutLabels.toggleDiagram ?? null,
    });
  }

  if (advanced) {
    // Le graphe reste la surface principale et n'a donc pas de commande
    // de fermeture. La liste de nœuds et l'inspecteur reprennent le même groupe
    // de panneaux que le Libre, avec une préférence distincte par éditeur.
    structural('toggleNodeList', 'common:toolbar.nodeList.toggle', TOOLBAR_GROUPS.PANELS);
    structural('toggleInspector', 'common:toolbar.settings.toggle', TOOLBAR_GROUPS.PANELS);
    // Créer un Écran, une Action ou une construction dérivée **ne passe plus
    // par cette barre** : ces commandes vivent dans l'en-tête du panneau Graphe,
    // à portée de la surface qu'elles peuplent. Elles n'ont pas de raccourci
    // clavier, donc rien ici n'en dépendait — et une entrée d'inventaire que
    // personne ne rend serait un piège pour la prochaine lecture.
    //
    // La raison de leur suspension, elle, reste partagée : l'en-tête lit les
    // mêmes constantes `SUSPENDED_BY_*`, pour que le bouton déplacé ne puisse
    // pas se mettre à expliquer son refus autrement que la barre ne le faisait.
  }

  // Une seule liste « à corriger », au même rang et sous le même
  // raccourci dans les deux éditeurs. Elle reste ouvrable à zéro : le compteur
  // dit alors honnêtement qu'il n'y a rien, et côté graphe la même surface
  // conserve la qualification du document. La disponibilité ne doit donc pas
  // être recalculée à partir d'une famille de diagnostics particulière.
  universal('toggleValidation', 'common:toolbar.issues.label', TOOLBAR_GROUPS.ISSUES, {
    shortcut: shortcutLabels.toggleValidation ?? null,
  });

  // ── Production ────────────────────────────────────────────────────────────
  // **Un seul bouton**, au même rang et sous le même libellé des deux côtés.
  // C'est une commande universelle au sens de ce module : elle existe dès qu'un
  // projet est ouvert, et elle ne bouge pas de place d'un éditeur à l'autre. La
  // chaîne qu'elle emprunte, elle, dépend du projet — et l'auteur n'a pas à
  // savoir laquelle.
  //
  // Les deux éditeurs retiennent la commande quand leur qualification courante
  // bloque. Côté graphe, elle attend aussi la fin de la lecture et d'une
  // qualification périmée ; la production revérifie toujours au départ.
  //
  // Universelle comme Annuler : sa présence et sa place sont les mêmes des deux
  // côtés, sa réponse dépend de l'état.
  //
  // **Elle se suspend aussi pendant une fabrication graphe.** La raison
  // n'est pas la prudence : l'édition est suspendue du clic jusqu'à
  // l'archive, donc un second départ trouverait l'auteur déjà bloqué et capturerait
  // la même révision une seconde fois. Le Libre, lui, n'a pas de verrou et
  // enfile autant de travaux que l'auteur en demande — c'est un état, pas une
  // branche par éditeur.
  universal('generate', 'common:toolbar.generate.label', TOOLBAR_GROUPS.PRODUCTION, {
    shortcut: shortcutLabels.generate ?? null,
    available: hierarchical
      ? !generateDisabled
      : (!documentUnread && !editingLocked && !generatePending && !generateDisabled),
    reason: hierarchical
      ? ISSUES_BEFORE_GENERATE_KEY
      : (editingLocked ? SUSPENDED_BY_EXPORT_KEY
        : documentUnread ? DOCUMENT_NOT_READ_KEY
          : generatePending ? CHECKING_BEFORE_GENERATE_KEY : ISSUES_BEFORE_GENERATE_KEY),
  });

  // ── Préférences ───────────────────────────────────────────────────────────
  // Cette commande garde le raccourci et son état de disponibilité dans
  // l'inventaire. Le point d'entrée visuel est dans la barre de titre.
  universal('openPreferences', 'common:toolbar.preferences.label', TOOLBAR_GROUPS.PREFERENCES, {
    shortcut: shortcutLabels.tabOptions ?? null,
  });

  return commands;
}

/** Les commandes d'un groupe, dans l'ordre de l'inventaire. */
export function toolbarGroup(inventory, group) {
  return inventory.filter((entry) => entry.group === group);
}

/**
 * La table `id → { available, unavailableReason }`.
 *
 * C'est elle que la table des raccourcis consomme, pour que le clavier et la
 * souris disent la même chose. Une disponibilité recalculée de son côté
 * afficherait Annuler comme disponible pendant l'écriture de l'archive, et la
 * commande serait ensuite refusée sans explication.
 */
export function toolbarAvailability(inventory) {
  const table = {};
  for (const entry of inventory) {
    table[entry.id] = { available: entry.available, unavailableReason: entry.unavailableReason };
  }
  return table;
}

/** Vrai si la commande existe dans cet éditeur **et** répond. */
export function isCommandAvailable(inventory, id) {
  return toolbarAvailability(inventory)[id]?.available === true;
}

// Les consommateurs partagés conservent des clés jusqu’à la présentation.
export const SUSPENDED_BY_EXPORT = SUSPENDED_BY_EXPORT_KEY;
export const SUSPENDED_BY_GESTURE = SUSPENDED_BY_GESTURE_KEY;
