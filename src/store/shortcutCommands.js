// Ce que chaque raccourci de la table fait, et ce qui l'autorise.
//
// Elle est **pure et exportée** parce que c'est là que la parité bouton/clavier
// se joue réellement : la disponibilité lue ici doit être celle de l'inventaire
// de la barre, et rien d'autre. Elle vivait en cascade de `if` dans le
// listener, où aucun test ne pouvait l'atteindre — et c'est ainsi qu'un
// raccourci de panneau du Libre a pu rester actif dans l'éditeur graphe, où il
// écrivait les préférences de panneaux d'un éditeur qu'on n'avait pas ouvert.
//
// `saveProject`, `saveAs` et `treeSearch` n'y sont pas : les deux premiers sont
// câblés en dur sur leurs refs, le troisième neutralise la recherche native
// avant de consulter sa disponibilité. Leur ordre d'exécution est particulier,
// et le fondre ici le changerait.
const SHORTCUT_COMMANDS = {
  newProject: { allow: () => true, run: (actions) => actions.newProject?.() },
  openProject: { allow: () => true, run: (actions) => actions.openProject?.() },
  openPack: { allow: (actions) => actions.canOpenPack, run: (actions) => actions.openPack?.() },
  addFolder: { allow: (actions) => actions.canAddFolder, run: (actions) => actions.addFolder?.() },
  importStories: { allow: (actions) => actions.canImportStories, run: (actions) => actions.importStories?.() },
  storySettings: { allow: (actions) => actions.canOpenPackOptions, run: (actions) => actions.openPackOptions?.() },
  toggleTree: { allow: (actions) => actions.canToggleTree, run: (actions) => actions.toggleTree?.() },
  toggleSettings: { allow: (actions) => actions.canToggleSettings, run: (actions) => actions.toggleSettings?.() },
  toggleDiagram: { allow: (actions) => actions.canToggleDiagram, run: (actions) => actions.toggleDiagram?.() },
  tabOptions: { allow: (actions) => actions.canOpenPreferences, run: (actions) => actions.openPreferences?.() },
  generate: { allow: (actions) => actions.canGenerate, run: (actions) => actions.generate?.() },
  toggleValidation: { allow: (actions) => actions.canToggleValidation, run: (actions) => actions.toggleValidation?.() },
  undo: { allow: (actions) => actions.canUndo, run: (actions) => actions.undo?.() },
  redo: { allow: (actions) => actions.canRedo, run: (actions) => actions.redo?.() },
};

export const SHORTCUT_COMMAND_IDS = Object.freeze(Object.keys(SHORTCUT_COMMANDS));

/**
 * Exécute la commande d'un raccourci si l'éditeur courant l'offre.
 *
 * Rend `'ran'`, `'unavailable'` — la commande existe mais ne répond pas, ou
 * n'existe pas dans cet éditeur — ou `'unknown'` pour un identifiant hors table.
 * Seul `'ran'` neutralise la touche : une commande indisponible n'avale pas le
 * raccourci, elle ne fait rien.
 */
export function runShortcutCommand(actionId, actions) {
  const command = SHORTCUT_COMMANDS[actionId];
  if (!command) return 'unknown';
  if (!command.allow(actions)) return 'unavailable';
  command.run(actions);
  return 'ran';
}
