import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ficheModalAfterRemoval, ficheModalPosition } from '../store/catalogue/ficheModal.js';

/**
 * État de la grande fiche : `null` ou `{ id }`. Elle parcourt les résultats
 * filtrés et triés courants ; la fiche affichée devient la sélection et
 * l'élément actif, et la grille défile pour la garder visible sans lui voler
 * le focus. À la fermeture, le focus revient à la carte de la dernière fiche vue.
 */
export function useCatalogueFicheModal({ order, cardsById, ready, selection, keyboardMove, setFicheId, restoreFocus, lastViewed, panelNavigation }) {
  const [modal, setModal] = useState(null);
  const previousOrder = useRef(order);
  const modalRef = useRef(null);
  modalRef.current = modal;
  const orderRef = useRef(order);
  orderRef.current = order;
  const position = useMemo(() => modal ? ficheModalPosition(order, modal.id) : null, [modal, order]);

  const show = useCallback((id) => {
    if (!orderRef.current.includes(id)) return;
    lastViewed.current = id;
    selection.apply({ type: 'click', id });
    // La grille défile vers la fiche sans que le focus quitte la fenêtre.
    if (id !== selection.activeId) { keyboardMove.current = true; selection.setActiveId(id); }
    setFicheId(current => current === null ? null : id);
    setModal({ id });
  }, [selection, keyboardMove, setFicheId, lastViewed]);

  const close = useCallback(({ restoreFocus: restore = true } = {}) => {
    if (restore && modalRef.current) restoreFocus(modalRef.current.id);
    setModal(null);
  }, [restoreFocus]);

  const step = useCallback((delta) => {
    const target = position && (delta < 0 ? position.previous : position.next);
    if (target) show(target);
  }, [position, show]);

  const navigatePanel = ({ id, delta, busy, openFiche }) => {
    const panelPosition = ficheModalPosition(order, id);
    const target = delta < 0 ? panelPosition.previous : panelPosition.next;
    if (!target || busy) return;
    if (target !== selection.activeId) { panelNavigation.current = true; keyboardMove.current = true; }
    selection.apply({ type: 'click', id: target });
    selection.setActiveId(target);
    openFiche(target);
    requestAnimationFrame(() => {
      const button = document.getElementById(delta < 0 ? 'catalogue-fiche-previous' : 'catalogue-fiche-next');
      const fallback = document.getElementById(delta < 0 ? 'catalogue-fiche-next' : 'catalogue-fiche-previous');
      (button?.disabled ? fallback : button)?.focus({ preventScroll: true });
    });
  };

  // Une fiche retirée par une actualisation cède la place à sa voisine.
  useEffect(() => {
    if (!ready || !modal) return;
    const exists = cardsById.has(modal.id);
    if (exists) { previousOrder.current = order; return; }
    const next = ficheModalAfterRemoval(order, previousOrder.current, modal.id, false);
    previousOrder.current = order;
    if (next) show(next); else close();
  }, [ready, modal, cardsById, order, show, close]);

  return { modal, position, show, close, step, navigatePanel };
}
