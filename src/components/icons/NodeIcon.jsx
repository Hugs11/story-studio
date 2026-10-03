// Le pinceau du vocabulaire.
//
// `store/nodeIconVocabulary.js` dit quelle nature porte quel dessin ; ce module
// est le seul endroit qui traduise un nom de dessin en composant du jeu
// partagé. Les surfaces — l'arbre, le diagramme, la liste du graphe, l'en-tête
// de réglages, l'éditeur d'histoire — peignent, elles ne décident pas.
//
// Une seule règle tient la suite : **tout nom de la table est peint ici, et
// rien d'autre ne l'est.** Un test dresse les deux listes et refuse qu'elles
// divergent ; c'est ce qui empêche un second jeu de revenir par la petite
// porte.

import {
  ArrowRight,
  FileArchive,
  Folder,
  FolderOpen,
  Fullscreen,
  House,
  Moon,
  Music,
  Square,
  Waypoints,
} from './LucideLocal';
import {
  ICON_ARROW_RIGHT,
  ICON_FILE_ARCHIVE,
  ICON_FOLDER,
  ICON_FOLDER_OPEN,
  ICON_FULLSCREEN,
  ICON_HOUSE,
  ICON_MOON,
  ICON_MUSIC,
  ICON_SQUARE,
  ICON_WAYPOINTS,
  resolveNodeIconName,
} from '../../store/nodeIconVocabulary.js';

const COMPONENT_BY_ICON_NAME = Object.freeze({
  [ICON_HOUSE]: House,
  [ICON_FOLDER]: Folder,
  [ICON_FOLDER_OPEN]: FolderOpen,
  [ICON_MUSIC]: Music,
  [ICON_FILE_ARCHIVE]: FileArchive,
  [ICON_ARROW_RIGHT]: ArrowRight,
  [ICON_SQUARE]: Square,
  [ICON_FULLSCREEN]: Fullscreen,
  [ICON_MOON]: Moon,
  [ICON_WAYPOINTS]: Waypoints,
});

/** Le composant d'un nom de dessin, ou `null` si le nom n'est pas du vocabulaire. */
function iconComponentByName(name) {
  return Object.hasOwn(COMPONENT_BY_ICON_NAME, name) ? COMPONENT_BY_ICON_NAME[name] : null;
}

/**
 * Le dessin d'une nature, dans la forme de document indiquée.
 *
 * Rend `null` quand la nature n'appartient pas à cette forme de document : la
 * surface appelante choisit alors son repli, s'il y a lieu d'en avoir un.
 *
 * Les tailles restent portées par la CSS de chaque surface, comme pour tout le
 * jeu partagé : l'arbre peint à 14 px, le diagramme à 18 px, le rail compact à
 * 16 px. C'est ce qui permet au même dessin de servir à trois échelles sans
 * être redessiné trois fois.
 */
export function NodeIcon({ workspaceMode, nature, collapsed = false, ...props }) {
  const Icon = iconComponentByName(resolveNodeIconName(workspaceMode, nature, { collapsed }));
  return Icon ? <Icon {...props} /> : null;
}
