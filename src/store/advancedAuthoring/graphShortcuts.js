// Les raccourcis clavier de l'éditeur graphe.
//
// Les touches ne sont plus écrites ici : elles viennent de la table commune
// (`store/keyboardShortcuts.js`), portées « Sélection » et « Éditeur graphe ».
// Copier, couper, coller, supprimer, dupliquer et renommer y sont **les mêmes
// commandes** que dans l'arbre et le diagramme du Libre : reconfigurées une
// fois dans les préférences, elles changent dans les trois surfaces.
//
// La règle vit ici, hors de React, pour être éprouvée sans monter l'espace de
// travail : ce qui se décide est « ce coup de touche m'est-il destiné, et pour
// quelle commande ? ».
//
// **Trois façons de ne pas être destinataire** :
//
// 1. la frappe va dans un **champ**, ou une **modale** est ouverte ailleurs
//    dans l'application — la garde commune des surfaces
//    (`utils/shortcutTarget.js`) ;
// 2. un **dialogue du graphe** est ouvert, un renommage est en cours, ou une
//    écoute : le canvas n'a pas la main, même si le pointeur le survole ;
// 3. la commande **écrit** dans le document alors qu'un geste ou un export
//    suspend l'édition. Copier, zoomer ou revenir au nœud visité restent
//    offerts : ce sont des lectures.

import { findShortcutAction } from '../keyboardShortcuts.js';
import { surfaceShortcutsSuspended } from '../../utils/shortcutTarget.js';

const GRAPH_SHORTCUT_SCOPES = Object.freeze(['selection', 'graph']);

// Les commandes qui modifient le document.
export const GRAPH_WRITING_SHORTCUTS = Object.freeze([
  'selectionCut',
  'selectionPaste',
  'selectionDuplicate',
  'selectionDelete',
  'selectionRename',
  'graphCreateStage',
  'graphCreateAction',
  'graphArrange',
]);

// La commande que cette frappe demande au graphe, ou `null`.
export function graphShortcutFor(event, { shortcuts, blocked = false, editingDisabled = false } = {}) {
  if (!event || blocked || surfaceShortcutsSuspended(event)) return null;
  const actionId = findShortcutAction(event, shortcuts, GRAPH_SHORTCUT_SCOPES);
  if (!actionId) return null;
  if (editingDisabled && GRAPH_WRITING_SHORTCUTS.includes(actionId)) return null;
  return actionId;
}
