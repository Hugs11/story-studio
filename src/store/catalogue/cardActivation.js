import { pointerSelection } from './listNavigation.js';
import { beforeFicheAbandon } from './metadataDraft.js';
import { selectionPanelTarget } from './browserState.js';

/** A second click this soon after the first one belongs to the same double click. */
export const DOUBLE_CLICK_MS = 500;

/** Shared by cards and rows: inspect on click, open the large fiche on double click or Enter. */
export function catalogueCardActivation({ selection, order, cardsById, openFiche, abandon, simulate, edit, revision, focusExemplars, openModal, clicks = { current: null }, now = Date.now }) {
  const recentClick = () => clicks.current && now() - clicks.current.at <= DOUBLE_CLICK_MS ? clicks.current : null;
  const openFirstClicked = () => {
    const { id } = clicks.current;
    clicks.current = null;
    return beforeFicheAbandon(abandon, () => openModal(id));
  };
  return {
    onBackgroundClick(event) {
      // The second click of a double click may land between cards after the grid reflowed.
      if (event.detail > 1 && recentClick()) return openFirstClicked();
      // Ignore cards, list headers and controls, including events from portals.
      if (!event.currentTarget.contains(event.target)
        || event.target.closest('[data-card-id], [data-focus-card-id], thead, button, a, input, select, textarea, [role="button"]')) return;
      return beforeFicheAbandon(abandon, () => {
        selection.clear();
        openFiche(null);
      });
    },
    onItemClick(event, id) {
      // The second click of a double click must not toggle a Ctrl selection again,
      // and opens the card of the FIRST click: opening the panel may have moved the grid.
      if (event.detail > 1) return recentClick() ? openFirstClicked() : undefined;
      clicks.current = { id, at: now() };
      return beforeFicheAbandon(abandon, () => {
        const action = pointerSelection({ id, order, shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey });
        openFiche(selectionPanelTarget(selection.snapshot, action, order, id), { selecting: action.type !== 'click' });
        selection.setActiveId(id);
        selection.apply(action);
      });
    },
    onFormatClick(event, id, format) {
      if (event.detail > 1) return;
      return beforeFicheAbandon(abandon, () => {
        selection.setActiveId(id);
        selection.apply({ type: 'click', id });
        openFiche(id);
        focusExemplars({ id, format });
      });
    },
    /** Double click and Enter: the fiche opens large and never launches a simulation. */
    onOpenModal(id) {
      return beforeFicheAbandon(abandon, () => {
        // Claim the catalogue side before opening its fiche (also from the keyboard).
        selection.apply({ type: 'click', id });
        openModal(id);
      });
    },
    /** Same editor flow as the fiche, without changing selection. */
    onEdit(id, trigger) {
      clicks.current = null;
      const card = cardsById.get(id);
      if (card) return beforeFicheAbandon(abandon, () => edit({ card, revision, returnFocusId: trigger?.id || trigger?.closest('[data-card-id]')?.id }));
    },
    /** Simulation requested explicitly (never by a double click). */
    onSimulate(id) {
      clicks.current = null;
      const card = cardsById.get(id);
      if (card) return beforeFicheAbandon(abandon, () => simulate({ card, revision }));
    },
  };
}
