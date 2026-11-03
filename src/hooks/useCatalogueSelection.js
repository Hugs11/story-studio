import { browseSession } from '../store/catalogue/browseSession.js';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { EMPTY_SELECTION, pruneSelection, prunedAnnouncement, selectionReducer } from '../store/catalogue/selection.js';
import { keepActive } from '../store/catalogue/listNavigation.js';

/**
 * Sélection multiple commune aux trois vues et fiche active (focus).
 * Les fiches devenues invisibles quittent la sélection, avec une seule
 * annonce regroupée.
 * @param {string[]} order identifiants affichés, dans l'ordre
 */
export function useCatalogueSelection(order, cards = [], ready = true, lunii = null) {
  const [selection, localDispatch] = useReducer(selectionReducer, null, () => browseSession.restore()?.selection ?? EMPTY_SELECTION);
  const [activeId, setActiveId] = useState(() => browseSession.restore()?.activeId ?? null);
  const [announcement, setAnnouncement] = useState(null);
  const previousOrder = useRef(order);
  const titles = useMemo(() => new Map(cards.map(card => [card.id,card.displayTitle ?? card.title ?? card.id])), [cards]);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const shared = lunii?.store;
  const dispatch = action => {
    const side = shared?.getSnapshot().selection.side;
    const passive = action.type === 'prune' || action.type === 'clear';
    const current = side === 'lunii' ? EMPTY_SELECTION : selectionRef.current;
    const next = selectionReducer(current, action);
    selectionRef.current = next;
    localDispatch({ type: 'restore', value: next });
    if (shared && (!passive || side === 'catalogue')) shared.select('catalogue', next.ids);
  };
  useEffect(() => {
    if (lunii?.selection.side === 'lunii') localDispatch({ type: 'clear' });
  }, [lunii?.selection.side]);

  useEffect(() => {
    if (!ready) return;
    const { removed } = pruneSelection(selectionRef.current, order);
    if (removed.length) {
      dispatch({ type: 'prune', order });
      setAnnouncement(prunedAnnouncement(removed, removed.map(id => titles.get(id) ?? id)));
    }
    setActiveId((current) => keepActive(current, previousOrder.current, order));
    previousOrder.current = order;
  }, [order, ready]);

  const apply = useCallback((action) => {
    if (action) dispatch({ ...action, order: action.order ?? order });
  }, [order, shared]);

  const visibleSelection = pruneSelection(lunii?.selection.side === 'lunii' ? EMPTY_SELECTION : selection, order).selection;
  return {
    restore: (value, active) => {
      dispatch({ type: 'restore', value });
      setActiveId(active);
    },
    snapshot: lunii?.selection.side === 'lunii' ? EMPTY_SELECTION : selection,
    ids: visibleSelection.ids,
    selected: new Set(visibleSelection.ids),
    activeId,
    setActiveId,
    apply,
    selectAll: () => dispatch({ type: 'selectAll', order }),
    clear: () => dispatch({ type: 'clear' }),
    announcement,
  };
}
