import { isEditableTarget } from '../../utils/shortcutTarget.js';

/** Position of a fiche in the filtered and sorted results, 1-based for display. */
export function ficheModalPosition(order, id) {
  const index = order.indexOf(id);
  if (index < 0) return { index: null, total: order.length, previous: null, next: null };
  return { index: index + 1, total: order.length, previous: order[index - 1] ?? null, next: order[index + 1] ?? null };
}

/** Left and right arrows step through the results, never from a text field. */
export function ficheModalKeyStep(event) {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return 0;
  if (isEditableTarget(event.target)) return 0;
  if (event.key === 'ArrowLeft') return -1;
  if (event.key === 'ArrowRight') return 1;
  return 0;
}

/**
 * Escape inside the modal, once secondary dialogs have taken theirs: a running
 * file operation blocks it, an inline edit closes first, then the modal.
 */
export function modalEscapeStep({ busy, editing }) {
  if (busy) return 'ignore';
  return editing ? 'closeEdit' : 'close';
}

/**
 * Escape on the catalogue screen with the modal closed. One selected fiche:
 * one press clears it and closes the panel. Several: the first press clears
 * the selection, the panel (a selection summary) goes with it. No selection:
 * the panel closes.
 */
export function escapeStep({ selectionCount, panelOpen }) {
  if (selectionCount === 1) return panelOpen ? 'clearSelectionAndClosePanel' : 'clearSelection';
  if (selectionCount > 1) return 'clearSelection';
  if (panelOpen) return 'closePanel';
  return null;
}

/** The modal survives a refresh while its fiche exists; otherwise it moves to a neighbour. */
export function ficheModalAfterRemoval(order, previousOrder, id, exists) {
  if (exists) return id;
  const index = previousOrder.indexOf(id);
  return order.find(candidate => previousOrder.indexOf(candidate) > index) ?? [...order].reverse().find(candidate => previousOrder.indexOf(candidate) < index) ?? null;
}
