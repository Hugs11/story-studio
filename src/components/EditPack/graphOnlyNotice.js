import { translateImport as t } from '../../i18n/importPresentation.js';
// La notice posée quand un pack ne s'ouvre que dans l'éditeur graphe.
//
// L'auteur qui ouvre depuis l'accueil ou depuis l'éditeur par menus n'a pas eu
// le choix de l'éditeur : il doit savoir pourquoi le graphe s'ouvre. Celui qui
// ouvre depuis le graphe sait déjà où il est.

/** Le texte à afficher après un atterrissage, ou `null` s'il n'y a rien à dire. */
export function graphOnlyNoticeFor(result, { openedFromGraph = false } = {}) {
  if (openedFromGraph) return null;
  if (result?.status !== 'landed' || !result.advanced) return null;
  if (result.report?.authoringEditable) return null;
  return t('import:landing.graphOnly.notice');
}
