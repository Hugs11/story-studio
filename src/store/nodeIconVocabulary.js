// La table nature → dessin — une seule, pour les deux éditeurs.
//
// Une table unique évite que le même Dossier n'ait pas tout à fait le même
// trait selon l'endroit où on le regarde. Elle s'appuie sur le jeu partagé
// (`components/icons/LucideLocal.jsx`).
//
// Ce module ne dessine rien. Il dit **quelle nature porte quel dessin**, et
// c'est tout son objet. C'est une donnée qu'un test dresse sans monter React,
// et que les surfaces peignent sans la décider. `components/icons/NodeIcon.jsx`
// est le pinceau ; ce fichier est la table.
//
// **Le vocabulaire ne dit pas plus que ce que la structure porte.** Un document
// de graphe ne connaît ni archive, ni nuit, ni renvoi : sa table n'invente pas
// ces natures pour ressembler à celle de l'arbre. Replier une valeur absente
// sur une valeur d'arbre, ce serait inventer une réponse.
//
// **Aucune information n'est portée par la seule icône.** Le libellé reste la
// source ; l'icône accompagne. Les surfaces rendent donc ces dessins en
// `aria-hidden`, à côté d'un nom, jamais à sa place.

import {
  WORKSPACE_MODE_ADVANCED,
  WORKSPACE_MODE_HIERARCHICAL,
} from './projectWorkState.js';

// Les noms de dessin. Ce sont des chaînes, pas des composants : la table reste
// lisible par un test qui ne monte rien, et le pinceau est le seul module qui
// connaisse React.
export const ICON_HOUSE = 'house';
export const ICON_FOLDER = 'folder';
export const ICON_FOLDER_OPEN = 'folder-open';
export const ICON_MUSIC = 'music';
export const ICON_FILE_ARCHIVE = 'file-archive';
export const ICON_ARROW_RIGHT = 'arrow-right';
export const ICON_SQUARE = 'square';
export const ICON_FULLSCREEN = 'fullscreen';
export const ICON_MOON = 'moon';
export const ICON_WAYPOINTS = 'waypoints';

// Les natures du document d'auteur hiérarchique — celles que l'arbre, le
// diagramme, l'en-tête du panneau de réglages et l'éditeur d'histoire nomment
// déjà par leur `type`.
export const HIERARCHICAL_NATURES = Object.freeze({
  ROOT: 'root',
  MENU: 'menu',
  STORY: 'story',
  ZIP: 'zip',
  REF: 'ref',
  END_NODE: 'end-node',
  END_NIGHT: 'end-night',
});

// Les natures du document de graphe. Il n'y en a que deux, et le DTO n'en porte
// pas d'autre : `stageType` et `actionType` sont des chaînes libres venues du
// pack, pas un vocabulaire borné dont on pourrait tirer un dessin.
export const ADVANCED_NATURES = Object.freeze({
  STAGE: 'stage',
  ACTION: 'action',
});

const HIERARCHICAL_VOCABULARY = Object.freeze({
  [HIERARCHICAL_NATURES.ROOT]: ICON_HOUSE,
  [HIERARCHICAL_NATURES.MENU]: ICON_FOLDER_OPEN,
  [HIERARCHICAL_NATURES.STORY]: ICON_MUSIC,
  [HIERARCHICAL_NATURES.ZIP]: ICON_FILE_ARCHIVE,
  [HIERARCHICAL_NATURES.REF]: ICON_ARROW_RIGHT,
  [HIERARCHICAL_NATURES.END_NODE]: ICON_SQUARE,
  [HIERARCHICAL_NATURES.END_NIGHT]: ICON_MOON,
});

// L'Écran et l'Action portent le dessin que le canvas peint dans leur forme :
// le cadre pour l'Écran, l'aiguillage `Waypoints` pour l'Action — celui du
// bouton « Créer une Action ». Le losange est la **forme** de l'Action sur le
// canvas, pas son icône.
const ADVANCED_VOCABULARY = Object.freeze({
  [ADVANCED_NATURES.STAGE]: ICON_FULLSCREEN,
  [ADVANCED_NATURES.ACTION]: ICON_WAYPOINTS,
});

export const NODE_ICON_VOCABULARY = Object.freeze({
  [WORKSPACE_MODE_HIERARCHICAL]: HIERARCHICAL_VOCABULARY,
  [WORKSPACE_MODE_ADVANCED]: ADVANCED_VOCABULARY,
});

// Le seul état qui change le dessin d'une nature. Un Dossier replié est dessiné
// fermé, et c'est bien un **état**, pas une nature : partout où un Dossier n'a
// pas de repli — le diagramme, l'en-tête de réglages, une cible de navigation —
// il porte le dessin de sa nature.
const COLLAPSED_OVERRIDES = Object.freeze({
  [HIERARCHICAL_NATURES.MENU]: ICON_FOLDER,
});

/**
 * Le dessin d'une nature, dans la forme de document indiquée.
 *
 * Rend `null` quand la nature n'existe pas dans cette forme de document : c'est
 * une réponse, et elle vaut mieux qu'un repli silencieux sur le dessin d'une
 * autre nature.
 */
export function resolveNodeIconName(workspaceMode, nature, { collapsed = false } = {}) {
  const vocabulary = NODE_ICON_VOCABULARY[workspaceMode];
  if (!vocabulary) return null;
  if (collapsed && Object.hasOwn(COLLAPSED_OVERRIDES, nature)) return COLLAPSED_OVERRIDES[nature];
  return Object.hasOwn(vocabulary, nature) ? vocabulary[nature] : null;
}

/**
 * La nature d'une entrée hiérarchique, à partir de son `type`.
 *
 * `end-night` n'est pas un type du document : c'est le message de fin lorsque
 * l'option nuit est active. Les surfaces portent ce drapeau de deux façons —
 * un `icon: 'moon'` recopié dans l'entrée par la mise en page, ou l'option lue
 * sur le projet — et cette fonction les ramène à la même nature plutôt que de
 * laisser chacune retrancher son `? :`.
 *
 * Rend `null` pour un type qui n'est pas une nature : l'appelant reste libre du
 * repli qu'il veut, et aucun repli n'est décidé ici à sa place.
 */
export function hierarchicalNatureOf(type, { night = false } = {}) {
  if (type === HIERARCHICAL_NATURES.END_NODE) {
    return night ? HIERARCHICAL_NATURES.END_NIGHT : HIERARCHICAL_NATURES.END_NODE;
  }
  return Object.hasOwn(HIERARCHICAL_VOCABULARY, type) ? type : null;
}

/**
 * Tous les dessins que la table peut demander, états compris.
 *
 * Sert la preuve du lot : le pinceau doit savoir peindre exactement cet
 * ensemble, ni plus ni moins.
 */
export function listVocabularyIconNames() {
  const names = new Set();
  for (const vocabulary of Object.values(NODE_ICON_VOCABULARY)) {
    for (const name of Object.values(vocabulary)) names.add(name);
  }
  for (const name of Object.values(COLLAPSED_OVERRIDES)) names.add(name);
  return [...names].sort();
}
