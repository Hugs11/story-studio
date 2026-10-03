// La notice posée quand un pack ne s'ouvre que dans l'éditeur graphe.
//
// L'auteur qui ouvre depuis l'accueil ou depuis l'éditeur par menus n'a pas eu
// le choix de l'éditeur : il doit savoir pourquoi le graphe s'ouvre. Celui qui
// ouvre depuis le graphe sait déjà où il est.

export const GRAPH_ONLY_NOTICE = 'Ce pack s’ouvre uniquement dans l’éditeur graphe : l’éditeur par menus ne sait pas représenter sa structure.';

/** Le texte à afficher après un atterrissage, ou `null` s'il n'y a rien à dire. */
export function graphOnlyNoticeFor(result, { openedFromGraph = false } = {}) {
  if (openedFromGraph) return null;
  if (result?.status !== 'landed' || !result.advanced) return null;
  if (result.report?.authoringEditable) return null;
  return GRAPH_ONLY_NOTICE;
}
