// Transitions de consultation communes aux vues : une cible de menu conserve
// la révision à laquelle elle a été affichée, indépendamment des actualisations.
import { selectionReducer } from './selection.js';

/** Le panneau suit une cible encore sélectionnée, ou se ferme si la sélection est vidée. */
export function selectionPanelTarget(selection, action, order, preferredId) {
  const next = selectionReducer(selection, { ...action, order });
  return next.ids.includes(preferredId) ? preferredId : next.ids[0] ?? null;
}

export function captureMenuTarget(item, revision) {
  return { ...item, revision };
}

export function menuRevealRequest(target, exemplar) {
  return { exemplarId: exemplar.id, expectedRevision: target.revision };
}

export function catalogueShortcutsEnabled(active, blocked) {
  return active && !blocked;
}

/** Fermer une fiche rend le focus à une fiche visible, sinon à la recherche. */
export function closeFicheState(ficheId, order, activeId) {
  const focusId = order.includes(ficheId) ? ficheId
    : order.includes(activeId) ? activeId : order[0] ?? null;
  return { ficheId: null, focusId };
}

/** Un retrait réel ferme la fiche ; une recherche qui la masque ne la ferme pas. */
export function reconcileFicheState(ficheId, cardsById, order, activeId) {
  if (ficheId === null || cardsById.has(ficheId)) return null;
  return closeFicheState(ficheId, order, activeId);
}

export function catalogueBrowserActive(tab, reportId) { return tab === 'catalogue' && reportId === null; }
